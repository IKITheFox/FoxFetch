import {
  beginPageAssistedMergeStaging,
  cleanupExpiredStagedMergeInputs,
  cleanupStagedMergeInputs,
  PAGE_ASSISTED_STAGING_MAX_CHUNK_BYTES,
  STAGED_MERGE_INPUT_TTL_MS,
  type MergeStagingDirectory,
  normalizeMergeError,
  type PageAssistedMergeStagingSession,
  prepareVerifiedMergeDownloadBlob,
  type CompletedRemux,
  type FileSystemFileHandleLike,
  withMergeDeadline,
} from '../../modules/merge';
import { superviseMergeWorker } from './worker-liveness';
import { installYouTubeOffscreenExecutor } from './youtube-executor';
import {
  prepareVerifiedStandardSeparateBlob,
  type CompletedStandardSeparateExport,
  type StandardSeparateOutputKind,
} from '../../modules/exports';
import { exportBlobToStoredDirectory } from '../../modules/downloads/custom-directory-export';
import {
  isMergeOffscreenCommand,
  isTrustedMergeOffscreenSender,
  type CustomDirectoryOutputKind,
  type CustomDirectorySaveOutcome,
  type MergeOffscreenCommand,
  type MergeOffscreenEvent,
  type MergeOffscreenStatusResponse,
  type MergeOffscreenCancelResponse,
} from '../../modules/jobs/offscreen-protocol';
import {
  isCurrentJobWorkerAttempt,
  type JobWorkerEvent,
  type JobWorkerRequest,
} from '../job/worker-protocol';

installYouTubeOffscreenExecutor();

interface MergeOutputResource {
  kind: 'merge';
  fileName: string;
  blob?: Blob;
  blobUrl?: string;
  result?: CompletedRemux;
}

interface SeparateOutputResource {
  kind: 'separate';
  fileNames: Record<StandardSeparateOutputKind, string>;
  blobs?: Partial<Record<StandardSeparateOutputKind, Blob>>;
  blobUrls?: Partial<Record<StandardSeparateOutputKind, string>>;
  result?: CompletedStandardSeparateExport;
}

type OutputResource = MergeOutputResource | SeparateOutputResource;

const resources = new Map<string, OutputResource>();
const customSaveResults = new Map<
  string,
  { commandKey: string; outcomes: CustomDirectorySaveOutcome[] }
>();
const queued = new Map<
  string,
  { kind: 'preflight' | 'merge' | 'separate' | 'custom-save'; generation: number }
>();
const active = new Map<
  string,
  { kind: 'preflight' | 'merge' | 'separate' | 'custom-save'; generation: number }
>();
const activeWorkers = new Map<
  string,
  { worker: Worker; attemptId: string; generation: number; cancel: () => void }
>();
const activeSettlements = new Map<string, Promise<void>>();
// Metadata promises are not abortable browser APIs. A timeout must not pretend they settled.
const pendingOutputHandles = new Map<string, Set<Promise<FileSystemFileHandle>>>();
const pendingWorkerEvents = new Map<string, Set<Promise<void>>>();
const pendingCleanups = new Map<string, Set<Promise<void>>>();
const cancellations = new Map<string, Promise<MergeOffscreenCancelResponse>>();
const forcedCancellations = new Set<string>();
const jobGenerations = new Map<string, number>();
const stagingExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pageStages = new Map<
  string,
  { stageId: string; generation: number; session: PageAssistedMergeStagingSession }
>();
let operationTail: Promise<void> = Promise.resolve();
let initialStagingSweep: Promise<void> | undefined;

function safeJobName(jobId: string): string {
  const normalized = jobId.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 96);
  return `merge-${normalized || 'job'}.partial`;
}

function safeSeparateJobNames(jobId: string): Record<StandardSeparateOutputKind, string> {
  const normalized = jobId.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 88) || 'job';
  return {
    video: `separate-${normalized}-video.partial`,
    audio: `separate-${normalized}-audio.partial`,
  };
}

async function outputRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await withMergeDeadline(navigator.storage.getDirectory(), { stage: 'storage' });
  initialStagingSweep ??= cleanupExpiredStagedMergeInputs(
    root as unknown as MergeStagingDirectory,
  ).catch(() => undefined);
  await withMergeDeadline(initialStagingSweep, { stage: 'storage' });
  return root;
}

async function outputHandle(
  root: FileSystemDirectoryHandle,
  fileName: string,
  jobId: string,
): Promise<FileSystemFileHandleLike> {
  const operation = root.getFileHandle(fileName, { create: true });
  const pending = pendingOutputHandles.get(jobId) ?? new Set<Promise<FileSystemFileHandle>>();
  pending.add(operation);
  pendingOutputHandles.set(jobId, pending);
  void operation
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pending.delete(operation);
      if (pending.size === 0 && pendingOutputHandles.get(jobId) === pending)
        pendingOutputHandles.delete(jobId);
    });
  return (await withMergeDeadline(operation, {
    stage: 'storage',
  })) as unknown as FileSystemFileHandleLike;
}

