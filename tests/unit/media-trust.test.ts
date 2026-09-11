import { describe, expect, it } from 'vitest';

import {
  assessMediaAssetTrust,
  currentVideoPlaybackAnchor,
  providerIdentityMatchesPage,
  selectPrimaryVideoAnchor,
} from '../../src/modules/media-products';
import type { MediaAsset, MediaElementInfo } from '../../src/shared/types';

const PAGE = 'https://www.bilibili.com/video/BV1TRUST001/';

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'candidate',
    url: 'https://upos-sz-mirrorcos.bilivideo.com/path/main-1-30112.m4s',
    pageUrl: PAGE,
    pageTitle: '可信媒体',
    frameId: 0,
    kind: 'video',
    detectedBy: ['network'],
    mime: 'video/mp4',
    size: 1_000_000,
    downloadable: true,
    discoveredAt: 1,
    ...overrides,
  };
}

function element(overrides: Partial<MediaElementInfo> = {}): MediaElementInfo {
  return {
    elementId: 'video',
    lifecycleGeneration: 1,
    frameId: 0,
    kind: 'video',
    title: '播放器',
    currentTime: 0,
    playbackRate: 1,
    volume: 1,
    paused: true,
    visibleArea: 10_000,
    lastActiveAt: 1,
    ...overrides,
  };
}

describe('media asset trust', () => {
  it('hard-rejects Bilibili telemetry and implausibly small complete responses', () => {
    expect(
      assessMediaAssetTrust(asset({ url: 'https://data.bilibili.com/web', size: 2 }), {
        pageUrl: PAGE,
        frameId: 0,
      }),
    ).toMatchObject({ trusted: false, rejected: true, reasons: ['telemetry-host'] });

    expect(
      assessMediaAssetTrust(asset({ url: 'https://cdn.example.test/not-media', size: 2 }), {
        pageUrl: PAGE,
        frameId: 0,
      }),
    ).toMatchObject({ trusted: false, rejected: true, reasons: ['implausibly-small'] });
  });

  it('keeps extensionless MIME-only XHR/performance observations as weak evidence', () => {
    const result = assessMediaAssetTrust(
      asset({
        url: 'https://api.example.test/web',
        detectedBy: ['network', 'performance'],
      }),
      { pageUrl: PAGE, frameId: 0 },
    );

    expect(result).toMatchObject({ trusted: false, rejected: false });
    expect(result.reasons).toEqual(
      expect.arrayContaining(['network', 'performance', 'media-mime']),
    );
  });

  it('accepts provider streams and exact active-player source matches', () => {
    expect(assessMediaAssetTrust(asset(), { pageUrl: PAGE, frameId: 0 }).trusted).toBe(true);

    const opaque = asset({
      url: 'https://cdn.example.test/playback?id=current',
      detectedBy: ['network'],
    });
    expect(
      assessMediaAssetTrust(opaque, {
        pageUrl: PAGE,
        anchor: {
          frameId: 0,
          kind: 'video',
          sourceUrl: `${opaque.url}#player`,
        },
      }).trusted,
    ).toBe(true);
  });

  it('selects the largest visible video instead of a newer small ad player', () => {
    const main = element({
      elementId: 'main',
      visibleArea: 900_000,
      paused: true,
      lastActiveAt: 1,
    });
    const ad = element({ elementId: 'ad', visibleArea: 20_000, paused: false, lastActiveAt: 99 });

    expect(selectPrimaryVideoAnchor([ad, main])).toMatchObject({ frameId: 0, title: '播放器' });
    expect(selectPrimaryVideoAnchor([ad, main])?.sourceUrl).toBeUndefined();
  });

  it('rejects stale-page and wrong-duration candidates before scoring', () => {
    expect(
      assessMediaAssetTrust(asset({ pageUrl: 'https://www.bilibili.com/video/BV1OLD0001/' }), {
        pageUrl: PAGE,
      }).reasons,
    ).toContain('wrong-page');
    expect(
      assessMediaAssetTrust(asset({ duration: 15 }), {
        pageUrl: PAGE,
        anchor: { frameId: 0, kind: 'video', duration: 120 },
      }).reasons,
    ).toContain('duration-mismatch');
  });

  it('anchors 18:42 current media instead of a hidden 37:01 SPA player', () => {
    const oldPlayer = element({
      elementId: 'old-37m01s',
      duration: 37 * 60 + 1,
      visibleArea: 0,
      paused: false,
      lastActiveAt: 99,
    });
    const currentPlayer = element({
      elementId: 'current-18m42s',
      duration: 18 * 60 + 42,
      visibleArea: 900_000,
      paused: true,
      lastActiveAt: 2,
    });
    const anchor = currentVideoPlaybackAnchor({
      pageUrl: PAGE,
      mediaEpoch: 2,
      activeMedia: {
        routeKey: 'bilibili:BV1TRUST001:p=1:cid=',
        mediaEpoch: 1,
        elementId: oldPlayer.elementId,
        lifecycleGeneration: 1,
        frameId: 0,
        kind: 'video',
        title: '旧播放器',
        duration: 37 * 60 + 1,
      },
      mediaElements: [oldPlayer, currentPlayer],
    });

    expect(anchor).toMatchObject({ duration: 18 * 60 + 42 });
  });

  it('binds Bilibili provider identity to the current BVID and explicit CID', () => {
    expect(providerIdentityMatchesPage(`${PAGE}?cid=42001`, 'bilibili:BV1TRUST001:42001')).toBe(
      true,
    );
    expect(providerIdentityMatchesPage(`${PAGE}?cid=42001`, 'bilibili:BV1TRUST001:42002')).toBe(
      false,
    );
    expect(providerIdentityMatchesPage(PAGE, 'bilibili:BV1STALE001:42001')).toBe(false);
  });
});
