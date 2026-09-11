import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FloatingPlaybackController,
  PlaybackManager,
  TRANSPORT_HOLD_DELAY_MS,
  TRANSPORT_TOOLTIP_DELAY_MS,
} from '../../src/modules/playback';
import type { MergeDockView } from '../../src/shared/types';
import { compactQualityLabel } from '../../src/shared/quality-label';
import { groupFloatingDockQualities } from '../../src/modules/playback/floating-product-ui';
import { MseCacheCaptureRuntime } from '../../src/modules/resolver/mse-cache-capture';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let controller: FloatingPlaybackController;
let manager: PlaybackManager;
let video: HTMLVideoElement;
let cache: MseCacheCaptureRuntime | undefined;
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function mount(options: ConstructorParameters<typeof FloatingPlaybackController>[2] = {}) {
  video = document.createElement('video');
  video.src = '/current.mp4';
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
  document.title = '当前视频真实标题';
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    playback: { showController: true },
    ...options,
  });
  controller.openPlayback();
}

function button(action: string): HTMLButtonElement {
  return controller.shadowRoot.querySelector<HTMLButtonElement>(`[data-media-action="${action}"]`)!;
}
function pointer(
  target: Element,
  type: string,
  extra: MouseEventInit & { pointerId?: number } = {},
) {
  const event = new TestPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 100,
    clientY: 100,
    ...extra,
  });
  target.dispatchEvent(event);
  return event;
}
function mergeView(extra: Partial<MergeDockView> = {}): MergeDockView {
  return {
    actionToken: 'action',
    pathToken: 'path',
    title: '完整视频标题',
    state: 'ready',
    phase: 'ready',
    status: '可以下载',
    progress: 0,
    savePath: 'Downloads/FoxFetch/Bilibili',
    pathMode: 'automatic',
    mergeEnabled: true,
    separateEnabled: true,
    busy: false,
    snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 1 },
    ...extra,
  };
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterEach(() => {
  controller?.destroy();
  cache?.destroy();
  cache = undefined;
  manager?.stop();
  document.body.replaceChildren();
  document.title = '';
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: originalWidth,
    writable: true,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: originalHeight,
    writable: true,
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('v0.12 floating playback', () => {
  it('shows four pure icons, a real title, exact brand assets and no rate buttons', () => {
    mount({ themeMode: 'dark' });
    const root = controller.shadowRoot;
    expect(root.querySelector('[data-role="target-label"]')?.textContent).toBe('当前视频真实标题');
    expect(root.querySelectorAll('.transport button')).toHaveLength(4);
    for (const control of root.querySelectorAll('.transport button')) {
      expect(control.textContent).toBe('');
      expect(control.hasAttribute('title')).toBe(false);
      expect(control.getAttribute('aria-label')).toBeTruthy();
    }
    expect(root.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect(
      root.querySelectorAll('.rate-presets,.custom-rate,[data-media-action="reset-rate"]'),
    ).toHaveLength(0);
    expect(root.querySelector('.head .brand')?.textContent).toBe('FoxFetch');
    expect(root.querySelector<HTMLImageElement>('.head .launcher-logo-dark')?.src).toContain(
      'foxfetch-dark.svg',
    );
    expect(controller.host.getAttribute('contenteditable')).toBe('false');
  });

  it('short press seeks exactly 15s once and never changes the global seek setting', async () => {
    vi.useFakeTimers();
    mount({ playback: { seekStep: 42 } });
    const next = button('seek-forward');
    pointer(next, 'pointerdown');
    await vi.advanceTimersByTimeAsync(TRANSPORT_HOLD_DELAY_MS - 1);
    pointer(next, 'pointerup');
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await Promise.resolve();
    expect(video.currentTime).toBe(45);
    expect(video.playbackRate).toBe(1);
    button('seek-back').click(); // keyboard/programmatic activation has no pointer press
    await Promise.resolve();
    expect(video.currentTime).toBe(30);
  });

  it('holds absolute 3×, restores the original paused rate and suppresses release click', async () => {
    vi.useFakeTimers();
    mount({ playback: { lockRate: true } });
    await manager.execute({ action: 'setRate', rate: 1.5, lockRate: true });
    const next = button('seek-forward');
    pointer(next, 'pointerdown');
    await vi.advanceTimersByTimeAsync(TRANSPORT_HOLD_DELAY_MS);
    expect(video.playbackRate).toBe(3);
    expect(video.defaultPlaybackRate).toBe(1.5);
    expect(video.paused).toBe(false);
    pointer(next, 'pointerup');
    next.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await Promise.resolve();
    expect(video.playbackRate).toBe(1.5);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(30);
    expect(manager.hasTemporaryTransport()).toBe(false);
  });

  it('cancels pending/active holds on suppression, blur and pointercancel', async () => {
    vi.useFakeTimers();
    mount();
    const next = button('seek-forward');
    pointer(next, 'pointerdown');
    controller.suppress();
    await vi.advanceTimersByTimeAsync(500);
    expect(video.playbackRate).toBe(1);
    controller.suppress(false);
    pointer(next, 'pointerdown');
    await vi.advanceTimersByTimeAsync(350);
    window.dispatchEvent(new Event('blur'));
    expect(video.playbackRate).toBe(1);
    expect(video.paused).toBe(true);
    pointer(next, 'pointerdown');
    pointer(next, 'pointercancel');
    await vi.advanceTimersByTimeAsync(500);
    expect(video.currentTime).toBe(30);
  });

  it('shows tooltips at 1500ms and cancels them on leave/press/Escape', async () => {
    vi.useFakeTimers();
    mount();
    const next = button('seek-forward');
    const tooltip = controller.shadowRoot.querySelector<HTMLElement>('.transport-tooltip')!;
    pointer(next, 'pointerover');
    await vi.advanceTimersByTimeAsync(TRANSPORT_TOOLTIP_DELAY_MS - 1);
    expect(tooltip.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toContain('右键播放下一个视频');
    next.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(tooltip.hidden).toBe(true);
    pointer(next, 'pointerover');
    pointer(next, 'pointerout');
    await vi.advanceTimersByTimeAsync(1600);
    expect(tooltip.hidden).toBe(true);
    pointer(next, 'pointerover');
    pointer(next, 'pointerdown');
    await vi.advanceTimersByTimeAsync(1600);
    expect(tooltip.hidden).toBe(true);
  });

  it('suppresses context menus only on previous/next controls', async () => {
    mount();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    button('seek-forward').dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      controller.shadowRoot.querySelector('[data-role="playback-error"]')?.textContent,
    ).toBeTruthy();
    const normal = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    button('toggle-play').dispatchEvent(normal);
    expect(normal.defaultPrevented).toBe(false);
    expect(video.currentTime).toBe(30);
  });

  it('reads actual play state and preserves a slider draft across snapshots and outside release', async () => {
    mount();
    await video.play();
    controller.update(manager.getMediaElements());
    expect(button('toggle-play').getAttribute('aria-label')).toBe('暂停视频');
    video.pause();
    controller.update(manager.getMediaElements());
    expect(button('toggle-play').getAttribute('aria-label')).toBe('播放视频');
    video.play = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    button('toggle-play').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button('toggle-play').getAttribute('aria-label')).toBe('播放视频');
    const slider = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="rate-slider"]',
    )!;
    pointer(slider, 'pointerdown', { pointerId: 4 });
    slider.value = '2.75';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    controller.update(manager.getMediaElements());
    expect(slider.value).toBe('2.75');
    window.dispatchEvent(new TestPointerEvent('pointerup', { pointerId: 4 }));
    await Promise.resolve();
    expect(video.playbackRate).toBe(2.75);
    expect(controller.shadowRoot.querySelector('[data-role="current-rate"]')?.textContent).toBe(
      '2.75×',
    );
  });
});

