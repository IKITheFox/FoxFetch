import { describe, expect, it } from 'vitest';

import {
  MEDIA_DOCK_TOKEN_TTL_MS,
  MediaDockProductGrantBroker,
  claimMediaDockPermissionFromMessage,
  createMergeDockAfterPermissionSettles,
  mediaDockPermissionModesForProduct,
  type MediaDockGrantStorage,
} from '../../src/modules/media-products';

class MemorySessionStorage implements MediaDockGrantStorage {
  readonly values: Record<string, unknown> = {};

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return { ...this.values };
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      selected.flatMap((key) => (key in this.values ? [[key, this.values[key]]] : [])),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}

const input = {
  tabId: 7,
  pageUrl: 'https://www.bilibili.com/video/BV1CURRENT/',
  mediaEpoch: 4,
  mediaIdentity: 'current-player',
  snapshotRevision: 'snapshot-4',
  productId: 'internal-product-id',
  allowedModes: ['complete', 'video'] as const,
  permissionModes: ['complete', 'video'] as const,
};

const request = {
  tabId: input.tabId,
  pageUrl: input.pageUrl,
  mediaEpoch: input.mediaEpoch,
  mediaIdentity: input.mediaIdentity,
  snapshotRevision: input.snapshotRevision,
  mode: 'complete' as const,
};

