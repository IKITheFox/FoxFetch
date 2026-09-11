import { beforeEach, expect, it, vi } from 'vitest';
import { prepareYouTubeDownload } from '../../src/modules/youtube/prepare-download';
import { stageYouTubeSabrSelection } from '../../src/modules/youtube/sources/staged-selection';
import { prepareYouTubeMergedOutput } from '../../src/modules/youtube/merged-output';
import { prepareYouTubeSeparateOutputs } from '../../src/modules/youtube/separate-output';
vi.mock('../../src/modules/youtube/sources/staged-selection', () => ({
  stageYouTubeSabrSelection: vi.fn(),
}));
vi.mock('../../src/modules/youtube/merged-output', () => ({ prepareYouTubeMergedOutput: vi.fn() }));
vi.mock('../../src/modules/youtube/separate-output', () => ({
  prepareYouTubeSeparateOutputs: vi.fn(),
}));
const dispose = vi.fn(async () => {});
const removeMerged = vi.fn(async () => {});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(stageYouTubeSabrSelection).mockResolvedValue({ dispose } as never);
  vi.mocked(prepareYouTubeMergedOutput).mockResolvedValue({
    file: new File(['m'], 'm.webm'),
    dispose: removeMerged,
  } as never);
  vi.mocked(prepareYouTubeSeparateOutputs).mockResolvedValue({
    video: new File(['v'], 'v.webm'),
    audio: new File(['a'], 'a.webm'),
  } as never);
});
const run = (mode: 'merge' | 'separate') =>
  prepareYouTubeDownload(
    { mode, container: mode === 'merge' ? 'webm' : null } as never,
    'abcdefghijk',
    {} as never,
    mode,
    {
      signal: new AbortController().signal,
    },
  );
it('prepares merged files without claiming publication and retains files until disposal', async () => {
  const result = await run('merge');
  expect(result.files).toHaveLength(1);
  expect(result.publicationCommitted).toBe(false);
  expect(dispose).not.toHaveBeenCalled();
  await result.dispose();
  await result.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(removeMerged).toHaveBeenCalledTimes(1);
});
it('prepares both separate files without invoking the merge path', async () => {
  const result = await run('separate');
  expect(result.files).toHaveLength(2);
  expect(prepareYouTubeMergedOutput).not.toHaveBeenCalled();
  await result.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});
it('cleans staged files if merge preparation fails', async () => {
  vi.mocked(prepareYouTubeMergedOutput).mockRejectedValueOnce(new Error('TIMELINE_MISMATCH'));
  await expect(run('merge')).rejects.toThrow('TIMELINE_MISMATCH');
  expect(dispose).toHaveBeenCalledTimes(1);
});
it('never starts output preparation if acquisition fails', async () => {
  vi.mocked(stageYouTubeSabrSelection).mockRejectedValueOnce(new Error('SESSION_REQUIRED'));
  await expect(run('merge')).rejects.toThrow('SESSION_REQUIRED');
  expect(prepareYouTubeMergedOutput).not.toHaveBeenCalled();
});
it('rejects a different output action before any media is read', async () => {
  await expect(
    prepareYouTubeDownload(
      { mode: 'separate', container: null } as never,
      'abcdefghijk',
      {} as never,
      'merge',
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow('OUTPUT_MODE_MISMATCH');
  expect(stageYouTubeSabrSelection).not.toHaveBeenCalled();
});
it.each(['merge', 'separate'] as const)(
  'does not return prepared %s files after cancellation',
  async (mode) => {
    const controller = new AbortController();
    if (mode === 'merge') {
      vi.mocked(prepareYouTubeMergedOutput).mockImplementationOnce(async () => {
        controller.abort();
        return { file: new File(['m'], 'm.webm'), dispose: removeMerged } as never;
      });
    } else {
      vi.mocked(prepareYouTubeSeparateOutputs).mockImplementationOnce(async () => {
        controller.abort();
        return { video: new File(['v'], 'v.webm'), audio: new File(['a'], 'a.webm') } as never;
      });
    }
    await expect(
      prepareYouTubeDownload(
        { mode, container: mode === 'merge' ? 'webm' : null } as never,
        'abcdefghijk',
        {} as never,
        mode,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    if (mode === 'merge') expect(removeMerged).toHaveBeenCalledTimes(1);
  },
);
