import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractYouTubePageSession } from '../../src/modules/youtube/sources/page-session';
import { resolveYouTubePageSession } from '../../src/modules/youtube/sources/resolve-session';
import { extractYouTubeInspection } from '../../src/modules/youtube/inspection';
import { createYouTubeSelectionPlan } from '../../src/modules/youtube/selection';

const id = 'abcdefghijk';
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalConfig = Object.getOwnPropertyDescriptor(window, 'ytcfg');
function fixture() {
  return {
    videoDetails: { videoId: id, lengthSeconds: '20', isLive: false },
    playabilityStatus: { status: 'OK' },
    playerConfig: {
      mediaCommonConfig: {
        mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: 'dGVzdA==' },
      },
    },
    streamingData: {
      serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=test&sig=fixture',
      adaptiveFormats: [
        {
          itag: 248,
          lastModified: '123',
          mimeType: 'video/webm; codecs="vp9"',
          bitrate: 10000,
          approxDurationMs: '20000',
          width: 1920,
          height: 1080,
          fps: 59.94,
          contentLength: '1000',
        },
        {
          itag: 251,
          lastModified: '456',
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 1000,
          approxDurationMs: '20000',
          audioTrack: { id: 'arbitrary.4', languageCode: 'en-us' },
        },
      ],
    },
  };
}
let source = fixture();
beforeEach(() => {
  source = fixture();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: new URL(`https://www.youtube.com/watch?v=${id}`),
  });
  Object.defineProperty(window, 'ytcfg', {
    configurable: true,
    value: {
      get: (key: string) =>
        key === 'INNERTUBE_CONTEXT_CLIENT_NAME' ? 1 : { client: { clientVersion: 'test-version' } },
    },
  });
  document.body.innerHTML = '<div id="movie_player"></div>';
  Object.assign(document.getElementById('movie_player')!, {
    getPlayerResponse: () => source,
    getVideoData: () => ({ video_id: source.videoDetails.videoId }),
  });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  if (originalConfig) Object.defineProperty(window, 'ytcfg', originalConfig);
  else Reflect.deleteProperty(window, 'ytcfg');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function plan() {
  const view = extractYouTubeInspection();
  const result = createYouTubeSelectionPlan(view, {
    videoId: id,
    videoTrackId: view.candidates[0]!.id,
    audioTrackId: view.candidates[1]!.id,
    mode: 'merge',
    container: 'auto',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}
it('reads exact source versions, fractional fps and explicit language without fetching or synthesizing authorization', () => {
  const result = extractYouTubePageSession(id);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.session.formats[0]).toMatchObject({
    fps: 59.94,
    lastModified: '123',
    contentLength: 1000,
  });
  expect(result.session.formats[1]).toMatchObject({
    language: 'en-US',
    audioTrackId: 'arbitrary.4',
  });
  expect(result.session).not.toHaveProperty('poToken');
  expect(result.session).not.toHaveProperty('initialStreamerContext');
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects an old player identity instead of taking an initial-page fallback', () => {
  source.videoDetails.videoId = 'zyxwvutsrqp';
  expect(extractYouTubePageSession(id)).toEqual({ ok: false, error: 'PAGE_IDENTITY_CHANGED' });
});
it.each(['ad-showing', 'ad-interrupting'])('does not acquire during %s', (className) => {
  document.getElementById('movie_player')!.classList.add(className);
  expect(extractYouTubePageSession(id).ok).toBe(false);
});
it('rejects restricted/live content and unrelated media addresses', () => {
  source.videoDetails.isLive = true;
  expect(extractYouTubePageSession(id).ok).toBe(false);
  source.videoDetails.isLive = false;
  source.playabilityStatus.status = 'LOGIN_REQUIRED';
  expect(extractYouTubePageSession(id).ok).toBe(false);
  source.playabilityStatus.status = 'OK';
  source.streamingData.serverAbrStreamingUrl = 'https://r1.googlevideo.com.example/videoplayback';
  expect(extractYouTubePageSession(id)).toEqual({ ok: false, error: 'SOURCE_NOT_ALLOWED' });
});
it('bounds format counts and does not infer a missing language from its track ID', () => {
  source.streamingData.adaptiveFormats[1]!.audioTrack!.languageCode = '';
  const result = extractYouTubePageSession(id);
  expect(result.ok && result.session.formats[1]).not.toHaveProperty('language');
  source.streamingData.adaptiveFormats = Array.from(
    { length: 201 },
    () => source.streamingData.adaptiveFormats[0]!,
  );
  expect(extractYouTubePageSession(id).ok).toBe(false);
});
it('resolves only the bound top document and checks the navigation epoch twice', async () => {
  const selected = plan();
  const execute = vi.fn(async () => [
    { frameId: 0, documentId: 'doc', result: extractYouTubePageSession(id) },
  ]);
  const assertCurrent = vi.fn(async () => {});
  const session = await resolveYouTubePageSession(
    selected,
    { tabId: 1, documentId: 'doc' },
    { signal: new AbortController().signal, execute, assertCurrent },
  );
  expect(session.formats[0]?.fps).toBe(59.94);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toBeDefined();
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tabId: 1, documentIds: ['doc'] },
      args: [id],
      world: 'MAIN',
    }),
  );
});
it('rejects a source version changed since the user selected it', async () => {
  const selected = plan();
  source.streamingData.adaptiveFormats[0]!.lastModified = '999';
  await expect(
    resolveYouTubePageSession(
      selected,
      { tabId: 1, documentId: 'doc' },
      {
        signal: new AbortController().signal,
        assertCurrent: async () => {},
        execute: async () => [
          { frameId: 0, documentId: 'doc', result: extractYouTubePageSession(id) },
        ],
      },
    ),
  ).rejects.toThrow('TRACK_IDENTITY_MISMATCH');
});
it('discards a read if the page epoch changes while reading', async () => {
  const assertCurrent = vi
    .fn(async () => {})
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
  await expect(
    resolveYouTubePageSession(
      plan(),
      { tabId: 1, documentId: 'doc' },
      {
        signal: new AbortController().signal,
        assertCurrent,
        execute: async () => [
          { frameId: 0, documentId: 'doc', result: extractYouTubePageSession(id) },
        ],
      },
    ),
  ).rejects.toThrow('PAGE_IDENTITY_CHANGED');
});
it('cancels a stalled read promptly and removes its deadline timer', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const execute = vi.fn(() => new Promise<never>(() => {}));
  const task = resolveYouTubePageSession(
    plan(),
    { tabId: 1, documentId: 'doc' },
    {
      signal: controller.signal,
      assertCurrent: async () => {},
      execute,
    },
  );
  const result = expect(task).rejects.toThrow('DOWNLOAD_CANCELED');
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledTimes(1);
  controller.abort();
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
it('times out a stalled page read without accepting a late result', async () => {
  vi.useFakeTimers();
  const task = resolveYouTubePageSession(
    plan(),
    { tabId: 1, documentId: 'doc' },
    {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      execute: () => new Promise(() => {}),
    },
  );
  const failure = expect(task).rejects.toThrow('SOURCE_READ_TIMEOUT');
  await vi.advanceTimersByTimeAsync(5000);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects a different returned document and sanitizes scripting errors', async () => {
  const selected = plan();
  const owner = { tabId: 1, documentId: 'doc' };
  await expect(
    resolveYouTubePageSession(selected, owner, {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      execute: async () => [
        { frameId: 0, documentId: 'other', result: extractYouTubePageSession(id) },
      ],
    }),
  ).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  await expect(
    resolveYouTubePageSession(selected, owner, {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      execute: async () => {
        throw new Error('https://private.example/?token=secret');
      },
    }),
  ).rejects.toThrow('SOURCE_READ_FAILED');
});
