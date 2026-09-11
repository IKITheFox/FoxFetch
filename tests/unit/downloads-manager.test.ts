import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDownloadFilename,
  directDownloadValidationError,
  startAssetDownload,
  startBatchDownloads,
} from '../../src/modules/downloads/manager';
import { getDownloadHistory, updateDownloadByChromeId } from '../../src/modules/downloads/history';
import {
  buildDownloadDirectory,
  displayDownloadDirectory,
  downloadFilePickerId,
  downloadPlatformDirectory,
} from '../../src/modules/downloads/download-path';
import {
  createMediaRequestRule,
  installMediaRequestContext,
  mediaRequestContextRequired,
  mediaRequestReferrer,
  releaseMediaRequestContext,
} from '../../src/modules/downloads/request-context';
import type { DownloadRecord, MediaAsset } from '../../src/shared/types';
import { DEFAULT_SETTINGS, DOWNLOADS_KEY } from '../../src/shared/constants';

const asset: MediaAsset = {
  id: 'video-1',
  url: 'https://cdn.example/media/source.mp4?token=hidden',
  pageUrl: 'https://example.com/watch',
  pageTitle: '示例页面',
  frameId: 0,
  kind: 'video',
  detectedBy: ['dom'],
  extension: 'mp4',
  filename: 'source.mp4',
  downloadable: true,
  discoveredAt: 1,
};

const originalChrome = globalThis.chrome;

it('persists exact download ownership before Chrome starts and through reconciliation', async () => {
  const download = installDownloadApiMock();
  const owner = { tabId: 4, pageIdentity: 'https://example.com/watch', mediaEpoch: 7 };
  let observedOwner: unknown;
  download.mockImplementationOnce(async () => {
    const stored = await chrome.storage.local.get(DOWNLOADS_KEY);
    observedOwner = (stored[DOWNLOADS_KEY] as DownloadRecord[])[0]?.owner;
    return 100;
  });
  const result = await startBatchDownloads([asset], 'Title', DEFAULT_SETTINGS, owner);
  expect(observedOwner).toEqual(owner);
  expect(result[0]?.owner).toEqual(owner);
});

it.each(['complete', 'interrupted'] as const)(
  'does not overwrite an onChanged %s result with an older in_progress search response',
  async (state) => {
    installDownloadApiMock();
    const owner = { tabId: 4, pageIdentity: 'https://example.com/watch', mediaEpoch: 7 };
    vi.spyOn(chrome.downloads, 'search').mockImplementationOnce(async () => {
      await updateDownloadByChromeId(100, {
        state,
        ...(state === 'interrupted' ? { error: 'USER_CANCELED' } : {}),
      });
      return [{ id: 100, state: 'in_progress' } as chrome.downloads.DownloadItem];
    });
    const result = await startAssetDownload(asset, 'Title', 0, DEFAULT_SETTINGS, owner);
    expect(result).toMatchObject({ chromeDownloadId: 100, owner, state });
    expect((await getDownloadHistory()).find((record) => record.id === result.id)?.state).toBe(
      state,
    );
    if (state === 'interrupted') expect(result.error).toBe('USER_CANCELED');
  },
);

it.each(['empty', 'rejected'] as const)(
  'returns the authoritative terminal history when reconciliation search is %s',
  async (mode) => {
    installDownloadApiMock();
    vi.spyOn(chrome.downloads, 'search').mockImplementationOnce(async () => {
      await updateDownloadByChromeId(100, { state: 'complete' });
      if (mode === 'rejected') throw new Error('Search unavailable');
      return [];
    });
    const result = await startAssetDownload(asset, 'Title', 0, DEFAULT_SETTINGS);
    expect(result.state).toBe('complete');
    expect((await getDownloadHistory()).find((record) => record.id === result.id)?.state).toBe(
      'complete',
    );
  },
);

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: originalChrome,
  });
});

function installDownloadApiMock(requestContextAvailable = true): ReturnType<typeof vi.fn> {
  const stored: Record<string, unknown> = {};
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let downloadId = 100;
  const download = vi.fn(async () => downloadId++);
  const chromeMock: Record<string, unknown> = {
    storage: {
      local: {
        get: async (key?: string | string[] | null) => {
          if (typeof key === 'string') return { [key]: stored[key] };
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((item) => [item, stored[item]]));
          }
          return { ...stored };
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        },
      },
    },
    downloads: {
      download,
      search: async () => [],
    },
  };
  if (requestContextAvailable) {
    Object.assign(chromeMock, {
      permissions: { contains: async () => true },
      declarativeNetRequest: {
        getSessionRules: async () => [...rules],
        updateSessionRules: async (update: chrome.declarativeNetRequest.UpdateRuleOptions) => {
          const removed = new Set(update.removeRuleIds ?? []);
          const retained = rules.filter((rule) => !removed.has(rule.id));
          rules.splice(0, rules.length, ...retained, ...(update.addRules ?? []));
        },
      },
    });
  }
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: chromeMock,
  });
  return download;
}

