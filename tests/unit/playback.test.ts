import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeMediaIdentityKey,
  createActiveMediaFingerprint,
  FLOATING_CONTROLLER_HOST_ID,
  FloatingPlaybackController,
  PlaybackManager,
  sameActiveMediaIdentity,
} from '../../src/modules/playback';
import { siteMediaRouteKey } from '../../src/modules/detector';
import { MseCacheCaptureRuntime } from '../../src/modules/resolver/mse-cache-capture';

function makeControllableVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.src = '/movie.mp4';
  Object.defineProperties(video, {
    paused: { configurable: true, writable: true, value: true },
    duration: { configurable: true, writable: true, value: 100 },
    currentTime: { configurable: true, writable: true, value: 20 },
    playbackRate: { configurable: true, writable: true, value: 1 },
    defaultPlaybackRate: { configurable: true, writable: true, value: 1 },
    volume: { configurable: true, writable: true, value: 1 },
    muted: { configurable: true, writable: true, value: false },
    preservesPitch: { configurable: true, writable: true, value: true },
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
  return video;
}

function setBufferedRanges(video: HTMLVideoElement, ranges: Array<[number, number]>): void {
  Object.defineProperty(video, 'buffered', {
    configurable: true,
    value: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0,
    },
  });
}

function makeControllableAudio(): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.src = '/episode.mp3';
  Object.defineProperties(audio, {
    paused: { configurable: true, writable: true, value: true },
    duration: { configurable: true, writable: true, value: 180 },
    currentTime: { configurable: true, writable: true, value: 0 },
    playbackRate: { configurable: true, writable: true, value: 1 },
    defaultPlaybackRate: { configurable: true, writable: true, value: 1 },
    volume: { configurable: true, writable: true, value: 1 },
    muted: { configurable: true, writable: true, value: false },
    preservesPitch: { configurable: true, writable: true, value: true },
  });
  return audio;
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('PlaybackManager', () => {
  it('tracks media and executes every basic playback command', async () => {
    const video = makeControllableVideo();
    const toggled = vi.fn();
    const manager = new PlaybackManager(document, { onToggleController: toggled });
    const [info] = manager.start();

    expect(info).toMatchObject({ kind: 'video', playbackRate: 1, currentTime: 20 });
    const elementId = info!.elementId;

    expect(await manager.execute({ action: 'setRate', rate: 99 }, elementId)).toMatchObject({
      applied: true,
      actualRate: 16,
    });
    expect(video.playbackRate).toBe(16);
    expect(await manager.execute({ action: 'adjustRate', delta: -100 }, elementId)).toMatchObject({
      applied: true,
      actualRate: 0.0625,
    });
    expect(await manager.execute({ action: 'resetRate' }, elementId)).toMatchObject({
      actualRate: 1,
    });

    await manager.execute({ action: 'seekBy', seconds: -30 }, elementId);
    expect(video.currentTime).toBe(0);
    video.currentTime = 99;
    expect(manager.isNearEnd(elementId)).toBe(true);
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    await manager.execute({ action: 'seekTo', seconds: 10, pause: true }, elementId);
    expect(video.currentTime).toBe(10);
    expect(video.pause).toHaveBeenCalledOnce();
    setBufferedRanges(video, [
      [0, 12],
      [40, 80],
    ]);
    await manager.execute({ action: 'seekToBufferedEnd', safetyMargin: 0.2 }, elementId);
    expect(video.currentTime).toBeCloseTo(79.8);
    await manager.execute({ action: 'setVolume', volume: 5 }, elementId);
    expect(video.volume).toBe(1);
    await manager.execute({ action: 'toggleMute' }, elementId);
    expect(video.muted).toBe(true);
    await manager.execute({ action: 'togglePlay' }, elementId);
    expect(video.play).toHaveBeenCalledOnce();
    await manager.execute({ action: 'togglePlay' }, elementId);
    expect(video.pause).toHaveBeenCalledTimes(2);
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: true });
    await manager.execute({ action: 'pause' }, elementId);
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledTimes(2);
    expect(await manager.execute({ action: 'toggleController' })).toEqual({ applied: true });
    expect(toggled).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('locks a custom rate and applies preservesPitch', async () => {
    vi.useFakeTimers();
    const video = makeControllableVideo();
    const manager = new PlaybackManager(document);
    const [info] = manager.start();
    await manager.execute(
      { action: 'setRate', rate: 3.5, lockRate: true, preservesPitch: false },
      info!.elementId,
    );
    expect(video.preservesPitch).toBe(false);

    video.playbackRate = 1;
    video.dispatchEvent(new Event('ratechange'));
    await vi.runAllTimersAsync();
    expect(video.playbackRate).toBe(3.5);
    manager.stop();
  });

  it('discovers SPA-inserted audio and applies a common playback rate', async () => {
    vi.useFakeTimers();
    const manager = new PlaybackManager(document);
    expect(manager.start()).toEqual([]);

    const audio = makeControllableAudio();
    document.body.append(audio);
    await Promise.resolve();
    await vi.runAllTimersAsync();

    const [info] = manager.getMediaElements();
    expect(info).toMatchObject({ kind: 'audio', playbackRate: 1 });
    await manager.execute({ action: 'setRate', rate: 2.5 }, info!.elementId);
    expect(audio.playbackRate).toBe(2.5);
    manager.stop();
  });

  it('advances one lifecycle generation for source changes and same-URL reloads', () => {
    const video = makeControllableVideo();
    const manager = new PlaybackManager(document);
    const [initial] = manager.start();
    expect(initial?.lifecycleGeneration).toBe(1);

    video.src = '/second.mp4';
    const [sourceChanged] = manager.refresh();
    expect(sourceChanged).toMatchObject({
      elementId: initial?.elementId,
      lifecycleGeneration: 2,
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(manager.getMediaElements()[0]?.lifecycleGeneration).toBe(2);

    video.dispatchEvent(new Event('emptied'));
    expect(manager.getMediaElements()[0]?.lifecycleGeneration).toBe(3);
    manager.refresh();
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(manager.getMediaElements()[0]?.lifecycleGeneration).toBe(3);

    manager.stop();
  });

  it('keeps a visible old SPA player unowned until the reused node finishes a new lifecycle', async () => {
    vi.useFakeTimers();
    history.replaceState({}, '', '/video/BV1ROUTEOLD1/');
    const video = makeControllableVideo();
    video.setAttribute('aria-label', '旧视频');
    Object.defineProperty(video, 'paused', {
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(video, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect(0, 0, 960, 540),
    });
    const manager = new PlaybackManager(document);
    const [oldMedia] = manager.start();

    history.pushState({}, '', '/video/BV1ROUTENEW2/');
    expect(manager.getMediaElements()).toEqual([]);
    expect(manager.isAwaitingRoutePlayer()).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.getMediaElements()).toEqual([]);

    video.src = '/new-route-video.mp4';
    expect(manager.refresh()).toEqual([]);
    video.dispatchEvent(new Event('loadedmetadata'));
    const [newMedia] = manager.getMediaElements();
    expect(newMedia).toMatchObject({
      elementId: oldMedia?.elementId,
      title: '旧视频',
      lifecycleGeneration: (oldMedia?.lifecycleGeneration ?? 0) + 1,
    });
    expect(newMedia?.sourceUrl).toContain('/new-route-video.mp4');
    expect(manager.isAwaitingRoutePlayer()).toBe(false);

    manager.stop();
    history.replaceState({}, '', '/');
  });

  it('admits a fresh post-route MediaSource URL before metadata so cache capture can bind', () => {
    history.replaceState({}, '', '/video/BV1ROUTEOLD1/');
    const video = makeControllableVideo();
    const manager = new PlaybackManager(document);
    const [oldMedia] = manager.start();

    history.pushState({}, '', '/video/BV1ROUTENEW2/');
    expect(manager.getMediaElements()).toEqual([]);

    video.src = 'blob:https://www.bilibili.com/fresh-media-source';
    const [newMedia] = manager.refresh();

    expect(newMedia).toMatchObject({
      elementId: oldMedia?.elementId,
      lifecycleGeneration: (oldMedia?.lifecycleGeneration ?? 0) + 1,
      sourceUrl: 'blob:https://www.bilibili.com/fresh-media-source',
    });
    expect(manager.isAwaitingRoutePlayer()).toBe(false);

    manager.stop();
    history.replaceState({}, '', '/');
  });

  it('admits a lifecycle that settled just before pushState only after current-manifest proof', () => {
    let now = 1_000;
    history.replaceState({}, '', '/video/BV1ROUTEOLD1/');
    const video = makeControllableVideo();
    video.src = '/old-route-video.mp4';
    Object.defineProperty(video, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect(0, 0, 960, 540),
    });
    const manager = new PlaybackManager(document, { now: () => now });
    const [oldMedia] = manager.start();

    video.dispatchEvent(new Event('emptied'));
    video.src = '/new-route-video.mp4';
    video.dispatchEvent(new Event('loadedmetadata'));
    const settledGeneration = manager.getMediaElements()[0]?.lifecycleGeneration;
    now += 10;
    history.pushState({}, '', '/video/BV1ROUTENEW2/');

    expect(manager.getMediaElements()).toEqual([]);
    expect(manager.isAwaitingRoutePlayer()).toBe(true);
    expect(manager.confirmCurrentRoutePlayerFromManifest()).toBe(true);
    expect(manager.getMediaElements()[0]).toMatchObject({
      elementId: oldMedia?.elementId,
      lifecycleGeneration: settledGeneration,
      sourceUrl: expect.stringContaining('/new-route-video.mp4'),
    });

    manager.stop();
    history.replaceState({}, '', '/');
  });

  it('does not manifest-confirm a stale lifecycle from the previous route', () => {
    let now = 1_000;
    history.replaceState({}, '', '/video/BV1ROUTEOLD1/');
    const video = makeControllableVideo();
    const manager = new PlaybackManager(document, { now: () => now });
    manager.start();
    video.dispatchEvent(new Event('emptied'));
    video.dispatchEvent(new Event('loadedmetadata'));
    now += 3_000;
    history.pushState({}, '', '/video/BV1ROUTENEW2/');

    expect(manager.confirmCurrentRoutePlayerFromManifest()).toBe(false);
    expect(manager.getMediaElements()).toEqual([]);

    manager.stop();
    history.replaceState({}, '', '/');
  });

  it('admits a newly inserted SPA player but exposes no active candidate while none exists', () => {
    history.replaceState({}, '', '/video/BV1ROUTEOLD1/');
    const oldVideo = makeControllableVideo();
    oldVideo.setAttribute('aria-label', '保留的旧播放器');
    Object.defineProperty(oldVideo, 'getBoundingClientRect', {
      configurable: true,
      value: () => domRect(0, 0, 960, 540),
    });
    const manager = new PlaybackManager(document);
    const [oldMedia] = manager.start();

    history.pushState({}, '', '/video/BV1ROUTENEW2/');
    const noPlayer = manager.getMediaElements();
    const activeWithoutPlayer = noPlayer[0]
      ? createActiveMediaFingerprint(document.URL, 2, noPlayer[0])
      : undefined;
    expect(noPlayer).toEqual([]);
    expect(activeWithoutPlayer).toBeUndefined();

    const newVideo = makeControllableVideo();
    newVideo.src = '/inserted-for-new-route.mp4';
    newVideo.setAttribute('aria-label', '新播放器');
    const current = manager.refresh();
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ title: '新播放器' });
    expect(current[0]?.elementId).not.toBe(oldMedia?.elementId);

    manager.stop();
    history.replaceState({}, '', '/');
  });

  it('builds a route/player fingerprint whose epoch rejects stale capture starts', () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    const [media] = manager.start();
    const fingerprint = createActiveMediaFingerprint(
      'https://www.youtube.com/watch?v=ZV-DAQGwK_o&list=playlist',
      7,
      media!,
    );

    expect(fingerprint).toMatchObject({
      routeKey: 'youtube:ZV-DAQGwK_o',
      mediaEpoch: 7,
      elementId: media?.elementId,
      lifecycleGeneration: 1,
      frameId: 0,
    });
    expect(activeMediaIdentityKey(fingerprint)).toContain(fingerprint.elementId);
    expect(sameActiveMediaIdentity(fingerprint, { ...fingerprint, title: '新标题' })).toBe(true);
    expect(sameActiveMediaIdentity(fingerprint, { ...fingerprint, mediaEpoch: 8 })).toBe(false);
    expect(
      sameActiveMediaIdentity(fingerprint, {
        ...fingerprint,
        lifecycleGeneration: fingerprint.lifecycleGeneration + 1,
      }),
    ).toBe(false);

    manager.stop();
  });

  it('toggles video picture-in-picture and rejects it for audio', async () => {
    const video = makeControllableVideo();
    let pipElement: Element | null = null;
    Object.defineProperty(document, 'pictureInPictureElement', {
      configurable: true,
      get: () => pipElement,
    });
    Object.defineProperty(video, 'requestPictureInPicture', {
      configurable: true,
      value: vi.fn(async () => {
        pipElement = video;
        return {};
      }),
    });
    Object.defineProperty(document, 'exitPictureInPicture', {
      configurable: true,
      value: vi.fn(async () => {
        pipElement = null;
      }),
    });
    const manager = new PlaybackManager(document);
    const [info] = manager.start();

    expect(
      await manager.execute({ action: 'togglePictureInPicture' }, info!.elementId),
    ).toMatchObject({ applied: true });
    expect(pipElement).toBe(video);
    expect(
      await manager.execute({ action: 'togglePictureInPicture' }, info!.elementId),
    ).toMatchObject({ applied: true });
    expect(pipElement).toBeNull();
    manager.stop();
  });
});

