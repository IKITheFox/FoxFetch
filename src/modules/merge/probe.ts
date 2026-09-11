import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  type Source,
  UrlSource,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { sniffBilibiliIsoBmffDynamicRange } from '../detector/bilibili-dynamic-range';
import { recommendContainer } from './container-policy';
import {
  createGuardedFetchInspector,
  detectIsoBmffDrm,
  ProtectedMediaDetectedError,
  signalsFromInternalCodecId,
} from './drm';
import { mergeError, MergeError, normalizeMergeError } from './errors';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';
import { createStrictRangeFetch } from './range-source';
import {
  assessDolbyVisionPassthroughSource,
  extractIsoBmffDynamicRangeEvidence,
  verifyIsoBmffDynamicRangePreservation,
} from './isobmff-dynamic-range';
import { unavailableNativeFfmpegHelper } from './native-ffmpeg-helper';
import {
  createDolbyVisionHevcCompatibilityView,
  createHevcSampleDescriptionView,
} from './dolby-vision-passthrough';
import { inspectIsoBmffTimeline } from './iso-bmff-timeline';
import { prepareTimelineReadView } from './timeline-read-view';
import { videoConfigurationDiagnostic } from './configuration-diagnostic';
import type {
  DrmSignal,
  MediaTrackProbe,
  MergeContainerPreference,
  MergeDynamicRangeConstraint,
  MergePlan,
  MergeSourceRequest,
  SeparateTrackMergeRequest,
  RemuxProgress,
} from './types';

const BLOB_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const BLOB_DRM_HEAD_BYTES = 16 * 1024 * 1024;
const BLOB_DRM_TAIL_BYTES = 4 * 1024 * 1024;
const UNVERIFIED_TIMELINE_OFFSET_SECONDS = 0.1;
const STRONG_IDENTITY_TIMELINE_OFFSET_SECONDS = 0.5;

interface PreparedBase<TTrack extends InputVideoTrack | InputAudioTrack> {
  input: Input;
  source: Source;
  track: TTrack;
  probe: MediaTrackProbe;
}

export type PreparedVideoTrack = PreparedBase<InputVideoTrack>;
export type PreparedAudioTrack = PreparedBase<InputAudioTrack>;

export interface PreparedMergePair {
  video: PreparedVideoTrack;
  audio: PreparedAudioTrack;
  plan: MergePlan;
  dispose(): void;
}

export interface MergeProbeOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: RemuxProgress) => void;
}

export interface CapturedBlobProbeOptions {
  onProgress?: (progress: RemuxProgress) => void;
  preferredContainer?: MergeContainerPreference;
  drmSignals?: DrmSignal[];
  /** Provider range metadata retained when URL inputs are staged into OPFS. */
  videoDynamicRange?: MergeDynamicRangeConstraint;
  videoStreamIdentity?: string;
  audioStreamIdentity?: string;
  /** Internal gate: only complete, source-ordered staged files may use DV passthrough. */
  allowDolbyVisionPassthrough?: boolean;
  signal?: AbortSignal;
}

