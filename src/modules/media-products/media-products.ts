import type { BilibiliMediaRepresentation, MediaAsset } from '../../shared/types';
import { formatBytes, stableId } from '../../shared/utils';
import { compactQualityLabel } from '../../shared/quality-label';
import {
  assessMediaAssetTrust,
  providerIdentityMatchesPage,
  type MediaProductPlaybackAnchor,
} from './media-trust';

export type MediaProductProvider = 'bilibili' | 'youtube' | 'generic';

export type MediaProductVideoComposition = 'video-only' | 'muxed' | 'unknown';

export interface MediaProductPageInfo {
  pageUrl: string;
  pageTitle?: string;
  /** The active player duration, when it is known. Used to reject short ad tracks. */
  duration?: number;
  /** Limit the product to a particular document frame. */
  frameId?: number;
  /** Current main player, used as evidence rather than as a strict URL dependency. */
  anchor?: MediaProductPlaybackAnchor;
  /** Current provider-owned media identity, for example bilibili:BVID:CID. */
  providerIdentity?: string;
}

export interface MediaProductTrack {
  /** Stable for one logical representation, even when its signed mirror URL changes. */
  id: string;
  kind: 'video' | 'audio';
  label: string;
  qualityLabel: string;
  format?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  mime?: string;
  /** Meaningful only for a video track. */
  composition?: MediaProductVideoComposition;
  /** Provider stream/manifest identity used to prevent unsafe cross-stream pairing. */
  streamIdentity?: string;
  /** Preferred downloadable source for this representation. */
  asset: MediaAsset;
  /** CDN mirrors and equivalent signed URLs, with the preferred source first. */
  sources: readonly MediaAsset[];
  representation?: BilibiliMediaRepresentation;
}

export type MediaProductVideoCodec = 'AV1' | 'AVC' | 'HEVC' | 'VP9' | 'unknown';

/**
 * One user-visible quality choice. A quality can use different underlying
 * tracks for a complete download and a silent-video download, but both tracks
 * always describe the same resolution and codec family.
 */
export interface MediaProductQuality {
  /** Stable metadata-derived id. It is not a media URL or an asset id. */
  id: string;
  label: string;
  detail?: string;
  codec: MediaProductVideoCodec;
  width?: number;
  height?: number;
  qn?: number;
  codecid?: number;
  frameRate?: string;
  bandwidth?: number;
  description?: string;
  displayDescription?: string;
  superscript?: string;
  dynamicRange?: BilibiliMediaRepresentation['dynamicRange'];
  /** Four-layer provider capability snapshot for this delivered quality. */
  capabilities?: BilibiliMediaRepresentation['capabilities'];
  /** Present when the original track remains downloadable but safe merge is unavailable. */
  mergeBlockedReason?: string;
  /** Preferred track used to describe this quality in the UI. */
  displayVideoTrackId: string;
  /** Exact silent representation for this quality, when one exists. */
  videoOnlyTrackId?: string;
  /** Exact complete representation/pair for this quality, when one exists. */
  complete?: MediaProductCompleteSelection;
}

export type MediaProductCompleteSelection =
  | {
      mode: 'direct';
      videoTrackId: string;
    }
  | {
      mode: 'merge';
      videoTrackId: string;
      audioTrackId: string;
    };

export interface MediaProductDefaultSelection {
  videoTrackId?: string;
  audioTrackId?: string;
  complete?: MediaProductCompleteSelection;
}

export interface MediaProductCapabilities {
  /** A separate audio representation can be downloaded directly. */
  audioOnly: boolean;
  /** A representation known not to contain audio can be downloaded directly. */
  videoOnly: boolean;
  /** A muxed source exists, or a compatible video/audio pair can be merged. */
  complete: boolean;
}

export interface MediaProduct {
  id: string;
  provider: MediaProductProvider;
  pageUrl: string;
  title: string;
  videoTracks: readonly MediaProductTrack[];
  audioTracks: readonly MediaProductTrack[];
  /** Downloadable qualities, highest known resolution first and unknown last. */
  qualities: readonly MediaProductQuality[];
  /** Highest quality that can produce a complete video, then highest silent fallback. */
  defaultQualityId?: string;
  defaultSelection: MediaProductDefaultSelection;
  capabilities: MediaProductCapabilities;
}

interface PageIdentity {
  provider: MediaProductProvider;
  key: string;
  origin?: string;
}