async function post(event: MergeOffscreenEvent, generation?: number): Promise<void> {
  if (generation !== undefined && !isCurrentGeneration(event.jobId, generation)) return;
  await withMergeDeadline(chrome.runtime.sendMessage(event), { timeoutMs: 5_000 }).catch(
    () => undefined,
  );
}

function workerFailure(message: string) {
  return {
    code: 'INTERNAL_ERROR',
    message,
    retryable: true,
    canDownloadSeparately: true,
  } as const;
}

async function runWorker(
  request: JobWorkerRequest,
  generation: number,
  onEvent: (event: JobWorkerEvent) => void | Promise<void>,
): Promise<void> {
  const worker = new Worker(new URL('../job/merge.worker.ts', import.meta.url), {
    type: 'module',
  });
  const deliver = async (event: JobWorkerEvent) => {
    const operation = Promise.resolve().then(() => onEvent(event));
    const pending = pendingWorkerEvents.get(request.jobId) ?? new Set<Promise<void>>();
    pending.add(operation);
    pendingWorkerEvents.set(request.jobId, pending);
    void operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pending.delete(operation);
        if (pending.size === 0 && pendingWorkerEvents.get(request.jobId) === pending)
          pendingWorkerEvents.delete(request.jobId);
      });
    try {
      await withMergeDeadline(operation, { stage: 'verify-output' });
    } catch (error) {
      if (!isCurrentGeneration(request.jobId, generation)) return;
      nextGeneration(request.jobId);
      await post({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'background',
        type: 'FAILED',
        jobId: request.jobId,
        failure: normalizeMergeError(error).detail,
      });
    }
  };
  await new Promise<void>((resolve) => {
    let settled = false;
    let terminalReceived = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      supervisor.close();
      if (
        activeWorkers.get(request.jobId)?.attemptId === request.attemptId &&
        activeWorkers.get(request.jobId)?.generation === generation
      ) {
        activeWorkers.delete(request.jobId);
      }
      worker.terminate();
      resolve();
    };
    const fail = (reason: 'WORKER_START_TIMEOUT' | 'WORKER_UNRESPONSIVE') => {
      if (settled || terminalReceived) return;
      terminalReceived = true;
      supervisor.close();
      worker.terminate();
      void Promise.resolve(
        deliver({
          type: 'FAILED',
          jobId: request.jobId,
          attemptId: request.attemptId,
          failure: { ...workerFailure('合并引擎未在时限内响应，已停止本次任务。'), reason },
        }),
      )
        .catch(() => undefined)
        .finally(settle);
    };
    const supervisor = superviseMergeWorker({
      fail,
      terminate: () => {
        forcedCancellations.add(request.jobId);
        settle();
      },
    });
    activeWorkers.set(request.jobId, {
      worker,
      attemptId: request.attemptId,
      generation,
      cancel: () => {
        if (settled) return;
        worker.postMessage({
          type: 'CANCEL',
          jobId: request.jobId,
          attemptId: request.attemptId,
        } satisfies JobWorkerRequest);
        supervisor.cancel();
      },
    });
    worker.onmessage = (message: MessageEvent<JobWorkerEvent>) => {
      if (settled || terminalReceived || !isCurrentJobWorkerAttempt(message.data, request)) return;
      supervisor.receive();
      if (message.data.type === 'ACK' || message.data.type === 'HEARTBEAT') return;
      const terminal =
        message.data.type === 'CAPABILITY' ||
        message.data.type === 'COMPLETED' ||
        message.data.type === 'SEPARATE_COMPLETED' ||
        message.data.type === 'FAILED';
      if (terminal) {
        terminalReceived = true;
        supervisor.close();
      }
      void Promise.resolve(deliver(message.data))
        .catch(() => undefined)
        .finally(() => {
          if (terminal) settle();
        });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (settled || terminalReceived) return;
      terminalReceived = true;
      supervisor.close();
      worker.terminate();
      void Promise.resolve(
        deliver({
          type: 'FAILED',
          jobId: request.jobId,
          attemptId: request.attemptId,
          failure: workerFailure(`合并引擎异常：${event.message || '后台处理程序加载失败。'}`),
        }),
      )
        .catch(() => undefined)
        .finally(settle);
    };
    worker.onmessageerror = () => {
      if (settled || terminalReceived) return;
      terminalReceived = true;
      supervisor.close();
      worker.terminate();
      void Promise.resolve(
        deliver({
          type: 'FAILED',
          jobId: request.jobId,
          attemptId: request.attemptId,
          failure: workerFailure('合并引擎无法读取任务消息'),
        }),
      )
        .catch(() => undefined)
        .finally(settle);
    };
    worker.postMessage(request);
  });
}

