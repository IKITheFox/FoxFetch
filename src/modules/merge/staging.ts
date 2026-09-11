import { mergeError, MergeError, normalizeMergeError } from './errors';
import { createTimedMergeFetch, checkMergeAborted, withMergeDeadline } from './runtime-control';
import type {
  MergeSourceLocation,
  MergeSourceRequest,
  RemuxProgress,
  SeparateTrackMergeRequest,
  MergeNetworkDiagnostic,
} from './types';

interface StagingWritable {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface StagingFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<StagingWritable>;
  getFile(): Promise<File>;
}

export interface MergeStagingDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<StagingFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries?(): AsyncIterableIterator<[string, { kind?: string }]>;
}

export interface StageMergeInputsOptions {
  root: MergeStagingDirectory;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: RemuxProgress) => void;
  now?: () => number;
  /** Sources were already selected by resolveMergeRequestSources. */
  skipSourceSelection?: boolean;
  /** Keep a verified descriptor so a later EXECUTE worker can reuse these bytes. */
  preserveForReuse?: boolean;
  reuseTtlMs?: number;
}

export interface StagedMergeInputs {
  videoBlob: Blob;
  audioBlob: Blob;
  readBytes: number;
  cleanup(): Promise<void>;
}

interface TrackDownloadState {
  readBytes: number;
  totalBytes: number | null;
  complete: boolean;
  network?: MergeNetworkDiagnostic;
}

const REPORT_INTERVAL_MS = 120;
const MAX_RANGE_RESPONSES = 16_384;
const MAX_STAGING_DESCRIPTOR_BYTES = 16 * 1_024;
const STAGING_DESCRIPTOR_VERSION = 1;

export const PAGE_ASSISTED_STAGING_MAX_CHUNK_BYTES = 1 * 1024 * 1024;
export const PAGE_ASSISTED_STAGING_MAX_TRACK_BYTES = 512 * 1024 * 1024 * 1024;

/**
 * Long enough for the user to review the preflight result and choose a target,
 * while still bounding abandoned OPFS input files.
 */
export const STAGED_MERGE_INPUT_TTL_MS = 15 * 60 * 1_000;

interface StagedMergeInputDescriptor {
  version: typeof STAGING_DESCRIPTOR_VERSION;
  requestFingerprint: string;
  videoBytes: number;
  audioBytes: number;
  readBytes: number;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvedMergeRequestSources {
  request: SeparateTrackMergeRequest;
  /** True when at least one selected origin only supports sequential HTTP 200. */
  requiresLocalBlobSource: boolean;
}

function safeJobId(jobId: string): string {
  return jobId.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 96) || 'job';
}

function inputNames(jobId: string): readonly [string, string] {
  const id = safeJobId(jobId);
  return [`merge-${id}-video.input`, `merge-${id}-audio.input`];
}

