import { expect, it } from 'vitest';
import {
  getMergeDownloadPathPolicy,
  saveMergeDownloadPathPolicy,
  getLastVideoDirectory,
} from '../../src/modules/jobs/path-policy';
import {
  buildDownloadDirectory,
  downloadFilePickerId,
} from '../../src/modules/downloads/download-path';

const youtube = 'https://www.youtube.com/watch?v=abcdefghijk';
const bili = 'https://www.bilibili.com/video/BV1test';
function storage() {
  const data: Record<string, unknown> = {};
  return {
    async get(key: string) {
      return { [key]: data[key] };
    },
    async set(value: Record<string, unknown>) {
      Object.assign(data, structuredClone(value));
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
  };
}
it('shares directory metadata and mode across both platforms and retains directory after switching to default', async () => {
  const store = storage();
  const directory = { handleId: 'youtube-last', name: '我的视频', selectedAt: 123 };
  await store.set({
    'foxfetch:video-save-policy': { mode: 'custom', directory },
    'foxfetch:last-video-directory': directory,
  });
  await expect(
    saveMergeDownloadPathPolicy(youtube, { mode: 'custom', directory }, store),
  ).rejects.toThrow('已停用');
  expect(await getMergeDownloadPathPolicy(bili, store)).toEqual({ mode: 'custom', directory });
  await saveMergeDownloadPathPolicy(bili, 'ask', store);
  expect(await getMergeDownloadPathPolicy(youtube, store)).toEqual({ mode: 'ask' });
  await saveMergeDownloadPathPolicy(youtube, 'automatic', store);
  expect(await getLastVideoDirectory(store)).toEqual(directory);
  expect(await getMergeDownloadPathPolicy('https://vimeo.com/1', store)).toEqual({
    mode: 'automatic',
  });
});
it('keeps old platform preferences readable, without renaming their stored identity', async () => {
  const store = storage();
  await store.set({ 'foxfetch:merge-path-policy:bilibili': { mode: 'ask' } });
  expect(await getMergeDownloadPathPolicy(bili, store)).toEqual({ mode: 'ask' });
  expect(buildDownloadDirectory(youtube, 'video')).toBe('FoxFetch/YouTube');
  expect(buildDownloadDirectory(bili, 'video')).toBe('FoxFetch/Bilibili');
  expect(downloadFilePickerId(bili, 'merge')).toBe('ff-merge-bilibili');
});