function nextGeneration(jobId: string): number {
  const generation = (jobGenerations.get(jobId) ?? 0) + 1;
  jobGenerations.set(jobId, generation);
  return generation;
}

function isCurrentGeneration(jobId: string, generation: number): boolean {
  return jobGenerations.get(jobId) === generation;
}

function clearStagingExpiry(jobId: string): void {
  const timer = stagingExpiryTimers.get(jobId);
  if (timer !== undefined) clearTimeout(timer);
  stagingExpiryTimers.delete(jobId);
}

async function cleanOutput(jobId: string, strict = false): Promise<void> {
  return trackedCleanup(jobId, () => performCleanOutput(jobId, strict));
}

function trackedCleanup(jobId: string, work: () => Promise<void>): Promise<void> {
  const operation = Promise.resolve().then(work);
  const pending = pendingCleanups.get(jobId) ?? new Set<Promise<void>>();
  pending.add(operation);
  pendingCleanups.set(jobId, pending);
  void operation
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pending.delete(operation);
      if (pending.size === 0 && pendingCleanups.get(jobId) === pending)
        pendingCleanups.delete(jobId);
    });
  return withMergeDeadline(operation, { stage: 'storage' });
}

async function performCleanOutput(jobId: string, strict: boolean): Promise<void> {
  const resource = resources.get(jobId);
  if (resource?.kind === 'merge' && resource.blobUrl) URL.revokeObjectURL(resource.blobUrl);
  if (resource?.kind === 'separate') {
    for (const blobUrl of Object.values(resource.blobUrls ?? {})) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }
  resources.delete(jobId);
  customSaveResults.delete(jobId);
  const root = await outputRoot();
  const fileNames =
    resource?.kind === 'merge'
      ? [resource.fileName]
      : resource?.kind === 'separate'
        ? Object.values(resource.fileNames)
        : [safeJobName(jobId), ...Object.values(safeSeparateJobNames(jobId))];
  await Promise.all(
    fileNames.map((fileName) =>
      root.removeEntry(fileName).catch((error: unknown) => {
        if (strict && !(error instanceof DOMException && error.name === 'NotFoundError'))
          throw error;
      }),
    ),
  );
}

async function cleanStaging(jobId: string, strict = false): Promise<void> {
  return trackedCleanup(jobId, () => performCleanStaging(jobId, strict));
}

async function performCleanStaging(jobId: string, strict: boolean): Promise<void> {
  clearStagingExpiry(jobId);
  const pageStage = pageStages.get(jobId);
  if (pageStage) {
    pageStages.delete(jobId);
    await pageStage.session.abort('页面辅助下载已取消。').catch((error: unknown) => {
      if (strict) throw error;
    });
  }
  const root = await outputRoot();
  await cleanupStagedMergeInputs(root as unknown as MergeStagingDirectory, jobId, { strict });
}

async function clean(jobId: string): Promise<void> {
  clearStagingExpiry(jobId);
  await Promise.all([cleanOutput(jobId), cleanStaging(jobId)]);
}

/** Stops only this job. A queued job must not wait behind unrelated active work. */
function cancelAndSettle(jobId: string): Promise<MergeOffscreenCancelResponse> {
  const existing = cancellations.get(jobId);
  if (existing) return existing;
  nextGeneration(jobId);
  queued.delete(jobId);
  clearStagingExpiry(jobId);
  activeWorkers.get(jobId)?.cancel();
  const operation = (async (): Promise<MergeOffscreenCancelResponse> => {
    try {
      await withMergeDeadline(
        Promise.all([
          activeSettlements.get(jobId) ?? Promise.resolve(),
          Promise.allSettled([...(pendingOutputHandles.get(jobId) ?? [])]),
          Promise.allSettled([...(pendingWorkerEvents.get(jobId) ?? [])]),
          Promise.allSettled([...(pendingCleanups.get(jobId) ?? [])]),
        ]),
        {
          timeoutMs: 5_000,
        },
      );
    } catch {
      return { ok: false, settled: false, error: 'STOP_TIMEOUT' };
    }
    try {
      const saved = customSaveResults.get(jobId);
      if (saved) {
        // Replay committed outcomes before removing private bookkeeping. External files are never removed here.
        await withMergeDeadline(
          chrome.runtime.sendMessage({
            channel: 'foxfetch-merge-offscreen-v1',
            target: 'background',
            type: 'CUSTOM_SAVED',
            jobId,
            outcomes: saved.outcomes,
          } satisfies MergeOffscreenEvent),
          { timeoutMs: 5_000 },
        );
      }
      await withMergeDeadline(Promise.all([cleanOutput(jobId, true), cleanStaging(jobId, true)]), {
        timeoutMs: 5_000,
      });
      const forced = forcedCancellations.delete(jobId);
      return { ok: true, settled: true, forced };
    } catch {
      return { ok: false, settled: false, error: 'CLEANUP_FAILED' };
    }
  })();
  cancellations.set(jobId, operation);
  void operation.finally(() => {
    if (cancellations.get(jobId) === operation) cancellations.delete(jobId);
  });
  return operation;
}