function installRequestContextFailureMock(mode: 'missing-host' | 'install-failure'): {
  contains: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  stored: Record<string, unknown>;
  updateSessionRules: ReturnType<typeof vi.fn>;
} {
  const stored: Record<string, unknown> = {};
  const download = vi.fn(async () => 100);
  const contains = vi.fn(async () => mode !== 'missing-host');
  const updateSessionRules = vi.fn(async () => {
    if (mode === 'install-failure') throw new Error('DNR rule installation failed');
  });
  const search = vi.fn(async () => [
    {
      id: 100,
      filename: 'C:\\Downloads\\403 Forbidden.html',
      state: 'complete' as const,
    },
  ]);
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key?: string | string[] | null) => {
            if (typeof key === 'string') return { [key]: stored[key] };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, stored[item]]));
            }
            return { ...stored };
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(stored, structuredClone(items));
          },
          remove: async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
          },
        },
      },
      permissions: { contains },
      declarativeNetRequest: {
        getSessionRules: async () => [],
        updateSessionRules,
      },
      downloads: { download, search },
    },
  });
  return { contains, download, search, stored, updateSessionRules };
}

describe('download filenames', () => {
  it('ignores a retired template and uses the safe title', () => {
    expect(buildDownloadFilename(asset, '标题：演示', 2, '{title}-{index}')).toBe(
      'FoxFetch/example-com/标题-演示.mp4',
    );
  });

  it('does not apply a literal filename from the retired template', () => {
    expect(buildDownloadFilename(asset, 'Demo', 0, 'clip.mp4')).toBe(
      'FoxFetch/example-com/Demo.mp4',
    );
  });

  it('uses the normalized platform video title for regular downloads', () => {
    expect(
      buildDownloadFilename(
        { ...asset, pageUrl: 'https://www.bilibili.com/video/BV1Example' },
        '只保留这个标题_哔哩哔哩_bilibili-cache',
        0,
        '{title}',
      ),
    ).toBe('FoxFetch/Bilibili/只保留这个标题.mp4');
    expect(
      buildDownloadFilename(
        { ...asset, pageUrl: 'https://www.youtube.com/watch?v=abc' },
        'YouTube 正文里的标题 - YouTube',
        0,
        '{title}',
      ),
    ).toBe('FoxFetch/YouTube/YouTube 正文里的标题.mp4');
  });

  it('uses one English platform directory without a media-category level', () => {
    expect(downloadPlatformDirectory('https://www.bilibili.com/video/BV1')).toBe('bilibili');
    expect(downloadPlatformDirectory('https://music.youtube.com/watch?v=1')).toBe('youtube');
    expect(buildDownloadDirectory('https://www.bilibili.com/video/BV1', 'video')).toBe(
      'FoxFetch/Bilibili',
    );
    expect(buildDownloadDirectory('https://www.youtube.com/watch?v=1', 'audio')).toBe(
      'FoxFetch/YouTube',
    );
    expect(buildDownloadDirectory('https://news.example.cn/watch', 'image')).toBe(
      'FoxFetch/news-example-cn',
    );
    expect(buildDownloadDirectory('https://media.example/manifest.m3u8', 'playlist')).toBe(
      'FoxFetch/media-example',
    );
    expect(displayDownloadDirectory('https://www.bilibili.com/video/BV1', 'video')).toBe(
      'Downloads/FoxFetch/Bilibili',
    );
  });

  it('uses valid platform-scoped ids so native pickers remember confirmed directories', () => {
    expect(downloadFilePickerId('https://www.bilibili.com/video/BV1', 'merge')).toBe(
      'ff-merge-bilibili',
    );
    expect(downloadFilePickerId('https://www.youtube.com/watch?v=1', 'cache-merge')).toBe(
      'ff-cache-youtube',
    );
    const unknown = downloadFilePickerId(
      'https://a-very-long-platform-hostname-for-testing.example.com/watch',
      'cache-merge',
    );
    expect(unknown).toMatch(/^[a-z0-9_-]+$/u);
    expect(unknown.length).toBeLessThanOrEqual(32);
  });

  it('passes the default hierarchy to chrome.downloads for single and mixed batch downloads', async () => {
    const download = installDownloadApiMock();
    await startAssetDownload(
      { ...asset, pageUrl: 'https://www.bilibili.com/video/BV1' },
      'Single',
      0,
      DEFAULT_SETTINGS,
    );

    await startBatchDownloads(
      [
        { ...asset, id: 'batch-video', pageUrl: 'https://www.youtube.com/watch?v=1' },
        {
          ...asset,
          id: 'batch-audio',
          kind: 'audio',
          extension: 'm4a',
          pageUrl: 'https://www.youtube.com/watch?v=1',
        },
        {
          ...asset,
          id: 'batch-image',
          kind: 'image',
          extension: 'webp',
          pageUrl: 'https://www.bilibili.com/video/BV1',
        },
        {
          ...asset,
          id: 'batch-stream',
          kind: 'playlist',
          extension: 'm3u8',
          pageUrl: 'https://news.example.cn/watch',
        },
      ],
      'Batch',
      DEFAULT_SETTINGS,
    );

    const filenames = download.mock.calls
      .map(([options]) => (options as chrome.downloads.DownloadOptions).filename)
      .sort();
    expect(filenames).toEqual(
      [
        'FoxFetch/Bilibili/Single.mp4',
        'FoxFetch/YouTube/Batch.mp4',
        'FoxFetch/YouTube/Batch.m4a',
        'FoxFetch/Bilibili/Batch.webp',
        'FoxFetch/news-example-cn/Batch.m3u8',
      ].sort(),
    );
  });

  it('rejects an HTML player shell even if stale state labels it as video', () => {
    expect(
      directDownloadValidationError({
        ...asset,
        url: 'https://player.bilibili.com/player.html?bvid=BV1',
        extension: 'html',
        filename: 'player.html',
      }),
    ).toMatch(/网页文档/);
  });

  it('retains an HTML-looking endpoint when the response MIME proves it is media', () => {
    expect(
      directDownloadValidationError({
        ...asset,
        url: 'https://media.example/stream.html',
        extension: 'html',
        mime: 'video/mp4',
      }),
    ).toBeUndefined();
  });
});

