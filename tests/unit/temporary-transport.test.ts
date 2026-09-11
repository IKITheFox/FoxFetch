import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackManager } from '../../src/modules/playback/playback-manager';
import { TemporaryTransport } from '../../src/modules/playback/temporary-transport';

const managers: PlaybackManager[] = [];
const sessions: TemporaryTransport[] = [];
const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');

function ranges(...items: Array<[number, number]>): TimeRanges {
  return {
    length: items.length,
    start: (index) => items[index]![0],
    end: (index) => items[index]![1],
  };
}

function createMedia({ rate = 1.5, paused = false } = {}): HTMLVideoElement {
  const media = document.createElement('video');
  media.src = '/movie.mp4';
  Object.defineProperties(media, {
    paused: { configurable: true, writable: true, value: paused },
    ended: { configurable: true, writable: true, value: false },
    seeking: { configurable: true, writable: true, value: false },
    currentTime: { configurable: true, writable: true, value: 20 },
    duration: { configurable: true, writable: true, value: 100 },
    playbackRate: { configurable: true, writable: true, value: rate },
    defaultPlaybackRate: { configurable: true, writable: true, value: rate },
    seekable: { configurable: true, value: ranges([0, 100]) },
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
  return media;
}

function manager(settings = {}): PlaybackManager {
  const result = new PlaybackManager(document, { settings });
  managers.push(result);
  result.start();
  return result;
}

function lease(
  media: HTMLMediaElement,
  direction: 'forward' | 'backward',
  isCurrent = () => true,
  now?: () => number,
): TemporaryTransport {
  const result = new TemporaryTransport(media, direction, { isCurrent, ...(now ? { now } : {}) });
  sessions.push(result);
  return result;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.end({ restore: false });
  for (const value of managers.splice(0)) value.stop();
  document.body.replaceChildren();
  if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
  else Reflect.deleteProperty(document, 'URL');
  vi.useRealTimers();
});

describe('temporary playback transport', () => {
  it('uses fixed 3x, suspends lock correction and restores the actual rate without changing defaults', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    const value = manager({ defaultRate: 1.5, lockRate: true });
    const id = value.getMediaElements()[0]!.elementId;
    expect(await value.beginTemporaryTransport('forward', id)).toEqual({ applied: true });
    expect(media.playbackRate).toBe(3);
    media.dispatchEvent(new Event('ratechange'));
    await vi.advanceTimersByTimeAsync(100);
    expect(media.playbackRate).toBe(3);
    expect(media.defaultPlaybackRate).toBe(1.5);
    expect(value.getSettings().defaultRate).toBe(1.5);
    await value.endTemporaryTransport();
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(false);
    expect(value.hasTemporaryTransport()).toBe(false);
    await value.execute({ action: 'adjustRate', delta: 0.25 }, id);
    expect(media.playbackRate).toBe(1.75);
  });

  it('cancels an already queued lock correction before claiming temporary rate', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    const value = manager({ defaultRate: 1.5, lockRate: true });
    media.playbackRate = 2;
    media.dispatchEvent(new Event('ratechange'));
    await value.beginTemporaryTransport('forward');
    await vi.advanceTimersByTimeAsync(1);
    expect(media.playbackRate).toBe(3);
    await value.endTemporaryTransport();
    expect(media.playbackRate).toBe(2);
    expect(media.defaultPlaybackRate).toBe(1.5);
  });

  it('restores paused state and cannot be revived by a late begin play promise', async () => {
    const media = createMedia({ paused: true });
    let finishPlay: (() => void) | undefined;
    media.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPlay = resolve;
        }),
    );
    const value = manager();
    const pending = value.beginTemporaryTransport('forward');
    expect(value.hasTemporaryTransport()).toBe(true);
    expect(media.playbackRate).toBe(3);
    await value.endTemporaryTransport();
    await value.execute({ action: 'setRate', rate: 2 });
    finishPlay?.();
    expect((await pending).applied).toBe(false);
    expect(media.playbackRate).toBe(2);
    expect(media.paused).toBe(true);
    expect(value.hasTemporaryTransport()).toBe(false);
  });

  it('a new slider command wins immediately and desired rate remains separate', async () => {
    const media = createMedia();
    const value = manager();
    await value.beginTemporaryTransport('forward');
    await value.execute({ action: 'setRate', rate: 2.25 });
    expect(media.playbackRate).toBe(2.25);
    expect(value.hasTemporaryTransport()).toBe(false);
    await value.endTemporaryTransport();
    expect(media.playbackRate).toBe(2.25);
  });

  it('reverse uses wall-clock distance, coalesces pending seeks and restores playing state', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    let wallClock = 0;
    const session = lease(
      media,
      'backward',
      () => true,
      () => wallClock,
    );
    expect(await session.start()).toEqual({ applied: true });
    expect(media.paused).toBe(true);
    expect(media.playbackRate).toBe(1.5);
    await media.play();
    expect(media.paused).toBe(true);
    Object.defineProperty(media, 'seeking', { value: true });
    wallClock = 900;
    await vi.advanceTimersByTimeAsync(100);
    expect(media.currentTime).toBe(20);
    Object.defineProperty(media, 'seeking', { value: false });
    wallClock = 1_500;
    await vi.advanceTimersByTimeAsync(100);
    expect(media.currentTime).toBe(15.5);
    wallClock = 1_600;
    media.dispatchEvent(new Event('timeupdate'));
    expect(media.currentTime).toBe(15.5);
    session.end();
    expect(media.paused).toBe(false);
    expect(media.playbackRate).toBe(1.5);
  });

  it('reverse does not cross seekable gaps and stays paused at its range boundary', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    Object.defineProperty(media, 'seekable', { value: ranges([0, 5], [10, 100]) });
    let wallClock = 0;
    const session = lease(
      media,
      'backward',
      () => true,
      () => wallClock,
    );
    await session.start();
    wallClock = 10_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(media.currentTime).toBe(10);
    session.end();
    expect(media.paused).toBe(true);
  });

  it('refuses reverse without a legal seekable range without altering playback', async () => {
    const media = createMedia();
    Object.defineProperty(media, 'seekable', { value: ranges() });
    const value = manager();
    expect((await value.beginTemporaryTransport('backward')).applied).toBe(false);
    expect(media.paused).toBe(false);
    expect(value.hasTemporaryTransport()).toBe(false);
  });

  it('stops before the duration and blocks ended/play attempts while held', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    const session = lease(media, 'forward');
    await session.start();
    media.currentTime = 99.9;
    await vi.advanceTimersByTimeAsync(50);
    expect(media.paused).toBe(true);
    const nextVideo = vi.fn();
    media.addEventListener('ended', nextVideo);
    media.dispatchEvent(new Event('ended'));
    expect(nextVideo).not.toHaveBeenCalled();
    await media.play();
    expect(media.paused).toBe(true);
    session.end();
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
  });

  it('does not restore rate/paused into a new source reusing the same DOM node', async () => {
    const media = createMedia();
    const value = manager();
    await value.beginTemporaryTransport('forward');
    media.src = '/new-movie.mp4';
    media.playbackRate = 1.25;
    Object.defineProperty(media, 'paused', { value: true });
    media.dispatchEvent(new Event('emptied'));
    await value.endTemporaryTransport();
    expect(media.playbackRate).toBe(1.25);
    expect(media.paused).toBe(true);
    expect(value.hasTemporaryTransport()).toBe(false);
  });

  it('invalidates on an identity route change even before polling discovers new DOM', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'URL', {
      configurable: true,
      value: 'https://www.bilibili.com/video/BV1CURRENT1/',
    });
    const media = createMedia();
    const value = manager();
    await value.beginTemporaryTransport('forward');
    Object.defineProperty(document, 'URL', {
      configurable: true,
      value: 'https://www.bilibili.com/video/BV1CURRENT1/?p=2',
    });
    media.playbackRate = 1.25;
    await vi.advanceTimersByTimeAsync(60);
    expect(value.hasTemporaryTransport()).toBe(false);
    expect(media.playbackRate).toBe(1.25);
  });

  it('play rejection restores state and releases the lease', async () => {
    const media = createMedia({ paused: true });
    media.play = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const value = manager();
    expect((await value.beginTemporaryTransport('forward')).applied).toBe(false);
    expect(media.playbackRate).toBe(1.5);
    expect(media.paused).toBe(true);
    expect(value.hasTemporaryTransport()).toBe(false);
  });

  it('does not claim forward playback started when a site/terminal guard keeps it paused', async () => {
    const media = createMedia({ paused: true });
    media.play = vi.fn(async () => undefined);
    const value = manager();
    const result = await value.beginTemporaryTransport('forward');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('暂停');
    expect(media.playbackRate).toBe(1.5);
    expect(value.hasTemporaryTransport()).toBe(false);
  });

  it('stopping the manager restores the same player and removes all transport work', async () => {
    vi.useFakeTimers();
    const media = createMedia();
    const value = manager();
    await value.beginTemporaryTransport('forward');
    value.stop();
    expect(media.playbackRate).toBe(1.5);
    expect(value.hasTemporaryTransport()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(media.playbackRate).toBe(1.5);
  });
});
