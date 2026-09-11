import { t as uiText } from '../../shared/i18n';
import type { MediaProductDownloadMode } from '../../shared/types';
import { siteMediaRouteKey } from '../detector/site-media';
import { safeMediaArtworkUrl } from './media-artwork';
import type { MediaProduct, MediaProductQuality, MediaProductTrack } from './media-products';

/** Compact, framework-neutral modes used by every finished-media card. */
export type MediaProductCardDownloadMode = 'audio' | 'video' | 'complete';

export interface MediaProductDownloadOption {
  mode: MediaProductCardDownloadMode;
  /** Disabled choices stay visible so users can see which stream is missing. */
  available?: boolean;
  label?: string;
  detail?: string;
}

export interface MediaProductQualityOption {
  id: string;
  label: string;
  detail?: string;
  completeAvailable: boolean;
  dynamicRange?: MediaProductQuality['dynamicRange'];
  completeUnavailableReason?: string;
  /** A delivered HDR/DV candidate still requires full-source and output proof. */
  completeCheckRequired?: boolean;
  videoOnlyAvailable: boolean;
}

/**
 * Sanitized presentation data suitable for both extension pages and the open
 * Shadow DOM media dock. It deliberately contains no source URL or headers.
 */
export interface MediaProductCardModel {
  id: string;
  title: string;
  domain: string;
  /** Trusted extension-page artwork. Page-Dock snapshots deliberately omit it. */
  poster?: string;
  duration?: number;
  selectedQuality?: string;
  selectedQualityId?: string;
  /** Present only in trusted extension pages. Page-Dock qualities need opaque tokens first. */
  qualityOptions?: MediaProductQualityOption[];
  options: MediaProductDownloadOption[];
}

export interface MediaProductDownloadSelection {
  mode: MediaProductDownloadMode;
  videoAssetId: string;
  audioAssetId?: string;
  /** Exact logical representation selected inside the quality variant. */
  videoTrackId?: string;
  /** Metadata-only quality id; never a media URL or asset id. */
  qualityId?: string;
  /** Reserved for a tab-bound opaque capability when the page Dock gains quality selection. */
  qualityToken?: string;
}

export function productTrack(
  product: MediaProduct,
  trackId?: string,
): MediaProductTrack | undefined {
  if (!trackId) return undefined;
  return [...product.videoTracks, ...product.audioTracks].find((track) => track.id === trackId);
}

export function productQuality(
  product: MediaProduct,
  qualityId?: string,
): MediaProductQuality | undefined {
  return (
    product.qualities.find((quality) => quality.id === qualityId) ??
    product.qualities.find((quality) => quality.id === product.defaultQualityId) ??
    product.qualities[0]
  );
}

export function productDisplayTrack(
  product: MediaProduct,
  qualityId?: string,
): MediaProductTrack | undefined {
  const quality = productQuality(product, qualityId);
  if (quality) return productTrack(product, quality.displayVideoTrackId);
  const complete = product.defaultSelection.complete;
  return productTrack(product, complete?.videoTrackId ?? product.defaultSelection.videoTrackId);
}

export function productQualityOptions(product: MediaProduct): MediaProductQualityOption[] {
  return product.qualities.map((quality) => ({
    id: quality.id,
    label: quality.label,
    ...(quality.detail ? { detail: quality.detail } : {}),
    completeAvailable: quality.complete != null,
    ...(quality.dynamicRange ? { dynamicRange: quality.dynamicRange } : {}),
    ...(quality.mergeBlockedReason
      ? { completeUnavailableReason: quality.mergeBlockedReason }
      : {}),
    ...((quality.dynamicRange === 'HDR' || quality.dynamicRange === 'Dolby Vision') &&
    quality.complete
      ? { completeCheckRequired: true }
      : {}),
    videoOnlyAvailable: quality.videoOnlyTrackId != null,
  }));
}

export function productDownloadOptions(
  product: MediaProduct,
  qualityId?: string,
): MediaProductDownloadOption[] {
  const quality = productQuality(product, qualityId);
  const complete = quality ? quality.complete : product.defaultSelection.complete;
  const completeVideo = productTrack(product, complete?.videoTrackId);
  const videoOnly = productTrack(
    product,
    quality ? quality.videoOnlyTrackId : product.defaultSelection.videoTrackId,
  );
  const audio = productTrack(product, product.defaultSelection.audioTrackId);
  const completeAvailable = quality ? complete != null : product.capabilities.complete;
  const videoOnlyAvailable = quality
    ? quality.videoOnlyTrackId != null
    : product.capabilities.videoOnly;
  const advancedRange = quality?.dynamicRange === 'HDR' || quality?.dynamicRange === 'Dolby Vision';
  return [
    {
      mode: 'complete',
      available: completeAvailable,
      detail: completeAvailable
        ? complete?.mode === 'merge'
          ? `${advancedRange ? uiText('E0778') : uiText('E0779')} · ${quality?.label ?? completeVideo?.qualityLabel ?? uiText('E0780')}`
          : uiText('E0781', {
              p1: quality?.label ?? completeVideo?.qualityLabel ?? uiText('E0782'),
            })
        : (quality?.mergeBlockedReason ?? uiText('E0783')),
    },
    {
      mode: 'video',
      available: videoOnlyAvailable,
      detail: videoOnlyAvailable
        ? uiText('E0784', { p1: quality?.label ?? videoOnly?.qualityLabel ?? uiText('E0780') })
        : uiText('E0785'),
    },
    {
      mode: 'audio',
      available: product.capabilities.audioOnly,
      detail: product.capabilities.audioOnly
        ? uiText('E0786', { p1: audio?.qualityLabel ?? uiText('E0787') })
        : uiText('E0788'),
    },
  ];
}

