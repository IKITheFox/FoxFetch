import type { prepareYouTubeDownload } from './prepare-download';
import { MergeError } from '../merge/errors';
import { canTryAnotherFormat } from './automatic-selection';
import { ReadSpeedWindow } from '../../shared/read-speed';
import type { YouTubeSelectionPlan } from './selection';
import { youtubePreparationStages, type YouTubePreparationStage } from './preparation-stage';
import { isYouTubeAddressRejection } from './sources/fresh-session';
import { validateDownloadFilename } from '../downloads/download-target';
import type { YouTubeDirectoryAllocation } from './directory-output';
import type { saveJournaledYouTubeDirectoryOutput } from './directory-save';

type Preparation = Awaited<ReturnType<typeof prepareYouTubeDownload>>;
export interface YouTubeExecutionRequest {
  jobId: string;
  plan: YouTubeSelectionPlan;
  session: Parameters<typeof prepareYouTubeDownload>[2];
}
export interface YouTubePreparedFile {
  kind: 'merged' | 'video' | 'audio';
  url: string;
  name: string;
  size: number;
  mime: string;
}
export interface YouTubeExecutionStatus {
  bufferPeaks?: Record<string, number>;
  jobId: string;
  state: 'preparing' | 'canceling' | 'canceled' | 'ready' | 'failed' | 'released';
  readBytes: number;
  network?: import('./sources/sabr-transport').SabrNetworkEvent[];
  primaryError?: string;
  readSpeed?: number | null;
  totalBytes?: number | null;
  segments?: import('./sources/segment-progress').SegmentProgress | null;
  preparationStage?: YouTubePreparationStage;
  files: YouTubePreparedFile[];
  error?: string;
  /** Only the background's final save confirmation can establish publication. */
  publicationCommitted: false;
  directory?: {
    state: 'saving' | 'checking' | 'verified' | 'unknown' | 'stopped';
    files: Array<YouTubeDirectoryAllocation & { kind: YouTubePreparedFile['kind'] }>;
    removed?: Array<YouTubeDirectoryAllocation & { kind: YouTubePreparedFile['kind'] }>;
    unstarted?: YouTubePreparedFile['kind'][];
    error?: string;
    attempt?: number;
  };
}
interface Entry {
  formatAttempt?: number;
  speed: ReadSpeedWindow;
  status: YouTubeExecutionStatus;
  planKey: string;
  controller: AbortController;
  done: Promise<void>;
  prepared?: Preparation;
  cleaning?: Promise<void>;
  refreshed?: boolean;
  directoryKey?: string;
  directoryController?: AbortController;
  directoryDone?: Promise<void>;
  releasing?: boolean;
}

