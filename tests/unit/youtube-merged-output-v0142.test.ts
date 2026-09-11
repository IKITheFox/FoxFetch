import { beforeEach, expect, it, vi } from 'vitest';
import { prepareYouTubeMergedOutput } from '../../src/modules/youtube/merged-output';
import { remuxStagedBlobsToFile } from '../../src/modules/merge/executor';
import { verifyYouTubeTrackParameters } from '../../src/modules/youtube/track-verification';
import type { StagedYouTubeSelection } from '../../src/modules/youtube/sources/staged-selection';

vi.mock('../../src/modules/merge/executor', () => ({ remuxStagedBlobsToFile: vi.fn() }));
vi.mock('../../src/modules/youtube/track-verification', () => ({
  verifyYouTubeTrackParameters: vi.fn(),
}));
const staged = {
  plan: { videoId: 'abcdefghijk', container: 'webm', mode: 'merge' },
  video: new File(['video'], 'video.track'),
  audio: new File(['audio'], 'audio.track'),
} as StagedYouTubeSelection;
function storage() {
  const file = new File(['merged'], 'output.webm');
  const root = {
    getFileHandle: vi.fn(async () => ({ getFile: async () => file })),
    removeEntry: vi.fn(async (_name: string) => {}),
  };
  return { root: root as unknown as FileSystemDirectoryHandle, mock: root };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyYouTubeTrackParameters).mockResolvedValue({
    completePlaybackVerified: false,
    videoPacketCount: 60,
    averageVideoFrameRate: 30,
  } as never);
  vi.mocked(remuxStagedBlobsToFile).mockResolvedValue({
    plan: { mode: 'packet-copy', container: 'webm' },
  } as never);
});
it.each([
  { videoPacketCount: 30, averageVideoFrameRate: 30 },
  { videoPacketCount: 60, averageVideoFrameRate: 60 },
  { videoPacketCount: 60, averageVideoFrameRate: Number.NaN },
])('rejects changed frame count or timing: %j', async (changed) => {
  const store = storage();
  vi.mocked(verifyYouTubeTrackParameters)
    .mockResolvedValueOnce({ videoPacketCount: 60, averageVideoFrameRate: 30 } as never)
    .mockResolvedValueOnce(changed as never);
  await expect(
    prepareYouTubeMergedOutput(staged, {
      root: store.root,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('OUTPUT_FRAME_RATE_MISMATCH');
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('preserves a non-integer average rate without imposing nominal CFR', async () => {
  const store = storage();
  vi.mocked(verifyYouTubeTrackParameters)
    .mockResolvedValueOnce({ videoPacketCount: 600, averageVideoFrameRate: 29.85 } as never)
    .mockResolvedValueOnce({
      videoPacketCount: 600,
      averageVideoFrameRate: 600 / (600 / 29.85 + 0.001),
    } as never);
  const result = await prepareYouTubeMergedOutput(staged, {
    root: store.root,
    signal: new AbortController().signal,
  });
  expect(result.parameters.videoPacketCount).toBe(600);
  await result.dispose();
});
it('passes the selected container to the packet-copy executor and reads the output back', async () => {
  const store = storage();
  const signal = new AbortController().signal;
  const result = await prepareYouTubeMergedOutput(staged, { root: store.root, signal });
  expect(vi.mocked(remuxStagedBlobsToFile).mock.calls[0]?.[4]).toMatchObject({
    preferredContainer: 'webm',
    videoStreamIdentity: 'abcdefghijk',
    audioStreamIdentity: 'abcdefghijk',
  });
  expect(verifyYouTubeTrackParameters).toHaveBeenLastCalledWith(
    staged.plan,
    result.file,
    result.file,
    signal,
    'merged',
  );
  expect(store.mock.removeEntry).not.toHaveBeenCalled();
  await result.dispose();
  await result.dispose();
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('does not allocate output if source parameters fail', async () => {
  const store = storage();
  vi.mocked(verifyYouTubeTrackParameters).mockRejectedValueOnce(
    new Error('OUTPUT_SELECTION_MISMATCH'),
  );
  await expect(
    prepareYouTubeMergedOutput(staged, { root: store.root, signal: new AbortController().signal }),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
  expect(store.mock.getFileHandle).not.toHaveBeenCalled();
});
it('preserves the actual source language tag and rejects a changed output tag', async () => {
  const store = storage();
  vi.mocked(verifyYouTubeTrackParameters)
    .mockResolvedValueOnce({ audioLanguage: 'jpn', completePlaybackVerified: false } as never)
    .mockResolvedValueOnce({ audioLanguage: 'eng', completePlaybackVerified: false } as never);
  await expect(
    prepareYouTubeMergedOutput(staged, {
      root: store.root,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
  expect(vi.mocked(remuxStagedBlobsToFile).mock.calls[0]?.[4]).toMatchObject({
    audioLanguageCode: 'jpn',
  });
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});

it.each(['und', 'eng'])(
  'explicitly preserves unknown source language; output %s',
  async (outputLanguage) => {
    const store = storage();
    const parameters = {
      audioLanguage: 'und',
      videoPacketCount: 60,
      averageVideoFrameRate: 30,
      completePlaybackVerified: false,
    };
    vi.mocked(verifyYouTubeTrackParameters)
      .mockResolvedValueOnce(parameters as never)
      .mockResolvedValueOnce({ ...parameters, audioLanguage: outputLanguage } as never);
    const operation = prepareYouTubeMergedOutput(staged, {
      root: store.root,
      signal: new AbortController().signal,
    });
    if (outputLanguage === 'und')
      await expect(operation).resolves.toMatchObject({ parameters: { audioLanguage: 'und' } });
    else await expect(operation).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
    expect(vi.mocked(remuxStagedBlobsToFile).mock.calls[0]?.[4]).toMatchObject({
      audioLanguageCode: 'und',
    });
  },
);
it('removes output if its container changed', async () => {
  const store = storage();
  vi.mocked(remuxStagedBlobsToFile).mockResolvedValueOnce({
    plan: { mode: 'packet-copy', container: 'mp4' },
  } as never);
  await expect(
    prepareYouTubeMergedOutput(staged, { root: store.root, signal: new AbortController().signal }),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('removes output when readback verification fails', async () => {
  const store = storage();
  vi.mocked(verifyYouTubeTrackParameters)
    .mockResolvedValueOnce({ completePlaybackVerified: false } as never)
    .mockRejectedValueOnce(new Error('OUTPUT_SELECTION_MISMATCH'));
  await expect(
    prepareYouTubeMergedOutput(staged, { root: store.root, signal: new AbortController().signal }),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
it('removes partial output when remux fails without disposing original tracks', async () => {
  const store = storage();
  vi.mocked(remuxStagedBlobsToFile).mockRejectedValueOnce(new Error('TIMELINE_MISMATCH'));
  await expect(
    prepareYouTubeMergedOutput(staged, { root: store.root, signal: new AbortController().signal }),
  ).rejects.toThrow('TIMELINE_MISMATCH');
  expect(store.mock.removeEntry).toHaveBeenCalledTimes(1);
});
