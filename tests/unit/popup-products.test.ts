import { describe, expect, it } from 'vitest';

import {
  buildMediaProducts,
  presentMediaProduct,
  productDownloadOptions,
  productQualityOptions,
  selectProductDownload,
} from '../../src/modules/media-products';
import type { MediaAsset } from '../../src/shared/types';

const BILIBILI_PAGE = 'https://www.bilibili.com/video/BV1PRODUCT01/';
const YOUTUBE_PAGE = 'https://www.youtube.com/watch?v=product_01';

function track(
  id: string,
  kind: 'video' | 'audio',
  overrides: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    url: `https://cdn.example/${id}.m4s`,
    pageUrl: BILIBILI_PAGE,
    pageTitle: '成品视频测试',
    frameId: 0,
    kind,
    detectedBy: ['manifest'],
    mime: `${kind}/mp4`,
    downloadable: true,
    discoveredAt: 1,
    ...overrides,
  };
}

describe('popup finished-video download selection', () => {
  it('maps a separated Bilibili product to the three exact track outputs', () => {
    const [product] = buildMediaProducts(
      [
        track('video-1080', 'video', {
          url: 'https://upos.example/1545003132-1-100145.m4s',
          width: 1920,
          height: 1080,
        }),
        track('audio-best', 'audio', {
          url: 'https://upos.example/1545003132-1-30216.m4s',
          size: 5_000,
        }),
      ],
      { pageUrl: BILIBILI_PAGE },
    );
    expect(product).toBeDefined();

    expect(selectProductDownload(product!, 'video')).toEqual({
      mode: 'video-only',
      videoAssetId: 'video-1080',
    });
    expect(selectProductDownload(product!, 'audio')).toEqual({
      mode: 'audio-only',
      videoAssetId: 'video-1080',
      audioAssetId: 'audio-best',
    });
    expect(selectProductDownload(product!, 'complete')).toEqual({
      mode: 'complete',
      videoAssetId: 'video-1080',
      audioAssetId: 'audio-best',
    });
  });

  it('downloads a muxed YouTube format directly and disables impossible splits', () => {
    const [product] = buildMediaProducts(
      [
        track('yt-muxed', 'video', {
          pageUrl: YOUTUBE_PAGE,
          url: 'https://r1.googlevideo.com/videoplayback?id=main&itag=18',
          mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          width: 640,
          height: 360,
        }),
      ],
      { pageUrl: YOUTUBE_PAGE },
    );
    expect(product).toBeDefined();

    expect(selectProductDownload(product!, 'complete')).toEqual({
      mode: 'complete',
      videoAssetId: 'yt-muxed',
    });
    expect(
      productDownloadOptions(product!).map(({ mode, available }) => [mode, available]),
    ).toEqual([
      ['complete', true],
      ['video', false],
      ['audio', false],
    ]);
    expect(() => selectProductDownload(product!, 'video')).toThrow('不含音频');
    expect(() => selectProductDownload(product!, 'audio')).toThrow('独立音轨');
  });

  it('never labels a higher-quality muxed representation as video-only', () => {
    const [product] = buildMediaProducts(
      [
        track('muxed-1080', 'video', {
          pageUrl: YOUTUBE_PAGE,
          url: 'https://r1.googlevideo.com/videoplayback?id=main&itag=22',
          mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
          width: 1920,
          height: 1080,
        }),
        track('silent-720', 'video', {
          pageUrl: YOUTUBE_PAGE,
          url: 'https://r1.googlevideo.com/videoplayback?id=main&itag=136',
          mime: 'video/mp4; codecs="avc1.4d401f"',
          width: 1280,
          height: 720,
        }),
      ],
      { pageUrl: YOUTUBE_PAGE },
    );
    expect(product).toBeDefined();

    expect(selectProductDownload(product!, 'complete').videoAssetId).toBe('muxed-1080');
    expect(selectProductDownload(product!, 'video').videoAssetId).toBe('silent-720');
  });

  it('binds complete and silent downloads to the explicitly selected quality', () => {
    const family = '1545003132-1';
    const [product] = buildMediaProducts(
      [
        track('video-avc-1080', 'video', {
          url: `https://upos.example/${family}-100145.m4s`,
          mime: 'video/mp4; codecs="avc1.640028"',
          width: 1920,
          height: 1080,
        }),
        track('video-hevc-720', 'video', {
          url: `https://upos.example/${family}-100024.m4s`,
          poster: 'https://i0.hdslb.com/provider-cover.jpg?token=signed',
          mime: 'video/mp4; codecs="hev1.1.6.L93"',
          width: 1280,
          height: 720,
        }),
        track('audio-best', 'audio', {
          url: `https://upos.example/${family}-30216.m4s`,
          mime: 'audio/mp4; codecs="mp4a.40.2"',
        }),
      ],
      { pageUrl: BILIBILI_PAGE },
    );
    const hevc720 = product?.qualities.find((quality) => quality.label === '720P · HEVC');
    expect(hevc720).toBeDefined();
    expect(productQualityOptions(product!)).toContainEqual(
      expect.objectContaining({
        id: hevc720?.id,
        label: '720P · HEVC',
        detail: '1280×720',
        completeAvailable: true,
        videoOnlyAvailable: true,
      }),
    );

    const complete = selectProductDownload(product!, 'complete', hevc720!.id);
    expect(complete).toMatchObject({
      mode: 'complete',
      videoAssetId: 'video-hevc-720',
      audioAssetId: 'audio-best',
      qualityId: hevc720?.id,
      videoTrackId: hevc720?.displayVideoTrackId,
    });
    expect(selectProductDownload(product!, 'video', hevc720!.id)).toMatchObject({
      mode: 'video-only',
      videoAssetId: 'video-hevc-720',
      qualityId: hevc720?.id,
      videoTrackId: hevc720?.videoOnlyTrackId,
    });
    expect(() => selectProductDownload(product!, 'complete', 'quality-stale')).toThrow(
      '清晰度已变化',
    );

    const pageDockView = presentMediaProduct(product!);
    expect(pageDockView).not.toHaveProperty('selectedQualityId');
    expect(pageDockView).not.toHaveProperty('qualityOptions');
    expect(pageDockView).not.toHaveProperty('poster');
    expect(presentMediaProduct(product!, undefined, hevc720!.id, true)).toMatchObject({
      selectedQuality: '720P · HEVC',
      selectedQualityId: hevc720!.id,
      qualityOptions: expect.any(Array),
      poster: 'https://i0.hdslb.com/provider-cover.jpg?token=signed',
    });
  });
});