interface LogicalTrackGroup {
  id: string;
  kind: 'video' | 'audio';
  assets: MediaAsset[];
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
const EXCLUDED_MIMES = new Set([
  'application/json',
  'application/xhtml+xml',
  'text/css',
  'text/html',
  'text/json',
]);

const MUXED_YOUTUBE_ITAGS = new Set([
  '17',
  '18',
  '22',
  '37',
  '38',
  '43',
  '44',
  '45',
  '46',
  '59',
  '78',
]);

function normalizedMime(mime?: string): string | undefined {
  const value = mime?.split(';', 1)[0]?.trim().toLowerCase();
  return value || undefined;
}

function extension(asset: MediaAsset): string | undefined {
  const explicit = asset.extension?.trim().toLowerCase();
  if (explicit) return explicit;
  try {
    const filename = new URL(asset.url).pathname.split('/').pop() ?? '';
    const match = /\.([a-z0-9]{1,8})$/iu.exec(filename);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathExtension(asset: MediaAsset): string | undefined {
  try {
    const match = /\.([a-z0-9]{1,8})$/iu.exec(new URL(asset.url).pathname);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function pageIdentity(pageUrl: string): PageIdentity {
  try {
    const url = new URL(pageUrl);
    const hostname = url.hostname.toLowerCase();
    const origin = url.origin;
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      const id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
      if (id) return { provider: 'youtube', key: `youtube:${id}`, origin };
    }
    if (hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com')) {
      const id = /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
      if (id) return { provider: 'youtube', key: `youtube:${id}`, origin };
    }
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
      const id = /\/video\/(BV[0-9A-Za-z]+)/iu.exec(url.pathname)?.[1]?.toUpperCase();
      if (id) {
        const part = /^\d+$/u.test(url.searchParams.get('p') ?? '')
          ? String(Number(url.searchParams.get('p')))
          : '1';
        return { provider: 'bilibili', key: `bilibili:${id}:p=${part}`, origin };
      }
    }
    return {
      provider: 'generic',
      key: `${url.origin}${url.pathname}${url.search}${url.hash}`,
      origin,
    };
  } catch {
    return { provider: 'generic', key: pageUrl };
  }
}

function belongsToPage(asset: MediaAsset, page: PageIdentity): boolean {
  const assetPage = pageIdentity(asset.pageUrl);
  if (assetPage.key === page.key) return true;
  // webRequest initiators can contain only an origin. The background normally
  // enriches them with the tab URL, but accepting the same origin here keeps the
  // pure aggregation policy useful for raw observer snapshots as well.
  return Boolean(
    page.origin &&
    assetPage.origin === page.origin &&
    assetPage.key === page.origin &&
    page.provider !== 'generic',
  );
}

function isAdvertisementUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'doubleclick.net' ||
      hostname.endsWith('.doubleclick.net') ||
      hostname === 'googleadservices.com' ||
      hostname.endsWith('.googleadservices.com') ||
      hostname === 'googlesyndication.com' ||
      hostname.endsWith('.googlesyndication.com') ||
      hostname === 'cm.bilibili.com'
    ) {
      return true;
    }
    const source = parsed.searchParams.get('source')?.toLowerCase();
    return (
      source === 'yt_ads' ||
      parsed.searchParams.has('adformat') ||
      parsed.searchParams.has('ad_type') ||
      parsed.searchParams.has('adunit') ||
      parsed.searchParams.has('vad_type')
    );
  } catch {
    return true;
  }
}

function durationMatches(asset: MediaAsset, expected?: number): boolean {
  if (
    expected == null ||
    asset.duration == null ||
    !Number.isFinite(expected) ||
    !Number.isFinite(asset.duration) ||
    expected <= 0 ||
    asset.duration <= 0
  ) {
    return true;
  }
  // DASH representations can differ by a small encoder tail. A short ad, on
  // the other hand, is normally far outside this relative/absolute tolerance.
  return Math.abs(asset.duration - expected) <= Math.max(2, expected * 0.03);
}