function scheduleStagingExpiry(jobId: string, generation: number): void {
  clearStagingExpiry(jobId);
  const timer = setTimeout(() => {
    if (stagingExpiryTimers.get(jobId) !== timer) return;
    stagingExpiryTimers.delete(jobId);
    operationTail = operationTail.then(
      async () => {
        if (!isCurrentGeneration(jobId, generation) || active.has(jobId) || queued.has(jobId)) {
          return;
        }
        await cleanStaging(jobId);
      },
      async () => {
        if (!isCurrentGeneration(jobId, generation) || active.has(jobId) || queued.has(jobId)) {
          return;
        }
        await cleanStaging(jobId);
      },
    );
  }, STAGED_MERGE_INPUT_TTL_MS);
  stagingExpiryTimers.set(jobId, timer);
}

async function preflight(
  command: Extract<MergeOffscreenCommand, { type: 'PREFLIGHT' }>,
  generation: number,
) {
  const publish = (event: MergeOffscreenEvent) => post(event, generation);
  clearStagingExpiry(command.jobId);
  await runWorker(
    {
      type: 'PREFLIGHT',
      jobId: command.jobId,
      attemptId: crypto.randomUUID(),
      request: command.request,
    },
    generation,
    async (event) => {
      if (!isCurrentGeneration(command.jobId, generation)) return;
      if (event.type === 'PROGRESS') {
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'PROGRESS',
          jobId: command.jobId,
          progress: event.progress,
        });
        return;
      }
      if (event.type === 'CAPABILITY') {
        if (event.capability.status === 'supported') {
          scheduleStagingExpiry(command.jobId, generation);
        } else {
          await cleanStaging(command.jobId);
        }
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'CAPABILITY',
          jobId: command.jobId,
          capability: event.capability,
        });
      } else if (event.type === 'FAILED') {
        await cleanStaging(command.jobId);
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'FAILED',
          jobId: command.jobId,
          failure: event.failure,
        });
      }
    },
  );
}

async function start(
  command: Extract<MergeOffscreenCommand, { type: 'START' }>,
  generation: number,
) {
  const publish = (event: MergeOffscreenEvent) => post(event, generation);
  clearStagingExpiry(command.jobId);
  // Preserve a hash-bound HTTP 200 preflight pair; the worker validates and
  // atomically consumes it. Only a stale output from an earlier attempt is removed.
  await cleanOutput(command.jobId);
  if (!isCurrentGeneration(command.jobId, generation)) return;
  const fileName = safeJobName(command.jobId);
  const handle = await outputHandle(await outputRoot(), fileName, command.jobId);
  if (!isCurrentGeneration(command.jobId, generation)) return;
  resources.set(command.jobId, { kind: 'merge', fileName });

  await runWorker(
    {
      type: 'START',
      jobId: command.jobId,
      attemptId: crypto.randomUUID(),
      request: command.request,
      handle,
    },
    generation,
    async (event) => {
      if (!isCurrentGeneration(command.jobId, generation)) return;
      if (event.type === 'PROGRESS') {
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'PROGRESS',
          jobId: command.jobId,
          progress: event.progress,
        });
        return;
      }
      if (event.type === 'COMPLETED') {
        try {
          await cleanStaging(command.jobId);
          const file = await handle.getFile();
          const typedOutput = await prepareVerifiedMergeDownloadBlob(file, event.result);
          if (!isCurrentGeneration(command.jobId, generation)) return;
          const blobUrl = URL.createObjectURL(typedOutput);
          resources.set(command.jobId, {
            kind: 'merge',
            fileName,
            blob: typedOutput,
            blobUrl,
            result: event.result,
          });
          await publish({
            channel: 'foxfetch-merge-offscreen-v1',
            target: 'background',
            type: 'COMPLETED',
            jobId: command.jobId,
            result: event.result,
            blobUrl,
          });
        } catch (error) {
          if (!isCurrentGeneration(command.jobId, generation)) return;
          await clean(command.jobId);
          await publish({
            channel: 'foxfetch-merge-offscreen-v1',
            target: 'background',
            type: 'FAILED',
            jobId: command.jobId,
            failure: normalizeMergeError(error).detail,
          });
        }
        return;
      }
      if (event.type === 'FAILED') {
        await clean(command.jobId);
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'FAILED',
          jobId: command.jobId,
          failure: event.failure,
        });
      }
    },
  );
}