describe('download request context', () => {
  it('uses only the page origin as Referer for a third-party CDN', () => {
    expect(
      mediaRequestReferrer(
        'https://cdn.example/video.m4s?token=secret',
        'https://www.bilibili.com/video/BV1?share=private#reply',
      ),
    ).toBe('https://www.bilibili.com/');
  });

  it('creates an exact session rule that restores Referer for download requests', () => {
    const rule = createMediaRequestRule(
      {
        url: 'https://cdn.example/video.m4s?token=a+b&range=0-1',
        pageUrl: 'https://www.bilibili.com/video/BV1',
      },
      1_900_000_000,
    );

    expect(rule).toMatchObject({
      id: 1_900_000_000,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
        ],
      },
      condition: { resourceTypes: ['other', 'media', 'xmlhttprequest'] },
    });
    expect(rule?.condition.regexFilter).toBe(
      '^https://cdn\\.example/video\\.m4s\\?token=a\\+b&range=0-1$',
    );
    expect(rule?.condition.isUrlFilterCaseSensitive).toBe(true);
  });

  it('falls back to the exact scheme, host, and path for an oversized signed URL', () => {
    const rule = createMediaRequestRule(
      {
        url: `https://cdn.example/media/source.m4s?token=${'x'.repeat(2_100)}`,
        pageUrl: 'https://page.example/watch',
      },
      1_900_000_003,
    );

    expect(rule?.condition).toEqual({
      regexFilter: '^https://cdn\\.example/media/source\\.m4s(\\?.*)?$',
      isUrlFilterCaseSensitive: true,
      resourceTypes: ['other', 'media', 'xmlhttprequest'],
    });

    const fallback = new RegExp(rule?.condition.regexFilter ?? '');
    expect(fallback.test('https://cdn.example/media/source.m4s?token=renewed')).toBe(true);
    expect(fallback.test('https://cdn.example/media/other.m4s?token=renewed')).toBe(false);
    expect(fallback.test('https://other.example/media/source.m4s?token=renewed')).toBe(false);
    expect(fallback.test('http://cdn.example/media/source.m4s?token=renewed')).toBe(false);
  });

  it('does not broaden an oversized path into a host-wide request rule', () => {
    expect(
      createMediaRequestRule(
        {
          url: `https://cdn.example/${'segment'.repeat(350)}.m4s?token=short`,
          pageUrl: 'https://page.example/watch',
        },
        1_900_000_004,
      ),
    ).toBeUndefined();
  });

  it('replays captured protected headers while leaving Cookie browser-managed', () => {
    const rule = createMediaRequestRule(
      {
        url: 'https://cdn.example/video.m4s',
        pageUrl: 'https://page.example/fallback',
        requestHeaders: {
          referer: 'https://page.example/exact/player?id=1',
          origin: 'https://page.example',
          authorization: 'Bearer media-token',
          accept: 'video/mp4,*/*',
        },
      },
      1_900_000_001,
    );

    expect(rule?.action.requestHeaders).toEqual([
      {
        header: 'Referer',
        operation: 'set',
        value: 'https://page.example/exact/player?id=1',
      },
      { header: 'Origin', operation: 'set', value: 'https://page.example' },
      { header: 'Authorization', operation: 'set', value: 'Bearer media-token' },
      { header: 'Accept', operation: 'set', value: 'video/mp4,*/*' },
    ]);
    expect(rule?.action.requestHeaders?.some((header) => header.header === 'Cookie')).toBe(false);
  });

  it('does not leak a secure page referrer to an insecure media URL', () => {
    expect(
      mediaRequestReferrer('http://cdn.example/video.mp4', 'https://example.com/watch'),
    ).toBeUndefined();
  });

  it('can replay Authorization when the original request had no Referer', () => {
    expect(
      createMediaRequestRule(
        {
          url: 'https://api.example/protected-media',
          pageUrl: '',
          requestHeaders: { authorization: 'Bearer only-token' },
        },
        1_900_000_002,
      )?.action.requestHeaders,
    ).toEqual([{ header: 'Authorization', operation: 'set', value: 'Bearer only-token' }]);
  });

  it.each(['missing-host', 'install-failure'] as const)(
    'interrupts before starting a native download when request context has a %s failure',
    async (mode) => {
      const { contains, download, search, stored, updateSessionRules } =
        installRequestContextFailureMock(mode);

      const result = await startAssetDownload(asset, 'Protected media', 0, DEFAULT_SETTINGS);

      expect(mediaRequestContextRequired(asset)).toBe(true);
      expect(contains).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });
      if (mode === 'missing-host') expect(updateSessionRules).not.toHaveBeenCalled();
      else expect(updateSessionRules).toHaveBeenCalledOnce();
      expect(download).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        assetId: asset.id,
        state: 'interrupted',
        error: expect.stringMatching(/请求上下文.*下载已中止/u),
      });
      expect(result).not.toHaveProperty('chromeDownloadId');
      expect(result).not.toHaveProperty('requestRuleId');

      const history = stored[DOWNLOADS_KEY] as DownloadRecord[];
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(result);
      expect(history[0]?.filename).not.toContain('403 Forbidden.html');
      expect(history[0]).not.toHaveProperty('requestRuleId');
    },
  );

  it('keeps direct downloads working when the asset does not need request context', async () => {
    const download = installDownloadApiMock(false);
    const contextFreeAsset = { ...asset, pageUrl: '' };

    expect(mediaRequestContextRequired(contextFreeAsset)).toBe(false);
    await expect(
      startAssetDownload(contextFreeAsset, 'Context-free media', 0, DEFAULT_SETTINGS),
    ).resolves.toMatchObject({ state: 'downloading', chromeDownloadId: 100 });
    expect(download).toHaveBeenCalledOnce();
  });

  it('installs and releases the exact session rule only with target host access', async () => {
    const rules: chrome.declarativeNetRequest.Rule[] = [];
    const updateSessionRules = vi.fn(
      async (update: chrome.declarativeNetRequest.UpdateRuleOptions) => {
        for (const id of update.removeRuleIds ?? []) {
          const index = rules.findIndex((rule) => rule.id === id);
          if (index >= 0) rules.splice(index, 1);
        }
        rules.push(...(update.addRules ?? []));
      },
    );
    const contains = vi.fn(async () => true);
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        permissions: { contains },
        declarativeNetRequest: {
          getSessionRules: async () => [...rules],
          updateSessionRules,
        },
      },
    });

    const ruleId = await installMediaRequestContext({
      ...asset,
      requestHeaders: { referer: 'https://example.com/watch' },
    });

    expect(ruleId).toBe(1_900_000_000);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://cdn.example/*'] });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action.requestHeaders).toContainEqual({
      header: 'Referer',
      operation: 'set',
      value: 'https://example.com/watch',
    });

    await releaseMediaRequestContext(ruleId);
    expect(rules).toHaveLength(0);
    expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [ruleId] });
  });

  it('allocates merge rules from a separate id range', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        permissions: { contains: async () => true },
        declarativeNetRequest: {
          getSessionRules: async () => [],
          updateSessionRules: async () => undefined,
        },
      },
    });

    await expect(
      installMediaRequestContext(
        {
          url: asset.url,
          pageUrl: asset.pageUrl,
          requestHeaders: { referer: asset.pageUrl },
        },
        'merge',
      ),
    ).resolves.toBe(1_900_010_000);
  });
});
