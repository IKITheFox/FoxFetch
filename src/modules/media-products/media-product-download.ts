import { sameActiveMediaIdentity } from '../playback/playback-manager';
import type {
  ActiveMediaFingerprint,
  MediaAsset,
  MediaProductDownloadMode,
  TabMediaState,
} from '../../shared/types';
import { buildMediaProducts, type MediaProduct, type MediaProductTrack } from './media-products';
import {
  currentVideoPlaybackAnchor,
  providerIdentityMatchesPage,
  type MediaProductPlaybackAnchor,
} from './media-trust';

export interface MediaProductDownloadIntent {
  productId: string;
  mode: MediaProductDownloadMode;
  videoAssetId: string;
  audioAssetId?: string;
  /** Exact logical video representation selected by the trusted UI. */
  videoTrackId?: string;
  /** Optional metadata-only quality binding from a trusted extension UI. */
  qualityId?: string;
  /** Reserved for a background-issued opaque page-Dock capability. */
  qualityToken?: string;
  expectedMedia?: ActiveMediaFingerprint;
}

export interface ValidatedMediaProductDownload {
  product: MediaProduct;
  video: MediaAsset;
  audio?: MediaAsset;
  /** Logical tracks retain every current mirror for resolver fallback. */
  videoTrack: MediaProductTrack;
  audioTrack?: MediaProductTrack;
}

function currentPlaybackAnchor(state: TabMediaState): MediaProductPlaybackAnchor | undefined {
  return currentVideoPlaybackAnchor(state);
}

function productTrackForAsset(
  tracks: readonly MediaProductTrack[],
  assetId: string,
): MediaProductTrack | undefined {
  return tracks.find((track) => track.sources.some((source) => source.id === assetId));
}

function exactCurrentAsset(track: MediaProductTrack | undefined, assetId: string): MediaAsset {
  const asset = track?.sources.find((source) => source.id === assetId);
  if (!asset?.downloadable) {
    throw new Error('成品视频已变化，列表正在自动更新');
  }
  return asset;
}

/**
 * Rebuild and validate a finished-media selection at the download boundary.
 * UI-provided asset ids are hints only; the current tab state remains authoritative.
 */
export function validateMediaProductDownload(
  state: TabMediaState,
  intent: MediaProductDownloadIntent,
): ValidatedMediaProductDownload {
  if (
    intent.expectedMedia &&
    !sameActiveMediaIdentity(intent.expectedMedia, state.activeMedia, true)
  ) {
    throw new Error('播放器已切换，成品视频列表正在自动更新');
  }

  const anchor = currentPlaybackAnchor(state);
  const assets = state.assets.filter(
    (asset) =>
      !asset.detectedBy.includes('manifest') ||
      state.providerIdentity == null ||
      providerIdentityMatchesPage(state.pageUrl, state.providerIdentity),
  );
  const product = buildMediaProducts(assets, {
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
    ...(anchor ? { anchor } : {}),
  }).find((candidate) => candidate.id === intent.productId);
  if (!product) throw new Error('成品视频已变化，列表正在自动更新');

  const quality = intent.qualityId
    ? product.qualities.find((candidate) => candidate.id === intent.qualityId)
    : undefined;
  if (intent.qualityId && !quality) {
    throw new Error('所选清晰度已变化，列表正在自动更新');
  }
  if (intent.mode === 'complete') {
    const videoTrack = productTrackForAsset(product.videoTracks, intent.videoAssetId);
    const selectedComplete = quality?.complete;
    if (
      !videoTrack ||
      (intent.videoTrackId != null && intent.videoTrackId !== videoTrack.id) ||
      (quality && selectedComplete?.videoTrackId !== videoTrack.id) ||
      (videoTrack.composition !== 'muxed' && videoTrack.composition !== 'video-only')
    ) {
      throw new Error('尚未识别到可安全配对的完整视频');
    }
    const video = exactCurrentAsset(videoTrack, intent.videoAssetId);
    if (videoTrack.composition === 'muxed') {
      if (intent.audioAssetId) throw new Error('当前完整视频不需要额外音轨');
      return { product, video, videoTrack };
    }
    const audioTrack = intent.audioAssetId
      ? productTrackForAsset(product.audioTracks, intent.audioAssetId)
      : undefined;
    const audio = intent.audioAssetId
      ? exactCurrentAsset(audioTrack, intent.audioAssetId)
      : undefined;
    if (
      !audio ||
      videoTrack?.streamIdentity == null ||
      videoTrack.streamIdentity !== audioTrack?.streamIdentity
    ) {
      throw new Error('当前音视频轨不属于同一媒体流，已拒绝合并');
    }
    const admittedPair =
      selectedComplete ??
      product.qualities.find((candidate) => candidate.complete?.videoTrackId === videoTrack.id)
        ?.complete ??
      product.defaultSelection.complete;
    if (
      admittedPair?.mode !== 'merge' ||
      admittedPair.videoTrackId !== videoTrack.id ||
      admittedPair.audioTrackId !== audioTrack.id
    ) {
      throw new Error('所选音视频组合未通过当前清晰度的安全配对检查，已拒绝合并');
    }
    return { product, video, audio, videoTrack, audioTrack };
  }

  if (intent.mode === 'video-only') {
    if (!product.capabilities.videoOnly || intent.audioAssetId) {
      throw new Error('尚未识别到不含音频的视频轨');
    }
    const videoTrack = productTrackForAsset(product.videoTracks, intent.videoAssetId);
    if (
      videoTrack?.composition !== 'video-only' ||
      (intent.videoTrackId != null && intent.videoTrackId !== videoTrack.id) ||
      (quality && quality.videoOnlyTrackId !== videoTrack.id)
    ) {
      throw new Error('尚未识别到不含音频的视频轨');
    }
    return {
      product,
      video: exactCurrentAsset(videoTrack, intent.videoAssetId),
      videoTrack,
    };
  }

  if (!product.capabilities.audioOnly || !intent.audioAssetId) {
    throw new Error('尚未识别到可下载的独立音轨');
  }
  const videoTrack = productTrackForAsset(product.videoTracks, intent.videoAssetId);
  const audioTrack = productTrackForAsset(product.audioTracks, intent.audioAssetId);
  if (!videoTrack) throw new Error('当前成品视频已变化，列表正在自动更新');
  if (!audioTrack) throw new Error('尚未识别到可下载的独立音轨');
  if (intent.videoTrackId != null && intent.videoTrackId !== videoTrack?.id) {
    throw new Error('所选清晰度已变化，列表正在自动更新');
  }
  const video = exactCurrentAsset(videoTrack, intent.videoAssetId);
  const audio = exactCurrentAsset(audioTrack, intent.audioAssetId);
  return { product, video, audio, videoTrack, audioTrack };
}
