import { afterEach, expect, it, vi } from 'vitest';
import { renderYouTubeTaskControls } from '../../src/modules/youtube/task-view';
import type { YouTubeTaskSnapshot } from '../../src/modules/youtube/background-task';
import type { YouTubeSelection } from '../../src/modules/youtube/selection';
import type { ApiResponse, UiRequest } from '../../src/shared/types';

vi.mock('../../src/modules/jobs/path-policy', async (original) => ({
  ...(await original<object>()),
  saveMergeDownloadPathPolicy: vi.fn().mockResolvedValue({ mode: 'automatic' }),
}));
let index = 0;
it.each([undefined, 2048, 1024])(
  'renders reliable read totals without premature success: %s',
  async (totalBytes) => {
    const s = setup();
    s.send.mockImplementation(async (message) => ({
      ok: true,
      data:
        'jobId' in message
          ? {
              jobId: message.jobId,
              videoId: s.selection.videoId,
              state: 'preparing',
              preparationStage: 'downloading',
              readBytes: 1024,
              ...(totalBytes === undefined ? {} : { totalBytes }),
              files: [],
              cleanupPending: true,
            }
          : null,
    }));
    s.controls.select(s.selection, true);
    s.start.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.host.textContent).toContain(
      totalBytes === 2048 ? '已读取：1 KB / 2 KB' : '已读取：1 KB',
    );
    expect(s.host.textContent).not.toContain('建议位置');
    const label = s.host.querySelector('[data-role="merge-progress-label"]')!;
    expect(label.textContent).toBe(
      totalBytes === 2048 ? '50%' : totalBytes === 1024 ? '100%' : '已读取 1 KB',
    );
    expect(s.host.querySelector('.merge-progress-heading strong')?.textContent).not.toContain(
      '总进度 100%',
    );
  },
);
it('bounds unknown task polling and offers requery without creating another task', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const send = vi
    .fn<NonNullable<Parameters<typeof renderYouTubeTaskControls>[2]['send']>>()
    .mockResolvedValue({ ok: true, data: null });
  const controls = renderYouTubeTaskControls(host, 'unknownjob1', {
    tabId: 12345,
    send,
    restore: false,
  });
  controls.select(
    { videoId: 'unknownjob1', videoTrackId: 'v', audioTrackId: 'a', container: 'auto' },
    true,
  );
  host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!.click();
  await vi.advanceTimersByTimeAsync(61000);
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(send.mock.calls).toHaveLength(count);
  expect(host.textContent).toContain('重新查询任务');
  expect(send.mock.calls.filter(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toHaveLength(1);
});
it('shows download and cancel, freezes the merge plan and rejects duplicate starts', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const send = vi
    .fn<NonNullable<Parameters<typeof renderYouTubeTaskControls>[2]['send']>>()
    .mockResolvedValue({ ok: true, data: null });
  const controls = renderYouTubeTaskControls(host, 'sharedaac01', {
    tabId: 884,
    send,
    restore: false,
    sharedActions: true,
  });
  const value: YouTubeSelection = {
    videoId: 'sharedaac01',
    videoTrackId: 'vp9',
    audioTrackId: 'aac-default',
    container: 'auto',
    mode: 'merge',
  };
  controls.select(value, true);
  controls.selectSeparate(value, true);
  const separate = host.querySelector<HTMLButtonElement>('[data-youtube-download-separate]')!;
  const merge = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
  expect(separate).toBeNull();
  expect(merge.disabled).toBe(false);
  merge.click();
  value.audioTrackId = 'later-change';
  merge.click();
  const starts = send.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'START_YOUTUBE_DOWNLOAD');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    selection: { mode: 'merge', audioTrackId: 'aac-default', container: 'auto' },
  });
  controls.select(
    { videoId: value.videoId, videoTrackId: 'muxed', container: 'auto', mode: 'merge' },
    true,
    true,
  );
  expect(host.querySelector('[data-youtube-download-separate]')).toBeNull();
});
const buttonNamed = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll('button')).find((button) => button.textContent === name)!;
it('rechecks a failed initial lookup without starting or duplicating a download', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const send = vi
    .fn<NonNullable<Parameters<typeof renderYouTubeTaskControls>[2]['send']>>()
    .mockResolvedValueOnce({ ok: false, error: 'temporary lookup failure' })
    .mockResolvedValue({ ok: true, data: null });
  const controls = renderYouTubeTaskControls(host, 'lookupretry', { tabId: 991, send });
  controls.select(
    {
      videoId: 'lookupretry',
      videoTrackId: 'v',
      audioTrackId: 'a',
      container: 'auto',
      mode: 'merge',
    },
    true,
  );
  await vi.advanceTimersByTimeAsync(0);
  const retry = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === '重新查询任务',
  )!;
  const start = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
  expect(retry.hidden).toBe(false);
  expect(start.disabled).toBe(true);
  retry.click();
  retry.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(send.mock.calls.map(([message]) => message.type)).toEqual([
    'GET_CURRENT_YOUTUBE_DOWNLOAD',
    'GET_CURRENT_YOUTUBE_DOWNLOAD',
  ]);
  expect(retry.hidden).toBe(true);
  expect(start.disabled).toBe(false);
});

