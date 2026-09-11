import { describe, expect, it } from 'vitest';

import {
  isAllowedBilibiliMediaUrl,
  isBilibiliPlayurlApiUrl,
  parseBilibiliMediaManifest,
  sniffIsoBmffTrackKind,
} from '../../src/modules/detector/bilibili-media';
import {
  classifyBilibiliDynamicRange,
  sniffBilibiliIsoBmffDynamicRange,
} from '../../src/modules/detector/bilibili-dynamic-range';
import {
  clearBilibiliTrackProbeCache,
  sniffBilibiliNetworkTrack,
} from '../../src/modules/network/bilibili-track-sniffer';

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payloadLength = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const output = new Uint8Array(8 + payloadLength);
  new DataView(output.buffer).setUint32(0, output.byteLength);
  output.set(ascii(type), 4);
  let offset = 8;
  for (const payload of payloads) {
    output.set(payload, offset);
    offset += payload.byteLength;
  }
  return output;
}

function initSegment(...handlers: Array<'vide' | 'soun'>): Uint8Array {
  const tracks = handlers.map((handler) =>
    box('trak', box('mdia', box('hdlr', new Uint8Array(8), ascii(handler)))),
  );
  return box('moov', ...tracks);
}

describe('Bilibili provider media policy', () => {
  it.each([
    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/asset-100145.m4s',
    'https://cdn.bilivideo.cn/upgcxcode/12/34/asset-30216.m4s',
    'https://upos-sz-mirror.mountaintoys.cn/upgcxcode/12/34/asset-30216.m4s',
    'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/asset-100145.m4s',
    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/progressive.flv',
  ])('accepts a strict media CDN URL: %s', (url) => {
    expect(isAllowedBilibiliMediaUrl(url)).toBe(true);
  });

  it.each([
    'http://upos-sz-mirrorcos.bilivideo.com/upgcxcode/asset.m4s',
    'https://bilivideo.com.evil.example/upgcxcode/asset.m4s',
    'https://arbitrary.akamaized.net/upgcxcode/asset.m4s',
    'https://upos-hz-mirrorakam.akamaized.net/unrelated/asset.m4s',
    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode-evil/asset.m4s',
    'https://mountaintoys.cn/upgcxcode/asset.json',
  ])('rejects a non-provider or non-media URL: %s', (url) => {
    expect(isAllowedBilibiliMediaUrl(url)).toBe(false);
  });

  it('recognizes only the Bilibili playurl API with an explicit BVID and CID', () => {
    expect(
      isBilibiliPlayurlApiUrl(
        'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1CURRENT1&cid=123',
      ),
    ).toBe(true);
    expect(isBilibiliPlayurlApiUrl('https://api.bilibili.com/x/player/wbi/playurl?cid=123')).toBe(
      false,
    );
    expect(
      isBilibiliPlayurlApiUrl(
        'https://api.bilibili.com.evil.test/x/player/wbi/playurl?bvid=BV1CURRENT1&cid=123',
      ),
    ).toBe(false);
  });
});

