import { expect, it, vi } from 'vitest';
import {
  startYouTubeDownloadWithPermission,
  type YouTubeStartMessage,
} from '../../src/modules/youtube/permission-download';
import type { ApiResponse, UiRequest } from '../../src/shared/types';

const message = (): YouTubeStartMessage => ({
  type: 'START_YOUTUBE_DOWNLOAD',
  jobId: 'fixed-job',
  tabId: 7,
  selection: {
    videoId: 'abcdefghijk',
    videoTrackId: 'av1',
    audioTrackId: 'aac',
    container: 'mp4',
    mode: 'merge',
  },
  saveLocation: 'custom',
  directorySessionId: 'validated-directory-session',
});

it('requests in the click turn, stages a fixed selection, and commits the same job without START', async () => {
  let finish!: (response: ApiResponse<unknown>) => void;
  const send = vi
    .fn<(message: UiRequest) => Promise<ApiResponse<unknown>>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, data: { jobId: 'fixed-job' } });
  const request = vi.fn(async () => true);
  const input = message();
  const pending = startYouTubeDownloadWithPermission(input, send, { request });
  expect(request).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  input.selection.videoTrackId = 'changed';
  expect(send.mock.calls[0]![0]).toMatchObject({
    type: 'STAGE_YOUTUBE_DOWNLOAD_PERMISSION',
    jobId: 'fixed-job',
    selection: { videoTrackId: 'av1' },
    directorySessionId: 'validated-directory-session',
  });
  finish({ ok: true, data: 'fixed-job' });
  await expect(pending).resolves.toMatchObject({ ok: true });
  expect(send.mock.calls.map(([m]) => m.type)).toEqual([
    'STAGE_YOUTUBE_DOWNLOAD_PERMISSION',
    'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION',
  ]);
  expect(send.mock.calls[1]![0]).toEqual({
    type: 'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION',
    jobId: 'fixed-job',
    tabId: 7,
  });
});

it('returns a safe denial only after background cancellation is confirmed', async () => {
  const send = vi
    .fn<(message: UiRequest) => Promise<ApiResponse<unknown>>>()
    .mockResolvedValueOnce({ ok: true, data: 'fixed-job' })
    .mockResolvedValueOnce({ ok: true, data: null });
  await expect(
    startYouTubeDownloadWithPermission(message(), send, { request: async () => false }),
  ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('下载未开始') });
  expect(send.mock.calls.map(([m]) => m.type)).toEqual([
    'STAGE_YOUTUBE_DOWNLOAD_PERMISSION',
    'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION',
  ]);
});

it('does not report safe failure when cancellation or granted commit is uncertain', async () => {
  for (const granted of [false, true]) {
    const send = vi
      .fn<(message: UiRequest) => Promise<ApiResponse<unknown>>>()
      .mockResolvedValueOnce({ ok: true, data: 'fixed-job' })
      .mockRejectedValueOnce(new Error('response lost'));
    await expect(
      startYouTubeDownloadWithPermission(message(), send, { request: async () => granted }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.some(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toBe(false);
  }
});

it('waits for late staging before cancelling a rejected permission request', async () => {
  let finish!: (response: ApiResponse<unknown>) => void;
  const send = vi
    .fn<(message: UiRequest) => Promise<ApiResponse<unknown>>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, data: null });
  const pending = startYouTubeDownloadWithPermission(message(), send, {
    request: async () => {
      throw new Error('request unavailable');
    },
  });
  const observed = expect(pending).rejects.toThrow('request unavailable');
  await Promise.resolve();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  finish({ ok: true, data: 'fixed-job' });
  await observed;
  expect(send.mock.calls[1]![0].type).toBe('CANCEL_YOUTUBE_DOWNLOAD_PERMISSION');
});
