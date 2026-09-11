import type {
  ActiveMediaFingerprint,
  MediaAsset,
  MediaElementInfo,
  TabMediaState,
} from '../../shared/types';
import { siteMediaRouteKey } from '../detector/site-media';

/**
 * The product matcher consumes the same player identity fields as cache capture.
 * Extra fingerprint fields (route/media epoch) may be passed without adapting them.
 */
export type MediaProductPlaybackAnchor = Omit<
  Pick<ActiveMediaFingerprint, 'frameId' | 'kind'>,
  'kind'
> &
  Partial<Pick<ActiveMediaFingerprint, 'sourceUrl' | 'duration' | 'width' | 'height' | 'title'>> & {
    kind: 'video';
  };

export interface MediaAssetTrustContext {
  pageUrl: string;
  anchor?: MediaProductPlaybackAnchor;
  duration?: number;
  frameId?: number;
}

export type MediaAssetTrustReason =
  | 'manifest'
  | 'direct-dom'
  | 'network'
  | 'performance'
  | 'known-provider'
  | 'media-extension'
  | 'media-mime'
  | 'meaningful-size'
  | 'same-frame'
  | 'source-match'
  | 'duration-match'
  | 'dimension-match'
  | 'blob-player'
  | 'wrong-page'
  | 'wrong-frame'
  | 'mime-mismatch'
  | 'duration-mismatch'
  | 'telemetry-host'
  | 'implausibly-small'
  | 'unsupported-url';

export interface MediaAssetTrustAssessment {
  score: number;
  trusted: boolean;
  rejected: boolean;
  reasons: readonly MediaAssetTrustReason[];
}

const VIDEO_EXTENSIONS = new Set([
  'avi',
  'flv',
  'm4s',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'ogv',
  'ts',
  'webm',
]);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav']);
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const PLAYLIST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const MIN_PLAUSIBLE_MEDIA_BYTES = 16;
const TRUST_THRESHOLD = 60;

function normalizedMime(value?: string): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mime || undefined;
}

function urlExtension(value: string): string | undefined {
  try {
    const last = new URL(value).pathname.split('/').pop() ?? '';
    return /\.([a-z0-9]{1,8})$/iu.exec(last)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function canonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const name of ['range', 'rn', 'rbuf']) url.searchParams.delete(name);
    return url.href;
  } catch {
    return undefined;
  }
}

function pageKey(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      const videoId =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
      if (videoId) return `youtube:${videoId}`;
    }
    if (hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com')) {
      const videoId = /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
      if (videoId) return `youtube:${videoId}`;
    }
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
      const videoId = /\/video\/(BV[0-9A-Za-z]+)/iu.exec(url.pathname)?.[1]?.toUpperCase();
      if (videoId) {
        const part = /^\d+$/u.test(url.searchParams.get('p') ?? '')
          ? String(Number(url.searchParams.get('p')))
          : '1';
        return `bilibili:${videoId}:p=${part}`;
      }
    }
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

export function providerIdentityMatchesPage(pageUrl: string, providerIdentity?: string): boolean {
  try {
    const url = new URL(pageUrl);
    const route = pageKey(pageUrl);
    if (route.startsWith('bilibili:')) {
      if (!providerIdentity?.startsWith('bilibili:')) return false;
      const [, rawBvid, rawCid = ''] = providerIdentity.split(':');
      const expectedBvid = /\/video\/(BV[0-9A-Za-z]+)/iu.exec(url.pathname)?.[1]?.toUpperCase();
      if (!expectedBvid || rawBvid?.toUpperCase() !== expectedBvid) return false;
      const expectedCid = url.searchParams.get('cid');
      return !expectedCid || expectedCid === rawCid;
    }
    if (route.startsWith('youtube:')) {
      return providerIdentity === route;
    }
    return providerIdentity == null;
  } catch {
    return false;
  }
}

function isTelemetryUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === 'data.bilibili.com' ||
      hostname.endsWith('.data.bilibili.com') ||
      hostname === 'cm.bilibili.com' ||
      hostname === 'google-analytics.com' ||
      hostname.endsWith('.google-analytics.com') ||
      hostname === 'googletagmanager.com' ||
      hostname.endsWith('.googletagmanager.com') ||
      hostname === 'doubleclick.net' ||
      hostname.endsWith('.doubleclick.net')
    );
  } catch {
    return false;
  }
}

function isKnownProviderMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      (hostname === 'bilivideo.com' || hostname.endsWith('.bilivideo.com')) &&
      /\.m4s$/iu.test(url.pathname)
    ) {
      return true;
    }
    return (
      (hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')) &&
      url.pathname === '/videoplayback' &&
      Boolean(url.searchParams.get('id') && url.searchParams.get('itag'))
    );
  } catch {
    return false;
  }
}

function durationRelation(actual?: number, expected?: number): 'unknown' | 'match' | 'mismatch' {
  if (
    actual == null ||
    expected == null ||
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    actual <= 0 ||
    expected <= 0
  ) {
    return 'unknown';
  }
  return Math.abs(actual - expected) <= Math.max(2, expected * 0.03) ? 'match' : 'mismatch';
}

function mediaMimeMatches(asset: MediaAsset, mime?: string): boolean {
  if (!mime) return true;
  if (asset.kind === 'video') return mime.startsWith('video/');
  if (asset.kind === 'audio') return mime.startsWith('audio/');
  if (asset.kind === 'image') return mime.startsWith('image/');
  return mime.includes('mpegurl') || mime.includes('dash+xml');
}

function expectedFrame(context: MediaAssetTrustContext): number | undefined {
  return context.anchor?.frameId ?? context.frameId;
}

/** Choose the page's main visible video, not a newer small ad player. */
export function selectPrimaryVideoAnchor(
  elements: readonly MediaElementInfo[],
): MediaProductPlaybackAnchor | undefined {
  const selected = elements
    .filter(
      (element) =>
        element.kind === 'video' &&
        element.visibleArea > 0 &&
        (element.duration == null || (Number.isFinite(element.duration) && element.duration > 0)),
    )
    .toSorted(
      (left, right) =>
        right.visibleArea - left.visibleArea ||
        Number(left.paused) - Number(right.paused) ||
        right.lastActiveAt - left.lastActiveAt,
    )[0];
  if (!selected) return undefined;
  return {
    frameId: selected.frameId,
    kind: 'video',
    ...(selected.sourceUrl ? { sourceUrl: selected.sourceUrl } : {}),
    ...(selected.duration == null ? {} : { duration: selected.duration }),
    ...(selected.width == null ? {} : { width: selected.width }),
    ...(selected.height == null ? {} : { height: selected.height }),
    ...(selected.title ? { title: selected.title } : {}),
  };
}

function compatibleDuration(left?: number, right?: number): boolean {
  if (left == null || right == null) return true;
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) <= Math.max(2, Math.max(left, right) * 0.03);
}

/** Re-admit a stored active identity only while its exact visible player is current. */
export function currentVideoPlaybackAnchor(
  state: Pick<TabMediaState, 'pageUrl' | 'mediaEpoch' | 'activeMedia' | 'mediaElements'>,
): MediaProductPlaybackAnchor | undefined {
  const active = state.activeMedia;
  if (
    active?.kind === 'video' &&
    active.routeKey === siteMediaRouteKey(state.pageUrl) &&
    active.mediaEpoch === (state.mediaEpoch ?? 0)
  ) {
    const exact = state.mediaElements.find(
      (element) =>
        element.kind === 'video' &&
        element.frameId === active.frameId &&
        element.elementId === active.elementId &&
        element.lifecycleGeneration === active.lifecycleGeneration &&
        element.visibleArea > 0 &&
        compatibleDuration(element.duration, active.duration),
    );
    if (exact) {
      return {
        frameId: exact.frameId,
        kind: 'video',
        ...(exact.sourceUrl ? { sourceUrl: exact.sourceUrl } : {}),
        ...(exact.duration == null ? {} : { duration: exact.duration }),
        ...(exact.width == null ? {} : { width: exact.width }),
        ...(exact.height == null ? {} : { height: exact.height }),
        ...(exact.title ? { title: exact.title } : {}),
      };
    }
  }
  return selectPrimaryVideoAnchor(state.mediaElements);
}