function isEligibleTrack(
  asset: MediaAsset,
  page: PageIdentity,
  info: MediaProductPageInfo,
): asset is MediaAsset & { kind: 'video' | 'audio' } {
  if (asset.kind !== 'video' && asset.kind !== 'audio') return false;
  if (!asset.downloadable || !/^https?:\/\//iu.test(asset.url)) return false;
  if (
    asset.representation?.provider === 'bilibili' &&
    asset.representation.capabilities?.delivered === false
  ) {
    return false;
  }
  const frameId = info.anchor?.frameId ?? info.frameId;
  if (frameId != null && asset.frameId !== frameId) return false;
  if (!belongsToPage(asset, page) || isAdvertisementUrl(asset.url)) return false;
  if (!durationMatches(asset, info.anchor?.duration ?? info.duration)) return false;
  if (!assessMediaAssetTrust(asset, info).trusted) return false;

  const mime = normalizedMime(asset.mime);
  if (mime && (EXCLUDED_MIMES.has(mime) || mime.startsWith('image/') || mime.endsWith('+json'))) {
    return false;
  }
  if (mime?.startsWith('video/')) return asset.kind === 'video';
  if (mime?.startsWith('audio/')) return asset.kind === 'audio';
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return false;

  const suffix = extension(asset);
  return asset.kind === 'video'
    ? Boolean(suffix && VIDEO_EXTENSIONS.has(suffix))
    : Boolean(suffix && AUDIO_EXTENSIONS.has(suffix));
}

function trustedProviderTracks(
  assets: readonly (MediaAsset & { kind: 'video' | 'audio' })[],
  provider: MediaProductProvider,
): Array<MediaAsset & { kind: 'video' | 'audio' }> {
  if (provider === 'generic') return [...assets];
  const result: Array<MediaAsset & { kind: 'video' | 'audio' }> = [];
  for (const kind of ['video', 'audio'] as const) {
    const tracks = assets.filter((asset) => asset.kind === kind);
    const manifestTracks = tracks.filter((asset) => asset.detectedBy.includes('manifest'));
    result.push(...(manifestTracks.length > 0 ? manifestTracks : tracks));
  }
  return result;
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

interface BilibiliProviderIdentity {
  bvid: string;
  cid: string;
}

function parseBilibiliProviderIdentity(value?: string): BilibiliProviderIdentity | undefined {
  const match = /^bilibili:(BV[0-9A-Za-z]+):(\d+)$/iu.exec(value ?? '');
  return match?.[1] && match[2] ? { bvid: match[1].toUpperCase(), cid: match[2] } : undefined;
}

/**
 * Exact Bilibili DASH resource family. The host is intentionally omitted
 * because one representation can be served by equivalent bilivideo mirrors;
 * the complete path family remains mandatory.
 */
export function bilibiliMediaResourceFamily(rawUrl: string): string | undefined {
  const url = safeUrl(rawUrl);
  if (!url) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'bilivideo.com' && !hostname.endsWith('.bilivideo.com')) return undefined;
  const match = /^(.*)-\d+\.m4s$/iu.exec(url.pathname);
  return match?.[1] ? match[1].toLowerCase() : undefined;
}

function bilibiliNativeRepresentationId(rawUrl: string): number | undefined {
  const pathname = safeUrl(rawUrl)?.pathname;
  const value = pathname ? /-(\d+)\.m4s$/iu.exec(pathname)?.[1] : undefined;
  if (!value) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Enrich a network-only DASH side only when a current provider identity and a
 * manifest representation independently prove the same BVID/CID and exact
 * resource family. No timing or CDN-domain proximity is used as ownership.
 */
export function enrichBilibiliNetworkAsset(
  asset: MediaAsset & { kind: 'video' | 'audio' },
  authoritativeAssets: readonly MediaAsset[],
  pageUrl: string,
  providerIdentity?: string,
): (MediaAsset & { kind: 'video' | 'audio' }) | undefined {
  if (!asset.detectedBy.includes('network') || asset.representation) {
    return undefined;
  }
  const identity = parseBilibiliProviderIdentity(providerIdentity);
  if (!identity || !providerIdentityMatchesPage(pageUrl, providerIdentity)) return undefined;
  const family = bilibiliMediaResourceFamily(asset.url);
  if (!family) return undefined;
  const authoritative = authoritativeAssets.find((candidate) => {
    const representation = candidate.representation;
    return (
      candidate.detectedBy.some((source) => source !== 'network') &&
      representation?.provider === 'bilibili' &&
      representation.bvid?.toUpperCase() === identity.bvid &&
      representation.cid === identity.cid &&
      bilibiliMediaResourceFamily(candidate.url) === family
    );
  });
  if (!authoritative) return undefined;
  const id = bilibiliNativeRepresentationId(asset.url);
  const codecs = /codecs\s*=\s*"?([^";]+)/iu.exec(asset.mime ?? '')?.[1]?.trim();
  const codecProfile = codecs?.split(',')[0]?.trim();
  const representation: BilibiliMediaRepresentation = {
    provider: 'bilibili',
    bvid: identity.bvid,
    cid: identity.cid,
    key: `bilibili:${asset.kind}:${identity.bvid}:${identity.cid}:${id ?? stableId(asset.url)}`,
    delivery: 'dash',
    ...(id == null ? {} : { id }),
    ...(codecs ? { codecs } : {}),
    ...(codecProfile ? { codecProfile } : {}),
    capabilities: {
      advertised: false,
      delivered: true,
      decodable: 'unknown',
      remuxable: 'unknown',
    },
    ...(asset.kind === 'audio' ? { audioType: 'unknown' as const } : {}),
  };
  return { ...asset, representation };
}

function youtubeRepresentationIdentity(asset: MediaAsset): string | undefined {
  const url = safeUrl(asset.url);
  if (!url || !url.hostname.toLowerCase().endsWith('googlevideo.com')) return undefined;
  const itag = url.searchParams.get('itag');
  if (!itag) return undefined;
  const streamId = url.searchParams.get('id') ?? '';
  return `youtube:${streamId}:${itag}`;
}

function bilibiliRepresentationIdentity(asset: MediaAsset): string | undefined {
  if (asset.representation?.provider === 'bilibili') {
    return asset.representation.key;
  }
  const url = safeUrl(asset.url);
  if (!url) return undefined;
  const filename = url.pathname.split('/').pop()?.toLowerCase();
  return filename ? `bilibili:${filename}` : undefined;
}

function mimeWithCodecs(asset: MediaAsset): string {
  return asset.mime?.trim().toLowerCase() ?? '';
}

