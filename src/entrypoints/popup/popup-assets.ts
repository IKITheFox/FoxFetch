import type { MediaAsset, MediaKind } from '../../shared/types';

export type PopupAssetFilter = 'all' | MediaKind;

export const POPUP_RECENT_ASSET_LIMIT = 50;

export function selectRecentPopupAssets(
  assets: readonly MediaAsset[],
  filter: PopupAssetFilter,
): MediaAsset[] {
  return assets
    .filter((asset) => filter === 'all' || asset.kind === filter)
    .slice(0, POPUP_RECENT_ASSET_LIMIT);
}
