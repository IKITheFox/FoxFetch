import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingPlaybackController, PlaybackManager } from '../../src/modules/playback';
import { NavigationPanelIntent } from '../../src/modules/playback/navigation-panel-intent';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';
import { MseCacheCaptureRuntime } from '../../src/modules/resolver/mse-cache-capture';
import type { MergeDockView } from '../../src/shared/types';

const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
const source = 'https://www.bilibili.com/video/BV1CURRENT1/';
const target = 'https://www.bilibili.com/video/BV1NEXTVIDEO2/';
let manager: PlaybackManager;
let controller: FloatingPlaybackController;
const setUrl = (url: string) =>
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
function mount() {
  const video = document.createElement('video');
  video.src = '/fixture.mp4';
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    positionStore: { get: async () => ({}), set: async () => undefined },
  });
  controller.openPlayback();
}
function native(action: () => void) {
  const root = document.createElement('div');
  root.id = 'bilibili-player';
  const btn = document.createElement('button');
  btn.className = 'bpx-player-ctrl-next';
  root.append(btn);
  document.body.append(root);
  vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({ width: 40, height: 40 } as DOMRect);
  btn.onclick = action;
  return btn;
}
function rightClick() {
  controller.shadowRoot
    .querySelector('[data-media-action="seek-forward"]')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}
beforeEach(() => {
  vi.useFakeTimers();
  setUrl(source);
  window.sessionStorage.clear();
});
afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  window.sessionStorage.clear();
  if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
  else Reflect.deleteProperty(document, 'URL');
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('v0.13.2 explicit navigation panel retention', () => {
  it('ignores the old cache launcher request during navigation but honors a manual collapse', () => {
    mount();
    const elements = manager.getMediaElements();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    controller.attachCacheCapture(cache);
    native(() => {
      setUrl(target);
      cache.resetForMediaChange();
      controller.resetForNavigation();
      controller.update([]);
    });
    rightClick();
    expect(controller.getMode()).toBe('playback');
    controller.collapse();
    expect(controller.getMode()).toBe('hidden');
    controller.update(
      elements.map((element) => ({
        ...element,
        lifecycleGeneration: element.lifecycleGeneration + 1,
      })),
    );
    expect(controller.getMode()).toBe('launcher');
    controller.attachCacheCapture(undefined);
    cache.destroy();
  });
  it('stays expanded through route reset and an empty-player gap, then returns to ordinary reset behavior', async () => {
    mount();
    const elements = manager.getMediaElements();
    native(() => {
      setUrl(target);
      controller.resetForNavigation();
      controller.update([]);
    });
    rightClick();
    expect(controller.getMode()).toBe('playback');
    expect(controller.shadowRoot.querySelector('[data-role="target-label"]')!.textContent).toBe(
      '正在切换视频…',
    );
    expect(
      (
        controller.shadowRoot.querySelector(
          '[data-media-action="toggle-play"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    controller.resetForNavigation();
    expect(controller.getMode()).toBe('playback');
    controller.update(
      elements.map((e) => ({
        ...e,
        title: '新视频',
        lifecycleGeneration: e.lifecycleGeneration + 1,
      })),
    );
    expect(controller.getMode()).toBe('playback');
    setUrl('https://www.bilibili.com/video/BV1OTHER/');
    controller.resetForNavigation();
    expect(controller.getMode()).toBe('launcher');
  });
  it.each(['collapse', 'hide'] as const)(
    'respects %s during a pending navigation and repeated resets',
    async (method) => {
      mount();
      native(() => undefined);
      rightClick();
      controller[method]();
      setUrl(target);
      controller.resetForNavigation();
      await vi.advanceTimersByTimeAsync(60);
      controller.resetForNavigation();
      expect(controller.getMode()).toBe(method === 'hide' ? 'hidden' : 'launcher');
    },
  );
  it('does not alter ordinary route resets or retain a failed navigation', async () => {
    mount();
    controller.resetForNavigation();
    expect(controller.getMode()).toBe('launcher');
    controller.openPlayback();
    native(() => undefined);
    rightClick();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(controller.getMode()).toBe('playback');
    setUrl(target);
    controller.resetForNavigation();
    expect(controller.getMode()).toBe('launcher');
  });
  it('restores a known full-document destination only once, excluding reload/back and wrong destinations', () => {
    const intent = new NavigationPanelIntent(document);
    const perf = vi
      .spyOn(window.performance, 'getEntriesByType')
      .mockReturnValue([{ type: 'navigate' }] as unknown as PerformanceEntry[]);
    intent.begin(siteMediaRouteKey(target));
    setUrl(target + '?cid=100');
    expect(new NavigationPanelIntent(document).restore()).toBe(true);
    expect(new NavigationPanelIntent(document).restore()).toBe(false);
    for (const type of ['reload', 'back_forward']) {
      setUrl(source);
      intent.begin(siteMediaRouteKey(target));
      setUrl(target);
      perf.mockReturnValue([{ type }] as unknown as PerformanceEntry[]);
      expect(new NavigationPanelIntent(document).restore()).toBe(false);
    }
  });
  it('expires UI intent and rejects unrelated destinations', async () => {
    const intent = new NavigationPanelIntent(document);
    intent.begin(siteMediaRouteKey(target));
    setUrl('https://www.bilibili.com/video/BV1OTHER/');
    expect(intent.active()).toBe(false);
    setUrl(source);
    intent.begin();
    await vi.advanceTimersByTimeAsync(12_001);
    expect(intent.active()).toBe(false);
  });
  it.each(['completed', 'cancelled'] as const)(
    'allows %s buttons again and suppresses a rapid double click',
    async (state) => {
      mount();
      controller.destroy();
      let finish!: () => void;
      const action = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      controller = new FloatingPlaybackController(document, manager, { onMergeDockAction: action });
      const view: MergeDockView = {
        actionToken: 'a',
        pathToken: 'p',
        state,
        title: '视频',
        status: '保存成功',
        progress: 1,
        savePath: 'Downloads/FoxFetch',
        pathMode: 'automatic',
        mergeEnabled: true,
        separateEnabled: true,
        busy: false,
      };
      controller.openMerge(view);
      const merge = controller.shadowRoot.querySelector<HTMLButtonElement>(
        '[data-merge-action="merge"]',
      )!;
      const separate = controller.shadowRoot.querySelector<HTMLButtonElement>(
        '[data-merge-action="cancel"]',
      )!;
      expect(merge.disabled).toBe(false);
      expect(merge.textContent).toBe(state === 'cancelled' ? '重新下载' : '下载');
      expect(separate.disabled).toBe(true);
      merge.click();
      merge.click();
      separate.click();
      expect(action).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(1);
      expect(merge.disabled).toBe(false);
      expect(separate.disabled).toBe(true);
    },
  );
});
