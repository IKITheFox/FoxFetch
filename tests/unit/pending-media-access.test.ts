import { describe, expect, it, vi } from 'vitest';

import {
  MEDIA_ACCESS_INTENT_TTL_MS,
  MediaAccessIntentBroker,
  PendingPermissionIntentStore,
  PermissionIntentBroker,
  PendingMediaAccessIntentStore,
  type PermissionGatedMediaIntent,
  type SessionStorageArea,
} from '../../src/modules/permissions/pending-intents';
import type { MediaAccessIntent } from '../../src/shared/types';

class MemorySessionStorage implements SessionStorageArea {
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

function intent(id: string, createdAt = 1_000, tabId = 3): MediaAccessIntent {
  return {
    id,
    createdAt,
    action: {
      kind: 'merge-assets',
      tabId,
      videoAssetId: 'video',
      audioAssetId: 'audio',
      expectedPageUrl: 'https://example.com/watch',
      expectedMediaEpoch: 1,
    },
  };
}

describe('pending media access intent store', () => {
  it('persists a pending action and its completed idempotent result', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 2_000);
    await store.stage(intent('merge-1'));
    expect((await store.listPending()).map((record) => record.intent.id)).toEqual(['merge-1']);

    await store.complete('merge-1', { mode: 'merge', jobId: 'merge-1' });
    await expect(store.read('merge-1')).resolves.toMatchObject({
      state: 'completed',
      result: { mode: 'merge', jobId: 'merge-1' },
    });
    await expect(store.listPending()).resolves.toEqual([]);
  });

  it('removes expired action-popup continuations', async () => {
    const storage = new MemorySessionStorage();
    let now = 5_000;
    const store = new PendingMediaAccessIntentStore(storage, () => now);
    await store.stage(intent('expired'));
    now += MEDIA_ACCESS_INTENT_TTL_MS + 1;

    await expect(store.read('expired')).resolves.toBeUndefined();
    expect(Object.keys(storage.values)).toEqual([]);
  });