function descriptorName(jobId: string): string {
  return `merge-${safeJobId(jobId)}-staging.json`;
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

interface ParsedContentRange {
  start: number;
  end: number;
  total: number;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu.exec(value?.trim() ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

function sourceLocations(source: MergeSourceRequest): MergeSourceLocation[] {
  const locations = [source, ...(source.sources ?? [])];
  const seen = new Set<string>();
  return locations.filter((location) => {
    if (seen.has(location.url)) return false;
    seen.add(location.url);
    return true;
  });
}

function portableSourceLocation(
  source: MergeSourceRequest,
  location: MergeSourceLocation,
): MergeSourceLocation {
  return {
    url: location.url,
    credentials: location.credentials ?? source.credentials ?? 'include',
    ...((location.declaredMimeType ?? source.declaredMimeType)
      ? { declaredMimeType: location.declaredMimeType ?? source.declaredMimeType }
      : {}),
  };
}

function canonicalTrackIdentity(source: MergeSourceRequest) {
  return {
    streamIdentity: source.streamIdentity?.trim() || null,
    locations: sourceLocations(source)
      .map((location) => portableSourceLocation(source, location))
      .sort((left, right) =>
        `${left.url}\n${left.credentials ?? ''}\n${left.declaredMimeType ?? ''}`.localeCompare(
          `${right.url}\n${right.credentials ?? ''}\n${right.declaredMimeType ?? ''}`,
        ),
      ),
  };
}

/**
 * Produces a non-reversible identity for the exact representations staged in
 * OPFS. Signed media URLs are never written to the staging descriptor.
 */
export async function mergeStagingRequestFingerprint(
  request: SeparateTrackMergeRequest,
): Promise<string> {
  const canonical = JSON.stringify({
    video: canonicalTrackIdentity(request.video),
    audio: canonicalTrackIdentity(request.audio),
    preferredContainer: request.preferredContainer ?? null,
    drmSignals: [...new Set(request.drmSignals ?? [])].sort(),
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface SelectedSource {
  source: MergeSourceRequest;
  supportsStrictRange: boolean;
}

function selectedSourceRequest(
  source: MergeSourceRequest,
  location: MergeSourceLocation,
): MergeSourceRequest {
  return {
    ...source,
    url: location.url,
    credentials: location.credentials ?? source.credentials ?? 'include',
    ...((location.declaredMimeType ?? source.declaredMimeType)
      ? { declaredMimeType: location.declaredMimeType ?? source.declaredMimeType }
      : {}),
    // Keep every equivalent location. A strict-range probe can succeed and a
    // later full transfer can still fail; execution must be able to restart
    // the same representation from byte zero on a mirror.
    sources: sourceLocations(source).map((candidate) => portableSourceLocation(source, candidate)),
  };
}

async function discardProbeBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function selectSource(
  source: MergeSourceRequest,
  options: Pick<StageMergeInputsOptions, 'fetchFn' | 'signal'>,
): Promise<SelectedSource> {
  const fetchFn = createTimedMergeFetch(options.fetchFn ?? fetch, options.signal);
  let sequential: MergeSourceLocation | undefined;
  let sawInvalidRange = false;
  let lastStatus: number | undefined;
  const responseStatuses: number[] = [];
  let sawTransportFailure = false;
  let lastTransportError: unknown;

  for (const location of sourceLocations(source).slice(0, 3)) {
    throwIfAborted(options.signal);
    let response: Response;
    try {
      response = await fetchFn(location.url, {
        method: 'GET',
        credentials: location.credentials ?? source.credentials ?? 'include',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throwIfAborted(options.signal);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      sawTransportFailure = true;
      lastTransportError = error;
      continue;
    }

    lastStatus = response.status;
    responseStatuses.push(response.status);
    const range = parseContentRange(response.headers.get('content-range'));
    if (response.status === 206) {
      const valid = range?.start === 0 && range.end === 0;
      await discardProbeBody(response);
      if (valid) {
        return {
          source: selectedSourceRequest(source, location),
          supportsStrictRange: true,
        };
      }
      sawInvalidRange = true;
      continue;
    }
    if (response.status === 200 && !sequential) sequential = location;
    await discardProbeBody(response);
  }

  if (sequential) {
    return {
      source: selectedSourceRequest(source, sequential),
      supportsStrictRange: false,
    };
  }
  if (sawInvalidRange) {
    throw mergeError(
      'RANGE_RESPONSE_INVALID',
      '媒体镜像返回了无效的 Content-Range，无法确认字节连续性。',
      {
        retryable: true,
        canDownloadSeparately: true,
        reason: 'RANGE_INVALID',
        stage: 'source-headers',
      },
    );
  }
  if (lastTransportError instanceof MergeError && responseStatuses.length === 0)
    throw lastTransportError;
  throw mergeError(
    'NETWORK_FAILED',
    `媒体镜像均不可读取${lastStatus == null ? '' : `（最后 HTTP ${lastStatus}）`}。`,
    {
      retryable: true,
      canDownloadSeparately: true,
      ...(!sawTransportFailure &&
      responseStatuses.length > 0 &&
      responseStatuses.every((status) => status === 403)
        ? { httpStatus: 403 }
        : {}),
    },
  );
}

/**
 * Prefers a strict 206 mirror for each representation. If every usable mirror
 * returns 200, the caller must stage it sequentially and inspect a local File;
 * it must not hand that origin to a bounded random-access UrlSource.
 */
export async function resolveMergeRequestSources(
  request: SeparateTrackMergeRequest,
  options: Pick<StageMergeInputsOptions, 'fetchFn' | 'signal'> = {},
): Promise<ResolvedMergeRequestSources> {
  if (request.drmSignals && request.drmSignals.length > 0) {
    throw mergeError(
      'DRM_PROTECTED',
      '检测到加密或 DRM 信号；FoxFetch 不会请求密钥或尝试绕过保护。',
      {
        canDownloadSeparately: false,
        drmSignals: [...new Set(request.drmSignals)],
      },
    );
  }
  const videoIdentity = request.video.streamIdentity?.trim();
  const audioIdentity = request.audio.streamIdentity?.trim();
  if (videoIdentity && audioIdentity && videoIdentity !== audioIdentity) {
    throw mergeError(
      'TIMELINE_MISMATCH',
      '音视频轨属于不同的媒体身份；为避免把不同视频配在一起，已停止无损合并。',
      {
        canDownloadSeparately: true,
        reason: 'SOURCE_IDENTITY_MISMATCH',
        stage: 'source-selection',
      },
    );
  }
  const [video, audio] = await Promise.all([
    selectSource(request.video, options),
    selectSource(request.audio, options),
  ]);
  // Dolby Vision needs the complete, source-ordered ISO-BMFF file before we can
  // prove that the original sample entry and every DV metadata box survived
  // packet-copy. A range-capable origin is useful for ordinary probing, but it
  // is not sufficient evidence for this preservation path. Force the worker to
  // stage both tracks even when both selected mirrors returned a strict 206.
  const requiresDolbyVisionStaging = request.video.dynamicRange?.range === 'Dolby Vision';
  return {
    request: { ...request, video: video.source, audio: audio.source },
    requiresLocalBlobSource:
      requiresDolbyVisionStaging || !video.supportsStrictRange || !audio.supportsStrictRange,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  checkMergeAborted(signal);
}

/** A deadline requests abort; only the original operation settling releases its OPFS owner. */
async function ownedStagingOperation<T>(
  operation: Promise<T>,
  writable: StagingWritable,
  signal?: AbortSignal,
): Promise<T> {
  let aborting: Promise<void> | undefined;
  const stop = (reason: unknown) => {
    if (aborting) return;
    try {
      aborting = Promise.resolve(writable.abort?.(reason)).catch(() => undefined);
    } catch {
      aborting = Promise.resolve();
    }
  };
  try {
    const result = await withMergeDeadline(operation, {
      ...(signal ? { signal } : {}),
      stage: 'storage',
      onStop: stop,
    });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    stop(error);
    // Native writes/close can ignore abort. Do not clean/reuse the input file
    // while such an operation still owns it; the host may force-stop a worker.
    await Promise.allSettled([operation, aborting]);
    throw error;
  }
}

async function writeResponseBody(
  response: Response,
  writable: StagingWritable,
  signal: AbortSignal | undefined,
  onChunk: (bytes: number) => void,
): Promise<number> {
  let written = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    await ownedStagingOperation(writable.write(bytes), writable, signal);
    onChunk(bytes.byteLength);
    return bytes.byteLength;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      await ownedStagingOperation(writable.write(next.value), writable, signal);
      written += next.value.byteLength;
      onChunk(next.value.byteLength);
    }
    return written;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function downloadTrackAttempt(
  source: SeparateTrackMergeRequest['video'],
  handle: StagingFileHandle,
  state: TrackDownloadState,
  options: StageMergeInputsOptions,
  reportProgress: (force?: boolean) => void,
  sequentialOnly = false,
): Promise<File> {
  const fetchFn = createTimedMergeFetch(options.fetchFn ?? fetch, options.signal);
  throwIfAborted(options.signal);
  // Retain ownership of the native operation: a deadline cannot cancel OPFS.
  // Do not report this task settled until a late writer has been released.
  const opening = handle.createWritable({ keepExistingData: false });
  let writable: StagingWritable;
  try {
    writable = await withMergeDeadline(opening, {
      ...(options.signal ? { signal: options.signal } : {}),
      stage: 'storage',
    });
  } catch (error) {
    await opening.then((late) => late.abort?.(error)).catch(() => undefined);
    throw error;
  }
  let offset = 0;
  let responses = 0;
  let declaredTotal: number | undefined;
  let validator: string | undefined;
  try {
    while (true) {
      throwIfAborted(options.signal);
      if (++responses > MAX_RANGE_RESPONSES) {
        throw mergeError('NETWORK_FAILED', '媒体来源返回了过多分段，已停止下载。', {
          retryable: true,
          canDownloadSeparately: true,
        });
      }
      let response: Response;
      try {
        response = await fetchFn(source.url, {
          method: 'GET',
          credentials: source.credentials ?? 'include',
          cache: 'no-store',
          headers: sequentialOnly
            ? {}
            : {
                Range: `bytes=${offset}-`,
                ...(offset > 0 && validator ? { 'If-Range': validator } : {}),
              },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        throwIfAborted(options.signal);
        if (error instanceof MergeError) throw error;
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw mergeError('NETWORK_FAILED', '媒体来源连接中断，正在尝试同轨镜像。', {
          retryable: true,
          canDownloadSeparately: true,
          cause: error,
        });
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw mergeError('NETWORK_FAILED', `媒体来源下载失败（HTTP ${response.status}）。`, {
          retryable: true,
          canDownloadSeparately: true,
        });
      }

      const range = parseContentRange(response.headers.get('content-range'));
      const lengthHeader = response.headers.get('content-length');
      const declaredLength = parsePositiveInteger(lengthHeader);
      const etag = response.headers.get('etag');
      const currentValidator =
        etag && !etag.startsWith('W/')
          ? etag
          : (response.headers.get('last-modified') ?? undefined);
      if (response.status === 206) {
        if (
          !range ||
          range.start !== offset ||
          (declaredTotal != null && declaredTotal !== range.total) ||
          (offset > 0 && validator !== currentValidator) ||
          (lengthHeader != null && declaredLength !== range.end - range.start + 1) ||
          (sequentialOnly && (range.start !== 0 || range.end + 1 !== range.total))
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw mergeError('RANGE_RESPONSE_INVALID', '媒体来源返回了不连续的 Range 数据。', {
            retryable: true,
            canDownloadSeparately: true,
            reason: 'RANGE_INVALID',
            stage: 'source-headers',
          });
        }
        if (range.end + 1 < range.total && !currentValidator) {
          void response.body?.cancel().catch(() => undefined);
          throw mergeError('RANGE_RESPONSE_INVALID', '无法验证跨分段资源一致性，需从零完整读取。', {
            reason: 'RANGE_UNSUPPORTED',
            stage: 'source-headers',
            retryable: true,
          });
        }
        declaredTotal = range.total;
        validator = currentValidator;
        state.totalBytes = range.total;
      } else if (response.status === 200 && offset > 0) {
        void response.body?.cancel().catch(() => undefined);
        throw mergeError('RANGE_RESPONSE_INVALID', '媒体来源在续传时忽略 Range，需从零完整读取。', {
          retryable: true,
          canDownloadSeparately: true,
          reason: 'RANGE_UNSUPPORTED',
          stage: 'source-headers',
        });
      } else {
        if (
          response.status !== 200 ||
          response.headers.has('content-range') ||
          (lengthHeader != null && declaredLength == null)
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw mergeError('RANGE_RESPONSE_INVALID', '完整媒体响应头不一致，已停止暂存。', {
            reason: 'RANGE_INVALID',
            stage: 'source-headers',
            retryable: true,
          });
        }
        state.totalBytes = declaredLength;
      }
      state.network = {
        readMode: response.status === 206 ? 'range' : 'sequential',
        responseStatus: response.status,
        requestStart: offset,
        ...(sequentialOnly ? { fallback: 'range-unavailable' as const } : {}),
        ...(range
          ? { responseStart: range.start, responseEnd: range.end, totalBytes: range.total }
          : {}),
      };
      reportProgress(true);

      const written = await writeResponseBody(response, writable, options.signal, (bytes) => {
        offset += bytes;
        state.readBytes += bytes;
        reportProgress();
      });
      if (written === 0 && (state.totalBytes == null || offset < state.totalBytes)) {
        throw mergeError('NETWORK_FAILED', '媒体来源提前结束，未获得完整文件。', {
          retryable: true,
          canDownloadSeparately: true,
        });
      }
      if (range && offset !== range.end + 1) {
        throw mergeError('RANGE_RESPONSE_INVALID', '媒体来源 Range 长度与响应声明不一致。', {
          retryable: true,
          canDownloadSeparately: true,
          reason: 'RANGE_INVALID',
          stage: 'source-body',
        });
      }
      if (!range || offset >= range.total) break;
    }

    if (state.totalBytes == null) state.totalBytes = state.readBytes;
    if (state.totalBytes !== state.readBytes) {
      throw mergeError('NETWORK_FAILED', '媒体来源大小校验失败，未进入合并阶段。', {
        retryable: true,
        canDownloadSeparately: true,
      });
    }
    reportProgress(true);
    await ownedStagingOperation(writable.close(), writable, options.signal);
    const file = await ownedStagingOperation(handle.getFile(), writable, options.signal);
    throwIfAborted(options.signal);
    if (file.size !== state.readBytes || file.size <= 0) {
      throw mergeError('OUTPUT_WRITE_FAILED', '磁盘暂存大小与已读取字节不一致，未进入合并阶段。', {
        stage: 'storage',
        retryable: true,
      });
    }
    state.complete = true;
    reportProgress(true);
    return file;
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw normalizeMergeError(error);
  }
}

async function downloadTrack(
  source: SeparateTrackMergeRequest['video'],
  handle: StagingFileHandle,
  state: TrackDownloadState,
  options: StageMergeInputsOptions,
  reportProgress: (force?: boolean) => void,
): Promise<File> {
  const attempts = sourceLocations(source)
    .slice(0, 3)
    .map((location) => selectedSourceRequest(source, location));
  let lastError: unknown;

  let sequentialRestarted = false;

  for (const candidate of attempts) {
    throwIfAborted(options.signal);
    state.readBytes = 0;
    state.totalBytes = null;
    state.complete = false;
    reportProgress(true);
    try {
      return await downloadTrackAttempt(candidate, handle, state, options, reportProgress);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      lastError = error;
      if (
        !sequentialRestarted &&
        error instanceof MergeError &&
        error.detail.reason === 'RANGE_UNSUPPORTED'
      ) {
        sequentialRestarted = true;
        throwIfAborted(options.signal);
        state.readBytes = 0;
        state.totalBytes = null;
        state.complete = false;
        state.network = { readMode: 'sequential', fallback: 'range-unavailable' };
        reportProgress(true);
        try {
          return await downloadTrackAttempt(
            candidate,
            handle,
            state,
            options,
            reportProgress,
            true,
          );
        } catch (restartError) {
          throwIfAborted(options.signal);
          lastError = restartError;
        }
      }
    }
  }

  throw normalizeMergeError(lastError ?? new Error('没有可用的同轨媒体镜像'));
}

function isSafeByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseStagedDescriptor(value: unknown): StagedMergeInputDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const descriptor = value as Partial<StagedMergeInputDescriptor>;
  if (
    descriptor.version !== STAGING_DESCRIPTOR_VERSION ||
    typeof descriptor.requestFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(descriptor.requestFingerprint) ||
    !isSafeByteCount(descriptor.videoBytes) ||
    !isSafeByteCount(descriptor.audioBytes) ||
    !isSafeByteCount(descriptor.readBytes) ||
    descriptor.readBytes !== descriptor.videoBytes + descriptor.audioBytes ||
    typeof descriptor.createdAt !== 'number' ||
    !Number.isFinite(descriptor.createdAt) ||
    typeof descriptor.expiresAt !== 'number' ||
    !Number.isFinite(descriptor.expiresAt) ||
    descriptor.expiresAt <= descriptor.createdAt
  ) {
    return null;
  }
  return descriptor as StagedMergeInputDescriptor;
}

async function readStagedDescriptor(
  root: MergeStagingDirectory,
  jobId: string,
): Promise<StagedMergeInputDescriptor | null> {
  try {
    const handle = await root.getFileHandle(descriptorName(jobId));
    const file = await handle.getFile();
    if (file.size <= 0 || file.size > MAX_STAGING_DESCRIPTOR_BYTES) return null;
    return parseStagedDescriptor(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

async function writeStagedDescriptor(
  root: MergeStagingDirectory,
  jobId: string,
  descriptor: StagedMergeInputDescriptor,
): Promise<void> {
  const handle = await root.getFileHandle(descriptorName(jobId), { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(JSON.stringify(descriptor));
    await writable.close();
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
}

export async function cleanupStagedMergeInputs(
  root: MergeStagingDirectory,
  jobId: string,
  options: { strict?: boolean } = {},
): Promise<void> {
  await Promise.all(
    [...inputNames(jobId), descriptorName(jobId)].map((name) =>
      root.removeEntry(name).catch((error: unknown) => {
        if (options.strict && !(error instanceof DOMException && error.name === 'NotFoundError'))
          throw error;
      }),
    ),
  );
}

export interface ReuseStagedMergeInputsOptions {
  root: MergeStagingDirectory;
  signal?: AbortSignal;
  onProgress?: (progress: RemuxProgress) => void;
  now?: () => number;
}

export interface PageAssistedMergeStagingSession {
  append(
    track: 'video' | 'audio',
    offset: number,
    totalBytes: number,
    bytes: Uint8Array,
  ): Promise<{ persistedBytes: number; trackBytes: number }>;
  commit(): Promise<StagedMergeInputs>;
  abort(reason?: unknown): Promise<void>;
}

export interface BeginPageAssistedMergeStagingOptions {
  root: MergeStagingDirectory;
  now?: () => number;
  reuseTtlMs?: number;
}

/**
 * Open a descriptor-last OPFS transaction for bytes admitted by the strict
 * page-assisted Bilibili range bridge. Callers cannot seek, overlap, leave a
 * hole, or change a track's declared total after its first chunk.
 */
export async function beginPageAssistedMergeStaging(
  request: SeparateTrackMergeRequest,
  jobId: string,
  options: BeginPageAssistedMergeStagingOptions,
): Promise<PageAssistedMergeStagingSession> {
  if (request.drmSignals && request.drmSignals.length > 0) {
    throw mergeError(
      'DRM_PROTECTED',
      '检测到加密或 DRM 信号；FoxFetch 不会为页面辅助下载创建缓存。',
      {
        canDownloadSeparately: false,
        drmSignals: [...new Set(request.drmSignals)],
      },
    );
  }
  const videoIdentity = request.video.streamIdentity?.trim();
  const audioIdentity = request.audio.streamIdentity?.trim();
  if (!videoIdentity || !audioIdentity || videoIdentity !== audioIdentity) {
    throw mergeError('TIMELINE_MISMATCH', '页面辅助下载的音视频身份不完整或不一致。', {
      canDownloadSeparately: true,
    });
  }
  const reuseTtlMs = options.reuseTtlMs ?? STAGED_MERGE_INPUT_TTL_MS;
  if (!Number.isFinite(reuseTtlMs) || reuseTtlMs <= 0) {
    throw new TypeError('缓存复用有效期必须是正数');
  }

  await cleanupStagedMergeInputs(options.root, jobId);
  const requestFingerprint = await mergeStagingRequestFingerprint(request);
  const [videoName, audioName] = inputNames(jobId);
  const [videoHandle, audioHandle] = await Promise.all([
    options.root.getFileHandle(videoName, { create: true }),
    options.root.getFileHandle(audioName, { create: true }),
  ]);
  const [videoWritable, audioWritable] = await Promise.all([
    videoHandle.createWritable({ keepExistingData: false }),
    audioHandle.createWritable({ keepExistingData: false }),
  ]);
  const tracks = {
    video: {
      handle: videoHandle,
      writable: videoWritable,
      written: 0,
      total: null as number | null,
    },
    audio: {
      handle: audioHandle,
      writable: audioWritable,
      written: 0,
      total: null as number | null,
    },
  };
  let terminal = false;
  let committed = false;

  const abort = async (reason?: unknown): Promise<void> => {
    if (terminal && !committed) return;
    terminal = true;
    await Promise.allSettled([
      tracks.video.writable.abort?.(reason),
      tracks.audio.writable.abort?.(reason),
    ]);
    await cleanupStagedMergeInputs(options.root, jobId);
  };

  const append: PageAssistedMergeStagingSession['append'] = async (
    track,
    offset,
    totalBytes,
    bytes,
  ) => {
    try {
      if (terminal) throw new Error('页面辅助缓存会话已经结束。');
      const state = tracks[track];
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes <= 0 ||
        totalBytes > PAGE_ASSISTED_STAGING_MAX_TRACK_BYTES ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength <= 0 ||
        bytes.byteLength > PAGE_ASSISTED_STAGING_MAX_CHUNK_BYTES ||
        offset !== state.written ||
        (state.total != null && state.total !== totalBytes) ||
        !Number.isSafeInteger(offset + bytes.byteLength) ||
        offset + bytes.byteLength > totalBytes
      ) {
        throw mergeError(
          'RANGE_RESPONSE_INVALID',
          '页面辅助缓存分片不连续、大小无效或总长度发生变化。',
          { retryable: true, canDownloadSeparately: true },
        );
      }
      state.total ??= totalBytes;
      const stableBytes = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await state.writable.write(stableBytes);
      state.written += bytes.byteLength;
      return { persistedBytes: bytes.byteLength, trackBytes: state.written };
    } catch (error) {
      await abort(error);
      throw normalizeMergeError(error);
    }
  };

  const commit = async (): Promise<StagedMergeInputs> => {
    try {
      if (terminal) throw new Error('页面辅助缓存会话已经结束。');
      if (
        tracks.video.total == null ||
        tracks.audio.total == null ||
        tracks.video.written !== tracks.video.total ||
        tracks.audio.written !== tracks.audio.total
      ) {
        throw mergeError('NETWORK_FAILED', '页面辅助下载尚未完整接收音视频双轨。', {
          retryable: true,
          canDownloadSeparately: true,
        });
      }
      await Promise.all([tracks.video.writable.close(), tracks.audio.writable.close()]);
      const [videoFile, audioFile] = await Promise.all([
        tracks.video.handle.getFile(),
        tracks.audio.handle.getFile(),
      ]);
      if (videoFile.size !== tracks.video.written || audioFile.size !== tracks.audio.written) {
        throw mergeError('OUTPUT_SIZE_MISMATCH', '写入后的页面缓存大小与预期不一致。', {
          retryable: true,
          canDownloadSeparately: true,
        });
      }
      const createdAt = (options.now ?? Date.now)();
      await writeStagedDescriptor(options.root, jobId, {
        version: STAGING_DESCRIPTOR_VERSION,
        requestFingerprint,
        videoBytes: videoFile.size,
        audioBytes: audioFile.size,
        readBytes: videoFile.size + audioFile.size,
        createdAt,
        expiresAt: createdAt + reuseTtlMs,
      });
      terminal = true;
      committed = true;
      return {
        videoBlob: videoFile,
        audioBlob: audioFile,
        readBytes: videoFile.size + audioFile.size,
        cleanup: () => cleanupStagedMergeInputs(options.root, jobId),
      };
    } catch (error) {
      await abort(error);
      throw normalizeMergeError(error);
    }
  };

  return { append, commit, abort };
}

/**
 * Reopens a completed preflight download only when its opaque request identity,
 * expiry and both byte counts still match. Any partial or mismatched state is
 * removed before returning so it can never be mistaken for a safe input pair.
 */
export async function reuseStagedMergeInputsFromOpfs(
  request: SeparateTrackMergeRequest,
  jobId: string,
  options: ReuseStagedMergeInputsOptions,
): Promise<StagedMergeInputs | null> {
  throwIfAborted(options.signal);
  const descriptor = await readStagedDescriptor(options.root, jobId);
  if (!descriptor) {
    await cleanupStagedMergeInputs(options.root, jobId);
    return null;
  }
  const fingerprint = await mergeStagingRequestFingerprint(request);
  throwIfAborted(options.signal);
  if (
    descriptor.expiresAt <= (options.now ?? Date.now)() ||
    descriptor.requestFingerprint !== fingerprint
  ) {
    await cleanupStagedMergeInputs(options.root, jobId);
    return null;
  }

  try {
    const [videoName, audioName] = inputNames(jobId);
    const [videoFile, audioFile] = await Promise.all([
      options.root.getFileHandle(videoName).then((handle) => handle.getFile()),
      options.root.getFileHandle(audioName).then((handle) => handle.getFile()),
    ]);
    if (
      videoFile.size !== descriptor.videoBytes ||
      audioFile.size !== descriptor.audioBytes ||
      videoFile.size + audioFile.size !== descriptor.readBytes
    ) {
      await cleanupStagedMergeInputs(options.root, jobId);
      return null;
    }
    options.onProgress?.({
      phase: 'fetching',
      ratio: 1,
      readBytes: descriptor.readBytes,
      totalBytes: descriptor.readBytes,
      message: '已复用安全预检下载，无需重复读取媒体。',
    });
    return {
      videoBlob: videoFile,
      audioBlob: audioFile,
      readBytes: descriptor.readBytes,
      cleanup: () => cleanupStagedMergeInputs(options.root, jobId),
    };
  } catch {
    await cleanupStagedMergeInputs(options.root, jobId);
    return null;
  }
}

/** Removes expired, malformed and interrupted staging pairs after host restart. */
export async function cleanupExpiredStagedMergeInputs(
  root: MergeStagingDirectory,
  options: { now?: () => number } = {},
): Promise<void> {
  if (!root.entries) return;
  const ids = new Set<string>();
  for await (const [name] of root.entries()) {
    const match = /^merge-(.+?)-(?:video\.input|audio\.input|staging\.json)$/u.exec(name);
    if (match?.[1]) ids.add(match[1]);
  }
  const now = (options.now ?? Date.now)();
  for (const id of ids) {
    const descriptor = await readStagedDescriptor(root, id);
    if (!descriptor || descriptor.expiresAt <= now) {
      await cleanupStagedMergeInputs(root, id);
    }
  }
}

/**
 * Streams both remote tracks to OPFS before any muxer is created. This gives
 * the 0-70% download phase a real completion boundary and bounds heap usage.
 */
export async function stageMergeInputsToOpfs(
  request: SeparateTrackMergeRequest,
  jobId: string,
  options: StageMergeInputsOptions,
): Promise<StagedMergeInputs> {
  await cleanupStagedMergeInputs(options.root, jobId);
  const selectedRequest = options.skipSourceSelection
    ? request
    : (await resolveMergeRequestSources(request, options)).request;
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const taskOptions: StageMergeInputsOptions = {
    ...options,
    signal: controller.signal,
  };
  const [videoName, audioName] = inputNames(jobId);
  const videoState: TrackDownloadState = { readBytes: 0, totalBytes: null, complete: false };
  const audioState: TrackDownloadState = { readBytes: 0, totalBytes: null, complete: false };
  const now = options.now ?? Date.now;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  const reportProgress = (force = false): void => {
    const timestamp = now();
    if (!force && timestamp - lastReportAt < REPORT_INTERVAL_MS) return;
    lastReportAt = timestamp;
    const readBytes = videoState.readBytes + audioState.readBytes;
    const totalBytes =
      videoState.totalBytes == null || audioState.totalBytes == null
        ? null
        : videoState.totalBytes + audioState.totalBytes;
    const complete = videoState.complete && audioState.complete;
    options.onProgress?.({
      phase: 'fetching',
      ratio: complete
        ? 1
        : totalBytes && totalBytes > 0
          ? Math.min(1, readBytes / totalBytes)
          : null,
      readBytes,
      ...(totalBytes == null ? {} : { totalBytes }),
      message: '正在下载媒体数据…',
      ...((videoState.network ?? audioState.network)
        ? {
            network: videoState.network?.fallback
              ? videoState.network
              : audioState.network?.fallback
                ? audioState.network
                : (videoState.network ?? audioState.network!),
          }
        : {}),
    });
  };

  let tasks: Promise<File>[] = [];
  try {
    throwIfAborted(controller.signal);
    const opening = Promise.allSettled([
      options.root.getFileHandle(videoName, { create: true }),
      options.root.getFileHandle(audioName, { create: true }),
    ]);
    let opened: Awaited<typeof opening>;
    try {
      opened = await withMergeDeadline(opening, { signal: controller.signal, stage: 'storage' });
    } catch (error) {
      // A late getFileHandle can create a file; wait for it before cleanup.
      await opening;
      throw error;
    }
    const video = opened[0]!;
    const audio = opened[1]!;
    if (video.status === 'rejected') throw video.reason;
    if (audio.status === 'rejected') throw audio.reason;
    throwIfAborted(controller.signal);
    reportProgress(true);
    tasks = [
      downloadTrack(selectedRequest.video, video.value, videoState, taskOptions, reportProgress),
      downloadTrack(selectedRequest.audio, audio.value, audioState, taskOptions, reportProgress),
    ];
    const [videoFile, audioFile] = await Promise.all(tasks);
    if (!videoFile || !audioFile) throw new Error('暂存轨道不完整');
    reportProgress(true);
    const readBytes = videoState.readBytes + audioState.readBytes;
    if (options.preserveForReuse) {
      const createdAt = now();
      const reuseTtlMs = options.reuseTtlMs ?? STAGED_MERGE_INPUT_TTL_MS;
      if (!Number.isFinite(reuseTtlMs) || reuseTtlMs <= 0) {
        throw new TypeError('缓存复用有效期必须是正数');
      }
      await writeStagedDescriptor(options.root, jobId, {
        version: STAGING_DESCRIPTOR_VERSION,
        requestFingerprint: await mergeStagingRequestFingerprint(selectedRequest),
        videoBytes: videoFile.size,
        audioBytes: audioFile.size,
        readBytes,
        createdAt,
        expiresAt: createdAt + reuseTtlMs,
      });
    }
    return {
      videoBlob: videoFile,
      audioBlob: audioFile,
      readBytes,
      cleanup: () => cleanupStagedMergeInputs(options.root, jobId),
    };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(tasks);
    await cleanupStagedMergeInputs(options.root, jobId);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