async function startSeparate(
  command: Extract<MergeOffscreenCommand, { type: 'START_SEPARATE' }>,
  generation: number,
) {
  const publish = (event: MergeOffscreenEvent) => post(event, generation);
  clearStagingExpiry(command.jobId);
  await cleanOutput(command.jobId);
  if (!isCurrentGeneration(command.jobId, generation)) return;
  const root = await outputRoot();
  const fileNames = safeSeparateJobNames(command.jobId);
  const handles = {
    video: await outputHandle(root, fileNames.video, command.jobId),
    audio: await outputHandle(root, fileNames.audio, command.jobId),
  };
  if (!isCurrentGeneration(command.jobId, generation)) return;
  resources.set(command.jobId, { kind: 'separate', fileNames });

  await runWorker(
    {
      type: 'EXPORT_SEPARATE',
      jobId: command.jobId,
      attemptId: crypto.randomUUID(),
      request: command.request,
      handles,
    },
    generation,
    async (event) => {
      if (!isCurrentGeneration(command.jobId, generation)) return;
      if (event.type === 'PROGRESS') {
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'PROGRESS',
          jobId: command.jobId,
          progress: event.progress,
        });
        return;
      }
      if (event.type === 'SEPARATE_COMPLETED') {
        await cleanStaging(command.jobId);
        const blobs: Partial<Record<StandardSeparateOutputKind, Blob>> = {};
        const blobUrls: Partial<Record<StandardSeparateOutputKind, string>> = {};
        const outcomes = await Promise.all(
          event.result.outcomes.map(async (outcome) => {
            const handle = handles[outcome.kind];
            if (outcome.status === 'failed') {
              await root.removeEntry(fileNames[outcome.kind]).catch(() => undefined);
              return outcome;
            }
            try {
              const file = await handle.getFile();
              const typedOutput = await prepareVerifiedStandardSeparateBlob(file, outcome);
              blobs[outcome.kind] = typedOutput;
              blobUrls[outcome.kind] = URL.createObjectURL(typedOutput);
              return outcome;
            } catch (error) {
              if (!isCurrentGeneration(command.jobId, generation))
                return {
                  status: 'failed' as const,
                  kind: outcome.kind,
                  failure: normalizeMergeError(error).detail,
                };
              await root.removeEntry(fileNames[outcome.kind]).catch(() => undefined);
              return {
                status: 'failed' as const,
                kind: outcome.kind,
                failure: normalizeMergeError(error).detail,
              };
            }
          }),
        );
        const tuple: CompletedStandardSeparateExport['outcomes'] = [outcomes[0]!, outcomes[1]!];
        if (!isCurrentGeneration(command.jobId, generation)) {
          for (const url of Object.values(blobUrls)) if (url) URL.revokeObjectURL(url);
          return;
        }
        const successCount = tuple.filter((outcome) => outcome.status === 'completed').length;
        const result: CompletedStandardSeparateExport = {
          status: successCount === 2 ? 'completed' : successCount === 1 ? 'partial' : 'failed',
          outcomes: tuple,
        };
        resources.set(command.jobId, {
          kind: 'separate',
          fileNames,
          blobs,
          blobUrls,
          result,
        });
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'SEPARATE_COMPLETED',
          jobId: command.jobId,
          result,
          blobUrls,
        });
        return;
      }
      if (event.type === 'FAILED') {
        await clean(command.jobId);
        await publish({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'background',
          type: 'FAILED',
          jobId: command.jobId,
          failure: event.failure,
        });
      }
    },
  );
}

function customSaveFailure(
  kind: CustomDirectoryOutputKind,
  error: unknown,
): CustomDirectorySaveOutcome {
  return {
    status: 'failed',
    kind,
    failure: {
      code: 'OUTPUT_WRITE_FAILED',
      message:
        error instanceof Error && error.message
          ? error.message
          : typeof error === 'string' && error
            ? error
            : '无法写入已选择的自定义目录。',
      retryable: true,
      canDownloadSeparately: true,
    },
  };
}

