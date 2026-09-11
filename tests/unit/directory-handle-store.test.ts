import { describe, expect, it, vi } from 'vitest';

import {
  ExtensionDirectoryHandleStore,
  assertExtensionDirectoryHandleContext,
  createUniqueDirectoryFile,
  resolveDirectoryHandle,
  verifyDirectoryPermission,
  writeVerifiedBlobToDirectory,
  type FileSystemFileHandleLike,
  type FileSystemDirectoryHandleLike,
} from '../../src/modules/downloads/directory-handle-store';

function permissionHandle(
  query: 'denied' | 'granted' | 'prompt',
  request: 'denied' | 'granted' | 'prompt' = query,
): FileSystemDirectoryHandleLike {
  return {
    kind: 'directory',
    name: 'Media',
    queryPermission: vi.fn(async () => query),
    requestPermission: vi.fn(async () => request),
    getDirectoryHandle: vi.fn(),
  };
}

describe('extension directory handle store', () => {
  it('restores original grant metadata exactly after a failed path-policy promotion', async () => {
    let now = 123;
    const store = new ExtensionDirectoryHandleStore({
      dbName: `foxfetch-test-${crypto.randomUUID()}`,
      enforceExtensionOrigin: false,
      now: () => now,
    });
    const original = await store.save('merge-bilibili', {
      kind: 'directory',
      name: 'Original',
    } as FileSystemDirectoryHandleLike);
    now = 456;
    await store.save('merge-bilibili', {
      kind: 'directory',
      name: 'Replacement',
    } as FileSystemDirectoryHandleLike);
    await store.restore(original);
    await expect(store.get('merge-bilibili')).resolves.toEqual(original);
    await store.close();
  });

  it('rejects accidental construction under a host-page origin', () => {
    expect(() => assertExtensionDirectoryHandleContext('https://www.bilibili.com')).toThrow(
      '扩展自身页面',
    );
    expect(() =>
      assertExtensionDirectoryHandleContext('chrome-extension://extension-id'),
    ).not.toThrow();
  });

  it('stores the handle and non-sensitive metadata in IndexedDB', async () => {
    const store = new ExtensionDirectoryHandleStore({
      dbName: `foxfetch-test-${crypto.randomUUID()}`,
      enforceExtensionOrigin: false,
      now: () => 456,
    });
    // Native handles are structured-cloneable. A data-only stand-in exercises
    // the IndexedDB record shape under fake-indexeddb.
    const handle = { kind: 'directory', name: 'Downloads' } as FileSystemDirectoryHandleLike;

    await expect(store.save('output-root', handle)).resolves.toMatchObject({
      metadata: { handleId: 'output-root', name: 'Downloads', selectedAt: 456 },
    });
    await expect(store.get('output-root')).resolves.toMatchObject({
      metadata: { handleId: 'output-root', name: 'Downloads', selectedAt: 456 },
      handle: { kind: 'directory', name: 'Downloads' },
    });
    await expect(store.listMetadata()).resolves.toEqual([
      { handleId: 'output-root', name: 'Downloads', selectedAt: 456 },
    ]);
    await store.remove('output-root');
    await expect(store.get('output-root')).resolves.toBeUndefined();
    await store.close();
  });
});

describe('directory permission and relative traversal', () => {
  it('does not request again when read/write permission is already granted', async () => {
    const handle = permissionHandle('granted');
    await expect(verifyDirectoryPermission(handle, { request: true })).resolves.toBe('granted');
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('requests only when the caller explicitly allows a user-gesture request', async () => {
    const handle = permissionHandle('prompt', 'granted');
    await expect(verifyDirectoryPermission(handle)).resolves.toBe('prompt');
    expect(handle.requestPermission).not.toHaveBeenCalled();
    await expect(verifyDirectoryPermission(handle, { request: true })).resolves.toBe('granted');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('creates only validated child directories below the selected root', async () => {
    const visited: string[] = [];
    const makeHandle = (name: string): FileSystemDirectoryHandleLike => ({
      kind: 'directory',
      name,
      getDirectoryHandle: vi.fn(async (child, options) => {
        visited.push(`${child}:${String(options?.create)}`);
        return makeHandle(child);
      }),
    });
    const resolved = await resolveDirectoryHandle(makeHandle('root'), 'FoxFetch/Bilibili/video', {
      create: true,
    });

    expect(resolved.name).toBe('video');
    expect(visited).toEqual(['FoxFetch:true', 'Bilibili:true', 'video:true']);
    await expect(resolveDirectoryHandle(makeHandle('root'), '../escape')).rejects.toThrow(
      '无效的下载相对路径',
    );
  });

  it('uniquifies names and verifies the committed custom-directory file', async () => {
    const files = new Map<string, Blob>([['demo.mp4', new Blob(['old'])]]);
    const directory: FileSystemDirectoryHandleLike = {
      kind: 'directory',
      name: 'Media',
      queryPermission: vi.fn(async () => 'granted' as const),
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(async (name, options) => {
        if (!options?.create && !files.has(name)) {
          throw new DOMException('missing', 'NotFoundError');
        }
        let staged = files.get(name) ?? new Blob();
        return {
          kind: 'file',
          name,
          createWritable: vi.fn(async () => ({
            write: vi.fn(async (data: Blob | BufferSource | string) => {
              staged = data instanceof Blob ? data : new Blob([data as BlobPart]);
            }),
            close: vi.fn(async () => {
              files.set(name, staged);
            }),
            abort: vi.fn(async () => undefined),
          })),
          getFile: vi.fn(
            async () => new File([files.get(name) ?? staged], name, { type: 'video/mp4' }),
          ),
        } satisfies FileSystemFileHandleLike;
      }),
      removeEntry: vi.fn(async (name) => {
        files.delete(name);
      }),
    };

    const blob = new Blob(['verified-media'], { type: 'video/mp4' });
    await expect(writeVerifiedBlobToDirectory(directory, 'demo.mp4', blob)).resolves.toEqual({
      fileName: 'demo (1).mp4',
      size: blob.size,
    });
    expect(files.get('demo (1).mp4')?.size).toBe(blob.size);
    await expect(createUniqueDirectoryFile(directory, '../escape.mp4')).rejects.toThrow(
      '无效的下载相对路径',
    );
  });

  it('never requests a custom-directory permission outside a fresh user gesture', async () => {
    const directory = permissionHandle('prompt', 'granted');
    await expect(
      writeVerifiedBlobToDirectory(directory, 'demo.mp4', new Blob(['media'])),
    ).rejects.toThrow('重新授权');
    expect(directory.requestPermission).not.toHaveBeenCalled();
  });
});