function normalizedDuration(value?: number): string {
  return value != null && Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '';
}

function logicalTrackIdentity(asset: MediaAsset, provider: MediaProductProvider): string {
  const providerIdentity =
    provider === 'youtube'
      ? youtubeRepresentationIdentity(asset)
      : provider === 'bilibili'
        ? bilibiliRepresentationIdentity(asset)
        : undefined;
  if (providerIdentity) return `${asset.kind}:${providerIdentity}`;

  const url = safeUrl(asset.url);
  if (url) {
    for (const name of ['range', 'rn', 'rbuf']) url.searchParams.delete(name);
    url.hash = '';
  }
  const metadata = [
    asset.width ?? '',
    asset.height ?? '',
    normalizedDuration(asset.duration),
    asset.size ?? '',
    mimeWithCodecs(asset),
  ].join(':');
  return `${asset.kind}:${url?.href ?? asset.url}:${metadata}`;
}

function bilibiliStreamIdentity(asset: MediaAsset): string | undefined {
  if (asset.representation?.bvid) {
    return `bilibili:${asset.representation.bvid}:${asset.representation.cid ?? ''}`;
  }
  const filename = safeUrl(asset.url)?.pathname.split('/').pop()?.toLowerCase();
  if (!filename) return undefined;
  // Bilibili's final DASH representation component is not fixed-width. Audio
  // ids such as 30216/30280 commonly use five digits, while video ids can be
  // short quality ids (for example 80) or six-digit codec/quality ids such as
  // 100145. The preceding filename family identifies the owning media item and
  // remains stable across the matching audio/video representations and mirrors.
  const match = /^(.*)-\d+\.m4s$/u.exec(filename);
  const family = match?.[1];
  return family ? `bilibili:${family}` : undefined;
}

function trackStreamIdentity(
  asset: MediaAsset,
  provider: MediaProductProvider,
  pageKey: string,
): string | undefined {
  if (provider === 'youtube') {
    const url = safeUrl(asset.url);
    const streamId = url?.searchParams.get('id');
    if (streamId) return `youtube:${streamId}`;
  }
  if (provider === 'bilibili') {
    const identity = bilibiliStreamIdentity(asset);
    if (identity) return identity;
  }
  // Provider stream identities take precedence over provenance. This keeps a
  // manifest-discovered video compatible with its later network-discovered
  // audio track (and vice versa) without weakening the same-stream check.
  if (asset.detectedBy.includes('manifest')) return `${provider}:manifest:${pageKey}`;
  if (asset.duration != null && Number.isFinite(asset.duration)) {
    const origin = safeUrl(asset.url)?.origin;
    return origin ? `generic:${origin}:${normalizedDuration(asset.duration)}` : undefined;
  }
  return undefined;
}

function sourcePreference(left: MediaAsset, right: MediaAsset): number {
  const score = (asset: MediaAsset): number =>
    (asset.detectedBy.includes('manifest') ? 8 : 0) +
    (asset.detectedBy.includes('network') ? 4 : 0) +
    (asset.requestHeaders ? 2 : 0) +
    (asset.size != null ? 1 : 0);
  return (
    (left.representation?.sourceIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.representation?.sourceIndex ?? Number.MAX_SAFE_INTEGER) ||
    score(right) - score(left) ||
    (right.lastObservedAt ?? right.discoveredAt) - (left.lastObservedAt ?? left.discoveredAt) ||
    left.url.localeCompare(right.url)
  );
}