describe('v0.12 launcher and merge states', () => {
  it.each(['pointercancel', 'lostpointercapture', 'blur'] as const)(
    'rolls back a complete-panel drag on %s without saving or changing its mode',
    (reason) => {
      const set = vi.fn(async () => undefined);
      mount({ positionStore: { get: async () => ({}), set } });
      const panel = controller.shadowRoot.querySelector<HTMLElement>('.panel')!;
      const header = controller.shadowRoot.querySelector<HTMLElement>('.head')!;
      const original = { left: panel.style.left, top: panel.style.top };
      pointer(header, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 8 });
      pointer(header, 'pointermove', { clientX: 300, clientY: 200, pointerId: 8 });
      expect(controller.host.dataset.panelDragging).toBe('true');
      expect(panel.style.left).not.toBe(original.left);
      expect(controller.getMode()).toBe('playback');
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else pointer(header, reason, { pointerId: 8 });
      expect(controller.host.dataset.panelDragging).toBeUndefined();
      expect(panel.style.left).toBe(original.left);
      expect(panel.style.top).toBe(original.top);
      expect(controller.getMode()).toBe('playback');
      window.dispatchEvent(new TestPointerEvent('pointerup', { pointerId: 8 }));
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each(['suppressed', 'resources', 'launcher', 'hidden'] as const)(
    'cancels an unfinished panel drag before switching to %s',
    (nextMode) => {
      const set = vi.fn(async () => undefined);
      mount({ positionStore: { get: async () => ({}), set } });
      const header = controller.shadowRoot.querySelector<HTMLElement>('.head')!;
      pointer(header, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 9 });
      pointer(header, 'pointermove', { clientX: 260, clientY: 240, pointerId: 9 });
      expect(controller.host.dataset.panelDragging).toBe('true');
      controller.setMode(nextMode);
      expect(controller.getMode()).toBe(nextMode);
      expect(controller.host.dataset.panelDragging).toBeUndefined();
      window.dispatchEvent(new TestPointerEvent('pointerup', { pointerId: 9 }));
      expect(set).not.toHaveBeenCalled();
      expect(controller.getMode()).toBe(nextMode);
    },
  );

  it('does not leave launcher hover locked after a cancelled panel drag is collapsed', async () => {
    vi.useFakeTimers();
    mount();
    const header = controller.shadowRoot.querySelector<HTMLElement>('.head')!;
    pointer(header, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 12 });
    pointer(header, 'pointermove', { clientX: 300, clientY: 200, pointerId: 12 });
    pointer(header, 'pointercancel', { pointerId: 12 });
    controller.collapse();
    const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
    pointer(launcher, 'pointerover');
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.getMode()).toBe('launcher');
    expect(controller.host.dataset.launcherPreview).toBe('true');
  });

  it('allows hover after launcher cancellation while consuming only the stale drag click', async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => undefined);
    mount({ positionStore: { get: async () => ({}), set } });
    controller.collapse();
    const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
    pointer(launcher, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 13 });
    pointer(launcher, 'pointermove', { clientX: 300, clientY: 200, pointerId: 13 });
    pointer(launcher, 'pointercancel', { pointerId: 13 });
    pointer(launcher, 'pointerover');
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.host.dataset.launcherPreview).toBe('true');
    launcher.click(); // A delayed synthetic click from the cancelled gesture.
    expect(controller.getMode()).toBe('launcher');
    pointer(launcher, 'pointerdown', { pointerId: 14 });
    pointer(launcher, 'pointerup', { pointerId: 14 });
    launcher.click(); // A distinct intentional gesture still opens normally.
    expect(controller.getMode()).toBe('playback');
    expect(set).not.toHaveBeenCalled();
  });

  it('clamps a panel during a narrow/short viewport resize and saves a finite edge anchor', () => {
    const set = vi.fn<(items: Record<string, unknown>) => Promise<void>>(async () => undefined);
    mount({ positionStore: { get: async () => ({}), set } });
    const panel = controller.shadowRoot.querySelector<HTMLElement>('.panel')!;
    const header = controller.shadowRoot.querySelector<HTMLElement>('.head')!;
    pointer(header, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 10 });
    pointer(header, 'pointermove', { clientX: 260, clientY: 200, pointerId: 10 });
    Object.defineProperties(window, {
      innerWidth: { configurable: true, writable: true, value: 320 },
      innerHeight: { configurable: true, writable: true, value: 180 },
    });
    window.dispatchEvent(new Event('resize'));
    pointer(header, 'pointermove', { clientX: -10000, clientY: -10000, pointerId: 10 });
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('10px');
    expect(controller.host.dataset.panelDragging).toBe('true');
    expect(controller.getMode()).toBe('playback');
    pointer(header, 'pointerup', { pointerId: 10 });
    expect(controller.host.dataset.panelDragging).toBeUndefined();
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('10px');
    expect(set).toHaveBeenCalledOnce();
    const anchor = Object.values(set.mock.calls[0]![0])[0] as {
      version: number;
      mode: string;
      edge: string;
      inset: number;
      xRatio: number;
      yRatio: number;
    };
    expect(anchor).toMatchObject({ version: 2, mode: 'edge', inset: 10 });
    expect(['left', 'right']).toContain(anchor.edge);
    for (const ratio of [anchor.xRatio, anchor.yRatio]) {
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });

  it.each(['download', 'quality'] as const)(
    'reanchors an open %s menu after a panel drag loses pointer capture',
    (kind) => {
      mount();
      controller.setResourceSnapshot({
        status: 'ready',
        products: [
          {
            id: 'drag-menu-fixture',
            title: '拖动菜单定位测试',
            domain: 'bilibili.com',
            options: [{ mode: 'complete' }, { mode: 'video' }, { mode: 'audio' }],
            qualities: [
              {
                id: 'q4k',
                token: 'q4k-token',
                label: '4K 超高清 · HEVC',
                completeAvailable: true,
                videoOnlyAvailable: true,
              },
              {
                id: 'q1080',
                token: 'q1080-token',
                label: '1080P 高清 · HEVC',
                completeAvailable: true,
                videoOnlyAvailable: true,
              },
            ],
          },
        ],
      });
      controller.openResources();
      const root = controller.shadowRoot;
      const panel = root.querySelector<HTMLElement>('.panel')!;
      const header = root.querySelector<HTMLElement>('.head')!;
      const trigger = root.querySelector<HTMLButtonElement>(
        kind === 'download' ? '[data-action="toggle-product-menu"]' : '.dock-variant-trigger',
      )!;
      const menu = root.querySelector<HTMLElement>(
        kind === 'download' ? '.dock-product-menu' : '.dock-variant-list',
      )!;
      expect(trigger).not.toBeNull();
      expect(menu).not.toBeNull();
      vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(
        () =>
          new DOMRect(
            Number.parseFloat(panel.style.left) + 200,
            Number.parseFloat(panel.style.top) + 80,
            80,
            36,
          ),
      );
      vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 100));
      Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 100 });
      trigger.click();
      expect(menu.hidden).toBe(false);
      const before = { left: menu.style.left, top: menu.style.top };
      pointer(header, 'pointerdown', { clientX: 700, clientY: 400, pointerId: 11, composed: true });
      pointer(header, 'pointermove', { clientX: 300, clientY: 200, pointerId: 11, composed: true });
      expect(menu.style.left).not.toBe(before.left);
      pointer(header, 'lostpointercapture', { pointerId: 11, composed: true });
      expect(menu.hidden).toBe(false);
      expect(menu.style.left).toBe(before.left);
      expect(menu.style.top).toBe(before.top);
    },
  );

  it('restores the canonical right edge after repeated suppression/resize cycles', async () => {
    const positionKey = `foxfetch:media-dock-position:${document.location.origin}`;
    const set = vi.fn(async () => undefined);
    mount({
      positionStore: {
        get: async () => ({
          [positionKey]: {
            version: 2,
            mode: 'edge',
            edge: 'right',
            inset: 10,
            xRatio: 1,
            yRatio: 0.7,
          },
        }),
        set,
      },
    });
    await Promise.resolve();
    controller.collapse();
    const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
    for (let index = 0; index < 10; index++) {
      controller.suppress();
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 640,
      });
      window.dispatchEvent(new Event('resize'));
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1200,
      });
      window.dispatchEvent(new Event('resize'));
      controller.suppress(false);
      expect(launcher.style.left).toBe('1138px');
    }
    expect(set).not.toHaveBeenCalled();
  });

  it('blocks native logo drag and cancels without committing a new position', () => {
    const set = vi.fn(async () => undefined);
    mount({ positionStore: { get: async () => ({}), set } });
    controller.collapse();
    const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
    const logo = launcher.querySelector<HTMLImageElement>('img')!;
    expect(logo.draggable).toBe(false);
    const start = new Event('dragstart', { bubbles: true, cancelable: true });
    logo.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    const before = launcher.style.left;
    pointer(logo, 'pointerdown');
    pointer(logo, 'pointermove', { clientX: 400 });
    pointer(logo, 'pointercancel');
    expect(launcher.style.left).toBe(before);
    expect(set).not.toHaveBeenCalled();
  });

  it('uses real lifecycle phases, explicit initialization, and rejects stale task snapshots', () => {
    mount();
    controller.openMerge(
      mergeView({ state: 'preparing', phase: 'fetching', busy: true, progress: 0.2 }),
    );
    const root = controller.shadowRoot;
    expect(root.querySelector('[data-role="merge-state-label"]')?.textContent).toBe('正在初始化');
    expect(root.querySelector('[data-role="merge-progress-label"]')?.textContent).toBe('--');
    expect(root.querySelector<HTMLButtonElement>('[data-merge-action="merge"]')?.disabled).toBe(
      true,
    );
    controller.setMergeSnapshot(
      mergeView({
        state: 'running',
        phase: 'verifying',
        progress: 0.2,
        busy: true,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 2 },
      }),
    );
    expect(root.querySelector('[data-role="merge-state-label"]')?.textContent).toBe('正在验证');
    expect(controller.host.dataset.mergeStage).toBe('merge');
    controller.setMergeSnapshot(
      mergeView({
        state: 'completed',
        progress: 1,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 3 },
      }),
    );
    controller.setMergeSnapshot(
      mergeView({
        state: 'preparing',
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 1 },
      }),
    );
    expect(root.querySelector('[data-role="merge-state-label"]')?.textContent).toBe('保存成功');
    expect(root.querySelector('[data-role="merge-title"]')?.textContent).toBe('完整视频标题');
    expect(root.querySelector('[data-role="merge-progress-label"]')?.textContent).toBe('100%');
  });

  it('keeps authoritative completion when an older action rejects late', async () => {
    let rejectAction!: (reason: Error) => void;
    const action = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectAction = reject;
        }),
    );
    mount({ onMergeDockAction: action });
    controller.openMerge(mergeView());
    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-merge-action="merge"]')!.click();
    expect(action).toHaveBeenCalledOnce();
    controller.setMergeSnapshot(
      mergeView({
        state: 'completed',
        phase: 'completed',
        progress: 1,
        snapshot: { taskKey: 'task-A', mediaEpoch: 1, revision: 3 },
      }),
    );
    rejectAction(new Error('late transport failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state-label"]')?.textContent,
    ).toBe('保存成功');
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-progress-label"]')?.textContent,
    ).toBe('100%');
    expect(controller.shadowRoot.textContent).not.toContain('late transport failure');
  });

  it('does not cancel a retry lease on a token-only refresh of the same failed revision', async () => {
    let finishAction!: () => void;
    mount({
      onMergeDockAction: () =>
        new Promise<void>((resolve) => {
          finishAction = resolve;
        }),
    });
    const failed = mergeView({ state: 'failed', phase: 'failed', error: 'prior attempt failed' });
    controller.openMerge(failed);
    const retry = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-merge-action="merge"]',
    )!;
    retry.click();
    expect(retry.disabled).toBe(true);
    controller.setMergeSnapshot({ ...failed, actionToken: 'rotated-same-revision' });
    expect(retry.disabled).toBe(true);
    finishAction();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not render late action errors after destruction', async () => {
    let rejectAction!: (reason: Error) => void;
    mount({
      onMergeDockAction: () =>
        new Promise<void>((_, reject) => {
          rejectAction = reject;
        }),
    });
    controller.openMerge(mergeView());
    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-merge-action="merge"]')!.click();
    controller.destroy();
    const detachedMarkup = controller.shadowRoot.innerHTML;
    rejectAction(new Error('late destroyed action'));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.host.isConnected).toBe(false);
    expect(controller.shadowRoot.innerHTML).toBe(detachedMarkup);
  });

  it('does not surface cache hints until regular resolution explicitly fails', () => {
    cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    mount({ cacheCapture: cache });
    cache.start({ sessionId: 'ui-only-cache', title: 'test' });
    controller.setResourceSnapshot({ status: 'ready', products: [] });
    expect(controller.shadowRoot.querySelector('[data-role="launcher-status"]')?.textContent).toBe(
      '已识别视频',
    );
    controller.setResourceSnapshot({ status: 'loading', products: [] });
    expect(controller.shadowRoot.querySelector('[data-role="launcher-status"]')?.textContent).toBe(
      '正在识别视频',
    );
    controller.setResourceSnapshot({ status: 'error', products: [], error: '解析失败' });
    expect(
      controller.shadowRoot.querySelector('[data-role="launcher-status"]')?.textContent,
    ).toContain('缓存');
  });
});

describe('quality badge deduplication', () => {
  it('deduplicates high bitrate/high frame labels without changing delivered quality identities', () => {
    expect(compactQualityLabel('1080P 高码率', 'AVC', '高码率')).toBe('1080P 高码率 · AVC');
    expect(compactQualityLabel('1080P 60帧', '60帧', 'HEVC')).toBe('1080P 60帧 · HEVC');
    expect(compactQualityLabel('4K 超高清', 'HEVC', 'HDR')).toBe('4K 超高清 · HEVC · HDR');
    const quality = {
      id: 'stable-quality',
      token: 'current-token',
      label: '1080P 高码率 · AVC · 高码率',
      completeAvailable: true,
      videoOnlyAvailable: true,
    };
    const groups = groupFloatingDockQualities([quality]);
    expect(groups[0]?.label).toBe('1080P 高码率');
    expect(groups[0]?.choices[0]?.quality).toBe(quality);
  });
});