export function assessMediaAssetTrust(
  asset: MediaAsset,
  context: MediaAssetTrustContext,
): MediaAssetTrustAssessment {
  const reasons: MediaAssetTrustReason[] = [];
  const reject = (reason: MediaAssetTrustReason): MediaAssetTrustAssessment => ({
    score: 0,
    trusted: false,
    rejected: true,
    reasons: [...reasons, reason],
  });

  if (pageKey(asset.pageUrl) !== pageKey(context.pageUrl)) return reject('wrong-page');
  const frame = expectedFrame(context);
  if (frame != null && asset.frameId !== frame) return reject('wrong-frame');
  if (isTelemetryUrl(asset.url)) return reject('telemetry-host');
  if (
    (asset.kind === 'video' || asset.kind === 'audio') &&
    asset.size != null &&
    asset.size > 0 &&
    asset.size < MIN_PLAUSIBLE_MEDIA_BYTES
  ) {
    return reject('implausibly-small');
  }

  const mime = normalizedMime(asset.mime);
  if (!mediaMimeMatches(asset, mime)) return reject('mime-mismatch');
  const relation = durationRelation(asset.duration, context.anchor?.duration ?? context.duration);
  if (relation === 'mismatch') return reject('duration-mismatch');

  const isBlob = asset.url.startsWith('blob:');
  const isHttp = /^https?:\/\//iu.test(asset.url);
  if (!isBlob && !isHttp) return reject('unsupported-url');

  let score = 0;
  if (asset.detectedBy.includes('manifest')) {
    score += 100;
    reasons.push('manifest');
  }
  if (asset.detectedBy.includes('dom') || asset.detectedBy.includes('link')) {
    score += 40;
    reasons.push('direct-dom');
  }
  if (asset.detectedBy.includes('network')) {
    score += 5;
    reasons.push('network');
  }
  if (asset.detectedBy.includes('performance')) {
    score += 5;
    reasons.push('performance');
  }
  if (isKnownProviderMediaUrl(asset.url)) {
    score += 55;
    reasons.push('known-provider');
  }

  const suffix = urlExtension(asset.url) ?? asset.extension?.toLowerCase();
  const hasMediaExtension =
    asset.kind === 'video'
      ? Boolean(suffix && VIDEO_EXTENSIONS.has(suffix))
      : asset.kind === 'audio'
        ? Boolean(suffix && AUDIO_EXTENSIONS.has(suffix))
        : asset.kind === 'image'
          ? Boolean(suffix && IMAGE_EXTENSIONS.has(suffix))
          : Boolean(suffix && PLAYLIST_EXTENSIONS.has(suffix));
  if (hasMediaExtension) {
    score += 35;
    reasons.push('media-extension');
  }
  if (mime) {
    score += 15;
    reasons.push('media-mime');
  }
  if (asset.size != null && asset.size >= 1_024) {
    score += 10;
    reasons.push('meaningful-size');
  }
  if (frame != null && asset.frameId === frame) {
    score += 10;
    reasons.push('same-frame');
  }
  if (isBlob && (asset.kind === 'video' || asset.kind === 'audio')) {
    score += 60;
    reasons.push('blob-player');
  }

  const source = context.anchor?.sourceUrl;
  if (source && /^https?:\/\//iu.test(source) && canonicalUrl(source) === canonicalUrl(asset.url)) {
    score += 90;
    reasons.push('source-match');
  }
  if (relation === 'match') {
    score += 35;
    reasons.push('duration-match');
  }
  if (
    asset.kind === 'video' &&
    asset.width != null &&
    asset.height != null &&
    context.anchor?.width === asset.width &&
    context.anchor.height === asset.height
  ) {
    score += 15;
    reasons.push('dimension-match');
  }

  return {
    score,
    trusted: score >= TRUST_THRESHOLD,
    rejected: false,
    reasons,
  };
}

export function isTrustedMediaAssetForDisplay(
  asset: MediaAsset,
  context: MediaAssetTrustContext,
): boolean {
  return assessMediaAssetTrust(asset, context).trusted;
}