function setup() {
  vi.useFakeTimers();
  const videoId = `testvideo${String(++index).padStart(2, '0')}`;
  const host = document.createElement('div');
  document.body.append(host);
  let state: YouTubeTaskSnapshot['state'] = 'preparing';
  let cleanupPending = false;
  let retryAvailable = false;
  let error: string | undefined;
  const send = vi
    .fn<(message: UiRequest) => Promise<ApiResponse<YouTubeTaskSnapshot | null>>>()
    .mockImplementation(async (message) => ({
      ok: true,
      data:
        'jobId' in message
          ? {
              jobId: message.jobId,
              videoId,
              state,
              readBytes: 8,
              files: [],
              cleanupPending,
              retryAvailable,
              ...(error ? { error } : {}),
            }
          : null,
    }));
  const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const directorySend = vi
    .fn<NonNullable<Parameters<typeof renderYouTubeTaskControls>[2]['directorySend']>>()
    .mockResolvedValue({ ok: true, data: null });
  const controls = renderYouTubeTaskControls(host, videoId, {
    tabId: index,
    send,
    copy,
    restore: false,
    directorySend,
  });
  const selection: YouTubeSelection = {
    videoId,
    videoTrackId: 'video',
    audioTrackId: 'audio',
    container: 'auto',
    mode: 'merge',
  };
  const start = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
  const cancel = buttonNamed(host, '取消');
  const settings = buttonNamed(host, '打开设置');
  return {
    host,
    send,
    directorySend,
    controls,
    copy,
    selection,
    start,
    cancel,
    settings,
    set: (next: typeof state, pending = false, code?: string, retry = false) => {
      state = next;
      cleanupPending = pending;
      error = code;
      retryAvailable = retry;
    },
  };
}

