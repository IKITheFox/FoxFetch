import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FloatingPlaybackController,
  PlaybackManager,
  TRANSPORT_HOLD_DELAY_MS,
} from '../../src/modules/playback';
import { MseCacheCaptureRuntime } from '../../src/modules/resolver/mse-cache-capture';
import type { MergeDockView } from '../../src/shared/types';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType = 'mouse';
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

let controller: FloatingPlaybackController;
let manager: PlaybackManager;
let video: HTMLVideoElement;
let cache: MseCacheCaptureRuntime | undefined;
const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const CURRENT = 'https://www.bilibili.com/video/BV1CURRENT1/';

function setUrl(url: string) {
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
}

function mount(options: ConstructorParameters<typeof FloatingPlaybackController>[2] = {}) {
  video = document.createElement('video');
  video.src = '/fixture.mp4';
  Object.defineProperties(video, {
    paused: { configurable: true, writable: true, value: true },
    duration: { configurable: true, value: 120 },
    currentTime: { configurable: true, writable: true, value: 30 },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 120 } },
  });
  video.play = vi.fn(async () => {
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    video.dispatchEvent(new Event('play'));
  });
  video.pause = vi.fn(() => {
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true });
    video.dispatchEvent(new Event('pause'));
  });
  document.body.append(video);
  document.title = 'v0.12.1 当前视频';
  manager = new PlaybackManager(document, { defaultRate: 1.75 });
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    playback: { showController: true, defaultRate: 1.75 },
    positionStore: { get: async () => ({}), set: async () => undefined },
    ...options,
  });
  controller.openPlayback();
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  return controller.shadowRoot.querySelector<T>(selector)!;
}
function action(name: string): HTMLButtonElement {
  return element(`[data-action="${name}"]`);
}
function media(name: string): HTMLButtonElement {
  return element(`[data-media-action="${name}"]`);
}
function pointer(target: EventTarget, type: string, id = 1) {
  target.dispatchEvent(
    new TestPointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: id }),
  );
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mergeView(extra: Partial<MergeDockView> = {}): MergeDockView {
  return {
    actionToken: 'action-A',
    pathToken: 'path-A',
    title: '当前完整视频',
    state: 'ready',
    phase: 'ready',
    status: '可以下载',
    progress: 0,
    savePath: 'Downloads/FoxFetch/Bilibili',
    pathMode: 'automatic',
    mergeEnabled: true,
    separateEnabled: true,
    busy: false,
    cancelEnabled: true,
    snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 1 },
    ...extra,
  };
}
function activeView(extra: Partial<MergeDockView> = {}) {
  return mergeView({ state: 'running', phase: 'fetching', busy: true, progress: 0.2, ...extra });
}
function returnLayer(): HTMLElement {
  return element('[data-role="merge-return-confirm"]');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  setUrl(CURRENT);
});
afterEach(() => {
  controller?.destroy();
  cache?.destroy();
  cache = undefined;
  manager?.stop();
  document.body.replaceChildren();
  document.title = '';
  if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
  else Reflect.deleteProperty(document, 'URL');
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('v0.12.1 playback presentation and restore 1x', () => {
  it('removes the duplicate footer status and keeps only restore and mute actions', () => {
    mount();
    expect(element('.playback-foot').textContent).toBe('恢复默认速度静音');
    expect(element('.playback-foot').querySelectorAll('button')).toHaveLength(2);
    expect(element('[data-role="current-rate"]').textContent).toBe('1.75×');
  });

  it.each([true, false])('restores only speed while paused=%s', async (paused) => {
    mount();
    if (!paused) await video.play();
    video.muted = true;
    video.volume = 0.35;
    video.currentTime = 42;
    video.playbackRate = 2.5;
    controller.update(manager.getMediaElements());
    const settings = manager.getSettings();
    media('restore-rate').click();
    await flush();
    expect(video.playbackRate).toBe(1);
    expect(video.currentTime).toBe(42);
    expect(video.paused).toBe(paused);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.35);
    expect(manager.getSettings()).toEqual(settings);
    expect(element('[data-role="current-rate"]').textContent).toBe('1×');
    expect(element<HTMLInputElement>('[data-role="rate-slider"]').value).toBe('1');
  });

  it('ends a held temporary rate before reset and ignores the late pointer release', async () => {
    mount();
    pointer(media('seek-forward'), 'pointerdown', 7);
    await vi.advanceTimersByTimeAsync(TRANSPORT_HOLD_DELAY_MS + 1);
    expect(manager.hasTemporaryTransport()).toBe(true);
    expect(video.playbackRate).toBe(3);
    media('restore-rate').click();
    await flush();
    expect(manager.hasTemporaryTransport()).toBe(false);
    expect(video.playbackRate).toBe(1);
    pointer(window, 'pointerup', 7);
    await flush();
    expect(video.playbackRate).toBe(1);
    expect(video.paused).toBe(true);
    expect(manager.getSettings().defaultRate).toBe(1.75);
  });

  it('disables restore with no controlled media and does not fabricate a successful reset', async () => {
    mount();
    controller.update([]);
    expect(media('restore-rate').disabled).toBe(true);
    const rate = video.playbackRate;
    media('restore-rate').click();
    await flush();
    expect(video.playbackRate).toBe(rate);
  });

  it('retains both SVG nodes through actual play/pause state changes and rejects failed play', async () => {
    mount();
    const icon = element('[data-role="play-icon"]');
    const play = icon.querySelector('svg.play-shape');
    const pause = icon.querySelector('svg.pause-shape');
    expect(play).not.toBeNull();
    expect(pause).not.toBeNull();
    expect(icon.querySelectorAll('svg')).toHaveLength(2);
    for (const control of controller.shadowRoot.querySelectorAll('.transport button'))
      expect(control.firstElementChild?.classList.contains('transport-icon')).toBe(true);
    await video.play();
    controller.update(manager.getMediaElements());
    expect(icon.dataset.state).toBe('playing');
    expect(media('toggle-play').getAttribute('aria-label')).toBe('暂停视频');
    video.pause();
    controller.update(manager.getMediaElements());
    expect(icon.dataset.state).toBe('paused');
    expect(icon.querySelector('svg.play-shape')).toBe(play);
    expect(icon.querySelector('svg.pause-shape')).toBe(pause);
    video.play = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    media('toggle-play').click();
    await flush();
    expect(icon.dataset.state).toBe('paused');
    expect(element('[data-role="playback-error"]').hidden).toBe(false);
  });
});

describe('v0.12.1 minimizing retains the effective view', () => {
  it('reopens the resource pane at its prior scroll without restarting discovery', async () => {
    const request = vi.fn(async () => undefined);
    mount({ onResourceViewRequest: request });
    controller.openResources();
    await flush();
    const before = request.mock.calls.length;
    element('.resources-view').scrollTop = 93;
    controller.collapse();
    expect(controller.getMode()).toBe('launcher');
    action('launcher').click();
    expect(controller.getMode()).toBe('resources');
    expect(element('.resources-view').scrollTop).toBe(93);
    expect(request).toHaveBeenCalledTimes(before);
  });

  it('preserves cache filename, options and scroll and never restarts the capture', async () => {
    cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    mount({ cacheCapture: cache });
    cache.start({ sessionId: 'v0121-ui-only', title: '缓存原名' });
    const start = vi.spyOn(cache, 'requestStart');
    const close = vi.spyOn(cache, 'close');
    controller.openCache();
    const filename = element<HTMLInputElement>('[data-role="cache-filename"]');
    filename.value = '自定义缓存名';
    filename.dispatchEvent(new Event('change', { bubbles: true }));
    cache.setAutoDownload(true);
    const options = element<HTMLDetailsElement>('.cache-options');
    options.open = true;
    element('.resources-view').scrollTop = 107;
    controller.collapse();
    cache.setClearAfterDownload(true);
    action('launcher').click();
    expect(controller.getMode()).toBe('cache');
    expect(filename.value).toBe('自定义缓存名');
    expect(options.open).toBe(true);
    expect(element('.resources-view').scrollTop).toBe(107);
    expect(element<HTMLInputElement>('[data-role="cache-auto-download"]').checked).toBe(true);
    expect(element<HTMLInputElement>('[data-role="cache-clear-after-download"]').checked).toBe(
      true,
    );
    expect(cache.getSnapshot().status).not.toBe('idle');
    expect(start).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('reopens a merge task with its latest terminal snapshot and retained details', () => {
    const call = vi.fn();
    mount({ onMergeDockAction: call });
    controller.openMerge(
      activeView({
        diagnostics: {
          stage: '正在读取视频信息',
          readBytes: 20,
          totalBytes: null,
          startedAt: 1,
          lastProgressAt: 2,
        },
      }),
    );
    const details = element<HTMLDetailsElement>('[data-role="merge-diagnostics"]');
    details.open = true;
    element('.merge-view').scrollTop = 69;
    controller.collapse();
    controller.setMergeSnapshot(
      mergeView({
        state: 'completed',
        phase: 'completed',
        progress: 1,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 2 },
      }),
    );
    expect(controller.getMode()).toBe('launcher');
    action('launcher').click();
    expect(controller.getMode()).toBe('merge');
    expect(element('[data-role="merge-state-label"]').textContent).toBe('保存成功');
    expect(element('.merge-view').scrollTop).toBe(69);
    expect(details.open).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('preserves an uncommitted cache filename draft across minimize and background refresh', () => {
    cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    mount({ cacheCapture: cache });
    cache.start({ sessionId: 'v0121-draft-only', title: '后台原文件名' });
    controller.openCache();
    const filename = element<HTMLInputElement>('[data-role="cache-filename"]');
    filename.focus();
    filename.value = '尚未失焦的草稿';
    filename.dispatchEvent(new Event('input', { bubbles: true }));
    controller.collapse();
    filename.blur();
    cache.setClearAfterDownload(true);
    action('launcher').click();
    expect(controller.getMode()).toBe('cache');
    expect(filename.value).toBe('尚未失焦的草稿');
  });

  it('does not restore a previous route task after the page identity changes', () => {
    mount();
    controller.openMerge(activeView());
    controller.collapse();
    setUrl('https://www.bilibili.com/video/BV1NEWVIDEO2/');
    controller.resetForNavigation();
    action('launcher').click();
    expect(controller.getMode()).not.toBe('merge');
    expect(element('[data-role="merge-title"]').textContent).not.toBe('当前完整视频');
  });

  it('does not reuse a filename draft when a new cache route is published', () => {
    cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    mount({ cacheCapture: cache });
    cache.start({ sessionId: 'draft-route-A', title: '旧视频' });
    controller.openCache();
    const filename = element<HTMLInputElement>('[data-role="cache-filename"]');
    filename.value = '旧视频未提交草稿';
    filename.dispatchEvent(new Event('input', { bubbles: true }));
    controller.collapse();
    setUrl('https://www.bilibili.com/video/BV1NEWVIDEO2/');
    // A cache snapshot may arrive before the content-agent navigation reset.
    cache.start({ sessionId: 'draft-route-B', title: '新视频缓存文件名' });
    expect(filename.value).toBe('新视频缓存文件名');
    controller.resetForNavigation();
    expect(filename.value).not.toBe('旧视频未提交草稿');
  });
});

describe('v0.12.1 regular download return lifecycle', () => {
  it('cancels a ready preparation without a confirmation and waits for actual stop', async () => {
    const done = deferred();
    const call = vi.fn(() => done.promise);
    mount({ onMergeDockAction: call });
    controller.openMerge(mergeView());
    action('back-from-merge').click();
    expect(returnLayer().hidden).toBe(true);
    expect(call).toHaveBeenCalledExactlyOnceWith('action-A', 'cancel');
    expect(controller.getMode()).toBe('merge');
    expect(element('[data-role="merge-state-label"]').textContent).toBe('正在终止');
    done.resolve();
    await flush();
    expect(controller.getMode()).toBe('resources');
  });

  it.each(['preparing', 'running', 'permission_required'] as const)(
    'confirms an active %s operation and can continue it unchanged',
    (state) => {
      const call = vi.fn();
      mount({ onMergeDockAction: call });
      controller.openMerge(activeView({ state }));
      action('back-from-merge').click();
      expect(returnLayer().hidden).toBe(false);
      expect(call).not.toHaveBeenCalled();
      action('continue-merge').click();
      expect(returnLayer().hidden).toBe(true);
      expect(controller.getMode()).toBe('merge');
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('blocks repeated confirmation until the cancellation promise settles', async () => {
    const done = deferred();
    const call = vi.fn(() => done.promise);
    mount({ onMergeDockAction: call });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    action('confirm-merge-return').click();
    action('confirm-merge-return').click();
    action('back-from-merge').click();
    expect(call).toHaveBeenCalledExactlyOnceWith('action-A', 'cancel');
    expect(action('confirm-merge-return').disabled).toBe(true);
    expect(controller.getMode()).toBe('merge');
    done.resolve();
    await flush();
    expect(controller.getMode()).toBe('resources');
    expect(returnLayer().hidden).toBe(true);
  });

  it('keeps the task visible after a rejected stop and permits an explicit retry', async () => {
    const first = deferred();
    const second = deferred();
    const call = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mount({ onMergeDockAction: call });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    action('confirm-merge-return').click();
    first.reject(new Error('无法确认初始化已停止'));
    await flush();
    expect(controller.getMode()).toBe('merge');
    expect(returnLayer().hidden).toBe(false);
    expect(element('[data-role="merge-return-error"]').textContent).toBe('无法确认初始化已停止');
    expect(action('confirm-merge-return').disabled).toBe(false);
    action('confirm-merge-return').click();
    second.resolve();
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    expect(controller.getMode()).toBe('resources');
  });

  it('does not reopen a minimized panel when cancellation finishes', async () => {
    const done = deferred();
    mount({ onMergeDockAction: () => done.promise });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    action('confirm-merge-return').click();
    controller.collapse();
    done.resolve();
    await flush();
    expect(controller.getMode()).toBe('launcher');
    action('launcher').click();
    expect(controller.getMode()).toBe('resources');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late old cancellation %s after navigation and a new task',
    async (outcome) => {
      const done = deferred();
      mount({ onMergeDockAction: () => done.promise });
      controller.openMerge(activeView());
      action('back-from-merge').click();
      action('confirm-merge-return').click();
      setUrl('https://www.bilibili.com/video/BV1NEWVIDEO2/');
      controller.resetForNavigation();
      controller.openMerge(
        mergeView({
          actionToken: 'action-B',
          title: '新视频任务',
          snapshot: { taskKey: 'task-B', mediaEpoch: 2, revision: 1 },
        }),
      );
      if (outcome === 'resolve') done.resolve();
      else done.reject(new Error('旧任务迟到错误'));
      await flush();
      expect(controller.getMode()).toBe('merge');
      expect(element('[data-role="merge-title"]').textContent).toBe('新视频任务');
      expect(element<HTMLButtonElement>('[data-merge-action="merge"]').disabled).toBe(false);
      expect(controller.shadowRoot.textContent).not.toContain('旧任务迟到错误');
    },
  );

  it('preserves a committed completion that wins while the confirmation is open', async () => {
    const call = vi.fn();
    mount({ onMergeDockAction: call });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    controller.setMergeSnapshot(
      mergeView({
        state: 'completed',
        phase: 'completed',
        progress: 1,
        cancelEnabled: false,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 2 },
      }),
    );
    action('confirm-merge-return').click();
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(controller.getMode()).toBe('resources');
  });

  it.each(['resolve', 'reject'] as const)(
    'does not clear a new task cancellation pending state when the previous task %s arrives',
    async (outcome) => {
      const first = deferred();
      const second = deferred();
      mount({
        onMergeDockAction: (token) => (token === 'action-A' ? first.promise : second.promise),
      });
      controller.openMerge(activeView());
      action('back-from-merge').click();
      action('confirm-merge-return').click();
      controller.openMerge(
        activeView({
          actionToken: 'action-B',
          title: '新并发任务',
          snapshot: { taskKey: 'task-B', mediaEpoch: 1, revision: 1 },
        }),
      );
      action('back-from-merge').click();
      action('confirm-merge-return').click();
      if (outcome === 'resolve') first.resolve();
      else first.reject(new Error('旧任务取消错误'));
      await flush();
      expect(controller.getMode()).toBe('merge');
      expect(element('[data-role="merge-title"]').textContent).toBe('新并发任务');
      expect(action('confirm-merge-return').disabled).toBe(true);
      expect(element('[data-role="merge-state-label"]').textContent).toBe('正在终止');
      second.resolve();
      await flush();
      expect(controller.getMode()).toBe('resources');
    },
  );

  it('keeps committed success authoritative when an already-pending cancel later rejects', async () => {
    const done = deferred();
    mount({ onMergeDockAction: () => done.promise });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    action('confirm-merge-return').click();
    controller.setMergeSnapshot(
      mergeView({
        state: 'completed',
        phase: 'completed',
        progress: 1,
        cancelEnabled: false,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 2 },
      }),
    );
    done.reject(new Error('取消确认迟到失败'));
    await flush();
    for (const role of ['merge-status', 'merge-return-error', 'merge-diagnostic-text'])
      expect(element(`[data-role="${role}"]`).textContent).not.toContain('取消确认迟到失败');
    expect(element('[data-role="merge-state-label"]').textContent).not.toBe('任务失败');
  });

  it('settles the same task cancellation after its action capability rotates in a snapshot', async () => {
    const done = deferred();
    mount({ onMergeDockAction: () => done.promise });
    controller.openMerge(activeView());
    action('back-from-merge').click();
    action('confirm-merge-return').click();
    controller.setMergeSnapshot(
      activeView({
        actionToken: 'rotated-action-A',
        state: 'cancelling',
        phase: 'cancelling',
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 2 },
      }),
    );
    done.resolve();
    await flush();
    expect(controller.getMode()).toBe('resources');
    expect(returnLayer().hidden).toBe(true);
  });

  it('returns a settled failed task directly when the backend confirms no cancelable work', async () => {
    const call = vi.fn();
    mount({ onMergeDockAction: call });
    controller.openMerge(
      mergeView({
        state: 'failed',
        phase: 'failed',
        error: '失败说明',
        cancelEnabled: false,
        returnRequiresConfirmation: false,
      }),
    );
    action('back-from-merge').click();
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(returnLayer().hidden).toBe(true);
    expect(controller.getMode()).toBe('resources');
  });
});

describe('v0.12.1 restrained download status and diagnostics', () => {
  it('hides credentials from a rejected save-location callback without changing the chosen path', async () => {
    const callback = vi.fn(async () => {
      throw new Error('保存位置操作失败\nAuthorization: Bearer fixture-path-secret');
    });
    mount({ onMergeDockPathModeChange: callback });
    controller.openMerge(mergeView());
    element<HTMLButtonElement>('[data-merge-action="change-path"]').click();
    element<HTMLButtonElement>('[data-path-mode="ask"]').click();
    await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith('path-A', 'ask');
    const error = element('[data-role="merge-status"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).not.toMatch(/Authorization|fixture-path-secret|Bearer/iu);
    expect(error.textContent).toContain('错误详情已隐藏');
    expect(element('[data-role="merge-path"]').textContent).toBe('Downloads/FoxFetch/Bilibili');
    expect(element('[data-role="merge-path-picker"]').hidden).toBe(true);
    expect(element<HTMLDetailsElement>('[data-role="merge-diagnostics"]').open).toBe(false);
  });

  it.each(['merge', 'cancel'] as const)(
    'does not display or copy credentials from a rejected %s action',
    async (operation) => {
      const reason = '来源缺少杜比视界配置，无法确认完整保真输出。';
      const sensitiveError = [
        `DYNAMIC_RANGE_UNVERIFIED：${reason}`,
        'https://cdn.example/video.m4s?deadline=123&upsig=fixture-signature',
        'Authorization: Bearer fixture-auth-secret',
        'Cookie: SESSDATA=fixture-cookie-secret; bili_jct=fixture-csrf-secret',
        '{"token":"fixture-json-token","upsig":"fixture-json-upsig"}',
        'X-Api-Key: fixture-api-key',
      ].join('\n');
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      mount({
        onMergeDockAction: async () => {
          throw new Error(sensitiveError);
        },
      });
      controller.openMerge(
        mergeView({
          diagnostics: {
            stage: '正在检查编码配置',
            readBytes: 2048,
            totalBytes: 4096,
            startedAt: 1,
            lastProgressAt: 2,
            errorCode: 'DYNAMIC_RANGE_UNVERIFIED',
            reason,
          },
        }),
      );
      if (operation === 'merge') element<HTMLButtonElement>('[data-merge-action="merge"]').click();
      else action('back-from-merge').click();
      await flush();
      action('copy-merge-diagnostics').click();
      await flush();
      const detail = element('[data-role="merge-diagnostic-text"]').textContent;
      expect(writeText).toHaveBeenCalledExactlyOnceWith(detail);
      for (const text of [
        detail,
        element('[data-role="merge-status"]').textContent,
        element('[data-role="merge-return-error"]').textContent,
        writeText.mock.calls[0]?.[0],
      ]) {
        expect(text).not.toMatch(
          /https?:|cdn\.example|upsig|fixture-signature|Authorization|fixture-auth-secret|Cookie|SESSDATA|fixture-cookie-secret|bili_jct|fixture-csrf-secret|fixture-json-token|fixture-json-upsig|fixture-api-key/iu,
        );
      }
      expect(detail).toContain('DYNAMIC_RANGE_UNVERIFIED');
      expect(detail).toContain(reason);
      expect(detail).toContain('正在检查编码配置');
      expect(controller.getMode()).toBe('merge');
    },
  );

  it('keeps action labels stable, reports an actual preparing stage and folds diagnostic detail', () => {
    mount({ onMergeDockAction: vi.fn() });
    const diagnostics = {
      stage: '正在读取视频信息',
      readBytes: 4096,
      totalBytes: 8192,
      startedAt: 1,
      lastProgressAt: 2,
    };
    controller.openMerge(activeView({ state: 'preparing', diagnostics }));
    expect(element('[data-role="merge-state-label"]').textContent).toBe('正在读取视频信息');
    expect(element('[data-role="merge-progress-label"]').textContent).toBe('--');
    expect(element('[data-role="merge-action-label"]').textContent).toBe('下载');
    expect(element('[data-merge-action="cancel"]').textContent).toContain('取消');
    expect(element<HTMLDetailsElement>('[data-role="merge-diagnostics"]').open).toBe(false);
    expect(element('[data-role="merge-diagnostic-text"]').textContent).toContain(
      '正在读取视频信息',
    );
    expect(element<HTMLButtonElement>('[data-merge-action="merge"]').disabled).toBe(true);
    expect(element<HTMLButtonElement>('[data-merge-action="cancel"]').disabled).toBe(false);
  });

  it('preserves a precise packet error without guessing its category from translated prose', () => {
    mount({ onMergeDockAction: vi.fn() });
    controller.openMerge(
      mergeView({
        state: 'failed',
        phase: 'failed',
        error: 'Dolby Vision 视频编码包与来源不一致',
        mergeEnabled: false,
        separateEnabled: false,
        diagnostics: {
          stage: '正在验证',
          readBytes: 100,
          totalBytes: 100,
          startedAt: 1,
          lastProgressAt: 2,
          errorCode: 'VIDEO_PACKET_MISMATCH',
          reason: '视频编码包不一致',
        },
      }),
    );
    expect(element('[data-role="merge-status"]').textContent).toBe(
      'Dolby Vision 视频编码包与来源不一致',
    );
    expect(element('[data-role="merge-diagnostic-text"]').textContent).toContain(
      'VIDEO_PACKET_MISMATCH',
    );
    expect(element('[data-role="merge-state-label"]').textContent).toBe('任务失败');
    expect(element('[data-role="merge-progress-label"]').textContent).not.toBe('100%');
    expect(element<HTMLButtonElement>('[data-merge-action="merge"]').disabled).toBe(true);
    expect(element<HTMLButtonElement>('[data-merge-action="cancel"]').disabled).toBe(false);
  });
});