  it('keeps a completed intent when a late cancellation races the UI continuation', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 9_000);
    await store.stage(intent('done'));
    await store.complete('done', { mode: 'merge', jobId: 'done' });
    await store.cancel('done');
    await expect(store.read('done')).resolves.toMatchObject({ state: 'completed' });
  });

  it('cancels an older pending intent for the same tab when a new one is staged', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 10_000);
    await store.stage(intent('older'));

    await store.stage(intent('newer', 2_000));

    await expect(store.read('older')).resolves.toMatchObject({ state: 'cancelled' });
    await expect(store.read('newer')).resolves.toMatchObject({ state: 'pending' });
    await expect(store.listPending()).resolves.toMatchObject([
      { intent: { id: 'newer' }, state: 'pending' },
    ]);
  });

  it('keeps same-id staging idempotent without cancelling the newer active intent', async () => {
    const storage = new MemorySessionStorage();
    let now = 10_000;
    const store = new PendingMediaAccessIntentStore(storage, () => now);
    const older = intent('older');
    await store.stage(older);
    await store.stage(intent('newer', 2_000));
    now = 11_000;

    const restaged = await store.stage(older);

    expect(restaged).toMatchObject({ intent: older, state: 'cancelled', updatedAt: 10_000 });
    await expect(
      store.stage({
        ...older,
        action: { ...older.action, audioAssetId: 'different-audio' },
      }),
    ).rejects.toThrow('标识已被其他操作占用');
    await expect(store.read('newer')).resolves.toMatchObject({ state: 'pending' });
  });

  it('preserves terminal intents when another intent is staged for the same tab', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 12_000);
    await store.stage(intent('completed', 1_000, 1));
    await store.complete('completed', { mode: 'merge', jobId: 'completed' });
    await store.stage(intent('failed', 1_000, 2));
    await store.fail('failed', new Error('failed'));
    await store.stage(intent('cancelled', 1_000, 3));
    await store.cancel('cancelled');

    await store.stage(intent('replacement-completed', 2_000, 1));
    await store.stage(intent('replacement-failed', 2_000, 2));
    await store.stage(intent('replacement-cancelled', 2_000, 3));

    await expect(store.read('completed')).resolves.toMatchObject({ state: 'completed' });
    await expect(store.read('failed')).resolves.toMatchObject({ state: 'failed' });
    await expect(store.read('cancelled')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('keeps pending intents from other tabs', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 15_000);
    await store.stage(intent('tab-three', 1_000, 3));

    await store.stage(intent('tab-four', 2_000, 4));

    await expect(store.listPending()).resolves.toEqual([
      expect.objectContaining({ intent: expect.objectContaining({ id: 'tab-three' }) }),
      expect.objectContaining({ intent: expect.objectContaining({ id: 'tab-four' }) }),
    ]);
  });

  it('executes simultaneous UI and permission-event commits exactly once', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingMediaAccessIntentStore(storage, () => 9_000);
    await store.stage(intent('one-job'));
    let release: (() => void) | undefined;
    const operation = vi.fn(
      (intentId: string) =>
        new Promise<{ mode: 'merge'; jobId: string }>((resolve) => {
          release = () => resolve({ mode: 'merge', jobId: intentId });
        }),
    );
    const broker = new MediaAccessIntentBroker(store, async () => true, operation);

    const uiCommit = broker.commit('one-job');
    const permissionEventCommit = broker.commit('one-job');
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    release?.();
    await expect(Promise.all([uiCommit, permissionEventCommit])).resolves.toEqual([
      { mode: 'merge', jobId: 'one-job' },
      { mode: 'merge', jobId: 'one-job' },
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('generic permission intent broker', () => {
  it('rejects an intent id reused for a different action', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingPermissionIntentStore<PermissionGatedMediaIntent>(
      storage,
      () => 20_000,
      { storagePrefix: 'test:collision:' },
    );
    const firstAction: Extract<PermissionGatedMediaIntent['action'], { kind: 'download-assets' }> =
      {
        kind: 'download-assets',
        tabId: 4,
        assetIds: ['video-1'],
        expectedPageUrl: 'https://example.com/watch',
        expectedMediaEpoch: 1,
      };
    const first: PermissionGatedMediaIntent = {
      id: 'same-id',
      createdAt: 19_000,
      action: firstAction,
    };
    await store.stage(first);

    await expect(
      store.stage({
        ...first,
        action: { ...firstAction, assetIds: ['video-2'] },
      }),
    ).rejects.toThrow('标识已被其他操作占用');
  });

  it('supports direct downloads and returns the persisted result without executing twice', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingPermissionIntentStore<
      PermissionGatedMediaIntent,
      { mode: 'download'; recordIds: string[] }
    >(storage, () => 20_000, { storagePrefix: 'test:permission:', ttlMs: 60_000 });
    const directIntent: PermissionGatedMediaIntent = {
      id: 'direct-1',
      createdAt: 19_000,
      action: {
        kind: 'download-assets',
        tabId: 4,
        assetIds: ['video-1'],
        expectedPageUrl: 'https://www.bilibili.com/video/one',
        expectedMediaEpoch: 0,
      },
    };
    await store.stage(directIntent);
    await store.stage(directIntent);

    const execute = vi.fn(async () => ({ mode: 'download' as const, recordIds: ['record-1'] }));
    const hasAccess = vi.fn(async () => true);
    const broker = new PermissionIntentBroker(store, hasAccess, execute);
    const first = broker.commit(directIntent.id);
    const concurrent = broker.commit(directIntent.id);

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { mode: 'download', recordIds: ['record-1'] },
      { mode: 'download', recordIds: ['record-1'] },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);

    const restoredBroker = new PermissionIntentBroker(store, hasAccess, execute);
    await expect(restoredBroker.commit(directIntent.id)).resolves.toEqual({
      mode: 'download',
      recordIds: ['record-1'],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('checks permission per pending intent when resuming mixed actions', async () => {
    const storage = new MemorySessionStorage();
    const store = new PendingPermissionIntentStore<PermissionGatedMediaIntent, string>(
      storage,
      () => 30_000,
      { storagePrefix: 'test:mixed:' },
    );
    await store.stage({
      id: 'capture',
      createdAt: 29_000,
      action: {
        kind: 'capture-source',
        tabId: 2,
        blobAssetId: 'blob-1',
        expectedPageUrl: 'https://example.com/watch',
        expectedMediaEpoch: 0,
      },
    });
    await store.stage({
      id: 'download',
      createdAt: 29_000,
      action: {
        kind: 'download-assets',
        tabId: 2,
        assetIds: ['video', 'audio'],
        expectedPageUrl: 'https://example.com/watch',
        expectedMediaEpoch: 0,
      },
    });
    const execute = vi.fn(async (intentId: string) => intentId);
    const broker = new PermissionIntentBroker(
      store,
      async (candidate) => candidate.id === 'download',
      execute,
    );

    await broker.resumePending();

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ kind: 'download-assets' }),
      expect.objectContaining({ id: 'download' }),
    );
    await expect(store.read('capture')).resolves.toMatchObject({ state: 'pending' });
    await expect(store.read('download')).resolves.toMatchObject({ state: 'completed' });
  });
});
