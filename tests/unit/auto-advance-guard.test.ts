import { describe, expect, it, vi } from 'vitest';

import {
  createAutoAdvanceGuard,
  type AutoAdvanceMediaBinding,
} from '../../src/modules/playback/auto-advance-guard';

function mediaBinding(
  elementId = 'video-1',
  lifecycleGeneration = 1,
): AutoAdvanceMediaBinding & { pause: ReturnType<typeof vi.fn> } {
  const element = document.createElement('video');
  const pause = vi.fn();
  Object.defineProperty(element, 'pause', { configurable: true, value: pause });
  Object.defineProperty(element, 'duration', { configurable: true, value: 100 });
  return { element, elementId, lifecycleGeneration, pause };
}

describe('AutoAdvanceGuard', () => {
  it('is independently enabled by default and disables autoplay as soon as it arms', () => {
    const binding = mediaBinding();
    binding.element.autoplay = true;
    const guard = createAutoAdvanceGuard(binding);

    expect(guard.getSnapshot()).toMatchObject({ state: 'idle', enabled: true });
    expect(guard.arm()).toMatchObject({
      state: 'armed',
      elementId: 'video-1',
      lifecycleGeneration: 1,
    });
    expect(binding.element.autoplay).toBe(false);
    expect(binding.pause).not.toHaveBeenCalled();
  });

  it('does not pause an incomplete final segment at 10x and locks on ended', () => {
    const binding = mediaBinding();
    const guard = createAutoAdvanceGuard(binding);
    binding.element.playbackRate = 10;
    guard.arm();

    Object.defineProperty(binding.element, 'currentTime', { configurable: true, value: 98.8 });
    binding.element.dispatchEvent(new Event('timeupdate'));

    expect(guard.getSnapshot()).toMatchObject({ state: 'armed' });
    expect(binding.pause).not.toHaveBeenCalled();

    binding.element.dispatchEvent(new Event('ended'));
    expect(guard.getSnapshot()).toMatchObject({
      state: 'terminal-lock',
      terminalReason: 'ended',
    });
    expect(binding.pause).toHaveBeenCalledOnce();
  });

  it('keeps autoplay suppressed on durationchange and progress without pausing', () => {
    for (const eventName of ['durationchange', 'progress']) {
      const binding = mediaBinding(`video-${eventName}`);
      const guard = createAutoAdvanceGuard(binding);
      guard.arm();
      binding.element.autoplay = true;
      Object.defineProperty(binding.element, 'currentTime', { configurable: true, value: 99 });

      binding.element.dispatchEvent(new Event(eventName));

      expect(guard.getSnapshot()).toMatchObject({ state: 'armed' });
      expect(binding.element.autoplay).toBe(false);
      expect(binding.pause).not.toHaveBeenCalled();
    }
  });

  it('locks only after cache completion and blocks ended/play/playing attempts', () => {
    const binding = mediaBinding();
    binding.element.autoplay = true;
    const pageEnded = vi.fn();
    binding.element.addEventListener('ended', pageEnded);
    const guard = createAutoAdvanceGuard(binding);
    guard.arm();

    expect(guard.observe({ cacheComplete: false })).toMatchObject({ state: 'armed' });
    expect(binding.pause).not.toHaveBeenCalled();
    expect(guard.observe({ cacheComplete: true })).toMatchObject({
      state: 'terminal-lock',
      terminalReason: 'cache-complete',
    });
    expect(binding.element.autoplay).toBe(false);

    binding.element.dispatchEvent(new Event('ended', { cancelable: true, bubbles: true }));
    binding.element.dispatchEvent(new Event('play', { cancelable: true, bubbles: true }));
    binding.element.dispatchEvent(new Event('playing', { cancelable: true, bubbles: true }));

    expect(binding.pause).toHaveBeenCalledTimes(4);
    expect(pageEnded).not.toHaveBeenCalled();
  });

  it('uses cache completion as a terminal lock even without duration metadata', () => {
    const binding = mediaBinding();
    Object.defineProperty(binding.element, 'duration', { configurable: true, value: Number.NaN });
    const guard = createAutoAdvanceGuard(binding);
    guard.arm();

    expect(guard.observe({ cacheComplete: true })).toMatchObject({
      state: 'terminal-lock',
      terminalReason: 'cache-complete',
    });
    expect(binding.pause).toHaveBeenCalledOnce();
  });

  it('enters terminal lock when ended arrives before a progress observation', () => {
    const binding = mediaBinding();
    const guard = createAutoAdvanceGuard(binding);
    guard.arm();

    binding.element.dispatchEvent(new Event('ended', { cancelable: true }));

    expect(guard.getSnapshot()).toMatchObject({
      state: 'terminal-lock',
      terminalReason: 'ended',
    });
  });

  it('restores the target autoplay value and releases idempotently', () => {
    const binding = mediaBinding();
    const unrelated = mediaBinding('video-2', 8);
    binding.element.autoplay = true;
    unrelated.element.autoplay = true;
    const guard = createAutoAdvanceGuard(binding);
    guard.arm();
    guard.observe({ cacheComplete: true });

    expect(guard.release()).toMatchObject({ state: 'released' });
    expect(guard.release()).toMatchObject({ state: 'released' });
    expect(binding.element.autoplay).toBe(true);
    expect(unrelated.element.autoplay).toBe(true);

    binding.element.dispatchEvent(new Event('play'));
    unrelated.element.dispatchEvent(new Event('play'));
    expect(binding.pause).toHaveBeenCalledOnce();
    expect(unrelated.pause).not.toHaveBeenCalled();
  });

  it('binds to both the element and lifecycle generation', () => {
    const binding = mediaBinding('stable-element', 4);
    const guard = createAutoAdvanceGuard(binding);

    expect(guard.isBoundTo(binding)).toBe(true);
    expect(guard.isBoundTo({ ...binding, lifecycleGeneration: 5 })).toBe(false);
    expect(guard.isBoundTo({ ...mediaBinding('stable-element', 4) })).toBe(false);
  });

  it('can be independently disabled and restores autoplay before returning idle', () => {
    const binding = mediaBinding();
    binding.element.autoplay = true;
    const guard = createAutoAdvanceGuard(binding);
    guard.arm();
    guard.observe({ cacheComplete: true });

    expect(guard.setEnabled(false)).toMatchObject({ state: 'idle', enabled: false });
    expect(binding.element.autoplay).toBe(true);
    binding.element.dispatchEvent(new Event('playing'));
    expect(binding.pause).toHaveBeenCalledOnce();

    guard.setEnabled(true);
    expect(guard.arm()).toMatchObject({ state: 'armed', enabled: true });
  });
});
