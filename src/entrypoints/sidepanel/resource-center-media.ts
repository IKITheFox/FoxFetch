import {
  buildMediaProducts,
  isTrustedMediaAssetForDisplay,
  type MediaProduct,
  type MediaProductPageInfo,
} from '../../modules/media-products';
import type { MediaAsset, MediaKind } from '../../shared/types';

export interface ResourceCenterMediaInventory {
  /** Finished media cards shown by default. */
  products: readonly MediaProduct[];
  /** Trusted, independently useful files that are not part of a product. */
  assets: readonly MediaAsset[];
  /** Original observations, kept in a collapsed diagnostics section. */
  rawAssets: readonly MediaAsset[];
  counts: Readonly<Record<MediaKind, number>>;
}

/**
 * Turns noisy detector output into the default Resource Center inventory.
 * Product source tracks remain available in rawAssets for troubleshooting, but
 * they are never counted as several separate videos in the primary library.
 */
export function buildResourceCenterMediaInventory(
  allAssets: readonly MediaAsset[],
  info: MediaProductPageInfo,
  showPlaylists: boolean,
): ResourceCenterMediaInventory {
  const products = buildMediaProducts(allAssets, info).filter(
    (product) =>
      product.videoTracks.length > 0 &&
      (product.capabilities.complete || product.capabilities.videoOnly),
  );
  const productAssetIds = new Set(
    products.flatMap((product) =>
      [...product.videoTracks, ...product.audioTracks].flatMap((track) =>
        track.sources.map((source) => source.id),
      ),
    ),
  );
  const assets = allAssets.filter(
    (asset) =>
      !productAssetIds.has(asset.id) &&
      (showPlaylists || asset.kind !== 'playlist') &&
      isTrustedMediaAssetForDisplay(asset, info),
  );
  const primaryAssetIds = new Set(assets.map((asset) => asset.id));
  const rawAssets = allAssets.filter((asset) => !primaryAssetIds.has(asset.id));

  return {
    products,
    assets,
    rawAssets,
    counts: {
      image: assets.filter((asset) => asset.kind === 'image').length,
      video: products.length + assets.filter((asset) => asset.kind === 'video').length,
      audio:
        products.filter((product) => product.capabilities.audioOnly).length +
        assets.filter((asset) => asset.kind === 'audio').length,
      playlist: assets.filter((asset) => asset.kind === 'playlist').length,
    },
  };
}