async function saveCustom(
  command: Extract<MergeOffscreenCommand, { type: 'SAVE_CUSTOM' }>,
): Promise<void> {
  const commandKey = JSON.stringify({
    handleId: command.handleId,
    merge: command.fileNames.merge ?? '',
    video: command.fileNames.video ?? '',
    audio: command.fileNames.audio ?? '',
  });
  const previous = customSaveResults.get(command.jobId);
  if (previous?.commandKey === commandKey) {
    await post({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'background',
      type: 'CUSTOM_SAVED',
      jobId: command.jobId,
      outcomes: previous.outcomes,
    });
    return;
  }

  const resource = resources.get(command.jobId);
  const work: Array<Promise<CustomDirectorySaveOutcome>> = [];
  if (resource?.kind === 'merge') {
    const fileName = command.fileNames.merge;
    const blob = resource.blob;
    const expectedSize = resource.result?.verification.sizeBytes;
    if (fileName && blob && expectedSize && expectedSize > 0) {
      work.push(
        exportBlobToStoredDirectory(command.handleId, fileName, blob, expectedSize)
          .then((written) => ({
            status: 'completed' as const,
            kind: 'merge' as const,
            fileName: written.fileName,
            sizeBytes: written.size,
          }))
          .catch((error: unknown) => customSaveFailure('merge', error)),
      );
    } else {
      work.push(Promise.resolve(customSaveFailure('merge', '已验证的合并文件不可用')));
    }
  } else if (resource?.kind === 'separate') {
    for (const kind of ['video', 'audio'] as const) {
      const fileName = command.fileNames[kind];
      if (!fileName) continue;
      const outcome = resource.result?.outcomes.find((candidate) => candidate.kind === kind);
      const blob = resource.blobs?.[kind];
      const expectedSize = outcome?.status === 'completed' ? outcome.verification.sizeBytes : 0;
      if (!blob || !expectedSize) {
        work.push(Promise.resolve(customSaveFailure(kind, '无法读取已检查的媒体文件。')));
        continue;
      }
      work.push(
        exportBlobToStoredDirectory(command.handleId, fileName, blob, expectedSize)
          .then((written) => ({
            status: 'completed' as const,
            kind,
            fileName: written.fileName,
            sizeBytes: written.size,
          }))
          .catch((error: unknown) => customSaveFailure(kind, error)),
      );
    }
  } else {
    for (const kind of ['merge', 'video', 'audio'] as const) {
      if (command.fileNames[kind]) {
        work.push(Promise.resolve(customSaveFailure(kind, '后台临时文件已失效，请重试')));
      }
    }
  }

  const outcomes = await Promise.all(work);
  customSaveResults.set(command.jobId, { commandKey, outcomes });
  await post({
    channel: 'foxfetch-merge-offscreen-v1',
    target: 'background',
    type: 'CUSTOM_SAVED',
    jobId: command.jobId,
    outcomes,
  });
}

type PageStageCommand = Extract<
  MergeOffscreenCommand,
  {
    type: 'PAGE_STAGE_BEGIN' | 'PAGE_STAGE_CHUNK' | 'PAGE_STAGE_COMMIT' | 'PAGE_STAGE_ABORT';
  }
>;

interface PageStageResponse {
  ok: boolean;
  persistedBytes?: number;
  trackBytes?: number;
  readBytes?: number;
  error?: string;
}

