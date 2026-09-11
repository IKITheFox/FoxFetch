import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaElementInfo } from '../../src/shared/types';
import {
  isMainMediaAtBeginning,
  isRestartTargetReset,
  pollRestartAtBeginning,
  selectRestartTarget,
} from '../../src/modules/playback/restart-target';

function media(elementId: string, overrides: Partial<MediaElementInfo> = {}): MediaElementInfo {
  return {
    elementId,
    lifecycleGeneration: 1,
    frameId: 0,
    kind: 'video',
    title: elementId,
    currentTime: 20,
    playbackRate: 1,
    volume: 1,
    paused: true,
    visibleArea: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe('media-agent restart target', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rewinds the largest visible video instead of a newer small player or audio', () => {
    const mainVideo = media('main-video', { visibleArea: 720_000, lastActiveAt: 10 });
    const smallPlayingVideo = media('small-video', {
      visibleArea: 40_000,
      lastActiveAt: 100,
      paused: false,
    });
    const audio = media('audio', {
      kind: 'audio',
      visibleArea: 900_000,
      lastActiveAt: 200,
      paused: false,
    });

    expect(selectRestartTarget([smallPlayingVideo, audio, mainVideo])?.elementId).toBe(
      'main-video',
    );
  });

  it('falls back to playback activity when videos have no visible area', () => {
    const stale = media('stale', { lastActiveAt: 100 });
    const playing = media('playing', { lastActiveAt: 10, paused: false });

    expect(selectRestartTarget([stale, playing])?.elementId).toBe('playing');
  });

  it('accepts audio only when no video is present', () => {
    expect(
      selectRestartTarget([
        media('audio-a', { kind: 'audio', visibleArea: 100 }),
        media('audio-b', { kind: 'audio', visibleArea: 200 }),
      ])?.elementId,
    ).toBe('audio-b');
  });

  it('confirms reset only for the selected paused target near zero', () => {
    expect(isRestartTargetReset([media('main', { currentTime: 0.1 })], 'main')).toBe(true);
    expect(isRestartTargetReset([media('main', { currentTime: 0.1, paused: false })], 'main')).toBe(
      false,
    );
    expect(isRestartTargetReset([media('main', { currentTime: 0.5 })], 'main')).toBe(false);
    expect(isRestartTargetReset([media('other', { currentTime: 0 })], 'main')).toBe(false);
  });

  it('recognizes a manual capture that starts with the main video near zero', () => {
    expect(
      isMainMediaAtBeginning([
        media('small-ad', { currentTime: 20, visibleArea: 20_000 }),
        media('main', { currentTime: 0.2, paused: false, visibleArea: 500_000 }),
      ]),
    ).toBe(true);
    expect(
      isMainMediaAtBeginning([
        media('small-ad', { currentTime: 0, visibleArea: 20_000 }),
        media('main', { currentTime: 1, visibleArea: 500_000 }),
      ]),
    ).toBe(false);
  });

  it('rewinds a player that mounts late and reports it only after a stable window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let elements: MediaElementInfo[] = [];
    const onStableReset = vi.fn();
    const onTimeout = vi.fn();
    const seek = vi.fn(async (elementId: string) => {
      elements = [media(elementId, { currentTime: 0, paused: true, visibleArea: 500_000 })];
      return true;
    });

    pollRestartAtBeginning({
      getElements: () => elements,
      refresh: () => {
        if (Date.now() >= 900 && elements.length === 0) {
          elements = [media('late-video', { paused: false, visibleArea: 500_000 })];
        }
      },
      seek,
      isCurrent: () => true,
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        setTimeout(callback, delayMs);
      },
      onStableReset,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(seek).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(seek).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledWith('late-video');
    expect(onStableReset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_499);
    expect(onStableReset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStableReset).toHaveBeenCalledOnce();
    expect(onStableReset).toHaveBeenCalledWith('late-video');
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pulls the player back when the site restores watch history after the first rewind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let elements = [media('main', { paused: false, visibleArea: 500_000 })];
    const onStableReset = vi.fn();
    const seek = vi.fn(async (elementId: string) => {
      elements = [media(elementId, { currentTime: 0, paused: true, visibleArea: 500_000 })];
      return true;
    });

    pollRestartAtBeginning({
      getElements: () => elements,
      refresh: vi.fn(),
      seek,
      isCurrent: () => true,
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        setTimeout(callback, delayMs);
      },
      onStableReset,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(seek).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    elements = [media('main', { currentTime: 87, paused: false, visibleArea: 500_000 })];
    await vi.advanceTimersByTimeAsync(250);
    expect(seek).toHaveBeenCalledTimes(2);
    expect(onStableReset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_499);
    expect(onStableReset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStableReset).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never guards beyond the hard timeout and an old generation cannot seek', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let current = true;
    const seek = vi.fn(async () => false);
    const onTimeout = vi.fn();
    const onStableReset = vi.fn();

    pollRestartAtBeginning({
      getElements: () => [media('main', { currentTime: 50, paused: false })],
      refresh: vi.fn(),
      seek,
      onTimeout,
      onStableReset,
      isCurrent: () => current,
      now: () => Date.now(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    current = false;
    const callsAtCancellation = seek.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seek).toHaveBeenCalledTimes(callsAtCancellation);
    expect(onStableReset).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('stops retrying at the twelve-second hard deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seek = vi.fn(async () => false);
    const onTimeout = vi.fn();

    pollRestartAtBeginning({
      getElements: () => [media('main', { currentTime: 50, paused: false })],
      refresh: vi.fn(),
      seek,
      onTimeout,
      isCurrent: () => true,
      now: () => Date.now(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    });

    await vi.advanceTimersByTimeAsync(11_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).toHaveBeenCalledOnce();
    const callsAtDeadline = seek.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seek).toHaveBeenCalledTimes(callsAtDeadline);
  });
});
