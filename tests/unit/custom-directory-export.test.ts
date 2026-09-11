import { describe, expect, it, vi } from 'vitest';

import { exportBlobToStoredDirectory } from '../../src/modules/downloads/custom-directory-export';
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from '../../src/modules/downloads/directory-handle-store';

describe('custom directory export', () => {
  it('fails closed when the opaque directory handle no longer exists', async () => {
    await expect(
      exportBlobToStoredDirectory('missing', 'video.mp4', new Blob(['media']), 5, {
        get: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('重新选择');
  });

  it('writes and verifies through the stored extension-origin handle', async () => {
    let saved = new Blob();
    const fileHandle: FileSystemFileHandleLike = {
      kind: 'file',
      name: 'video.mp4',
      createWritable: vi.fn(async () => ({
        write: vi.fn(async (data: Blob | BufferSource | string) => {
          saved = data instanceof Blob ? data : new Blob([data as BlobPart]);
        }),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
      getFile: vi.fn(async () => new File([saved], 'video.mp4', { type: 'video/mp4' })),
    };
    const directory: FileSystemDirectoryHandleLike = {
      kind: 'directory',
      name: 'Media',
      queryPermission: vi.fn(async () => 'granted' as const),
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(async (name, options) => {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        expect(name).toBe('video.mp4');
        return fileHandle;
      }),
      removeEntry: vi.fn(async () => undefined),
    };
    const blob = new Blob(['media'], { type: 'video/mp4' });
    const result = await exportBlobToStoredDirectory('merge-bilibili', 'video.mp4', blob, 5, {
      get: vi.fn(async () => ({
        metadata: {
          handleId: 'merge-bilibili',
          name: 'Media',
          selectedAt: 1,
        },
        handle: directory,
      })),
    });
    expect(result).toEqual({ fileName: 'video.mp4', size: 5 });
  });
});
