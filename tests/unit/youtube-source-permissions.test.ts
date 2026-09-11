import { expect, it, vi } from 'vitest';
import {
  runYouTubeSourcePermission,
  YOUTUBE_SOURCE_PERMISSIONS,
} from '../../src/modules/youtube/source-permissions';

it('requests only transport access in the click turn and commits the same intent after staging', async () => {
  let staged!: () => void;
  const stage = vi.fn(
    (_intent: unknown) =>
      new Promise<void>((resolve) => {
        staged = resolve;
      }),
  );
  const commit = vi.fn(async (id: string) => id);
  const cancel = vi.fn(async () => {});
  const request = vi.fn(async () => true);
  const pending = runYouTubeSourcePermission(
    { id: 'fixed-intent', createdAt: 1, action: { jobId: 'fixed-job' } },
    { stage, commit, cancel },
    { request },
  );
  expect(request).toHaveBeenCalledWith({
    origins: ['https://*.googlevideo.com/*'],
    permissions: ['webRequest'],
  });
  expect(commit).not.toHaveBeenCalled();
  expect(stage.mock.calls[0]?.[0]).toMatchObject({ permissions: YOUTUBE_SOURCE_PERMISSIONS });
  staged();
  expect(await pending).toBe('fixed-intent');
  expect(commit).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});

it('cancels the staged intent on denial without starting its action', async () => {
  const stage = vi.fn(async () => {});
  const commit = vi.fn(async () => null);
  const cancel = vi.fn(async (_id: string) => {});
  await expect(
    runYouTubeSourcePermission(
      { id: 'denied', createdAt: 1, action: {} },
      { stage, commit, cancel },
      { request: async () => false },
    ),
  ).rejects.toThrow('下载未开始');
  expect(cancel).toHaveBeenCalledWith('denied');
  expect(commit).not.toHaveBeenCalled();
});
