import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/entrypoints/sidepanel/App';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { populatedUiState, uiPageUrl, uiRecentTasks, uiTitle } from '../fixtures/react-ui-state';

const data = vi.hoisted(() => ({ state: undefined as unknown, downloads: [] as unknown[] }));
vi.mock('../../src/hooks/useExtensionApi', () => ({
  useAppSettings: () => ({ settings: DEFAULT_SETTINGS, saveSettings: vi.fn() }),
  useTabMedia: () => ({
    state: data.state,
    activeTab: { tabId: 7, url: uiPageUrl, title: '网页旧标题' },
    loading: false,
  }),
  useDownloads: () => data.downloads,
  sendUiRequest: vi.fn(),
  startMediaAccessIntent: vi.fn(),
}));
vi.mock('../../src/entrypoints/sidepanel/resource-center-presence', () => ({
  connectResourceCenterPresence: () => () => undefined,
}));

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
function render() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<App />));
  return host;
}
describe('resource center UI scope', () => {
  it('keeps populated media and current artwork but removes the entire player and empty advanced shell', () => {
    data.state = populatedUiState();
    data.downloads = [];
    const host = render();
    expect(host.querySelectorAll('.media-product-card')).toHaveLength(1);
    expect(host.querySelectorAll('.media-card').length).toBeGreaterThan(0);
    expect(host.querySelector('.page-summary__title')?.textContent ?? host.textContent).toContain(
      uiTitle,
    );
    expect(host.querySelector('.current-video-artwork__image')).not.toBeNull();
    expect(
      host.querySelectorAll('.playback-panel,.resource-tools,input[type="range"]'),
    ).toHaveLength(0);
    expect(host.querySelector('main')?.getAttribute('contenteditable')).toBe('false');
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
  });
  it('retains source capture and recent tasks independently of the removed player', () => {
    data.state = {
      ...populatedUiState(),
      sourceCapture: {
        id: 'capture',
        tabId: 7,
        blobAssetId: 'blob',
        status: 'capturing',
        startedAt: 1,
        updatedAt: 2,
        observationCount: 3,
        candidateCount: 2,
      },
    };
    data.downloads = uiRecentTasks;
    const host = render();
    expect(host.querySelector('.resource-tools')).not.toBeNull();
    expect(host.querySelector('.source-capture')).not.toBeNull();
    expect(host.querySelector('.task-strip')).not.toBeNull();
    expect(host.querySelector('.playback-panel')).toBeNull();
  });
});
