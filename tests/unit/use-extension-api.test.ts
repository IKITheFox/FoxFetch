import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isTransientPageSyncError,
  mediaProductAssetIds,
  openResourceCenterForTab,
  requireDownloadHostPermissions,
  sameTabMediaViewContext,
  startPermissionMediaIntent,
} from '../../src/hooks/useExtensionApi';
import type { MediaAsset, TabMediaState } from '../../src/shared/types';

const originalChrome = globalThis.chrome;

function mediaAsset(id: string, url: string): MediaAsset {
  return {
    id,
    url,
    pageUrl: 'https://page.example/watch',
    pageTitle: 'Example',
    frameId: 0,
    kind: 'video',
    detectedBy: ['network'],
    downloadable: true,
    discoveredAt: 1,
  };
}

function tabState(assets: MediaAsset[]): TabMediaState {
  return {
    tabId: 7,
    pageUrl: 'https://page.example/watch',
    pageTitle: 'Example',
    scannedAt: 1,
    status: 'ready',
    assets,
    mediaElements: [],
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: originalChrome,
  });
});

describe('direct-download host permissions', () => {
  it('stages the durable action before the permission promise settles', async () => {
    let settleStage: ((value: { ok: true; data: { intentId: string } }) => void) | undefined;
    let settlePermission: ((granted: boolean) => void) | undefined;
    const sendMessage = vi.fn((message: { type: string; intent?: { id: string } }) => {
      if (message.type === 'STAGE_PERMISSION_MEDIA_INTENT') {
        return new Promise((resolve) => {
          settleStage = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        data: { kind: 'download-assets', downloads: [] },
      });
    });
    const request = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settlePermission = resolve;
        }),
    );
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage }, permissions: { request } },
    });

    const pending = startPermissionMediaIntent(
      {
        kind: 'download-assets',
        tabId: 7,
        assetIds: ['video'],
        expectedPageUrl: 'https://page.example/watch',
        expectedMediaEpoch: 3,
      },
      { origins: ['https://cdn.example/*'] },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STAGE_PERMISSION_MEDIA_INTENT',
        intent: expect.objectContaining({
          action: expect.objectContaining({ expectedMediaEpoch: 3 }),
          permissions: { origins: ['https://cdn.example/*'] },
        }),
      }),
    );
    expect(request).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });

    const intentId = sendMessage.mock.calls[0]?.[0].intent?.id ?? '';
    settleStage?.({ ok: true, data: { intentId } });
    settlePermission?.(true);
    await expect(pending).resolves.toEqual({ kind: 'download-assets', downloads: [] });
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'COMMIT_PERMISSION_MEDIA_INTENT',
      intentId,
    });
  });

  it('starts one permission request for the selected CDN origins before yielding', async () => {
    let settlePermission: ((granted: boolean) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settlePermission = resolve;
        }),
    );
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { permissions: { request } },
    });

    const pending = requireDownloadHostPermissions(
      tabState([
        mediaAsset('video', 'https://video.cdn.example/v.m4s?token=1'),
        mediaAsset('audio', 'https://audio.cdn.example/a.m4s?token=2'),
        mediaAsset('ignored', 'https://ignored.example/file.mp4'),
      ]),
      ['video', 'audio'],
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      origins: ['https://video.cdn.example/*', 'https://audio.cdn.example/*'],
    });

    settlePermission?.(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it('reports a clear error when the user rejects CDN access', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { permissions: { request: vi.fn(async () => false) } },
    });

    await expect(
      requireDownloadHostPermissions(
        tabState([mediaAsset('video', 'https://cdn.example/video.mp4')]),
        ['video'],
      ),
    ).rejects.toThrow('未获得所选媒体 CDN 的网站访问权限，无法开始下载');
  });

  it('deduplicates origins and ignores unselected or non-network assets', async () => {
    const request = vi.fn(async () => true);
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { permissions: { request } },
    });

    await requireDownloadHostPermissions(
      tabState([
        mediaAsset('video', 'https://cdn.example/video.mp4'),
        mediaAsset('audio', 'https://cdn.example/audio.m4a'),
        mediaAsset('blob', 'blob:https://page.example/asset'),
        mediaAsset('ignored', 'https://ignored.example/file.mp4'),
      ]),
      ['video', 'audio', 'blob'],
    );

    expect(request).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });
  });
});

describe('automatic page synchronization errors', () => {
  it('classifies route races as transient instead of asking for a manual rescan', () => {
    expect(isTransientPageSyncError(new Error('页面已变化，请重新扫描'))).toBe(true);
    expect(isTransientPageSyncError('媒体已变化，请重新扫描后再解析')).toBe(true);
    expect(isTransientPageSyncError(new Error('网络连接失败'))).toBe(false);
  });

  it('keeps committed UI state for focus refreshes and tracking-only URL changes', () => {
    const current = {
      tabId: 7,
      title: '当前视频',
      url: 'https://www.bilibili.com/video/BV1CURRENT/?spm_id_from=333.1',
    };
    expect(
      sameTabMediaViewContext(current, {
        ...current,
        url: 'https://www.bilibili.com/video/BV1CURRENT/?vd_source=tracking&p=1',
      }),
    ).toBe(true);
    expect(
      sameTabMediaViewContext(current, {
        ...current,
        url: 'https://www.bilibili.com/video/BV1DIFFERENT/',
      }),
    ).toBe(false);
    expect(sameTabMediaViewContext(current, { ...current, tabId: 8 })).toBe(false);
  });
});

describe('resource center handoff', () => {
  it('asks the background to open the side panel so Dock suppression is ordered with it', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, data: null }));
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { sendMessage } },
    });

    await expect(openResourceCenterForTab(7)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'OPEN_SIDE_PANEL', tabId: 7 });
  });
});

describe('aggregated media product downloads', () => {
  it('requests only the track needed by each output mode', () => {
    expect(mediaProductAssetIds('audio-only', 'video', 'audio')).toEqual(['audio']);
    expect(mediaProductAssetIds('video-only', 'video', 'audio')).toEqual(['video']);
    expect(mediaProductAssetIds('complete', 'video', 'audio')).toEqual(['video', 'audio']);
  });

  it('rejects audio-dependent outputs until an audio track is available', () => {
    expect(() => mediaProductAssetIds('audio-only', 'video')).toThrow('独立音轨');
    expect(mediaProductAssetIds('complete', 'muxed-video')).toEqual(['muxed-video']);
    expect(mediaProductAssetIds('video-only', 'video')).toEqual(['video']);
  });
});
