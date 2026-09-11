import { describe, expect, it } from 'vitest';

import {
  POPUP_RECENT_ASSET_LIMIT,
  selectRecentPopupAssets,
} from '../../src/entrypoints/popup/popup-assets';
import type { MediaAsset, MediaKind } from '../../src/shared/types';

function asset(index: number, kind: MediaKind = 'image'): MediaAsset {
  return {
    id: `asset-${index}`,
    url: `https://media.example/${index}`,
    pageUrl: 'https://example.com',
    pageTitle: 'Example',
    frameId: 0,
    kind,
    detectedBy: ['dom'],
    downloadable: true,
    discoveredAt: 100 - index,
  };
}

describe('popup asset selection', () => {
  it('keeps the first 50 recent resources instead of truncating the list to four', () => {
    const assets = Array.from({ length: 64 }, (_, index) => asset(index));

    const selected = selectRecentPopupAssets(assets, 'all');

    expect(selected).toHaveLength(POPUP_RECENT_ASSET_LIMIT);
    expect(selected[0]?.id).toBe('asset-0');
    expect(selected.at(-1)?.id).toBe('asset-49');
  });

  it('filters by media kind before applying the display limit', () => {
    const assets = [asset(1, 'video'), asset(2, 'image'), asset(3, 'video')];

    expect(selectRecentPopupAssets(assets, 'video').map(({ id }) => id)).toEqual([
      'asset-1',
      'asset-3',
    ]);
  });
});