function decodePageStageChunk(value: string, expectedBytes: number): Uint8Array {
  const expectedBase64Length = Math.ceil(expectedBytes / 3) * 4;
  if (
    expectedBytes <= 0 ||
    expectedBytes > PAGE_ASSISTED_STAGING_MAX_CHUNK_BYTES ||
    value.length !== expectedBase64Length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error('页面辅助缓存分片编码无效。');
  }
  const binary = atob(value);
  if (binary.length !== expectedBytes) throw new Error('页面辅助缓存分片长度不匹配。');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function handlePageStage(
  command: PageStageCommand,
  generation: number,
): Promise<PageStageResponse> {
  if (!isCurrentGeneration(command.jobId, generation))
    throw new Error('页面辅助缓存请求已经过期。');
  await withMergeDeadline(
    Promise.all([
      Promise.allSettled([...(pendingOutputHandles.get(command.jobId) ?? [])]),
      Promise.allSettled([...(pendingWorkerEvents.get(command.jobId) ?? [])]),
      Promise.allSettled([...(pendingCleanups.get(command.jobId) ?? [])]),
    ]),
    { stage: 'storage' },
  );
  if (!isCurrentGeneration(command.jobId, generation))
    throw new Error('页面辅助缓存请求已经过期。');
  let finish!: () => void;
  const settlement = new Promise<void>((resolve) => {
    finish = resolve;
  });
  activeSettlements.set(command.jobId, settlement);
  try {
    return await performPageStage(command, generation);
  } finally {
    finish();
    if (activeSettlements.get(command.jobId) === settlement)
      activeSettlements.delete(command.jobId);
  }
}

async function performPageStage(
  command: PageStageCommand,
  generation: number,
): Promise<PageStageResponse> {
  if (command.type === 'PAGE_STAGE_BEGIN') {
    if (!isCurrentGeneration(command.jobId, generation)) {
      throw new Error('页面辅助缓存请求已经过期。');
    }
    await cleanStaging(command.jobId);
    const session = await beginPageAssistedMergeStaging(command.request, command.jobId, {
      root: (await outputRoot()) as unknown as MergeStagingDirectory,
    });
    if (!isCurrentGeneration(command.jobId, generation)) {
      await session.abort('页面辅助缓存请求已经过期。');
      throw new Error('页面辅助缓存请求已经过期。');
    }
    pageStages.set(command.jobId, { stageId: command.stageId, generation, session });
    return { ok: true };
  }

  const activeStage = pageStages.get(command.jobId);
  if (!activeStage || activeStage.stageId !== command.stageId) {
    throw new Error('页面辅助缓存会话不存在或已失效。');
  }
  if (command.type === 'PAGE_STAGE_ABORT') {
    pageStages.delete(command.jobId);
    await activeStage.session.abort('页面辅助下载已中止。');
    return { ok: true };
  }
  if (
    activeStage.generation !== generation ||
    !isCurrentGeneration(command.jobId, activeStage.generation)
  ) {
    pageStages.delete(command.jobId);
    await activeStage.session.abort('页面辅助缓存 generation 已失效。');
    throw new Error('页面辅助缓存 generation 已失效。');
  }
  if (command.type === 'PAGE_STAGE_CHUNK') {
    try {
      const bytes = decodePageStageChunk(command.bytesBase64, command.byteLength);
      const persisted = await activeStage.session.append(
        command.track,
        command.offset,
        command.totalBytes,
        bytes,
      );
      return { ok: true, ...persisted };
    } catch (error) {
      pageStages.delete(command.jobId);
      await activeStage.session.abort(error).catch(() => undefined);
      throw error;
    }
  }
  try {
    const staged = await activeStage.session.commit();
    pageStages.delete(command.jobId);
    scheduleStagingExpiry(command.jobId, generation);
    return { ok: true, readBytes: staged.readBytes };
  } catch (error) {
    pageStages.delete(command.jobId);
    await activeStage.session.abort(error).catch(() => undefined);
    throw error;
  }
}

async function handle(command: MergeOffscreenCommand, generation: number): Promise<void> {
  if (command.type === 'STATUS') return;
  if (
    command.type === 'PAGE_STAGE_BEGIN' ||
    command.type === 'PAGE_STAGE_CHUNK' ||
    command.type === 'PAGE_STAGE_COMMIT' ||
    command.type === 'PAGE_STAGE_ABORT'
  ) {
    return;
  }
  if (command.type === 'CLEANUP' || command.type === 'CANCEL') {
    if (!isCurrentGeneration(command.jobId, generation)) return;
    await withMergeDeadline(
      Promise.all([
        Promise.allSettled([...(pendingOutputHandles.get(command.jobId) ?? [])]),
        Promise.allSettled([...(pendingWorkerEvents.get(command.jobId) ?? [])]),
        Promise.allSettled([...(pendingCleanups.get(command.jobId) ?? [])]),
      ]),
      { stage: 'storage' },
    );
    if (!isCurrentGeneration(command.jobId, generation)) return;
    await clean(command.jobId);
    return;
  }
  if (!isCurrentGeneration(command.jobId, generation)) return;
  // A deadline only bounds the caller's wait. Never reuse same-job paths while
  // a previous native metadata or event handler operation still owns them.
  await withMergeDeadline(
    Promise.all([
      Promise.allSettled([...(pendingOutputHandles.get(command.jobId) ?? [])]),
      Promise.allSettled([...(pendingWorkerEvents.get(command.jobId) ?? [])]),
      Promise.allSettled([...(pendingCleanups.get(command.jobId) ?? [])]),
    ]),
    { stage: 'verify-output' },
  );
  if (!isCurrentGeneration(command.jobId, generation)) return;
  const kind =
    command.type === 'PREFLIGHT'
      ? 'preflight'
      : command.type === 'START_SEPARATE'
        ? 'separate'
        : command.type === 'SAVE_CUSTOM'
          ? 'custom-save'
          : 'merge';
  if (queued.get(command.jobId)?.generation === generation) queued.delete(command.jobId);
  active.set(command.jobId, { kind, generation });
  let finish!: () => void;
  const settlement = new Promise<void>((resolve) => {
    finish = resolve;
  });
  activeSettlements.set(command.jobId, settlement);
  try {
    if (command.type === 'PREFLIGHT') await preflight(command, generation);
    else if (command.type === 'START_SEPARATE') await startSeparate(command, generation);
    else if (command.type === 'SAVE_CUSTOM') await saveCustom(command);
    else await start(command, generation);
  } finally {
    finish();
    if (activeSettlements.get(command.jobId) === settlement)
      activeSettlements.delete(command.jobId);
    if (active.get(command.jobId)?.generation === generation) active.delete(command.jobId);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isMergeOffscreenCommand(message)) return undefined;
  if (!isTrustedMergeOffscreenSender(sender, chrome.runtime.id, chrome.runtime.getURL(''))) {
    sendResponse({ ok: false, error: '拒绝页面上下文直接控制后台合并宿主' });
    return false;
  }
  if (message.type === 'STATUS') {
    const resource = resources.get(message.jobId);
    const activeJob = active.get(message.jobId);
    const queuedJob = queued.get(message.jobId);
    const response: MergeOffscreenStatusResponse = pageStages.has(message.jobId)
      ? { ok: true, state: 'staging' }
      : resource?.kind === 'merge' && resource.blobUrl && resource.result
        ? { ok: true, state: 'completed', result: resource.result, blobUrl: resource.blobUrl }
        : resource?.kind === 'separate' && resource.result
          ? {
              ok: true,
              state: 'separate-completed',
              result: resource.result,
              blobUrls: resource.blobUrls ?? {},
            }
          : activeJob?.kind === 'preflight'
            ? { ok: true, state: 'preflighting' }
            : activeJob?.kind === 'merge' || activeJob?.kind === 'separate'
              ? { ok: true, state: 'running' }
              : queuedJob
                ? { ok: true, state: 'queued' }
                : { ok: true, state: 'idle' };
    sendResponse(response);
    return false;
  }
  if (message.type === 'CANCEL') {
    void cancelAndSettle(message.jobId).then(sendResponse);
    return true;
  }
  if (
    message.type === 'PAGE_STAGE_BEGIN' ||
    message.type === 'PAGE_STAGE_CHUNK' ||
    message.type === 'PAGE_STAGE_COMMIT' ||
    message.type === 'PAGE_STAGE_ABORT'
  ) {
    let generation: number;
    if (message.type === 'PAGE_STAGE_BEGIN') {
      generation = nextGeneration(message.jobId);
      queued.delete(message.jobId);
      const activeWorker = activeWorkers.get(message.jobId);
      activeWorker?.cancel();
    } else {
      generation =
        pageStages.get(message.jobId)?.generation ?? jobGenerations.get(message.jobId) ?? 0;
    }
    const responseTask = operationTail
      .then(
        () => handlePageStage(message, generation),
        () => handlePageStage(message, generation),
      )
      .catch(async (error: unknown) => {
        if (
          message.type !== 'PAGE_STAGE_ABORT' &&
          isCurrentGeneration(message.jobId, generation) &&
          !pendingOutputHandles.get(message.jobId)?.size &&
          !pendingWorkerEvents.get(message.jobId)?.size &&
          !pendingCleanups.get(message.jobId)?.size
        ) {
          await cleanStaging(message.jobId).catch(() => undefined);
        }
        throw error;
      });
    operationTail = responseTask.then(
      () => undefined,
      () => undefined,
    );
    void responseTask.then(
      (response) => sendResponse(response),
      (error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies PageStageResponse);
      },
    );
    return true;
  }
  let generation = jobGenerations.get(message.jobId) ?? 0;
  if (
    message.type === 'PREFLIGHT' ||
    message.type === 'START' ||
    message.type === 'START_SEPARATE'
  ) {
    generation = nextGeneration(message.jobId);
    const activeWorker = activeWorkers.get(message.jobId);
    activeWorker?.cancel();
    queued.set(message.jobId, {
      kind:
        message.type === 'PREFLIGHT'
          ? 'preflight'
          : message.type === 'START_SEPARATE'
            ? 'separate'
            : 'merge',
      generation,
    });
  } else if (message.type === 'CLEANUP') {
    generation = nextGeneration(message.jobId);
    // Cancellation must reach the running worker immediately. Cleanup remains
    // serialized below so it cannot delete the OPFS target while the worker is
    // still unwinding its muxer and writable stream.
    queued.delete(message.jobId);
    const activeWorker = activeWorkers.get(message.jobId);
    activeWorker?.cancel();
  }
  operationTail = operationTail.then(
    () => handle(message, generation),
    () => handle(message, generation),
  );
  operationTail = operationTail.catch(async (error: unknown) => {
    if (!isCurrentGeneration(message.jobId, generation)) return;
    if (
      !pendingOutputHandles.get(message.jobId)?.size &&
      !pendingWorkerEvents.get(message.jobId)?.size &&
      !pendingCleanups.get(message.jobId)?.size
    ) {
      await clean(message.jobId).catch(() => undefined);
    }
    await post({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'background',
      type: 'FAILED',
      jobId: message.jobId,
      failure: normalizeMergeError(error).detail,
    });
  });
  sendResponse({ ok: true, queued: true });
  return false;
});
