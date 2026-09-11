import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingPlaybackController } from '../../src/modules/playback/floating-controller';
import { PlaybackManager } from '../../src/modules/playback/playback-manager';

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
let media: HTMLVideoElement;
const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  media = document.createElement('video');
  media.src = '/movie.mp4';
  Object.defineProperties(media, {
    paused: { configurable: true, writable: true, value: true },
    currentTime: { configurable: true, writable: true, value: 40 },
    duration: { configurable: true, writable: true, value: 100 },
    playbackRate: { configurable: true, writable: true, value: 1.5 },
    defaultPlaybackRate: { configurable: true, writable: true, value: 1.5 },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 100 } },
  });
  media.play = vi.fn(async () => {
    Object.defineProperty(media, 'paused', { value: false });
    media.dispatchEvent(new Event('play'));
  });
  media.pause = vi.fn(() => {
    Object.defineProperty(media, 'paused', { value: true });
    media.dispatchEvent(new Event('pause'));
  });
  document.body.append(media);
  manager = new PlaybackManager(document, { onChange: (elements) => controller?.update(elements) });
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    playback: { showController: true },
  });
  controller.openPlayback();
});

afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
  if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight);
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else Reflect.deleteProperty(document, 'visibilityState');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function button(direction: 'forward' | 'back'): HTMLButtonElement {
  return controller.shadowRoot.querySelector<HTMLButtonElement>(
    `[data-media-action="seek-${direction}"]`,
  )!;
}

function pointer(target: EventTarget, type: string, pointerId = 1): void {
  target.dispatchEvent(
    new TestPointerEvent(type, { bubbles: true, composed: true, button: 0, pointerId }),
  );
}

describe('floating gesture independent integration review', () => {
  it('does one 15s seek for pointerup plus the browser follow-up click', () => {
    const control = button('forward');
    pointer(control, 'pointerdown');
    pointer(control, 'pointerup');
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 1 }));
    expect(media.currentTime).toBe(55);
  });

  it('cancellation before 350ms neither begins a hold nor triggers a synthetic follow-up click', async () => {
    const control = button('forward');
    pointer(control, 'pointerdown');
    await vi.advanceTimersByTimeAsync(200);
    pointer(control, 'pointercancel');
    await vi.advanceTimersByTimeAsync(500);
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(media.currentTime).toBe(40);
    expect(media.playbackRate).toBe(1.5);
    expect(manager.hasTemporaryTransport()).toBe(false);
  });

  it('an unrelated pointer release cannot terminate the held pointer lease', async () => {
    const control = button('forward');
    pointer(control, 'pointerdown', 7);
    await vi.advanceTimersByTimeAsync(350);
    expect(media.playbackRate).toBe(3);
    pointer(window, 'pointerup', 8);
    expect(manager.hasTemporaryTransport()).toBe(true);
    pointer(window, 'pointerup', 7);
    expect(manager.hasTemporaryTransport()).toBe(false);
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(40);
  });

  it('keyboard activation remains usable after a cancelled pointer gesture', () => {
    const control = button('back');
    pointer(control, 'pointerdown');
    pointer(control, 'pointercancel');
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(media.currentTime).toBe(25);
  });

  it('window blur restores rate and prevents delayed tooltip/hold side effects', async () => {
    const control = button('forward');
    pointer(control, 'pointerover');
    pointer(control, 'pointerdown');
    await vi.advanceTimersByTimeAsync(350);
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1_700);
    expect(media.playbackRate).toBe(1.5);
    expect(manager.hasTemporaryTransport()).toBe(false);
    expect(controller.shadowRoot.querySelector<HTMLElement>('.transport-tooltip')!.hidden).toBe(
      true,
    );
  });

  it('suppression ends a live transport before hiding the dock', async () => {
    const control = button('forward');
    pointer(control, 'pointerdown');
    await vi.advanceTimersByTimeAsync(350);
    controller.suppress(true);
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
    expect(manager.hasTemporaryTransport()).toBe(false);
    expect(controller.host.hidden).toBe(true);
  });

  it('lostpointercapture cancels an active hold and cannot add a release-click seek', async () => {
    const control = button('forward');
    pointer(control, 'pointerdown', 9);
    await vi.advanceTimersByTimeAsync(350);
    expect(media.playbackRate).toBe(3);
    pointer(control, 'lostpointercapture', 9);
    await vi.advanceTimersByTimeAsync(500);
    pointer(control, 'pointerup', 9);
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(40);
    expect(manager.hasTemporaryTransport()).toBe(false);
    expect(control.hasAttribute('data-holding')).toBe(false);
  });

  it('visibility hidden immediately ends active transport and clears a pending tooltip', async () => {
    const control = button('forward');
    pointer(control, 'pointerover');
    pointer(control, 'pointerdown');
    await vi.advanceTimersByTimeAsync(350);
    expect(media.playbackRate).toBe(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
    expect(manager.hasTemporaryTransport()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_700);
    expect(media.currentTime).toBe(40);
    expect(controller.shadowRoot.querySelector<HTMLElement>('.transport-tooltip')!.hidden).toBe(
      true,
    );
  });

  it.each([
    { label: 'left edge', edge: 'left' as const, xRatio: 0.01, expectedX: 10 },
    { label: 'right edge', edge: 'right' as const, xRatio: 0.99, expectedX: 1138 },
    { label: 'intentional free position', edge: 'right' as const, xRatio: 0.42, expectedX: 482 },
  ])(
    'migrates a versionless v1 $label and preserves it across shrink/restore',
    async ({ edge, xRatio, expectedX }) => {
      controller.destroy();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 850 });
      const key = `foxfetch:media-dock-position:${document.location.origin}`;
      const set = vi.fn(async () => undefined);
      controller = new FloatingPlaybackController(document, manager, {
        playback: { showController: true },
        positionStore: {
          get: async () => ({ [key]: { edge, xRatio, yRatio: 0.62 } }),
          set,
        },
      });
      await Promise.resolve();
      controller.collapse();
      const launcher = controller.shadowRoot.querySelector<HTMLElement>('.launcher')!;
      expect(launcher.style.left).toBe(`${expectedX}px`);
      expect(launcher.style.top).toBe('495px');
      controller.suppress();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
      window.dispatchEvent(new Event('resize'));
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
      window.dispatchEvent(new Event('resize'));
      controller.suppress(false);
      expect(launcher.style.left).toBe(`${expectedX}px`);
      expect(launcher.style.top).toBe('495px');
      // Migration and viewport clamping do not overwrite stored user intent.
      expect(set).not.toHaveBeenCalled();
    },
  );
});
