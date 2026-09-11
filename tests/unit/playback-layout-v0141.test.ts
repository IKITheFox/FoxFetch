import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackManager } from '../../src/modules/playback/playback-manager';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('asynchronous playback geometry', () => {
  it('does not force page layout from snapshots and retains observed geometry', () => {
    let deliver: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          deliver = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const video = document.createElement('video');
    video.src = '/video.mp4';
    video.setAttribute('poster', '/cover.jpg');
    const layout = vi.spyOn(video, 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('Layout must not be forced');
    });
    Object.defineProperty(video, 'poster', {
      get() {
        throw new Error('Use raw attribute');
      },
    });
    document.body.append(video);
    const manager = new PlaybackManager(document);
    try {
      expect(manager.start()[0]?.visibleArea).toBe(0);
      expect(observe).toHaveBeenCalledWith(video);
      deliver?.(
        [
          {
            target: video,
            isIntersecting: true,
            boundingClientRect: { width: 640, height: 360 },
            intersectionRect: { width: 640, height: 180 },
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      expect(manager.getMediaElements()[0]).toMatchObject({
        width: 640,
        height: 360,
        visibleArea: 115200,
      });
      expect(layout).not.toHaveBeenCalled();
      video.remove();
      manager.refresh();
      expect(unobserve).toHaveBeenCalledWith(video);
    } finally {
      manager.stop();
    }
    expect(disconnect).toHaveBeenCalled();
  });
});
