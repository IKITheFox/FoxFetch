import { describe, expect, it } from 'vitest';

import {
  buildMediaProducts,
  productDownloadOptions,
  productQualityOptions,
} from '../../src/modules/media-products';
import type { MediaAsset } from '../../src/shared/types';

const BILIBILI_PAGE = 'https://www.bilibili.com/video/BV1CURRENT1/?p=1';
const YOUTUBE_PAGE = 'https://www.youtube.com/watch?v=Current_01&list=playlist';

function asset(
  id: string,
  kind: MediaAsset['kind'],
  overrides: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    url: `https://cdn.example/${id}.m4s`,
    pageUrl: BILIBILI_PAGE,
    pageTitle: '测试视频',
    frameId: 0,
    kind,
    detectedBy: ['manifest'],
    ...(kind === 'video' || kind === 'audio' ? { mime: `${kind}/mp4` } : {}),
    downloadable: true,
    discoveredAt: 100,
    ...overrides,
  };
}

describe('media product aggregation', () => {
  it('turns Bilibili DASH representations into one finished product', () => {
    const input = [
      asset('video-720', 'video', {
        url: 'https://upos-sz-mirror.example/41482390218-1-30080.m4s?deadline=1',
        width: 720,
        height: 1280,
        duration: 36,
        size: 8_000,
      }),
      asset('video-1080', 'video', {
        url: 'https://upos-sz-mirror.example/41482390218-1-30112.m4s?deadline=1',
        width: 1080,
        height: 1920,
        duration: 36,
        size: 16_000,
      }),
      asset('audio-main', 'audio', {
        url: 'https://upos-sz-mirror.example/41482390218-1-30280.m4s?deadline=1',
        duration: 36.02,
        size: 2_800,
      }),
      asset('poster', 'image', {
        url: 'https://i0.hdslb.com/poster.avif',
        mime: 'image/avif',
      }),
      asset('page-html', 'video', {
        url: 'https://www.bilibili.com/video/BV1CURRENT1/',
        mime: 'text/html',
      }),
      asset('old-video', 'video', {
        pageUrl: 'https://www.bilibili.com/video/BV1OLDVIDEO1/',
        width: 3840,
        height: 2160,
      }),
    ];

    const [product] = buildMediaProducts(input, {
      pageUrl: 'https://www.bilibili.com/video/BV1CURRENT1/?p=1&spm_id_from=333',
      pageTitle: '竖屏视频',
      duration: 36,
      frameId: 0,
    });

    expect(product).toMatchObject({
      provider: 'bilibili',
      title: '竖屏视频',
      capabilities: { audioOnly: true, videoOnly: true, complete: true },
    });
    expect(product?.videoTracks.map((track) => track.resolution)).toEqual([
      '1080×1920',
      '720×1280',
    ]);
    expect(product?.videoTracks.every((track) => track.composition === 'video-only')).toBe(true);
    expect(product?.audioTracks).toHaveLength(1);
    expect(product?.defaultSelection.complete).toEqual({
      mode: 'merge',
      videoTrackId: product?.videoTracks[0]?.id,
      audioTrackId: product?.audioTracks[0]?.id,
    });
  });

  it.each(['80', '100145', '123456789'])(
    'pairs a Bilibili video representation with an arbitrary-width %s id',
    (videoRepresentationId) => {
      const family = '1545003132-1';
      const video = asset(`video-${videoRepresentationId}`, 'video', {
        url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/32/31/1545003132/${family}-${videoRepresentationId}.m4s`,
        detectedBy: ['network'],
        width: 1920,
        height: 1080,
      });
      const audio = asset('audio-30216', 'audio', {
        url: `https://upos-sz-mirrorali.bilivideo.com/upgcxcode/32/31/1545003132/${family}-30216.m4s`,
        detectedBy: ['network'],
      });

      const [product] = buildMediaProducts([video, audio], { pageUrl: BILIBILI_PAGE });

      expect(product?.capabilities).toMatchObject({
        videoOnly: true,
        audioOnly: true,
        complete: true,
      });
      expect(product?.defaultSelection.complete).toEqual({
        mode: 'merge',
        videoTrackId: product?.videoTracks[0]?.id,
        audioTrackId: product?.audioTracks[0]?.id,
      });
      expect(product?.videoTracks[0]?.streamIdentity).toBe(product?.audioTracks[0]?.streamIdentity);
    },
  );

  it.each([
    { videoSource: 'manifest', audioSource: 'network' },
    { videoSource: 'network', audioSource: 'manifest' },
  ] as const)(
    'pairs Bilibili tracks when video is $videoSource and audio is $audioSource',
    ({ videoSource, audioSource }) => {
      const family = '40905737292-1';
      const video = asset('mixed-video', 'video', {
        url: `https://cn-jsnt-ct-01-01.bilivideo.com/upgcxcode/92/72/40905737292/${family}-100027.m4s`,
        detectedBy: [videoSource],
        width: 1920,
        height: 1080,
      });
      const audio = asset('mixed-audio', 'audio', {
        url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/92/72/40905737292/${family}-30216.m4s`,
        detectedBy: [audioSource],
      });

      const [product] = buildMediaProducts([video, audio], { pageUrl: BILIBILI_PAGE });

      expect(product?.capabilities.complete).toBe(true);
      expect(product?.defaultSelection.complete?.mode).toBe('merge');
      expect(product?.videoTracks[0]?.streamIdentity).toBe(product?.audioTracks[0]?.streamIdentity);
    },
  );

  it('does not let mixed manifest provenance override different Bilibili filename families', () => {
    const video = asset('mixed-unrelated-video', 'video', {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/path/video-family-1-100145.m4s',
      detectedBy: ['manifest'],
    });
    const audio = asset('mixed-unrelated-audio', 'audio', {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/path/audio-family-1-30216.m4s',
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts([video, audio], { pageUrl: BILIBILI_PAGE });

    expect(product?.capabilities).toMatchObject({
      videoOnly: true,
      audioOnly: true,
      complete: false,
    });
  });

  it('enriches a network audio side from an exact current manifest resource family', () => {
    const family = '40905737292-1';
    const video = asset('owned-manifest-video', 'video', {
      url: `https://cn-jsnt-ct-01-01.bilivideo.com/upgcxcode/92/72/40905737292/${family}-100027.m4s`,
      detectedBy: ['manifest'],
      representation: {
        provider: 'bilibili',
        bvid: 'BV1CURRENT1',
        cid: '42001',
        key: 'bilibili:video:BV1CURRENT1:42001:100027',
        delivery: 'dash',
        id: 100027,
      },
    });
    const audio = asset('prefetched-network-audio', 'audio', {
      url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/92/72/40905737292/${family}-30216.m4s`,
      detectedBy: ['network'],
      requestHeaders: { referer: 'https://www.bilibili.com/video/BV1OLDVIDEO/' },
    });

    const [product] = buildMediaProducts([video, audio], {
      pageUrl: BILIBILI_PAGE,
      providerIdentity: 'bilibili:BV1CURRENT1:42001',
    });

    expect(product?.capabilities.complete).toBe(true);
    expect(product?.audioTracks[0]?.representation).toMatchObject({
      provider: 'bilibili',
      bvid: 'BV1CURRENT1',
      cid: '42001',
      id: 30216,
    });
    expect(product?.videoTracks[0]?.streamIdentity).toBe(product?.audioTracks[0]?.streamIdentity);
  });

  it('rejects cross-BVID enrichment even when the DASH filename family matches', () => {
    const family = '40905737292-1';
    const staleVideo = asset('stale-manifest-video', 'video', {
      url: `https://cn-jsnt-ct-01-01.bilivideo.com/upgcxcode/92/72/40905737292/${family}-100027.m4s`,
      detectedBy: ['manifest'],
      representation: {
        provider: 'bilibili',
        bvid: 'BV1OLDVIDEO',
        cid: '42001',
        key: 'bilibili:video:BV1OLDVIDEO:42001:100027',
        delivery: 'dash',
      },
    });
    const audio = asset('current-network-audio', 'audio', {
      url: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/92/72/40905737292/${family}-30216.m4s`,
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts([staleVideo, audio], {
      pageUrl: BILIBILI_PAGE,
      providerIdentity: 'bilibili:BV1CURRENT1:42001',
    });

    expect(product?.audioTracks[0]?.representation).toBeUndefined();
    expect(product?.capabilities.complete).toBe(false);
  });

  it('collapses Bilibili CDN mirrors into one logical quality', () => {
    const base = asset('video-base', 'video', {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/path/4148-1-30112.m4s?deadline=1',
      width: 1920,
      height: 1080,
      size: 30_000,
      detectedBy: ['manifest'],
      representation: {
        provider: 'bilibili',
        key: 'bilibili:video:112:7:30:sdr:',
        delivery: 'dash',
        id: 112,
        qn: 112,
        codecid: 7,
        frameRate: '30',
        dynamicRange: 'SDR',
        sourceIndex: 0,
      },
    });
    const backup = asset('video-backup', 'video', {
      url: 'https://upos-sz-mirrorali.bilivideo.com/path/4148-1-30112.m4s?deadline=2',
      width: 1920,
      height: 1080,
      size: 30_000,
      detectedBy: ['manifest', 'network'],
      requestHeaders: { referer: BILIBILI_PAGE },
      lastObservedAt: 999,
      representation: {
        provider: 'bilibili',
        key: 'bilibili:video:112:7:30:sdr:',
        delivery: 'dash',
        id: 112,
        qn: 112,
        codecid: 7,
        frameRate: '30',
        dynamicRange: 'SDR',
        sourceIndex: 1,
      },
    });

    const [product] = buildMediaProducts([base, backup], {
      pageUrl: BILIBILI_PAGE,
    });

    expect(product?.videoTracks).toHaveLength(1);
    expect(product?.qualities).toHaveLength(1);
    expect(product?.videoTracks[0]?.sources).toEqual([base, backup]);
    expect(product?.videoTracks[0]?.asset).toBe(base);
  });

  it('keeps every real Bilibili format distinct and prefers a compatible complete default', () => {
    const family = 'format-family-1';
    const video = (
      id: string,
      qn: number,
      codecid: number,
      codecs: string,
      frameRate: string,
      dynamicRange: 'SDR' | 'HDR' | 'Dolby Vision',
      description: string,
    ) =>
      asset(id, 'video', {
        url: `https://upos-video.bilivideo.com/upgcxcode/1/2/${family}-${qn}${codecid}.m4s?variant=${id}`,
        mime: `video/mp4; codecs="${codecs}"`,
        width: 1920,
        height: 1080,
        representation: {
          provider: 'bilibili',
          key: `bilibili:video:${qn}:${codecid}:${frameRate}:${dynamicRange.toLowerCase()}:`,
          delivery: 'dash',
          id: qn,
          qn,
          codecid,
          codecs,
          frameRate,
          description,
          newDescription: description,
          displayDescription: '1080P',
          dynamicRange,
          ...(dynamicRange === 'Dolby Vision' ? { dolbyVisionProfile: 8 } : {}),
          capabilities: {
            advertised: true,
            delivered: true,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
          sourceIndex: 0,
        },
      });
    const audio = (id: string, audioType: 'AAC' | 'Dolby' | 'FLAC', codecs: string) =>
      asset(`audio-${id}`, 'audio', {
        url: `https://upos-audio.bilivideo.com/upgcxcode/1/2/${family}-${id}.m4s`,
        mime: `audio/mp4; codecs="${codecs}"`,
        representation: {
          provider: 'bilibili',
          key: `bilibili:audio:${id}:${codecs}:unknown:sdr:${audioType.toLowerCase()}`,
          delivery: 'dash',
          id: Number(id),
          qn: Number(id),
          codecs,
          audioType,
          dynamicRange: 'SDR',
          sourceIndex: 0,
        },
      });
    const [product] = buildMediaProducts(
      [
        video('80-avc', 80, 7, 'avc1.640028', '30', 'SDR', '1080P 高清'),
        video('80-hevc', 80, 12, 'hev1.1.6.L120', '30', 'SDR', '1080P 高清'),
        video('112-avc', 112, 7, 'avc1.640028', '30', 'SDR', '1080P 高码率'),
        video('116-avc', 116, 7, 'avc1.640028', '60', 'SDR', '1080P 60帧'),
        video('125-hevc', 125, 12, 'hev1.2.4.L120', '60', 'HDR', 'HDR 真彩'),
        video('126-hevc', 126, 12, 'dvh1.08.07', '60', 'Dolby Vision', '杜比视界'),
        audio('30280', 'AAC', 'mp4a.40.2'),
        audio('30250', 'Dolby', 'ec-3'),
        audio('30251', 'FLAC', 'fLaC'),
      ],
      { pageUrl: BILIBILI_PAGE },
    );

    expect(product?.qualities).toHaveLength(6);
    expect(product?.qualities.map((quality) => quality.label)).toEqual(
      expect.arrayContaining([
        '1080P 高清 · AVC',
        '1080P 高清 · HEVC',
        '1080P 高码率 · AVC',
        '1080P 60帧 · AVC',
        'HDR 真彩 · HEVC',
        '杜比视界 · HEVC',
      ]),
    );
    expect(product?.audioTracks.map((track) => track.representation?.audioType)).toEqual([
      'FLAC',
      'Dolby',
      'AAC',
    ]);
    const selected = product?.qualities.find((quality) => quality.id === product.defaultQualityId);
    expect(selected?.description).toBe('1080P 高码率');
    expect(selected?.codec).toBe('AVC');
    expect(selected?.complete).toMatchObject({
      mode: 'merge',
      audioTrackId: product?.audioTracks.find((track) => track.representation?.audioType === 'AAC')
        ?.id,
    });
    const hdr = product?.qualities.find((candidate) => candidate.dynamicRange === 'HDR');
    expect(hdr?.videoOnlyTrackId).toBeDefined();
    expect(hdr?.complete).toMatchObject({ mode: 'merge' });
    expect(hdr?.mergeBlockedReason).toBeUndefined();
    const dolbyVision = product?.qualities.find(
      (candidate) => candidate.dynamicRange === 'Dolby Vision',
    );
    expect(dolbyVision?.videoOnlyTrackId).toBeDefined();
    expect(dolbyVision?.complete).toMatchObject({
      mode: 'merge',
      audioTrackId: product?.audioTracks.find((track) => track.representation?.audioType === 'AAC')
        ?.id,
    });
    expect(dolbyVision?.mergeBlockedReason).toBeUndefined();
    expect(productDownloadOptions(product!, dolbyVision?.id).map((option) => option.mode)).toEqual([
      'complete',
      'video',
      'audio',
    ]);
    expect(productDownloadOptions(product!, dolbyVision?.id)[0]).toMatchObject({
      available: true,
      detail: expect.stringContaining('保真预检'),
    });
    expect(
      productQualityOptions(product!).find((option) => option.id === dolbyVision?.id),
    ).toMatchObject({
      completeAvailable: true,
      completeCheckRequired: true,
      dynamicRange: 'Dolby Vision',
    });
    expect(productDownloadOptions(product!, dolbyVision?.id)[2]?.detail).toMatch(
      /原始音轨.*不转码/u,
    );

    const [withoutAac] = buildMediaProducts(
      [
        video('126-no-aac', 126, 12, 'dvh1.08.07', '60', 'Dolby Vision', '杜比视界'),
        audio('30250', 'Dolby', 'ec-3'),
      ],
      { pageUrl: BILIBILI_PAGE },
    );
    const withoutAacQuality = withoutAac?.qualities.find(
      (candidate) => candidate.dynamicRange === 'Dolby Vision',
    );
    expect(withoutAacQuality?.complete).toBeUndefined();

    const provisionalProfile = video(
      '126-profile-pending',
      126,
      12,
      'hev1.2.4.L153.B0',
      '60',
      'Dolby Vision',
      '杜比视界',
    );
    delete provisionalProfile.representation?.dolbyVisionProfile;
    const [profilePending] = buildMediaProducts(
      [provisionalProfile, audio('30280', 'AAC', 'mp4a.40.2')],
      { pageUrl: BILIBILI_PAGE },
    );
    expect(
      profilePending?.qualities.find((candidate) => candidate.dynamicRange === 'Dolby Vision')
        ?.complete,
    ).toMatchObject({ mode: 'merge' });

    const unsupportedProfile = video(
      '126-profile-7',
      126,
      12,
      'dvh1.07.06',
      '60',
      'Dolby Vision',
      '杜比视界',
    );
    if (unsupportedProfile.representation) {
      unsupportedProfile.representation.dolbyVisionProfile = 7;
    }
    const [profile7] = buildMediaProducts(
      [unsupportedProfile, audio('30280', 'AAC', 'mp4a.40.2')],
      { pageUrl: BILIBILI_PAGE },
    );
    const profile7Quality = profile7?.qualities.find(
      (candidate) => candidate.dynamicRange === 'Dolby Vision',
    );
    expect(profile7Quality?.complete).toBeUndefined();
    expect(profile7Quality?.mergeBlockedReason).toMatch(/Profile 5\/8/u);
    const blockedOptions = productDownloadOptions(profile7!, profile7Quality?.id);
    expect(blockedOptions.map((option) => option.mode)).toEqual(['complete', 'video', 'audio']);
    expect(blockedOptions[0]).toMatchObject({
      available: false,
      detail: expect.stringMatching(/Profile 5\/8/u),
    });
    expect(productQualityOptions(profile7!)[0]?.completeUnavailableReason).toMatch(/Profile 5\/8/u);
  });

  it('defaults to a delivered AVC SDR quality even when a higher-resolution AV1 track exists', () => {
    const video = (
      id: string,
      qn: number,
      codecid: number,
      codecs: string,
      width: number,
      height: number,
    ) =>
      asset(id, 'video', {
        url: `https://upos-video.bilivideo.com/upgcxcode/1/2/default-${id}.m4s`,
        mime: `video/mp4; codecs="${codecs}"`,
        width,
        height,
        representation: {
          provider: 'bilibili',
          key: `bilibili:video:${qn}:${codecid}:30:sdr:`,
          delivery: 'dash',
          id: qn,
          qn,
          codecid,
          codecs,
          dynamicRange: 'SDR',
          capabilities: {
            advertised: true,
            delivered: true,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
        },
      });
    const audio = asset('default-audio', 'audio', {
      url: 'https://upos-audio.bilivideo.com/upgcxcode/1/2/default-30280.m4s',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      representation: {
        provider: 'bilibili',
        key: 'bilibili:audio:30280:mp4a.40.2:unknown:sdr:aac',
        delivery: 'dash',
        id: 30280,
        qn: 30280,
        codecs: 'mp4a.40.2',
        audioType: 'AAC',
        dynamicRange: 'SDR',
        capabilities: {
          advertised: false,
          delivered: true,
          decodable: 'unknown',
          remuxable: 'unknown',
        },
      },
    });
    const [product] = buildMediaProducts(
      [
        video('4k-av1', 120, 13, 'av01.0.12M.10', 3840, 2160),
        video('1080-avc', 80, 7, 'avc1.640028', 1920, 1080),
        audio,
      ],
      { pageUrl: BILIBILI_PAGE },
    );

    const selected = product?.qualities.find((quality) => quality.id === product.defaultQualityId);
    expect(selected).toMatchObject({
      codec: 'AVC',
      dynamicRange: 'SDR',
      width: 1920,
      height: 1080,
    });
    expect(product?.defaultSelection.complete).toEqual(selected?.complete);
  });

  it('never exposes an advertised representation that was not actually delivered', () => {
    const advertisedOnly = asset('advertised-only-hdr', 'video', {
      url: 'https://upos-video.bilivideo.com/upgcxcode/1/2/advertised-only-125.m4s',
      mime: 'video/mp4; codecs="hev1.2.4.L120.90"',
      width: 3840,
      height: 2160,
      representation: {
        provider: 'bilibili',
        key: 'bilibili:video:125:12:60:hdr:',
        delivery: 'dash',
        qn: 125,
        codecid: 12,
        dynamicRange: 'HDR',
        capabilities: {
          advertised: true,
          delivered: false,
          decodable: 'unknown',
          remuxable: 'unsupported',
        },
      },
    });
    const delivered = asset('delivered-avc', 'video', {
      url: 'https://upos-video.bilivideo.com/upgcxcode/1/2/delivered-80.m4s',
      mime: 'video/mp4; codecs="avc1.640028"',
      width: 1920,
      height: 1080,
      representation: {
        provider: 'bilibili',
        key: 'bilibili:video:80:7:30:sdr:',
        delivery: 'dash',
        qn: 80,
        codecid: 7,
        dynamicRange: 'SDR',
        capabilities: {
          advertised: true,
          delivered: true,
          decodable: 'unknown',
          remuxable: 'unknown',
        },
      },
    });

    const [product] = buildMediaProducts([advertisedOnly, delivered], {
      pageUrl: BILIBILI_PAGE,
    });
    expect(product?.videoTracks.map((track) => track.asset.id)).toEqual(['delivered-avc']);
    expect(product?.qualities.map((quality) => quality.qn)).toEqual([80]);
  });

  it('lists only real quality variants, distinguishes codecs, and keeps unknown quality last', () => {
    const family = '41482390218-1';
    const video = (
      id: string,
      representation: string,
      codec: string,
      dimensions?: { width: number; height: number },
    ) =>
      asset(id, 'video', {
        url: `https://upos-sz-mirrorcos.bilivideo.com/path/${family}-${representation}.m4s`,
        mime: `video/mp4; codecs="${codec}"`,
        ...dimensions,
      });
    const audio = asset('quality-audio', 'audio', {
      url: `https://upos-sz-mirrorcos.bilivideo.com/path/${family}-30280.m4s`,
      mime: 'audio/mp4; codecs="mp4a.40.2"',
    });
    const [product] = buildMediaProducts(
      [
        video('avc-1080', '1001', 'avc1.640028', { width: 1920, height: 1080 }),
        video('hevc-1080', '1002', 'hev1.1.6.L120', { width: 1920, height: 1080 }),
        video('av1-1080', '1003', 'av01.0.08M.08', { width: 1920, height: 1080 }),
        video('avc-unknown', '1004', 'avc1.4d401f'),
        audio,
      ],
      { pageUrl: BILIBILI_PAGE },
    );

    expect(product?.qualities.map((quality) => quality.label)).toEqual([
      '1080P · AV1',
      '1080P · AVC',
      '1080P · HEVC',
      '未知画质 · AVC',
    ]);
    expect(product?.qualities.every((quality) => quality.complete != null)).toBe(true);
    expect(product?.defaultQualityId).toBe(product?.qualities[0]?.id);
    expect(product?.qualities.flatMap((quality) => quality.id)).not.toContain('avc-1080');
  });

  it('prefers a high-quality YouTube adaptive pair over a lower muxed format', () => {
    const muxed360 = asset('yt-18', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=18&sig=muxed',
      mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      width: 640,
      height: 360,
      duration: 90,
      size: 10_000,
    });
    const video1080 = asset('yt-137', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=137&sig=video',
      mime: 'video/mp4; codecs="avc1.640028"',
      width: 1920,
      height: 1080,
      duration: 90,
      size: 40_000,
    });
    const audio = asset('yt-140', 'audio', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=140&sig=audio',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      duration: 90.1,
      size: 5_000,
    });

    const [product] = buildMediaProducts([muxed360, video1080, audio], {
      pageUrl: 'https://www.youtube.com/watch?v=Current_01&index=3',
      pageTitle: 'YouTube video',
      duration: 90,
    });

    expect(product?.provider).toBe('youtube');
    expect(product?.videoTracks.map((track) => track.composition)).toEqual(['video-only', 'muxed']);
    expect(product?.defaultSelection.complete).toEqual({
      mode: 'merge',
      videoTrackId: product?.videoTracks[0]?.id,
      audioTrackId: product?.audioTracks[0]?.id,
    });
    expect(product?.capabilities).toEqual({
      audioOnly: true,
      videoOnly: true,
      complete: true,
    });
  });

  it('uses a YouTube muxed format directly when no separate pair exists', () => {
    const muxed = asset('yt-muxed', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=18&sig=muxed',
      mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
      width: 640,
      height: 360,
    });

    const [product] = buildMediaProducts([muxed], { pageUrl: YOUTUBE_PAGE });

    expect(product?.defaultSelection.complete).toEqual({
      mode: 'direct',
      videoTrackId: product?.videoTracks[0]?.id,
    });
    expect(product?.defaultSelection.videoTrackId).toBeUndefined();
    expect(product?.capabilities).toEqual({
      audioOnly: false,
      videoOnly: false,
      complete: true,
    });
  });

  it('pairs mixed-source YouTube tracks by provider stream id before manifest fallback', () => {
    const video = asset('yt-mixed-video', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=current-stream&itag=137&sig=video',
      mime: 'video/mp4; codecs="avc1.640028"',
      detectedBy: ['manifest'],
      width: 1920,
      height: 1080,
    });
    const audio = asset('yt-mixed-audio', 'audio', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r2.googlevideo.com/videoplayback?id=current-stream&itag=140&sig=audio',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts([video, audio], { pageUrl: YOUTUBE_PAGE });

    expect(product?.capabilities.complete).toBe(true);
    expect(product?.defaultSelection.complete?.mode).toBe('merge');
    expect(product?.videoTracks[0]?.streamIdentity).toBe(product?.audioTracks[0]?.streamIdentity);
  });

  it('selects the best silent representation independently from the best complete video', () => {
    const muxed1080 = asset('yt-muxed-1080', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=18&sig=muxed-hd',
      mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
      width: 1920,
      height: 1080,
    });
    const silent720 = asset('yt-silent-720', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main-stream&itag=136&sig=silent',
      mime: 'video/mp4; codecs="avc1.4d401f"',
      width: 1280,
      height: 720,
    });

    const [product] = buildMediaProducts([silent720, muxed1080], {
      pageUrl: YOUTUBE_PAGE,
    });

    expect(product?.defaultSelection.videoTrackId).toBe(product?.videoTracks[1]?.id);
    expect(product?.defaultSelection.complete).toEqual({
      mode: 'direct',
      videoTrackId: product?.videoTracks[0]?.id,
    });
  });

  it('rejects ad URLs and durations while preferring current manifest tracks', () => {
    const currentVideo = asset('current-video', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main&itag=137&sig=current',
      mime: 'video/mp4; codecs="avc1.640028"',
      width: 1920,
      height: 1080,
      duration: 120,
      detectedBy: ['manifest'],
    });
    const currentAudio = asset('current-audio', 'audio', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=main&itag=140&sig=current',
      duration: 120,
      detectedBy: ['manifest'],
    });
    const explicitAd = asset('ad-video', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=ad&itag=137&source=yt_ads',
      width: 3840,
      height: 2160,
      duration: 15,
      detectedBy: ['network'],
    });
    const shortUnlabelledAd = asset('short-video', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=ad2&itag=137',
      width: 3840,
      height: 2160,
      duration: 15,
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts(
      [explicitAd, shortUnlabelledAd, currentVideo, currentAudio],
      { pageUrl: YOUTUBE_PAGE, duration: 120 },
    );

    expect(product?.videoTracks.map((track) => track.asset.id)).toEqual(['current-video']);
    expect(product?.audioTracks.map((track) => track.asset.id)).toEqual(['current-audio']);
  });

  it('does not claim a complete product for an isolated silent fragment', () => {
    const silentVideo = asset('silent-video', 'video', {
      width: 1280,
      height: 720,
    });
    const [product] = buildMediaProducts([silentVideo], { pageUrl: BILIBILI_PAGE });

    expect(product?.capabilities).toEqual({
      audioOnly: false,
      videoOnly: true,
      complete: false,
    });
    expect(product?.defaultSelection.complete).toBeUndefined();
  });

  it('does not merge YouTube tracks from different stream identities', () => {
    const video = asset('yt-video', 'video', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=current-video&itag=137',
      mime: 'video/mp4; codecs="avc1.640028"',
      detectedBy: ['network'],
      width: 1920,
      height: 1080,
    });
    const audio = asset('yt-audio', 'audio', {
      pageUrl: YOUTUBE_PAGE,
      url: 'https://r1.googlevideo.com/videoplayback?id=other-video&itag=140',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts([video, audio], { pageUrl: YOUTUBE_PAGE });

    expect(product?.capabilities).toMatchObject({
      videoOnly: true,
      audioOnly: true,
      complete: false,
    });
    expect(product?.defaultSelection.complete).toBeUndefined();
  });

  it('does not merge unrelated Bilibili filename families without manifest evidence', () => {
    const video = asset('bili-video', 'video', {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/path/video-family-1-30112.m4s',
      detectedBy: ['network'],
    });
    const audio = asset('bili-audio', 'audio', {
      url: 'https://upos-sz-mirrorcos.bilivideo.com/path/audio-family-1-30280.m4s',
      detectedBy: ['network'],
    });

    const [product] = buildMediaProducts([video, audio], { pageUrl: BILIBILI_PAGE });

    expect(product?.capabilities.complete).toBe(false);
  });

  it('is input-pure and returns no product for non-media discoveries', () => {
    const image = Object.freeze(
      asset('image', 'image', {
        url: 'https://i0.hdslb.com/image.webp',
        mime: 'image/webp',
      }),
    );
    const html = Object.freeze(
      asset('html', 'video', {
        url: 'https://www.bilibili.com/video/BV1CURRENT1/',
        mime: 'text/html',
      }),
    );
    const input = Object.freeze([image, html]);

    expect(buildMediaProducts(input, { pageUrl: BILIBILI_PAGE })).toEqual([]);
    expect(input).toEqual([image, html]);
  });
});
