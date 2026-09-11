// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  writeVerifiedBlobToDirectory,
  type FileSystemDirectoryHandleLike,
} from '../../src/modules/downloads/directory-handle-store';

function setup() {
  const chunks: Blob[] = [];
  const write = vi.fn(async (data: Blob | BufferSource | string) => {
    chunks.push(data as Blob);
  });
  const close = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const handle = {
    name: 'video.mp4',
    createWritable: async () => ({ write, close, abort }),
    getFile: async () => new File(chunks, 'video.mp4'),
  };
  const directory: FileSystemDirectoryHandleLike = {
    kind: 'directory',
    name: 'Fixture',
    queryPermission: vi.fn(async () => 'granted' as const),
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(async (_name, options) => {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      return handle;
    }),
    removeEntry: vi.fn(async () => {}),
  };
  return { directory, handle, write, close, abort };
}
it('records removal only after the writer stops and the new entry is removed', async () => {
  const s = setup(),
    controller = new AbortController();
  const order: string[] = [];
  s.write.mockImplementation(async () => {
    controller.abort();
  });
  s.abort.mockImplementation(async () => {
    order.push('abort');
  });
  vi.mocked(s.directory.removeEntry!).mockImplementation(async () => {
    order.push('remove');
  });
  const onRemoved = vi.fn(async () => {
    order.push('record');
  });
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
      onRemoved,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(order).toEqual(['abort', 'remove', 'record']);
  expect(onRemoved).toHaveBeenCalledWith({ fileName: 'video.mp4', size: 1 });
});
it.each([false, true])(
  'handles writer-open failure with cleanup failure=%s',
  async (cleanupFails) => {
    const s = setup();
    const failure = new DOMException('Cannot open writer', 'NotAllowedError');
    vi.spyOn(s.handle, 'createWritable').mockRejectedValue(failure);
    if (cleanupFails) vi.mocked(s.directory.removeEntry!).mockRejectedValue(new Error('denied'));
    const onRemoved = vi.fn(async () => {});
    const result = writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: new AbortController().signal,
      onRemoved,
    });
    if (cleanupFails) await expect(result).rejects.toThrow('DIRECTORY_CLEANUP_FAILED');
    else await expect(result).rejects.toBe(failure);
    expect(s.directory.removeEntry).toHaveBeenCalledExactlyOnceWith('video.mp4');
    expect(onRemoved).toHaveBeenCalledTimes(cleanupFails ? 0 : 1);
    expect(s.write).not.toHaveBeenCalled();
    expect(s.abort).not.toHaveBeenCalled();
  },
);
it('awaits allocation recording with the actual unique name before opening the writer', async () => {
  const s = setup();
  s.handle.name = 'video (1).mp4';
  let finish!: () => void;
  const onAllocated = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const create = vi.spyOn(s.handle, 'createWritable');
  const result = writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
    onAllocated,
  });
  await vi.waitFor(() =>
    expect(onAllocated).toHaveBeenCalledWith({ fileName: 'video (1).mp4', size: 1 }),
  );
  expect(create).not.toHaveBeenCalled();
  finish();
  await expect(result).resolves.toMatchObject({ fileName: 'video (1).mp4', size: 1 });
});
it('keeps the existing non-task writer-open failure behavior unchanged', async () => {
  const s = setup();
  const failure = new Error('writer unavailable');
  vi.spyOn(s.handle, 'createWritable').mockRejectedValue(failure);
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a'])),
  ).rejects.toBe(failure);
  expect(s.directory.removeEntry).not.toHaveBeenCalled();
});
it('does not open a writer when recording the allocation fails', async () => {
  const s = setup();
  const create = vi.spyOn(s.handle, 'createWritable');
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      onAllocated: async () => {
        throw new Error('storage failed');
      },
    }),
  ).rejects.toThrow('DIRECTORY_CHECKPOINT_FAILED');
  expect(create).not.toHaveBeenCalled();
  expect(s.directory.removeEntry).toHaveBeenCalledWith('video.mp4');
});
it('keeps allocation cleanup failure visible and never opens a writer', async () => {
  const s = setup();
  const create = vi.spyOn(s.handle, 'createWritable');
  vi.mocked(s.directory.removeEntry!).mockRejectedValue(new Error('permission revoked'));
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      onAllocated: async () => {
        throw new Error('storage failed');
      },
    }),
  ).rejects.toThrow('DIRECTORY_CLEANUP_FAILED');
  expect(create).not.toHaveBeenCalled();
});
it('retains the file when the writer cannot confirm abort', async () => {
  const s = setup();
  const controller = new AbortController();
  s.write.mockImplementationOnce(async () => {
    controller.abort();
  });
  s.abort.mockRejectedValue(new Error('private browser failure'));
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
    }),
  ).rejects.toThrow('DIRECTORY_WRITE_STATUS_UNAVAILABLE');
  expect(s.directory.removeEntry).not.toHaveBeenCalled();
  expect(s.close).not.toHaveBeenCalled();
});
it('retries an in-flight abort once after the pending write settles', async () => {
  const s = setup();
  const controller = new AbortController();
  s.write.mockImplementationOnce(async () => {
    controller.abort();
  });
  s.abort.mockRejectedValueOnce(new TypeError('stream locked'));
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(s.abort).toHaveBeenCalledTimes(2);
  expect(s.directory.removeEntry).toHaveBeenCalledTimes(1);
});
it('reports cleanup failure instead of silently claiming cancellation finished', async () => {
  const s = setup();
  const controller = new AbortController();
  s.write.mockImplementationOnce(async () => {
    controller.abort();
  });
  vi.mocked(s.directory.removeEntry!).mockRejectedValue(new Error('permission revoked'));
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
    }),
  ).rejects.toThrow('DIRECTORY_CLEANUP_FAILED');
});
it('does not delete committed output when its verification read fails', async () => {
  const s = setup();
  s.handle.getFile = async () => {
    throw new Error('read denied');
  };
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('read denied');
  expect(s.close).toHaveBeenCalledTimes(1);
  expect(s.abort).not.toHaveBeenCalled();
  expect(s.directory.removeEntry).not.toHaveBeenCalled();
});
it('writes bounded chunks only when cancellable saving is requested', async () => {
  const s = setup();
  const blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 3)]);
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', blob, blob.size, {
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ size: blob.size });
  expect(s.write.mock.calls.map(([b]) => (b as Blob).size)).toEqual([1024 * 1024, 1024 * 1024, 3]);
  expect(s.abort).not.toHaveBeenCalled();
});
it('cancels during a chunk without closing or writing subsequent chunks', async () => {
  const s = setup();
  const controller = new AbortController();
  s.write.mockImplementationOnce(async () => {
    controller.abort();
  });
  const blob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', blob, blob.size, {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(s.abort).toHaveBeenCalledTimes(1);
  expect(s.close).not.toHaveBeenCalled();
  expect(s.directory.removeEntry).toHaveBeenCalledWith('video.mp4');
});
it('does not create a file for an already canceled request', async () => {
  const s = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(s.directory.getFileHandle).not.toHaveBeenCalled();
});
it('preserves an actually committed file when cancellation arrives during close', async () => {
  const s = setup();
  const controller = new AbortController();
  s.close.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(
    writeVerifiedBlobToDirectory(s.directory, 'video.mp4', new Blob(['a']), 1, {
      signal: controller.signal,
    }),
  ).resolves.toMatchObject({ size: 1 });
  expect(s.abort).not.toHaveBeenCalled();
  expect(s.directory.removeEntry).not.toHaveBeenCalled();
});