it('uses the shared location trigger without Bilibili delegates and restores focus on Escape', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  const trigger = s.host.querySelector<HTMLButtonElement>('.merge-path')!;
  const editor = s.host.querySelector<HTMLElement>('.youtube-location-dialog')!;
  const choices = editor.querySelectorAll<HTMLButtonElement>('.merge-path-choice');
  expect(trigger.hasAttribute('data-merge-action')).toBe(false);
  expect(trigger.querySelector('[data-role]')).toBeNull();
  expect(editor.hidden).toBe(true);
  trigger.click();
  expect(editor.hidden).toBe(false);
  expect(document.activeElement).toBe(choices[0]);
  expect(editor.querySelector('[data-action]')).toBeNull();
  choices[1]!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(trigger.textContent).toContain('保存时选择位置');
  expect(editor.hidden).toBe(true);
  trigger.click();
  choices[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(editor.hidden).toBe(true);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(s.send).not.toHaveBeenCalled();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('groups task actions in the shared layout without exposing hidden recovery operations', () => {
  const s = setup();
  expect(s.start.parentElement?.className).toBe('merge-actions');
  expect(s.cancel.parentElement).toBe(s.start.parentElement);
  expect(s.start.classList.contains('primary')).toBe(true);
  expect(s.settings.parentElement?.className).toBe('merge-actions');
  expect(s.settings.parentElement).not.toBe(s.start.parentElement);
  const block = s.host.querySelector('[data-youtube-task]')!;
  const order = Array.from(block.children);
  expect(order.indexOf(block.querySelector('.merge-diagnostics')!)).toBeLessThan(
    order.indexOf(block.querySelector('.merge-path')!),
  );
  expect(order.indexOf(block.querySelector('.merge-path')!)).toBeLessThan(
    order.indexOf(s.start.parentElement!),
  );
  expect(s.cancel.hidden).toBe(false);
  expect(s.cancel.disabled).toBe(true);
  expect(s.settings.hidden).toBe(true);
  expect(s.send).not.toHaveBeenCalled();
});

it('removes the custom-directory entry and cannot open its old picker', async () => {
  const s = setup();
  expect(s.host.querySelector('[data-path-mode="custom"]')).toBeNull();
  expect(s.host.querySelectorAll('.merge-path-choice')).toHaveLength(2);
  buttonNamed(s.host, '选择目录').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.directorySend).not.toHaveBeenCalled();
});

it('folds successful text with details but retains progress and failure summaries', async () => {
  const s = setup();
  const original = s.send.getMockImplementation()!;
  s.send.mockImplementation(async (message) => {
    const response = await original(message);
    return response.ok && response.data
      ? { ok: true, data: { ...response.data, selection: structuredClone(s.selection) } }
      : response;
  });
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  s.set('complete');
  await vi.advanceTimersByTimeAsync(1500);
  const status = s.host.querySelector<HTMLElement>('[data-youtube-task-status]')!;
  const details = s.host.querySelector<HTMLDetailsElement>('[data-youtube-task-details]')!;
  expect(details.contains(status)).toBe(true);
  expect(details.open).toBe(false);
  expect(s.host.querySelector('[data-role="merge-progress-label"]')!.textContent).toBe('100%');
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  expect(status.hidden).toBe(false);
  details.open = false;
  details.dispatchEvent(new Event('toggle'));
  expect(details.contains(status)).toBe(true);
  expect(details.open).toBe(false);
  s.set('failed');
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(status.hidden).toBe(false);
});

it('requires explicit migration before starting a legacy custom selection', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  const location = s.host.querySelector('select')!;
  location.value = 'custom';
  location.dispatchEvent(new Event('change'));
  s.start.click();
  expect(s.host.querySelector<HTMLElement>('.youtube-location-dialog')!.hidden).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
  s.host.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send).not.toHaveBeenCalled();
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send.mock.calls[0]![0]).toMatchObject({
    type: 'START_YOUTUBE_DOWNLOAD',
    saveLocation: 'ask',
  });
  expect(s.send.mock.calls[0]![0]).not.toHaveProperty('directorySessionId');
});
it('does not auto-expand details when a source error arrives', async () => {
  const s = setup();
  s.set('failed', false, 'SOURCE_PERMISSION_REQUIRED');
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const details = s.host.querySelector<HTMLDetailsElement>('[data-youtube-task-details]')!;
  expect(details.open).toBe(false);
  expect(s.host.textContent).toContain('下载失败');
  details.open = true;
  s.controls.refresh();
  expect(details.open).toBe(true);
  details.open = false;
  s.controls.refresh();
  expect(details.open).toBe(false);
});

it.each([
  ['SOURCE_STORAGE_FULL', '浏览器临时存储空间不足'],
  ['SOURCE_STORAGE_FAILED', '无法写入视频临时文件'],
  ['SOURCE_READ_TIMEOUT', '等待视频数据超时'],
  ['SOURCE_ADDRESS_REJECTED', '可能是地址失效或访问受限'],
  ['SAVE_STATUS_UNAVAILABLE', '暂时无法确认浏览器保存结果'],
])('explains %s without presenting a generic failure alone', async (code, message) => {
  const s = setup();
  s.set('failed', false, code);
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.host.textContent).toContain(message);
  expect(s.host.textContent).toContain(`错误码：${code}`);
});

it('scopes successful saves to the exact selection and does not reuse them after changing tracks', async () => {
  const s = setup();
  s.send.mockImplementation(async (message) => ({
    ok: true,
    data:
      'jobId' in message
        ? {
            jobId: message.jobId,
            videoId: s.selection.videoId,
            selection: structuredClone(s.selection),
            state: 'complete',
            readBytes: 8,
            files: [{ kind: 'merged', size: 8, state: 'complete' }],
            cleanupPending: false,
          }
        : null,
  }));
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const status = s.host.querySelector('[role="status"]')!;
  expect(status.textContent).toBe('当前选择的文件已保存成功。');
  for (const change of [
    { videoTrackId: 'other-resolution-or-codec-or-version' },
    { audioTrackId: 'other-language' },
    { container: 'webm' as const },
    { mode: 'separate' as const },
    { videoId: 'othervideo1' },
  ]) {
    s.controls.select({ ...s.selection, ...change }, true);
    expect(status.textContent).toBe('此前任务已保存成功；此结果不代表当前选择已完成下载。');
    expect(s.host.querySelector('.merge-meter')!.getAttribute('aria-valuenow')).toBe('0');
    expect(s.host.querySelector('[data-role="merge-state"]')!.getAttribute('aria-label')).toBe(
      '等待下载',
    );
  }
  s.controls.select(s.selection, true);
  expect(status.textContent).toBe('当前选择的文件已保存成功。');
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.host.querySelector('.merge-meter')!.getAttribute('aria-valuenow')).toBe('100');
});