describe('FloatingPlaybackController', () => {
  it('mounts an isolated dark C-theme unified dock in launcher mode', () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      themeMode: 'dark',
      playback: { showController: true },
    });

    expect(controller.host.id).toBe(FLOATING_CONTROLLER_HOST_ID);
    expect(controller.host.dataset.theme).toBe('dark');
    expect(controller.host.dataset.mode).toBe('launcher');
    expect(controller.shadowRoot.querySelector('style')?.textContent).toContain(
      '--surface: rgba(8, 9, 13, .985)',
    );
    expect(controller.shadowRoot.querySelector('style')?.textContent).toContain('width: 52px');
    expect(controller.shadowRoot.querySelector('style')?.textContent).toContain('.launcher-tile');
    expect(controller.host.dataset.launcherEdge).toBe('right');
    expect(
      controller.shadowRoot.querySelector<HTMLImageElement>('.launcher-logo-light')?.src,
    ).toContain('/icons/foxfetch.svg');
    expect(
      controller.shadowRoot.querySelector<HTMLImageElement>('.launcher-logo-dark')?.src,
    ).toContain('/icons/foxfetch-dark.svg');
    expect(controller.shadowRoot.querySelector('.launcher-inner')).toBeNull();
    expect(controller.shadowRoot.querySelector('.launcher-progress > i')).not.toBeNull();
    expect(controller.shadowRoot.querySelectorAll('.launcher-status')).toHaveLength(2);
    expect(controller.shadowRoot.querySelector('style')?.textContent).toContain(
      '@media (prefers-reduced-motion: reduce)',
    );
    expect(controller.shadowRoot.querySelector('style')?.textContent).not.toContain(
      'conic-gradient',
    );
    expect(controller.shadowRoot.querySelector('[data-role="rate"]')).toBeNull();
    expect(document.querySelector(`#${FLOATING_CONTROLLER_HOST_ID}`)?.shadowRoot).toBe(
      controller.shadowRoot,
    );

    controller.destroy();
    manager.stop();
  });

  it('previews the inward launcher tile on hover and retracts after pointer leave', () => {
    vi.useFakeTimers();
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
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const launcher = controller.shadowRoot.querySelector<HTMLButtonElement>('.launcher')!;

    launcher.dispatchEvent(
      new TestPointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
    vi.advanceTimersByTime(99);
    expect(controller.host.dataset.launcherPreview).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(controller.host.dataset.launcherPreview).toBe('true');
    expect(launcher.style.getPropertyValue('--launcher-preview-width')).toBe('184px');

    launcher.dispatchEvent(
      new TestPointerEvent('pointerout', {
        bubbles: true,
        pointerType: 'mouse',
        relatedTarget: document.body,
      }),
    );
    vi.advanceTimersByTime(179);
    expect(controller.host.dataset.launcherPreview).toBe('true');
    vi.advanceTimersByTime(1);
    expect(controller.host.dataset.launcherPreview).toBeUndefined();

    controller.destroy();
    manager.stop();
    vi.unstubAllGlobals();
  });

  it('supports keyboard preview/open/escape and lets touch open without a hover preview', () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;

      constructor(
        type: string,
        init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
      ) {
        super(type, init);
        this.pointerId = init.pointerId ?? 2;
        this.pointerType = init.pointerType ?? 'touch';
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const launcher = controller.shadowRoot.querySelector<HTMLButtonElement>('.launcher')!;

    launcher.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(controller.host.dataset.launcherPreview).toBe('true');
    launcher.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(controller.host.dataset.launcherPreview).toBeUndefined();

    launcher.dispatchEvent(
      new TestPointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }),
    );
    expect(controller.host.dataset.launcherPreview).toBeUndefined();
    launcher.click();
    expect(controller.getMode()).toBe('playback');

    controller.collapse();
    launcher.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(controller.getMode()).toBe('playback');

    controller.destroy();
    manager.stop();
    vi.unstubAllGlobals();
  });

  it('retracts the preview when a launcher drag crosses the six-pixel threshold', () => {
    vi.useFakeTimers();
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;

      constructor(
        type: string,
        init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
      ) {
        super(type, init);
        this.pointerId = init.pointerId ?? 3;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const launcher = controller.shadowRoot.querySelector<HTMLButtonElement>('.launcher')!;
    launcher.dispatchEvent(
      new TestPointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
    vi.advanceTimersByTime(100);
    expect(controller.host.dataset.launcherPreview).toBe('true');

    launcher.dispatchEvent(
      new TestPointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 900,
        clientY: 600,
      }),
    );
    launcher.dispatchEvent(
      new TestPointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 907,
        clientY: 600,
      }),
    );
    expect(controller.host.dataset.dragging).toBe('true');
    expect(controller.host.dataset.launcherPreview).toBeUndefined();
    launcher.dispatchEvent(
      new TestPointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 907,
        clientY: 600,
      }),
    );
    launcher.click();
    expect(controller.getMode()).toBe('launcher');

    controller.destroy();
    manager.stop();
    vi.unstubAllGlobals();
  });

  it('offers only a rate slider and preserves the draft across snapshots', async () => {
    const video = makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      themeMode: 'light',
      playback: { showController: true },
    });

    expect(
      controller.shadowRoot.querySelectorAll(
        '[data-media-action="set-rate"], .custom-rate, input[type="number"]',
      ),
    ).toHaveLength(0);
    controller.openPlayback();
    const slider = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="rate-slider"]',
    )!;
    expect(slider.min).toBe('0.1');
    expect(slider.max).toBe('16');
    slider.value = '3.25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    controller.update(manager.getMediaElements());
    expect(slider.value).toBe('3.25');
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    expect(video.playbackRate).toBe(3.25);
    expect(controller.shadowRoot.querySelector('[data-role="current-rate"]')?.textContent).toBe(
      '3.25×',
    );

    controller.destroy();
    manager.stop();
  });

  it('uses one Shadow host for playback and cache and supports suppression', () => {
    makeControllableVideo();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });

    expect(document.querySelectorAll(`#${FLOATING_CONTROLLER_HOST_ID}`)).toHaveLength(1);
    expect(cache.shadowRoot).toBe(controller.shadowRoot);
    cache.start({ sessionId: 'cache-1', title: 'Demo' });
    expect(controller.getMode()).toBe('cache');
    expect(controller.shadowRoot.querySelector('.cache-view')).not.toBeNull();
    cache.setFilename('自定义名称');
    expect(
      controller.shadowRoot.querySelector<HTMLInputElement>('[data-role="cache-filename"]')?.value,
    ).toBe('自定义名称');
    const clearAfter = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-clear-after-download"]',
    )!;
    clearAfter.checked = true;
    clearAfter.dispatchEvent(new Event('change', { bubbles: true }));
    expect(cache.getSnapshot().clearAfterDownload).toBe(true);
    expect(controller.shadowRoot.querySelector('.tracks')).not.toBeNull();

    controller.collapse();
    expect(controller.getMode()).toBe('launcher');
    controller.suppress(true);
    expect(controller.getMode()).toBe('suppressed');
    expect(controller.host.hidden).toBe(true);
    controller.suppress(false);
    expect(controller.getMode()).toBe('launcher');
    controller.suppress(true);
    cache.show();
    expect(controller.getMode()).toBe('suppressed');
    controller.suppress(false);
    expect(controller.getMode()).toBe('cache');

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('drags the launcher, snaps to an edge, and persists its normalized position', async () => {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;

      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    makeControllableVideo();
    const set = vi.fn<(items: Record<string, unknown>) => Promise<void>>(async () => undefined);
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      positionStore: { get: vi.fn(async () => ({})), set },
    });
    const launcher = controller.shadowRoot.querySelector<HTMLButtonElement>('.launcher')!;
    launcher.dispatchEvent(
      new TestPointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 980, clientY: 700 }),
    );
    launcher.dispatchEvent(
      new TestPointerEvent('pointermove', { bubbles: true, button: 0, clientX: 20, clientY: 300 }),
    );
    launcher.dispatchEvent(
      new TestPointerEvent('pointerup', { bubbles: true, button: 0, clientX: 20, clientY: 300 }),
    );
    await Promise.resolve();

    expect(launcher.style.left).toBe('10px');
    expect(controller.host.dataset.launcherEdge).toBe('left');
    expect(set).toHaveBeenCalledOnce();
    const saved = set.mock.calls[0]![0];
    const savedKey = Object.keys(saved)[0]!;
    expect(savedKey).toContain('foxfetch:media-dock-position:');
    expect(saved[savedKey]).toMatchObject({ edge: 'left' });

    controller.destroy();
    manager.stop();
    vi.unstubAllGlobals();
  });

  it.each([
    { edge: 'left', endX: 100 },
    { edge: 'right', endX: 520 },
  ])(
    'drags the expanded panel smoothly and persists its $edge edge anchor',
    async ({ edge, endX }) => {
      class TestPointerEvent extends MouseEvent {
        readonly pointerId: number;

        constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 7;
        }
      }
      vi.stubGlobal('PointerEvent', TestPointerEvent);
      makeControllableVideo();
      const set = vi.fn<(items: Record<string, unknown>) => Promise<void>>(async () => undefined);
      const manager = new PlaybackManager(document);
      manager.start();
      const controller = new FloatingPlaybackController(document, manager, {
        playback: { showController: true },
        positionStore: { get: vi.fn(async () => ({})), set },
      });
      controller.openPlayback();
      const panel = controller.shadowRoot.querySelector<HTMLElement>('.panel')!;
      const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
      const header = controller.shadowRoot.querySelector<HTMLElement>('.head')!;
      const originalLeft = Number.parseFloat(panel.style.left);
      const originalLauncherTop = Number.parseFloat(launcher.style.top);
      const finish = vi.fn();
      Object.defineProperty(panel, 'getAnimations', {
        value: () => [{ animationName: 'panel-open', finish }],
      });

      header.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 700,
          clientY: 400,
        }),
      );
      header.dispatchEvent(
        new TestPointerEvent('pointermove', {
          bubbles: true,
          button: 0,
          clientX: endX,
          clientY: 220,
        }),
      );
      expect(finish).toHaveBeenCalledOnce();
      expect(Number.parseFloat(panel.style.left)).toBe(Math.max(10, originalLeft + endX - 700));
      const draggedTop = panel.style.top;
      header.dispatchEvent(
        new TestPointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          clientX: endX,
          clientY: 220,
        }),
      );
      await Promise.resolve();

      const sharedLeft = edge === 'left' ? 10 : window.innerWidth - 52 - 10;
      const sharedTop = originalLauncherTop - 180;
      expect(Number.parseFloat(launcher.style.left)).toBe(sharedLeft);
      expect(Number.parseFloat(launcher.style.top)).toBe(originalLauncherTop - 180);
      expect(panel.style.left).toBe(edge === 'left' ? '10px' : `${window.innerWidth - 410 - 10}px`);
      expect(panel.style.top).toBe(draggedTop);
      expect(set).toHaveBeenCalledOnce();
      const saved = Object.values(set.mock.calls[0]![0])[0];
      expect(saved).toMatchObject({
        version: 2,
        mode: 'edge',
        edge,
        inset: 10,
        xRatio: expect.any(Number),
        yRatio: expect.any(Number),
      });
      expect(saved).not.toHaveProperty('panelXRatio');
      expect(saved).not.toHaveProperty('panelYRatio');

      controller.collapse();
      expect(controller.getMode()).toBe('launcher');
      expect(Number.parseFloat(launcher.style.left)).toBe(sharedLeft);
      expect(Number.parseFloat(launcher.style.top)).toBe(sharedTop);

      const stored = set.mock.calls[0]![0];
      controller.destroy();
      const restored = new FloatingPlaybackController(document, manager, {
        playback: { showController: true },
        positionStore: { get: vi.fn(async () => stored), set: vi.fn(async () => undefined) },
      });
      await Promise.resolve();
      restored.openPlayback();
      const restoredLauncher = restored.shadowRoot.querySelector<HTMLElement>('.launcher')!;
      expect(Number.parseFloat(restoredLauncher.style.left)).toBe(sharedLeft);
      expect(Number.parseFloat(restoredLauncher.style.top)).toBe(sharedTop);
      expect(restored.shadowRoot.querySelector<HTMLElement>('.panel')?.style.left).toBe(
        panel.style.left,
      );
      expect(restored.shadowRoot.querySelector<HTMLElement>('.panel')?.style.top).toBe(
        panel.style.top,
      );

      restored.destroy();
      manager.stop();
      vi.unstubAllGlobals();
    },
  );

  it('uses a styled media listbox and confirms before explicitly closing the dock', () => {
    makeControllableVideo();
    document.body.append(makeControllableAudio());
    const manager = new PlaybackManager(document);
    manager.start();
    const onSelectedMediaChange = vi.fn();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onSelectedMediaChange,
    });
    controller.openPlayback();

    expect(controller.shadowRoot.querySelector('select')).toBeNull();
    const trigger = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="toggle-target-list"]',
    )!;
    const list = controller.shadowRoot.querySelector<HTMLElement>('[data-role="target-list"]')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 46,
      right: 360,
      bottom: window.innerHeight - 10,
      left: 20,
      width: 340,
      height: 36,
      x: 20,
      y: window.innerHeight - 46,
      toJSON: () => ({}),
    });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 176 });
    trigger.click();
    expect(list.hidden).toBe(false);
    expect(list.closest('.target-picker')?.getAttribute('data-placement')).toBe('top');
    const options = list.querySelectorAll<HTMLButtonElement>('[data-action="select-target"]');
    expect(options).toHaveLength(2);
    options[1]!.click();
    expect(controller.getSelectedElementId()).toBe(options[1]!.dataset.elementId);
    expect(onSelectedMediaChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ elementId: options[1]!.dataset.elementId }),
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-action="request-hide"]')!.click();
    const confirmation = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="close-confirm"]',
    )!;
    expect(confirmation.hidden).toBe(false);
    expect(confirmation.textContent).toContain('Alt+Shift+M');
    expect(controller.getMode()).toBe('playback');
    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-action="cancel-hide"]')!.click();
    expect(confirmation.hidden).toBe(true);

    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-action="request-hide"]')!.click();
    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-action="confirm-hide"]')!.click();
    expect(controller.getMode()).toBe('hidden');
    controller.show();
    expect(controller.getMode()).toBe('playback');

    controller.destroy();
    manager.stop();
  });

  it('moves automatic active media and its epoch to a new playing video while the old DOM node remains', () => {
    const oldVideo = makeControllableVideo();
    oldVideo.setAttribute('aria-label', '旧视频');
    Object.defineProperty(oldVideo, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
        width: 640,
        height: 360,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(oldVideo, 'paused', {
      configurable: true,
      writable: true,
      value: false,
    });

    const manager = new PlaybackManager(document);
    const [oldMedia] = manager.start();
    let activeMedia = oldMedia
      ? createActiveMediaFingerprint(document.URL, 1, oldMedia)
      : undefined;
    let mediaEpoch = activeMedia ? 1 : 0;
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onSelectedMediaChange: (media) => {
        if (!media) return;
        const candidate = createActiveMediaFingerprint(document.URL, mediaEpoch, media);
        if (
          !activeMedia ||
          activeMediaIdentityKey(candidate) !== activeMediaIdentityKey(activeMedia)
        ) {
          mediaEpoch += 1;
        }
        activeMedia = createActiveMediaFingerprint(document.URL, mediaEpoch, media);
      },
    });

    Object.defineProperty(oldVideo, 'paused', {
      configurable: true,
      writable: true,
      value: true,
    });
    const newVideo = makeControllableVideo();
    newVideo.src = '/new-video.mp4';
    newVideo.setAttribute('aria-label', '新视频');
    Object.defineProperty(newVideo, 'paused', {
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(newVideo, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 960,
        bottom: 540,
        width: 960,
        height: 540,
        toJSON: () => ({}),
      }),
    });

    const elements = manager.refresh();
    const newMedia = elements.find((element) => element.title === '新视频');
    controller.update(elements);

    expect(document.body.contains(oldVideo)).toBe(true);
    expect(controller.getSelectedElementId()).toBe(newMedia?.elementId);
    expect(activeMedia).toMatchObject({
      elementId: newMedia?.elementId,
      lifecycleGeneration: newMedia?.lifecycleGeneration,
      mediaEpoch: 2,
    });

    controller.destroy();
    manager.stop();
  });

  it('keeps an explicit target only after the selected route media lifecycle settles', () => {
    const oldVideo = makeControllableVideo();
    oldVideo.setAttribute('aria-label', '手动目标');
    const newVideo = makeControllableVideo();
    newVideo.src = '/automatic.mp4';
    newVideo.setAttribute('aria-label', '自动目标');
    Object.defineProperty(newVideo, 'paused', {
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(oldVideo, 'paused', {
      configurable: true,
      writable: true,
      value: true,
    });

    const manager = new PlaybackManager(document);
    const elements = manager.start();
    const oldMedia = elements.find((element) => element.title === '手动目标')!;
    const newMedia = elements.find((element) => element.title === '自动目标')!;
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    controller.openPlayback();
    controller.shadowRoot
      .querySelector<HTMLButtonElement>(
        `[data-action="select-target"][data-element-id="${oldMedia.elementId}"]`,
      )!
      .click();

    controller.update(manager.getMediaElements());
    expect(controller.getSelectedElementId()).toBe(oldMedia.elementId);

    history.pushState({}, '', '/next-media-route');
    controller.update(manager.getMediaElements());
    expect(controller.getSelectedElementId()).toBeUndefined();

    newVideo.dispatchEvent(new Event('loadedmetadata'));
    controller.update(manager.getMediaElements());
    expect(controller.getSelectedElementId()).toBe(newMedia.elementId);

    expect(
      controller.shadowRoot.querySelector<HTMLButtonElement>(
        `[data-action="select-target"][data-element-id="${oldMedia.elementId}"]`,
      ),
    ).toBeNull();
    oldVideo.dispatchEvent(new Event('emptied'));
    controller.update(manager.getMediaElements());
    expect(controller.getSelectedElementId()).toBe(newMedia.elementId);

    history.replaceState({}, '', '/');
    controller.destroy();
    manager.stop();
  });

  it('follows the buffered tail only while capturing and toggles pause/resume without data loss', async () => {
    vi.useFakeTimers();
    const video = makeControllableVideo();
    setBufferedRanges(video, [[0, 80]]);
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });
    cache.start({ sessionId: 'cache-follow', title: 'Demo' });
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'cache-follow',
    });

    const follow = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-buffer-tail"]',
    )!;
    follow.checked = true;
    follow.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(850);
    expect(video.currentTime).toBeCloseTo(78.75);

    const toggle = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-cache-action="toggle-capture"]',
    )!;
    toggle.click();
    expect(cache.getSnapshot().status).toBe('paused');
    expect(toggle.textContent).toBe('开始继续捕获');
    video.currentTime = 10;
    setBufferedRanges(video, [[0, 90]]);
    await vi.advanceTimersByTimeAsync(1_700);
    expect(video.currentTime).toBe(10);

    toggle.click();
    expect(cache.getSnapshot().status).toBe('capturing');
    await vi.advanceTimersByTimeAsync(350);
    expect(video.currentTime).toBeCloseTo(88.75);
    expect(cache.getSnapshot().capturedBytes).toBe(0);

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('renders a verified complete-cache badge in the metric region', () => {
    makeControllableVideo();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });
    cache.start({ sessionId: 'cache-complete', title: 'Demo' });
    cache.markStartedAtBeginning();
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'chunk',
      sessionId: 'cache-complete',
      trackId: 'video-track',
      groupId: 'media-source',
      mime: 'video/mp4',
      sequence: 1,
      bytes: Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]).buffer,
      bufferedRanges: [[0, 10]],
      duration: 10,
    });
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'cache-complete',
      groupId: 'media-source',
    });

    const badge = controller.shadowRoot.querySelector<HTMLElement>('[data-role="cache-complete"]')!;
    expect(badge.textContent).toBe('已完整缓存');
    expect(badge.dataset.complete).toBe('true');
    expect(badge.closest('.metric-row')).not.toBeNull();
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="cache-time"]')?.textContent,
    ).toBe('0:10 / 0:10');
    const progressbar = controller.shadowRoot.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(progressbar.getAttribute('aria-valuenow')).toBe('10');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('10');
    expect(controller.shadowRoot.textContent).not.toContain('512 MB');

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('pauses playback and stops following the buffer tail once capture is complete', async () => {
    vi.useFakeTimers();
    const video = makeControllableVideo();
    video.currentTime = 5;
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    setBufferedRanges(video, [[0, 10]]);
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });
    cache.start({ sessionId: 'cache-auto-pause', title: 'Demo' });

    const follow = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-buffer-tail"]',
    )!;
    follow.checked = true;
    follow.dispatchEvent(new Event('change', { bubbles: true }));
    cache.markStartedAtBeginning();
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'chunk',
      sessionId: 'cache-auto-pause',
      trackId: 'video-track',
      groupId: 'media-source',
      mime: 'video/mp4',
      sequence: 1,
      bytes: Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]).buffer,
      bufferedRanges: [[0, 10]],
      duration: 10,
    });
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'cache-auto-pause',
      groupId: 'media-source',
    });
    await Promise.resolve();

    expect(cache.getSnapshot().isComplete).toBe(true);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(follow.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1_700);
    expect(video.currentTime).toBe(5);

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('guards the selected cache lifecycle from site autoplay and restores it when disabled', async () => {
    const video = makeControllableVideo();
    video.autoplay = true;
    video.currentTime = 98.9;
    Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
    const siteEnded = vi.fn();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });

    cache.start({ sessionId: 'cache-no-auto-advance', title: 'Demo' });
    expect(video.autoplay).toBe(false);

    video.addEventListener('ended', siteEnded);
    video.dispatchEvent(new Event('timeupdate'));
    expect(video.pause).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('ended'));
    expect(video.pause).toHaveBeenCalledOnce();
    expect(siteEnded).not.toHaveBeenCalled();

    await video.play();
    expect(video.paused).toBe(true);

    const prevent = controller.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-prevent-auto-advance"]',
    )!;
    expect(prevent.checked).toBe(true);
    prevent.checked = false;
    prevent.dispatchEvent(new Event('change', { bubbles: true }));
    expect(video.autoplay).toBe(true);

    await video.play();
    expect(video.paused).toBe(false);

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('uses the main cache button for single-track saving when no merge pair exists', async () => {
    makeControllableVideo();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });
    cache.start({ sessionId: 'cache-single', title: 'Demo' });
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'chunk',
      sessionId: 'cache-single',
      trackId: 'video-track',
      groupId: 'media-source',
      mime: 'video/mp4',
      sequence: 1,
      bytes: Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112]).buffer,
    });
    cache.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'cache-single',
      groupId: 'media-source',
    });
    const download = vi.spyOn(cache, 'downloadCaptured').mockResolvedValue([]);

    const button = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-cache-action="download"]',
    )!;
    expect(button.textContent).toBe('下载已捕获数据');
    button.click();
    await Promise.resolve();
    expect(download).toHaveBeenCalledWith(true);

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('restores an active cache panel after navigation even when it was explicitly hidden', () => {
    makeControllableVideo();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      cacheCapture: cache,
      playback: { showController: true },
    });

    controller.applyExternalMode('suppressed');
    expect(controller.getMode()).toBe('suppressed');
    controller.applyExternalMode('launcher');
    expect(controller.getMode()).toBe('launcher');

    controller.hide();
    controller.update(manager.getMediaElements());
    expect(controller.getMode()).toBe('hidden');
    cache.start({ sessionId: 'hidden-cache', title: 'Demo' });
    expect(controller.getMode()).toBe('hidden');
    controller.applyExternalMode('suppressed');
    controller.applyExternalMode('launcher');
    expect(controller.getMode()).toBe('hidden');

    controller.resetForNavigation();
    expect(controller.getMode()).toBe('cache');
    expect(controller.host.hidden).toBe(false);

    controller.destroy();
    cache.destroy();
    manager.stop();
  });
});