export function selectProductDownload(
  product: MediaProduct,
  mode: MediaProductCardDownloadMode,
  qualityId?: string,
): MediaProductDownloadSelection {
  const requestedQuality = qualityId
    ? product.qualities.find((quality) => quality.id === qualityId)
    : undefined;
  if (qualityId && !requestedQuality) {
    throw new Error(uiText('E0771'));
  }
  if (mode === 'audio' && !product.capabilities.audioOnly) {
    throw new Error(uiText('E0279'));
  }
  if (
    mode === 'video' &&
    (requestedQuality ? requestedQuality.videoOnlyTrackId == null : !product.capabilities.videoOnly)
  ) {
    throw new Error(uiText('E0776'));
  }
  if (
    mode === 'complete' &&
    (requestedQuality ? requestedQuality.complete == null : !product.capabilities.complete)
  ) {
    throw new Error(uiText('E0772'));
  }
  const complete = requestedQuality?.complete ?? product.defaultSelection.complete;
  const fallbackVideo = requestedQuality
    ? productTrack(product, requestedQuality.displayVideoTrackId)
    : product.videoTracks[0];
  const audio = productTrack(
    product,
    mode === 'complete' && complete?.mode === 'merge'
      ? complete.audioTrackId
      : product.defaultSelection.audioTrackId,
  );
  const video =
    mode === 'complete'
      ? productTrack(product, complete?.videoTrackId)
      : mode === 'video'
        ? productTrack(
            product,
            requestedQuality?.videoOnlyTrackId ?? product.defaultSelection.videoTrackId,
          )
        : fallbackVideo;
  if (!video) throw new Error(uiText('E0777'));

  if (mode === 'audio') {
    if (!audio) throw new Error(uiText('E0279'));
    return {
      mode: 'audio-only',
      videoAssetId: video.asset.id,
      audioAssetId: audio.asset.id,
      ...(requestedQuality ? { videoTrackId: video.id } : {}),
      ...(requestedQuality ? { qualityId: requestedQuality.id } : {}),
    };
  }
  if (mode === 'video') {
    if (video.composition !== 'video-only') {
      throw new Error(uiText('E0776'));
    }
    return {
      mode: 'video-only',
      videoAssetId: video.asset.id,
      ...(requestedQuality ? { videoTrackId: video.id } : {}),
      ...(requestedQuality ? { qualityId: requestedQuality.id } : {}),
    };
  }
  if (!complete) throw new Error(uiText('E0772'));
  if (complete.mode === 'direct') {
    return {
      mode: 'complete',
      videoAssetId: video.asset.id,
      ...(requestedQuality ? { videoTrackId: video.id } : {}),
      ...(requestedQuality ? { qualityId: requestedQuality.id } : {}),
    };
  }
  if (!audio) throw new Error(uiText('E0789'));
  return {
    mode: 'complete',
    videoAssetId: video.asset.id,
    audioAssetId: audio.asset.id,
    ...(requestedQuality ? { videoTrackId: video.id } : {}),
    ...(requestedQuality ? { qualityId: requestedQuality.id } : {}),
  };
}

export function mediaProductDomain(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./u, '');
  } catch {
    return uiText('E0052');
  }
}

/** Pick a poster carried by a track from this product's exact page identity. */
export function mediaProductPoster(
  product: MediaProduct,
  selectedQualityId?: string,
): string | undefined {
  const selected = productDisplayTrack(product, selectedQualityId);
  const tracks = [
    ...(selected ? [selected] : []),
    ...product.videoTracks.filter((track) => track !== selected),
  ];
  const productIdentity = siteMediaRouteKey(product.pageUrl);
  for (const track of tracks) {
    for (const asset of [track.asset, ...track.sources]) {
      if (siteMediaRouteKey(asset.pageUrl) !== productIdentity) continue;
      const poster = safeMediaArtworkUrl(asset.poster, product.pageUrl);
      if (poster) return poster;
    }
  }
  return undefined;
}

export function presentMediaProduct(
  product: MediaProduct,
  fallbackDuration?: number,
  selectedQualityId?: string,
  includeQualityOptions = false,
): MediaProductCardModel {
  const selectedQuality = productQuality(product, selectedQualityId);
  const displayTrack = productDisplayTrack(product, selectedQuality?.id);
  const duration = displayTrack?.duration ?? fallbackDuration;
  const poster = includeQualityOptions
    ? mediaProductPoster(product, selectedQuality?.id)
    : undefined;
  return {
    id: product.id,
    title: product.title,
    domain: mediaProductDomain(product.pageUrl),
    ...(poster ? { poster } : {}),
    ...(duration == null ? {} : { duration }),
    ...(selectedQuality?.label
      ? {
          selectedQuality: selectedQuality.label,
          ...(includeQualityOptions ? { selectedQualityId: selectedQuality.id } : {}),
        }
      : displayTrack?.qualityLabel
        ? { selectedQuality: displayTrack.qualityLabel }
        : {}),
    ...(includeQualityOptions ? { qualityOptions: productQualityOptions(product) } : {}),
    options: productDownloadOptions(product, selectedQuality?.id),
  };
}
