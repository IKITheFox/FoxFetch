// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { StreamerContext, VideoPlaybackAbrRequest } from 'googlevideo/protos';
import {
  bindYouTubeRequestContext,
  observeYouTubeSetupRequests,
  waitForYouTubeRequestContext,
  type PlayerRequestObservation,
} from '../../src/modules/youtube/sources/request-context';
import type { YouTubePageSession } from '../../src/modules/youtube/sources/page-session';

function fixture() {
  const session: YouTubePageSession = {
    serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=source',
    videoPlaybackUstreamerConfig: 'AQID',
    clientInfo: { clientName: 1, clientVersion: 'test' },
    durationMs: 1000,
    formats: [
      {
        itag: 299,
        lastModified: '123',
        bitrate: 2000,
        approxDurationMs: 1000,
        mimeType: 'video/mp4; codecs="avc1.64002a"',
      },
      {
        itag: 140,
        lastModified: '124',
        bitrate: 1000,
        approxDurationMs: 1000,
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      },
    ],
  };
  const request: VideoPlaybackAbrRequest = {
    selectedFormatIds: [],
    bufferedRanges: [],
    preferredVideoFormatIds: [{ itag: 299, lastModified: '123' }],
    preferredAudioFormatIds: [{ itag: 140, lastModified: '124' }],
    preferredSubtitleFormatIds: [],
    field1000: [],
    videoPlaybackUstreamerConfig: new Uint8Array([1, 2, 3]),
    streamerContext: {
      clientInfo: { clientName: 1, clientVersion: 'test' },
      poToken: new Uint8Array([7]),
      playbackCookie: new Uint8Array([9]),
      sabrContexts: [{ type: 5, value: new Uint8Array([8]) }],
      unsentSabrContexts: [],
    },
  };
  return { session, request, bytes: () => VideoPlaybackAbrRequest.encode(request).finish() };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('uses the current player address only for the same source and valid bound body', () => {
  const f = fixture();
  const current = 'https://r2.googlevideo.com/videoplayback?id=source&n=current';
  expect(bindYouTubeRequestContext(f.session, f.bytes(), current)?.serverAbrStreamingUrl).toBe(
    current,
  );
  expect(
    bindYouTubeRequestContext(f.session, f.bytes(), current.replace('id=source', 'id=other')),
  ).toBeUndefined();
  expect(
    bindYouTubeRequestContext(
      f.session,
      f.bytes(),
      current.replace('r2.googlevideo.com', 'example.com'),
    ),
  ).toBeUndefined();
  f.request.videoPlaybackUstreamerConfig = new Uint8Array([9]);
  expect(bindYouTubeRequestContext(f.session, f.bytes(), current)).toBeUndefined();
});
it('preserves observed context after exact binding but does not reuse the player playback cookie', () => {
  const f = fixture();
  const bound = bindYouTubeRequestContext(f.session, f.bytes())!;
  expect(bound.poToken).toBe('Bw==');
  const initial = StreamerContext.decode(
    Uint8Array.from(atob(bound.initialStreamerContext!), (c) => c.charCodeAt(0)),
  );
  expect(initial.playbackCookie?.length ?? 0).toBe(0);
  expect(initial.sabrContexts[0]!.type).toBe(5);
  expect(f.request.streamerContext!.playbackCookie).toEqual(new Uint8Array([9]));
  expect(f.session).not.toHaveProperty('poToken');
});
it.each(['config', 'version', 'client', 'audio-missing', 'ambiguous', 'malformed', 'oversize'])(
  'rejects %s without producing a session',
  (reason) => {
    const f = fixture();
    if (reason === 'config') f.request.videoPlaybackUstreamerConfig = new Uint8Array([9]);
    if (reason === 'version') f.request.preferredVideoFormatIds[0]!.lastModified = '999';
    if (reason === 'client') f.request.streamerContext!.clientInfo!.clientVersion = 'other';
    if (reason === 'audio-missing') f.request.preferredAudioFormatIds = [];
    if (reason === 'ambiguous') f.session.formats.push({ ...f.session.formats[0]! });
    const bytes =
      reason === 'oversize'
        ? new Uint8Array(100001)
        : reason === 'malformed'
          ? new Uint8Array([255])
          : f.bytes();
    expect(bindYouTubeRequestContext(f.session, bytes)).toBeUndefined();
  },
);
function waitFixture() {
  const f = fixture();
  const remove = vi.fn();
  const assertCurrent = vi.fn(async () => {});
  let listener!: (event: PlayerRequestObservation) => void;
  const controller = new AbortController();
  const listen = vi.fn((receive: typeof listener) => {
    listener = receive;
    return remove;
  });
  const ready = waitForYouTubeRequestContext(
    f.session,
    { tabId: 5, documentId: 'current' },
    { signal: controller.signal, assertCurrent, listen },
  );
  const event = (): PlayerRequestObservation => ({
    tabId: 5,
    documentId: 'current',
    frameId: 0,
    method: 'POST',
    url: 'https://r1.googlevideo.com/videoplayback?id=source',
    initiator: 'https://www.youtube.com',
    requestBody: { raw: [{ bytes: f.bytes().slice().buffer as ArrayBuffer }] },
  });
  return {
    ready,
    controller,
    remove,
    listen,
    assertCurrent,
    event,
    emit: (value: PlayerRequestObservation) => listener(value),
  };
}
it('ignores other documents, tabs and origins then binds one current request and removes listener', async () => {
  const s = waitFixture();
  await Promise.resolve();
  s.emit({ ...s.event(), documentId: 'old' });
  s.emit({ ...s.event(), tabId: 6 });
  s.emit({ ...s.event(), initiator: 'https://example.com' });
  expect(s.remove).not.toHaveBeenCalled();
  s.emit(s.event());
  expect((await s.ready).poToken).toBe('Bw==');
  expect(s.remove).toHaveBeenCalledTimes(1);
  expect(s.assertCurrent).toHaveBeenCalledTimes(2);
});
it('cancellation removes the observer and releases its timeout', async () => {
  vi.useFakeTimers();
  const s = waitFixture();
  const rejected = expect(s.ready).rejects.toThrow('DOWNLOAD_CANCELED');
  await Promise.resolve();
  s.controller.abort();
  await rejected;
  expect(s.remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('timeout removes observer instead of waiting indefinitely or creating media requests', async () => {
  vi.useFakeTimers();
  const s = waitFixture();
  const rejected = expect(s.ready).rejects.toThrow('SESSION_CONTEXT_UNAVAILABLE');
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
  expect(s.remove).toHaveBeenCalledTimes(1);
});
it('navigation changed after request capture prevents returning a session', async () => {
  const s = waitFixture();
  const rejected = expect(s.ready).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  await Promise.resolve();
  s.assertCurrent.mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
  s.emit(s.event());
  await rejected;
});

it('accepts a valid request after the former 15 second deadline', async () => {
  vi.useFakeTimers();
  const s = waitFixture();
  await vi.advanceTimersByTimeAsync(45000);
  expect(s.remove).not.toHaveBeenCalled();
  s.emit(s.event());
  expect((await s.ready).poToken).toBe('Bw==');
  expect(vi.getTimerCount()).toBe(0);
});

it('extends on scoped traffic but stops at the absolute deadline with a safe reason', async () => {
  vi.useFakeTimers();
  const s = waitFixture();
  const rejected = expect(s.ready).rejects.toThrow('SESSION_SOURCE_MISMATCH');
  await Promise.resolve();
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(30000);
    s.emit({ ...s.event(), url: 'https://r1.googlevideo.com/videoplayback?id=other' });
  }
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(s.remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes missing request bodies from absence of requests', async () => {
  vi.useFakeTimers();
  const s = waitFixture();
  const rejected = expect(s.ready).rejects.toThrow('SESSION_REQUEST_BODY_UNAVAILABLE');
  await Promise.resolve();
  s.emit({ ...s.event(), requestBody: { error: 'private browser error' } });
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
});

it('captures setup requests with bounded owned copies and removes observer', () => {
  let receive!: (event: PlayerRequestObservation) => void;
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', {
    webRequest: {
      onBeforeRequest: {
        addListener: vi.fn((listener) => {
          receive = listener;
        }),
        removeListener,
      },
    },
  });
  const observer = observeYouTubeSetupRequests({ tabId: 5, documentId: 'current' });
  const f = fixture();
  const original = f.bytes().slice().buffer as ArrayBuffer;
  const event: PlayerRequestObservation = {
    tabId: 5,
    documentId: 'current',
    frameId: 0,
    method: 'POST',
    url: f.session.serverAbrStreamingUrl,
    initiator: 'https://www.youtube.com',
    requestBody: { raw: [{ bytes: original }] },
  };
  receive({ ...event, documentId: 'old' });
  for (let i = 0; i < 12; i++) receive(event);
  const copies: ArrayBuffer[] = [];
  observer.listen((entry) => {
    const bytes = entry.requestBody!.raw![0]!.bytes!;
    expect(bindYouTubeRequestContext(f.session, new Uint8Array(bytes), entry.url)).toBeDefined();
    copies.push(bytes);
  });
  expect(copies).toHaveLength(8);
  expect(copies.every((bytes) => new Uint8Array(bytes).every((b) => b === 0))).toBe(true);
  expect(new Uint8Array(original)).toEqual(f.bytes());
  observer.close();
  observer.close();
  expect(removeListener).toHaveBeenCalledTimes(1);
});