describe('Bilibili manifest parsing', () => {
  it('collects ordinary, Dolby, FLAC, and progressive durl media', () => {
    const parsed = parseBilibiliMediaManifest(
      {
        code: 0,
        data: {
          bvid: 'BV1CURRENT1',
          cid: 123,
          timelength: 12_500,
          dash: {
            video: [
              {
                id: 116,
                codecid: 12,
                baseUrl: 'https://video.bilivideo.com/upgcxcode/12/34/item-100145.m4s?token=video',
                backupUrl: [
                  'https://backup.bilivideo.com/upgcxcode/12/34/item-100145.m4s?token=backup',
                ],
                mimeType: 'video/mp4',
                codecs: 'hev1.1.6.L150.90',
                frameRate: '60',
                bandwidth: 9_000_000,
                width: 1920,
                height: 1080,
              },
            ],
            audio: [
              {
                baseUrl: 'https://audio.bilivideo.cn/upgcxcode/12/34/item-30216.m4s?token=audio',
                mimeType: 'audio/mp4',
              },
            ],
            dolby: {
              audio: [
                {
                  baseUrl: 'https://upos-dolby.mountaintoys.cn/upgcxcode/12/34/item-30250.m4s',
                  mimeType: 'audio/mp4; codecs="ec-3"',
                },
              ],
            },
            flac: {
              audio: {
                baseUrl: 'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/12/34/item-30251.m4s',
                mimeType: 'audio/mp4; codecs="fLaC"',
              },
            },
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
          durl: [
            {
              url: 'https://video.bilivideo.com/upgcxcode/12/34/item.flv?token=muxed',
              length: 12_500,
              size: 99_000,
            },
          ],
        },
      },
      { bvid: 'BV1CURRENT1', cid: '123' },
    );

    expect(parsed?.identity).toEqual({ bvid: 'BV1CURRENT1', cid: '123' });
    expect(parsed?.candidates[0]?.mime).toBe('video/mp4; codecs="hev1.1.6.L150.90"');
    expect(parsed?.candidates.map((candidate) => candidate.kind)).toEqual([
      'video',
      'video',
      'audio',
      'audio',
      'audio',
      'video',
    ]);
    expect(parsed?.candidates[0]?.representation).toMatchObject({
      delivery: 'dash',
      id: 116,
      qn: 116,
      codecid: 12,
      codecs: 'hev1.1.6.L150.90',
      frameRate: '60',
      bandwidth: 9_000_000,
      description: '1080P 60帧',
      displayDescription: '1080P',
      superscript: '60帧',
      dynamicRange: 'SDR',
      sourceIndex: 0,
    });
    expect(parsed?.candidates[1]?.representation).toMatchObject({
      key: parsed?.candidates[0]?.representation?.key,
      sourceIndex: 2,
    });
    expect(
      parsed?.candidates
        .filter((candidate) => candidate.kind === 'audio')
        .map((candidate) => candidate.representation?.audioType),
    ).toEqual(['AAC', 'Dolby', 'FLAC']);
    expect(JSON.stringify(parsed?.candidates)).not.toContain('4K 超清');
    expect(parsed?.diagnostics.advertisedFormats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qn: 120,
          description: '4K 超清',
          capabilities: {
            advertised: true,
            delivered: false,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
        }),
      ]),
    );
    expect(parsed?.candidates.at(-1)).toMatchObject({
      mime: 'video/x-flv; codecs="mp4a"',
      duration: 12.5,
      size: 99_000,
    });
  });

  it('rejects an explicitly stale BVID or CID', () => {
    const manifest = {
      data: {
        bvid: 'BV1STALE999',
        cid: 999,
        dash: {
          video: [
            {
              baseUrl: 'https://video.bilivideo.com/upgcxcode/1/2/item.m4s',
              mimeType: 'video/mp4',
            },
          ],
        },
      },
    };
    expect(
      parseBilibiliMediaManifest(manifest, { bvid: 'BV1CURRENT1', cid: '123' }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: 'ordinary account receives only SDR',
      support: [{ quality: 80, new_description: '1080P 高清' }],
      video: { id: 80, codecs: 'avc1.640028' },
      expectedRange: 'SDR',
      expectedProfile: 'avc1.640028',
    },
    {
      name: 'logged-in account receives HDR',
      support: [{ quality: 125, new_description: 'HDR 真彩' }],
      video: { id: 125, codecs: 'hev1.2.4.L120.90' },
      expectedRange: 'HDR',
      expectedProfile: 'hev1.2.4.L120.90',
    },
    {
      name: 'entitled account receives Dolby Vision',
      support: [{ quality: 126, new_description: '杜比视界' }],
      video: { id: 126, codecs: 'dvh1.08.07' },
      expectedRange: 'Dolby Vision',
      expectedProfile: 'dvh1.08.07',
    },
  ] as const)(
    'models advertised, delivered, decodable, and remuxable layers when $name',
    ({ support, video, expectedRange, expectedProfile }) => {
      const parsed = parseBilibiliMediaManifest(
        {
          code: 0,
          data: {
            bvid: 'BV1CAPABILITY',
            cid: 456,
            dash: {
              video: [
                {
                  ...video,
                  codecid: video.codecs.startsWith('avc1') ? 7 : 12,
                  baseUrl: 'https://video.bilivideo.com/upgcxcode/12/34/capability-100145.m4s',
                  mimeType: 'video/mp4',
                  width: 1920,
                  height: 1080,
                },
              ],
              audio: [
                {
                  id: 30280,
                  baseUrl: 'https://audio.bilivideo.com/upgcxcode/12/34/capability-30280.m4s',
                  mimeType: 'audio/mp4',
                  codecs: 'mp4a.40.2',
                },
              ],
            },
            support_formats: support,
          },
        },
        { bvid: 'BV1CAPABILITY', cid: '456' },
      );

      const delivered = parsed?.candidates.find((candidate) => candidate.kind === 'video');
      expect(delivered?.representation).toMatchObject({
        dynamicRange: expectedRange,
        codecs: expectedProfile,
        codecProfile: expectedProfile,
        capabilities: {
          advertised: true,
          delivered: true,
          decodable: 'unknown',
          remuxable: 'unknown',
        },
      });
      expect(parsed?.diagnostics.advertisedFormats[0]).toMatchObject({
        dynamicRange: expectedRange,
        capabilities: {
          advertised: true,
          delivered: true,
          decodable: 'unknown',
          remuxable: 'unknown',
        },
      });
      if (expectedRange === 'Dolby Vision') {
        expect(delivered?.representation?.dolbyVisionProfile).toBe(8);
      }
    },
  );

  it('keeps advertised-only HDR and Dolby Vision diagnostic-only for an anonymous response', () => {
    const parsed = parseBilibiliMediaManifest(
      {
        code: 0,
        data: {
          bvid: 'BV1ANONYMOUS',
          cid: 789,
          dash: {
            video: [
              {
                id: 80,
                codecid: 7,
                codecs: 'avc1.640028',
                baseUrl: 'https://video.bilivideo.com/upgcxcode/1/2/anonymous-100145.m4s',
                mimeType: 'video/mp4',
              },
            ],
          },
          support_formats: [
            { quality: 80, new_description: '1080P 高清' },
            { quality: 125, new_description: 'HDR 真彩' },
            { quality: 126, new_description: '杜比视界' },
          ],
        },
      },
      { bvid: 'BV1ANONYMOUS', cid: '789' },
    );

    expect(parsed?.candidates).toHaveLength(1);
    expect(parsed?.candidates.map((candidate) => candidate.representation?.qn)).toEqual([80]);
    expect(parsed?.diagnostics.advertisedFormats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qn: 125,
          dynamicRange: 'HDR',
          capabilities: expect.objectContaining({ advertised: true, delivered: false }),
        }),
        expect.objectContaining({
          qn: 126,
          dynamicRange: 'Dolby Vision',
          capabilities: expect.objectContaining({ advertised: true, delivered: false }),
        }),
      ]),
    );
  });

  it('marks contradictory explicit/provider evidence unknown instead of guessing HDR', () => {
    expect(
      classifyBilibiliDynamicRange({
        explicit: 'SDR',
        qn: 125,
        codecs: 'hev1.2.4.L120.90',
        description: 'HDR 真彩',
      }),
    ).toMatchObject({
      dynamicRange: 'unknown',
      codecProfile: 'hev1.2.4.L120.90',
      evidence: expect.arrayContaining([
        expect.objectContaining({ source: 'explicit-field', range: 'SDR' }),
        expect.objectContaining({ source: 'quality-number', range: 'HDR' }),
        expect.objectContaining({ source: 'conflict', range: 'unknown' }),
      ]),
    });
  });

  it('does not confuse Dolby audio delivery with Dolby Vision video delivery', () => {
    const parsed = parseBilibiliMediaManifest(
      {
        data: {
          bvid: 'BV1DOLBYAUDIO',
          cid: 321,
          dash: {
            video: [
              {
                id: 80,
                codecs: 'avc1.640028',
                baseUrl: 'https://video.bilivideo.com/upgcxcode/1/2/video-100145.m4s',
              },
            ],
            dolby: {
              audio: [
                {
                  id: 30250,
                  codecs: 'ec-3',
                  baseUrl: 'https://audio.bilivideo.com/upgcxcode/1/2/audio-30250.m4s',
                },
              ],
            },
          },
        },
      },
      { bvid: 'BV1DOLBYAUDIO', cid: '321' },
    );

    expect(
      parsed?.candidates.find((candidate) => candidate.kind === 'video')?.representation,
    ).toMatchObject({ dynamicRange: 'SDR' });
    expect(
      parsed?.candidates.find((candidate) => candidate.kind === 'audio')?.representation,
    ).toMatchObject({ audioType: 'Dolby', dynamicRange: 'SDR' });
  });
});

