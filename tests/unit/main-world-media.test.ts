import { describe, expect, it } from 'vitest';

import {
  extractMainWorldMediaManifest,
  mergeValidatedMainWorldAssets,
  type MainWorldMediaManifestSnapshot,
  validateMainWorldMediaManifest,
} from '../../src/modules/detector/main-world-media';

const BILIBILI_PAGE = 'https://www.bilibili.com/video/BV1CURRENT01/?p=2&cid=24680';
const YOUTUBE_PAGE = 'https://www.youtube.com/watch?v=Current_01&list=playlist';

interface MainWorldFixture {
  globals?: Record<string, unknown>;
  playerResponse?: unknown;
}

function runAsInjectedFunction(
  pageUrl: string,
  fixture: MainWorldFixture = {},
): MainWorldMediaManifestSnapshot {
  const fakeWindow = {
    location: { href: pageUrl },
    ...fixture.globals,
  };
  const fakeDocument = {
    getElementById(id: string): unknown {
      if (id !== 'movie_player' || fixture.playerResponse == null) return null;
      return { getPlayerResponse: () => fixture.playerResponse };
    },
  };
  const invoke = Function(
    'window',
    'document',
    'URL',
    `"use strict"; return (${extractMainWorldMediaManifest.toString()})();`,
  ) as (pageWindow: unknown, pageDocument: unknown, urlConstructor: typeof URL) => unknown;
  return invoke(fakeWindow, fakeDocument, URL) as MainWorldMediaManifestSnapshot;
}

function currentYouTubeResponse(): Record<string, unknown> {
  return {
    videoDetails: { videoId: 'Current_01', lengthSeconds: '95' },
    streamingData: {
      formats: [
        {
          url: 'https://rr1---sn.example.googlevideo.com/videoplayback?id=current&itag=22',
          mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
          width: 1280,
          height: 720,
          contentLength: '123456',
        },
      ],
      adaptiveFormats: [
        {
          url: 'https://rr1---sn.example.googlevideo.com/videoplayback?id=current&itag=140',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          approxDurationMs: '95050',
          contentLength: '23456',
        },
        {
          signatureCipher: 'url=https%3A%2F%2Fexample.invalid%2Fprotected',
          mimeType: 'video/mp4',
        },
      ],
    },
  };
}

function cachedBilibiliEntry(
  bvid: string,
  cid: string,
  label: string,
  capturedAt: number,
): Record<string, unknown> {
  return {
    version: 1,
    bvid,
    cid,
    capturedAt,
    candidates: [
      {
        url: `https://upos-video.bilivideo.com/upgcxcode/1/2/${label}-100145.m4s`,
        kind: 'video',
        mime: 'video/mp4',
      },
      {
        url: `https://upos-audio.bilivideo.com/upgcxcode/1/2/${label}-30216.m4s`,
        kind: 'audio',
        mime: 'audio/mp4',
      },
    ],
  };
}

