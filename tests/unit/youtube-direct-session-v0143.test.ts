import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractYouTubeInspection } from '../../src/modules/youtube/inspection';
import { createYouTubeSelectionPlan } from '../../src/modules/youtube/selection';
import {
  extractYouTubeDirectSession,
  resolveYouTubeDirectSession,
} from '../../src/modules/youtube/sources/direct-session';

const id = 'abcdefghijk';
function fixture() {
  return {
    videoDetails: { videoId: id, lengthSeconds: '20', isLive: false },
    playabilityStatus: { status: 'OK' },
    streamingData: {
      formats: [
        {
          itag: 18,
          lastModified: '123',
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          width: 640,
          height: 360,
          fps: 30,
          approxDurationMs: '20000',
          contentLength: '1000',
          url: 'https://r1.googlevideo.com/videoplayback?sig=private',
          audioTrack: { id: 'arbitrary.4', languageCode: 'en-us' },
        },
      ],
    },
  };
}
let source = fixture();
beforeEach(() => {
  source = fixture();
  vi.stubGlobal('location', new URL(`https://www.youtube.com/watch?v=${id}`));
  vi.stubGlobal('fetch', vi.fn());
  document.body.innerHTML = '<div id="movie_player"></div>';
  Object.assign(document.getElementById('movie_player')!, {
    getPlayerResponse: () => source,
    getVideoData: () => ({ video_id: source.videoDetails.videoId }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function plan() {
  const view = extractYouTubeInspection();
  const result = createYouTubeSelectionPlan(view, {
    videoId: id,
    videoTrackId: view.candidates[0]!.id,
    container: 'auto',
    mode: 'merge',
  });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}
it('binds the exact current muxed source and does not fetch, transform the signature or synthesize tokens', () => {
  const p = plan();
  expect(extractYouTubeDirectSession(id, p.video)).toEqual({
    ok: true,
    session: {
      kind: 'direct-file',
      videoId: id,
      candidateId: p.video.id,
      address: source.streamingData.formats[0]!.url,
      duration: 20,
      expectedBytes: 1000,
    },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { width: 320 },
  { height: 240 },
  { fps: 24 },
  { lastModified: '456' },
  { approxDurationMs: '19900' },
  { contentLength: '999' },
  { xtags: 'new-version' },
  { mimeType: 'video/mp4; codecs="av01.0.08M.08, mp4a.40.2"' },
  { audioTrack: { id: 'arbitrary.4', languageCode: 'ja' } },
])('rejects changed selected parameters: %j', (change) => {
  const p = plan();
  Object.assign(source.streamingData.formats[0]!, change);
  expect(extractYouTubeDirectSession(id, p.video)).toEqual({
    ok: false,
    error: 'SELECTION_CHANGED',
  });
});
it.each([
  { signatureCipher: 'encrypted' },
  { drmFamilies: ['drm'] },
  { colorInfo: { transferCharacteristics: 'SMPTEST2084' } },
  { url: 'https://unrelated.example/video.mp4' },
])('rejects cipher, protected, HDR or unrelated sources: %j', (change) => {
  const p = plan();
  Object.assign(source.streamingData.formats[0]!, change);
  expect(extractYouTubeDirectSession(id, p.video)).toEqual({
    ok: false,
    error: 'SOURCE_NOT_ALLOWED',
  });
});
it('rejects duplicate identities, ads and changed pages without downloading', () => {
  const p = plan();
  source.streamingData.formats.push({ ...source.streamingData.formats[0]! });
  expect(extractYouTubeDirectSession(id, p.video)).toMatchObject({
    ok: false,
    error: 'SELECTION_CHANGED',
  });
  document.getElementById('movie_player')!.classList.add('ad-showing');
  expect(extractYouTubeDirectSession(id, p.video)).toMatchObject({
    ok: false,
    error: 'SOURCE_UNAVAILABLE',
  });
  vi.stubGlobal('location', new URL('https://www.youtube.com/watch?v=zyxwvutsrqp'));
  expect(extractYouTubeDirectSession(id, p.video)).toMatchObject({
    ok: false,
    error: 'PAGE_IDENTITY_CHANGED',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('uses the selected document and checks its identity before and after the private read', async () => {
  const p = plan();
  const assertCurrent = vi.fn().mockResolvedValue(undefined);
  const execute = vi
    .fn()
    .mockResolvedValue([
      { frameId: 0, documentId: 'doc', result: extractYouTubeDirectSession(id, p.video) },
    ]);
  await expect(
    resolveYouTubeDirectSession(
      p,
      { tabId: 4, documentId: 'doc' },
      { signal: new AbortController().signal, assertCurrent, execute },
    ),
  ).resolves.toMatchObject({ candidateId: p.video.id });
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tabId: 4, documentIds: ['doc'] },
      world: 'MAIN',
      args: [id, p.video],
    }),
  );
  execute.mockResolvedValue([
    { frameId: 0, documentId: 'other', result: extractYouTubeDirectSession(id, p.video) },
  ]);
  await expect(
    resolveYouTubeDirectSession(
      p,
      { tabId: 4, documentId: 'doc' },
      { signal: new AbortController().signal, assertCurrent, execute },
    ),
  ).rejects.toThrow('PAGE_IDENTITY_CHANGED');
});
it('cancels a pending private read without waiting for a late response', async () => {
  const p = plan();
  const controller = new AbortController();
  const execute = vi.fn(() => new Promise<never>(() => {}));
  const pending = resolveYouTubeDirectSession(
    p,
    { tabId: 4, documentId: 'doc' },
    { signal: controller.signal, assertCurrent: async () => {}, execute },
  );
  const rejected = expect(pending).rejects.toThrow('DOWNLOAD_CANCELED');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
});
