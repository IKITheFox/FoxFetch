import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FloatingPlaybackController, PlaybackManager } from '../../src/modules/playback';
import type { DownloadActivityView, MergeDockView } from '../../src/shared/types';
import { createActiveMediaFingerprint } from '../../src/modules/playback';
import { mediaArtworkTitleKey } from '../../src/modules/media-products/media-artwork';

let controller: FloatingPlaybackController;
let manager: PlaybackManager;

function view(extra: Partial<MergeDockView> = {}): MergeDockView {
  return {
    actionToken: 'task-action',
    pathToken: 'task-path',
    title: '当前视频',
    state: 'running',
    phase: 'fetching',
    status: '正在下载',
    progress: 0.25,
    savePath: 'Downloads/FoxFetch',
    pathMode: 'automatic',
    mergeEnabled: false,
    separateEnabled: false,
    busy: true,
    snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 1 },
    diagnostics: {
      stage: '读取视频',
      readBytes: 1024,
      totalBytes: 4096,
      startedAt: 1,
      lastProgressAt: 2,
    },
    ...extra,
  };
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  return controller.shadowRoot.querySelector<T>(selector)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.title = '当前视频';
  const video = document.createElement('video');
  video.src = 'https://media.example.test/current.mp4';
  document.body.append(video);
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    positionStore: { get: async () => ({}), set: async () => undefined },
  });
});

afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  document.title = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('v0.13.0 progress and native details', () => {
  it('v0.14.16 opens only the two-option migration menu, never starts a hidden custom target', () => {
    controller.destroy();
    const action = vi.fn();
    controller = new FloatingPlaybackController(document, manager, {
      positionStore: { get: async () => ({}), set: async () => undefined },
      onMergeDockAction: action,
      onMergeDockPathModeChange: vi.fn(),
    });
    controller.openMerge(
      view({
        state: 'ready',
        busy: false,
        mergeEnabled: true,
        saveLocationConfirmationRequired: true,
        pathMode: 'custom',
        savePath: '11111',
      }),
    );
    element<HTMLButtonElement>('[data-merge-action="merge"]').click();
    expect(action).not.toHaveBeenCalled();
    expect(element<HTMLElement>('[data-role="merge-path-picker"]').hidden).toBe(false);
    expect(element('[data-role="merge-path"]').textContent).toBe('请选择保存位置');
    expect(controller.shadowRoot.querySelectorAll('.merge-path-choice')).toHaveLength(2);
    expect(controller.shadowRoot.querySelector('[data-path-mode="custom"]')).toBeNull();
    expect(element<HTMLDetailsElement>('[data-role="merge-diagnostics"]').open).toBe(false);
  });
  it('v0.14.16 keeps permission errors collapsed and resets details when reopening', () => {
    const errorView = view({
      state: 'permission_required',
      busy: false,
      status: '请确认来源访问权限',
    });
    controller.openMerge(errorView);
    const details = element<HTMLDetailsElement>('[data-role="merge-diagnostics"]');
    expect(details.open).toBe(false);
    details.open = true;
    controller.setMergeSnapshot({ ...errorView, progress: 0.5 });
    expect(details.open).toBe(true);
    controller.collapse();
    controller.openMerge(errorView);
    expect(details.open).toBe(false);
  });
  it('prioritizes active merge then ordinary download, fences revisions and expires terminal notices', async () => {
    const active = createActiveMediaFingerprint(document.URL, 0, manager.getMediaElements()[0]!);
    const activity: DownloadActivityView = {
      pageIdentity: active.routeKey,
      mediaEpoch: 0,
      revision: 1,
      state: 'downloading',
      activeCount: 2,
      updatedAt: Date.now(),
    };
    controller.collapse();
    controller.setDownloadActivity(activity);
    expect(element('[data-role="launcher-status"]').textContent).toBe('正在下载（2 项）');
    expect(controller.getMode()).toBe('launcher');
    controller.openMerge(view({ phase: 'muxing' }));
    controller.collapse();
    expect(element('[data-role="launcher-status"]').textContent).toBe('正在合并 25%');
    controller.setMergeSnapshot(
      view({
        state: 'completed',
        snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 2 },
      }),
    );
    expect(element('[data-role="launcher-status"]').textContent).toBe('正在下载（2 项）');
    await vi.advanceTimersByTimeAsync(100);
    controller.setDownloadActivity({
      ...activity,
      state: 'cancelled',
      activeCount: 0,
      revision: 3,
      updatedAt: Date.now(),
    });
    controller.setDownloadActivity({ ...activity, state: 'failed', revision: 2 });
    expect(element('[data-role="launcher-status"]').textContent).toBe('已终止');
    expect(controller.host.dataset.launcherStatus).not.toBe('error');
    await vi.advanceTimersByTimeAsync(12_001);
    expect(element('[data-role="launcher-status"]').textContent).toBe('已识别视频');
    controller.setMergeSnapshot(
      view({
        state: 'completed',
        snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 3 },
      }),
    );
    expect(element('[data-role="launcher-status"]').textContent).toBe('已识别视频');
    controller.setDownloadActivity({ ...activity, pageIdentity: 'other-page', revision: 99 });
    controller.setDownloadActivity({ ...activity, mediaEpoch: 99, revision: 100 });
    expect(element('[data-role="launcher-status"]').textContent).toBe('已识别视频');
    expect(controller.getMode()).toBe('launcher');
  });
  it('rejects stale launcher updates and never fabricates percent for indeterminate work', () => {
    controller.openMerge(view({ progress: null }));
    controller.collapse();
    expect(element('[data-role="launcher-status"]').textContent).toBe('正在下载');
    controller.setMergeSnapshot(
      view({
        state: 'completed',
        snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 3 },
      }),
    );
    controller.setMergeSnapshot(
      view({ progress: 0.8, snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 2 } }),
    );
    expect(element('[data-role="launcher-status"]').textContent).toBe('保存成功');
    expect(controller.getMode()).toBe('launcher');
    controller.resetForNavigation();
    expect(element('[data-role="launcher-status"]').textContent).not.toBe('保存成功');
  });

  it('paints only bound own artwork over the platform mark, and clears removed metadata', () => {
    const active = createActiveMediaFingerprint(document.URL, 0, manager.getMediaElements()[0]!);
    const artwork = {
      url: 'http://i0.hdslb.com/bfs/archive/test.jpg@272w?x=1',
      source: 'page-metadata' as const,
      pageIdentity: active.routeKey,
      mediaEpoch: 0,
      elementId: active.elementId,
      lifecycleGeneration: active.lifecycleGeneration,
      frameId: 0,
      titleKey: mediaArtworkTitleKey(active.title, document.URL),
    };
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'current-product',
          title: active.title,
          domain: 'example.test',
          options: [{ mode: 'video', available: true }],
        },
      ],
    });
    controller.setArtwork(artwork);
    const image = element<HTMLImageElement>('.dock-product-poster');
    expect(image.getAttribute('src')).toBe('https://i0.hdslb.com/bfs/archive/test.jpg@272w?x=1');
    expect(document.querySelector('video')!.hasAttribute('poster')).toBe(false);
    expect(artwork.url.startsWith('http:')).toBe(true);
    controller.setArtwork(undefined);
    expect(controller.shadowRoot.querySelector('.dock-product-poster')).toBeNull();
    controller.setArtwork({ ...artwork, lifecycleGeneration: active.lifecycleGeneration + 1 });
    expect(controller.shadowRoot.querySelector('.dock-product-poster')).toBeNull();
    controller.setArtwork(artwork);
    element('.dock-product-poster').dispatchEvent(new Event('error'));
    controller.update(manager.getMediaElements());
    expect(controller.shadowRoot.querySelector('.dock-product-poster')).toBeNull();
    controller.setArtwork({ ...artwork, url: 'https://i0.hdslb.com/new-cover.jpg' });
    expect(element<HTMLImageElement>('.dock-product-poster').src).toBe(
      'https://i0.hdslb.com/new-cover.jpg',
    );
  });
  it('does not let a downloadable Dolby candidate override its pending verification state', () => {
    controller.setResourceSnapshot({
      status: 'ready',
      products: [
        {
          id: 'candidate',
          title: '当前视频',
          domain: 'bilibili.com',
          options: [
            { mode: 'complete', available: true },
            { mode: 'video', available: true },
          ],
          qualities: [
            {
              token: 'candidate',
              label: '杜比视界 · HEVC',
              completeAvailable: true,
              videoOnlyAvailable: true,
              fidelityState: 'checking',
              dynamicRange: 'Dolby Vision',
            },
          ],
        },
      ],
    });
    const status = element('[data-role="product-fidelity"]');
    expect(status.dataset.state).toBe('checking');
    expect(status.getAttribute('aria-label')).toBe('已找到媒体地址，尚未验证下载后的文件。');
    expect(status.dataset.verification).toBe('pending');
  });
  it('changes native details copy on toggle and keeps it open across progress updates', () => {
    controller.openMerge(view());
    const details = element<HTMLDetailsElement>('[data-role="merge-diagnostics"]');
    expect(details.querySelector('summary')?.textContent).toBe('查看详情');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(details.querySelector('summary')?.textContent).toBe('收起');
    controller.setMergeSnapshot(
      view({ progress: 0.5, snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 2 } }),
    );
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')?.textContent).toBe('收起');
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    expect(details.querySelector('summary')?.textContent).toBe('查看详情');
    details.open = true;
    controller.openMerge(
      view({
        actionToken: 'next-action',
        snapshot: { taskKey: 'task-next', mediaEpoch: 0, revision: 1 },
      }),
    );
    expect(details.open).toBe(false);
  });

  it.each([
    ['preparing', 'resolving', '正在初始化'],
    ['running', 'fetching', '正在下载 25%'],
    ['running', 'muxing', '正在合并 25%'],
    ['running', 'verifying', '正在验证 25%'],
    ['running', 'saving', '正在保存 25%'],
    ['permission_required', 'permission_required', '等待授权'],
    ['cancelling', 'cancelling', '正在终止'],
    ['cancelled', 'cancelled', '已终止'],
    ['completed', 'completed', '保存成功'],
    ['failed', 'failed', '下载失败'],
  ] as const)(
    'updates minimized launcher for %s/%s without opening it',
    (state, phase, expected) => {
      controller.openMerge(view());
      element<HTMLButtonElement>('[data-action="collapse"]').click();
      expect(controller.getMode()).toBe('launcher');
      const snapshot = view({
        state,
        phase,
        snapshot: { taskKey: 'task-current', mediaEpoch: 0, revision: 2 },
      });
      delete snapshot.diagnostics;
      controller.setMergeSnapshot(snapshot);
      expect(element('[data-role="launcher-status"]').textContent).toBe(expected);
      expect(controller.getMode()).toBe('launcher');
      controller.update(manager.getMediaElements());
      expect(element('[data-role="launcher-status"]').textContent).toBe(expected);
    },
  );
});
