import { APP_NAME, APP_NAME_EN } from '../../shared/constants';
import { cacheFailureMessage } from './cache-failure-message';
import { normalizeMediaTitle } from '../../shared/media-title';
import type { ThemeMode } from '../../shared/types';
import { sanitizeFilename } from '../../shared/utils';
import {
  MergeError,
  remuxCapturedBlobsToFile,
  type FileSystemFileHandleLike,
  type MergeContainer,
  type RemuxProgress,
} from '../merge';
import {
  buildDownloadDirectory,
  displayDownloadDirectory,
  downloadFilePickerId,
} from '../downloads/download-path';
import {
  createMseCacheChunkStore,
  MemoryMseCacheChunkStore,
  type MseCacheAppendResult,
  type MseCacheChunkStore,
  type MseCacheMergeOutput,
  type MseCacheStandardTrackOutput,
  MseCacheStorageError,
} from './mse-cache-store';
import type { MseTimelineUnsafeReason } from './mse-capture-main';
import { normalizeCapturedTrackPair, type CapturedFragmentPart } from './mse-fragment-normalizer';

/** v0.4 uses this one host for playback and cache. The capture runtime is headless. */
export const MSE_CACHE_CAPTURE_HOST_ID = 'foxfetch-floating-controller';
const MSE_CACHE_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Bounds transient ArrayBuffers waiting for extension-origin disk ACKs. */
const MSE_CACHE_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MSE_CACHE_MAX_TRACKS = 8;
const MSE_CACHE_DRM_INSPECTION_BYTES = 8 * 1024 * 1024;
/** Stop only after no new media data has arrived for this long. */
const MSE_CACHE_IDLE_TIMEOUT_MS = 5 * 60_000;
const MSE_CACHE_START_ACK_TIMEOUT_MS = 2_500;
const MSE_CACHE_TARGET_BIND_TIMEOUT_MS = 1_500;
const MSE_CAPTURE_CHANNEL = 'foxfetch:mse-cache:v1';
export const MSE_CACHE_PROTOCOL_VERSION = 3;
export const MSE_CACHE_HOOK_BUILD_ID = 'foxfetch-mse-hook-v3';

export type MseCacheCaptureStatus =
  | 'idle'
  | 'starting'
  | 'capturing'
  | 'paused'
  | 'ready'
  | 'downloading'
  | 'reload_required'
  | 'blocked_drm'
  | 'error';

export interface MseCacheGroupSnapshot {
  id: string;
  bytes: number;
  trackCount: number;
  sourceEnded: boolean;
  startSeconds?: number;
  endSeconds?: number;
  durationSeconds?: number;
  /** Continuous common coverage beginning at time zero. */
  cachedSeconds: number;
  complete: boolean;
  /** MAIN-world timeline mutations that make automatic A/V pairing unsafe. */
  unsafeTimelineReasons?: MseTimelineUnsafeReason[];
}

export interface MseCacheCaptureSnapshot {
  status: MseCacheCaptureStatus;
  capturedBytes: number;
  /** Bytes received from MAIN but not yet acknowledged by extension-origin storage. */
  pendingBytes?: number;
  /** Optional compatibility/safety ceiling. Production capture is disk-backed and uncapped. */
  capacityBytes?: number;
  /** Best current media source used by the time progress meter. */
  progressGroupId?: string;
  /** Continuous audio/video coverage from the beginning of the media. */
  cachedSeconds?: number;
  /** Finite duration reported by the selected player or captured MediaSource. */
  totalSeconds?: number;
  /** Null when total duration is unknown. */
  progressRatio: number | null;
  storageKind: MseCacheChunkStore['kind'];
  trackCount: number;
  sourceCount: number;
  autoDownload: boolean;
  clearAfterDownload: boolean;
  minimized: boolean;
  filename: string;
  downloading: boolean;
  /** A same-MediaSource video/audio pair is available for safe remuxing. */
  canMerge: boolean;
  /** Why automatic pairing is unsafe; separate track downloads remain available. */
  mergeBlockReason?: string;
  /** True only when the best downloadable media group is demonstrably complete. */
  isComplete: boolean;
  /** Set explicitly after the selected media has been reset close to time zero. */
  startedAtBeginning: boolean;
  completeGroupIds: string[];
  groups: MseCacheGroupSnapshot[];
  tracks: MseCacheTrackSnapshot[];
  /** Route identity acknowledged by the MAIN-world hook. */
  routeKey?: string;
  /** Monotonic MAIN-world route generation acknowledged for this session. */
  hookGeneration?: number;
  /** MediaSource group bound from the selected player's blob URL. */
  boundGroupId?: string;
  /** True while the selected blob URL has not yet been associated with a MediaSource. */
  waitingForTarget?: boolean;
  message: string;
  error?: string;
}

export interface MseCacheTrackSnapshot {
  id: string;
  groupId: string;
  mime: string;
  bytes: number;
  /** Whether a container initialization/header segment has been persisted. */
  initPresent?: boolean;
  unsafeTimelineReasons?: MseTimelineUnsafeReason[];
  complete: boolean;
}

export interface StartMseCacheCaptureOptions {
  sessionId: string;
  title: string;
  reason?: string;
  hookSupported?: boolean;
  pageUrl?: string;
  targetSourceUrl?: string;
  mediaIdentity?: MseCacheMediaIdentity;
}

export interface MseCacheMediaIdentity {
  pageUrl?: string;
  sourceUrl?: string;
  elementId?: string;
  frameId?: number;
  duration?: number;
  width?: number;
  height?: number;
  routeKey?: string;
  mediaEpoch?: number;
}

export type MseCacheUiRequest = 'cache' | 'launcher' | 'hidden';
export type MseCacheSnapshotListener = (snapshot: MseCacheCaptureSnapshot) => void;
export type MseCacheUiRequestHandler = (mode: MseCacheUiRequest) => void;

export interface MseCacheCaptureRuntimeOptions {
  /** Retained for source compatibility; the unified dock owns visual theming. */
  themeMode?: ThemeMode;
  capacityBytes?: number;
  chunkStore?: MseCacheChunkStore;
  captureTimeoutMs?: number;
  startAckTimeoutMs?: number;
  targetBindTimeoutMs?: number;
  /** Follow the global download.saveAs policy for merged cache output. */
  downloadSaveAs?: boolean;
  saveBlob?: (blob: Blob, filename: string) => void | Promise<void>;
  createStandardTrackOutput?: NonNullable<MseCacheChunkStore['createStandardTrackOutput']>;
  pickMergeFile?: (options: MseCacheMergeFileOptions) => Promise<FileSystemFileHandleLike>;
  remuxCapturedBlobs?: typeof remuxCapturedBlobsToFile;
  normalizeCapturedTracks?: typeof normalizeCapturedTrackPair;
  onSnapshot?: MseCacheSnapshotListener;
  onUiRequest?: MseCacheUiRequestHandler;
  onRequestStart?: () => void | Promise<void>;
  onRequestResetAndReload?: () => void | Promise<void>;
  shouldAutoDownload?: () => boolean;
  /** Used only when the extension context itself has already been invalidated. */
  reloadPage?: () => void;
}

async function copyVerifiedBlobToHandle(
  blob: Blob,
  handle: FileSystemFileHandleLike,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    // FileSystemWritableFileStream accepts Blob directly. The merge-facing
    // abstraction narrows write() to StreamTarget chunks, so keep this final,
    // already-verified copy behind a local structural cast.
    await (writable as unknown as { write(data: Blob): Promise<void> }).write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export interface MseCacheMergeFileOptions {
  suggestedName: string;
  description: string;
  mimeType: 'video/mp4' | 'video/webm' | 'video/x-matroska';
  extension: '.mp4' | '.webm' | '.mkv';
}

interface CapturedTrack {
  id: string;
  groupId: string;
  mime: string;
  bytes: number;
  pendingBytes: number;
  initPresent: boolean;
  firstSequence: number;
  lastSequence: number;
  bufferedStart?: number;
  bufferedEnd?: number;
  duration?: number;
  bufferedRanges: Array<{ start: number; end: number }>;
  unsafeTimelineReasons: Set<MseTimelineUnsafeReason>;
}

interface CapturedGroupState {
  sourceEnded: boolean;
  unsafeTimelineReasons: Set<MseTimelineUnsafeReason>;
}

interface PendingChunkMetadata {
  sequence: number;
  initPresent: boolean;
  bufferedRanges: unknown;
  bufferedStart: unknown;
  bufferedEnd: unknown;
  duration: unknown;
}

interface CapturedMergeCandidate {
  video: CapturedTrack;
  audio: CapturedTrack;
  videoParts: CapturedTrack[];
  audioParts: CapturedTrack[];
  preferredContainer: MergeContainer;
  extension: MseCacheMergeFileOptions['extension'];
  mimeType: MseCacheMergeFileOptions['mimeType'];
}

interface CapturedMergeResolution {
  candidate?: CapturedMergeCandidate;
  reason?: string;
}

interface TrackCoverageProfile {
  start: number;
  end: number;
  coveredSeconds: number;
  continuityRatio: number;
  duration?: number;
}

interface TrackPairCompatibility {
  compatible: boolean;
  verifiedTimeline: boolean;
  reason?: string;
}

interface SaveFilePickerWindow {
  showSaveFilePicker?(options: {
    id?: string;
    suggestedName?: string;
    startIn?: 'downloads';
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }): Promise<FileSystemFileHandleLike>;
}

interface CaptureDownloadOperation {
  id: number;
  generation: number;
  sessionId: string | undefined;
}

const runtimesByDocument = new WeakMap<Document, MseCacheCaptureRuntime>();

/** Lets the unified dock discover a runtime created before the playback UI. */
export function getMseCacheCaptureRuntime(doc: Document): MseCacheCaptureRuntime | undefined {
  return runtimesByDocument.get(doc);
}

export function formatMseCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /extension context invalidated|context invalidated|扩展上下文.*失效/iu.test(message);
}

/** Keep route ownership identical to the MAIN-world hook without shared state. */
export function mseCacheRouteKeyForUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const isYouTube =
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com');
    if (isYouTube) {
      const candidate =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
      if (candidate && /^[0-9A-Za-z_-]{6,32}$/u.test(candidate)) {
        return `youtube:${candidate}`;
      }
    }
    const isBilibili = hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
    if (isBilibili) {
      const bvid = /\/video\/(BV[0-9A-Za-z]+)/u.exec(url.pathname)?.[1]?.toUpperCase();
      if (bvid) {
        const numeric = (value: string | null): string =>
          value && /^\d+$/u.test(value) ? value.replace(/^0+(?=\d)/u, '') : '';
        return `bilibili:${bvid}:p=${numeric(url.searchParams.get('p')) || '1'}:cid=${numeric(url.searchParams.get('cid'))}`;
      }
    }
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl;
  }
}

function trackKind(mime: string): 'video' | 'audio' | undefined {
  const normalized = mime.trim().toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return undefined;
}

const MSE_TIMELINE_UNSAFE_REASONS = new Set<MseTimelineUnsafeReason>([
  'source-buffer-state-unreadable',
  'sequence-mode',
  'timestamp-offset',
  'append-window',
  'change-type',
  'remove',
  'abort',
  'end-of-stream-error',
  'timeline-event-overflow',
]);

function unsafeTimelineReasonsFrom(message: Record<string, unknown>): MseTimelineUnsafeReason[] {
  const candidates = [
    message.unsafeTimelineReason,
    ...(Array.isArray(message.unsafeTimelineReasons) ? message.unsafeTimelineReasons : []),
  ];
  return [
    ...new Set(
      candidates.filter(
        (value): value is MseTimelineUnsafeReason =>
          typeof value === 'string' &&
          MSE_TIMELINE_UNSAFE_REASONS.has(value as MseTimelineUnsafeReason),
      ),
    ),
  ];
}

