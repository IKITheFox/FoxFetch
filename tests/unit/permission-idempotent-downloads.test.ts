import { describe, expect, it, vi } from 'vitest';

import {
  PermissionDownloadAttemptStore,
  runIdempotentPermissionDownloads,
  type SessionStorageArea,
} from '../../src/modules/permissions';
import type { DownloadRecord, MediaAsset } from '../../src/shared/types';

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

function asset(id: string): MediaAsset {
  return {
    id,
    url: `https://cdn.example/${id}.m4s`,
    pageUrl: 'https://page.example/watch',
    pageTitle: 'Example',
    frameId: 0,
    kind: id === 'audio' ? 'audio' : 'video',
    detectedBy: ['network'],
    downloadable: true,
    discoveredAt: 1,
  };
}

function record(source: MediaAsset, createdAt: number): DownloadRecord {
  return {
    id: `record-${source.id}`,
    assetId: source.id,
    filename: `${source.id}.m4s`,
    url: source.url,
    kind: source.kind,
    state: 'downloading',
    chromeDownloadId: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('idempotent permission downloads', () => {
  it('returns a completed attempt without starting native downloads again', async () => {
    const store = new PermissionDownloadAttemptStore(new MemorySessionStorage(), () => 100);
    const video = asset('video');
    const execute = vi.fn(async () => [record(video, 101)]);
    const dependencies = {
      store,
      history: vi.fn(async () => []),
      verifyNativeDownload: vi.fn(async () => true),
      execute,
    };

    await expect(
      runIdempotentPermissionDownloads('intent-1', [video], dependencies),
    ).resolves.toEqual([record(video, 101)]);
    await expect(
      runIdempotentPermissionDownloads('intent-1', [video], dependencies),
    ).resolves.toEqual([record(video, 101)]);
    expect(execute).toHaveBeenCalledOnce();
    expect(dependencies.history).not.toHaveBeenCalled();
  });

  it('recovers recorded assets after a worker restart and starts only missing tracks', async () => {
    const store = new PermissionDownloadAttemptStore(new MemorySessionStorage(), () => 200);
    const video = asset('video');
    const audio = asset('audio');
    await store.stage('intent-2', [video, audio]);
    const videoRecord = record(video, 201);
    const execute = vi.fn(async (missing: MediaAsset[]) =>
      missing.map((item) => record(item, 202)),
    );

    const result = await runIdempotentPermissionDownloads('intent-2', [video, audio], {
      store,
      history: vi.fn(async () => [videoRecord]),
      verifyNativeDownload: vi.fn(async () => true),
      execute,
    });

    expect(execute).toHaveBeenCalledWith([audio]);
    expect(result.map((item) => item.assetId)).toEqual(['video', 'audio']);
    await expect(store.read('intent-2')).resolves.toMatchObject({ state: 'completed' });
  });

  it('refuses to reuse a durable attempt for another asset selection', async () => {
    const store = new PermissionDownloadAttemptStore(new MemorySessionStorage(), () => 300);
    await store.stage('intent-3', [asset('video')]);

    await expect(
      runIdempotentPermissionDownloads('intent-3', [asset('audio')], {
        store,
        history: vi.fn(async () => []),
        verifyNativeDownload: vi.fn(async () => true),
        execute: vi.fn(async () => []),
      }),
    ).rejects.toThrow('资源不一致');
  });

  it('retries a queued history record that never received a native download id', async () => {
    const store = new PermissionDownloadAttemptStore(new MemorySessionStorage(), () => 400);
    const video = asset('video');
    await store.stage('intent-4', [video]);
    const queued = { ...record(video, 401), state: 'queued' as const };
    delete queued.chromeDownloadId;
    const replacement = record(video, 402);
    const execute = vi.fn(async () => [replacement]);
    const verifyNativeDownload = vi.fn(async () => true);

    await expect(
      runIdempotentPermissionDownloads('intent-4', [video], {
        store,
        history: vi.fn(async () => [queued]),
        verifyNativeDownload,
        execute,
      }),
    ).resolves.toEqual([replacement]);
    expect(verifyNativeDownload).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith([video]);
  });

  it('reuses only a native download id that can still be verified after restart', async () => {
    const store = new PermissionDownloadAttemptStore(new MemorySessionStorage(), () => 500);
    const video = asset('video');
    await store.stage('intent-5', [video]);
    const started = record(video, 501);
    const execute = vi.fn(async () => []);
    const verifyNativeDownload = vi.fn(
      async (candidate: DownloadRecord) => candidate.chromeDownloadId === started.chromeDownloadId,
    );

    await expect(
      runIdempotentPermissionDownloads('intent-5', [video], {
        store,
        history: vi.fn(async () => [started]),
        verifyNativeDownload,
        execute,
      }),
    ).resolves.toEqual([started]);
    expect(verifyNativeDownload).toHaveBeenCalledWith(started);
    expect(execute).not.toHaveBeenCalled();
  });
});