function groupLogicalTracks(
  assets: readonly (MediaAsset & { kind: 'video' | 'audio' })[],
  provider: MediaProductProvider,
): LogicalTrackGroup[] {
  const groups = new Map<string, LogicalTrackGroup>();
  for (const asset of assets) {
    const identity = logicalTrackIdentity(asset, provider);
    const existing = groups.get(identity);
    if (existing) existing.assets.push(asset);
    else {
      groups.set(identity, {
        id: `track-${stableId(identity)}`,
        kind: asset.kind,
        assets: [asset],
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    assets: group.assets.sort(sourcePreference),
  }));
}

function codecList(asset: MediaAsset): string[] {
  const match = /codecs\s*=\s*["']?([^"';]+)/iu.exec(asset.mime ?? '');
  return (asset.representation?.codecs ?? match?.[1] ?? '')
    .split(',')
    .map((codec) => codec.trim().toLowerCase())
    .filter(Boolean);
}

function videoCodec(asset: MediaAsset): MediaProductVideoCodec {
  const codecs = codecList(asset);
  if (codecs.some((codec) => /^(?:av01)(?:\.|$)/u.test(codec))) return 'AV1';
  if (codecs.some((codec) => /^(?:avc1|avc3)(?:\.|$)/u.test(codec))) return 'AVC';
  if (codecs.some((codec) => /^(?:dvh1|dvhe|hev1|hvc1)(?:\.|$)/u.test(codec))) return 'HEVC';
  if (codecs.some((codec) => /^(?:vp09|vp9)(?:\.|$)/u.test(codec))) return 'VP9';
  if (asset.representation?.codecid === 7) return 'AVC';
  if (asset.representation?.codecid === 12) return 'HEVC';
  if (asset.representation?.codecid === 13) return 'AV1';
  return 'unknown';
}

function hasAudioCodec(asset: MediaAsset): boolean {
  return codecList(asset).some((codec) =>
    /^(?:ac-3|alac|ec-3|flac|mp4a|opus|vorbis)(?:\.|$)/u.test(codec),
  );
}

function youtubeItag(asset: MediaAsset): string | undefined {
  return safeUrl(asset.url)?.searchParams.get('itag') ?? undefined;
}

function videoComposition(
  asset: MediaAsset,
  provider: MediaProductProvider,
): MediaProductVideoComposition {
  if (hasAudioCodec(asset)) return 'muxed';
  if (provider === 'bilibili' || pathExtension(asset) === 'm4s') return 'video-only';
  if (provider === 'youtube') {
    const itag = youtubeItag(asset);
    return itag && MUXED_YOUTUBE_ITAGS.has(itag) ? 'muxed' : 'video-only';
  }
  if (codecList(asset).length > 0) return 'video-only';
  return 'unknown';
}

function mediaFormat(asset: MediaAsset): string | undefined {
  const mime = normalizedMime(asset.mime);
  if (mime) {
    const subtype = mime.split('/')[1];
    if (subtype) return subtype.replace(/^x-/u, '').toUpperCase();
  }
  return extension(asset)?.toUpperCase();
}

function createTrack(
  group: LogicalTrackGroup,
  provider: MediaProductProvider,
  pageKey: string,
): MediaProductTrack {
  const asset = group.assets[0]!;
  const streamIdentity = trackStreamIdentity(asset, provider, pageKey);
  const format = mediaFormat(asset);
  const resolution =
    asset.width != null && asset.height != null ? `${asset.width}×${asset.height}` : undefined;
  const representation = asset.representation;
  const officialName =
    representation?.newDescription ??
    representation?.description ??
    representation?.displayDescription;
  const audioType = representation?.audioType;
  const qualityLabel =
    group.kind === 'video'
      ? (officialName ?? resolution ?? (format ? `${format} 视频` : '未知画质'))
      : [
          audioType && audioType !== 'unknown' ? audioType : (format ?? '未知音频'),
          asset.size == null ? undefined : formatBytes(asset.size),
        ]
          .filter(Boolean)
          .join(' · ');
  const label = [qualityLabel, asset.duration == null ? undefined : `${asset.duration.toFixed(1)}s`]
    .filter(Boolean)
    .join(' · ');
  return {
    id: group.id,
    kind: group.kind,
    label,
    qualityLabel,
    ...(format ? { format } : {}),
    ...(resolution ? { resolution } : {}),
    ...(asset.width == null ? {} : { width: asset.width }),
    ...(asset.height == null ? {} : { height: asset.height }),
    ...(asset.duration == null ? {} : { duration: asset.duration }),
    ...(asset.size == null ? {} : { size: asset.size }),
    ...(asset.mime ? { mime: asset.mime } : {}),
    ...(group.kind === 'video' ? { composition: videoComposition(asset, provider) } : {}),
    ...(streamIdentity ? { streamIdentity } : {}),
    ...(representation ? { representation: { ...representation } } : {}),
    asset,
    sources: group.assets,
  };
}

function compareVideoTracks(left: MediaProductTrack, right: MediaProductTrack): number {
  const leftPixels = (left.width ?? 0) * (left.height ?? 0);
  const rightPixels = (right.width ?? 0) * (right.height ?? 0);
  return (
    rightPixels - leftPixels ||
    Math.max(right.width ?? 0, right.height ?? 0) - Math.max(left.width ?? 0, left.height ?? 0) ||
    (right.representation?.qn ?? 0) - (left.representation?.qn ?? 0) ||
    (right.representation?.bandwidth ?? 0) - (left.representation?.bandwidth ?? 0) ||
    (right.size ?? 0) - (left.size ?? 0) ||
    right.asset.discoveredAt - left.asset.discoveredAt ||
    left.id.localeCompare(right.id)
  );
}

function compareAudioTracks(left: MediaProductTrack, right: MediaProductTrack): number {
  const audioRank = (track: MediaProductTrack): number => {
    switch (track.representation?.audioType) {
      case 'FLAC':
        return 3;
      case 'Dolby':
        return 2;
      case 'AAC':
        return 1;
      default:
        return 0;
    }
  };
  return (
    audioRank(right) - audioRank(left) ||
    (right.representation?.bandwidth ?? 0) - (left.representation?.bandwidth ?? 0) ||
    (right.size ?? 0) - (left.size ?? 0) ||
    right.asset.discoveredAt - left.asset.discoveredAt ||
    left.id.localeCompare(right.id)
  );
}

function compatibleAudioTracks(audioTracks: readonly MediaProductTrack[]): MediaProductTrack[] {
  const compatibilityRank = (track: MediaProductTrack): number => {
    switch (track.representation?.audioType) {
      case 'AAC':
        return 4;
      case undefined:
      case 'unknown':
        return 3;
      case 'Dolby':
        return 2;
      case 'FLAC':
        return 1;
    }
  };
  return [...audioTracks].sort(
    (left, right) =>
      compatibilityRank(right) - compatibilityRank(left) || compareAudioTracks(left, right),
  );
}

function videoCompatibilityRank(track?: MediaProductTrack): number {
  if (!track) return 0;
  const codecRank: Record<MediaProductVideoCodec, number> = {
    AVC: 5,
    HEVC: 4,
    VP9: 3,
    AV1: 2,
    unknown: 1,
  };
  const range = track.representation?.dynamicRange;
  const rangeRank = range === 'SDR' || range == null ? 3 : range === 'unknown' ? 2 : 1;
  const rateExpression = track.representation?.frameRate;
  const [numeratorValue, denominatorValue] = rateExpression?.split('/') ?? [];
  const numerator = Number(numeratorValue);
  const denominator = denominatorValue == null ? 1 : Number(denominatorValue);
  const rate =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? numerator / denominator
      : undefined;
  const frameRateRank = rate == null ? 2 : rate <= 30.1 ? 3 : rate <= 60.1 ? 2 : 1;
  return rangeRank * 100 + codecRank[videoCodec(track.asset)] * 10 + frameRateRank;
}

function compareCompleteVideoQuality(left: MediaProductTrack, right: MediaProductTrack): number {
  const quality = compareVideoTracks(left, right);
  if (quality !== 0) return quality;
  // At equal quality, an already muxed file avoids unnecessary processing.
  return left.composition === 'muxed' ? -1 : right.composition === 'muxed' ? 1 : 0;
}

function completeSelectionForVideo(
  video: MediaProductTrack,
  audioTracks: readonly MediaProductTrack[],
): MediaProductCompleteSelection | undefined {
  if (video.composition === 'muxed') return { mode: 'direct', videoTrackId: video.id };
  if (video.composition !== 'video-only' || video.streamIdentity == null) return undefined;
  if (!bilibiliTrackCanBeSafelyRemuxed(video)) return undefined;
  const isDolbyVision = video.representation?.dynamicRange === 'Dolby Vision';
  const audio = compatibleAudioTracks(audioTracks).find(
    (candidate) =>
      candidate.streamIdentity === video.streamIdentity &&
      (!isDolbyVision || candidate.representation?.audioType === 'AAC'),
  );
  return audio ? { mode: 'merge', videoTrackId: video.id, audioTrackId: audio.id } : undefined;
}

function bilibiliTrackCanBeSafelyRemuxed(track: MediaProductTrack): boolean {
  const representation = track.representation;
  if (representation?.provider !== 'bilibili') return true;
  const range = representation.dynamicRange;
  const hasConflict = representation.dynamicRangeEvidence?.some(
    (item) => item.source === 'conflict',
  );
  if (hasConflict) return false;
  // HDR and the deliberately narrow Dolby Vision candidate range remain
  // provisional here. The merge worker admits them only after inspecting the
  // complete local source and publishes only after packet/metadata proof.
  if (range === 'HDR') return true;
  if (range === 'Dolby Vision') {
    const profile = representation.dolbyVisionProfile;
    // Bilibili commonly declares an actually delivered Dolby Vision stream as
    // qn=126 while omitting dvh1/dvhe profile details from the page manifest.
    // Admit that one bounded candidate to complete-file staging; the worker
    // still requires the local dvcC/dvvC/dvwC to prove Profile 5/8 before it
    // can publish anything. An explicitly known unsupported profile stays out.
    const supportedProfileCandidate =
      profile === 5 || profile === 8 || (profile == null && representation.qn === 126);
    return (
      representation.capabilities?.delivered === true &&
      representation.capabilities.remuxable !== 'unsupported' &&
      supportedProfileCandidate
    );
  }
  return true;
}

function mergeBlockedReason(track: MediaProductTrack): string | undefined {
  if (bilibiliTrackCanBeSafelyRemuxed(track)) return undefined;
  const range = track.representation?.dynamicRange;
  return range === 'Dolby Vision'
    ? '仅支持已实际下发的单层 Dolby Vision Profile 5/8 与 AAC 音轨；其他情况请分别保存。'
    : range === 'HDR'
      ? '当前媒体引擎不能证明 HDR 元数据在合并后完整保留，请分别保存。'
      : '视频色彩范围信息不一致，无法合并。';
}

function completeSelection(
  videoTracks: readonly MediaProductTrack[],
  audioTracks: readonly MediaProductTrack[],
): MediaProductCompleteSelection | undefined {
  const candidates = videoTracks
    .filter((track) => completeSelectionForVideo(track, audioTracks) != null)
    .sort((left, right) => {
      const leftPixels = (left.width ?? 0) * (left.height ?? 0);
      const rightPixels = (right.width ?? 0) * (right.height ?? 0);
      return (
        rightPixels - leftPixels ||
        Math.max(right.width ?? 0, right.height ?? 0) -
          Math.max(left.width ?? 0, left.height ?? 0) ||
        videoCompatibilityRank(right) - videoCompatibilityRank(left) ||
        (right.representation?.qn ?? 0) - (left.representation?.qn ?? 0) ||
        compareCompleteVideoQuality(left, right)
      );
    });
  const video = candidates[0];
  if (!video) return undefined;
  return completeSelectionForVideo(video, audioTracks);
}

function qualityHeightLabel(width?: number, height?: number): string {
  if (width == null || height == null || width <= 0 || height <= 0) return '未知画质';
  const shortSide = Math.min(width, height);
  if (shortSide >= 2160) return '4K';
  if (shortSide >= 1440) return '1440P';
  if (shortSide >= 1080) return '1080P';
  if (shortSide >= 720) return '720P';
  if (shortSide >= 480) return '480P';
  if (shortSide >= 360) return '360P';
  return `${shortSide}P`;
}

function qualityKey(track: MediaProductTrack): string {
  if (track.representation?.provider === 'bilibili') return track.representation.key;
  const codec = videoCodec(track.asset);
  const dimensions =
    track.width != null && track.height != null
      ? `${Math.max(track.width, track.height)}x${Math.min(track.width, track.height)}`
      : 'unknown';
  return `${dimensions}:${codec}`;
}

function createQualities(
  videoTracks: readonly MediaProductTrack[],
  audioTracks: readonly MediaProductTrack[],
): MediaProductQuality[] {
  const groups = new Map<string, MediaProductTrack[]>();
  for (const track of videoTracks) {
    // Unknown-composition tracks cannot safely satisfy either advertised video output.
    if (track.composition !== 'video-only' && track.composition !== 'muxed') continue;
    if (track.representation?.provider === 'bilibili' && track.representation.delivery !== 'dash') {
      continue;
    }
    const key = qualityKey(track);
    const existing = groups.get(key);
    if (existing) existing.push(track);
    else groups.set(key, [track]);
  }

  return [...groups.entries()]
    .map(([key, tracks]): MediaProductQuality | undefined => {
      const completeCandidates = tracks
        .filter((track) => completeSelectionForVideo(track, audioTracks) != null)
        .sort(compareCompleteVideoQuality);
      const completeVideo = completeCandidates[0];
      const videoOnly = tracks.find((track) => track.composition === 'video-only');
      const display = completeVideo ?? videoOnly;
      if (!display) return undefined;
      const codec = videoCodec(display.asset);
      const representation = display.representation;
      const qualityName =
        representation?.newDescription ??
        representation?.description ??
        representation?.displayDescription ??
        qualityHeightLabel(display.width, display.height);
      const codecLabel = codec === 'unknown' ? undefined : codec;
      const dimensions =
        display.width != null && display.height != null
          ? `${display.width}×${display.height}`
          : undefined;
      const complete = completeVideo
        ? completeSelectionForVideo(completeVideo, audioTracks)
        : undefined;
      const blockedReason = mergeBlockedReason(display);
      return {
        id: `quality-${stableId(key)}`,
        label: compactQualityLabel(qualityName, codecLabel, representation?.superscript),
        ...([
          dimensions,
          representation?.frameRate ? `${representation.frameRate} fps` : undefined,
          representation?.dynamicRange && representation.dynamicRange !== 'SDR'
            ? representation.dynamicRange
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
          ? {
              detail: [
                dimensions,
                representation?.frameRate ? `${representation.frameRate} fps` : undefined,
                representation?.dynamicRange && representation.dynamicRange !== 'SDR'
                  ? representation.dynamicRange
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · '),
            }
          : {}),
        codec,
        ...(display.width == null ? {} : { width: display.width }),
        ...(display.height == null ? {} : { height: display.height }),
        ...(representation?.qn == null ? {} : { qn: representation.qn }),
        ...(representation?.codecid == null ? {} : { codecid: representation.codecid }),
        ...(representation?.frameRate ? { frameRate: representation.frameRate } : {}),
        ...(representation?.bandwidth == null ? {} : { bandwidth: representation.bandwidth }),
        ...(representation?.description ? { description: representation.description } : {}),
        ...(representation?.displayDescription
          ? { displayDescription: representation.displayDescription }
          : {}),
        ...(representation?.superscript ? { superscript: representation.superscript } : {}),
        ...(representation?.dynamicRange ? { dynamicRange: representation.dynamicRange } : {}),
        ...(representation?.capabilities
          ? { capabilities: { ...representation.capabilities } }
          : {}),
        ...(blockedReason ? { mergeBlockedReason: blockedReason } : {}),
        displayVideoTrackId: display.id,
        ...(videoOnly ? { videoOnlyTrackId: videoOnly.id } : {}),
        ...(complete ? { complete } : {}),
      };
    })
    .filter((quality): quality is MediaProductQuality => quality != null)
    .sort((left, right) => {
      const leftKnown = left.width != null && left.height != null;
      const rightKnown = right.width != null && right.height != null;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      const leftPixels = (left.width ?? 0) * (left.height ?? 0);
      const rightPixels = (right.width ?? 0) * (right.height ?? 0);
      return (
        rightPixels - leftPixels ||
        Math.max(right.width ?? 0, right.height ?? 0) -
          Math.max(left.width ?? 0, left.height ?? 0) ||
        (right.qn ?? 0) - (left.qn ?? 0) ||
        left.label.localeCompare(right.label)
      );
    });
}

/**
 * Aggregate raw discoveries into the single finished-media product represented by
 * the current page. The function is deterministic and never mutates its inputs.
 */
export function buildMediaProducts(
  assets: readonly MediaAsset[],
  info: MediaProductPageInfo,
): MediaProduct[] {
  const page = pageIdentity(info.pageUrl);
  const currentBilibiliIdentity = parseBilibiliProviderIdentity(info.providerIdentity);
  const initialEligible = assets
    .filter((asset) => isEligibleTrack(asset, page, info))
    .filter((asset) => {
      const representation = asset.representation;
      if (!currentBilibiliIdentity || representation?.provider !== 'bilibili') return true;
      return (
        representation.bvid?.toUpperCase() === currentBilibiliIdentity.bvid &&
        representation.cid === currentBilibiliIdentity.cid
      );
    });
  const eligible =
    page.provider === 'bilibili'
      ? initialEligible.map(
          (asset) =>
            enrichBilibiliNetworkAsset(
              asset,
              initialEligible,
              info.pageUrl,
              info.providerIdentity,
            ) ?? asset,
        )
      : initialEligible;
  const trusted = trustedProviderTracks(eligible, page.provider);
  const groups = groupLogicalTracks(trusted, page.provider);
  const videoTracks = groups
    .filter((group) => group.kind === 'video')
    .map((group) => createTrack(group, page.provider, page.key))
    .sort(compareVideoTracks);
  const audioTracks = groups
    .filter((group) => group.kind === 'audio')
    .map((group) => createTrack(group, page.provider, page.key))
    .sort(compareAudioTracks);

  if (videoTracks.length === 0 && audioTracks.length === 0) return [];
  const complete = completeSelection(videoTracks, audioTracks);
  const qualities = createQualities(videoTracks, audioTracks);
  const availableQualities = qualities.filter(
    (quality) => quality.complete != null || quality.videoOnlyTrackId != null,
  );
  const hasBilibiliRepresentations = videoTracks.some(
    (track) => track.representation?.provider === 'bilibili',
  );
  const defaultQuality = hasBilibiliRepresentations
    ? (() => {
        const broadlyCompatible = availableQualities.filter((quality) => {
          if (quality.codec !== 'AVC' || quality.dynamicRange !== 'SDR') return false;
          return quality.complete != null || quality.videoOnlyTrackId != null;
        });
        return [...(broadlyCompatible.length > 0 ? broadlyCompatible : availableQualities)].sort(
          (left, right) => {
            const leftComplete = left.complete != null;
            const rightComplete = right.complete != null;
            if (leftComplete !== rightComplete) return rightComplete ? 1 : -1;
            const leftPixels = (left.width ?? 0) * (left.height ?? 0);
            const rightPixels = (right.width ?? 0) * (right.height ?? 0);
            return (
              rightPixels - leftPixels ||
              videoCompatibilityRank(
                videoTracks.find((track) => track.id === right.displayVideoTrackId),
              ) -
                videoCompatibilityRank(
                  videoTracks.find((track) => track.id === left.displayVideoTrackId),
                ) ||
              (right.qn ?? 0) - (left.qn ?? 0)
            );
          },
        )[0];
      })()
    : availableQualities[0];
  const defaultVideoOnly =
    videoTracks.find((track) => track.id === defaultQuality?.videoOnlyTrackId) ??
    videoTracks.find((track) => track.composition === 'video-only');
  const defaultComplete = defaultQuality?.complete ?? complete;
  const title =
    info.pageTitle?.trim() ||
    videoTracks[0]?.asset.pageTitle.trim() ||
    audioTracks[0]?.asset.pageTitle.trim() ||
    '当前视频';
  return [
    {
      id: `product-${stableId(page.key)}`,
      provider: page.provider,
      pageUrl: info.pageUrl,
      title,
      videoTracks,
      audioTracks,
      qualities,
      ...(defaultQuality ? { defaultQualityId: defaultQuality.id } : {}),
      defaultSelection: {
        ...(defaultVideoOnly ? { videoTrackId: defaultVideoOnly.id } : {}),
        ...(audioTracks[0] ? { audioTrackId: audioTracks[0].id } : {}),
        ...(defaultComplete ? { complete: defaultComplete } : {}),
      },
      capabilities: {
        audioOnly: audioTracks.length > 0,
        videoOnly: videoTracks.some((track) => track.composition === 'video-only'),
        complete: complete != null,
      },
    },
  ];
}
