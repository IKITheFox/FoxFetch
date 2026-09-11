import { beforeEach, expect, it, vi } from 'vitest';
import { stageYouTubeSabrSelection } from '../../src/modules/youtube/sources/staged-selection';
import { acquireSabrTracks } from '../../src/modules/youtube/sources/sabr';
import { bindYouTubeSabrSelection } from '../../src/modules/youtube/sources/selection-binding';
import type { YouTubeSelectionPlan } from '../../src/modules/youtube/selection';

vi.mock('../../src/modules/youtube/sources/sabr', () => ({ acquireSabrTracks: vi.fn() }));
vi.mock('../../src/modules/youtube/sources/selection-binding', () => ({
  bindYouTubeSabrSelection: vi.fn(),
}));
vi.mock('../../src/modules/youtube/track-verification', () => ({
  verifyYouTubeTrackParameters: vi.fn(async () => ({ completePlaybackVerified: false })),
}));
const plan = { videoId: 'abcdefghijk' } as YouTubeSelectionPlan;
const session = {
  formats: [],
  serverAbrStreamingUrl: 'https://r.googlevideo.com/videoplayback',
  videoPlaybackUstreamerConfig: 'x',
  clientInfo: { clientName: 1, clientVersion: 'x' },
  durationMs: 1000,
};
function storage() {
  const aborted = vi.fn();
  const video = new File([new Uint8Array(10)], 'video.track');
  const audio = new File([new Uint8Array(5)], 'audio.track');
  const directory = {
    getFileHandle: vi.fn(async (name: string) => ({
      createWritable: async () => new WritableStream({ abort: aborted }),
      getFile: async () => (name === 'video.track' ? video : audio),
    })),
  };
  const root = {
    getDirectoryHandle: vi.fn(async () => directory),
    removeEntry: vi.fn(async (_name: string, _options: { recursive: boolean }) => {}),
  };
  return { root: root as unknown as FileSystemDirectoryHandle, mock: root, aborted };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(bindYouTubeSabrSelection).mockReturnValue({
    video: { itag: 248 } as never,
    audio: { itag: 251 } as never,
  });
  vi.mocked(acquireSabrTracks).mockResolvedValue({
    video: { bytes: 10 } as never,
    audio: { bytes: 5 } as never,
  });
});
it('returns complete files with explicit ownership and idempotent disposal', async () => {
  const store = storage();
  const result = await stageYouTubeSabrSelection(plan, plan.videoId, session, {
    root: store.root,
    signal: new AbortController().signal,
  });
  expect(result.video.size).toBe(10);
  expect(result.audio.size).toBe(5);
  expect(store.mock.removeEntry).not.toHaveBeenCalled();
  expect(bindYouTubeSabrSelection).toHaveBeenCalledWith(plan, plan.videoId, session.formats);
  expect(vi.mocked(acquireSabrTracks).mock.calls[0]![0].video.itag).toBe(248);
  await result.dispose();
  await result.dispose();
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
  expect(store.mock.removeEntry.mock.calls[0]?.[0]).toMatch(/^youtube-selected-/);
});
it('does not allocate files for a stale selection', async () => {
  const store = storage();
  vi.mocked(bindYouTubeSabrSelection).mockImplementation(() => {
    throw new Error('TRACK_IDENTITY_MISMATCH');
  });
  await expect(
    stageYouTubeSabrSelection(plan, plan.videoId, session, {
      root: store.root,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TRACK_IDENTITY_MISMATCH');
  expect(store.mock.getDirectoryHandle).not.toHaveBeenCalled();
});
it('removes staging after acquisition failure', async () => {
  const store = storage();
  vi.mocked(acquireSabrTracks).mockRejectedValue(new Error('SESSION_REQUIRED'));
  await expect(
    stageYouTubeSabrSelection(plan, plan.videoId, session, {
      root: store.root,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('SESSION_REQUIRED');
  expect(store.aborted).toHaveBeenCalledTimes(2);
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('rejects incomplete persisted files even when acquisition reports success', async () => {
  const store = storage();
  vi.mocked(acquireSabrTracks).mockResolvedValue({
    video: { bytes: 11 } as never,
    audio: { bytes: 5 } as never,
  });
  await expect(
    stageYouTubeSabrSelection(plan, plan.videoId, session, {
      root: store.root,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('SEGMENT_MISSING');
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('does not allocate files for an already canceled task', async () => {
  const store = storage();
  const controller = new AbortController();
  controller.abort();
  await expect(
    stageYouTubeSabrSelection(plan, plan.videoId, session, {
      root: store.root,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(store.mock.getDirectoryHandle).not.toHaveBeenCalled();
});