describe('FloatingPlaybackController resource downloads', () => {
  it('keeps the panel and anchored product menu inside the viewport', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'viewport-product',
          title: '视口安全测试',
          domain: 'bilibili.com',
          options: [{ mode: 'complete' }, { mode: 'video' }, { mode: 'audio' }],
        },
      ],
    });
    controller.openResources();

    const style = controller.shadowRoot.querySelector('style')?.textContent ?? '';
    expect(style).toContain('max-height: calc(100dvh - 20px)');
    expect(style).toContain('overscroll-behavior: contain');
    expect(style).toContain('.dock-product-menu { position: fixed');
    expect(style).toContain('container: foxfetch-dock / inline-size');
    expect(style).toContain('@container foxfetch-dock (max-width: 380px)');
    expect(controller.shadowRoot.querySelectorAll('[data-media-action="set-rate"]')).toHaveLength(
      0,
    );

    const panel = controller.shadowRoot.querySelector<HTMLElement>('.panel')!;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 410, 748));
    window.dispatchEvent(new Event('resize'));
    expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(panel.style.top) + 748).toBeLessThanOrEqual(window.innerHeight - 10);

    const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const trigger = card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    const menu = card.querySelector<HTMLElement>('[role="menu"]')!;
    let triggerRect = domRect(window.innerWidth - 64, window.innerHeight - 68, 40, 34);
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => triggerRect);
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(domRect(0, 0, 300, 210));
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 210 });

    trigger.click();
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(menu.style.left) + 300).toBeLessThanOrEqual(window.innerWidth - 10);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(menu.style.top) + 210).toBeLessThanOrEqual(window.innerHeight - 10);

    triggerRect = domRect(window.innerWidth - 64, 20, 40, 34);
    controller.shadowRoot
      .querySelector<HTMLElement>('.resources-view')!
      .dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(menu.style.top).toBe('60px'));

    trigger.click();
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    controller.destroy();
    manager.stop();
  });

  it('uses accessible playback/resources tabs with regular/cache secondary tabs', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const cache = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    const onResourceViewRequest = vi.fn(async () => undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      cacheCapture: cache,
      onResourceViewRequest,
    });

    controller.openPlayback();
    const style = controller.shadowRoot.querySelector('style')?.textContent ?? '';
    expect(style).toContain('.view-tabs::before');
    expect(style).toContain('.resource-tabs::before');
    expect(style).toContain('cubic-bezier(.2, 1.55, .35, 1)');
    expect(style).toContain('@media (prefers-reduced-motion: reduce)');
    const playbackTab = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="open-playback"]',
    )!;
    const resourcesTab = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="open-resources"]',
    )!;
    expect(playbackTab.textContent).toBe('播放控制');
    expect(resourcesTab.textContent).toBe('资源下载');
    expect(playbackTab.tabIndex).toBe(0);
    expect(resourcesTab.tabIndex).toBe(-1);

    resourcesTab.click();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledOnce());
    expect(onResourceViewRequest).toHaveBeenLastCalledWith(false);
    expect(controller.getMode()).toBe('resources');
    expect(resourcesTab.getAttribute('aria-selected')).toBe('true');
    expect(resourcesTab.tabIndex).toBe(0);
    expect(playbackTab.tabIndex).toBe(-1);
    expect(
      controller.shadowRoot.querySelector('#foxfetch-regular-panel')?.getAttribute('aria-hidden'),
    ).toBe('false');

    controller.shadowRoot
      .querySelector<HTMLButtonElement>('[data-action="refresh-resources"]')!
      .click();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledTimes(2));
    expect(onResourceViewRequest).toHaveBeenLastCalledWith(true);

    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-action="open-cache"]')!.click();
    expect(controller.getMode()).toBe('cache');
    expect(
      controller.shadowRoot.querySelector('#foxfetch-cache-panel')?.getAttribute('aria-hidden'),
    ).toBe('false');
    controller.shadowRoot
      .querySelector<HTMLButtonElement>('[data-action="open-regular-download"]')!
      .click();
    expect(controller.getMode()).toBe('resources');

    controller.destroy();
    cache.destroy();
    manager.stop();
  });

  it('renders every resource state and dispatches all finished-product choices', async () => {
    document.title = '测试视频 - 哔哩哔哩_bilibili';
    const video = makeControllableVideo();
    video.setAttribute('aria-label', '测试视频');
    video.poster = 'https://images.example.test/current-video-cover.jpg';
    const manager = new PlaybackManager(document);
    manager.start();
    const onDownload = vi.fn(async () => undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceProductDownload: onDownload,
    });
    const content = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="regular-download-content"]',
    )!;

    controller.setResourceSnapshot({ status: 'loading', products: [] });
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(content.textContent).toContain('正在组合可下载资源');
    expect(controller.shadowRoot.querySelector('[data-role="resource-status"]')?.textContent).toBe(
      '',
    );
    expect(
      controller.shadowRoot
        .querySelector('[data-role="resource-status"]')
        ?.getAttribute('data-state'),
    ).toBe('recognizing');
    controller.setResourceSnapshot({ status: 'error', products: [], error: '识别失败' });
    expect(
      controller.shadowRoot.querySelector('[data-role="resource-notice"]')?.textContent,
    ).toContain('识别失败');
    expect(
      controller.shadowRoot
        .querySelector('[data-role="resource-status"]')
        ?.getAttribute('data-state'),
    ).toBe('error');
    controller.setResourceSnapshot({ status: 'ready', products: [] });
    expect(content.textContent).toContain('暂未识别到可下载视频');
    expect(controller.shadowRoot.querySelector('[data-role="resource-status"]')?.textContent).toBe(
      '',
    );
    expect(
      controller.shadowRoot
        .querySelector('[data-role="resource-status"]')
        ?.getAttribute('data-state'),
    ).toBe('success');

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'product-1',
          title: '测试视频',
          domain: 'bilibili.com',
          duration: 96,
          selectedQuality: '1080P',
          options: [{ mode: 'complete' }, { mode: 'video' }, { mode: 'audio' }],
        },
      ],
    });
    expect(content.textContent).toContain('测试视频');
    expect(content.textContent).toContain('1080P');
    expect(controller.shadowRoot.querySelector('.dock-product-duration')?.textContent).toBe('1:36');
    expect(
      controller.shadowRoot.querySelector('.dock-product-preview')?.getAttribute('data-platform'),
    ).toBe('bilibili');
    expect(controller.shadowRoot.querySelector('.dock-product-platform')?.textContent).toBe(
      '哔哩哔哩',
    );
    expect(
      controller.shadowRoot.querySelector<HTMLImageElement>('.dock-product-poster')?.src,
    ).toContain('/current-video-cover.jpg');
    expect(content.textContent).not.toContain('bilibili.com');
    expect(content.textContent).not.toContain('成品');
    expect(controller.shadowRoot.innerHTML).not.toContain('poster=');
    expect(controller.shadowRoot.querySelector('.dock-product-trigger svg')).not.toBeNull();

    const keyboardCard = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const keyboardTrigger =
      keyboardCard.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    keyboardTrigger.focus();
    keyboardTrigger.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }),
    );
    const firstMenuItem = keyboardCard.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    await vi.waitFor(() => expect(controller.shadowRoot.activeElement).toBe(firstMenuItem));
    firstMenuItem.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(keyboardCard.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);
    expect(controller.shadowRoot.activeElement).toBe(keyboardTrigger);

    keyboardTrigger.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(keyboardCard.querySelector<HTMLElement>('[role="menu"]')?.hidden).toBe(true);

    for (const mode of ['complete', 'video', 'audio'] as const) {
      const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
      card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
      card
        .querySelector<HTMLButtonElement>(`[role="menuitem"][data-download-mode="${mode}"]`)!
        .click();
      await vi.waitFor(() => expect(onDownload).toHaveBeenCalledWith('product-1', mode));
    }

    const pageIdentity = siteMediaRouteKey(document.URL);
    controller.clearResourceSnapshotForNavigation({
      navigationEpoch: 1,
      mediaEpoch: 1,
      pageIdentity,
    });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'product-after-navigation',
          title: '其他视频',
          domain: 'bilibili.com',
          duration: 42,
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 1,
      pageIdentity,
    });
    expect(controller.shadowRoot.querySelector('.dock-product-poster')).toBeNull();
    expect(controller.shadowRoot.innerHTML).not.toContain('current-video-cover.jpg');

    controller.destroy();
    manager.stop();
    document.title = '';
  });

  it('uses the selected URL-free quality capability in the page Dock', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const onDownload = vi.fn(async () => undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceProductDownload: onDownload,
    });

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'quality-1080-token',
          title: '当前视频',
          domain: 'bilibili.com',
          duration: 60,
          selectedQuality: '1080P · AVC',
          qualities: [
            {
              token: 'quality-1080-token',
              label: '1080P · AVC',
              detail: '1920×1080',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
            {
              token: 'quality-1080-hevc-token',
              label: '1080P · HEVC',
              detail: '1920×1080',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
            {
              token: 'quality-720-token',
              label: '720P · HEVC',
              detail: '1280×720',
              completeAvailable: false,
              videoOnlyAvailable: true,
            },
          ],
          options: [{ mode: 'complete' }, { mode: 'video' }, { mode: 'audio' }],
        },
      ],
    });

    const resolution = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="product-resolution"]',
    )!;
    let codec = controller.shadowRoot.querySelector<HTMLElement>('[data-role="product-quality"]')!;
    expect(
      [...resolution.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(['1080P', '720P']);
    expect(
      [...codec.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(['AVC', 'HEVC']);
    expect(controller.shadowRoot.querySelectorAll('select')).toHaveLength(0);
    expect(controller.shadowRoot.querySelector('.dock-product-variant-caption')).toBeNull();
    expect(resolution.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe(
      '当前视频 的清晰度',
    );
    expect(codec.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe(
      '当前视频 的视频编码',
    );

    const codecTrigger = codec.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    codecTrigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    await vi.waitFor(() => expect(controller.shadowRoot.activeElement?.textContent).toBe('AVC'));
    controller.shadowRoot.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }),
    );
    expect(controller.shadowRoot.activeElement?.textContent).toBe('HEVC');
    controller.shadowRoot.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );
    expect(codec.dataset.value).toBe('quality-1080-hevc-token');

    const resolutionTrigger = resolution.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    resolutionTrigger.click();
    expect(resolutionTrigger.getAttribute('aria-expanded')).toBe('true');
    resolution.querySelector<HTMLButtonElement>('[role="option"][data-value="720P"]')!.click();
    codec = controller.shadowRoot.querySelector<HTMLElement>('[data-role="product-quality"]')!;
    expect(
      [...codec.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(['HEVC']);
    expect(codec.dataset.value).toBe('quality-720-token');

    resolutionTrigger.click();
    await vi.waitFor(() => expect(resolutionTrigger.getAttribute('aria-expanded')).toBe('true'));
    controller.shadowRoot.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
    );
    expect(resolutionTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(controller.shadowRoot.activeElement).toBe(resolutionTrigger);

    const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    const unavailableComplete = card.querySelector<HTMLButtonElement>(
      '[data-download-mode="complete"]',
    )!;
    expect(unavailableComplete.disabled).toBe(true);
    expect(unavailableComplete.hidden).toBe(false);
    card.querySelector<HTMLButtonElement>('[data-download-mode="video"]')!.click();
    await vi.waitFor(() =>
      expect(onDownload).toHaveBeenCalledWith('quality-1080-token', 'video', 'quality-720-token'),
    );

    controller.destroy();
    manager.stop();
  });

  it('keeps three Dolby Vision download rows stable through checking, blocked, and ready states', () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const quality = {
      id: 'dv-quality',
      token: 'dv-token',
      label: '杜比视界 · HEVC',
      detail: '3840×2160 · 29.970 fps · Dolby Vision',
      dynamicRange: 'Dolby Vision' as const,
      videoCodec: 'HEVC',
      audioCodec: 'AAC',
      completeAvailable: false,
      videoOnlyAvailable: true,
    };
    const product = {
      id: 'dv-product',
      title: '杜比视界测试视频',
      domain: 'bilibili.com',
      qualities: [quality],
      options: [
        { mode: 'complete' as const, available: false },
        { mode: 'video' as const, available: true },
        { mode: 'audio' as const, available: true },
      ],
    };

    controller.setResourceSnapshot({ status: 'loading', products: [product] });
    const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const trigger = card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    trigger.click();
    const rows = card.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(rows).toHaveLength(3);
    const complete = card.querySelector<HTMLButtonElement>('[data-download-mode="complete"]')!;
    const videoOnly = card.querySelector<HTMLButtonElement>('[data-download-mode="video"]')!;
    const audioOnly = card.querySelector<HTMLButtonElement>('[data-download-mode="audio"]')!;
    expect(complete.hidden).toBe(false);
    expect(complete.disabled).toBe(true);
    expect(complete.dataset.fidelityState).toBe('checking');
    expect(complete.textContent).toContain('正在验证 Dolby Vision');
    expect(complete.textContent).not.toContain('未识别到可安全配对的音频');
    expect(videoOnly.textContent).toContain('原轨无音频视频');
    expect(videoOnly.textContent).toContain('MP4 · Dolby Vision · HEVC · 无音频');
    expect(audioOnly.textContent).toContain('原始音轨 · AAC · 不转码');

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          ...product,
          qualities: [
            {
              ...quality,
              fidelityState: 'blocked' as const,
              mergeBlockedReason: 'Dolby Vision 配置与 RPU 完整性尚未通过校验。',
            },
          ],
        },
      ],
    });
    expect(card.dataset.fidelityState).toBe('blocked');
    expect(complete.dataset.fidelityState).toBe('blocked');
    expect(complete.textContent).toContain('Dolby Vision 配置与 RPU 完整性尚未通过校验。');
    const failure = card.querySelector<HTMLElement>('[data-role="product-fidelity-error"]')!;
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toBe('Dolby Vision 配置与 RPU 完整性尚未通过校验。');

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          ...product,
          qualities: [
            {
              ...quality,
              completeAvailable: true,
              fidelityState: 'ready' as const,
            },
          ],
          options: product.options.map((option) =>
            option.mode === 'complete' ? { ...option, available: true } : option,
          ),
        },
      ],
    });
    expect(card.dataset.fidelityState).toBe('ready');
    expect(complete.disabled).toBe(false);
    expect(complete.textContent).toContain('MP4 · Dolby Vision · HEVC + AAC');
    expect(failure.hidden).toBe(true);

    controller.destroy();
    manager.stop();
  });

  it('preserves an open quality listbox across same-generation scan updates', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const pageIdentity = siteMediaRouteKey(document.URL);
    const product = {
      id: 'stable-product',
      title: '扫描前标题',
      domain: 'bilibili.com',
      selectedQuality: '1080P · AVC',
      qualities: [
        {
          token: 'quality-1080-token',
          label: '1080P · AVC',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
        {
          token: 'quality-720-token',
          label: '720P · AVC',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
      ],
      options: [{ mode: 'complete' as const }, { mode: 'video' as const }],
    };
    controller.setResourceSnapshot({
      status: 'ready',
      products: [product],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 1,
      pageIdentity,
    });

    const initialCard = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const resolution = initialCard.querySelector<HTMLElement>('[data-role="product-resolution"]')!;
    const trigger = resolution.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    trigger.click();
    const list = resolution.querySelector<HTMLElement>('[role="listbox"]')!;
    const focusedOption = list.querySelector<HTMLButtonElement>('[data-value="720P"]')!;
    list.scrollTop = 19;
    focusedOption.focus();

    controller.setResourceSnapshot({
      status: 'loading',
      products: [product],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 2,
      pageIdentity,
    });
    expect(controller.shadowRoot.querySelector('.dock-product')).toBe(initialCard);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(list.scrollTop).toBe(19);
    expect(controller.shadowRoot.activeElement).toBe(focusedOption);

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          ...product,
          title: '扫描后标题',
          qualities: [
            ...product.qualities,
            {
              token: 'quality-480-token',
              label: '480P · AVC',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
          ],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 3,
      pageIdentity,
    });
    expect(controller.shadowRoot.querySelector('.dock-product')).toBe(initialCard);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(list.scrollTop).toBe(19);
    expect(controller.shadowRoot.activeElement).toBe(focusedOption);

    focusedOption.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await vi.waitFor(() =>
      expect(controller.shadowRoot.querySelector('.dock-product')).not.toBe(initialCard),
    );
    expect(controller.shadowRoot.textContent).toContain('扫描后标题');
    expect(
      controller.shadowRoot.querySelectorAll('[data-role="product-resolution"] [role="option"]'),
    ).toHaveLength(3);

    controller.destroy();
    manager.stop();
  });

  it('keeps one live card through 50 rotating capability snapshots and downloads with the latest grant', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const onDownload = vi.fn(async () => undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceProductDownload: onDownload,
    });
    const pageIdentity = siteMediaRouteKey(document.URL);
    const snapshot = (revision: number) => ({
      status: 'ready' as const,
      products: [
        {
          id: 'stable-product',
          renderKey: 'stable-product',
          grantToken: `product-grant-${revision}`,
          title: '周期刷新视频',
          domain: 'bilibili.com',
          selectedQuality: '1080P · AVC',
          qualities: [
            {
              id: 'quality-1080-avc',
              token: `quality-grant-${revision}`,
              label: '1080P · AVC',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
            {
              id: 'quality-720-avc',
              token: `quality-720-grant-${revision}`,
              label: '720P · AVC',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
          ],
          options: [{ mode: 'complete' as const }, { mode: 'video' as const }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: revision + 1,
      pageIdentity,
    });
    controller.setResourceSnapshot(snapshot(0));

    const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const resolution = card.querySelector<HTMLElement>('[data-role="product-resolution"]')!;
    const trigger = resolution.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    trigger.click();
    const list = resolution.querySelector<HTMLElement>('[role="listbox"]')!;
    const focused = list.querySelector<HTMLButtonElement>('[data-value="720P"]')!;
    list.scrollTop = 23;
    focused.focus();

    for (let revision = 1; revision <= 50; revision += 1) {
      controller.setResourceSnapshot(snapshot(revision));
      expect(controller.shadowRoot.querySelector('.dock-product')).toBe(card);
      expect(resolution.querySelector('[role="listbox"]')).toBe(list);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(list.scrollTop).toBe(23);
      expect(controller.shadowRoot.activeElement).toBe(focused);
    }

    focused.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    card.querySelector<HTMLButtonElement>('[data-download-mode="video"]')!.click();
    await vi.waitFor(() =>
      expect(onDownload).toHaveBeenCalledWith('product-grant-50', 'video', 'quality-grant-50'),
    );

    controller.destroy();
    manager.stop();
  });

  it('keeps committed products through a same-generation temporary empty scan', () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const pageIdentity = siteMediaRouteKey(document.URL);
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'committed-product',
          renderKey: 'committed-product',
          grantToken: 'grant-before-scan',
          title: '已提交视频',
          domain: 'bilibili.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 1,
      pageIdentity,
    });
    const card = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;

    controller.setResourceSnapshot({
      status: 'loading',
      products: [],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 2,
      pageIdentity,
    });
    expect(controller.shadowRoot.querySelector('.dock-product')).toBe(card);
    expect(controller.shadowRoot.textContent).toContain('已提交视频');
    expect(
      controller.shadowRoot
        .querySelector('[data-role="regular-download-content"]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');

    controller.setResourceSnapshot({
      status: 'ready',
      products: [],
      navigationEpoch: 1,
      mediaEpoch: 1,
      sequence: 3,
      pageIdentity,
    });
    expect(card.isConnected).toBe(false);
    expect(controller.shadowRoot.textContent).toContain('暂未识别到可下载视频');

    controller.destroy();
    manager.stop();
  });

  it('drops stale finished products immediately when an SPA generation changes', () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'old-product',
          title: '旧视频',
          domain: 'youtube.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 1,
      pageIdentity: siteMediaRouteKey(document.URL),
    });
    const oldCard = controller.shadowRoot.querySelector<HTMLElement>('.dock-product')!;
    const oldMenuTrigger = oldCard.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    oldMenuTrigger.click();
    expect(oldMenuTrigger.getAttribute('aria-expanded')).toBe('true');

    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'new-generation-product',
          title: '新播放器视频',
          domain: 'youtube.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 2,
      pageIdentity: siteMediaRouteKey(document.URL),
    });
    expect(oldCard.isConnected).toBe(false);
    expect(controller.shadowRoot.textContent).toContain('新播放器视频');
    expect(
      controller.shadowRoot.querySelector('[aria-haspopup="menu"]')?.getAttribute('aria-expanded'),
    ).toBe('false');

    controller.clearResourceSnapshotForNavigation();
    expect(controller.shadowRoot.querySelector('.dock-product')).toBeNull();
    expect(
      controller.shadowRoot
        .querySelector('[data-role="regular-download-content"]')
        ?.getAttribute('aria-busy'),
    ).toBe('false');

    controller.destroy();
    manager.stop();
  });

  it('never lets an older generation or late push replace a newer GET snapshot', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const pageIdentity = siteMediaRouteKey(document.URL);
    const onResourceViewRequest = vi.fn(async () => {
      controller.setResourceSnapshot({
        status: 'ready',
        products: [
          {
            id: 'current-product',
            title: '当前视频',
            domain: 'bilibili.com',
            options: [{ mode: 'complete' }],
          },
        ],
        navigationEpoch: 2,
        mediaEpoch: 4,
        sequence: 12,
        pageIdentity,
      });
    });
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceViewRequest,
    });
    controller.resetForNavigation({ navigationEpoch: 2, mediaEpoch: 4, pageIdentity });
    controller.openResources();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledOnce());
    expect(controller.shadowRoot.textContent).toContain('当前视频');

    // Simulate an old background push arriving after the current GET completed.
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'late-old-push',
          title: '延迟旧视频',
          domain: 'bilibili.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 2,
      mediaEpoch: 4,
      sequence: 11,
      pageIdentity,
    });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'old-media-generation',
          title: '旧播放器视频',
          domain: 'bilibili.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 2,
      mediaEpoch: 3,
      sequence: 99,
      pageIdentity,
    });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'old-navigation-generation',
          title: '旧页面视频',
          domain: 'bilibili.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 99,
      sequence: 100,
      pageIdentity,
    });

    expect(controller.shadowRoot.textContent).toContain('当前视频');
    expect(controller.shadowRoot.textContent).not.toContain('延迟旧视频');
    expect(controller.shadowRoot.textContent).not.toContain('旧播放器视频');
    expect(controller.shadowRoot.textContent).not.toContain('旧页面视频');

    controller.destroy();
    manager.stop();
  });

  it('does not let an old request error overwrite a post-navigation snapshot', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    let rejectOldRequest!: (reason: Error) => void;
    const onResourceViewRequest = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOldRequest = reject;
        }),
    );
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceViewRequest,
    });
    const pageIdentity = siteMediaRouteKey(document.URL);
    controller.openResources();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledOnce());

    controller.resetForNavigation({ navigationEpoch: 1, mediaEpoch: 2, pageIdentity });
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'new-product',
          title: '导航后的新视频',
          domain: 'youtube.com',
          options: [{ mode: 'complete' }],
        },
      ],
      navigationEpoch: 1,
      mediaEpoch: 2,
      sequence: 2,
      pageIdentity,
    });
    rejectOldRequest(new Error('页面正在自动更新，旧请求已失效'));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.shadowRoot.textContent).toContain('导航后的新视频');
    expect(controller.shadowRoot.textContent).not.toContain('旧请求已失效');
    expect(
      controller.shadowRoot
        .querySelector('[data-role="regular-download-content"]')
        ?.getAttribute('aria-busy'),
    ).toBe('false');

    controller.destroy();
    manager.stop();
  });

  it('coalesces a forced manifest refresh while the current snapshot request is pending', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    let releaseFirstRequest!: () => void;
    const onResourceViewRequest = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstRequest = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceViewRequest,
    });

    controller.openResources();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledOnce());
    controller.refreshResources();
    controller.refreshResources();
    expect(onResourceViewRequest).toHaveBeenCalledTimes(1);

    releaseFirstRequest();
    await vi.waitFor(() => expect(onResourceViewRequest).toHaveBeenCalledTimes(2));
    expect(onResourceViewRequest).toHaveBeenLastCalledWith(true);

    controller.destroy();
    manager.stop();
  });

  it('keeps transient route errors loading and retries only a bounded number of times', async () => {
    vi.useFakeTimers();
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const onResourceViewRequest = vi.fn(async () => {
      throw new Error('stale 页面正在更新');
    });
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onResourceViewRequest,
    });
    controller.openResources();
    await Promise.resolve();
    await Promise.resolve();

    const content = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="regular-download-content"]',
    )!;
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(controller.shadowRoot.textContent).toContain('正在自动重试');

    await vi.runAllTimersAsync();
    expect(onResourceViewRequest).toHaveBeenCalledTimes(5);
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(controller.shadowRoot.textContent).toContain('等待下一次播放器事件');
    expect(controller.shadowRoot.textContent).not.toContain('更新失败');

    controller.destroy();
    manager.stop();
  });

  it('renders a URL-free merge task inside the shared Dock and dispatches path/download actions', async () => {
    document.title = '只保留视频标题';
    const video = makeControllableVideo();
    video.setAttribute('aria-label', '只保留视频标题');
    video.poster = 'https://images.example.test/merge-video-cover.jpg';
    const manager = new PlaybackManager(document);
    manager.start();
    const onMergeDockAction = vi.fn(async () => undefined);
    const onMergeDockPathModeChange = vi.fn(async () => undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onMergeDockAction,
      onMergeDockPathModeChange,
    });
    controller.openMerge({
      actionToken: 'opaque-action-token',
      pathToken: 'opaque-path-token',
      title: '只保留视频标题',
      state: 'ready',
      status: '轨道预检通过，可以安全合并。',
      progress: 0.25,
      savePath: 'Downloads/FoxFetch/Bilibili',
      pathMode: 'automatic',
      mergeEnabled: true,
      separateEnabled: true,
      busy: false,
    });

    expect(controller.getMode()).toBe('merge');
    expect(controller.host.dataset.mode).toBe('merge');
    expect(controller.shadowRoot.querySelector('[data-role="merge-title"]')?.textContent).toBe(
      '只保留视频标题',
    );
    expect(controller.shadowRoot.querySelector('[data-role="merge-path"]')?.textContent).toBe(
      'Downloads/FoxFetch/Bilibili',
    );
    expect(controller.shadowRoot.querySelector('.merge-meter')?.getAttribute('aria-valuenow')).toBe(
      '0',
    );
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-progress-label"]')?.textContent,
    ).toBe('0%');
    expect(controller.shadowRoot.textContent).toContain('总进度 0%');
    expect(controller.shadowRoot.querySelector('.merge-summary small')?.textContent).toBe('视频');
    expect(
      controller.shadowRoot.querySelector<HTMLImageElement>('.merge-summary-poster')?.src,
    ).toContain('/merge-video-cover.jpg');
    expect(controller.shadowRoot.textContent).not.toContain('下载 0–70%');
    expect(controller.shadowRoot.textContent).not.toContain('视频与音频正在并行下载');
    expect(controller.shadowRoot.querySelectorAll('[data-merge-action]')).toHaveLength(3);
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="merge-status"]')?.hidden,
    ).toBe(true);
    expect(controller.shadowRoot.querySelector('[data-role="merge-status"]')?.textContent).toBe('');
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state"]')?.getAttribute('data-state'),
    ).toBe('ready');
    expect(controller.shadowRoot.querySelector('[data-role="merge-state"]')?.textContent).toBe('');
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="merge-state-label"]')?.hidden,
    ).toBe(true);
    expect(controller.shadowRoot.querySelector('style')?.textContent).toContain(
      ':host([data-mode="merge"]) .view-tabs { display: none; }',
    );
    expect(controller.shadowRoot.textContent).not.toContain('https://');
    expect(controller.shadowRoot.innerHTML).not.toContain('opaque-action-token');
    expect(controller.shadowRoot.innerHTML).not.toContain('opaque-path-token');

    controller.shadowRoot
      .querySelector<HTMLButtonElement>('[data-merge-action="change-path"]')!
      .click();
    const pathPicker = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-path-picker"]',
    )!;
    expect(pathPicker.hidden).toBe(false);
    expect(onMergeDockPathModeChange).not.toHaveBeenCalled();
    pathPicker.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
    await vi.waitFor(() =>
      expect(onMergeDockPathModeChange).toHaveBeenCalledWith('opaque-path-token', 'ask'),
    );
    await vi.waitFor(() => expect(pathPicker.hidden).toBe(true));

    controller.setMergeSnapshot({
      actionToken: 'opaque-action-token',
      pathToken: 'opaque-custom-path-token',
      title: '只保留视频标题',
      state: 'ready',
      status: '轨道预检通过，可以安全合并。',
      progress: 0.25,
      savePath: 'D:/Videos/FoxFetch',
      pathMode: 'custom',
      saveLocationConfirmationRequired: false, // Historical target, current preference already migrated.
      mergeEnabled: true,
      separateEnabled: true,
      cancelEnabled: true,
      busy: false,
    });
    expect(controller.shadowRoot.querySelector('[data-role="merge-path"]')?.textContent).toBe(
      'D:/Videos/FoxFetch',
    );
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-path-action"]')?.textContent,
    ).toBe('更改位置');

    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-merge-action="merge"]')!.click();
    await vi.waitFor(() =>
      expect(onMergeDockAction).toHaveBeenCalledWith('opaque-action-token', 'merge'),
    );
    controller.shadowRoot.querySelector<HTMLButtonElement>('[data-merge-action="cancel"]')!.click();
    await vi.waitFor(() =>
      expect(onMergeDockAction).toHaveBeenCalledWith('opaque-action-token', 'cancel'),
    );

    controller.shadowRoot
      .querySelector<HTMLButtonElement>('[data-action="back-from-merge"]')!
      .click();
    // v0.12.1 ready tasks need no dialog, but must retire their background work.
    await vi.waitFor(() => expect(controller.getMode()).toBe('resources'));
    expect(onMergeDockAction).toHaveBeenCalledTimes(3);
    expect(onMergeDockAction).toHaveBeenLastCalledWith('opaque-action-token', 'cancel');
    controller.openMerge({
      actionToken: 'opaque-action-token',
      pathToken: 'opaque-custom-path-token',
      title: '只保留视频标题',
      state: 'ready',
      status: '轨道预检通过，可以安全合并。',
      progress: 0.25,
      savePath: 'D:/Videos/FoxFetch',
      pathMode: 'custom',
      mergeEnabled: true,
      separateEnabled: true,
      busy: false,
    });
    expect(controller.shadowRoot.querySelector('[data-role="merge-title"]')?.textContent).toBe(
      '只保留视频标题',
    );

    controller.destroy();
    manager.stop();
    document.title = '';
  });

  it('keeps save-location choice inside the merge panel and treats picker cancellation as no-op', async () => {
    makeControllableVideo();
    const manager = new PlaybackManager(document);
    manager.start();
    const onMergeDockPathModeChange = vi
      .fn<(_: string, __: 'automatic' | 'ask' | 'custom' | 'remembered') => Promise<void>>()
      .mockRejectedValueOnce(new DOMException('The user aborted a request.', 'AbortError'))
      .mockRejectedValueOnce(new Error('目录授权暂不可用'))
      .mockResolvedValue(undefined);
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
      onMergeDockPathModeChange,
    });
    controller.openMerge({
      actionToken: 'merge-token',
      pathToken: 'path-token',
      title: '目录选择测试',
      state: 'ready',
      status: '可以下载',
      progress: 0,
      savePath: 'Downloads/FoxFetch/Bilibili',
      pathMode: 'automatic',
      mergeEnabled: true,
      separateEnabled: true,
      busy: false,
    });

    const pathCard = controller.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-merge-action="change-path"]',
    )!;
    const picker = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-path-picker"]',
    )!;
    pathCard.click();
    expect(picker.hidden).toBe(false);
    expect(picker.querySelector('[data-path-mode="automatic"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    picker.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
    await vi.waitFor(() => expect(onMergeDockPathModeChange).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(picker.hidden).toBe(true));
    expect(controller.shadowRoot.querySelector('[data-role="merge-status"]')?.textContent).toBe('');

    pathCard.click();
    picker.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!.click();
    await vi.waitFor(() => expect(onMergeDockPathModeChange).toHaveBeenCalledTimes(2));
    const pickerError = controller.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-status"]',
    )!;
    await vi.waitFor(() => expect(pickerError.hidden).toBe(false));
    expect(pickerError.textContent).toBe('目录授权暂不可用');
    expect(picker.hidden).toBe(true);
    picker.querySelector<HTMLButtonElement>('[data-action="cancel-merge-path"]')!.click();
    expect(picker.hidden).toBe(true);

    pathCard.click();
    picker.querySelector<HTMLButtonElement>('[data-path-mode="automatic"]')!.click();
    await vi.waitFor(() =>
      expect(onMergeDockPathModeChange).toHaveBeenLastCalledWith('path-token', 'automatic'),
    );
    expect(onMergeDockPathModeChange).not.toHaveBeenCalledWith('path-token', 'custom');

    controller.destroy();
    manager.stop();
  });

  it('renders indeterminate downloads and smoothly switches the progress treatment for merging', () => {
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager, {
      playback: { showController: true },
    });
    const base = {
      actionToken: 'action',
      pathToken: 'path',
      title: '视频标题',
      state: 'running' as const,
      savePath: 'Downloads/FoxFetch/Bilibili',
      pathMode: 'automatic' as const,
      mergeEnabled: false,
      separateEnabled: false,
      busy: true,
    };

    controller.openMerge({
      ...base,
      phase: 'fetching',
      status: '已下载 52.3 MB',
      progress: null,
    });
    const meter = controller.shadowRoot.querySelector<HTMLElement>('.merge-meter')!;
    expect(meter.dataset.indeterminate).toBe('true');
    expect(meter.hasAttribute('aria-valuenow')).toBe(false);
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-progress-label"]')?.textContent,
    ).toBe('--');
    expect(controller.host.dataset.mergeStage).toBe('download');
    expect(controller.shadowRoot.querySelector('[data-merge-action="merge"]')?.textContent).toBe(
      '下载',
    );

    controller.setMergeSnapshot({
      ...base,
      phase: 'muxing',
      status: '合并中 · 已处理 50%',
      progress: 0.82,
    });
    expect(meter.dataset.indeterminate).toBeUndefined();
    expect(meter.getAttribute('aria-valuenow')).toBe('82');
    expect(controller.host.dataset.mergeStage).toBe('merge');
    expect(controller.shadowRoot.querySelector('[data-merge-action="merge"]')?.textContent).toBe(
      '下载',
    );
    expect(controller.shadowRoot.textContent).toContain('总进度 82%');
    expect(controller.shadowRoot.querySelector('[data-role="merge-status"]')?.textContent).toBe('');
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="merge-status"]')?.hidden,
    ).toBe(true);
    expect(controller.shadowRoot.querySelector('[data-role="panel-status"]')?.textContent).toBe('');
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state"]')?.getAttribute('data-state'),
    ).toBe('loading');

    const progressElement = controller.shadowRoot.querySelector('.merge-meter')!;
    const detailElement = controller.shadowRoot.querySelector('[data-role="merge-status"]')!;
    expect(
      progressElement.compareDocumentPosition(detailElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    controller.setMergeSnapshot({
      ...base,
      state: 'failed',
      status: '合并失败',
      error: '媒体轨道已失效',
      progress: 0.82,
      busy: false,
    });
    expect(detailElement.textContent).toBe('媒体轨道已失效');
    expect((detailElement as HTMLElement).hidden).toBe(false);
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="merge-state-label"]')?.hidden,
    ).toBe(false);
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state"]')?.getAttribute('data-state'),
    ).toBe('error');

    controller.setMergeSnapshot({
      ...base,
      state: 'completed',
      status: '合并文件已保存并验证完成',
      progress: 1,
      busy: false,
    });
    expect(controller.shadowRoot.querySelector('[data-role="merge-title"]')?.textContent).toBe(
      '视频标题',
    );
    expect((detailElement as HTMLElement).hidden).toBe(true);
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state"]')?.getAttribute('data-state'),
    ).toBe('ready');
    expect(
      controller.shadowRoot.querySelector('[data-role="merge-state-label"]')?.textContent,
    ).toBe('保存成功');
    expect(
      controller.shadowRoot.querySelector<HTMLElement>('[data-role="merge-state-label"]')?.hidden,
    ).toBe(false);

    controller.destroy();
    manager.stop();
  });
});