describe('MAIN-world media manifest extraction', () => {
  it('extracts only structured media metadata for the current Bilibili part', () => {
    const snapshot = runAsInjectedFunction(BILIBILI_PAGE, {
      globals: {
        __playinfo__: {
          bvid: 'BV1CURRENT01',
          cid: 24680,
          secretCookie: 'must-not-leak',
          data: {
            timelength: 36_500,
            dash: {
              video: [
                {
                  id: 116,
                  codecid: 13,
                  baseUrl:
                    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/asset-1-100145.m4s?deadline=1',
                  backupUrl: [
                    'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/asset-1-100145.m4s',
                  ],
                  mimeType: 'video/mp4',
                  codecs: 'av01.0.08M.08',
                  frameRate: '60',
                  bandwidth: 8_000_000,
                  width: 1920,
                  height: 1080,
                  contentLength: '9000',
                },
              ],
              audio: [
                {
                  base_url:
                    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/asset-1-30216.m4s?deadline=1',
                  mime_type: 'audio/mp4',
                  content_length: 1000,
                },
              ],
            },
            support_formats: [
              {
                quality: 116,
                new_description: '1080P 60帧',
                display_desc: '1080P',
                superscript: '60帧',
              },
              { quality: 120, new_description: '4K 超清' },
            ],
          },
        },
      },
    });

    expect(snapshot.provider).toBe('bilibili');
    expect(snapshot.pageUrl).toBe('https://www.bilibili.com/video/BV1CURRENT01/?p=2&cid=24680');
    expect(snapshot.identity).toEqual({ bvid: 'BV1CURRENT01', cid: '24680' });
    expect(snapshot.candidates).toHaveLength(3);
    expect(snapshot.candidates.map((candidate) => candidate.kind)).toEqual([
      'video',
      'video',
      'audio',
    ]);
    expect(snapshot.candidates[0]).toMatchObject({
      mime: 'video/mp4; codecs="av01.0.08M.08"',
      width: 1920,
      height: 1080,
      duration: 36.5,
      size: 9000,
      representation: {
        id: 116,
        qn: 116,
        codecid: 13,
        codecs: 'av01.0.08M.08',
        frameRate: '60',
        bandwidth: 8_000_000,
        description: '1080P 60帧',
        displayDescription: '1080P',
        superscript: '60帧',
        dynamicRange: 'SDR',
        sourceIndex: 0,
      },
    });
    expect(snapshot.candidates[1]?.representation).toMatchObject({
      key: snapshot.candidates[0]?.representation?.key,
      sourceIndex: 2,
    });
    expect(JSON.stringify(snapshot)).not.toContain('4K 超清');
    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak');
  });

  it('preserves delivered Dolby Vision codec/profile evidence without coupling Dolby audio', () => {
    const snapshot = runAsInjectedFunction(BILIBILI_PAGE, {
      globals: {
        __playinfo__: {
          bvid: 'BV1CURRENT01',
          cid: 24680,
          data: {
            support_formats: [{ quality: 126, new_description: '杜比视界' }],
            dash: {
              video: [
                {
                  id: 126,
                  codecid: 12,
                  codecs: 'dvh1.08.07',
                  baseUrl: 'https://upos-video.bilivideo.com/upgcxcode/1/2/dolby-video-126.m4s',
                  mimeType: 'video/mp4',
                  width: 3840,
                  height: 2160,
                },
              ],
              dolby: {
                audio: [
                  {
                    id: 30250,
                    codecs: 'ec-3',
                    baseUrl: 'https://upos-audio.bilivideo.com/upgcxcode/1/2/dolby-audio-30250.m4s',
                    mimeType: 'audio/mp4',
                  },
                ],
              },
            },
          },
        },
      },
    });

    const video = snapshot.candidates.find((candidate) => candidate.kind === 'video');
    const audio = snapshot.candidates.find((candidate) => candidate.kind === 'audio');
    expect(video?.representation).toMatchObject({
      codecs: 'dvh1.08.07',
      codecProfile: 'dvh1.08.07',
      dolbyVisionProfile: 8,
      dynamicRange: 'Dolby Vision',
      dynamicRangeEvidence: expect.arrayContaining([
        expect.objectContaining({ source: 'quality-number', range: 'Dolby Vision' }),
        expect.objectContaining({ source: 'codec', range: 'Dolby Vision' }),
      ]),
      capabilities: {
        advertised: true,
        delivered: true,
        decodable: 'unknown',
        remuxable: 'unknown',
      },
    });
    expect(audio?.representation).toMatchObject({
      codecs: 'ec-3',
      audioType: 'Dolby',
      dynamicRange: 'SDR',
    });

    const validated = validateMainWorldMediaManifest(snapshot, { pageUrl: BILIBILI_PAGE });
    expect(video?.representation).toBeDefined();
    expect(validated?.assets.find((asset) => asset.kind === 'video')?.representation).toEqual(
      video!.representation,
    );
  });

  it('uses the document-start playurl cache when __playinfo__ is absent', () => {
    const snapshot = runAsInjectedFunction('https://www.bilibili.com/video/BV1CURRENT01/?p=2', {
      globals: {
        __INITIAL_STATE__: {
          videoData: {
            bvid: 'BV1CURRENT01',
            pages: [
              { page: 1, cid: 11111 },
              { page: 2, cid: 24680 },
            ],
          },
        },
        __foxfetchBilibiliManifestCacheV1__: {
          version: 1,
          entries: [
            {
              version: 1,
              bvid: 'BV1CURRENT01',
              cid: '24680',
              part: 2,
              capturedAt: 200,
              candidates: [
                {
                  url: 'https://upos-video.bilivideo.com/upgcxcode/1/2/item-100145.m4s',
                  kind: 'video',
                  mime: 'video/mp4',
                  width: 1920,
                  height: 1080,
                  duration: 36,
                },
                {
                  url: 'https://upos-audio.mountaintoys.cn/upgcxcode/1/2/item-30216.m4s',
                  kind: 'audio',
                  mime: 'audio/mp4',
                  duration: 36,
                },
              ],
            },
            {
              version: 1,
              bvid: 'BV1CURRENT01',
              cid: '11111',
              part: 1,
              capturedAt: 300,
              candidates: [
                {
                  url: 'https://upos-stale.bilivideo.com/upgcxcode/1/2/stale-100145.m4s',
                  kind: 'video',
                  mime: 'video/mp4',
                },
              ],
            },
          ],
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1CURRENT01', cid: '24680' });
    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.candidates.map((candidate) => candidate.kind)).toEqual(['video', 'audio']);
    expect(JSON.stringify(snapshot)).not.toContain('stale-100145');
  });

  it('uses a prefetched manifest after SPA navigation even while page globals are stale', () => {
    const snapshot = runAsInjectedFunction('https://www.bilibili.com/video/BV1PREFETCH2/', {
      globals: {
        __INITIAL_STATE__: {
          videoData: { bvid: 'BV1CURRENT01', cid: 11111 },
        },
        __playinfo__: {
          bvid: 'BV1CURRENT01',
          cid: 11111,
          data: {
            dash: {
              video: [
                {
                  baseUrl: 'https://upos-stale.bilivideo.com/upgcxcode/1/2/stale-100145.m4s',
                  mimeType: 'video/mp4',
                },
              ],
            },
          },
        },
        __foxfetchBilibiliManifestCacheV1__: {
          version: 1,
          entries: [cachedBilibiliEntry('BV1PREFETCH2', '456', 'prefetched', 200)],
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1PREFETCH2', cid: '456' });
    expect(snapshot.candidates.map((candidate) => candidate.kind)).toEqual(['video', 'audio']);
    expect(JSON.stringify(snapshot)).toContain('prefetched-100145');
    expect(JSON.stringify(snapshot)).not.toContain('stale-100145');
  });

  it('matches a multi-part video by explicit CID rather than capture-time part metadata', () => {
    const firstPart = cachedBilibiliEntry('BV1MULTIPART', '111', 'part-one', 300);
    const secondPart = cachedBilibiliEntry('BV1MULTIPART', '222', 'part-two', 200);
    firstPart.part = 2;
    secondPart.part = 1;
    const snapshot = runAsInjectedFunction('https://www.bilibili.com/video/BV1MULTIPART/?p=2', {
      globals: {
        __INITIAL_STATE__: {
          videoData: {
            bvid: 'BV1MULTIPART',
            pages: [
              { page: 1, cid: 111 },
              { page: 2, cid: 222 },
            ],
          },
        },
        __foxfetchBilibiliManifestCacheV1__: {
          version: 1,
          entries: [firstPart, secondPart],
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1MULTIPART', cid: '222' });
    expect(JSON.stringify(snapshot)).toContain('part-two-100145');
    expect(JSON.stringify(snapshot)).not.toContain('part-one-100145');
  });

  it('does not guess between multiple cached CIDs when the current CID is unknown', () => {
    const snapshot = runAsInjectedFunction('https://www.bilibili.com/video/BV1AMBIGUOUS/', {
      globals: {
        __foxfetchBilibiliManifestCacheV1__: {
          version: 1,
          entries: [
            cachedBilibiliEntry('BV1AMBIGUOUS', '111', 'first', 300),
            cachedBilibiliEntry('BV1AMBIGUOUS', '222', 'second', 400),
          ],
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1AMBIGUOUS' });
    expect(snapshot.candidates).toEqual([]);
  });

  it('selects only route C from out-of-order prefetched A-B-C cache entries', () => {
    const snapshot = runAsInjectedFunction('https://www.bilibili.com/video/BV1ROUTEC/?cid=303', {
      globals: {
        __foxfetchBilibiliManifestCacheV1__: {
          version: 1,
          entries: [
            cachedBilibiliEntry('BV1ROUTEB', '202', 'route-b-newest', 500),
            cachedBilibiliEntry('BV1ROUTEA', '101', 'route-a', 300),
            cachedBilibiliEntry('BV1ROUTEC', '303', 'route-c-oldest', 100),
          ],
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1ROUTEC', cid: '303' });
    expect(snapshot.candidates).toHaveLength(2);
    expect(JSON.stringify(snapshot)).toContain('route-c-oldest-100145');
    expect(JSON.stringify(snapshot)).not.toContain('route-b-newest');
    expect(JSON.stringify(snapshot)).not.toContain('route-a');
  });

  it('does not reuse stale Bilibili playinfo after an SPA route change', () => {
    const snapshot = runAsInjectedFunction(BILIBILI_PAGE, {
      globals: {
        __playinfo__: {
          bvid: 'BV1STALE0001',
          cid: 111,
          data: {
            dash: {
              video: [
                {
                  baseUrl: 'https://cdn.bilivideo.com/stale-10001.m4s',
                  mimeType: 'video/mp4',
                },
              ],
            },
          },
        },
      },
    });

    expect(snapshot.identity).toEqual({ bvid: 'BV1CURRENT01' });
    expect(snapshot.candidates).toEqual([]);
  });

  it('uses the selected Bilibili part CID to reject stale same-video playinfo', () => {
    const snapshot = runAsInjectedFunction(
      'https://www.bilibili.com/video/BV1CURRENT01/?p=2&from=tracking',
      {
        globals: {
          __INITIAL_STATE__: {
            videoData: {
              bvid: 'BV1CURRENT01',
              pages: [
                { page: 1, cid: 11111 },
                { page: 2, cid: 22222 },
              ],
            },
          },
          __playinfo__: {
            bvid: 'BV1CURRENT01',
            cid: 11111,
            data: {
              dash: {
                video: [
                  {
                    baseUrl: 'https://cdn.bilivideo.com/stale-10001.m4s',
                    mimeType: 'video/mp4',
                  },
                ],
              },
            },
          },
        },
      },
    );

    expect(snapshot.pageUrl).toBe('https://www.bilibili.com/video/BV1CURRENT01/?p=2');
    expect(snapshot.identity).toEqual({ bvid: 'BV1CURRENT01', cid: '22222' });
    expect(snapshot.candidates).toEqual([]);
  });

  it('prefers the current YouTube player response and ignores cipher-only formats', () => {
    const snapshot = runAsInjectedFunction(YOUTUBE_PAGE, {
      playerResponse: currentYouTubeResponse(),
      globals: {
        ytInitialPlayerResponse: {
          videoDetails: { videoId: 'Stale_0001' },
          streamingData: {
            formats: [
              {
                url: 'https://rr1.googlevideo.com/videoplayback?id=stale&itag=18',
                mimeType: 'video/mp4',
              },
            ],
          },
        },
      },
    });

    expect(snapshot.provider).toBe('youtube');
    expect(snapshot.pageUrl).toBe('https://www.youtube.com/watch?v=Current_01');
    expect(snapshot.identity).toEqual({ videoId: 'Current_01' });
    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.candidates[0]).toMatchObject({
      kind: 'video',
      duration: 95,
      width: 1280,
      height: 720,
    });
    expect(snapshot.candidates[1]).toMatchObject({ kind: 'audio', duration: 95.05 });
  });

  it('reads a serialized YouTube config response when the player API is unavailable', () => {
    const snapshot = runAsInjectedFunction(YOUTUBE_PAGE, {
      globals: {
        ytplayer: {
          config: {
            args: { player_response: JSON.stringify(currentYouTubeResponse()) },
          },
        },
      },
    });

    expect(snapshot.identity).toEqual({ videoId: 'Current_01' });
    expect(snapshot.candidates).toHaveLength(2);
  });
});

describe('MAIN-world media manifest validation', () => {
  it('keeps validated MAIN assets when a later isolated Agent snapshot omits them', () => {
    const common = {
      pageUrl: BILIBILI_PAGE,
      pageTitle: '当前视频',
      frameId: 0,
      downloadable: true,
      discoveredAt: 100,
    };
    const overlappingUrl = 'https://cdn.bilivideo.com/upgcxcode/current-100145.m4s';
    const merged = mergeValidatedMainWorldAssets(
      [
        {
          ...common,
          id: 'shared-video',
          url: overlappingUrl,
          kind: 'video',
          mime: 'video/mp4',
          detectedBy: ['performance'],
        },
      ],
      [
        {
          ...common,
          id: 'shared-video',
          url: overlappingUrl,
          kind: 'video',
          mime: 'video/mp4',
          duration: 36,
          detectedBy: ['manifest'],
        },
        {
          ...common,
          id: 'main-audio',
          url: 'https://cdn.bilivideo.com/upgcxcode/current-30216.m4s',
          kind: 'audio',
          mime: 'audio/mp4',
          detectedBy: ['manifest'],
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((asset) => asset.id === 'shared-video')).toMatchObject({
      duration: 36,
      detectedBy: ['performance', 'manifest'],
    });
    expect(merged.some((asset) => asset.id === 'main-audio')).toBe(true);
  });

  it('accepts a current Bilibili envelope that enriches a cid-less route with its CID', () => {
    const browserPage = 'https://www.bilibili.com/video/BV1CURRENT01/?p=2&spm_id_from=tracking';
    const validated = validateMainWorldMediaManifest(
      {
        version: 1,
        provider: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BV1CURRENT01/?p=2&cid=24680',
        identity: { bvid: 'BV1CURRENT01', cid: '24680' },
        candidates: [
          {
            url: 'https://cdn.bilivideo.com/upgcxcode/current-100145.m4s',
            kind: 'video',
            mime: 'video/mp4',
          },
        ],
      },
      { pageUrl: browserPage },
    );

    expect(validated?.identity).toEqual({ bvid: 'BV1CURRENT01', cid: '24680' });
    expect(validated?.assets).toHaveLength(1);
  });

  it('converts allowed Bilibili candidates and drops hostile or inconsistent candidates', () => {
    const validUrl =
      'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/asset-1-100145.m4s?deadline=1';
    const validated = validateMainWorldMediaManifest(
      {
        version: 1,
        provider: 'bilibili',
        pageUrl: BILIBILI_PAGE,
        identity: { bvid: 'bv1current01', cid: '024680' },
        candidates: [
          {
            url: validUrl,
            kind: 'video',
            mime: 'video/mp4',
            width: 1920,
            height: 1080,
            duration: 36.5,
          },
          {
            url: 'https://bilivideo.com.evil.example/asset-1-100145.m4s',
            kind: 'video',
            mime: 'video/mp4',
          },
          {
            url: 'http://cdn.bilivideo.com/asset-1-30216.m4s',
            kind: 'audio',
            mime: 'audio/mp4',
          },
          {
            url: 'https://cdn.bilivideo.com/asset-1-30216.m4s',
            kind: 'audio',
            mime: 'video/mp4',
          },
        ],
      },
      { pageUrl: BILIBILI_PAGE, pageTitle: '当前视频', discoveredAt: 1234 },
    );

    expect(validated?.identity).toEqual({ bvid: 'BV1CURRENT01', cid: '24680' });
    expect(validated?.assets).toHaveLength(1);
    expect(validated?.assets[0]).toMatchObject({
      url: validUrl,
      pageTitle: '当前视频',
      kind: 'video',
      mime: 'video/mp4',
      detectedBy: ['manifest'],
      downloadable: true,
      discoveredAt: 1234,
    });
  });

  it('rejects stale route and identity envelopes instead of accepting their candidates', () => {
    const base = {
      version: 1,
      provider: 'bilibili',
      pageUrl: BILIBILI_PAGE,
      identity: { bvid: 'BV1CURRENT01', cid: '24680' },
      candidates: [],
    };

    expect(
      validateMainWorldMediaManifest(
        { ...base, pageUrl: 'https://www.bilibili.com/video/BV1OTHER0001/?p=2&cid=24680' },
        { pageUrl: BILIBILI_PAGE },
      ),
    ).toBeUndefined();
    expect(
      validateMainWorldMediaManifest(
        { ...base, identity: { bvid: 'BV1OTHER0001', cid: '24680' } },
        { pageUrl: BILIBILI_PAGE },
      ),
    ).toBeUndefined();
  });

  it('allows only strict YouTube media hosts and videoplayback routes', () => {
    const validated = validateMainWorldMediaManifest(
      {
        version: 1,
        provider: 'youtube',
        pageUrl: YOUTUBE_PAGE,
        identity: { videoId: 'Current_01' },
        candidates: [
          {
            url: 'https://rr1---sn.example.googlevideo.com/videoplayback?id=current&itag=140',
            kind: 'audio',
            mime: 'audio/mp4',
          },
          {
            url: 'https://googlevideo.com.evil.example/videoplayback?id=current&itag=140',
            kind: 'audio',
            mime: 'audio/mp4',
          },
          {
            url: 'https://rr1.googlevideo.com/not-videoplayback?id=current&itag=140',
            kind: 'audio',
            mime: 'audio/mp4',
          },
          {
            url: 'https://rr1.googlevideo.com/videoplayback?itag=140',
            kind: 'audio',
            mime: 'audio/mp4',
          },
        ],
      },
      { pageUrl: YOUTUBE_PAGE },
    );

    expect(validated?.provider).toBe('youtube');
    expect(validated?.assets).toHaveLength(1);
    expect(validated?.assets[0]?.kind).toBe('audio');
  });
});
