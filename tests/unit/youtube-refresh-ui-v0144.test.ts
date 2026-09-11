// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=abcdefghijk"}
import { afterEach, expect, it, vi } from 'vitest';
import { FloatingPlaybackController, PlaybackManager } from '../../src/modules/playback';
import { renderYouTubeTaskControls } from '../../src/modules/youtube/task-view';

let controller: FloatingPlaybackController | undefined;
let manager: PlaybackManager | undefined;
afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('retains the committed card through a same-generation loading pulse, but never through a new player generation', () => {
  vi.useFakeTimers();
  const video = document.createElement('video');
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    positionStore: { get: async () => ({}), set: async () => undefined },
  });
  controller.setResourceSnapshot({
    status: 'ready',
    products: [],
    youtube: {
      version: 1,
      videoId: 'abcdefghijk',
      title: '当前视频',
      status: 'identified',
      pageType: 'watch',
      transports: [],
      candidates: [],
      completeDownloadVerified: false,
    },
  });
  const card = controller.shadowRoot.querySelector('.dock-product');
  expect(card).not.toBeNull();
  controller.setResourceSnapshot({ status: 'loading', products: [] });
  expect(controller.shadowRoot.querySelector('.dock-product')).toBe(card);
  expect(controller.shadowRoot.querySelector('[data-youtube-refreshing="true"]')).not.toBeNull();
  controller.setResourceSnapshot({ status: 'loading', products: [], mediaEpoch: 1 });
  expect(controller.shadowRoot.querySelector('.dock-product')).toBeNull();
});

it('blocks starting from a refreshing source and restores the button without replacing controls', async () => {
  vi.useFakeTimers();
  const permissionSend = vi.fn(async () => ({
    ok: true,
    data: { token: 'page-capability', expiresAt: Date.now() + 90_000 },
  }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: permissionSend } });
  const host = document.createElement('div');
  document.body.append(host);
  let refreshing = true;
  const send = vi.fn(async () => ({ ok: true as const, data: null }));
  const controls = renderYouTubeTaskControls(host, 'abcdefghijk', {
    restore: false,
    send,
    isSourceRefreshing: () => refreshing,
  });
  controls.select(
    { videoId: 'abcdefghijk', videoTrackId: '18', container: 'auto', mode: 'merge' },
    true,
    true,
  );
  await vi.advanceTimersByTimeAsync(0);
  const start = host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!;
  expect(start.disabled).toBe(true);
  start.dispatchEvent(new MouseEvent('click'));
  expect(send).not.toHaveBeenCalled();
  refreshing = false;
  controls.refresh();
  expect(start.disabled).toBe(false);
  expect(permissionSend).toHaveBeenCalledWith({ type: 'GET_YOUTUBE_PERMISSION_CAPABILITY' });
});
