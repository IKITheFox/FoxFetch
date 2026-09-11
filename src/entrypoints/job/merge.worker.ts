import {
  checkMergeAborted,
  mergeError,
  MERGE_RUNTIME_LIMITS,
  normalizeMergeError,
  preflightCapturedBlobs,
  preflightSeparateTracks,
  remuxStagedBlobsToFile,
  resolveMergeMediaMetadata,
  resolveMergeRequestSources,
  reuseStagedMergeInputsFromOpfs,
  stageMergeInputsToOpfs,
  withMergeDeadline,
  type CapturedBlobProbeOptions,
  type MergeStagingDirectory,
  type RemuxProgress,
} from '../../modules/merge';
import { exportStandardSeparateOutputs } from '../../modules/exports';
import type { JobWorkerEvent, JobWorkerRequest } from './worker-protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<JobWorkerRequest>) => void) | null;
  postMessage(message: JobWorkerEvent): void;
}
const scope = globalThis as unknown as WorkerScope;
let active: { jobId: string; attemptId: string; controller: AbortController } | null = null;
const send = (event: JobWorkerEvent) => scope.postMessage(event);

scope.onmessage = ({ data: message }) => {
  if (message.type === 'CANCEL') {
    if (active?.jobId === message.jobId && active.attemptId === message.attemptId)
      active.controller.abort();
    return;
  }
  if (active) {
    send({
      type: 'FAILED',
      jobId: message.jobId,
      attemptId: message.attemptId,
      failure: {
        code: 'INTERNAL_ERROR',
        message: '已有合并任务正在运行，请先等待或取消。',
        retryable: true,
        canDownloadSeparately: true,
      },
    });
    return;
  }
  const controller = new AbortController();
  const identity = { jobId: message.jobId, attemptId: message.attemptId };
  active = { ...identity, controller };
  send({ type: 'ACK', ...identity });
  const startedAt = Date.now();
  let lastAdvance = startedAt;
  let last: RemuxProgress | undefined;
  const progress = (value: RemuxProgress) => {
    const stage =
      value.stage ??
      (value.phase === 'fetching'
        ? 'staging'
        : value.phase === 'probing'
          ? 'media-metadata'
          : value.phase === 'verifying'
            ? 'verify-output'
            : value.phase);
    if (
      !last ||
      last.stage !== stage ||
      last.readBytes !== value.readBytes ||
      last.packetCount !== value.packetCount ||
      last.processedSeconds !== value.processedSeconds ||
      last.ratio !== value.ratio
    )
      lastAdvance = Date.now();
    last = { ...value, stage };
    send({
      type: 'PROGRESS',
      ...identity,
      progress: { ...last, elapsedMs: Date.now() - startedAt, idleMs: Date.now() - lastAdvance },
    });
  };
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted) return;
    send({ type: 'HEARTBEAT', ...identity });
    if (
      last?.stage !== 'source-selection' &&
      last?.stage !== 'staging' &&
      Date.now() - lastAdvance >= MERGE_RUNTIME_LIMITS.parserIdleMs
    ) {
      controller.abort(
        mergeError('INTERNAL_ERROR', '当前媒体处理阶段长时间没有有效进展。', {
          reason: 'PARSER_TIMEOUT',
          stage: last?.stage ?? 'storage',
          retryable: true,
        }),
      );
    }
  }, MERGE_RUNTIME_LIMITS.heartbeatMs);
  const options: CapturedBlobProbeOptions = {
    onProgress: progress,
    ...(message.request.preferredContainer
      ? { preferredContainer: message.request.preferredContainer }
      : {}),
    ...(message.request.drmSignals ? { drmSignals: message.request.drmSignals } : {}),
    ...(message.request.video.dynamicRange
      ? { videoDynamicRange: message.request.video.dynamicRange }
      : {}),
    ...(message.request.video.streamIdentity
      ? { videoStreamIdentity: message.request.video.streamIdentity }
      : {}),
    ...(message.request.audio.streamIdentity
      ? { audioStreamIdentity: message.request.audio.streamIdentity }
      : {}),
    signal: controller.signal,
  };
  let cleanup: (() => Promise<void>) | undefined;
  void (async () => {
    progress({
      phase: 'probing',
      stage: 'storage',
      ratio: null,
      message: '正在检查浏览器临时存储…',
    });
    const root = await withMergeDeadline(navigator.storage.getDirectory(), {
      signal: controller.signal,
      stage: 'storage',
    });
    const stagingRoot = root as unknown as MergeStagingDirectory;
    const reusable = await withMergeDeadline(
      reuseStagedMergeInputsFromOpfs(message.request, message.jobId, {
        root: stagingRoot,
        signal: controller.signal,
        onProgress: progress,
      }),
      { signal: controller.signal, stage: 'storage' },
    );
    let staged = reusable;
    if (!staged) {
      progress({
        phase: 'probing',
        stage: 'source-selection',
        ratio: null,
        message: '正在连接媒体来源并检查 Range…',
      });
      const resolved = await resolveMergeRequestSources(message.request, {
        signal: controller.signal,
      });
      if (message.type === 'PREFLIGHT' && !resolved.requiresLocalBlobSource) {
        progress({
          phase: 'probing',
          stage: 'media-metadata',
          ratio: null,
          message: '正在读取媒体索引和编码配置…',
        });
        const capability = await preflightSeparateTracks(resolved.request, {
          signal: controller.signal,
          onProgress: progress,
        });
        checkMergeAborted(controller.signal);
        if (
          capability.status === 'supported' ||
          capability.failure.reason !== 'RANGE_UNSUPPORTED'
        ) {
          send({ type: 'CAPABILITY', ...identity, capability });
          return;
        }
        // The capability probe has disposed both remote inputs before returning.
        // At most one fallback: all further parsing reads the complete local files.
        progress({
          phase: 'fetching',
          stage: 'staging',
          ratio: null,
          message: '来源分段读取发生变化，正在顺序下载并暂存到磁盘…',
          network: {
            readMode: 'sequential',
            fallback: 'range-unavailable',
            responseStatus: capability.failure.network?.responseStatus ?? 200,
          },
        });
      }
      staged = await stageMergeInputsToOpfs(resolved.request, message.jobId, {
        root: stagingRoot,
        signal: controller.signal,
        skipSourceSelection: true,
        preserveForReuse: message.type === 'PREFLIGHT',
        onProgress: progress,
      });
    }
    cleanup = staged.cleanup;
    checkMergeAborted(controller.signal);
    if (message.type === 'PREFLIGHT') {
      progress({
        phase: 'probing',
        stage: 'decoder-config',
        ratio: null,
        readBytes: staged.readBytes,
        totalBytes: staged.readBytes,
        message: '媒体读取完成，正在检查 HEVC / 动态范围配置…',
      });
      const capability = await preflightCapturedBlobs(staged.videoBlob, staged.audioBlob, options);
      checkMergeAborted(controller.signal);
      if (capability.status === 'supported') cleanup = undefined;
      else {
        await cleanup();
        cleanup = undefined;
      }
      send({ type: 'CAPABILITY', ...identity, capability });
      return;
    }
    progress({
      phase: 'probing',
      stage: 'media-metadata',
      ratio: null,
      message: '正在准备文件信息。',
    });
    const metadata = await withMergeDeadline(
      resolveMergeMediaMetadata(message.request.metadata, { signal: controller.signal }),
      {
        signal: controller.signal,
        stage: 'media-metadata',
        onStop: (reason) => controller.abort(reason),
      },
    );
    progress({
      phase: 'probing',
      stage: 'decoder-config',
      ratio: null,
      message: '正在读取本地编码与动态范围配置…',
    });
    const remuxOptions = { ...options, ...(metadata ? { metadata } : {}), onProgress: progress };
    if (message.type === 'EXPORT_SEPARATE') {
      const result = await exportStandardSeparateOutputs(
        staged.videoBlob,
        staged.audioBlob,
        message.handles,
        staged.readBytes,
        remuxOptions,
      );
      checkMergeAborted(controller.signal);
      await cleanup();
      cleanup = undefined;
      send({ type: 'SEPARATE_COMPLETED', ...identity, result });
    } else {
      const result = await remuxStagedBlobsToFile(
        staged.videoBlob,
        staged.audioBlob,
        message.handle,
        staged.readBytes,
        remuxOptions,
      );
      checkMergeAborted(controller.signal);
      await cleanup();
      cleanup = undefined;
      send({ type: 'COMPLETED', ...identity, result });
    }
  })()
    .catch(async (error: unknown) => {
      await cleanup?.().catch(() => undefined);
      cleanup = undefined;
      const failure = normalizeMergeError(
        controller.signal.aborted ? controller.signal.reason : error,
      ).detail;
      if (message.type === 'PREFLIGHT')
        send({
          type: 'CAPABILITY',
          ...identity,
          capability: {
            status: failure.code === 'DRM_PROTECTED' ? 'blocked' : 'unsupported',
            canMerge: false,
            canDownloadSeparately: failure.canDownloadSeparately,
            failure,
          },
        });
      else send({ type: 'FAILED', ...identity, failure });
    })
    .finally(() => {
      clearInterval(heartbeat);
      if (active?.jobId === message.jobId && active.attemptId === message.attemptId) active = null;
    });
};
