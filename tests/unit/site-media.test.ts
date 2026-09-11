import { describe, expect, it } from 'vitest';

import {
  extractSiteMediaCandidatesFromScripts,
  scanDocument,
  siteMediaRouteKey,
} from '../../src/modules/detector';

describe('inline site media metadata', () => {
  it('uses stable video identities for YouTube and Bilibili SPA routes', () => {
    expect(siteMediaRouteKey('https://www.youtube.com/watch?v=Current_01&list=RD1&index=3')).toBe(
      siteMediaRouteKey('https://www.youtube.com/watch?v=Current_01&list=RD2&t=30'),
    );
    expect(siteMediaRouteKey('https://www.youtube.com/watch?v=Other_02')).not.toBe(
      siteMediaRouteKey('https://www.youtube.com/watch?v=Current_01'),
    );
    expect(siteMediaRouteKey('https://www.bilibili.com/video/BV1CURRENT1?p=1')).not.toBe(
      siteMediaRouteKey('https://www.bilibili.com/video/BV1CURRENT1?p=2'),
    );
  });

  it('extracts Bilibili DASH video and audio base URLs without executing page code', () => {
    const playInfo = {
      data: {
        bvid: 'BV1CURRENT1',
        timelength: 125_500,
        dash: {
          video: [
            {
              baseUrl:
                'https://upos-video.bilivideo.com/upgcxcode/test/track-80.m4s?deadline=1&upsig=video',
              mimeType: 'video/mp4',
              width: 1920,
              height: 1080,
            },
          ],
          audio: [
            {
              base_url:
                'https://upos-audio.bilivideo.com/upgcxcode/test/track-30216.m4s?deadline=1&upsig=audio',
              mime_type: 'audio/mp4',
              contentLength: '4096',
            },
          ],
        },
      },
    };
    const source = `window.__playinfo__ = ${JSON.stringify(playInfo)};`;

    expect(
      extractSiteMediaCandidatesFromScripts(
        [source],
        'https://www.bilibili.com/video/BV1CURRENT1/',
      ),
    ).toEqual([
      {
        url: 'https://upos-video.bilivideo.com/upgcxcode/test/track-80.m4s?deadline=1&upsig=video',
        source: 'manifest',
        kind: 'video',
        mime: 'video/mp4',
        width: 1920,
        height: 1080,
        duration: 125.5,
        representation: {
          provider: 'bilibili',
          bvid: 'BV1CURRENT1',
          key: 'bilibili:video:unknown:unknown:unknown:sdr:',
          delivery: 'dash',
          dynamicRange: 'SDR',
          dynamicRangeEvidence: [{ source: 'default-sdr', range: 'SDR' }],
          capabilities: {
            advertised: false,
            delivered: true,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
          sourceIndex: 0,
        },
      },
      {
        url: 'https://upos-audio.bilivideo.com/upgcxcode/test/track-30216.m4s?deadline=1&upsig=audio',
        source: 'manifest',
        kind: 'audio',
        mime: 'audio/mp4',
        duration: 125.5,
        size: 4096,
        representation: {
          provider: 'bilibili',
          bvid: 'BV1CURRENT1',
          key: 'bilibili:audio:unknown:unknown:unknown:sdr:aac',
          delivery: 'dash',
          dynamicRange: 'SDR',
          dynamicRangeEvidence: [{ source: 'default-sdr', range: 'SDR' }],
          capabilities: {
            advertised: false,
            delivered: true,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
          audioType: 'AAC',
          sourceIndex: 1,
        },
      },
    ]);
  });

  it('keeps each Bilibili main URL before unique backups and accepts a backup-only track', () => {
    const source = `window.__playinfo__=${JSON.stringify({
      data: {
        dash: {
          video: [
            {
              baseUrl: 'https://primary.bilivideo.com/upgcxcode/test/video.m4s?token=primary',
              base_url: 'https://primary.bilivideo.com/upgcxcode/test/video.m4s?token=primary',
              backupUrl: [
                'https://primary.bilivideo.com/upgcxcode/test/video.m4s?token=primary',
                'https://backup-a.bilivideo.cn/upgcxcode/test/video.m4s?token=a',
              ],
              backup_url: [
                'https://backup-a.bilivideo.cn/upgcxcode/test/video.m4s?token=a',
                'https://upos-backup-b.bilivideo.com/upgcxcode/test/video.m4s?token=b',
              ],
              mimeType: 'video/mp4',
              width: 1920,
              height: 1080,
            },
            {
              baseUrl: 'javascript:alert(1)',
              backupUrl:
                'https://upos-backup.mountaintoys.cn/upgcxcode/test/video.m4s?token=fallback',
              mimeType: 'video/mp4',
              width: 1280,
              height: 720,
            },
          ],
        },
      },
    })}`;

    const candidates = extractSiteMediaCandidatesFromScripts(
      [source],
      'https://www.bilibili.com/video/BV1CURRENT1/',
    );

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      'https://primary.bilivideo.com/upgcxcode/test/video.m4s?token=primary',
      'https://backup-a.bilivideo.cn/upgcxcode/test/video.m4s?token=a',
      'https://upos-backup-b.bilivideo.com/upgcxcode/test/video.m4s?token=b',
      'https://upos-backup.mountaintoys.cn/upgcxcode/test/video.m4s?token=fallback',
    ]);
    expect(candidates.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          kind: 'video',
          mime: 'video/mp4',
          width: 1920,
          height: 1080,
        }),
      ),
    );
  });

  it('rejects a Bilibili response that explicitly belongs to another video', () => {
    const source = `window.__playinfo__=${JSON.stringify({
      data: {
        bvid: 'BV1OTHER999',
        dash: {
          video: [{ baseUrl: 'https://cdn.example/other.m4s', mimeType: 'video/mp4' }],
        },
      },
    })}`;

    expect(
      extractSiteMediaCandidatesFromScripts(
        [source],
        'https://www.bilibili.com/video/BV1CURRENT1/',
      ),
    ).toEqual([]);
  });

  it('rejects Bilibili media that explicitly belongs to another page cid', () => {
    const source = `window.__playinfo__=${JSON.stringify({
      data: {
        cid: '00123',
        dash: {
          video: [
            {
              baseUrl: 'https://cdn.bilivideo.com/upgcxcode/test/current.m4s',
              mimeType: 'video/mp4',
            },
          ],
        },
      },
    })}`;

    expect(
      extractSiteMediaCandidatesFromScripts(
        [source],
        'https://www.bilibili.com/video/BV1CURRENT1/?cid=123',
      ),
    ).toHaveLength(1);
    expect(
      extractSiteMediaCandidatesFromScripts(
        [source],
        'https://www.bilibili.com/video/BV1CURRENT1/?cid=456',
      ),
    ).toEqual([]);
  });

  it('keeps only direct YouTube URLs for the current video', () => {
    const currentResponse = {
      videoDetails: { videoId: 'Current_01', lengthSeconds: '90' },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://r1.googlevideo.com/videoplayback?itag=18&sig=muxed',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            width: 640,
            height: 360,
            contentLength: '123456',
          },
        ],
        adaptiveFormats: [
          {
            itag: 140,
            url: 'https://r1.googlevideo.com/videoplayback?itag=140&sig=audio',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            approxDurationMs: '90123',
            contentLength: '6543',
          },
          {
            itag: 137,
            signatureCipher: 'url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback',
            mimeType: 'video/mp4; codecs="avc1.640028"',
          },
        ],
      },
    };
    const advertisement = {
      videoDetails: { videoId: 'Advertisement_02', lengthSeconds: '15' },
      streamingData: {
        formats: [
          {
            url: 'https://r1.googlevideo.com/videoplayback?itag=18&sig=ad',
            mimeType: 'video/mp4',
          },
        ],
      },
    };

    const candidates = extractSiteMediaCandidatesFromScripts(
      [
        `var ytInitialPlayerResponse = ${JSON.stringify(advertisement)};`,
        `var ytInitialPlayerResponse = ${JSON.stringify(currentResponse)};`,
      ],
      'https://www.youtube.com/watch?v=Current_01',
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        url: expect.stringContaining('sig=muxed'),
        kind: 'video',
        mime: expect.stringContaining('video/mp4'),
        width: 640,
        height: 360,
        duration: 90,
        size: 123_456,
      }),
      expect.objectContaining({
        url: expect.stringContaining('sig=audio'),
        kind: 'audio',
        mime: expect.stringContaining('audio/mp4'),
        duration: 90.123,
        size: 6_543,
      }),
    ]);
    expect(candidates).toHaveLength(2);
  });

  it('does not invent a URL for cipher-only YouTube formats or malformed assignments', () => {
    const response = {
      videoDetails: { videoId: 'Current_01' },
      streamingData: {
        adaptiveFormats: [
          {
            signatureCipher: 's=secret&url=https%3A%2F%2Fr.example%2Fvideoplayback',
            mimeType: 'video/mp4',
          },
        ],
      },
    };

    expect(
      extractSiteMediaCandidatesFromScripts(
        [
          'var ytInitialPlayerResponse = {notJson:true};',
          `var ytInitialPlayerResponse = ${JSON.stringify(response)};`,
        ],
        'https://www.youtube.com/watch?v=Current_01',
      ),
    ).toEqual([]);
  });

  it('integrates direct inline metadata into MediaAsset with manifest provenance', () => {
    const playInfo = {
      data: {
        timelength: 10_000,
        dash: {
          video: [
            {
              baseUrl: 'https://cdn.bilivideo.com/upgcxcode/test/video.m4s?token=signed',
              mimeType: 'video/mp4',
              width: 1280,
              height: 720,
            },
          ],
        },
      },
    };
    const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
    try {
      Object.defineProperty(document, 'URL', {
        configurable: true,
        value: 'https://www.bilibili.com/video/BV1CURRENT1/',
      });
      document.body.innerHTML = `<script>window.__playinfo__=${JSON.stringify(playInfo)};</script>`;

      expect(scanDocument(document, { performanceEntries: [], now: () => 321 })).toEqual([
        expect.objectContaining({
          url: 'https://cdn.bilivideo.com/upgcxcode/test/video.m4s?token=signed',
          kind: 'video',
          mime: 'video/mp4',
          extension: 'mp4',
          width: 1280,
          height: 720,
          duration: 10,
          detectedBy: ['manifest'],
          downloadable: true,
          discoveredAt: 321,
        }),
      ]);
    } finally {
      document.body.replaceChildren();
      if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
      else Reflect.deleteProperty(document, 'URL');
    }
  });

  it('does not reinterpret an unchanged Bilibili SPA script as the next video', () => {
    const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
    const script = document.createElement('script');
    script.textContent = `window.__playinfo__=${JSON.stringify({
      data: {
        dash: {
          video: [
            {
              baseUrl: 'https://cdn.bilivideo.com/upgcxcode/test/old.m4s',
              mimeType: 'video/mp4',
            },
          ],
        },
      },
    })}`;
    document.body.append(script);
    try {
      Object.defineProperty(document, 'URL', {
        configurable: true,
        value: 'https://www.bilibili.com/video/BV1OLDVIDEO1/',
      });
      expect(scanDocument(document, { performanceEntries: [] })).toEqual([
        expect.objectContaining({ url: 'https://cdn.bilivideo.com/upgcxcode/test/old.m4s' }),
      ]);

      Object.defineProperty(document, 'URL', {
        configurable: true,
        value: 'https://www.bilibili.com/video/BV1NEWVIDEO2/',
      });
      expect(scanDocument(document, { performanceEntries: [] })).toEqual([]);

      script.textContent = `window.__playinfo__=${JSON.stringify({
        data: {
          dash: {
            video: [
              {
                baseUrl: 'https://cdn.bilivideo.com/upgcxcode/test/new.m4s',
                mimeType: 'video/mp4',
              },
            ],
          },
        },
      })}`;
      expect(scanDocument(document, { performanceEntries: [] })).toEqual([
        expect.objectContaining({ url: 'https://cdn.bilivideo.com/upgcxcode/test/new.m4s' }),
      ]);
    } finally {
      script.remove();
      if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
      else Reflect.deleteProperty(document, 'URL');
    }
  });

  it('rejects non-http media URLs and ignores assignments on unrelated sites', () => {
    const playInfo = {
      data: {
        dash: {
          video: [
            { baseUrl: 'javascript:alert(1)', mimeType: 'video/mp4' },
            { baseUrl: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' },
          ],
        },
      },
    };
    const source = `window.__playinfo__=${JSON.stringify(playInfo)}`;

    expect(
      extractSiteMediaCandidatesFromScripts(
        [source],
        'https://www.bilibili.com/video/BV1CURRENT1/',
      ),
    ).toEqual([]);
    expect(
      extractSiteMediaCandidatesFromScripts([source], 'https://attacker.example/watch'),
    ).toEqual([]);
  });
});