it('does not start during rendering or selection and blocks unimplemented sources', () => {
  const s = setup();
  expect(s.start.disabled).toBe(true);
  s.controls.select(s.selection, false);
  s.start.click();
  expect(s.send).not.toHaveBeenCalled();
  s.controls.select(s.selection, true);
  expect(s.start.disabled).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
});
it('ten clicks freeze one selection and create only one task', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  for (let i = 0; i < 10; i++) s.start.click();
  s.selection.videoTrackId = 'new-choice';
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send.mock.calls.filter(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toHaveLength(1);
  expect(s.send.mock.calls[0]![0]).toMatchObject({ selection: { videoTrackId: 'video' } });
  expect(s.start.disabled).toBe(true);
  expect(s.host.textContent).toContain('正在下载和处理视频');
});
it('Chrome-completed task unlocks another download with a different ID', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  s.set('saving');
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.start.disabled).toBe(true);
  s.set('complete');
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.start.disabled).toBe(false);
  expect(s.host.textContent).toContain('保存成功');
  const first = s.send.mock.calls[0]![0];
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const starts = s.send.mock.calls.filter(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD');
  expect(starts).toHaveLength(2);
  expect(starts[1]![0]).not.toMatchObject({ jobId: 'jobId' in first ? first.jobId : '' });
});
it('an ambiguous start response polls the same ID, never starts another task', async () => {
  const s = setup();
  s.send.mockRejectedValueOnce(new Error('private URL'));
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  s.start.click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.send.mock.calls.map(([m]) => m.type)).toEqual([
    'START_YOUTUBE_DOWNLOAD',
    'GET_YOUTUBE_DOWNLOAD',
  ]);
  const messages = s.send.mock.calls.map(([m]) => m as { jobId: string });
  expect(messages[0]!.jobId).toBe(messages[1]!.jobId);
  expect(s.host.textContent).not.toContain('private URL');
});
it('cancel uses the existing ID; cleanup pending does not prematurely unlock start', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  s.set('canceling');
  s.cancel.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send.mock.calls[1]![0].type).toBe('CANCEL_YOUTUBE_DOWNLOAD');
  expect(s.cancel.disabled).toBe(true);
  s.set('canceled', true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.start.disabled).toBe(true);
  s.set('canceled', false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.start.disabled).toBe(false);
  expect(s.start.textContent).toBe('重新下载');
  const oldStart = s.send.mock.calls.find(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')![0];
  s.start.click();
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const starts = s.send.mock.calls
    .map(([m]) => m)
    .filter((m) => m.type === 'START_YOUTUBE_DOWNLOAD');
  expect(starts).toHaveLength(2);
  const newStart = starts[1]!;
  if (!('jobId' in newStart) || !('jobId' in oldStart)) throw new Error('Missing task identity');
  expect(newStart.jobId).not.toBe(oldStart.jobId);
});
it('missing permission has a settings action and details toggle has correct text', async () => {
  const s = setup();
  s.set('failed', false, 'SOURCE_PERMISSION_REQUIRED');
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.settings.hidden).toBe(false);
  expect(s.host.textContent).toContain('允许访问 YouTube 视频来源');
  s.settings.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send.mock.calls.at(-1)![0].type).toBe('OPEN_YOUTUBE_PERMISSIONS');
  const details = s.host.querySelector('details')!;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  expect(details.querySelector('summary')!.textContent).toBe('收起');
});
it('removing the panel stops observation but sends no cancellation', async () => {
  const s = setup();
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  s.host.remove();
  await vi.advanceTimersByTimeAsync(2000);
  expect(s.send.mock.calls.map(([m]) => m.type)).toEqual(['START_YOUTUBE_DOWNLOAD']);
});

