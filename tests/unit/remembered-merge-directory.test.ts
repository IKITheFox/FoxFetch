import { describe, expect, it, vi } from 'vitest';
import {
  presentRememberedMergeDirectory,
  resolveRememberedMergeDirectory,
  type RememberedDirectoryStore,
} from '../../src/modules/jobs';
import type {
  DirectoryPermissionState,
  StoredDirectoryHandle,
} from '../../src/modules/downloads/directory-handle-store';

const PAGE = 'https://www.bilibili.com/video/BV1CURRENT';

function fixture(permission: DirectoryPermissionState) {
  const requestPermission = vi.fn(async () => 'granted' as const);
  const record: StoredDirectoryHandle = {
    metadata: { handleId: 'merge-bilibili', name: '我的视频', selectedAt: 123 },
    handle: {
      kind: 'directory',
      name: '我的视频',
      queryPermission: vi.fn(async () => permission),
      requestPermission,
      getDirectoryHandle: vi.fn(),
    },
  };
  const store: RememberedDirectoryStore = { get: vi.fn(async () => record) };
  return { store, record, requestPermission };
}

describe('inline remembered merge directory', () => {
  it('shows only name and availability; a granted directory can be reused without a prompt', async () => {
    const { store, record, requestPermission } = fixture('granted');
    expect(await presentRememberedMergeDirectory(PAGE, store)).toEqual({
      name: '我的视频',
      available: true,
    });
    expect(await resolveRememberedMergeDirectory(PAGE, store)).toEqual(record.metadata);
    expect(store.get).toHaveBeenCalledWith('merge-bilibili');
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it.each(['prompt', 'denied'] as const)(
    'refuses %s without a prompt or changing old policy',
    async (permission) => {
      const { store, requestPermission } = fixture(permission);
      expect(await presentRememberedMergeDirectory(PAGE, store)).toEqual({
        name: '我的视频',
        available: false,
      });
      await expect(resolveRememberedMergeDirectory(PAGE, store)).rejects.toThrow('原位置未更改');
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );
  it('handles missing and unreadable directory stores without inventing authorization', async () => {
    const missing = { get: vi.fn(async () => undefined) };
    expect(await presentRememberedMergeDirectory(PAGE, missing)).toBeUndefined();
    await expect(resolveRememberedMergeDirectory(PAGE, missing)).rejects.toThrow('重新授权');
    const failed = {
      get: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    expect(await presentRememberedMergeDirectory(PAGE, failed)).toBeUndefined();
  });
});
