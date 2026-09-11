import { describe, expect, it, vi } from 'vitest';

import {
  FULL_MEDIA_ACCESS_PERMISSIONS,
  assertDirectMediaAssetPermissions,
  assertDirectMediaDownloadContext,
  assertPermissionIntentBundle,
  assertPermissionMediaContext,
  requiredPermissionBundle,
  validatePermissionActionAssets,
} from '../../src/modules/permissions';
import type {
  MediaAsset,
  PermissionGatedMediaAction,
  PermissionGatedMediaIntent,
  TabMediaState,
} from '../../src/shared/types';

const PAGE_URL = 'https://page.example/watch/one';

function asset(id: string, url: string, kind: MediaAsset['kind'] = 'video'): MediaAsset {
  return {
    id,
    url,
    pageUrl: PAGE_URL,
    pageTitle: 'Example',
    frameId: 0,
    kind,
    detectedBy: ['network'],
    downloadable: true,
    discoveredAt: 1,
  };
}

function state(assets: MediaAsset[]): TabMediaState {
  return {
    tabId: 9,
    pageUrl: PAGE_URL,
    pageTitle: 'Example',
    scannedAt: 1,
    status: 'ready',
    assets,
    mediaElements: [],
    mediaEpoch: 7,
  };
}

function downloadAction(assetIds = ['video']): PermissionGatedMediaAction {
  return {
    kind: 'download-assets',
    tabId: 9,
    assetIds,
    expectedPageUrl: PAGE_URL,
    expectedMediaEpoch: 7,
  };
}

describe('permission media intent validation', () => {
  it('derives only the selected CDN origins and accepts the exact stored bundle', () => {
    const current = state([
      asset('video', 'https://video.cdn.example/v.m4s?token=1'),
      asset('audio', 'https://audio.cdn.example/a.m4s?token=2', 'audio'),
      asset('ignored', 'https://ignored.example/file.mp4'),
    ]);
    const action = downloadAction(['video', 'audio']);
    assertPermissionMediaContext(current, PAGE_URL, action);
    const selected = validatePermissionActionAssets(current, action);
    const permissions = requiredPermissionBundle(action, selected);

    expect(permissions).toEqual({
      origins: ['https://audio.cdn.example/*', 'https://video.cdn.example/*'],
    });
    const intent: PermissionGatedMediaIntent = {
      id: 'intent-1',
      action,
      createdAt: 1,
      permissions: { origins: [...(permissions.origins ?? [])].reverse() },
    };
    expect(() => assertPermissionIntentBundle(intent, permissions)).not.toThrow();
    expect(() =>
      assertPermissionIntentBundle(
        { ...intent, permissions: { origins: ['https://unselected.example/*'] } },
        permissions,
      ),
    ).toThrow('权限范围');
  });

  it('fails closed when the route, media generation, or exact asset set changed', () => {
    const current = state([asset('video', 'https://cdn.example/video.mp4')]);
    expect(() =>
      assertPermissionMediaContext(current, 'https://page.example/watch/two', downloadAction()),
    ).toThrow('页面已切换');
    expect(() =>
      assertPermissionMediaContext(current, PAGE_URL, {
        ...downloadAction(),
        expectedMediaEpoch: 8,
      }),
    ).toThrow('播放器已切换');
    expect(() => validatePermissionActionAssets(current, downloadAction(['missing']))).toThrow(
      '媒体已变化',
    );
    expect(() =>
      validatePermissionActionAssets(current, downloadAction(['video', 'video'])),
    ).toThrow('资源无效');
  });

  it('requires full media access only for source capture', () => {
    const source = { ...asset('blob', 'blob:https://page.example/id'), downloadable: false };
    const current = state([source]);
    const action: PermissionGatedMediaAction = {
      kind: 'capture-source',
      tabId: 9,
      blobAssetId: source.id,
      expectedPageUrl: PAGE_URL,
      expectedMediaEpoch: 7,
    };

    expect(requiredPermissionBundle(action, validatePermissionActionAssets(current, action))).toBe(
      FULL_MEDIA_ACCESS_PERMISSIONS,
    );
  });

  it('rejects direct download messages without an exact page and media generation', () => {
    const current = state([asset('video', 'https://cdn.example/video.mp4')]);
    expect(() =>
      assertDirectMediaDownloadContext(current, PAGE_URL, {
        ...downloadAction(),
        expectedPageUrl: '',
      }),
    ).toThrow('缺少页面或播放器校验信息');
    expect(() =>
      assertDirectMediaDownloadContext(current, PAGE_URL, {
        ...downloadAction(),
        expectedMediaEpoch: undefined as unknown as number,
      }),
    ).toThrow('缺少页面或播放器校验信息');
  });

  it('requires the exact selected HTTP origins while allowing non-network assets', async () => {
    const contains = vi.fn(async () => false);
    await expect(
      assertDirectMediaAssetPermissions([asset('video', 'https://cdn.example/video.mp4')], {
        contains,
      }),
    ).rejects.toThrow('需要先授予所选媒体来源权限');
    expect(contains).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });

    contains.mockClear();
    await expect(
      assertDirectMediaAssetPermissions(
        [{ ...asset('local', 'data:video/mp4;base64,AAAA'), downloadable: true }],
        { contains },
      ),
    ).resolves.toBeUndefined();
    expect(contains).not.toHaveBeenCalled();
  });
});