describe('page Dock product capability broker', () => {
  it('permission-gates every available network product output', () => {
    expect(
      mediaDockPermissionModesForProduct({
        defaultSelection: {
          videoTrackId: 'video',
          audioTrackId: 'audio',
          complete: { mode: 'merge', videoTrackId: 'video', audioTrackId: 'audio' },
        },
      }),
    ).toEqual(['complete', 'video', 'audio']);
    expect(
      mediaDockPermissionModesForProduct({
        defaultSelection: {
          videoTrackId: 'muxed',
          complete: { mode: 'direct', videoTrackId: 'muxed' },
        },
      }),
    ).toEqual(['complete', 'video']);
    expect(mediaDockPermissionModesForProduct({ defaultSelection: {} })).toEqual([]);
  });

  it('survives a service-worker restart without exposing the product id', async () => {
    const storage = new MemorySessionStorage();
    const issuer = new MediaDockProductGrantBroker(
      storage,
      () => 1_000,
      () => 'opaque-token',
    );
    const token = await issuer.issue(input);

    expect(token).toBe('opaque-token');
    expect(token).not.toContain(input.productId);
    const afterRestart = new MediaDockProductGrantBroker(storage, () => 1_001);
    // A restarted worker cannot synchronously authenticate a persisted token,
    // so it safely skips the broad prompt and lets consumption open the retry Dock.
    expect(afterRestart.claimPermissionRequest(token, request)).toBe(false);
    await expect(afterRestart.consume(token, request)).resolves.toMatchObject({
      productId: input.productId,
      tabId: input.tabId,
      allowedModes: ['complete', 'video'],
      permissionModes: ['complete', 'video'],
    });
  });

  it('restores the synchronous permission continuation after a cold worker restart', async () => {
    const storage = new MemorySessionStorage();
    const token = '49c0c7f1-72f4-4c6f-9b30-17c9d592c763';
    const issuer = new MediaDockProductGrantBroker(
      storage,
      () => 1_100,
      () => token,
    );
    await issuer.issue(input);
    const afterRestart = new MediaDockProductGrantBroker(storage, () => 1_101);
    const sender = { tab: { id: input.tabId, url: input.pageUrl }, frameId: 0 };

    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token, mode: 'complete' },
        sender,
        afterRestart,
      ),
    ).toBe(true);
    await expect(afterRestart.consume(token, request)).resolves.toMatchObject({
      productId: input.productId,
    });
  });

  it('claims a synchronous permission prompt only for a live merge token', async () => {
    const storage = new MemorySessionStorage();
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => 1_500,
      () => `permission-${++sequence}`,
    );
    const token = await broker.issue(input);

    expect(broker.claimPermissionRequest(token, request)).toBe(true);
    expect(broker.claimPermissionRequest(token, request)).toBe(false);
    expect(broker.claimPermissionRequest('unknown-token', request)).toBe(false);
  });

  it('rejects malformed, invalid-token, and subframe prompt messages while allowing direct media', async () => {
    const broker = new MediaDockProductGrantBroker(
      new MemorySessionStorage(),
      () => 1_550,
      (() => {
        let sequence = 0;
        return () => `message-token-${++sequence}`;
      })(),
    );
    const token = await broker.issue(input);
    const sender = { tab: { id: input.tabId, url: input.pageUrl }, frameId: 0 };

    expect(claimMediaDockPermissionFromMessage(null, sender, broker)).toBe(false);
    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token: 'unknown', mode: 'complete' },
        sender,
        broker,
      ),
    ).toBe(false);
    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token, mode: 'video' },
        sender,
        broker,
      ),
    ).toBe(true);
    const subframeToken = await broker.issue(input);
    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token: subframeToken, mode: 'complete' },
        { ...sender, frameId: 1 },
        broker,
      ),
    ).toBe(false);
    const completeToken = await broker.issue(input);
    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token: completeToken, mode: 'complete' },
        sender,
        broker,
      ),
    ).toBe(true);
  });

  it('requests access for a direct complete output so authenticated CDN downloads stay media', async () => {
    const broker = new MediaDockProductGrantBroker(
      new MemorySessionStorage(),
      () => 1_600,
      () => 'direct-complete',
    );
    const token = await broker.issue({ ...input, permissionModes: ['complete'] });

    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token, mode: 'complete' },
        { tab: { id: input.tabId, url: input.pageUrl }, frameId: 0 },
        broker,
      ),
    ).toBe(true);
  });

  it('binds a page quality choice to its own opaque capability', async () => {
    const storage = new MemorySessionStorage();
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => 1_625,
      () => `quality-token-${++sequence}`,
    );
    const defaultToken = await broker.issue({ ...input, qualityId: 'quality-720-avc' });
    const selectedToken = await broker.issue({ ...input, qualityId: 'quality-1080-hevc' });
    const sender = { tab: { id: input.tabId, url: input.pageUrl }, frameId: 0 };

    expect(
      claimMediaDockPermissionFromMessage(
        {
          type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT',
          token: defaultToken,
          qualityToken: selectedToken,
          mode: 'complete',
        },
        sender,
        broker,
      ),
    ).toBe(true);
    await expect(broker.consume(selectedToken, request)).resolves.toMatchObject({
      qualityId: 'quality-1080-hevc',
      productId: input.productId,
    });
  });

  it('rotates one-shot grants on every production-style snapshot without changing metadata identity', async () => {
    const storage = new MemorySessionStorage();
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => 1_640,
      () => `snapshot-token-${++sequence}`,
    );
    const tokens: string[] = [];
    for (let revision = 0; revision < 50; revision += 1) {
      tokens.push(await broker.issue({ ...input, qualityId: 'quality-1080-avc' }));
    }

    expect(new Set(tokens).size).toBe(50);
    expect(tokens.at(-1)).toBe('snapshot-token-50');
    await expect(broker.consume(tokens.at(-1)!, request)).resolves.toMatchObject({
      productId: input.productId,
      qualityId: 'quality-1080-avc',
    });
  });

  it('uses the current tab route instead of a stale SPA sender URL', async () => {
    const broker = new MediaDockProductGrantBroker(
      new MemorySessionStorage(),
      () => 1_650,
      () => 'spa-token',
    );
    const token = await broker.issue(input);
    expect(
      claimMediaDockPermissionFromMessage(
        { type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT', token, mode: 'complete' },
        {
          tab: { id: input.tabId, url: input.pageUrl },
          url: 'https://www.bilibili.com/video/BV1STALE/',
          frameId: 0,
        },
        broker,
      ),
    ).toBe(true);
  });

  it('rejects permission prompting for a wrong sender, stale context, or expired token', async () => {
    const storage = new MemorySessionStorage();
    let now = 1_700;
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => now,
      () => `guard-${++sequence}`,
    );

    const wrongTab = await broker.issue(input);
    expect(broker.claimPermissionRequest(wrongTab, { ...request, tabId: request.tabId + 1 })).toBe(
      false,
    );

    const wrongPage = await broker.issue(input);
    expect(
      broker.claimPermissionRequest(wrongPage, { ...request, pageUrl: `${request.pageUrl}?p=2` }),
    ).toBe(false);

    const stale = await broker.issue(input);
    broker.activateContext({ ...input, mediaEpoch: input.mediaEpoch + 1 });
    expect(broker.claimPermissionRequest(stale, request)).toBe(false);

    const staleProduct = await broker.issue({ ...input, mediaEpoch: input.mediaEpoch + 1 });
    const nextRevision = 'snapshot-updated-products';
    broker.activateContext({
      ...input,
      mediaEpoch: input.mediaEpoch + 1,
      snapshotRevision: nextRevision,
    });
    expect(broker.claimPermissionRequest(staleProduct, request)).toBe(false);

    const expired = await broker.issue({
      ...input,
      mediaEpoch: input.mediaEpoch + 1,
      snapshotRevision: nextRevision,
    });
    now += MEDIA_DOCK_TOKEN_TTL_MS + 1;
    expect(broker.claimPermissionRequest(expired, request)).toBe(false);
  });

  it('is one-shot and rejects a replayed synthetic click', async () => {
    const storage = new MemorySessionStorage();
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => 2_000,
      () => 'single-use',
    );
    await broker.issue(input);

    await expect(broker.consume('single-use', request)).resolves.toBeDefined();
    await expect(broker.consume('single-use', request)).rejects.toThrow('已过期');
  });

  it('invalidates the token when the SPA route, media epoch, or mode changes', async () => {
    const storage = new MemorySessionStorage();
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => 3_000,
      () => `token-${++sequence}`,
    );
    const routeToken = await broker.issue(input);
    await expect(
      broker.consume(routeToken, { ...request, pageUrl: `${request.pageUrl}?p=2` }),
    ).rejects.toThrow('页面或播放器已变化');

    const epochToken = await broker.issue(input);
    await expect(
      broker.consume(epochToken, { ...request, mediaEpoch: request.mediaEpoch + 1 }),
    ).rejects.toThrow('页面或播放器已变化');

    const modeToken = await broker.issue(input);
    await expect(broker.consume(modeToken, { ...request, mode: 'audio' })).rejects.toThrow(
      '不支持所选下载内容',
    );
  });

  it('expires old grants and can clear every grant for a closed tab', async () => {
    const storage = new MemorySessionStorage();
    let now = 4_000;
    let sequence = 0;
    const broker = new MediaDockProductGrantBroker(
      storage,
      () => now,
      () => `t-${++sequence}`,
    );
    const expired = await broker.issue(input);
    now += MEDIA_DOCK_TOKEN_TTL_MS + 1;
    await expect(broker.consume(expired, request)).rejects.toThrow('已过期');

    await broker.issue(input);
    await broker.issue({ ...input, tabId: 9 });
    await broker.clearTab(input.tabId);
    expect(Object.values(storage.values)).toHaveLength(1);
    expect(Object.values(storage.values)[0]).toMatchObject({ tabId: 9 });
  });

  it('waits for the first-click decision, then creates the Dock after grant or denial', async () => {
    let settlePermission: ((granted: boolean) => void) | undefined;
    const permission = new Promise<boolean>((resolve) => {
      settlePermission = resolve;
    });
    const events: string[] = [];
    const pending = createMergeDockAfterPermissionSettles(permission, async () => {
      events.push('dock');
      return 'opened';
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    settlePermission?.(true);
    await expect(pending).resolves.toBe('opened');
    expect(events).toEqual(['dock']);

    await expect(
      createMergeDockAfterPermissionSettles(Promise.resolve(false), async () => 'denied-dock'),
    ).resolves.toBe('denied-dock');
    await expect(
      createMergeDockAfterPermissionSettles(Promise.reject(new Error('prompt closed')), async () =>
        Promise.resolve('retry-dock'),
      ),
    ).resolves.toBe('retry-dock');
  });
});
