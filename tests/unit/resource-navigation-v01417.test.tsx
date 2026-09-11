import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App as Popup } from '../../src/entrypoints/popup/App';
import { App as Center } from '../../src/entrypoints/sidepanel/App';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { youtubeUiState } from '../fixtures/youtube-v01417';
import {
  identifiedYouTubeVideo,
  isIdentifiedYouTubePlaceholder,
} from '../../src/modules/youtube/display-video';
const data = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof youtubeUiState> | undefined,
  send: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../src/hooks/useExtensionApi', () => ({
  useAppSettings: () => ({ settings: DEFAULT_SETTINGS, saveSettings: vi.fn() }),
  useTabMedia: () => ({
    state: data.state,
    activeTab: { tabId: 7, url: data.state?.pageUrl },
    loading: false,
    setError: data.error,
  }),
  useDownloads: () => [],
  sendUiRequest: data.send,
  startMediaAccessIntent: vi.fn(),
}));
vi.mock('../../src/entrypoints/sidepanel/resource-center-presence', () => ({
  connectResourceCenterPresence: () => () => undefined,
}));
let root: Root;
beforeEach(() => {
  data.state = youtubeUiState();
  data.send.mockReset().mockResolvedValue(null);
  data.error.mockReset();
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true, data: null }) },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(center = false) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(center ? <Center /> : <Popup />);
  });
  return host;
}
it('replaces only the admitted placeholder, retaining unrelated players and rejecting stale identity', () => {
  const state = data.state!;
  const asset = state.assets[0]!;
  expect(isIdentifiedYouTubePlaceholder(asset, state)).toBe(true);
  expect(
    isIdentifiedYouTubePlaceholder({ ...asset, url: 'blob:https://www.youtube.com/ad' }, state),
  ).toBe(false);
  expect(isIdentifiedYouTubePlaceholder(asset, { ...state, mediaEpoch: 2 })).toBe(false);
  expect(
    identifiedYouTubeVideo(state.youtube, state.pageUrl.replace('abcdefghijk', '12345678901')),
  ).toBeUndefined();
  expect(
    identifiedYouTubeVideo({ ...state.youtube!, status: 'advertisement' }, state.pageUrl),
  ).toBeUndefined();
});
it('popup has one compact video row, no top selector and explicit navigation instead of capture/download', async () => {
  const host = await render();
  expect(host.querySelectorAll('.media-product-card')).toHaveLength(1);
  expect(host.querySelector('[aria-label="YouTube 识别结果"]')).toBeNull();
  expect(host.querySelector('.media-product-card select')).toBeNull();
  expect(host.textContent).toContain('页面资源');
  expect(host.textContent).not.toContain('待解析视频');
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="打开视频下载"]')!.click();
  });
  expect(data.send).toHaveBeenCalledExactlyOnceWith({
    type: 'OPEN_VIDEO_VIEW',
    tabId: 7,
    pageUrl: data.state!.pageUrl,
    mediaEpoch: 0,
    target: 'resources',
  });
  expect(window.close).toHaveBeenCalledOnce();
});
it('controller navigation selects playback and failed navigation does not close the popup', async () => {
  const host = await render();
  data.send.mockRejectedValueOnce(new Error('stale page'));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="打开播放控制器"]')!.click();
  });
  expect(data.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'OPEN_VIDEO_VIEW', target: 'playback' }),
  );
  expect(data.error).toHaveBeenCalledWith('stale page');
  expect(window.close).not.toHaveBeenCalled();
});
it('resource center retains top selectors and its row opens the same local task without a start request', async () => {
  const host = await render(true);
  expect(host.querySelectorAll('.media-product-card')).toHaveLength(2);
  const task = host.querySelector<HTMLElement>('[data-youtube-status]')!;
  const group = task.querySelector('fieldset')!;
  expect(task.dataset.youtubeTaskOpen).toBe('false');
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="打开视频下载"]')!.click();
  });
  expect(task.dataset.youtubeTaskOpen).toBe('true');
  expect(task.querySelector('fieldset')).toBe(group);
  expect(data.send).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'START_YOUTUBE_DOWNLOAD' }),
  );
});