function validateSourceUrl(source: MergeSourceRequest): URL {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch (cause) {
    throw mergeError('INVALID_URL', '视频和音频都必须是完整、有效的 URL。', {
      cause,
      canDownloadSeparately: false,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw mergeError(
      'UNSUPPORTED_PROTOCOL',
      `首版任务页仅支持 http/https 直链，不能处理 ${url.protocol} URL。`,
      { canDownloadSeparately: false },
    );
  }
  return url;
}

function retryDelay(previousAttempts: number, error: unknown): number | null {
  if (error instanceof ProtectedMediaDetectedError || previousAttempts >= 2) return null;
  if (
    error instanceof MergeError &&
    (error.detail.reason === 'RANGE_UNSUPPORTED' || error.detail.reason === 'RANGE_INVALID')
  )
    return null;
  return 0.5 * 2 ** previousAttempts;
}

function normalizeInternalCodecId(
  value: string | number | Uint8Array<ArrayBufferLike> | null,
): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function throwDrm(signals: DrmSignal[]): never {
  throw mergeError(
    'DRM_PROTECTED',
    '检测到加密或 DRM 信号；FoxFetch 不会请求密钥或尝试绕过保护。',
    {
      canDownloadSeparately: false,
      drmSignals: [...new Set(signals)],
    },
  );
}

function declaredDolbyVision(value?: string): boolean {
  return /(?:^|["',;\s])(?:dvh1|dvhe)(?:\.|["',;\s]|$)/iu.test(value ?? '');
}

function assertDynamicRangeRemuxPolicy(
  request: { video?: MergeSourceRequest },
  options: { allowVerifiedStagedDolbyVision?: boolean } = {},
): void {
  const constraint = request.video?.dynamicRange;
  const inferredDolbyVision = declaredDolbyVision(request.video?.declaredMimeType);
  const verifiedStagedDolbyVision =
    options.allowVerifiedStagedDolbyVision === true &&
    constraint?.range === 'Dolby Vision' &&
    constraint.remuxable === 'supported';
  if (
    ((inferredDolbyVision || constraint?.range === 'Dolby Vision') && !verifiedStagedDolbyVision) ||
    (constraint?.range === 'unknown' && constraint.remuxable === 'unsupported')
  ) {
    const range =
      inferredDolbyVision || constraint?.range === 'Dolby Vision' ? 'Dolby Vision' : 'HDR';
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      range === 'Dolby Vision'
        ? '浏览器媒体引擎不能证明 Dolby Vision dvcC/dvvC 与 RPU 完整保留；当前版本未提供 Native FFmpeg helper，请使用分别下载保存经逐字节复验的原始视频轨。'
        : '动态范围类型存在冲突，不能证明高级元数据完整保留；请分别保存原始轨道。',
      {
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range,
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
}

interface OpenSourceTrackOptions {
  onProgress?: (progress: RemuxProgress) => void;
  signal?: AbortSignal;
  strictSingleTrack?: boolean;
  sizeUnknown?: boolean;
  unreadableMessage: string;
  getDrmSignals(formatName: string): Promise<DrmSignal[]>;
  getLastAdvance?: () => number;
}

function throwIfAborted(signal?: AbortSignal): void {
  checkMergeAborted(signal);
}

async function openSourceTrack(
  source: Source,
  sourceLabel: string,
  expectedKind: 'video',
  options: OpenSourceTrackOptions,
): Promise<PreparedVideoTrack>;
async function openSourceTrack(
  source: Source,
  sourceLabel: string,
  expectedKind: 'audio',
  options: OpenSourceTrackOptions,
): Promise<PreparedAudioTrack>;
async function openSourceTrack(
  source: Source,
  sourceLabel: string,
  expectedKind: 'video' | 'audio',
  options: OpenSourceTrackOptions,
): Promise<PreparedVideoTrack | PreparedAudioTrack> {
  const input = new Input({ formats: ALL_FORMATS, source });
  // UrlSource owns requests: disposing Input is required in addition to Request.signal.
  const disposeOnAbort = () => input.dispose();
  options.signal?.addEventListener('abort', disposeOnAbort, { once: true });
  const step = <T>(operation: Promise<T>) =>
    withMergeDeadline(operation, {
      ...(options.signal ? { signal: options.signal } : {}),
      onStop: disposeOnAbort,
      ...(options.getLastAdvance ? { getLastAdvance: options.getLastAdvance } : {}),
    });

  try {
    throwIfAborted(options.signal);
    if (!(await step(input.canRead()))) {
      throw mergeError('SOURCE_UNREADABLE', options.unreadableMessage, {
        canDownloadSeparately: true,
      });
    }
    throwIfAborted(options.signal);

    options.onProgress?.({
      phase: 'probing',
      stage: 'media-metadata',
      ratio: null,
      message: '正在检查媒体索引、轨道与加密信号…',
    });
    const format = await step(input.getFormat());
    let track: InputVideoTrack | InputAudioTrack | null;
    if (options.strictSingleTrack) {
      const [allTracks, expectedTracks] = await step(
        Promise.all([
          input.getTracks(),
          expectedKind === 'video' ? input.getVideoTracks() : input.getAudioTracks(),
        ]),
      );
      if (expectedTracks.length > 1 || allTracks.length !== 1) {
        throw mergeError(
          'SOURCE_FORMAT_UNSUPPORTED',
          `${expectedKind === 'video' ? '视频' : '音频'}缓存必须恰好包含一条独立轨道，不会猜测或丢弃其他轨道。`,
          { canDownloadSeparately: true },
        );
      }
      track = expectedTracks[0] ?? null;
    } else {
      track =
        expectedKind === 'video'
          ? await step(input.getPrimaryVideoTrack())
          : await step(input.getPrimaryAudioTrack());
    }

    if (!track) {
      throw mergeError(
        expectedKind === 'video' ? 'VIDEO_TRACK_MISSING' : 'AUDIO_TRACK_MISSING',
        `${expectedKind === 'video' ? '视频' : '音频'}来源中没有找到所需轨道。`,
        { canDownloadSeparately: true },
      );
    }

    const internalCodecId = await step(track.getInternalCodecId());
    const detectedSignals = [
      ...signalsFromInternalCodecId(internalCodecId),
      ...(await step(Promise.resolve(options.getDrmSignals(format.name)))),
    ];
    if (detectedSignals.length > 0) throwDrm(detectedSignals);
    throwIfAborted(options.signal);

    const codec = await step(track.getCodec());
    if (!codec) {
      throw mergeError(
        'CODEC_UNKNOWN',
        `${expectedKind === 'video' ? '视频' : '音频'}轨编码无法识别，不能保证无损封装。`,
        { canDownloadSeparately: true },
      );
    }

    const live = await step(track.isLive());
    if (live) {
      throw mergeError('LIVE_STREAM_UNSUPPORTED', '首版仅合并点播媒体，不会无限录制直播。', {
        canDownloadSeparately: true,
      });
    }

    options.onProgress?.({
      phase: 'probing',
      stage: 'decoder-config',
      ratio: null,
      message: '正在读取编码配置、时长与音画起点…',
    });
    const [codecParameterString, durationSeconds, firstTimestampSeconds, sourceSize, mimeType] =
      await step(
        Promise.all([
          track.getCodecParameterString(),
          track.getDurationFromMetadata({ skipLiveWait: true }),
          track.getFirstTimestamp(),
          source.getSizeOrNull(),
          input.getMimeType(),
        ]),
      );

    const probe: MediaTrackProbe = {
      url: sourceLabel,
      kind: expectedKind,
      formatName: format.name,
      mimeType,
      codec,
      codecParameterString,
      internalCodecId: normalizeInternalCodecId(internalCodecId),
      durationSeconds,
      firstTimestampSeconds,
      sizeBytes: options.sizeUnknown ? null : sourceSize,
      live,
    };

    if (expectedKind === 'video') {
      return { input, source, track: track as InputVideoTrack, probe };
    }
    return { input, source, track: track as InputAudioTrack, probe };
  } catch (error) {
    input.dispose();
    if (error instanceof ProtectedMediaDetectedError) throwDrm(error.signals);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', disposeOnAbort);
  }
}

async function openTrack(
  sourceRequest: MergeSourceRequest,
  expectedKind: 'video',
  options: MergeProbeOptions,
): Promise<PreparedVideoTrack>;
async function openTrack(
  sourceRequest: MergeSourceRequest,
  expectedKind: 'audio',
  options: MergeProbeOptions,
): Promise<PreparedAudioTrack>;
async function openTrack(
  sourceRequest: MergeSourceRequest,
  expectedKind: 'video' | 'audio',
  options: MergeProbeOptions,
): Promise<PreparedVideoTrack | PreparedAudioTrack> {
  const locations = [sourceRequest, ...(sourceRequest.sources ?? [])].filter(
    (location, index, all) =>
      all.findIndex((candidate) => candidate.url === location.url) === index,
  );
  let lastError: unknown;
  let allAttemptsWere403 = locations.length > 0;

  for (const location of locations.slice(0, 3)) {
    throwIfAborted(options.signal);
    const candidateRequest: MergeSourceRequest = {
      ...sourceRequest,
      url: location.url,
      ...((location.credentials ?? sourceRequest.credentials)
        ? { credentials: location.credentials ?? sourceRequest.credentials }
        : {}),
      ...((location.declaredMimeType ?? sourceRequest.declaredMimeType)
        ? { declaredMimeType: location.declaredMimeType ?? sourceRequest.declaredMimeType }
        : {}),
      sources: [],
    };
    const url = validateSourceUrl(candidateRequest);
    let lastAdvance = Date.now();
    let readBytes = 0;
    const inspector = createGuardedFetchInspector({
      ...options,
      fetchFn: createStrictRangeFetch(
        options.fetchFn ?? globalThis.fetch.bind(globalThis),
        (network) => {
          options.onProgress?.({
            phase: 'probing',
            stage: 'source-headers',
            ratio: null,
            readBytes,
            message: '正在读取媒体分段…',
            network,
          });
        },
      ),
      onReadBytes: (bytes) => {
        lastAdvance = Date.now();
        readBytes += bytes;
        options.onProgress?.({
          phase: 'probing',
          stage: 'source-body',
          ratio: null,
          readBytes,
          message:
            expectedKind === 'video'
              ? '正在读取视频索引与编码数据…'
              : '正在读取音频索引与编码数据…',
        });
      },
    });
    const source = new UrlSource(url, {
      requestInit: { credentials: candidateRequest.credentials ?? 'include' },
      fetchFn: inspector.fetch,
      getRetryDelay: retryDelay,
      maxCacheSize: 32 * 1024 * 1024,
      parallelism: 2,
    });
    const isDash = url.pathname.toLowerCase().endsWith('.mpd');
    const sourceOptions: OpenSourceTrackOptions = {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      sizeUnknown: false,
      unreadableMessage: isDash
        ? 'Mediabunny 1.55.4 不能直接读取 DASH MPD；请先由 DASH Planner 解析为具体音视频轨 URL。'
        : `无法识别${expectedKind === 'video' ? '视频' : '音频'}直链的媒体格式。`,
      getDrmSignals: () => inspector.getSignals(),
      getLastAdvance: () => lastAdvance,
    };
    try {
      return expectedKind === 'video'
        ? await openSourceTrack(source, url.href, 'video', sourceOptions)
        : await openSourceTrack(source, url.href, 'audio', sourceOptions);
    } catch (error) {
      throwIfAborted(options.signal);
      if (
        error instanceof ProtectedMediaDetectedError ||
        (error instanceof MergeError &&
          (error.detail.code === 'DRM_PROTECTED' || error.detail.reason === 'RANGE_UNSUPPORTED')) ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      const httpStatus = inspector.getFailureHttpStatus();
      allAttemptsWere403 &&= httpStatus === 403;
      lastError =
        isDash && error instanceof MergeError && error.detail.code === 'SOURCE_UNREADABLE'
          ? mergeError('SOURCE_FORMAT_UNSUPPORTED', sourceOptions.unreadableMessage, {
              cause: error,
              canDownloadSeparately: true,
            })
          : error;
    }
  }

  if (allAttemptsWere403) {
    const normalized = lastError instanceof MergeError ? lastError : normalizeMergeError(lastError);
    throw mergeError(normalized.detail.code, normalized.detail.message, {
      cause: lastError,
      retryable: true,
      canDownloadSeparately: normalized.detail.canDownloadSeparately,
      ...(normalized.detail.drmSignals ? { drmSignals: normalized.detail.drmSignals } : {}),
      httpStatus: 403,
    });
  }
  throw lastError;
}

function validateCapturedBlob(blob: Blob, expectedKind: 'video' | 'audio'): void {
  if (blob.size <= 0) {
    throw mergeError(
      'SOURCE_UNREADABLE',
      `${expectedKind === 'video' ? '视频' : '音频'}缓存为空，无法进行合并。`,
      { canDownloadSeparately: false },
    );
  }
  const mime = blob.type.split(';', 1)[0]?.trim().toLowerCase();
  if (
    mime &&
    mime !== 'application/octet-stream' &&
    mime !== 'application/mp4' &&
    !mime.startsWith(`${expectedKind}/`)
  ) {
    throw mergeError(
      'SOURCE_FORMAT_UNSUPPORTED',
      `${expectedKind === 'video' ? '视频' : '音频'}缓存声明为 ${mime}，与所需轨道类型不匹配。`,
      { canDownloadSeparately: true },
    );
  }
}

async function detectCapturedBlobDrm(blob: Blob, formatName: string): Promise<DrmSignal[]> {
  if (!/mp4|quicktime/iu.test(formatName)) return [];
  const headLength = Math.min(blob.size, BLOB_DRM_HEAD_BYTES);
  const ranges = [{ bytes: await blob.slice(0, headLength).arrayBuffer(), fileStart: 0 }];
  if (blob.size > headLength) {
    const tailStart = Math.max(headLength, blob.size - BLOB_DRM_TAIL_BYTES);
    if (tailStart < blob.size) {
      ranges.push({
        bytes: await blob.slice(tailStart).arrayBuffer(),
        fileStart: tailStart,
      });
    }
  }
  return detectIsoBmffDrm(ranges);
}

async function openCapturedBlobTrack(
  blob: Blob,
  expectedKind: 'video',
  options: CapturedBlobProbeOptions,
): Promise<PreparedVideoTrack>;
async function openCapturedBlobTrack(
  blob: Blob,
  expectedKind: 'audio',
  options: CapturedBlobProbeOptions,
): Promise<PreparedAudioTrack>;
async function openCapturedBlobTrack(
  blob: Blob,
  expectedKind: 'video' | 'audio',
  options: CapturedBlobProbeOptions,
): Promise<PreparedVideoTrack | PreparedAudioTrack> {
  throwIfAborted(options.signal);
  validateCapturedBlob(blob, expectedKind);
  const timelineBlob = await prepareTimelineReadView(blob, expectedKind, options);
  const source = new BlobSource(timelineBlob, { maxCacheSize: BLOB_SOURCE_CACHE_BYTES });
  const sourceLabel = `blob:foxfetch-captured-${expectedKind}`;
  const sourceOptions: OpenSourceTrackOptions = {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    strictSingleTrack: true,
    unreadableMessage: `无法识别${expectedKind === 'video' ? '视频' : '音频'}缓存；可能缺少 MSE 初始化段或缓存不完整。`,
    getDrmSignals: (formatName) => detectCapturedBlobDrm(blob, formatName),
  };
  if (expectedKind === 'audio') {
    return openSourceTrack(source, sourceLabel, 'audio', sourceOptions);
  }

  const prepared = await openSourceTrack(source, sourceLabel, 'video', sourceOptions);
  try {
    throwIfAborted(options.signal);
    const firstPacket = await new EncodedPacketSink(prepared.track).getFirstPacket({
      verifyKeyPackets: true,
      skipLiveWait: true,
    });
    throwIfAborted(options.signal);
    if (!firstPacket) {
      throw mergeError('VIDEO_TRACK_MISSING', '视频缓存中没有可读取的媒体 packet。', {
        canDownloadSeparately: true,
      });
    }
    if (firstPacket.type !== 'key') {
      throw mergeError(
        'TIMELINE_MISMATCH',
        '视频缓存从非关键帧开始；无损合并不会输出无法独立解码的开头，请保留分轨下载或从更早的关键帧重新捕获。',
        { canDownloadSeparately: true },
      );
    }
    return prepared;
  } catch (error) {
    prepared.input.dispose();
    throw error;
  }
}

/**
 * Opens one locally staged video representation with the same strict
 * single-track, DRM and key-packet checks used by the merge pipeline.
 * Separate export intentionally exposes this operation without constructing
 * an A/V pair: a broken or incompatible sibling track must not prevent the
 * other track from being exported safely.
 */
export function prepareCapturedVideoTrack(
  blob: Blob,
  options: CapturedBlobProbeOptions = {},
): Promise<PreparedVideoTrack> {
  if (options.drmSignals && options.drmSignals.length > 0) throwDrm(options.drmSignals);
  return openCapturedBlobTrack(blob, 'video', options);
}

/** See {@link prepareCapturedVideoTrack}. */
export function prepareCapturedAudioTrack(
  blob: Blob,
  options: CapturedBlobProbeOptions = {},
): Promise<PreparedAudioTrack> {
  if (options.drmSignals && options.drmSignals.length > 0) throwDrm(options.drmSignals);
  return openCapturedBlobTrack(blob, 'audio', options);
}

function normalizedStreamIdentity(source: MergeSourceRequest): string | null {
  const identity = source.streamIdentity?.trim();
  return identity ? identity : null;
}

function matchingStreamIdentity(
  sources: Pick<SeparateTrackMergeRequest, 'video' | 'audio'>,
): string | null {
  const videoIdentity = normalizedStreamIdentity(sources.video);
  const audioIdentity = normalizedStreamIdentity(sources.audio);
  if (videoIdentity && audioIdentity && videoIdentity !== audioIdentity) {
    throw mergeError(
      'TIMELINE_MISMATCH',
      '音视频轨属于不同的媒体身份；为避免把不同视频配在一起，已停止无损合并。',
      { canDownloadSeparately: true },
    );
  }
  return videoIdentity && videoIdentity === audioIdentity ? videoIdentity : null;
}

function assertTimelineCompatible(
  video: MediaTrackProbe,
  audio: MediaTrackProbe,
  sources?: Pick<SeparateTrackMergeRequest, 'video' | 'audio'>,
): string[] {
  const warnings: string[] = [];
  sharedTimelineOriginSeconds(video, audio);
  const firstTimestampDifference = Math.abs(
    video.firstTimestampSeconds - audio.firstTimestampSeconds,
  );
  const hasStrongSharedIdentity = sources ? matchingStreamIdentity(sources) !== null : false;
  const allowedOffset = hasStrongSharedIdentity
    ? STRONG_IDENTITY_TIMELINE_OFFSET_SECONDS
    : UNVERIFIED_TIMELINE_OFFSET_SECONDS;
  if (firstTimestampDifference > allowedOffset) {
    throw mergeError(
      'TIMELINE_MISMATCH',
      `音视频起始时间相差 ${firstTimestampDifference.toFixed(3)} 秒，超过${
        hasStrongSharedIdentity ? '同一媒体身份的 500 ms' : '未验证配对的 100 ms'
      }安全阈值。`,
      { canDownloadSeparately: true },
    );
  }
  if (hasStrongSharedIdentity && firstTimestampDifference > UNVERIFIED_TIMELINE_OFFSET_SECONDS) {
    warnings.push(
      `检测到 ${Math.round(firstTimestampDifference * 1_000)} ms 正常编码延迟；合并将保留原始音画同步偏移。`,
    );
  }

  if (video.durationSeconds !== null && audio.durationSeconds !== null) {
    const durationDifference = Math.abs(video.durationSeconds - audio.durationSeconds);
    const allowedDifference = Math.max(
      2,
      Math.min(10, Math.max(video.durationSeconds, audio.durationSeconds) * 0.01),
    );
    if (durationDifference > allowedDifference) {
      throw mergeError(
        'TIMELINE_MISMATCH',
        `音视频时长相差 ${durationDifference.toFixed(2)} 秒，疑似配对错误。`,
        { canDownloadSeparately: true },
      );
    }
  } else {
    warnings.push('来源没有可靠的时长元数据；完成后必须重新验证输出。');
  }

  return warnings;
}

/**
 * Returns the one origin that every input conversion must use. Letting each
 * Conversion choose its own origin silently removes a real A/V start offset.
 *
 * Packet-copy deliberately rejects negative preroll. Mediabunny's encoded
 * packet path subtracts trim.start without decoding; accepting a negative
 * first packet and clamping the origin to zero would either assert or require
 * decoding to trim it safely.
 */
export function sharedTimelineOriginSeconds(
  video: Pick<MediaTrackProbe, 'firstTimestampSeconds'>,
  audio: Pick<MediaTrackProbe, 'firstTimestampSeconds'>,
): number {
  const firstTimestamps = [video.firstTimestampSeconds, audio.firstTimestampSeconds];
  if (firstTimestamps.some((timestamp) => !Number.isFinite(timestamp))) {
    throw mergeError('TIMELINE_MISMATCH', '音视频轨缺少有效的起始时间戳。', {
      canDownloadSeparately: true,
    });
  }
  if (firstTimestamps.some((timestamp) => timestamp < 0)) {
    throw mergeError(
      'TIMELINE_MISMATCH',
      '音视频轨包含负时间戳前滚；无损复制无法安全裁切，请分别下载或使用明确的转码流程。',
      { canDownloadSeparately: true },
    );
  }
  return Math.max(0, Math.min(...firstTimestamps));
}

/** Mediabunny duration metadata is an absolute media end timestamp. */
export function estimatedDurationAfterTimelineOrigin(
  video: Pick<MediaTrackProbe, 'durationSeconds'>,
  audio: Pick<MediaTrackProbe, 'durationSeconds'>,
  timelineOriginSeconds: number,
): number | null {
  const endTimestamps = [video.durationSeconds, audio.durationSeconds].filter(
    (duration): duration is number => duration !== null && Number.isFinite(duration),
  );
  return endTimestamps.length > 0
    ? Math.max(0, Math.max(...endTimestamps) - timelineOriginSeconds)
    : null;
}

function buildPlan(
  request: {
    preferredContainer?: MergeContainerPreference;
    video?: MergeSourceRequest;
    audio?: MergeSourceRequest;
  },
  video: PreparedVideoTrack,
  audio: PreparedAudioTrack,
): MergePlan {
  const verifiedStagedDolbyVision =
    request.video?.dynamicRange?.range === 'Dolby Vision' &&
    request.video.dynamicRange.remuxable === 'supported';
  assertDynamicRangeRemuxPolicy(request, { allowVerifiedStagedDolbyVision: true });
  if (
    !verifiedStagedDolbyVision &&
    (declaredDolbyVision(video.probe.codecParameterString ?? undefined) ||
      (typeof video.probe.internalCodecId === 'string' &&
        /^(?:dvh1|dvhe)$/iu.test(video.probe.internalCodecId)))
  ) {
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      '检测到 Dolby Vision 视频轨，但当前媒体引擎不能验证输出中的 Dolby Vision 配置；请分别保存原始轨道。',
      {
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range: 'Dolby Vision',
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
  const videoCodec = video.probe.codec as VideoCodec;
  const audioCodec = audio.probe.codec as AudioCodec;
  const recommendation = recommendContainer(
    videoCodec,
    audioCodec,
    request.preferredContainer ?? 'auto',
  );
  if (
    request.video?.dynamicRange?.range === 'HDR' &&
    (videoCodec !== 'hevc' || audioCodec !== 'aac' || recommendation.container !== 'mp4')
  ) {
    throw mergeError(
      'CONTAINER_INCOMPATIBLE',
      'HDR 浏览器保真合并仅支持已验证的 Main10 HEVC 视频、AAC 音频与 MP4 容器。',
      { canDownloadSeparately: true },
    );
  }
  if (
    verifiedStagedDolbyVision &&
    (videoCodec !== 'hevc' || audioCodec !== 'aac' || recommendation.container !== 'mp4')
  ) {
    throw mergeError(
      'CONTAINER_INCOMPATIBLE',
      'Dolby Vision 浏览器保真合并仅支持带完整 DV 配置的 HEVC 视频、AAC 音频与 MP4 容器。',
      { canDownloadSeparately: true },
    );
  }
  if (
    !recommendation.supported ||
    !recommendation.container ||
    !recommendation.extension ||
    !recommendation.mimeType
  ) {
    throw mergeError('CONTAINER_INCOMPATIBLE', recommendation.reason, {
      canDownloadSeparately: true,
    });
  }

  const timelineWarnings = assertTimelineCompatible(
    video.probe,
    audio.probe,
    request.video && request.audio ? { video: request.video, audio: request.audio } : undefined,
  );
  const timelineOriginSeconds = sharedTimelineOriginSeconds(video.probe, audio.probe);
  const sizes = [video.probe.sizeBytes, audio.probe.sizeBytes];
  const estimatedInputBytes = sizes.every((size): size is number => size !== null)
    ? sizes.reduce((sum, size) => sum + size, 0)
    : null;

  return {
    mode: 'packet-copy',
    container: recommendation.container,
    extension: recommendation.extension,
    mimeType: recommendation.mimeType,
    video: video.probe,
    audio: audio.probe,
    estimatedInputBytes,
    estimatedDurationSeconds: estimatedDurationAfterTimelineOrigin(
      video.probe,
      audio.probe,
      timelineOriginSeconds,
    ),
    warnings: [...recommendation.warnings, ...timelineWarnings],
    ...(request.video?.dynamicRange?.range === 'HDR' || verifiedStagedDolbyVision
      ? {
          dynamicRangeVerification: {
            range: verifiedStagedDolbyVision ? ('Dolby Vision' as const) : ('HDR' as const),
            strategy: 'browser-verified-packet-copy' as const,
            verifyAfterTemporaryWrite: true as const,
            originalVideoTrackFallback: true as const,
            nativeHelper: unavailableNativeFfmpegHelper(),
          },
        }
      : {}),
  };
}

async function assemblePreparedPair(
  videoPromise: Promise<PreparedVideoTrack>,
  audioPromise: Promise<PreparedAudioTrack>,
  request: {
    preferredContainer?: MergeContainerPreference;
    video?: MergeSourceRequest;
    audio?: MergeSourceRequest;
  },
): Promise<PreparedMergePair> {
  const results = await Promise.allSettled([videoPromise, audioPromise]);
  const videoResult = results[0];
  const audioResult = results[1];

  if (videoResult.status === 'rejected' || audioResult.status === 'rejected') {
    if (videoResult.status === 'fulfilled') videoResult.value.input.dispose();
    if (audioResult.status === 'fulfilled') audioResult.value.input.dispose();
    const reasons = [
      ...(videoResult.status === 'rejected' ? [videoResult.reason] : []),
      ...(audioResult.status === 'rejected' ? [audioResult.reason] : []),
    ];
    const reason =
      reasons.find(
        (candidate) => candidate instanceof MergeError && candidate.detail.code === 'DRM_PROTECTED',
      ) ??
      reasons.find(
        (candidate) => candidate instanceof MergeError && candidate.detail.httpStatus === 403,
      ) ??
      reasons[0];
    throw reason;
  }

  try {
    const plan = buildPlan(request, videoResult.value, audioResult.value);
    return {
      video: videoResult.value,
      audio: audioResult.value,
      plan,
      dispose() {
        videoResult.value.input.dispose();
        audioResult.value.input.dispose();
      },
    };
  } catch (error) {
    videoResult.value.input.dispose();
    audioResult.value.input.dispose();
    throw error;
  }
}

async function prepareConcurrentPair(
  options: MergeProbeOptions,
  video: (signal: AbortSignal) => Promise<PreparedVideoTrack>,
  audio: (signal: AbortSignal) => Promise<PreparedAudioTrack>,
  request: Parameters<typeof assemblePreparedPair>[2],
): Promise<PreparedMergePair> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const stopPeer = (error: unknown): never => {
    controller.abort(error);
    throw error;
  };
  try {
    return await assemblePreparedPair(
      video(controller.signal).catch(stopPeer),
      audio(controller.signal).catch(stopPeer),
      request,
    );
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function prepareMergePair(
  request: SeparateTrackMergeRequest,
  options: MergeProbeOptions = {},
): Promise<PreparedMergePair> {
  if (request.drmSignals && request.drmSignals.length > 0) throwDrm(request.drmSignals);
  assertDynamicRangeRemuxPolicy(request);
  matchingStreamIdentity(request);
  return prepareConcurrentPair(
    options,
    (signal) => openTrack(request.video, 'video', { ...options, signal }),
    (signal) => openTrack(request.audio, 'audio', { ...options, signal }),
    request,
  );
}

export async function prepareCapturedBlobPair(
  videoBlob: Blob,
  audioBlob: Blob,
  options: CapturedBlobProbeOptions = {},
): Promise<PreparedMergePair> {
  if (options.drmSignals && options.drmSignals.length > 0) throwDrm(options.drmSignals);
  await Promise.all([
    inspectIsoBmffTimeline(videoBlob, options.signal, 'video'),
    inspectIsoBmffTimeline(audioBlob, options.signal, 'audio'),
  ]);
  if (options.videoDynamicRange && options.videoDynamicRange.range !== 'Dolby Vision') {
    assertDynamicRangeRemuxPolicy({
      video: {
        url: 'blob:foxfetch-captured-video',
        dynamicRange: options.videoDynamicRange,
      },
    });
  }
  const initialization = await withMergeDeadline(extractIsoBmffDynamicRangeEvidence(videoBlob), {
    ...(options.signal ? { signal: options.signal } : {}),
    stage: 'decoder-config',
  });
  const configuration = { source: videoConfigurationDiagnostic(initialization) };
  const conservativeInitialization = sniffBilibiliIsoBmffDynamicRange(
    await videoBlob.slice(0, Math.min(videoBlob.size, 2 * 1024 * 1024)).arrayBuffer(),
  );
  const requestedDolbyVision = options.videoDynamicRange?.range === 'Dolby Vision';
  const detectedDolbyVision =
    initialization.classification === 'Dolby Vision' ||
    (!initialization.sampleEntry && conservativeInitialization?.dynamicRange === 'Dolby Vision');
  if (
    detectedDolbyVision &&
    options.videoDynamicRange != null &&
    options.videoDynamicRange.range !== 'Dolby Vision' &&
    options.videoDynamicRange.range !== 'unknown'
  ) {
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      '页面声明的动态范围与实际 Dolby Vision 初始化数据不一致。',
      {
        reason: 'DYNAMIC_RANGE_CONFLICT',
        configuration,
        stage: 'decoder-config',
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range: 'Dolby Vision',
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
  if (requestedDolbyVision && !detectedDolbyVision) {
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      '页面声明为 Dolby Vision，但完整来源中没有可验证的 Dolby Vision 样本项。',
      {
        reason: 'DV_CONFIG_MISSING',
        configuration,
        stage: 'decoder-config',
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range: 'Dolby Vision',
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
  if (detectedDolbyVision) {
    if (options.allowDolbyVisionPassthrough !== true) {
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        'Dolby Vision 只支持完整、按来源顺序暂存的文件；MSE 缓存轨请分别保存。',
        {
          reason: 'DV_SOURCE_INCOMPLETE',
          configuration,
          stage: 'decoder-config',
          canDownloadSeparately: true,
          dynamicRangeCapability: {
            range: 'Dolby Vision',
            browserVerifiedMerge: false,
            originalVideoTrackFallback: true,
            nativeHelper: unavailableNativeFfmpegHelper(),
          },
        },
      );
    }
    const support = assessDolbyVisionPassthroughSource(initialization);
    if (!support.supported) {
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        `Dolby Vision 来源不在浏览器保真合并范围内：${support.reason}`,
        {
          reason: support.reasonCode,
          configuration,
          stage: 'decoder-config',
          canDownloadSeparately: true,
          dynamicRangeCapability: {
            range: 'Dolby Vision',
            browserVerifiedMerge: false,
            originalVideoTrackFallback: true,
            nativeHelper: unavailableNativeFfmpegHelper(),
          },
        },
      );
    }
  }
  const requestedHdr = options.videoDynamicRange?.range === 'HDR';
  const detectedHdr = initialization.classification === 'HDR';
  if (requestedHdr || detectedHdr) {
    const sourceProof = verifyIsoBmffDynamicRangePreservation(
      'HDR',
      initialization,
      initialization,
      {
        equivalent: true,
        sourcePacketCount: 1,
        outputPacketCount: 1,
        sourceBytes: 1,
        outputBytes: 1,
      },
    );
    if (!sourceProof.preserved) {
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        `HDR 来源缺少可验证的 hvcC、10-bit 与 BT.2020 PQ/HLG 证据：${sourceProof.reason}`,
        {
          reason: 'HDR_CONFIG_INCOMPLETE',
          configuration,
          stage: 'decoder-config',
          canDownloadSeparately: true,
          dynamicRangeCapability: {
            range: 'HDR',
            browserVerifiedMerge: false,
            originalVideoTrackFallback: true,
            nativeHelper: unavailableNativeFfmpegHelper(),
          },
        },
      );
    }
  }
  const sourceRequest = {
    video: {
      url: 'blob:foxfetch-captured-video',
      ...(options.videoStreamIdentity ? { streamIdentity: options.videoStreamIdentity } : {}),
      ...(detectedDolbyVision
        ? {
            dynamicRange: {
              provider: 'bilibili' as const,
              range: 'Dolby Vision' as const,
              remuxable: 'supported' as const,
            },
          }
        : requestedHdr || detectedHdr
          ? {
              dynamicRange: {
                provider: 'bilibili' as const,
                range: 'HDR' as const,
                remuxable: 'unknown' as const,
              },
            }
          : {}),
    },
    audio: {
      url: 'blob:foxfetch-captured-audio',
      ...(options.audioStreamIdentity ? { streamIdentity: options.audioStreamIdentity } : {}),
    },
  };
  matchingStreamIdentity(sourceRequest);
  let engineVideoBlob = videoBlob;
  if (detectedDolbyVision) {
    try {
      engineVideoBlob = await createDolbyVisionHevcCompatibilityView(videoBlob);
    } catch (error) {
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        'Dolby Vision 视频轨结构不唯一或无法创建安全的 HEVC 兼容读取视图。',
        {
          reason: 'DV_COMPATIBILITY_VIEW_FAILED',
          configuration,
          stage: 'decoder-config',
          cause: error,
          canDownloadSeparately: true,
          dynamicRangeCapability: {
            range: 'Dolby Vision',
            browserVerifiedMerge: false,
            originalVideoTrackFallback: true,
            nativeHelper: unavailableNativeFfmpegHelper(),
          },
        },
      );
    }
  }
  if (!detectedDolbyVision && (requestedHdr || detectedHdr)) {
    try {
      engineVideoBlob = await createHevcSampleDescriptionView(videoBlob);
    } catch (error) {
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        'HDR 视频轨无法取得唯一、可验证的 HEVC 样本描述。',
        {
          reason: 'HDR_CONFIG_INCOMPLETE',
          stage: 'decoder-config',
          cause: error,
          configuration,
          canDownloadSeparately: true,
        },
      );
    }
  }
  return prepareConcurrentPair(
    options,
    (signal) => openCapturedBlobTrack(engineVideoBlob, 'video', { ...options, signal }),
    (signal) => openCapturedBlobTrack(audioBlob, 'audio', { ...options, signal }),
    { ...options, ...sourceRequest },
  );
}

export async function preflightSeparateTracks(
  request: SeparateTrackMergeRequest,
  options: MergeProbeOptions = {},
) {
  try {
    const prepared = await prepareMergePair(request, options);
    const plan = prepared.plan;
    prepared.dispose();
    return {
      status: 'supported',
      canMerge: true,
      canDownloadSeparately: true,
      plan,
    } as const;
  } catch (error) {
    const normalized = error instanceof MergeError ? error : normalizeMergeError(error);
    return {
      status: normalized.detail.code === 'DRM_PROTECTED' ? 'blocked' : 'unsupported',
      canMerge: false,
      canDownloadSeparately: normalized.detail.canDownloadSeparately,
      failure: normalized.detail,
    } as const;
  }
}

export async function preflightCapturedBlobs(
  videoBlob: Blob,
  audioBlob: Blob,
  options: CapturedBlobProbeOptions = {},
) {
  try {
    const prepared = await prepareCapturedBlobPair(videoBlob, audioBlob, {
      ...options,
      allowDolbyVisionPassthrough: true,
    });
    const plan = prepared.plan;
    prepared.dispose();
    return {
      status: 'supported',
      canMerge: true,
      canDownloadSeparately: true,
      plan,
    } as const;
  } catch (error) {
    const normalized = error instanceof MergeError ? error : normalizeMergeError(error);
    return {
      status: normalized.detail.code === 'DRM_PROTECTED' ? 'blocked' : 'unsupported',
      canMerge: false,
      canDownloadSeparately: normalized.detail.canDownloadSeparately,
      failure: normalized.detail,
    } as const;
  }
}