it('recheck uses the original task and unlocks only after cleanup is confirmed', async () => {
  const s = setup();
  s.set('failed', true, 'SAVE_STATUS_UNAVAILABLE');
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const recheck = buttonNamed(s.host, '重新检查保存状态');
  expect(recheck.hidden).toBe(false);
  expect(s.start.disabled).toBe(true);
  s.set('failed', false, 'SAVE_STATUS_UNAVAILABLE');
  for (let i = 0; i < 10; i++) recheck.click();
  await vi.advanceTimersByTimeAsync(0);
  const checks = s.send.mock.calls.filter(([m]) => m.type === 'RECHECK_YOUTUBE_DOWNLOAD');
  expect(checks).toHaveLength(1);
  const original = s.send.mock.calls[0]![0] as { jobId: string };
  expect(checks[0]![0]).toMatchObject({ jobId: original.jobId });
  expect(s.start.disabled).toBe(false);
  expect(recheck.hidden).toBe(true);
  expect(s.send.mock.calls.filter(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toHaveLength(1);
});

it.each(['response', 'error'] as const)(
  'ignores an old recheck %s after another download starts',
  async (outcome) => {
    const s = setup();
    s.set('failed', true, 'SAVE_STATUS_UNAVAILABLE');
    s.controls.select(s.selection, true);
    s.start.click();
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (value: ApiResponse<YouTubeTaskSnapshot | null>) => void;
    let reject!: (reason: Error) => void;
    s.send.mockImplementationOnce(
      () =>
        new Promise((ok, fail) => {
          resolve = ok;
          reject = fail;
        }),
    );
    buttonNamed(s.host, '重新检查保存状态').click();
    const old = s.send.mock.calls[0]![0] as { jobId: string };
    s.set('failed', false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.start.disabled).toBe(false);
    s.set('preparing');
    s.start.click();
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'error') reject(new Error('private source'));
    else
      resolve({
        ok: true,
        data: {
          jobId: old.jobId,
          videoId: s.selection.videoId,
          state: 'failed',
          cleanupPending: true,
          readBytes: 8,
          files: [],
        },
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.host.querySelector('[role="status"]')!.textContent).toBe('正在下载和处理视频');
    expect(s.start.disabled).toBe(true);
    expect(s.host.textContent).not.toContain(old.jobId);
  },
);

it('a late saving query cannot relock a task whose cleanup was confirmed by recheck', async () => {
  const s = setup();
  s.set('failed', true);
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  let resolve!: (value: ApiResponse<YouTubeTaskSnapshot | null>) => void;
  s.send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  s.set('failed', false);
  buttonNamed(s.host, '重新检查保存状态').click();
  await vi.advanceTimersByTimeAsync(0);
  const old = s.send.mock.calls[0]![0] as { jobId: string };
  resolve({
    ok: true,
    data: {
      jobId: old.jobId,
      videoId: s.selection.videoId,
      state: 'saving',
      cleanupPending: true,
      readBytes: 8,
      files: [],
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(s.start.disabled).toBe(false);
  expect(s.host.querySelector('[role="status"]')!.textContent).toBe('下载失败');
});

it('allows explicit browser save location without starting work until download is clicked', async () => {
  const s = setup();
  const location = s.host.querySelector('select')!;
  location.value = 'ask';
  location.dispatchEvent(new Event('change'));
  expect(s.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.send.mock.calls[0]![0]).toMatchObject({ saveLocation: 'ask' });
  expect(location.disabled).toBe(true);
});

it.each(['retry', 'discard'] as const)(
  'exposes %s for retained failed saves without creating a new task',
  async (action) => {
    const s = setup();
    s.set('failed', true, 'SAVE_INCOMPLETE', true);
    s.controls.select(s.selection, true);
    s.start.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(buttonNamed(s.host, '重新检查保存状态').hidden).toBe(true);
    expect(buttonNamed(s.host, '重试未保存文件').hidden).toBe(false);
    expect(buttonNamed(s.host, '放弃重试并释放临时文件').hidden).toBe(false);
    s.set(action === 'retry' ? 'saving' : 'failed', action === 'retry');
    for (let i = 0; i < 10; i++)
      buttonNamed(s.host, action === 'retry' ? '重试未保存文件' : '放弃重试并释放临时文件').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.send.mock.calls.filter(
        ([m]) => m.type === (action === 'retry' ? 'RETRY_YOUTUBE_SAVE' : 'DISCARD_YOUTUBE_SAVE'),
      ),
    ).toHaveLength(1);
    expect(s.send.mock.calls.filter(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toHaveLength(1);
    expect(s.start.disabled).toBe(action === 'retry');
  },
);

it('ignores a pre-retry query arriving after the new save attempt is acknowledged', async () => {
  const s = setup();
  s.set('failed', true, 'SAVE_INCOMPLETE', true);
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const first = s.send.mock.calls[0]![0] as { jobId: string };
  const base = {
    jobId: first.jobId,
    videoId: s.selection.videoId,
    readBytes: 8,
    files: [],
    cleanupPending: true,
  };
  let resolve!: (value: ApiResponse<YouTubeTaskSnapshot | null>) => void;
  s.send.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  s.send.mockResolvedValueOnce({
    ok: true,
    data: { ...base, state: 'saving', saveAttempt: 1, retryAvailable: false },
  });
  buttonNamed(s.host, '重试未保存文件').click();
  await vi.advanceTimersByTimeAsync(0);
  resolve({ ok: true, data: { ...base, state: 'failed', saveAttempt: 0, retryAvailable: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(buttonNamed(s.host, '重试未保存文件').hidden).toBe(true);
  expect(s.host.querySelector('[role="status"]')!.textContent).toBe('正在保存文件');
  expect(s.start.disabled).toBe(true);
});

it('copies a snapshot once and reports clipboard failure without changing the download state', async () => {
  const s = setup();
  s.set('failed', false, 'SAVE_INCOMPLETE');
  s.controls.select(s.selection, true);
  s.start.click();
  await vi.advanceTimersByTimeAsync(0);
  const button = buttonNamed(s.host, '复制诊断信息');
  for (let i = 0; i < 10; i++) button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.copy).toHaveBeenCalledTimes(1);
  expect(s.copy.mock.calls[0]![0]).toContain('SAVE_INCOMPLETE');
  expect(s.host.textContent).toContain('诊断信息已复制');
  s.copy.mockRejectedValueOnce(new Error('private clipboard error'));
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.host.textContent).toContain('无法复制，请展开详情后手动复制。');
  expect(s.host.textContent).not.toContain('private clipboard error');
  expect(s.start.disabled).toBe(false);
});

it.each([undefined, 4, 8])(
  'shows browser saved bytes %s without treating byte completion as task completion',
  async (bytes) => {
    const s = setup();
    s.send.mockImplementation(async (message) => ({
      ok: true,
      data:
        'jobId' in message
          ? {
              jobId: message.jobId,
              videoId: s.selection.videoId,
              state: 'saving',
              readBytes: 8,
              cleanupPending: true,
              files: [{ kind: 'merged', size: 8, state: 'saving', savedBytes: bytes }],
            }
          : null,
    }));
    s.controls.select(s.selection, true);
    s.start.click();
    await vi.advanceTimersByTimeAsync(0);
    const progress = s.host.querySelector('progress')!;
    expect(progress.hidden).toBe(false);
    if (bytes === undefined) expect(progress.hasAttribute('value')).toBe(false);
    else {
      expect(progress.value).toBe(bytes);
      expect(progress.max).toBe(8);
    }
    expect(s.start.disabled).toBe(true);
    expect(s.host.querySelector('[role="status"]')!.textContent).toBe('正在保存文件');
  },
);

it.each(['active', 'empty', 'failure'] as const)(
  'discovers existing tasks before enabling a new download: %s',
  async (outcome) => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.append(host);
    const videoId = `restoreid${String(++index).padStart(2, '0')}`;
    const send = vi
      .fn<(message: UiRequest) => Promise<ApiResponse<YouTubeTaskSnapshot | null>>>()
      .mockImplementation(async () => {
        if (outcome === 'failure') throw new Error('unavailable');
        return {
          ok: true,
          data:
            outcome === 'empty'
              ? null
              : {
                  jobId: '11111111-1111-4111-8111-111111111111',
                  videoId,
                  state: 'saving',
                  readBytes: 8,
                  files: [],
                  cleanupPending: true,
                },
        };
      });
    const controls = renderYouTubeTaskControls(host, videoId, { tabId: index, send });
    controls.select(
      { videoId, videoTrackId: 'v', audioTrackId: 'a', container: 'auto', mode: 'merge' },
      true,
    );
    const start = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
    expect(start.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[0]![0].type).toBe('GET_CURRENT_YOUTUBE_DOWNLOAD');
    expect(start.disabled).toBe(outcome !== 'empty');
    expect(send.mock.calls.some(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toBe(false);
    if (outcome === 'active') expect(host.textContent).toContain('正在保存文件');
  },
);
