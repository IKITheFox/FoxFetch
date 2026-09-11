import { afterEach, expect, it, vi } from 'vitest';
import { FloatingPlaybackController, PlaybackManager } from '../../src/modules/playback';
import { setLanguage } from '../../src/shared/i18n';
let controller: FloatingPlaybackController | undefined;
let manager: PlaybackManager | undefined;
afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  setLanguage('zh-CN');
  vi.restoreAllMocks();
});
it('updates the open header, rate, ended state and true muted state from snapshots', () => {
  const video = document.createElement('video');
  video.src = 'https://example.test/test.mp4';
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    positionStore: { get: async () => ({}), set: async () => undefined },
  });
  controller.openPlayback();
  setLanguage('en');
  const original = manager.getMediaElements()[0]!;
  const header = () =>
    controller!.shadowRoot.querySelector('[data-role="panel-status"]')!.textContent;
  const mute = () => controller!.shadowRoot.querySelector('[data-role="mute-label"]')!.textContent;
  controller.update([{ ...original, paused: false, playbackRate: 1.5, muted: false, volume: 0 }]);
  expect(header()).toBe('1.5× · Playing');
  expect(mute()).toBe('Mute');
  controller.update([{ ...original, paused: true, muted: true, volume: 1 }]);
  expect(header()).toContain('Paused');
  expect(mute()).toBe('Unmute');
  controller.update([{ ...original, ended: true }]);
  expect(header()).toContain('Ended');
});
it('relocalizes an already visible navigation error without altering its source message', () => {
  const video = document.createElement('video');
  video.src = 'https://example.test/test.mp4';
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    positionStore: { get: async () => ({}), set: async () => undefined },
  });
  controller.openPlayback();
  (controller as unknown as { setPlaybackError(message: string): void }).setPlaybackError(
    '此站点或页面尚无可靠的上一／下一视频导航支持。',
  );
  setLanguage('en');
  expect(controller.shadowRoot.querySelector('[data-role="playback-error"]')!.textContent).toBe(
    'Reliable previous/next video navigation is not supported on this site or page.',
  );
});
