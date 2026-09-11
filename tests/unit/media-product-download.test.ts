import { describe, expect, it } from 'vitest';

import {
  buildMediaProducts,
  selectProductDownload,
  validateMediaProductDownload,
} from '../../src/modules/media-products';
import type { ActiveMediaFingerprint, MediaAsset, TabMediaState } from '../../src/shared/types';

const PAGE = 'https://www.bilibili.com/video/BV1CURRENT1/?p=1';

function asset(id: string, kind: 'video' | 'audio', suffix: string): MediaAsset {
  return {
    id,
    url: `https://upos-sz-mirror.example/41482390218-1-${suffix}.m4s?deadline=1`,
    pageUrl: PAGE,
    pageTitle: '当前视频',
    frameId: 0,
    kind,
    detectedBy: ['manifest'],
    mime: `${kind}/mp4`,
    ...(kind === 'video' ? { width: 1920, height: 1080 } : {}),
    duration: 36,
    size: kind === 'video' ? 16_000 : 2_800,
    downloadable: true,
    discoveredAt: 100,
  };
}

function activeMedia(mediaEpoch: number): ActiveMediaFingerprint {
  return {
    routeKey: 'bilibili:BV1CURRENT1:p=1',
    mediaEpoch,
    elementId: 'main-player',
    lifecycleGeneration: mediaEpoch,
    frameId: 0,
    kind: 'video',
    title: '当前视频',
    sourceUrl: 'blob:https://www.bilibili.com/current-player',
    duration: 36,
    width: 1920,
    height: 1080,
  };
}

function state(mediaEpoch = 4): TabMediaState {
  const active = activeMedia(mediaEpoch);
  return {
    tabId: 7,
    pageUrl: PAGE,
    pageTitle: '当前视频',
    scannedAt: 1,
    status: 'ready',
    assets: [asset('video-current', 'video', '30112'), asset('audio-current', 'audio', '30280')],
    mediaElements: [],
    mediaEpoch,
    activeMedia: active,
  };
}

describe('download-boundary finished-media validation', () => {
  it('rejects a same-stream audio substitution that is not the admitted complete pair', () => {
    const current = state();
    current.assets.push({
      ...asset('audio-alternative', 'audio', '30250'),
      mime: 'audio/mp4; codecs="ec-3"',
      representation: {
        provider: 'bilibili',
        key: 'audio:30250',
        delivery: 'dash',
        id: 30250,
        codecs: 'ec-3',
        audioType: 'Dolby',
        dynamicRange: 'SDR',
        sourceIndex: 0,
      },
    });
    const [product] = buildMediaProducts(current.assets, {
      pageUrl: current.pageUrl,
      pageTitle: current.pageTitle,
      anchor: { ...current.activeMedia!, kind: 'video' },
    });
    expect(product?.defaultSelection.complete?.mode).toBe('merge');
    expect(() =>
      validateMediaProductDownload(current, {
        productId: product!.id,
        mode: 'complete',
        videoAssetId: 'video-current',
        audioAssetId: 'audio-alternative',
        expectedMedia: current.activeMedia!,
      }),
    ).toThrow(/安全配对|不属于同一媒体流/u);
  });
  it('accepts only the current product default pair', () => {
    const current = state();
    const [product] = buildMediaProducts(current.assets, {
      pageUrl: current.pageUrl,
      pageTitle: current.pageTitle,
      anchor: { ...current.activeMedia!, kind: 'video' },
    });
    expect(product).toBeDefined();

    expect(
      validateMediaProductDownload(current, {
        productId: product!.id,
        mode: 'complete',
        videoAssetId: 'video-current',
        audioAssetId: 'audio-current',
        expectedMedia: current.activeMedia!,
      }),
    ).toMatchObject({
      product: { id: product!.id },
      video: { id: 'video-current' },
      audio: { id: 'audio-current' },
      videoTrack: { id: product!.videoTracks[0]!.id, sources: [{ id: 'video-current' }] },
      audioTrack: { id: product!.audioTracks[0]!.id, sources: [{ id: 'audio-current' }] },
    });
  });

  it('rejects a request issued for the previous media epoch', () => {
    const current = state(5);
    const [product] = buildMediaProducts(current.assets, {
      pageUrl: current.pageUrl,
      anchor: { ...current.activeMedia!, kind: 'video' },
    });

    expect(() =>
      validateMediaProductDownload(current, {
        productId: product!.id,
        mode: 'complete',
        videoAssetId: 'video-current',
        audioAssetId: 'audio-current',
        expectedMedia: activeMedia(4),
      }),
    ).toThrow('播放器已切换');
  });

  it('rejects stale product ids and asset pairs instead of trusting UI ids', () => {
    const current = state();
    const [product] = buildMediaProducts(current.assets, {
      pageUrl: current.pageUrl,
      anchor: { ...current.activeMedia!, kind: 'video' },
    });
    const baseIntent = {
      mode: 'complete' as const,
      videoAssetId: 'video-current',
      audioAssetId: 'audio-current',
      expectedMedia: current.activeMedia!,
    };

    expect(() =>
      validateMediaProductDownload(current, {
        ...baseIntent,
        productId: 'product-from-previous-video',
      }),
    ).toThrow('成品视频已变化');
    expect(() =>
      validateMediaProductDownload(current, {
        ...baseIntent,
        productId: product!.id,
        audioAssetId: 'audio-from-another-stream',
      }),
    ).toThrow(/成品视频已变化|不属于同一媒体流/u);
  });

  it('accepts a non-default selected quality and rejects a forged logical track binding', () => {
    const current = state();
    current.assets.push({
      ...asset('video-720', 'video', '30080'),
      width: 1280,
      height: 720,
      mime: 'video/mp4; codecs="hev1.1.6.L93"',
    });
    current.assets[0] = {
      ...current.assets[0]!,
      mime: 'video/mp4; codecs="avc1.640028"',
    };
    const [product] = buildMediaProducts(current.assets, {
      pageUrl: current.pageUrl,
      pageTitle: current.pageTitle,
      anchor: { ...current.activeMedia!, kind: 'video' },
    });
    const selectedQuality = product?.qualities.find((quality) => quality.label === '720P · HEVC');
    const selection = selectProductDownload(product!, 'complete', selectedQuality!.id);

    expect(
      validateMediaProductDownload(current, {
        productId: product!.id,
        ...selection,
        expectedMedia: current.activeMedia!,
      }),
    ).toMatchObject({
      video: { id: 'video-720' },
      audio: { id: 'audio-current' },
    });
    expect(() =>
      validateMediaProductDownload(current, {
        productId: product!.id,
        ...selection,
        videoTrackId: product!.videoTracks[0]!.id,
        expectedMedia: current.activeMedia!,
      }),
    ).toThrow(/清晰度|完整视频/u);
  });
});
