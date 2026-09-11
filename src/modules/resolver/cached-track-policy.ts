import type { MediaAsset, TabMediaState } from '../../shared/types';

export interface CachedNetworkTrackPair {
  video: MediaAsset;
  audio: MediaAsset;
}

function isExplicitNetworkTrack(asset: MediaAsset, state: TabMediaState, frameId: number): boolean {
  return (
    asset.frameId === frameId &&
    asset.pageUrl === state.pageUrl &&
    asset.downloadable &&
    (asset.detectedBy.includes('network') || asset.detectedBy.includes('manifest')) &&
    (asset.kind === 'video' || asset.kind === 'audio') &&
    asset.mime?.toLowerCase().startsWith(`${asset.kind}/`) === true &&
    /^https?:\/\//iu.test(asset.url)
  );
}

function compareVideoQuality(left: MediaAsset, right: MediaAsset): number {
  const leftPixels = (left.width ?? 0) * (left.height ?? 0);
  const rightPixels = (right.width ?? 0) * (right.height ?? 0);
  return (
    rightPixels - leftPixels ||
    (right.height ?? 0) - (left.height ?? 0) ||
    (right.size ?? 0) - (left.size ?? 0) ||
    right.discoveredAt - left.discoveredAt
  );
}

function compareAudioQuality(left: MediaAsset, right: MediaAsset): number {
  return (right.size ?? 0) - (left.size ?? 0) || right.discoveredAt - left.discoveredAt;
}

/**
 * A page-owned manifest is authoritative about track roles, so its best visible video/audio
 * pair can be reused immediately. Raw network tracks remain conservative: without a manifest
 * or request-level stream identity, more than one representation is still ambiguous.
 */
export function selectCachedNetworkTrackPair(
  state: TabMediaState,
  frameId: number,
  excludedUrls: ReadonlySet<string> = new Set(),
): CachedNetworkTrackPair | undefined {
  const tracks = state.assets.filter(
    (asset) => !excludedUrls.has(asset.url) && isExplicitNetworkTrack(asset, state, frameId),
  );
  const manifestTracks = tracks.filter((asset) => asset.detectedBy.includes('manifest'));
  const manifestVideos = manifestTracks
    .filter((asset) => asset.kind === 'video')
    .sort(compareVideoQuality);
  const manifestAudios = manifestTracks
    .filter((asset) => asset.kind === 'audio')
    .sort(compareAudioQuality);
  if (manifestVideos[0] && manifestAudios[0]) {
    return { video: manifestVideos[0], audio: manifestAudios[0] };
  }

  const networkTracks = tracks.filter((asset) => asset.detectedBy.includes('network'));
  const videos = networkTracks.filter((asset) => asset.kind === 'video');
  const audios = networkTracks.filter((asset) => asset.kind === 'audio');
  return videos.length === 1 && audios.length === 1
    ? { video: videos[0]!, audio: audios[0]! }
    : undefined;
}