function coverageProfile(track: CapturedTrack): TrackCoverageProfile | undefined {
  const ranges = track.bufferedRanges.filter(
    (range) =>
      Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start,
  );
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first || !last) return undefined;
  const coveredSeconds = ranges.reduce((total, range) => total + (range.end - range.start), 0);
  const spanSeconds = last.end - first.start;
  return {
    start: first.start,
    end: last.end,
    coveredSeconds,
    continuityRatio: spanSeconds > 0 ? coveredSeconds / spanSeconds : 0,
    ...(track.duration == null ? {} : { duration: track.duration }),
  };
}

function intersectedCoverageSeconds(
  left: readonly { start: number; end: number }[],
  right: readonly { start: number; end: number }[],
): number {
  let leftIndex = 0;
  let rightIndex = 0;
  let coveredSeconds = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRange = left[leftIndex]!;
    const rightRange = right[rightIndex]!;
    coveredSeconds += Math.max(
      0,
      Math.min(leftRange.end, rightRange.end) - Math.max(leftRange.start, rightRange.start),
    );
    if (leftRange.end <= rightRange.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return coveredSeconds;
}

function intersectRanges(
  left: readonly { start: number; end: number }[],
  right: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  let leftIndex = 0;
  let rightIndex = 0;
  const intersection: Array<{ start: number; end: number }> = [];
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRange = left[leftIndex]!;
    const rightRange = right[rightIndex]!;
    const start = Math.max(leftRange.start, rightRange.start);
    const end = Math.min(leftRange.end, rightRange.end);
    if (end > start) intersection.push({ start, end });
    if (leftRange.end <= rightRange.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return intersection;
}

function commonTrackRanges(
  tracks: readonly CapturedTrack[],
): Array<{ start: number; end: number }> {
  const withRanges = tracks.filter((track) => track.bufferedRanges.length > 0);
  if (withRanges.length !== tracks.length || withRanges.length === 0) return [];
  return withRanges.slice(1).reduce<Array<{ start: number; end: number }>>(
    (ranges, track) => intersectRanges(ranges, track.bufferedRanges),
    withRanges[0]!.bufferedRanges.map((range) => ({ ...range })),
  );
}

/** Only a gap-free range starting near zero can advance completion progress. */
function continuousCoverageFromBeginning(
  ranges: readonly { start: number; end: number }[],
): number {
  const first = ranges[0];
  if (!first || first.start > 0.25) return 0;
  let end = first.end;
  for (const range of ranges.slice(1)) {
    if (range.start > end + 0.05) break;
    end = Math.max(end, range.end);
  }
  return Math.max(0, end);
}

function pairCompatibility(video: CapturedTrack, audio: CapturedTrack): TrackPairCompatibility {
  const videoCoverage = coverageProfile(video);
  const audioCoverage = coverageProfile(audio);
  if (!videoCoverage && !audioCoverage) {
    // Older capture messages did not carry ranges. Preserve the known-safe
    // one-video/one-audio path, but never use this fallback to break a tie.
    return { compatible: true, verifiedTimeline: false };
  }
  if (!videoCoverage || !audioCoverage) {
    return {
      compatible: false,
      verifiedTimeline: false,
      reason: '视频轨与音频轨缺少可比较的共同捕获时间范围，无法确认来自同一段时间线。',
    };
  }

  const overlapSeconds = intersectedCoverageSeconds(video.bufferedRanges, audio.bufferedRanges);
  if (overlapSeconds <= 0.05) {
    return {
      compatible: false,
      verifiedTimeline: true,
      reason: '视频轨与音频轨的捕获时间范围不重叠，可能属于不同播放阶段或切轨分段。',
    };
  }

  if (videoCoverage.continuityRatio < 0.97 || audioCoverage.continuityRatio < 0.97) {
    return {
      compatible: false,
      verifiedTimeline: true,
      reason: '检测到轨道时间范围存在明显断层；本轮不会猜测拼接 changeType 分段。',
    };
  }

  const shortestCoverage = Math.min(videoCoverage.coveredSeconds, audioCoverage.coveredSeconds);
  if (shortestCoverage <= 0 || overlapSeconds / shortestCoverage < 0.9) {
    return {
      compatible: false,
      verifiedTimeline: true,
      reason: '视频轨与音频轨缺少持续的共同覆盖，无法安全对齐完整时间线。',
    };
  }

  const referenceDuration = Math.max(
    videoCoverage.duration ?? videoCoverage.end,
    audioCoverage.duration ?? audioCoverage.end,
  );
  const lifecycleTolerance = Math.max(0.25, Math.min(1, referenceDuration * 0.01));
  if (
    Math.abs(videoCoverage.start - audioCoverage.start) > lifecycleTolerance ||
    Math.abs(videoCoverage.end - audioCoverage.end) > lifecycleTolerance ||
    (videoCoverage.duration != null &&
      audioCoverage.duration != null &&
      Math.abs(videoCoverage.duration - audioCoverage.duration) > lifecycleTolerance)
  ) {
    return {
      compatible: false,
      verifiedTimeline: true,
      reason: '视频和音频的开始时间、结束时间或时长差异较大，可能来自不同次播放。',
    };
  }

  return { compatible: true, verifiedTimeline: true };
}

function clearlyDominatesByBytes(
  selected: CapturedTrack,
  tracks: readonly CapturedTrack[],
): boolean {
  const ordered = [...tracks].sort((left, right) => right.bytes - left.bytes);
  const runnerUp = ordered.find((track) => track.id !== selected.id);
  // Legacy hooks may announce an abandoned bootstrap track without timing.
  // Only discard such an alternative when it is demonstrably a tiny fragment;
  // two substantial tracks are never resolved by byte size alone.
  return !runnerUp || (runnerUp.bytes <= 4 * 1024 && selected.bytes >= runnerUp.bytes * 4);
}

function capturedMergeCandidate(
  video: CapturedTrack,
  audio: CapturedTrack,
  videoParts: CapturedTrack[] = [video],
  audioParts: CapturedTrack[] = [audio],
): CapturedMergeCandidate {
  const videoMime = video.mime.toLowerCase();
  const audioMime = audio.mime.toLowerCase();
  if (videoMime.includes('webm') && audioMime.includes('webm')) {
    return {
      video,
      audio,
      videoParts,
      audioParts,
      preferredContainer: 'webm',
      extension: '.webm',
      mimeType: 'video/webm',
    };
  }
  if (videoMime.includes('mp4') && audioMime.includes('mp4')) {
    return {
      video,
      audio,
      videoParts,
      audioParts,
      preferredContainer: 'mp4',
      extension: '.mp4',
      mimeType: 'video/mp4',
    };
  }
  return {
    video,
    audio,
    videoParts,
    audioParts,
    preferredContainer: 'mkv',
    extension: '.mkv',
    mimeType: 'video/x-matroska',
  };
}

function sequentialMp4TrackParts(tracks: readonly CapturedTrack[]): CapturedTrack[] | undefined {
  if (tracks.length === 1) return [tracks[0]!];
  if (
    tracks.some(
      (track) =>
        !track.mime.toLowerCase().includes('mp4') ||
        !Number.isSafeInteger(track.firstSequence) ||
        track.firstSequence < 0 ||
        track.bufferedRanges.length === 0,
    )
  ) {
    return undefined;
  }
  const ordered = [...tracks].sort((left, right) => {
    const leftCoverage = coverageProfile(left)!;
    const rightCoverage = coverageProfile(right)!;
    return leftCoverage.start - rightCoverage.start || left.firstSequence - right.firstSequence;
  });
  let previousEnd: number | undefined;
  let previousSequence = -1;
  for (const track of ordered) {
    const coverage = coverageProfile(track);
    if (!coverage || coverage.continuityRatio < 0.97) return undefined;
    if (previousEnd != null) {
      if (track.firstSequence <= previousSequence) return undefined;
      if (Math.abs(coverage.start - previousEnd) > 0.05) return undefined;
    }
    previousEnd = coverage.end;
    previousSequence = track.firstSequence;
  }
  return ordered;
}

function aggregateSequentialParts(parts: readonly CapturedTrack[]): CapturedTrack {
  const first = parts[0]!;
  const firstCoverage = coverageProfile(first)!;
  const lastCoverage = coverageProfile(parts[parts.length - 1]!)!;
  const durations = parts.flatMap((track) => (track.duration == null ? [] : [track.duration]));
  return {
    ...first,
    id: parts.map((track) => track.id).join('+'),
    bytes: parts.reduce((total, track) => total + track.bytes, 0),
    firstSequence: Math.min(...parts.map((track) => track.firstSequence)),
    lastSequence: Math.max(...parts.map((track) => track.lastSequence)),
    bufferedStart: firstCoverage.start,
    bufferedEnd: lastCoverage.end,
    bufferedRanges: [{ start: firstCoverage.start, end: lastCoverage.end }],
    ...(durations.length === 0 ? {} : { duration: Math.max(...durations) }),
  };
}

function sequentialChangeTypeCandidate(
  videoTracks: readonly CapturedTrack[],
  audioTracks: readonly CapturedTrack[],
): CapturedMergeCandidate | undefined {
  if (videoTracks.length === 1 && audioTracks.length === 1) return undefined;
  const videoParts = sequentialMp4TrackParts(videoTracks);
  const audioParts = sequentialMp4TrackParts(audioTracks);
  if (!videoParts || !audioParts) return undefined;
  const compatibility = pairCompatibility(
    aggregateSequentialParts(videoParts),
    aggregateSequentialParts(audioParts),
  );
  if (!compatibility.compatible) return undefined;
  return capturedMergeCandidate(videoParts[0]!, audioParts[0]!, videoParts, audioParts);
}

function mergeCandidateForGroup(tracks: readonly CapturedTrack[]): CapturedMergeResolution {
  const unsafeTimelineReasons = [
    ...new Set(tracks.flatMap((track) => [...track.unsafeTimelineReasons])),
  ];
  if (unsafeTimelineReasons.length > 0) {
    return {
      reason: `播放器修改过媒体时间线（${unsafeTimelineReasons.join(', ')}），自动合并可能发生错位。`,
    };
  }
  const videoTracks = tracks.filter((track) => trackKind(track.mime) === 'video');
  const audioTracks = tracks.filter((track) => trackKind(track.mime) === 'audio');
  if (videoTracks.length === 0) return { reason: '当前媒体源没有可合并的视频轨。' };
  if (audioTracks.length === 0) return { reason: '当前媒体源没有可合并的音频轨。' };

  const sequentialCandidate = sequentialChangeTypeCandidate(videoTracks, audioTracks);
  if (sequentialCandidate) return { candidate: sequentialCandidate };

  const compatiblePairs = videoTracks.flatMap((video) =>
    audioTracks.flatMap((audio) => {
      const compatibility = pairCompatibility(video, audio);
      return compatibility.compatible ? [{ video, audio, compatibility }] : [];
    }),
  );
  if (compatiblePairs.length === 0) {
    const reasons = videoTracks.flatMap((video) =>
      audioTracks.flatMap((audio) => pairCompatibility(video, audio).reason ?? []),
    );
    return {
      reason: reasons[0] ?? '同一媒体源内没有时间线兼容的视频轨与音频轨，无法安全合并。',
    };
  }

  if (compatiblePairs.length === 1) {
    const pair = compatiblePairs[0]!;
    return { candidate: capturedMergeCandidate(pair.video, pair.audio) };
  }

  const allLegacy = compatiblePairs.every((pair) => !pair.compatibility.verifiedTimeline);
  if (allLegacy) {
    const video = [...videoTracks].sort((left, right) => right.bytes - left.bytes)[0]!;
    const audio = [...audioTracks].sort((left, right) => right.bytes - left.bytes)[0]!;
    if (
      clearlyDominatesByBytes(video, videoTracks) &&
      clearlyDominatesByBytes(audio, audioTracks)
    ) {
      return { candidate: capturedMergeCandidate(video, audio) };
    }
  }

  return {
    reason:
      '同一媒体源内存在多组可配对轨道，可能是 changeType 切轨分段；无法无歧义地选择完整视频与音频。',
  };
}

function groupedTracks(tracks: readonly CapturedTrack[]): Map<string, CapturedTrack[]> {
  const groups = new Map<string, CapturedTrack[]>();
  for (const track of tracks) {
    const group = groups.get(track.groupId) ?? [];
    group.push(track);
    groups.set(track.groupId, group);
  }
  return groups;
}

function bestCapturedMergeCandidate(
  tracks: readonly CapturedTrack[],
  completeGroupIds: ReadonlySet<string>,
  preferredGroupId?: string,
): CapturedMergeResolution {
  const resolutions = [...groupedTracks(tracks)].map(([groupId, groupTracks]) => {
    const resolution = mergeCandidateForGroup(groupTracks);
    return {
      resolution,
      preferred: groupId === preferredGroupId,
      complete: completeGroupIds.has(groupId),
      bytes: groupTracks.reduce((total, track) => total + track.bytes, 0),
      hasBothKinds:
        groupTracks.some((track) => trackKind(track.mime) === 'video') &&
        groupTracks.some((track) => trackKind(track.mime) === 'audio'),
    };
  });
  // Once MAIN has bound the selected player's blob URL, never substitute an
  // unrelated page/ad MediaSource merely because it happens to be mergeable.
  const preferred = resolutions.find((entry) => entry.preferred);
  if (preferred) return preferred.resolution;
  const candidates = resolutions.filter((entry) => entry.resolution.candidate != null);
  candidates.sort(
    (left, right) =>
      Number(right.preferred) - Number(left.preferred) ||
      Number(right.complete) - Number(left.complete) ||
      right.bytes - left.bytes,
  );
  const selected = candidates[0]?.resolution;
  if (selected) return selected;
  const hasVideo = tracks.some((track) => trackKind(track.mime) === 'video');
  const hasAudio = tracks.some((track) => trackKind(track.mime) === 'audio');
  if (hasVideo && hasAudio && resolutions.every((entry) => !entry.hasBothKinds)) {
    return {
      reason: '视频轨与音频轨来自不同 MediaSource；没有同一媒体源内可安全配对的轨道。',
    };
  }
  resolutions.sort(
    (left, right) =>
      Number(right.preferred) - Number(left.preferred) ||
      Number(right.hasBothKinds) - Number(left.hasBothKinds) ||
      right.bytes - left.bytes,
  );
  return resolutions[0]?.resolution ?? { reason: '当前缓存中没有可合并的媒体轨道。' };
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const pattern = [...text].map((character) => character.charCodeAt(0));
  outer: for (let index = 0; index <= bytes.byteLength - pattern.length; index += 1) {
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (bytes[index + offset] !== pattern[offset]) continue outer;
    }
    return true;
  }
  return false;
}

export function detectMseDrmSignal(bytes: Uint8Array): string | undefined {
  for (const signal of ['pssh', 'encv', 'enca']) {
    if (containsAscii(bytes, signal)) return signal;
  }
  return undefined;
}

export function inferMseTrackMime(bytes: Uint8Array): string | undefined {
  const isoBmff = ['ftyp', 'styp', 'moov', 'moof'].some((marker) => containsAscii(bytes, marker));
  if (isoBmff) {
    const video = ['vide', 'avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'].some((marker) =>
      containsAscii(bytes, marker),
    );
    const audio = ['soun', 'mp4a', 'ac-3', 'ec-3', 'Opus'].some((marker) =>
      containsAscii(bytes, marker),
    );
    if (video) return 'video/mp4';
    if (audio) return 'audio/mp4';
  }

  const webmHeader =
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;
  if (webmHeader || containsAscii(bytes, 'webm')) {
    if (['V_VP8', 'V_VP9', 'V_AV1'].some((marker) => containsAscii(bytes, marker))) {
      return 'video/webm';
    }
    if (['A_OPUS', 'A_VORBIS', 'A_AAC'].some((marker) => containsAscii(bytes, marker))) {
      return 'audio/webm';
    }
  }
  return undefined;
}

/** A complete cache must contain enough container bootstrap data to be playable. */
export function containsMseInitialization(bytes: Uint8Array, mime: string): boolean {
  const normalized = mime.toLowerCase();
  if (normalized.includes('mp4') || normalized.includes('iso.segment')) {
    return containsAscii(bytes, 'ftyp') || containsAscii(bytes, 'moov');
  }
  if (normalized.includes('webm')) {
    return (
      (bytes.byteLength >= 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3) ||
      containsAscii(bytes, 'webm')
    );
  }
  // MPEG-TS and other self-describing streams do not have a separate MSE init segment.
  return !normalized.includes('octet-stream');
}

/**
 * Page-local MSE capture session. It deliberately owns no DOM: rendering lives
 * in FloatingPlaybackController so v0.4 can guarantee exactly one Shadow host.
 */
export class MseCacheCaptureRuntime {
  private readonly view: Window;
  private readonly capacityBytes: number | undefined;
  private readonly chunkStore: MseCacheChunkStore;
  private readonly ownsChunkStore: boolean;
  private readonly captureTimeoutMs: number;
  private readonly startAckTimeoutMs: number;
  private readonly targetBindTimeoutMs: number;
  private readonly createStandardTrackOutput:
    NonNullable<MseCacheChunkStore['createStandardTrackOutput']> | undefined;
  private readonly pickMergeFile:
    ((options: MseCacheMergeFileOptions) => Promise<FileSystemFileHandleLike>) | undefined;
  private readonly remuxCapturedBlobs: typeof remuxCapturedBlobsToFile;
  private readonly normalizeCapturedTracks: typeof normalizeCapturedTrackPair;
  private downloadSaveAs: boolean;
  private readonly tracks = new Map<string, CapturedTrack>();
  private readonly groupStates = new Map<string, CapturedGroupState>();
  private readonly listeners = new Set<MseCacheSnapshotListener>();
  private readonly requestStartHandler: (() => void | Promise<void>) | undefined;
  private readonly requestResetAndReloadHandler: (() => void | Promise<void>) | undefined;
  private readonly shouldAutoDownload: (() => boolean) | undefined;
  private readonly reloadPage: () => void;
  private uiRequestHandler: MseCacheUiRequestHandler | undefined;
  private themeMode: ThemeMode;
  private status: MseCacheCaptureStatus = 'idle';
  private capturedBytes = 0;
  private pendingStorageBytes = 0;
  private inspectedBytes = 0;
  private sessionId: string | undefined;
  private title = APP_NAME_EN;
  private message = '等待下载失败后启动缓存捕获';
  private error: string | undefined;
  private autoDownload = false;
  private clearAfterDownload = false;
  private minimized = true;
  private filename = APP_NAME_EN;
  private downloading = false;
  private startedAtBeginning = false;
  private captureTimer: number | undefined;
  private startAckTimer: number | undefined;
  private targetBindTimer: number | undefined;
  private renderTimer: number | undefined;
  private sessionRouteKey: string | undefined;
  private sessionPageUrl: string | undefined;
  private mediaIdentity: MseCacheMediaIdentity | undefined;
  private hookGeneration: number | undefined;
  private hookAcknowledged = false;
  private targetSourceUrl: string | undefined;
  private boundGroupId: string | undefined;
  private waitingForTarget = false;
  private recoveryReloadRequested = false;
  private operationGeneration = 0;
  private downloadOperationSequence = 0;
  private activeDownloadOperation: CaptureDownloadOperation | undefined;
  private storageTail: Promise<void> = Promise.resolve();
  private storageFailure: Error | undefined;
  private storageGeneration = 0;
  private readonly autoDownloadedGroupIds = new Set<string>();

  constructor(
    private readonly doc: Document,
    options: MseCacheCaptureRuntimeOptions = {},
  ) {
    this.view = doc.defaultView ?? window;
    this.capacityBytes =
      options.capacityBytes == null ? undefined : Math.max(1, options.capacityBytes);
    this.ownsChunkStore = options.chunkStore == null;
    this.chunkStore = options.chunkStore ?? createMseCacheChunkStore(this.view, this.doc);
    this.captureTimeoutMs = Math.max(1, options.captureTimeoutMs ?? MSE_CACHE_IDLE_TIMEOUT_MS);
    this.startAckTimeoutMs = Math.max(
      1,
      options.startAckTimeoutMs ?? MSE_CACHE_START_ACK_TIMEOUT_MS,
    );
    this.targetBindTimeoutMs = Math.max(
      1,
      options.targetBindTimeoutMs ?? MSE_CACHE_TARGET_BIND_TIMEOUT_MS,
    );
    // Direct runtime consumers retain the previous picker behavior. The media
    // agent always passes the real global download setting (whose default is false).
    this.downloadSaveAs = options.downloadSaveAs ?? true;
    this.themeMode = options.themeMode ?? 'auto';
    this.createStandardTrackOutput =
      options.createStandardTrackOutput ??
      this.chunkStore.createStandardTrackOutput?.bind(this.chunkStore);
    const picker = this.view as unknown as SaveFilePickerWindow;
    this.pickMergeFile =
      options.pickMergeFile ??
      (this.view.top === this.view && picker.showSaveFilePicker
        ? (file) =>
            picker.showSaveFilePicker!({
              id: downloadFilePickerId(this.sessionPageUrl ?? this.doc.URL, 'cache-merge'),
              suggestedName: file.suggestedName,
              startIn: 'downloads',
              types: [
                {
                  description: file.description,
                  accept: { [file.mimeType]: [file.extension] },
                },
              ],
            })
        : undefined);
    this.remuxCapturedBlobs = options.remuxCapturedBlobs ?? remuxCapturedBlobsToFile;
    this.normalizeCapturedTracks = options.normalizeCapturedTracks ?? normalizeCapturedTrackPair;
    this.requestStartHandler = options.onRequestStart;
    this.requestResetAndReloadHandler = options.onRequestResetAndReload;
    this.shouldAutoDownload = options.shouldAutoDownload;
    this.reloadPage = options.reloadPage ?? (() => this.view.location.reload());
    this.uiRequestHandler = options.onUiRequest;
    if (options.onSnapshot) this.listeners.add(options.onSnapshot);

    this.view.addEventListener('message', this.handleWindowMessage);
    this.doc.addEventListener('encrypted', this.handleEncrypted, true);
    runtimesByDocument.get(doc)?.destroy();
    runtimesByDocument.set(doc, this);
    this.renderView();
  }

  /** Compatibility accessor: points at the unified dock once it is mounted. */
  get host(): HTMLElement {
    const host = this.doc.getElementById(MSE_CACHE_CAPTURE_HOST_ID);
    if (!host) throw new Error('FoxFetch unified media dock is not mounted');
    return host;
  }

  /** Compatibility accessor: points at the unified dock ShadowRoot. */
  get shadowRoot(): ShadowRoot {
    const root = this.host.shadowRoot;
    if (!root) throw new Error('FoxFetch unified media dock has no ShadowRoot');
    return root;
  }

  subscribe(listener: MseCacheSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  setUiRequestHandler(handler: MseCacheUiRequestHandler | undefined): void {
    this.uiRequestHandler = handler;
    if (handler && this.status !== 'idle' && !this.minimized) handler('cache');
  }

  applyDownloadSaveAs(saveAs: boolean): void {
    this.downloadSaveAs = saveAs;
  }

  start(options: StartMseCacheCaptureOptions): MseCacheCaptureSnapshot {
    const pageUrl = options.pageUrl ?? options.mediaIdentity?.pageUrl ?? this.doc.URL;
    const routeKey = mseCacheRouteKeyForUrl(pageUrl);
    const targetCandidate = options.targetSourceUrl ?? options.mediaIdentity?.sourceUrl;
    const targetSourceUrl =
      typeof targetCandidate === 'string' && targetCandidate.startsWith('blob:')
        ? targetCandidate
        : undefined;
    const sameBinding =
      this.sessionRouteKey === routeKey && this.targetSourceUrl === targetSourceUrl;
    if (
      (this.status === 'starting' || this.status === 'capturing') &&
      this.sessionId === options.sessionId &&
      sameBinding
    ) {
      this.show();
      return this.getSnapshot();
    }
    if (this.status === 'paused' && this.sessionId === options.sessionId && sameBinding) {
      this.resume();
      this.show();
      return this.getSnapshot();
    }
    if (this.sessionId) this.postControl('stop');
    this.invalidateDownloadOperations();
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.resetData();
    this.recoveryReloadRequested = false;
    this.sessionId = options.sessionId;
    this.sessionRouteKey = routeKey;
    this.sessionPageUrl = pageUrl;
    this.mediaIdentity = options.mediaIdentity;
    this.hookGeneration = undefined;
    this.hookAcknowledged = false;
    this.targetSourceUrl = targetSourceUrl;
    this.boundGroupId = undefined;
    this.waitingForTarget = targetSourceUrl != null;
    const normalizedTitle = normalizeMediaTitle(options.title, pageUrl) || options.title;
    this.title = normalizedTitle;
    this.filename = sanitizeFilename(normalizedTitle, APP_NAME_EN);
    this.error = undefined;
    this.minimized = false;

    if (options.hookSupported === false) {
      this.status = 'error';
      this.error = '当前页面未提供可捕获的 Media Source Extensions 数据。';
      this.message = this.error;
      this.renderView();
      this.requestUi('cache');
      return this.getSnapshot();
    }

    this.status = 'starting';
    this.message = options.reason
      ? `常规下载失败（${options.reason}），正在连接页面缓存捕获钩子…`
      : '正在连接页面缓存捕获钩子…';
    this.postControl('start');
    this.armStartAckTimer();
    this.renderView();
    this.requestUi('cache');
    return this.getSnapshot();
  }

  getSnapshot(): MseCacheCaptureSnapshot {
    const groups = this.getGroupSnapshots();
    const completeGroupIds = groups.filter((group) => group.complete).map((group) => group.id);
    const bestGroupId = this.bestDownloadableGroupId(groups);
    const bestGroup = groups.find((group) => group.id === bestGroupId);
    const totalSeconds =
      bestGroup?.durationSeconds ??
      (this.mediaIdentity?.duration != null &&
      Number.isFinite(this.mediaIdentity.duration) &&
      this.mediaIdentity.duration > 0
        ? this.mediaIdentity.duration
        : undefined);
    const cachedSeconds = bestGroup?.cachedSeconds ?? 0;
    const mergeResolution = bestCapturedMergeCandidate(
      [...this.tracks.values()].filter((track) => track.bytes > 0),
      new Set(completeGroupIds),
      this.boundGroupId,
    );
    return {
      status: this.status,
      capturedBytes: this.capturedBytes,
      pendingBytes: this.pendingStorageBytes,
      ...(this.capacityBytes == null ? {} : { capacityBytes: this.capacityBytes }),
      ...(bestGroupId == null ? {} : { progressGroupId: bestGroupId }),
      cachedSeconds,
      ...(totalSeconds == null ? {} : { totalSeconds }),
      progressRatio:
        totalSeconds == null || totalSeconds <= 0
          ? null
          : Math.max(0, Math.min(1, cachedSeconds / totalSeconds)),
      storageKind: this.chunkStore.kind,
      trackCount: this.tracks.size,
      sourceCount: new Set([...this.tracks.values()].map((track) => track.groupId)).size,
      autoDownload: this.autoDownload,
      clearAfterDownload: this.clearAfterDownload,
      minimized: this.minimized,
      filename: this.filename,
      downloading: this.downloading,
      canMerge: mergeResolution.candidate != null,
      ...(mergeResolution.candidate || !mergeResolution.reason
        ? {}
        : { mergeBlockReason: mergeResolution.reason }),
      isComplete: bestGroupId != null && completeGroupIds.includes(bestGroupId),
      startedAtBeginning: this.startedAtBeginning,
      completeGroupIds,
      groups,
      tracks: [...this.tracks.values()].map((track) => ({
        id: track.id,
        groupId: track.groupId,
        mime: track.mime,
        bytes: track.bytes,
        initPresent: track.initPresent,
        ...(track.unsafeTimelineReasons.size === 0
          ? {}
          : { unsafeTimelineReasons: [...track.unsafeTimelineReasons] }),
        complete: completeGroupIds.includes(track.groupId),
      })),
      ...(this.sessionRouteKey ? { routeKey: this.sessionRouteKey } : {}),
      ...(this.hookGeneration == null ? {} : { hookGeneration: this.hookGeneration }),
      ...(this.boundGroupId ? { boundGroupId: this.boundGroupId } : {}),
      waitingForTarget: this.waitingForTarget,
      message: this.message,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  applyTheme(themeMode: ThemeMode): void {
    this.themeMode = themeMode;
  }

  show(): void {
    this.minimized = false;
    this.renderView();
    this.requestUi('cache');
  }

  hide(): void {
    this.minimized = true;
    this.renderView();
    this.requestUi('launcher');
  }

  close(): void {
    this.postControl('stop');
    this.invalidateDownloadOperations();
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.clearRenderTimer();
    this.resetData();
    this.sessionId = undefined;
    this.sessionRouteKey = undefined;
    this.sessionPageUrl = undefined;
    this.mediaIdentity = undefined;
    this.hookGeneration = undefined;
    this.hookAcknowledged = false;
    this.targetSourceUrl = undefined;
    this.boundGroupId = undefined;
    this.waitingForTarget = false;
    this.recoveryReloadRequested = false;
    this.status = 'idle';
    this.message = '等待下载失败后启动缓存捕获';
    this.error = undefined;
    this.minimized = true;
    this.renderView();
    this.requestUi('launcher');
  }

  /**
   * End a page-local session when an SPA changes videos and invalidate MAIN's
   * replay archive. A normal close intentionally keeps that bounded archive for
   * retrying the same video; navigation must not carry it into another title.
   */
  resetForNavigation(): void {
    this.close();
    this.view.postMessage(
      {
        channel: MSE_CAPTURE_CHANNEL,
        direction: 'agent-to-main',
        protocolVersion: MSE_CACHE_PROTOCOL_VERSION,
        hookBuildId: MSE_CACHE_HOOK_BUILD_ID,
        command: 'reset-route',
        pageUrl: this.doc.URL,
      },
      '*',
    );
  }

  /**
   * Invalidate a capture even when an SPA swaps the selected media without
   * changing location.href. Old remux callbacks and MAIN messages can no
   * longer mutate the next media session after this returns.
   */
  resetForMediaChange(identity?: string | MseCacheMediaIdentity): void {
    const details = typeof identity === 'string' ? undefined : identity;
    const pageUrl = details?.pageUrl ?? this.doc.URL;
    this.close();
    this.view.postMessage(
      {
        channel: MSE_CAPTURE_CHANNEL,
        direction: 'agent-to-main',
        protocolVersion: MSE_CACHE_PROTOCOL_VERSION,
        hookBuildId: MSE_CACHE_HOOK_BUILD_ID,
        command: 'reset-route',
        pageUrl,
        force: true,
        ...(identity == null ? {} : { mediaIdentity: identity }),
      },
      '*',
    );
  }

  /** Pause capture without discarding the current session or captured bytes. */
  pause(): MseCacheCaptureSnapshot {
    if (this.status !== 'capturing' && this.status !== 'starting') return this.getSnapshot();
    this.status = 'paused';
    this.postControl('pause');
    this.clearCaptureTimer();
    this.message = '捕获已暂停；现有缓存数据已保留，可随时继续捕获或下载。';
    this.renderView();
    return this.getSnapshot();
  }

  /** Resume the same MAIN-world session without replaying initialization data. */
  resume(): MseCacheCaptureSnapshot {
    if (this.status !== 'paused' || !this.sessionId) return this.getSnapshot();
    this.status = this.hookAcknowledged && !this.waitingForTarget ? 'capturing' : 'starting';
    this.error = undefined;
    this.postControl(this.hookAcknowledged ? 'resume' : 'start');
    if (!this.hookAcknowledged) this.armStartAckTimer();
    else if (this.waitingForTarget) this.armTargetBindTimer();
    else this.armCaptureTimer();
    this.message = !this.hookAcknowledged
      ? '正在重新等待页面缓存捕获钩子确认…'
      : this.waitingForTarget
        ? '缓存功能已启动，正在等待识别所选播放器。'
        : '已继续捕获；此前缓存数据和轨道序号均已保留。';
    this.renderView();
    return this.getSnapshot();
  }

  /** Called after the selected media element has been reset and confirmed near zero. */
  markStartedAtBeginning(): MseCacheCaptureSnapshot {
    if (!this.sessionId) return this.getSnapshot();
    this.startedAtBeginning = true;
    this.renderView();
    return this.getSnapshot();
  }

  clear(): void {
    const wasPaused = this.status === 'paused';
    const wasStarting = this.status === 'starting';
    this.invalidateDownloadOperations();
    this.resetData();
    if (this.status !== 'blocked_drm' && this.status !== 'error') {
      this.status = this.sessionId
        ? wasPaused
          ? 'paused'
          : wasStarting
            ? 'starting'
            : 'capturing'
        : 'idle';
      this.message = this.sessionId
        ? wasPaused
          ? '缓存已清空，捕获仍处于暂停状态。'
          : wasStarting
            ? '缓存已清空，仍在等待页面捕获钩子确认。'
            : '缓存已清空，继续播放即可重新捕获。'
        : '等待下载失败后启动缓存捕获';
    }
    this.postControl('clear');
    this.renderView();
  }

  setAutoDownload(enabled: boolean): void {
    if (this.autoDownload === enabled) return;
    this.autoDownload = enabled;
    this.renderView();
  }

  setClearAfterDownload(enabled: boolean): void {
    if (this.clearAfterDownload === enabled) return;
    this.clearAfterDownload = enabled;
    this.renderView();
  }

  setFilename(filename: string): void {
    const normalized = filename.trim().slice(0, 180);
    if (!normalized || normalized === this.filename) return;
    this.filename = normalized;
    this.renderView();
  }

  async requestStart(): Promise<void> {
    if (this.requestStartHandler) {
      try {
        await this.requestStartHandler();
        return;
      } catch (error) {
        if (isExtensionContextInvalidatedError(error)) {
          this.status = 'reload_required';
          this.error = '插件刚刚更新，当前网页仍连接着旧版本脚本。';
          this.message = '插件已更新，正在刷新当前视频页以重新连接并恢复缓存功能…';
          this.minimized = false;
          this.renderView();
          this.requestUi('cache');
          this.reloadInvalidatedContextOnce();
          throw error;
        }
        this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error);
        this.message = `无法启动缓存捕获：${this.error}`;
        this.minimized = false;
        this.renderView();
        this.requestUi('cache');
        throw error;
      }
    }
    this.start({
      sessionId: `cache-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: this.doc.title || APP_NAME_EN,
    });
  }

  async requestResetAndReload(): Promise<void> {
    if (this.requestResetAndReloadHandler) {
      // A deliberate button click may retry after the one automatic recovery
      // attempt failed; automatic protocol/binding signals remain single-shot.
      this.recoveryReloadRequested = false;
      try {
        await this.requestResetAndReloadHandler();
        return;
      } catch (error) {
        if (isExtensionContextInvalidatedError(error)) {
          this.status = 'reload_required';
          this.error = '插件刚刚更新，当前网页仍连接着旧版本脚本。';
          this.message = '插件已更新，正在刷新当前视频页以重新连接…';
          this.minimized = false;
          this.renderView();
          this.requestUi('cache');
          this.reloadInvalidatedContextOnce();
          throw error;
        }
        this.error = error instanceof Error ? error.message : String(error);
        this.message = `无法刷新并重新捕获：${this.error}；现有缓存仍保留。`;
        this.minimized = false;
        this.renderView();
        this.requestUi('cache');
        throw error;
      }
    }
    this.clear();
  }

  async downloadCaptured(preferMerge = false): Promise<string[]> {
    if (this.status === 'blocked_drm') throw new Error('DRM 媒体不能下载缓存');
    if (this.downloading) throw new Error('缓存文件正在生成，请稍候');
    const byteCapsAtClick = new Map(
      [...this.tracks.values()].map((track) => [track.id, track.bytes + track.pendingBytes]),
    );
    const eligibleGroupIdsAtClick = new Set(
      [...this.tracks.values()]
        .filter((track) => (byteCapsAtClick.get(track.id) ?? 0) > 0)
        .map((track) => track.groupId),
    );
    const storageBarrierAtClick = this.storageTail;
    const snapshotPersistedTracks = (capAtClick = false): CapturedTrack[] =>
      [...this.tracks.values()]
        .filter((track) => track.bytes > 0 && (!capAtClick || byteCapsAtClick.has(track.id)))
        .map((track) => ({
          ...track,
          bytes: capAtClick
            ? Math.min(track.bytes, byteCapsAtClick.get(track.id) ?? 0)
            : track.bytes,
          bufferedRanges: track.bufferedRanges.map((range) => ({ ...range })),
          unsafeTimelineReasons: new Set(track.unsafeTimelineReasons),
        }))
        .filter((track) => track.bytes > 0);
    let tracks = snapshotPersistedTracks();
    if (tracks.length === 0 && (preferMerge || this.pendingStorageBytes === 0)) {
      throw new Error('还没有捕获到可下载的数据');
    }
    const initialSnapshot = this.getSnapshot();
    const completeGroupIds = new Set(initialSnapshot.completeGroupIds);
    const mergeResolution = preferMerge
      ? bestCapturedMergeCandidate(tracks, completeGroupIds, this.boundGroupId)
      : undefined;
    const mergeCandidate = mergeResolution?.candidate;
    const promptForMergeSave = this.downloadSaveAs;
    if (preferMerge && !mergeCandidate) {
      const mergeError = new MergeError({
        code:
          tracks.some((track) => trackKind(track.mime) === 'video') &&
          tracks.some((track) => trackKind(track.mime) === 'audio')
            ? 'TIMELINE_MISMATCH'
            : tracks.some((track) => trackKind(track.mime) === 'video')
              ? 'AUDIO_TRACK_MISSING'
              : 'VIDEO_TRACK_MISSING',
        message: `${mergeResolution?.reason ?? '当前缓存中没有同一媒体源内可安全配对的视频轨与音频轨。'}请继续从头播放，或清除缓存后重新捕获。`,
        retryable: true,
        canDownloadSeparately: true,
      });
      this.error = mergeError.message;
      this.message = `无法安全合并：${mergeError.message}`;
      this.renderView();
      throw mergeError;
    }
    if (preferMerge && promptForMergeSave && !this.pickMergeFile) {
      const mergeError = new MergeError({
        code: 'OUTPUT_WRITE_FAILED',
        message: '当前浏览器不支持保存合并文件所需的接口，请更新浏览器后重试。',
        retryable: false,
        canDownloadSeparately: true,
      });
      this.error = mergeError.message;
      this.message = `无法安全合并：${mergeError.message}`;
      this.renderView();
      throw mergeError;
    }
    if (preferMerge && !promptForMergeSave && !this.chunkStore.createMergeOutput) {
      const mergeError = new MergeError({
        code: 'OUTPUT_WRITE_FAILED',
        message: '后台缓存合并程序不可用，请刷新页面后重试。',
        retryable: true,
        canDownloadSeparately: true,
      });
      this.error = mergeError.message;
      this.message = `无法安全合并：${mergeError.message}`;
      this.renderView();
      throw mergeError;
    }
    const baseName = sanitizeFilename(this.filename, sanitizeFilename(this.title, APP_NAME_EN));
    const mergeFileName = mergeCandidate ? `${baseName}${mergeCandidate.extension}` : undefined;
    // Open the picker before the first await so the dock click retains transient activation.
    let mergeHandlePromise: Promise<FileSystemFileHandleLike> | undefined;
    try {
      mergeHandlePromise =
        mergeCandidate && mergeFileName && promptForMergeSave && this.pickMergeFile
          ? this.pickMergeFile({
              suggestedName: mergeFileName,
              description: `${mergeCandidate.preferredContainer.toUpperCase()} 媒体文件`,
              mimeType: mergeCandidate.mimeType,
              extension: mergeCandidate.extension,
            })
          : undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.message = `无法打开合并文件保存窗口：${this.error}`;
      this.renderView();
      throw error;
    }

    const previousStatus = this.status;
    const operation: CaptureDownloadOperation = {
      id: ++this.downloadOperationSequence,
      generation: this.operationGeneration,
      sessionId: this.sessionId,
    };
    this.activeDownloadOperation = operation;
    this.downloading = true;
    this.error = undefined;
    if (
      previousStatus !== 'starting' &&
      previousStatus !== 'capturing' &&
      previousStatus !== 'paused'
    ) {
      this.status = 'downloading';
    }
    this.message = mergeCandidate
      ? promptForMergeSave
        ? `正在准备 ${tracks.length} 条缓存轨道并执行安全合并；保存位置可能暂时显示 0 KB 占位，只有封装和复验成功后才会提交文件内容。`
        : `正在准备 ${tracks.length} 条缓存轨道，并将合并结果分块写入扩展专用磁盘空间…`
      : `正在准备 ${tracks.length} 条缓存轨道…`;
    this.renderView();

    const filenames: string[] = [];
    const pageUrl = this.sessionPageUrl ?? this.doc.URL;
    let mergeOutput: MseCacheMergeOutput | undefined;
    const standardOutputs: MseCacheStandardTrackOutput[] = [];
    try {
      if (mergeCandidate && mergeFileName) {
        const destinationHandle = mergeHandlePromise ? await mergeHandlePromise : undefined;
        let handle = destinationHandle;
        // A user picker grants the final destination, but the remuxer must never
        // stream unverified bytes into that file. Prefer an extension-origin
        // OPFS staging output whenever the production store provides one, then
        // publish the immutable verified blob in one final copy.
        if (operation.sessionId && this.chunkStore.createMergeOutput) {
          mergeOutput = await this.chunkStore.createMergeOutput(
            operation.sessionId,
            `merge-${operation.id}-${Date.now().toString(36)}`,
            mergeFileName,
            mergeCandidate.mimeType,
          );
          handle = mergeOutput.handle;
        }
        if (!handle) {
          throw new MseCacheStorageError('缓存下载状态已失效，或后台缓存合并程序不可用。', {
            code: 'STORAGE_FAILED',
          });
        }
        if (!this.isCurrentDownloadOperation(operation)) return filenames;
        const storedParts = (parts: readonly CapturedTrack[]): Promise<CapturedFragmentPart[]> =>
          Promise.all(
            parts.map(async (track) => ({
              id: track.id,
              mime: track.mime,
              firstSequence: track.firstSequence,
              blob: await this.storedBlob(operation.sessionId, track),
            })),
          );
        const [videoParts, audioParts] = await Promise.all([
          storedParts(mergeCandidate.videoParts),
          storedParts(mergeCandidate.audioParts),
        ]);
        if (!this.isCurrentDownloadOperation(operation)) return filenames;
        this.message = '正在按 MP4 解码时间轴或 WebM 安全规则规范化缓存片段…';
        this.scheduleRender();
        const normalized = await this.normalizeCapturedTracks(videoParts, audioParts);
        if (!this.isCurrentDownloadOperation(operation)) return filenames;
        // Both tracks were selected from the same bound MediaSource group above.
        // Preserve that strong provenance through the local merge probe so normal
        // encoder priming offsets (for example Bilibili's ~133 ms A/V lead) are
        // accepted without weakening cross-page/cross-player pairing checks.
        const capturedStreamIdentity = [
          'mse-cache',
          operation.sessionId ?? 'unknown-session',
          this.sessionRouteKey ?? 'unknown-route',
          mergeCandidate.video.groupId,
        ].join(':');
        const result = await this.remuxCapturedBlobs(
          normalized.video.blob,
          normalized.audio.blob,
          handle,
          {
            preferredContainer: mergeCandidate.preferredContainer,
            videoStreamIdentity: capturedStreamIdentity,
            audioStreamIdentity: capturedStreamIdentity,
            onProgress: (progress: RemuxProgress) => {
              if (!this.isCurrentDownloadOperation(operation)) return;
              this.message = progress.message;
              this.scheduleRender();
            },
          },
        );
        const filename = destinationHandle?.name || mergeFileName;
        if (mergeOutput && destinationHandle) {
          if (!this.isCurrentDownloadOperation(operation)) return filenames;
          const stagedFile = await mergeOutput.handle.getFile();
          if (stagedFile.size !== result.sizeBytes) {
            throw new MergeError({
              code: 'OUTPUT_SIZE_MISMATCH',
              message: '扩展内部合并文件与验证结果大小不一致，未向目标文件写入内容。',
              retryable: true,
              canDownloadSeparately: true,
            });
          }
          await copyVerifiedBlobToHandle(
            stagedFile.slice(0, stagedFile.size, result.mimeType),
            destinationHandle,
          );
        } else if (mergeOutput) {
          if (!this.isCurrentDownloadOperation(operation)) return filenames;
          await mergeOutput.download(
            `${buildDownloadDirectory(pageUrl, 'video')}/${mergeFileName}`,
            { pageUrl, saveAs: this.downloadSaveAs },
          );
        }
        filenames.push(filename);
        if (!this.isCurrentDownloadOperation(operation)) return filenames;
        if (this.status === 'downloading') this.status = 'ready';
        this.error = undefined;
        this.message =
          mergeOutput && !destinationHandle
            ? `音视频已无损合并并验证，已提交到 ${displayDownloadDirectory(pageUrl, 'video')}/${mergeFileName}（${formatMseCacheBytes(result.sizeBytes)}）；捕获仍可继续。`
            : `音视频已无损合并并验证：${filename}（${formatMseCacheBytes(result.sizeBytes)}）；捕获仍可继续。`;
        this.clearAfterSuccessfulDownload();
        this.renderView();
        return filenames;
      }

      if (!operation.sessionId || !this.createStandardTrackOutput) {
        throw new MseCacheStorageError('后台媒体转换程序不可用，未生成可直接播放的文件。', {
          code: 'STORAGE_FAILED',
        });
      }
      await storageBarrierAtClick;
      if (!this.isCurrentDownloadOperation(operation)) return filenames;
      if (this.storageFailure) throw this.storageFailure;
      // The user can click while the final MediaSource append is still awaiting
      // its OPFS ACK. Take the immutable track/byte snapshot only after that
      // barrier so the tail is never silently omitted from MP4/MP3 output.
      tracks = snapshotPersistedTracks(true);
      const settledSnapshot = this.getSnapshot();
      const selectedGroupId = this.bestDownloadableGroupId(
        settledSnapshot.groups.filter((group) => eligibleGroupIdsAtClick.has(group.id)),
      );
      const mediaTracks = tracks.filter(
        (track): track is CapturedTrack & { mime: string } =>
          track.groupId === selectedGroupId && trackKind(track.mime) != null,
      );
      if (mediaTracks.length === 0) {
        throw new MseCacheStorageError('缓存中没有可转换为标准 MP4 或 MP3 的媒体轨。');
      }
      const failures: string[] = [];
      const submittedKinds = new Set<'video' | 'audio'>();
      for (const kind of ['video', 'audio'] as const) {
        const parts = mediaTracks
          .filter((track) => trackKind(track.mime) === kind)
          .sort(
            (left, right) =>
              left.firstSequence - right.firstSequence || left.id.localeCompare(right.id),
          );
        if (parts.length === 0) continue;
        if (!this.isCurrentDownloadOperation(operation)) return filenames;
        const extension = kind === 'video' ? '.mp4' : '.mp3';
        const filename = `${baseName}${extension}`;
        let output: MseCacheStandardTrackOutput | undefined;
        try {
          this.message =
            kind === 'video'
              ? `正在规范化 ${parts.length} 段缓存视频轨并无损转封装为 MP4…`
              : `正在规范化 ${parts.length} 段缓存音频轨并转码为 MP3…`;
          this.scheduleRender();
          output = await this.createStandardTrackOutput(
            operation.sessionId,
            parts.map((track) => ({
              trackId: track.id,
              mime: track.mime,
              maxBytes: track.bytes,
              firstSequence: track.firstSequence,
            })),
            `standard-${operation.id}-${kind}-${Date.now().toString(36)}`,
            kind,
          );
          standardOutputs.push(output);
          if (
            output.result.kind !== kind ||
            output.result.extension !== extension ||
            output.result.verification.sizeBytes <= 0
          ) {
            throw new MseCacheStorageError(
              `${kind === 'video' ? '视频' : '音频'}标准输出验证元数据不一致。`,
            );
          }
          await output.download(`${buildDownloadDirectory(pageUrl, kind)}/${filename}`, {
            pageUrl,
            saveAs: this.downloadSaveAs,
          });
          filenames.push(filename);
          submittedKinds.add(kind);
        } catch (error) {
          await output?.remove().catch(() => undefined);
          failures.push(
            `${kind === 'video' ? '视频 MP4' : '音频 MP3'}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (filenames.length === 0) {
        throw new MseCacheStorageError(`缓存轨道均未能生成标准文件：${failures.join('；')}`, {
          code: 'DOWNLOAD_FAILED',
        });
      }
      if (this.status === 'downloading') this.status = 'ready';
      this.error = undefined;
      const separateDirectories = [
        submittedKinds.has('video') ? displayDownloadDirectory(pageUrl, 'video') : undefined,
        submittedKinds.has('audio') ? displayDownloadDirectory(pageUrl, 'audio') : undefined,
      ].filter((value): value is string => value != null);
      const archiveHint = separateDirectories.length
        ? `文件已归档到 ${separateDirectories.join(' 或 ')}。`
        : '';
      this.message = this.clearAfterDownload
        ? `已分别提交 ${filenames.length} 个标准缓存文件；浏览器下载完成前缓存已保留。${archiveHint}${failures.length ? ` 其余轨道转换失败：${failures.join('；')}。` : ''}`
        : `已分别提交 ${filenames.length} 个标准缓存文件；可继续播放并再次保存。${archiveHint}${failures.length ? ` 其余轨道转换失败：${failures.join('；')}。` : ''}`;
      this.renderView();
      return filenames;
    } catch (error) {
      if (!this.isCurrentDownloadOperation(operation)) return filenames;
      if (this.status === 'downloading') this.status = 'error';
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (this.status === 'error') {
          this.status = previousStatus === 'ready' ? 'ready' : 'idle';
        }
        this.error = undefined;
        this.message = '已取消选择保存文件；捕获数据仍保留。';
        this.renderView();
        return [];
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.message =
        error instanceof MergeError && error.detail.canDownloadSeparately
          ? promptForMergeSave
            ? `无法安全合并：${this.error}。缓存仍保留；如果保存位置留下了未写入内容的 0 KB 文件，可以删除该文件后重试。`
            : `无法安全合并：${this.error}。缓存仍保留。`
          : `缓存文件保存失败：${this.error}`;
      this.renderView();
      throw error;
    } finally {
      await mergeOutput?.remove().catch(() => undefined);
      await Promise.all(standardOutputs.map((output) => output.remove().catch(() => undefined)));
      if (this.isCurrentDownloadOperation(operation)) {
        this.activeDownloadOperation = undefined;
        this.downloading = false;
        this.renderView();
      }
    }
  }

  handleMainMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    if (
      message.channel !== MSE_CAPTURE_CHANNEL ||
      message.direction !== 'main-to-agent' ||
      typeof message.type !== 'string'
    ) {
      return false;
    }
    if (
      (message.protocolVersion != null && message.protocolVersion !== MSE_CACHE_PROTOCOL_VERSION) ||
      (message.hookBuildId != null && message.hookBuildId !== MSE_CACHE_HOOK_BUILD_ID)
    ) {
      if (message.sessionId === this.sessionId) {
        this.requireControlledReload('页面仍运行旧版缓存捕获钩子，需要刷新一次后再从头捕获。');
        return true;
      }
      return false;
    }
    if (
      message.type === 'health' &&
      message.sessionId === this.sessionId &&
      message.health === 'reload-required'
    ) {
      this.requireControlledReload('页面缓存钩子版本已变化，需要刷新一次后继续。');
      return true;
    }
    if (message.type === 'route-reset') return this.handleMainRouteReset(message);
    if (message.sessionId !== this.sessionId || !this.messageMatchesActiveRoute(message)) {
      return false;
    }
    if (message.type === 'started' || message.type === 'resumed') {
      this.acknowledgeMainHook(message);
      return true;
    }
    if (message.type === 'binding') {
      this.updateTargetBinding(message);
      return true;
    }
    if (message.type === 'cleared') return true;
    if (
      (message.type === 'track' ||
        message.type === 'chunk' ||
        message.type === 'timeline-event' ||
        message.type === 'source-ended') &&
      !this.hookAcknowledged
    ) {
      // Compatibility with a V1 hook that predates started ACK metadata.
      this.acknowledgeMainHook(message, true);
    }
    if (message.type === 'track') {
      const trackId = this.validTrackId(message.trackId);
      const groupId = this.validTrackId(message.groupId);
      if (!trackId || !groupId) return false;
      const track = this.ensureTrack(trackId, groupId, this.validMime(message.mime));
      if (!track) return true;
      this.noteUnsafeTimeline(groupId, track, message);
      this.scheduleRender();
      return true;
    }
    if (message.type === 'timeline-event') {
      const trackId = this.validTrackId(message.trackId);
      const groupId = this.validTrackId(message.groupId);
      if (!trackId || !groupId) return false;
      const track = this.ensureTrack(trackId, groupId, this.validMime(message.mime));
      if (!track) return true;
      this.noteUnsafeTimeline(groupId, track, message);
      this.scheduleRender();
      return true;
    }
    if (message.type === 'chunk') {
      if (this.status !== 'capturing') return false;
      const trackId = this.validTrackId(message.trackId);
      const groupId = this.validTrackId(message.groupId);
      const sequence = message.sequence;
      const bytes = message.bytes;
      if (
        !trackId ||
        !groupId ||
        !Number.isInteger(sequence) ||
        Number(sequence) < 0 ||
        !(bytes instanceof ArrayBuffer) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > MSE_CACHE_MAX_CHUNK_BYTES
      ) {
        return false;
      }
      let mime = this.validMime(message.mime);
      if (mime === 'application/octet-stream') {
        mime =
          inferMseTrackMime(
            new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4 * 1024 * 1024)),
          ) ?? mime;
      }
      const track = this.ensureTrack(trackId, groupId, mime);
      if (!track) return true;
      this.noteUnsafeTimeline(groupId, track, message);
      if (Number(sequence) <= track.lastSequence) return false;

      if (this.inspectedBytes < MSE_CACHE_DRM_INSPECTION_BYTES) {
        const remaining = MSE_CACHE_DRM_INSPECTION_BYTES - this.inspectedBytes;
        const inspected = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, remaining));
        this.inspectedBytes += inspected.byteLength;
        const signal = detectMseDrmSignal(inspected);
        if (signal) {
          this.blockDrm(signal);
          return true;
        }
      }
      if (
        this.capacityBytes != null &&
        this.capturedBytes + this.pendingStorageBytes + bytes.byteLength > this.capacityBytes
      ) {
        this.status = 'error';
        this.error = `缓存已达到 ${formatMseCacheBytes(this.capacityBytes)} 上限，请先下载或清空。`;
        this.message = this.error;
        this.postControl('stop');
        this.clearCaptureTimer();
        this.renderView();
        return true;
      }
      if (this.pendingStorageBytes + bytes.byteLength > MSE_CACHE_MAX_PENDING_BYTES) {
        this.status = 'error';
        this.error = `缓存写入速度低于播放速度，等待写入的数据已达到 ${formatMseCacheBytes(MSE_CACHE_MAX_PENDING_BYTES)} 上限。`;
        this.message = `${this.error} 如需完整视频，请稍后重新开始缓存并从头播放。`;
        this.postControl('stop');
        this.clearCaptureTimer();
        this.minimized = false;
        this.renderView();
        this.requestUi('cache');
        return true;
      }
      const sessionId = this.sessionId;
      if (!sessionId) return false;
      track.lastSequence = Number(sequence);
      this.pendingStorageBytes += bytes.byteLength;
      this.enqueueStoredChunk(sessionId, track, bytes, {
        sequence: Number(sequence),
        initPresent:
          message.initialization === true ||
          containsMseInitialization(
            new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4 * 1024 * 1024)),
            mime,
          ),
        bufferedRanges: message.bufferedRanges,
        bufferedStart: message.bufferedStart,
        bufferedEnd: message.bufferedEnd,
        duration: message.duration,
      });
      // This is an inactivity watchdog rather than a fixed maximum capture length.
      // Long videos can therefore continue for hours while data is still arriving.
      this.armCaptureTimer();
      this.message = '正在将播放数据写入扩展缓存；进度仅统计已写入的数据。';
      this.scheduleRender();
      return true;
    }
    if (message.type === 'source-ended') {
      const groupId = this.validTrackId(message.groupId);
      if (groupId) {
        const state = this.ensureGroupState(groupId);
        state.sourceEnded = true;
        this.noteUnsafeTimeline(groupId, undefined, message);
      }
      const completed = groupId
        ? this.getGroupSnapshots().find((group) => group.id === groupId)?.complete === true
        : false;
      this.message =
        this.capturedBytes > 0
          ? completed
            ? `媒体源${groupId ? `（${groupId}）` : ''}已结束，已确认从头到尾完整缓存。`
            : `一个 MSE 媒体源${groupId ? `（${groupId}）` : ''}已结束；尚未确认从 0 秒完整捕获，其他播放器或轨道仍可能继续。`
          : '一个 MSE 媒体源已结束，仍在等待实际追加的数据。';
      this.renderView();
      if (groupId) this.maybeAutoDownloadCompletedGroup(groupId);
      return true;
    }
    return false;
  }

  destroy(): void {
    this.postControl('stop');
    this.invalidateDownloadOperations();
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.clearRenderTimer();
    this.resetData();
    this.view.removeEventListener('message', this.handleWindowMessage);
    this.doc.removeEventListener('encrypted', this.handleEncrypted, true);
    this.listeners.clear();
    this.uiRequestHandler = undefined;
    if (this.ownsChunkStore) {
      // resetData queued the physical session removal behind every in-flight
      // append. Do not dispose the extension host until that cleanup reaches
      // the worker, otherwise a navigation can strand the last cache session.
      void this.storageTail.then(() => this.chunkStore.dispose?.()).catch(() => undefined);
    }
    if (runtimesByDocument.get(this.doc) === this) runtimesByDocument.delete(this.doc);
  }

  private handleMainRouteReset(message: Record<string, unknown>): boolean {
    const routeKey =
      typeof message.routeKey === 'string' && message.routeKey.length > 0
        ? message.routeKey
        : undefined;
    const generation = this.validHookGeneration(message.hookGeneration);
    if (message.hookGeneration != null && generation == null) {
      return false;
    }
    if (generation != null && this.hookGeneration != null && generation < this.hookGeneration) {
      return false;
    }

    // MAIN emits route-reset immediately before started when start() supplies
    // a page URL newer than its local History signal. This is the handshake's
    // generation announcement, not an invalidation of the session being born.
    if (
      this.sessionId &&
      this.status === 'starting' &&
      routeKey === this.sessionRouteKey &&
      message.sessionId !== this.sessionId
    ) {
      if (generation != null) this.hookGeneration = generation;
      return true;
    }

    const invalidatesActiveSession =
      this.sessionId != null &&
      (message.sessionId === this.sessionId ||
        (routeKey != null && routeKey !== this.sessionRouteKey) ||
        (generation != null && this.hookGeneration != null && generation > this.hookGeneration));
    if (!invalidatesActiveSession) return true;

    this.invalidateDownloadOperations();
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.clearRenderTimer();
    this.resetData();
    this.sessionId = undefined;
    this.sessionRouteKey = routeKey;
    this.sessionPageUrl = undefined;
    this.mediaIdentity = undefined;
    this.hookGeneration = generation;
    this.hookAcknowledged = false;
    this.targetSourceUrl = undefined;
    this.boundGroupId = undefined;
    this.waitingForTarget = false;
    this.recoveryReloadRequested = false;
    this.status = 'idle';
    this.error = undefined;
    this.message = '页面媒体已切换，旧缓存会话已失效；可为当前视频重新开始捕获。';
    this.minimized = true;
    this.renderView();
    this.requestUi('launcher');
    return true;
  }

  private messageMatchesActiveRoute(message: Record<string, unknown>): boolean {
    if (
      typeof message.routeKey === 'string' &&
      this.sessionRouteKey != null &&
      message.routeKey !== this.sessionRouteKey
    ) {
      return false;
    }
    const generation = this.validHookGeneration(message.hookGeneration);
    if (message.hookGeneration != null && generation == null) return false;
    return !(
      generation != null &&
      this.hookGeneration != null &&
      generation !== this.hookGeneration
    );
  }

  private acknowledgeMainHook(message: Record<string, unknown>, legacyFallback = false): void {
    const routeKey = typeof message.routeKey === 'string' ? message.routeKey : undefined;
    const generation = this.validHookGeneration(message.hookGeneration);
    if (routeKey) this.sessionRouteKey = routeKey;
    if (generation != null) this.hookGeneration = generation;
    this.hookAcknowledged = true;
    this.clearStartAckTimer();
    this.updateTargetBinding(message, false);
    if (this.status === 'starting') {
      if (this.waitingForTarget) {
        this.status = 'starting';
        this.armTargetBindTimer();
      } else {
        this.status = 'capturing';
        this.armCaptureTimer();
      }
    }
    this.error = undefined;
    this.message = this.waitingForTarget
      ? '捕获钩子已连接，正在等待所选播放器创建 MediaSource…'
      : this.boundGroupId
        ? `已选定播放器，请从头播放以获取完整视频。`
        : legacyFallback
          ? '缓存捕获已启动（兼容模式），请从头播放视频以获得完整文件。'
          : '缓存捕获已启动，请从头播放视频以获得完整文件。';
    this.renderView();
  }

  private updateTargetBinding(message: Record<string, unknown>, render = true): void {
    const hasBindingUpdate = 'boundGroupId' in message || 'waiting' in message;
    if (!hasBindingUpdate) return;
    const boundGroupId = this.validTrackId(message.boundGroupId);
    this.boundGroupId = boundGroupId;
    this.waitingForTarget = message.waiting === true && boundGroupId == null;
    if (boundGroupId) {
      this.clearTargetBindTimer();
      if (this.status === 'starting' && this.hookAcknowledged) {
        this.status = 'capturing';
        this.armCaptureTimer();
      }
    } else if (this.waitingForTarget && this.hookAcknowledged) {
      this.armTargetBindTimer();
    }
    if (render) {
      this.message = boundGroupId
        ? `已选定播放器，正在记录播放数据。`
        : '正在等待所选播放器创建 MediaSource…';
      this.renderView();
    }
  }

  private validHookGeneration(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  private invalidateDownloadOperations(): void {
    this.operationGeneration += 1;
    this.activeDownloadOperation = undefined;
    this.downloading = false;
  }

  private isCurrentDownloadOperation(operation: CaptureDownloadOperation): boolean {
    return (
      this.activeDownloadOperation === operation &&
      operation.generation === this.operationGeneration &&
      operation.sessionId === this.sessionId
    );
  }

  private renderView(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  private requestUi(mode: MseCacheUiRequest): void {
    this.uiRequestHandler?.(mode);
  }

  private readonly handleWindowMessage = (event: MessageEvent): void => {
    if (event.source && event.source !== this.view) return;
    this.handleMainMessage(event.data);
  };

  private readonly handleEncrypted = (): void => {
    if ((this.status === 'starting' || this.status === 'capturing') && this.sessionId) {
      this.blockDrm('encrypted-event');
    }
  };

  private ensureTrack(id: string, groupId: string, mime: string): CapturedTrack | undefined {
    const existing = this.tracks.get(id);
    if (existing) {
      if (existing.mime === 'application/octet-stream' && mime !== existing.mime) {
        existing.mime = mime;
      }
      return existing;
    }
    if (this.tracks.size >= MSE_CACHE_MAX_TRACKS) {
      this.status = 'error';
      this.error = `检测到超过 ${MSE_CACHE_MAX_TRACKS} 条 MSE 轨道，已停止以避免混入其他播放器或广告。`;
      this.message = this.error;
      this.postControl('stop');
      this.clearCaptureTimer();
      this.renderView();
      return undefined;
    }
    const track: CapturedTrack = {
      id,
      groupId,
      mime,
      bytes: 0,
      pendingBytes: 0,
      initPresent: false,
      firstSequence: Number.POSITIVE_INFINITY,
      lastSequence: -1,
      bufferedRanges: [],
      unsafeTimelineReasons: new Set(this.ensureGroupState(groupId).unsafeTimelineReasons),
    };
    this.tracks.set(id, track);
    return track;
  }

  private ensureGroupState(groupId: string): CapturedGroupState {
    const existing = this.groupStates.get(groupId);
    if (existing) return existing;
    const state: CapturedGroupState = {
      sourceEnded: false,
      unsafeTimelineReasons: new Set(),
    };
    this.groupStates.set(groupId, state);
    return state;
  }

  private noteUnsafeTimeline(
    groupId: string,
    track: CapturedTrack | undefined,
    message: Record<string, unknown>,
  ): void {
    const reasons = unsafeTimelineReasonsFrom(message);
    if (reasons.length === 0) return;
    const group = this.ensureGroupState(groupId);
    for (const reason of reasons) group.unsafeTimelineReasons.add(reason);
    if (track) {
      for (const reason of reasons) track.unsafeTimelineReasons.add(reason);
    }
    // A group-level source-ended reason must also fence tracks announced before
    // that event; tracks created later inherit the group's accumulated set.
    for (const candidate of this.tracks.values()) {
      if (candidate.groupId !== groupId) continue;
      for (const reason of reasons) candidate.unsafeTimelineReasons.add(reason);
    }
  }

  private updateTrackCoverage(
    track: CapturedTrack,
    bufferedRangesValue: unknown,
    bufferedStartValue: unknown,
    bufferedEndValue: unknown,
    durationValue: unknown,
  ): void {
    const bufferedStart = this.validMediaTime(bufferedStartValue);
    const bufferedEnd = this.validMediaTime(bufferedEndValue);
    const duration = this.validMediaTime(durationValue);
    const newRanges: Array<{ start: number; end: number }> = [];
    if (Array.isArray(bufferedRangesValue) && bufferedRangesValue.length <= 64) {
      for (const range of bufferedRangesValue) {
        if (!Array.isArray(range) || range.length !== 2) continue;
        const start = this.validMediaTime(range[0]);
        const end = this.validMediaTime(range[1]);
        if (start != null && end != null && end >= start) newRanges.push({ start, end });
      }
    }
    if (newRanges.length === 0 && bufferedStart != null && bufferedEnd != null) {
      if (bufferedEnd >= bufferedStart) newRanges.push({ start: bufferedStart, end: bufferedEnd });
    }
    if (newRanges.length > 0) {
      const sorted = [...track.bufferedRanges, ...newRanges].sort(
        (left, right) => left.start - right.start || left.end - right.end,
      );
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end + 0.05) {
          previous.end = Math.max(previous.end, range.end);
        } else {
          merged.push({ ...range });
        }
      }
      track.bufferedRanges = merged;
      const first = merged[0];
      const last = merged[merged.length - 1];
      if (first && last) {
        track.bufferedStart = first.start;
        track.bufferedEnd = last.end;
      }
    }
    if (duration != null && duration > 0) track.duration = duration;
  }

  private validMediaTime(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private getGroupSnapshots(): MseCacheGroupSnapshot[] {
    return [...groupedTracks([...this.tracks.values()].filter((track) => track.bytes > 0))].map(
      ([groupId, tracks]) => {
        const starts = tracks.flatMap((track) =>
          track.bufferedStart == null ? [] : [track.bufferedStart],
        );
        const ends = tracks.flatMap((track) =>
          track.bufferedEnd == null ? [] : [track.bufferedEnd],
        );
        const durations = tracks.flatMap((track) =>
          track.duration == null ? [] : [track.duration],
        );
        // Intersection coverage is conservative: every captured track must cover the interval.
        const startSeconds = starts.length === tracks.length ? Math.max(...starts) : undefined;
        const endSeconds = ends.length === tracks.length ? Math.min(...ends) : undefined;
        const durationSeconds =
          durations.length > 0
            ? Math.max(...durations)
            : this.mediaIdentity?.duration != null &&
                Number.isFinite(this.mediaIdentity.duration) &&
                this.mediaIdentity.duration > 0
              ? this.mediaIdentity.duration
              : undefined;
        const commonRanges = commonTrackRanges(tracks);
        const cachedSeconds = continuousCoverageFromBeginning(commonRanges);
        const sourceEnded = this.groupStates.get(groupId)?.sourceEnded === true;
        const hasRequiredInitialization = tracks.every((track) => track.initPresent);
        const startsAtZero = startSeconds != null && startSeconds <= 0.25;
        const endTolerance =
          durationSeconds == null ? 0 : Math.max(0.5, Math.min(2, durationSeconds * 0.005));
        const coversDuration =
          endSeconds != null &&
          durationSeconds != null &&
          durationSeconds > 0 &&
          cachedSeconds >= durationSeconds - endTolerance;
        const hasContinuousSourceCoverage =
          sourceEnded && startsAtZero && commonRanges.length === 1 && cachedSeconds > 0;
        const unsafeTimelineReasons = [
          ...(this.groupStates.get(groupId)?.unsafeTimelineReasons ?? []),
        ];
        return {
          id: groupId,
          bytes: tracks.reduce((total, track) => total + track.bytes, 0),
          trackCount: tracks.length,
          sourceEnded,
          ...(startSeconds == null ? {} : { startSeconds }),
          ...(endSeconds == null ? {} : { endSeconds }),
          ...(durationSeconds == null ? {} : { durationSeconds }),
          cachedSeconds,
          ...(unsafeTimelineReasons.length === 0 ? {} : { unsafeTimelineReasons }),
          complete:
            this.startedAtBeginning &&
            hasRequiredInitialization &&
            startsAtZero &&
            (coversDuration || (durationSeconds == null && hasContinuousSourceCoverage)),
        };
      },
    );
  }

  private bestDownloadableGroupId(groups: readonly MseCacheGroupSnapshot[]): string | undefined {
    if (this.boundGroupId && groups.some((group) => group.id === this.boundGroupId)) {
      return this.boundGroupId;
    }
    const ranked = groups
      .map((group) => {
        const tracks = [...this.tracks.values()].filter(
          (track) => track.groupId === group.id && track.bytes > 0,
        );
        const hasVideo = tracks.some((track) => trackKind(track.mime) === 'video');
        const mergeable = mergeCandidateForGroup(tracks).candidate != null;
        return { group, hasVideo, mergeable };
      })
      .sort(
        (left, right) =>
          Number(right.hasVideo) - Number(left.hasVideo) ||
          Number(right.mergeable) - Number(left.mergeable) ||
          Number(right.group.complete) - Number(left.group.complete) ||
          right.group.bytes - left.group.bytes,
      );
    return ranked[0]?.group.id;
  }

  private validTrackId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
  }

  private validMime(value: unknown): string {
    return typeof value === 'string' && value.length <= 256 && !/[\r\n]/u.test(value)
      ? value
      : 'application/octet-stream';
  }

  private blockDrm(signal: string): void {
    this.invalidateDownloadOperations();
    this.resetData();
    this.status = 'blocked_drm';
    this.error = `检测到加密或 DRM 信号（${signal}），${APP_NAME}不会捕获、解密或下载该内容。`;
    this.message = this.error;
    this.postControl('stop');
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.minimized = false;
    this.renderView();
    this.requestUi('cache');
  }

  private resetData(): void {
    const sessionId = this.sessionId;
    this.storageGeneration += 1;
    if (sessionId) this.enqueueSessionCleanup(sessionId);
    this.tracks.clear();
    this.groupStates.clear();
    this.capturedBytes = 0;
    this.pendingStorageBytes = 0;
    this.inspectedBytes = 0;
    this.startedAtBeginning = false;
    this.storageFailure = undefined;
    this.autoDownloadedGroupIds.clear();
  }

  private enqueueStoredChunk(
    sessionId: string,
    track: CapturedTrack,
    bytes: ArrayBuffer,
    metadata: PendingChunkMetadata,
  ): void {
    const generation = this.storageGeneration;
    const byteLength = bytes.byteLength;
    track.pendingBytes += byteLength;
    const commit = (result: MseCacheAppendResult): void => {
      if (result.persistedBytes !== byteLength) {
        throw new MseCacheStorageError('部分缓存片段未能完整写入。', { code: 'STORAGE_FAILED' });
      }
      if (
        generation !== this.storageGeneration ||
        this.sessionId !== sessionId ||
        this.tracks.get(track.id) !== track
      ) {
        return;
      }
      if (track.bytes === 0) track.firstSequence = metadata.sequence;
      track.bytes += result.persistedBytes;
      track.initPresent ||= metadata.initPresent;
      this.updateTrackCoverage(
        track,
        metadata.bufferedRanges,
        metadata.bufferedStart,
        metadata.bufferedEnd,
        metadata.duration,
      );
      this.capturedBytes += result.persistedBytes;
      this.error = undefined;
      this.message = '正在捕获并写入扩展专用磁盘空间；播放越完整，缓存越完整。';
      this.scheduleRender();
      this.maybeAutoDownloadCompletedGroup(track.groupId);
    };
    const handleFailure = (error: unknown): void => {
      // Every storage callback is fenced by a physical storage generation.
      // A late error from data queued before clear() cannot poison the new run.
      if (
        generation !== this.storageGeneration ||
        this.sessionId !== sessionId ||
        this.storageFailure
      ) {
        return;
      }
      this.storageFailure =
        error instanceof Error
          ? error
          : new MseCacheStorageError('无法写入浏览器磁盘缓存。', { cause: error });
      this.status = 'error';
      this.error = this.storageFailure.message;
      this.message = cacheFailureMessage(this.error, this.capturedBytes);
      this.postControl('stop');
      this.clearCaptureTimer();
      this.minimized = false;
      this.renderView();
      this.requestUi('cache');
    };
    const completePending = (): void => {
      if (generation !== this.storageGeneration) return;
      if (this.tracks.get(track.id) === track) {
        track.pendingBytes = Math.max(0, track.pendingBytes - byteLength);
      }
      this.pendingStorageBytes = Math.max(0, this.pendingStorageBytes - byteLength);
      this.scheduleRender();
    };

    // The in-memory test/fallback store persists synchronously. Committing its
    // ACK inline preserves the runtime's long-standing synchronous snapshot
    // semantics without weakening extension-origin disk ACK accounting.
    if (this.chunkStore instanceof MemoryMseCacheChunkStore) {
      try {
        commit(this.chunkStore.append(sessionId, track.id, bytes));
      } catch (error) {
        handleFailure(error);
      } finally {
        completePending();
      }
      return;
    }

    const write = this.storageTail.then(async () => {
      if (
        generation !== this.storageGeneration ||
        this.sessionId !== sessionId ||
        this.storageFailure
      ) {
        return;
      }
      commit(await this.chunkStore.append(sessionId, track.id, bytes));
    });
    this.storageTail = write.catch(handleFailure).finally(completePending);
  }

  private enqueueSessionCleanup(sessionId: string): void {
    this.storageTail = this.storageTail
      .then(() => this.chunkStore.clearSession(sessionId))
      // Cleanup is best-effort during navigation/teardown; a future session uses
      // a different deterministic directory and cannot read this stale data.
      .catch(() => undefined);
  }

  private async storedBlob(
    sessionId: string | undefined,
    track: Pick<CapturedTrack, 'id' | 'mime' | 'bytes'>,
  ): Promise<Blob> {
    if (!sessionId) throw new MseCacheStorageError('缓存会话已结束，请重新从头捕获。');
    await this.storageTail;
    const blobMime = track.mime.split(';', 1)[0]?.trim() || 'application/octet-stream';
    return this.chunkStore.getBlob(sessionId, track.id, blobMime, track.bytes);
  }

  private maybeAutoDownloadCompletedGroup(groupId: string): void {
    if (
      !this.autoDownload ||
      this.downloading ||
      this.autoDownloadedGroupIds.has(groupId) ||
      this.shouldAutoDownload?.() !== true
    ) {
      return;
    }
    const group = this.getGroupSnapshots().find((candidate) => candidate.id === groupId);
    if (!group?.sourceEnded || !group.complete) return;
    const capturedGroupIds = new Set(
      [...this.tracks.values()].filter((track) => track.bytes > 0).map((track) => track.groupId),
    );
    if (capturedGroupIds.size !== 1 || !capturedGroupIds.has(groupId)) return;
    this.autoDownloadedGroupIds.add(groupId);
    void this.downloadCaptured(true).catch(() => this.autoDownloadedGroupIds.delete(groupId));
  }

  private clearAfterSuccessfulDownload(): void {
    if (!this.clearAfterDownload) return;
    this.resetData();
    this.postControl('clear');
    this.message = `${this.message.replace(/[。；]$/u, '')}；已按设置清理缓存。`;
  }

  private clearCaptureTimer(): void {
    if (this.captureTimer == null) return;
    this.view.clearTimeout(this.captureTimer);
    this.captureTimer = undefined;
  }

  private clearStartAckTimer(): void {
    if (this.startAckTimer == null) return;
    this.view.clearTimeout(this.startAckTimer);
    this.startAckTimer = undefined;
  }

  private clearTargetBindTimer(): void {
    if (this.targetBindTimer == null) return;
    this.view.clearTimeout(this.targetBindTimer);
    this.targetBindTimer = undefined;
  }

  private armTargetBindTimer(): void {
    this.clearTargetBindTimer();
    const sessionId = this.sessionId;
    if (!sessionId || !this.waitingForTarget || this.boundGroupId) return;
    this.targetBindTimer = this.view.setTimeout(() => {
      this.targetBindTimer = undefined;
      if (
        this.sessionId !== sessionId ||
        !this.waitingForTarget ||
        this.boundGroupId ||
        (this.status !== 'starting' && this.status !== 'paused')
      ) {
        return;
      }
      this.requireControlledReload(
        '无法关联当前播放器的 MediaSource；它可能在插件钩子连接前已创建。',
      );
    }, this.targetBindTimeoutMs);
  }

  private requireControlledReload(reason: string): void {
    if (this.status === 'reload_required' && this.recoveryReloadRequested) return;
    this.postControl('stop');
    this.invalidateDownloadOperations();
    this.clearCaptureTimer();
    this.clearStartAckTimer();
    this.clearTargetBindTimer();
    this.status = 'reload_required';
    this.error = reason;
    this.message = `${reason} 正在刷新页面，并从头重新获取播放数据。`;
    this.minimized = false;
    this.renderView();
    this.requestUi('cache');
    void this.requestControlledReloadOnce();
  }

  private async requestControlledReloadOnce(): Promise<void> {
    if (this.recoveryReloadRequested) return;
    this.recoveryReloadRequested = true;
    if (!this.requestResetAndReloadHandler) {
      this.message = `${this.error ?? '当前页面需要重新连接缓存钩子'} 请点击“删除并从头捕获”刷新后重试。`;
      this.renderView();
      return;
    }
    try {
      await this.requestResetAndReloadHandler();
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        this.message = '插件已更新，正在刷新当前视频页以重新连接…';
        this.renderView();
        this.reloadInvalidatedContextOnce();
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.error = detail;
      this.message = `无法自动刷新并恢复捕获：${detail}。请点击“删除并从头捕获”重试。`;
      this.renderView();
    }
  }

  private reloadInvalidatedContextOnce(): void {
    if (this.recoveryReloadRequested) return;
    this.recoveryReloadRequested = true;
    this.view.setTimeout(() => this.reloadPage(), 120);
  }

  private armStartAckTimer(): void {
    this.clearStartAckTimer();
    const sessionId = this.sessionId;
    if (!sessionId || this.hookAcknowledged) return;
    this.startAckTimer = this.view.setTimeout(() => {
      this.startAckTimer = undefined;
      if (
        this.sessionId !== sessionId ||
        this.hookAcknowledged ||
        (this.status !== 'starting' && this.status !== 'paused')
      ) {
        return;
      }
      this.postControl('stop');
      this.status = 'error';
      this.error = '页面缓存捕获钩子未在限定时间内确认启动，请刷新页面后重试。';
      this.message = this.error;
      this.sessionId = undefined;
      this.sessionRouteKey = undefined;
      this.sessionPageUrl = undefined;
      this.mediaIdentity = undefined;
      this.targetSourceUrl = undefined;
      this.boundGroupId = undefined;
      this.waitingForTarget = false;
      this.renderView();
    }, this.startAckTimeoutMs);
  }

  private armCaptureTimer(): void {
    this.clearCaptureTimer();
    this.captureTimer = this.view.setTimeout(() => {
      if (this.status !== 'capturing') return;
      this.status = 'error';
      this.error = '连续 5 分钟没有收到新的媒体数据，缓存捕获已安全停止。';
      this.message = this.error;
      this.postControl('stop');
      this.renderView();
    }, this.captureTimeoutMs);
  }

  private scheduleRender(): void {
    if (this.renderTimer != null) return;
    this.renderTimer = this.view.setTimeout(() => {
      this.renderTimer = undefined;
      this.renderView();
    }, 80);
  }

  private clearRenderTimer(): void {
    if (this.renderTimer == null) return;
    this.view.clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
  }

  private postControl(command: 'start' | 'pause' | 'resume' | 'stop' | 'clear'): void {
    if (!this.sessionId) return;
    this.view.postMessage(
      {
        channel: MSE_CAPTURE_CHANNEL,
        direction: 'agent-to-main',
        protocolVersion: MSE_CACHE_PROTOCOL_VERSION,
        hookBuildId: MSE_CACHE_HOOK_BUILD_ID,
        command,
        sessionId: this.sessionId,
        ...(this.sessionRouteKey ? { routeKey: this.sessionRouteKey } : {}),
        ...(command === 'start' && this.sessionPageUrl ? { pageUrl: this.sessionPageUrl } : {}),
        ...(command === 'start' && this.targetSourceUrl
          ? { targetSourceUrl: this.targetSourceUrl }
          : {}),
        ...(command === 'start' && this.mediaIdentity ? { mediaIdentity: this.mediaIdentity } : {}),
        ...(command !== 'start' && this.hookGeneration != null
          ? { hookGeneration: this.hookGeneration }
          : {}),
      },
      '*',
    );
  }
}
