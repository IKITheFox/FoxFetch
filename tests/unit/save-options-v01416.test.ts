import { afterEach, expect, it, vi } from 'vitest';
import { renderYouTubeTaskControls } from '../../src/modules/youtube/task-view';
import {
  getMergeDownloadPathPolicy,
  saveMergeDownloadPathPolicy,
  publicationSavePolicy,
} from '../../src/modules/jobs/path-policy';

const youtube = 'https://www.youtube.com/watch?v=abcdefghijk';
const bili = 'https://www.bilibili.com/video/BV1test';
const legacy = {
  mode: 'custom' as const,
  directory: { handleId: 'old', name: '11111', selectedAt: 123 },
};
function store(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, structuredClone(values));
    }),
    remove: vi.fn(async () => undefined),
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['foxfetch:video-save-policy', 'foxfetch:merge-path-policy:youtube'])(
  'migrates %s explicitly without creating a download or opening a directory picker',
  async (key) => {
    vi.useFakeTimers();
    const local = store({ [key]: legacy });
    vi.stubGlobal('chrome', { storage: { local } });
    const host = document.createElement('div');
    document.body.append(host);
    const send = vi.fn().mockResolvedValue({ ok: true, data: null });
    const controls = renderYouTubeTaskControls(host, 'abcdefghijk', {
      restore: false,
      tabId: 70,
      send,
    });
    controls.select(
      { videoId: 'abcdefghijk', videoTrackId: 'v', audioTrackId: 'a', container: 'auto' },
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    const details = host.querySelector<HTMLDetailsElement>('details')!;
    expect(details.open).toBe(false);
    expect(host.querySelector('.merge-path')!.textContent).toContain('请选择保存位置');
    const start = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
    start.click();
    expect(host.querySelector<HTMLElement>('.youtube-location-dialog')!.hidden).toBe(false);
    expect(send).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
    expect(start.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(await getMergeDownloadPathPolicy(bili, local)).toEqual({ mode: 'ask' });
    expect(start.disabled).toBe(false);
    expect(details.open).toBe(false);
    expect(host.querySelector('[data-path-mode="custom"]')).toBeNull();
  },
);

it('keeps migration unresolved after storage failure and permits a deliberate retry', async () => {
  vi.useFakeTimers();
  const local = store({ 'foxfetch:video-save-policy': legacy });
  local.set.mockRejectedValueOnce(new Error('storage unavailable'));
  vi.stubGlobal('chrome', { storage: { local } });
  const host = document.createElement('div');
  document.body.append(host);
  const send = vi.fn().mockResolvedValue({ ok: true, data: null });
  const controls = renderYouTubeTaskControls(host, 'failuretest', {
    restore: false,
    tabId: 71,
    send,
  });
  controls.select({ videoId: 'failuretest', videoTrackId: 'v', container: 'auto' }, true);
  await vi.advanceTimersByTimeAsync(0);
  host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!.click();
  host.querySelector<HTMLButtonElement>('[data-path-mode="automatic"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(await getMergeDownloadPathPolicy(youtube, local)).toEqual(legacy);
  expect(host.querySelector('.merge-path')!.textContent).toContain('请选择保存位置');
  expect(host.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
  host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!.click();
  expect(send).not.toHaveBeenCalled();
  host.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(await getMergeDownloadPathPolicy(youtube, local)).toEqual({ mode: 'ask' });
});

it('preserves fixed historical targets while rejecting missing target snapshots and late custom writes', async () => {
  const local = store({ 'foxfetch:video-save-policy': legacy });
  await saveMergeDownloadPathPolicy(youtube, 'ask', local);
  await expect(publicationSavePolicy(bili, legacy, local)).resolves.toEqual(legacy);
  await expect(publicationSavePolicy(bili, undefined, local)).rejects.toThrow('未记录固定保存位置');
  await expect(saveMergeDownloadPathPolicy(bili, legacy, local)).rejects.toThrow('已停用');
  expect(await getMergeDownloadPathPolicy(youtube, local)).toEqual({ mode: 'ask' });
  expect(local.remove).not.toHaveBeenCalled();
});
