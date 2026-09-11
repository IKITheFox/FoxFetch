import { describe, expect, it } from 'vitest';

import {
  NetworkMediaCaptureSession,
  parseNetworkByteRange,
  recommendNetworkMediaTracks,
  resolveNetworkMediaCandidates,
  type NetworkMediaObservation,
} from '../../src/modules/network/media-observation';

function observation(
  patch: Partial<NetworkMediaObservation> & Pick<NetworkMediaObservation, 'requestId' | 'url'>,
): NetworkMediaObservation {
  return {
    frameId: 0,
    resourceType: 'xmlhttprequest',
    status: 200,
    time: 1_000,
    ...patch,
  };
}

describe('network media observation resolver', () => {
  it('rejects non-GET bodies, telemetry endpoints, and complete tiny responses', () => {
    expect(
      resolveNetworkMediaCandidates([
        observation({
          requestId: 'post',
          url: 'https://cdn.example.test/upload.mp4',
          method: 'POST',
          mime: 'video/mp4',
          size: 10_000,
        }),
        observation({
          requestId: 'telemetry',
          url: 'https://data.bilibili.com/web',
          method: 'GET',
          mime: 'video/mp4',
          size: 2,
        }),
        observation({
          requestId: 'tiny',
          url: 'https://cdn.example.test/tiny.mp4',
          method: 'GET',
          mime: 'video/mp4',
          size: 2,
        }),
      ]),
    ).toEqual([]);
  });

  it('keeps HEAD as metadata but never recommends it as a downloadable pair', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'head-video',
        url: 'https://cdn.example.test/video.mp4',
        method: 'HEAD',
        mime: 'video/mp4',
        size: 10_000,
      }),
      observation({
        requestId: 'head-audio',
        url: 'https://cdn.example.test/audio.m4a',
        method: 'HEAD',
        mime: 'audio/mp4',
        size: 1_000,
      }),
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.reasons.includes('head-metadata'))).toBe(true);
    expect(recommendNetworkMediaTracks(candidates).autoPair).toBe(false);
  });

  it('does not promote extensionless MIME-only XHR into a media track', () => {
    const [candidate] = resolveNetworkMediaCandidates([
      observation({
        requestId: 'xhr',
        url: 'https://api.example.test/web',
        method: 'GET',
        resourceType: 'xmlhttprequest',
        mime: 'video/mp4',
        size: 1_000_000,
      }),
    ]);

    expect(candidate).toMatchObject({ role: 'unknown', confidence: 'low' });
    expect(candidate?.reasons).toContain('mime-only-xhr');
  });

  it('recognizes media and playlist MIME types while preserving request metadata', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'video-1',
        url: 'https://cdn.example.test/playback?id=7',
        initiator: 'https://app.example.test/watch/7',
        documentId: 'doc-7',
        frameId: 3,
        resourceType: 'media',
        mime: 'video/mp4; codecs=avc1',
        status: 206,
        size: 8_000_000,
        time: 1_100,
        range: { start: 0, end: 999_999, total: 8_000_000 },
      }),
      observation({
        requestId: 'playlist-1',
        url: 'https://cdn.example.test/master',
        mime: 'application/vnd.apple.mpegurl',
      }),
    ]);

    const video = candidates.find((candidate) => candidate.kind === 'video');
    const playlist = candidates.find((candidate) => candidate.kind === 'playlist');
    expect(video).toMatchObject({
      requestId: 'video-1',
      url: 'https://cdn.example.test/playback?id=7',
      initiator: 'https://app.example.test/watch/7',
      documentId: 'doc-7',
      frameId: 3,
      resourceType: 'media',
      mime: 'video/mp4',
      status: 206,
      size: 8_000_000,
      time: 1_100,
      confidence: 'high',
      role: 'track',
    });
    expect(video?.reasons).toEqual(
      expect.arrayContaining(['video-mime', 'byte-range', 'partial-response']),
    );
    expect(playlist).toMatchObject({
      kind: 'playlist',
      role: 'playlist',
      confidence: 'high',
    });
  });

  it('detects m4s fragments and opaque extensionless responses as candidates', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'fragment-1',
        url: 'https://cdn.example.test/video/chunk-12.m4s',
        mime: 'application/octet-stream',
        status: 206,
        range: { start: 0, end: 65_535 },
      }),
      observation({
        requestId: 'opaque-1',
        url: 'https://cdn.example.test/resource?id=audio',
        resourceType: 'media',
        mime: 'application/octet-stream',
        size: 4_000_000,
        time: 1_200,
      }),
      observation({
        requestId: 'opaque-other',
        url: 'https://cdn.example.test/signed-delivery?id=17',
        resourceType: 'other',
        mime: 'application/octet-stream',
        size: 2_000_000,
        time: 1_300,
      }),
    ]);

    expect(candidates).toHaveLength(3);
    expect(candidates.find((candidate) => candidate.requestId === 'fragment-1')).toMatchObject({
      kind: 'video',
      role: 'segment',
    });
    expect(candidates.find((candidate) => candidate.requestId === 'opaque-1')).toMatchObject({
      kind: 'audio',
      role: 'track',
    });
    expect(candidates.find((candidate) => candidate.requestId === 'opaque-other')).toMatchObject({
      kind: 'unknown',
      role: 'unknown',
      confidence: 'low',
    });
  });

  it('treats MIME-confirmed m4s video and audio responses as pairable tracks', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'dash-video',
        url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/11/123456_nb3-1-30080.m4s?deadline=1900000000&gen=playurlv3',
        documentId: 'bilibili-player',
        mime: 'video/mp4',
      }),
      observation({
        requestId: 'dash-audio',
        url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/11/123456_nb3-1-30280.m4s?deadline=1900000000&gen=playurlv3',
        documentId: 'bilibili-player',
        mime: 'audio/mp4',
      }),
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'dash-video', kind: 'video', role: 'track' }),
        expect.objectContaining({ requestId: 'dash-audio', kind: 'audio', role: 'track' }),
      ]),
    );
    expect(candidates.every((candidate) => candidate.reasons.includes('fragment-extension'))).toBe(
      true,
    );
    expect(recommendNetworkMediaTracks(candidates)).toMatchObject({
      autoPair: true,
      reason: 'paired',
    });
  });

  it('lets an MP4 hdlr probe override a wrong Bilibili video MIME header', () => {
    const [candidate] = resolveNetworkMediaCandidates([
      observation({
        requestId: 'bili-audio-with-wrong-header',
        url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/00/11/41482390218-1-30216.m4s',
        documentId: 'bilibili-player',
        mime: 'video/mp4',
        sniffedKind: 'audio',
      }),
    ]);

    expect(candidate).toMatchObject({
      kind: 'audio',
      mime: 'audio/mp4',
      role: 'track',
      confidence: 'high',
    });
    expect(candidate?.reasons).toContain('container-track-handler');
  });

  it('coalesces unsigned googlevideo transport ranges while retaining signed URL parameters', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'google-video-range-1',
        url: 'https://r1---sn-a5meknzl.googlevideo.com/videoplayback?id=o-main-video&itag=137&source=youtube&mime=video%2Fmp4&clen=10000&sparams=expire%2Cid%2Citag%2Csource%2Cmime%2Cclen&expire=1900000000&sig=AJfQdSswRA%2Bfirst&n=signed-n-value&range=0-999&rn=1&rbuf=0',
        documentId: 'youtube-player',
        mime: 'application/octet-stream',
        status: 200,
        size: 1_000,
      }),
      observation({
        requestId: 'google-video-range-2',
        url: 'https://r2---sn-a5meknzl.googlevideo.com/videoplayback?rn=2&rbuf=0&range=1000-1999&n=signed-n-value&sig=AJfQdSswRA%2Bfirst&expire=1900000000&sparams=expire%2Cid%2Citag%2Csource%2Cmime%2Cclen&clen=10000&mime=video%2Fmp4&source=youtube&itag=137&id=o-main-video',
        documentId: 'youtube-player',
        mime: 'application/octet-stream',
        status: 200,
        size: 1_000,
        time: 1_100,
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'video',
      role: 'track',
      confidence: 'high',
      mime: 'video/mp4',
      size: 10_000,
      observedBytes: 2_000,
      requestIds: ['google-video-range-1', 'google-video-range-2'],
    });
    expect(
      candidates[0]?.url.startsWith('https://r2---sn-a5meknzl.googlevideo.com/videoplayback?'),
    ).toBe(true);
    expect(candidates[0]?.url).toContain('sig=AJfQdSswRA%2Bfirst');
    expect(candidates[0]?.url).toContain('n=signed-n-value');
    expect(candidates[0]?.url).toContain('sparams=expire%2Cid%2Citag%2Csource%2Cmime%2Cclen');
    expect(candidates[0]?.url).not.toMatch(/[?&](?:range|rn|rbuf)=/u);
  });

  it('keeps googlevideo transport parameters that participate in the signature', () => {
    const url =
      'https://r1---sn-a5meknzl.googlevideo.com/videoplayback?id=o-signed-range&itag=137&mime=video%2Fmp4&clen=10000&range=0-999&rn=1&rbuf=0&sparams=id%2Citag%2Cmime%2Cclen%2Crange%2Crn%2Crbuf&sig=range-specific-signature';
    const [candidate] = resolveNetworkMediaCandidates([
      observation({
        requestId: 'signed-range',
        url,
        documentId: 'youtube-player',
        mime: 'application/octet-stream',
      }),
    ]);

    expect(candidate?.url).toBe(url);
    expect(candidate).toMatchObject({
      kind: 'video',
      mime: 'video/mp4',
      size: 10_000,
      observedBytes: 1_000,
    });
  });

  it('pairs googlevideo adaptive tracks only when their video ids match', () => {
    const makeTrack = (
      requestId: string,
      id: string,
      itag: number,
      mime: 'video/mp4' | 'audio/mp4',
    ) =>
      observation({
        requestId,
        url: `https://r1---sn-a5meknzl.googlevideo.com/videoplayback?id=${id}&itag=${itag}&mime=${encodeURIComponent(mime)}&clen=10000&sparams=id%2Citag%2Cmime%2Cclen&sig=shared-signature`,
        documentId: 'youtube-player',
        mime: 'application/octet-stream',
      });

    const matching = resolveNetworkMediaCandidates([
      makeTrack('video-main', 'o-main-video', 137, 'video/mp4'),
      makeTrack('audio-main', 'o-main-video', 140, 'audio/mp4'),
    ]);
    expect(recommendNetworkMediaTracks(matching)).toMatchObject({
      autoPair: true,
      reason: 'paired',
    });

    const mismatched = resolveNetworkMediaCandidates([
      makeTrack('video-other', 'o-other-video', 137, 'video/mp4'),
      makeTrack('audio-main', 'o-main-video', 140, 'audio/mp4'),
    ]);
    expect(recommendNetworkMediaTracks(mismatched)).toMatchObject({
      autoPair: false,
      reason: 'context-mismatch',
    });
  });

  it.each([
    ['text/html', 'media', 'https://cdn.example.test/player'],
    ['application/json', 'xmlhttprequest', 'https://cdn.example.test/api'],
    ['text/css', 'stylesheet', 'https://cdn.example.test/site.css'],
    ['image/jpeg', 'image', 'https://cdn.example.test/poster.jpg'],
    ['application/octet-stream', 'xmlhttprequest', 'https://cdn.example.test/data.json'],
  ])('excludes %s responses', (mime, resourceType, url) => {
    expect(
      resolveNetworkMediaCandidates([
        observation({ requestId: mime, url, mime, resourceType, size: 1_000_000 }),
      ]),
    ).toEqual([]);
  });

  it('deduplicates range requests for one URL and merges total and covered sizes', () => {
    const url = 'https://cdn.example.test/movie.mp4?token=same';
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'range-a',
        url,
        mime: 'video/mp4',
        status: 206,
        size: 10_000,
        range: { start: 0, end: 4_999, total: 10_000 },
      }),
      observation({
        requestId: 'range-b',
        url: `${url}#ignored-fragment`,
        mime: 'video/mp4',
        status: 206,
        size: 10_000,
        time: 1_100,
        range: { start: 4_000, end: 9_999, total: 10_000 },
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      size: 10_000,
      observedBytes: 10_000,
      requestIds: ['range-a', 'range-b'],
    });
    expect(candidates[0]?.observations).toHaveLength(2);
  });

  it('coalesces a redirect chain and keeps every redirect and raw observation', () => {
    const redirect = {
      fromUrl: 'https://media.example.test/original.mp4',
      toUrl: 'https://edge.example.test/signed/video.mp4?key=1',
      status: 302,
      time: 1_000,
    };
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'redirected-request',
        url: redirect.fromUrl,
        status: 302,
        redirect,
      }),
      observation({
        requestId: 'redirected-request',
        url: redirect.toUrl,
        mime: 'video/mp4',
        time: 1_100,
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: redirect.toUrl,
      redirect,
      redirects: [redirect],
      requestIds: ['redirected-request'],
    });
    expect(candidates[0]?.observations).toHaveLength(2);
  });

  it('only auto-pairs compatible high-confidence video and audio tracks', () => {
    const highConfidence = resolveNetworkMediaCandidates([
      observation({
        requestId: 'video',
        url: 'https://cdn.example.test/video.mp4',
        documentId: 'same-document',
      }),
      observation({
        requestId: 'audio',
        url: 'https://cdn.example.test/audio.m4a',
        documentId: 'same-document',
      }),
    ]);
    const paired = recommendNetworkMediaTracks(highConfidence);
    expect(paired).toMatchObject({ autoPair: true, reason: 'paired' });
    expect(paired.pair?.video.requestId).toBe('video');
    expect(paired.pair?.audio.requestId).toBe('audio');

    const lowConfidence = resolveNetworkMediaCandidates([
      observation({
        requestId: 'video',
        url: 'https://cdn.example.test/video.mp4',
        documentId: 'same-document',
      }),
      observation({
        requestId: 'audio-low',
        url: 'https://cdn.example.test/delivery?track=audio',
        documentId: 'same-document',
      }),
    ]);
    const withheld = recommendNetworkMediaTracks(lowConfidence);
    expect(withheld.video?.requestId).toBe('video');
    expect(withheld.audio).toMatchObject({ requestId: 'audio-low', confidence: 'low' });
    expect(withheld).toMatchObject({ autoPair: false, reason: 'low-confidence' });
    expect(withheld.pair).toBeUndefined();

    const mediumConfidence = resolveNetworkMediaCandidates([
      observation({
        requestId: 'video',
        url: 'https://cdn.example.test/video.mp4',
        documentId: 'same-document',
      }),
      observation({
        requestId: 'audio-medium',
        url: 'https://cdn.example.test/delivery?track=audio',
        documentId: 'same-document',
        mime: 'application/octet-stream',
        resourceType: 'media',
      }),
    ]);
    const mediumWithheld = recommendNetworkMediaTracks(mediumConfidence);
    expect(mediumWithheld.audio?.confidence).toBe('medium');
    expect(mediumWithheld).toMatchObject({ autoPair: false, reason: 'low-confidence' });
    expect(mediumWithheld.pair).toBeUndefined();
  });

  it('chooses a compatible high-confidence pair instead of unrelated larger tracks', () => {
    const candidates = resolveNetworkMediaCandidates([
      observation({
        requestId: 'video-right-document',
        url: 'https://cdn.example.test/right/video.mp4',
        documentId: 'right-document',
        size: 5_000,
      }),
      observation({
        requestId: 'audio-wrong-document',
        url: 'https://cdn.example.test/wrong/audio.m4a',
        documentId: 'wrong-document',
        size: 10_000,
      }),
      observation({
        requestId: 'audio-right-document',
        url: 'https://cdn.example.test/right/audio.m4a',
        documentId: 'right-document',
        size: 4_000,
      }),
    ]);

    const recommendation = recommendNetworkMediaTracks(candidates);
    expect(recommendation).toMatchObject({ autoPair: true, reason: 'paired' });
    expect(recommendation.audio?.requestId).toBe('audio-right-document');
  });

  it('keeps a capture session immutable after it is stopped', () => {
    const session = new NetworkMediaCaptureSession();
    expect(
      session.observe(
        observation({ requestId: 'accepted', url: 'https://cdn.example.test/video.mp4' }),
      ),
    ).toBe(true);

    const stopped = session.stop();
    expect(stopped.active).toBe(false);
    expect(stopped.candidates).toHaveLength(1);
    expect(
      session.observe(
        observation({ requestId: 'ignored', url: 'https://cdn.example.test/audio.m4a' }),
      ),
    ).toBe(false);
    expect(session.snapshot().observations).toHaveLength(1);
  });

  it('parses request and response byte-range forms safely', () => {
    expect(parseNetworkByteRange('bytes=0-1023')).toEqual({ start: 0, end: 1023 });
    expect(parseNetworkByteRange('bytes 1024-2047/8192')).toEqual({
      start: 1024,
      end: 2047,
      total: 8192,
    });
    expect(parseNetworkByteRange('bytes 9-2/10')).toBeUndefined();
    expect(parseNetworkByteRange('items=0-1')).toBeUndefined();
  });
});