/** Offscreen ownership only. No page input, browser downloads or success claims here. */
export class YouTubeOffscreenExecutor {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly dependencies: {
      prepare?: typeof prepareYouTubeDownload;
      createUrl?: (blob: Blob) => string;
      revokeUrl?: (url: string) => void;
      directorySave?: (
        request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
        file: Blob,
        signal: AbortSignal,
      ) => Promise<YouTubeDirectoryAllocation>;
      directoryRecheck?: (
        request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
        file: Blob,
        signal: AbortSignal,
      ) => Promise<YouTubeDirectoryAllocation>;
      directoryRetry?: (
        request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
        file: Blob,
        signal: AbortSignal,
      ) => Promise<YouTubeDirectoryAllocation>;
      directoryRemoved?: (
        request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
      ) => Promise<YouTubeDirectoryAllocation | undefined>;
    } = {},
  ) {}

  status(jobId: string): YouTubeExecutionStatus | undefined {
    const entry = this.entries.get(jobId);
    const status = entry?.status;
    if (entry && status) status.readSpeed = entry.speed.sample(status.readBytes);
    return status ? structuredClone(status) : undefined;
  }

  start(request: YouTubeExecutionRequest): YouTubeExecutionStatus {
    if (!/^[0-9a-f-]{36}$/iu.test(request.jobId)) throw new Error('JOB_ID_INVALID');
    if (
      !request.plan ||
      !/^[\w-]{11}$/u.test(request.plan.videoId) ||
      !['merge', 'separate'].includes(request.plan.mode)
    )
      throw new Error('SELECTION_INVALID');
    const planKey = JSON.stringify(request.plan);
    const previous = this.entries.get(request.jobId);
    if (previous) {
      if (previous.planKey !== planKey) throw new Error('JOB_SELECTION_CHANGED');
      return this.status(request.jobId)!;
    }
    // Bound retained files and state. Release is explicit: never expire a file
    // while Chrome may still be saving it. Old IDs remain tombstones this lifetime.
    if (this.entries.size >= 128) throw new Error('JOB_CAPACITY_REACHED');
    if (
      [...this.entries.values()].filter(
        (entry) =>
          entry.prepared || ['preparing', 'canceling', 'ready'].includes(entry.status.state),
      ).length >= 2
    )
      throw new Error('JOB_BUSY');
    const copied = structuredClone(request);
    const controller = new AbortController();
    const entry: Entry = {
      speed: new ReadSpeedWindow(),
      planKey,
      controller,
      done: Promise.resolve(),
      status: {
        jobId: request.jobId,
        state: 'preparing',
        readBytes: 0,
        files: [],
        publicationCommitted: false,
      },
    };
    this.entries.set(request.jobId, entry);
    entry.done = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const prepare =
          this.dependencies.prepare ?? (await import('./prepare-download')).prepareYouTubeDownload;
        controller.signal.throwIfAborted();
        entry.prepared = await prepare(
          copied.plan,
          copied.plan.videoId,
          copied.session,
          copied.plan.mode,
          {
            signal: controller.signal,
            onStage: (stage) => {
              if (
                entry.status.state === 'preparing' &&
                !controller.signal.aborted &&
                Object.hasOwn(youtubePreparationStages, stage)
              )
                entry.status.preparationStage = stage;
            },
            onProgress: (bytes) => {
              if (
                entry.status.state === 'preparing' &&
                Number.isSafeInteger(bytes) &&
                bytes >= entry.status.readBytes
              )
                entry.status.readBytes = bytes;
            },
            onSegments: (progress) => {
              if (entry.status.state === 'preparing' && !controller.signal.aborted)
                entry.status.segments = progress;
            },
            onDiagnostic: (code, value) => {
              if (
                ['RESPONSE_BYTES', 'RETAINED_BYTES', 'WRITING_BYTES'].includes(code) &&
                Number.isSafeInteger(value) &&
                value >= 0
              ) {
                const peaks = (entry.status.bufferPeaks ??= {});
                peaks[code] = Math.max(peaks[code] ?? 0, value);
              }
            },
            onNetwork: (event) => {
              if (entry.status.state === 'preparing')
                entry.status.network = [...(entry.status.network ?? []), event].slice(-16);
            },
            onTotal: (bytes) => {
              if (entry.status.state === 'preparing' && !controller.signal.aborted)
                entry.status.totalBytes =
                  Number.isSafeInteger(bytes) && bytes! > 0 && bytes! >= entry.status.readBytes
                    ? bytes
                    : null;
            },
          },
        );
        controller.signal.throwIfAborted();
        const files = entry.prepared.files;
        if (
          files.length !== (copied.plan.mode === 'merge' ? 1 : 2) ||
          files.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)
        )
          throw new Error('OUTPUT_INCOMPLETE');
        for (const [index, file] of files.entries()) {
          entry.status.files.push({
            kind: copied.plan.mode === 'merge' ? 'merged' : index === 0 ? 'video' : 'audio',
            url: (this.dependencies.createUrl ?? URL.createObjectURL)(file),
            name: copied.plan.mode === 'merge' ? `video.${copied.plan.container}` : file.name,
            size: file.size,
            mime: file.type,
          });
        }
        entry.status.state = 'ready';
      } catch (error) {
        entry.status.state = controller.signal.aborted ? 'canceled' : 'failed';
        const message =
          error instanceof MergeError && canTryAnotherFormat(error.detail.code)
            ? error.detail.code
            : error instanceof Error
              ? error.message
              : '';
        entry.status.error = controller.signal.aborted
          ? 'DOWNLOAD_CANCELED'
          : /^[A-Z_0-9]{1,80}$/u.test(message)
            ? message
            : 'YOUTUBE_PREPARATION_FAILED';
        try {
          await this.clean(entry);
        } catch {
          entry.status.state = 'failed';
          entry.status.primaryError = entry.status.error;
          entry.status.error = 'TEMPORARY_CLEANUP_FAILED';
        }
      }
    });
    return this.status(request.jobId)!;
  }

  async cancel(jobId: string): Promise<YouTubeExecutionStatus | undefined> {
    const entry = this.entries.get(jobId);
    if (!entry) return undefined;
    // Ready URLs may already be in use by Chrome. Its owner must first settle
    // browser downloads, then explicitly release them; cancellation is not deletion.
    if (entry.status.state === 'ready') throw new Error('OUTPUT_RELEASE_REQUIRED');
    entry.controller.abort();
    if (entry.status.state === 'preparing') {
      entry.status.state = 'canceling';
    }
    await entry.done;
    return this.status(jobId);
  }

  /** One explicit retry after the owner resolved the exact plan to a fresh source.
   * No ready output or uncertain cleanup may be replaced. */
  async refresh(request: YouTubeExecutionRequest): Promise<YouTubeExecutionStatus> {
    const copied = structuredClone(request);
    const entry = this.entries.get(copied.jobId);
    if (!entry || entry.planKey !== JSON.stringify(copied.plan))
      throw new Error('JOB_SELECTION_CHANGED');
    await entry.done;
    if (
      this.entries.get(copied.jobId) !== entry ||
      entry.refreshed ||
      entry.controller.signal.aborted ||
      entry.status.state !== 'failed' ||
      !isYouTubeAddressRejection(entry.status.error) ||
      entry.prepared ||
      entry.cleaning ||
      entry.status.files.length
    )
      throw new Error('SOURCE_REFRESH_UNAVAILABLE');
    this.entries.delete(copied.jobId);
    try {
      const status = this.start(copied);
      this.entries.get(copied.jobId)!.refreshed = true;
      this.entries.get(copied.jobId)!.formatAttempt = entry.formatAttempt ?? 1;
      return status;
    } catch (error) {
      this.entries.set(copied.jobId, entry);
      throw error;
    }
  }

  async release(jobId: string): Promise<YouTubeExecutionStatus | undefined> {
    const entry = this.entries.get(jobId);
    if (!entry) return undefined;
    if (entry.status.directory && !['verified', 'stopped'].includes(entry.status.directory.state))
      throw new Error('DIRECTORY_RECONCILIATION_REQUIRED');
    entry.releasing = true;
    if (['preparing', 'canceling'].includes(entry.status.state)) await this.cancel(jobId);
    await entry.done;
    await this.clean(entry);
    entry.status.state = 'released';
    return this.status(jobId);
  }

  /** A bounded replacement only after a definite format failure and successful cleanup. */
  async nextFormat(request: YouTubeExecutionRequest): Promise<YouTubeExecutionStatus> {
    const entry = this.entries.get(request.jobId);
    if (!entry) throw new Error('FORMAT_RETRY_UNAVAILABLE');
    await entry.done;
    const attempt = entry.formatAttempt ?? 1;
    const previous = JSON.parse(entry.planKey) as YouTubeSelectionPlan;
    if (
      request.plan.videoId !== previous.videoId ||
      request.plan.video.width !== previous.video.width ||
      request.plan.video.height !== previous.video.height ||
      request.plan.video.fps !== previous.video.fps ||
      request.plan.video.dynamicRange !== previous.video.dynamicRange ||
      request.plan.audio?.language !== previous.audio?.language ||
      request.plan.audio?.audioTrackId !== previous.audio?.audioTrackId ||
      request.plan.audio?.audioTrackName !== previous.audio?.audioTrackName
    )
      throw new Error('FORMAT_RETRY_SCOPE_CHANGED');
    if (
      this.entries.get(request.jobId) !== entry ||
      entry.controller.signal.aborted ||
      entry.releasing ||
      attempt >= 3 ||
      entry.status.state !== 'failed' ||
      !canTryAnotherFormat(entry.status.error) ||
      entry.status.files.length ||
      entry.status.directory ||
      entry.planKey === JSON.stringify(request.plan)
    )
      throw new Error('FORMAT_RETRY_UNAVAILABLE');
    await this.clean(entry);
    if (entry.controller.signal.aborted || entry.releasing)
      throw new Error('FORMAT_RETRY_UNAVAILABLE');
    this.entries.delete(request.jobId);
    try {
      const result = this.start(request);
      this.entries.get(request.jobId)!.formatAttempt = attempt + 1;
      return result;
    } catch (error) {
      this.entries.set(request.jobId, entry);
      throw error;
    }
  }

  /** Retry uses the target captured by the first save, never a replacement
   * directory or filenames supplied by the caller. */
  retryDirectory(jobId: string, attempt: number): YouTubeExecutionStatus {
    const entry = this.entries.get(jobId);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1000 || !entry?.directoryKey)
      throw new Error('DIRECTORY_RETRY_REJECTED');
    const { handleId, names } = JSON.parse(entry.directoryKey) as {
      handleId: string;
      names: string[];
    };
    return this.saveDirectory(jobId, handleId, names, attempt);
  }

  /** Trusted background only; the public download UI must first bind a grant. */
  saveDirectory(
    jobId: string,
    handleId: string,
    filenames: string[],
    retryAttempt = 0,
  ): YouTubeExecutionStatus {
    const entry = this.entries.get(jobId);
    if (!entry || entry.releasing || entry.status.state !== 'ready' || !entry.prepared)
      throw new Error('OUTPUT_NOT_READY');
    if (
      typeof handleId !== 'string' ||
      !/^youtube-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        handleId,
      ) ||
      !Array.isArray(filenames) ||
      filenames.length !== entry.prepared.files.length ||
      filenames.some((name) => typeof name !== 'string' || validateDownloadFilename(name) !== name)
    )
      throw new Error('DIRECTORY_TARGET_INVALID');
    const names = [...filenames];
    const directoryKey = JSON.stringify({ handleId, names });
    const previous = entry.status.directory;
    if (entry.directoryKey) {
      if (entry.directoryKey !== directoryKey) throw new Error('DIRECTORY_TARGET_CHANGED');
      if (retryAttempt === 0 || retryAttempt === (previous?.attempt ?? 0))
        return this.status(jobId)!;
      if (
        !Number.isSafeInteger(retryAttempt) ||
        retryAttempt !== (previous?.attempt ?? 0) + 1 ||
        previous?.state !== 'stopped' ||
        entry.directoryController?.signal.aborted
      )
        throw new Error('DIRECTORY_RETRY_REJECTED');
    } else if (retryAttempt !== 0) {
      throw new Error('DIRECTORY_RETRY_REJECTED');
    }
    entry.directoryKey = directoryKey;
    const controller = new AbortController();
    entry.directoryController = controller;
    entry.status.directory = {
      state: 'saving',
      files: [],
      ...(retryAttempt ? { attempt: retryAttempt } : {}),
    };
    const outputs = [...entry.prepared.files];
    const kinds = entry.status.files.map((file) => file.kind);
    const attempted = new Set<number>();
    entry.directoryDone = Promise.resolve().then(async () => {
      try {
        const save =
          this.dependencies.directorySave ??
          (async (request, file, signal) => {
            const [
              { saveJournaledYouTubeDirectoryOutput },
              { createPersistentYouTubeDirectoryJournal },
            ] = await Promise.all([
              import('./directory-save'),
              import('./directory-journal-store'),
            ]);
            const persistence = createPersistentYouTubeDirectoryJournal();
            try {
              return await saveJournaledYouTubeDirectoryOutput(request, file, {
                signal,
                journal: persistence.journal,
              });
            } finally {
              await persistence.close();
            }
          });
        for (const [index, file] of outputs.entries()) {
          controller.signal.throwIfAborted();
          const kind = kinds[index]!;
          attempted.add(index);
          const retained = retryAttempt && previous?.files.some((item) => item.kind === kind);
          const removed = retryAttempt && previous?.removed?.some((item) => item.kind === kind);
          const operation = retained
            ? this.dependencies.directoryRecheck
            : removed
              ? this.dependencies.directoryRetry
              : save;
          const perform =
            operation ??
            (async (
              request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
              file: Blob,
              signal: AbortSignal,
            ) => {
              const adapter = await import('./directory-save');
              const { createPersistentYouTubeDirectoryJournal } =
                await import('./directory-journal-store');
              const persistence = createPersistentYouTubeDirectoryJournal();
              try {
                const options = { journal: persistence.journal, signal };
                if (retained)
                  return await adapter.recheckJournaledYouTubeDirectoryOutput(
                    request,
                    file,
                    options,
                  );
                const record = (await persistence.journal.read()).find(
                  (item) => item.jobId === jobId && item.kind === kind,
                );
                if (
                  !record ||
                  record.handleId !== handleId ||
                  record.requestedName !== request.requestedName ||
                  record.size !== file.size
                )
                  throw new Error('DIRECTORY_RETRY_REJECTED');
                return await adapter.retryJournaledYouTubeDirectoryOutput(record, file, options);
              } finally {
                await persistence.close();
              }
            });
          const result = await perform(
            { jobId, kind, handleId, requestedName: names[index]!, size: file.size },
            file,
            controller.signal,
          );
          if (
            result.handleId !== handleId ||
            result.size !== file.size ||
            (retained &&
              result.fileName !== previous?.files.find((item) => item.kind === kind)?.fileName) ||
            validateDownloadFilename(result.fileName) !== result.fileName
          )
            throw new Error('DIRECTORY_OUTPUT_MISMATCH');
          entry.status.directory!.files.push({ ...result, kind });
        }
        entry.status.directory!.state = 'verified';
      } catch (error) {
        entry.status.directory!.state = 'unknown';
        const message = error instanceof Error ? error.message : '';
        entry.status.directory!.error = /^[A-Z_0-9]{1,80}$/u.test(message)
          ? message
          : 'DIRECTORY_SAVE_UNCONFIRMED';
        const directory = entry.status.directory!;
        directory.unstarted = kinds.filter((_kind, index) => !attempted.has(index));
        directory.removed = [];
        try {
          const removed =
            this.dependencies.directoryRemoved ??
            (async (request) => {
              const { createPersistentYouTubeDirectoryJournal } =
                await import('./directory-journal-store');
              const persistence = createPersistentYouTubeDirectoryJournal();
              try {
                const record = (await persistence.journal.read()).find(
                  (r) => r.jobId === request.jobId && r.kind === request.kind,
                );
                if (
                  record?.phase !== 'removed' ||
                  !record.actualName ||
                  record.handleId !== request.handleId ||
                  record.requestedName !== request.requestedName ||
                  record.size !== request.size
                )
                  return undefined;
                return {
                  handleId: record.handleId,
                  fileName: record.actualName,
                  size: record.size,
                };
              } finally {
                await persistence.close();
              }
            });
          for (const index of attempted) {
            const kind = kinds[index]!;
            if (directory.files.some((file) => file.kind === kind)) continue;
            // A failed read-only check is never evidence that a formerly saved
            // file was removed by this attempt. Retain unknown and the source.
            if (retryAttempt && previous?.files.some((file) => file.kind === kind)) continue;
            const result = await removed({
              jobId,
              kind,
              handleId,
              requestedName: names[index]!,
              size: outputs[index]!.size,
            });
            if (
              result &&
              result.handleId === handleId &&
              result.size === outputs[index]!.size &&
              validateDownloadFilename(result.fileName) === result.fileName
            )
              directory.removed.push({ ...result, kind });
          }
          if (
            directory.files.length + directory.removed.length + directory.unstarted.length ===
            outputs.length
          )
            directory.state = 'stopped';
        } catch {
          /* Missing journal evidence retains unknown and its source. */
        }
      }
    });
    return this.status(jobId)!;
  }

  /** Recheck only after the previous writer settled, using its immutable target. */
  recheckDirectory(jobId: string): YouTubeExecutionStatus {
    const entry = this.entries.get(jobId);
    if (!entry || entry.releasing || entry.status.state !== 'ready' || !entry.prepared)
      throw new Error('OUTPUT_NOT_READY');
    if (!entry.directoryKey || !entry.status.directory)
      throw new Error('DIRECTORY_RECORD_UNAVAILABLE');
    if (entry.status.directory.state === 'saving') throw new Error('DIRECTORY_WRITE_PENDING');
    if (entry.status.directory.state === 'checking') return this.status(jobId)!;
    if (entry.status.directory.state === 'stopped') return this.status(jobId)!;
    const { handleId, names } = JSON.parse(entry.directoryKey) as {
      handleId: string;
      names: string[];
    };
    const files = [...entry.prepared.files];
    const kinds = entry.status.files.map((file) => file.kind);
    const controller = new AbortController();
    entry.directoryController = controller;
    // Prior checks are not evidence of the current contents. Rebuild results.
    entry.status.directory = {
      state: 'checking',
      files: [],
      ...(entry.status.directory.attempt ? { attempt: entry.status.directory.attempt } : {}),
    };
    entry.directoryDone = Promise.resolve().then(async () => {
      try {
        const check =
          this.dependencies.directoryRecheck ??
          (async (request, file, signal) => {
            const [
              { recheckJournaledYouTubeDirectoryOutput },
              { createPersistentYouTubeDirectoryJournal },
            ] = await Promise.all([
              import('./directory-save'),
              import('./directory-journal-store'),
            ]);
            const persistence = createPersistentYouTubeDirectoryJournal();
            try {
              return await recheckJournaledYouTubeDirectoryOutput(request, file, {
                signal,
                journal: persistence.journal,
              });
            } finally {
              await persistence.close();
            }
          });
        for (const [index, file] of files.entries()) {
          controller.signal.throwIfAborted();
          const kind = kinds[index]!;
          const result = await check(
            { jobId, kind, handleId, requestedName: names[index]!, size: file.size },
            file,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if (
            result.handleId !== handleId ||
            result.size !== file.size ||
            validateDownloadFilename(result.fileName) !== result.fileName
          )
            throw new Error('DIRECTORY_OUTPUT_MISMATCH');
          entry.status.directory!.files.push({ ...result, kind });
        }
        entry.status.directory!.state = 'verified';
      } catch (error) {
        entry.status.directory!.state = 'unknown';
        const message = error instanceof Error ? error.message : '';
        entry.status.directory!.error = /^[A-Z_0-9]{1,80}$/u.test(message)
          ? message
          : 'DIRECTORY_SAVE_UNCONFIRMED';
      }
    });
    return this.status(jobId)!;
  }

  async cancelDirectory(jobId: string): Promise<YouTubeExecutionStatus | undefined> {
    const entry = this.entries.get(jobId);
    if (!entry) return undefined;
    if (entry.status.directory && ['saving', 'checking'].includes(entry.status.directory.state))
      entry.directoryController?.abort();
    await entry.directoryDone;
    return this.status(jobId);
  }

  private async clean(entry: Entry): Promise<void> {
    if (entry.cleaning) return entry.cleaning;
    entry.cleaning = Promise.resolve().then(async () => {
      for (const file of entry.status.files)
        (this.dependencies.revokeUrl ?? URL.revokeObjectURL)(file.url);
      entry.status.files = [];
      // Retain the owner if disposal fails so RELEASE can retry safely.
      if (entry.prepared) {
        await entry.prepared.dispose();
        delete entry.prepared;
      }
    });
    try {
      await entry.cleaning;
    } finally {
      delete entry.cleaning;
    }
  }
}
