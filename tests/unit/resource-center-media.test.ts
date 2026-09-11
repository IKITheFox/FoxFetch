import { describe, expect, it } from 'vitest';

import { buildResourceCenterMediaInventory } from '../../src/entrypoints/sidepanel/resource-center-media';
import type { MediaAsset } from '../../src/shared/types';

const PAGE = 'https://www.bilibili.com/video/BV1CENTER01/';

function asset(
  id: string,
  kind: MediaAsset['kind'],
  overrides: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    url: `https://upos-sz-mirrorcos.bilivideo.com/path/current-1-${id}.m4s`,
    pageUrl: PAGE,
    pageTitle: '资源中心测试',
    frameId: 0,
    kind,
    detectedBy: ['manifest'],
    mime: kind === 'audio' ? 'audio/mp4' : kind === 'video' ? 'video/mp4' : 'image/webp',
    size: 10_000,
    downloadable: true,
    discoveredAt: 1,
    ...overrides,
  };
}

describe('Resource Center media inventory', () => {
  it('shows one finished product while keeping its source tracks in the raw section', () => {
    const video = asset('30112', 'video', { width: 1920, height: 1080, duration: 60 });
    const audio = asset('30280', 'audio', { duration: 60, size: 2_000 });
    const image = asset('poster', 'image', {
      url: 'https://i0.hdslb.com/poster.webp',
      extension: 'webp',
      detectedBy: ['dom'],
    });

    const inventory = buildResourceCenterMediaInventory(
      [video, audio, image],
      { pageUrl: PAGE, pageTitle: '成品视频', duration: 60, frameId: 0 },
      false,
    );

    expect(inventory.products).toHaveLength(1);
    expect(inventory.products[0]?.capabilities.complete).toBe(true);
    expect(inventory.assets.map((item) => item.id)).toEqual(['poster']);
    expect(inventory.rawAssets.map((item) => item.id)).toEqual(['30112', '30280']);
    expect(inventory.counts).toEqual({ image: 1, video: 1, audio: 1, playlist: 0 });
  });

  it('does not count data.bilibili.com/web or 2-byte responses as video', () => {
    const fake = asset('fake', 'video', {
      url: 'https://data.bilibili.com/web',
      detectedBy: ['network'],
      size: 2,
    });
    const mimeOnly = asset('xhr', 'video', {
      url: 'https://api.bilibili.com/x/player/web',
      detectedBy: ['performance'],
      size: 50_000,
    });

    const inventory = buildResourceCenterMediaInventory(
      [fake, mimeOnly],
      { pageUrl: PAGE, frameId: 0 },
      false,
    );

    expect(inventory.products).toEqual([]);
    expect(inventory.assets).toEqual([]);
    expect(inventory.counts.video).toBe(0);
    expect(inventory.rawAssets.map((item) => item.id)).toEqual(['fake', 'xhr']);
  });
});