describe('ISO-BMFF initialization sniffing', () => {
  it('uses hdlr boxes to distinguish video, audio, and muxed resources', () => {
    expect(sniffIsoBmffTrackKind(initSegment('vide'))).toBe('video');
    expect(sniffIsoBmffTrackKind(initSegment('soun'))).toBe('audio');
    expect(sniffIsoBmffTrackKind(initSegment('vide', 'soun'))).toBe('muxed');
  });

  it('does not infer a track from arbitrary bytes containing soun/vide text', () => {
    expect(sniffIsoBmffTrackKind(ascii('not-a-box-vide-soun'))).toBeUndefined();
  });

  it('recognizes bounded Dolby Vision and BT.2020 PQ initialization metadata', () => {
    const dolby = box('dvcC', new Uint8Array([1, 0, 8 << 1]));
    const hdr = box('colr', ascii('nclx'), new Uint8Array([0, 9, 0, 16, 0, 9, 0]));

    expect(sniffBilibiliIsoBmffDynamicRange(dolby)).toEqual({
      dynamicRange: 'Dolby Vision',
      dolbyVisionProfile: 8,
      evidence: {
        source: 'initialization-segment',
        range: 'Dolby Vision',
        detail: 'dvcC',
      },
    });
    const profile5DvwC = box('dvwC', new Uint8Array([1, 0, 5 << 1]));
    expect(sniffBilibiliIsoBmffDynamicRange(profile5DvwC)).toMatchObject({
      dynamicRange: 'Dolby Vision',
      dolbyVisionProfile: 5,
      evidence: { source: 'initialization-segment', detail: 'dvwC' },
    });
    expect(sniffBilibiliIsoBmffDynamicRange(hdr)).toMatchObject({
      dynamicRange: 'HDR',
      evidence: { source: 'initialization-segment', detail: 'colr:bt2020:pq' },
    });
    expect(sniffBilibiliIsoBmffDynamicRange(ascii('payload-dvcC-colr-nclx'))).toBeUndefined();
  });

  it('range-probes an opaque numeric M4S once and classifies it from hdlr', async () => {
    clearBilibiliTrackProbeCache();
    const url =
      'https://upos-audio.bilivideo.com/upgcxcode/12/34/41482390218-1-30216.m4s?token=audio';
    let calls = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-131071');
      return new Response(initSegment('soun').slice().buffer as ArrayBuffer, {
        status: 206,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      sniffBilibiliNetworkTrack(url, undefined, fetchImpl),
      sniffBilibiliNetworkTrack(url, undefined, fetchImpl),
    ]);
    expect(first).toBe('audio');
    expect(second).toBe('audio');
    expect(calls).toBe(1);
  });
});
