import { describe, expect, it, vi } from 'vitest';
import { createStrictRangeFetch } from '../../src/modules/merge/range-source';
import {
  stageMergeInputsToOpfs,
  type MergeStagingDirectory,
} from '../../src/modules/merge/staging';

const request = {
  video: { url: 'https://media.example/video.m4s' },
  audio: { url: 'https://media.example/audio.m4s' },
};

class Writer {
  readonly chunks: BlobPart[] = [];
  readonly abort = vi.fn(async () => undefined);
  close = vi.fn(async (): Promise<void> => undefined);
  write = vi.fn(async (data: BufferSource | Blob | string) => {
    this.chunks.push(
      typeof data === 'string' || data instanceof Blob
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
          : new Uint8Array(data).slice().buffer,
    );
  });
}
class Handle {
  writer = new Writer();
  async createWritable() {
    this.writer = new Writer();
    return this.writer;
  }
  async getFile() {
    return new File(this.writer.chunks, 'track.input');
  }
}
class Directory implements MergeStagingDirectory {
  files = new Map<string, Handle>();
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
      this.files.set(name, new Handle());
    }
    return this.files.get(name)!;
  }
  async removeEntry(name: string) {
    this.files.delete(name);
  }
}

describe('independent v0.13 range/staging boundary audit', () => {
  it('rejects a same-size changed Last-Modified resource during random reads without ETag', async () => {
    let count = 0;
    const fetcher = createStrictRangeFetch(
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 206,
            headers: {
              'content-range': 'bytes 0-1/4',
              'last-modified':
                ++count === 1 ? 'Sun, 06 Sep 2026 01:00:00 GMT' : 'Sun, 06 Sep 2026 02:00:00 GMT',
            },
          }),
      ),
    );
    await fetcher(request.video.url, { headers: { Range: 'bytes=0-1' } });
    await expect(
      fetcher(request.video.url, { headers: { Range: 'bytes=0-1' } }),
    ).rejects.toMatchObject({ detail: { reason: 'RANGE_INVALID' } });
  });

  it('releases a createWritable result that arrives after cancellation', async () => {
    const root = new Directory();
    const handle = new Handle();
    const lateWriter = new Writer();
    let resolveWriter!: (writer: Writer) => void;
    const pendingWriter = new Promise<Writer>((resolve) => {
      resolveWriter = resolve;
    });
    const opened = vi.fn();
    handle.createWritable = async () => {
      opened();
      return pendingWriter;
    };
    const normalGet = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (options?.create && name.includes('-video.input')) {
        root.files.set(name, handle);
        return handle;
      }
      return normalGet(name, options);
    };
    const controller = new AbortController();
    const operation = stageMergeInputsToOpfs(request, 'late-writer', {
      root,
      signal: controller.signal,
      skipSourceSelection: true,
      fetchFn: vi.fn(async () => new Response(new Uint8Array([8]))),
    });
    // Attach before cancellation to avoid an unhandled rejection during the interleaving.
    const rejected = expect(operation).rejects.toBeDefined();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    controller.abort();
    resolveWriter(lateWriter);
    await rejected;
    await vi.waitFor(() => expect(lateWriter.abort).toHaveBeenCalled());
    expect(lateWriter.write).not.toHaveBeenCalled();
  });

  it('rejects an actual closed OPFS file shorter than the verified HTTP transfer', async () => {
    const root = new Directory();
    const normalGet = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      const handle = await normalGet(name, options);
      if (name.includes('-video.input'))
        handle.getFile = async () => new File([new Uint8Array([1])], 'short.input');
      return handle;
    };
    await expect(
      stageMergeInputsToOpfs(request, 'short-file', {
        root,
        skipSourceSelection: true,
        fetchFn: vi.fn(
          async () =>
            new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } }),
        ),
      }),
    ).rejects.toBeDefined();
    expect(root.files.size).toBe(0);
  });

  it.each(['write', 'close'] as const)(
    'retains a pending native %s owner until the operation really settles after abort',
    async (method) => {
      const root = new Directory();
      const handle = new Handle();
      const writer = new Writer();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = vi.fn();
      writer[method].mockImplementation(async () => {
        entered();
        return pending;
      });
      handle.createWritable = async () => writer;
      const normalGet = root.getFileHandle.bind(root);
      root.getFileHandle = async (name, options) => {
        if (options?.create && name.includes('-video.input')) {
          root.files.set(name, handle);
          return handle;
        }
        return normalGet(name, options);
      };
      const controller = new AbortController();
      const operation = stageMergeInputsToOpfs(request, `pending-${method}`, {
        root,
        signal: controller.signal,
        skipSourceSelection: true,
        fetchFn: vi.fn(async () => new Response(new Uint8Array([1]))),
      });
      const rejected = expect(operation).rejects.toBeDefined();
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      controller.abort();
      await vi.waitFor(() => expect(writer.abort).toHaveBeenCalled());
      for (let index = 0; index < 30; index++) await Promise.resolve();
      const settledBeforeNativeOperation = settled;
      release();
      await rejected;
      expect(settledBeforeNativeOperation).toBe(false);
      expect(root.files.size).toBe(0);
    },
  );

  it('removes a created sibling file when the other getFileHandle fails before downloads start', async () => {
    const root = new Directory();
    const normalGet = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (options?.create && name.includes('-audio.input'))
        throw new DOMException('No space', 'QuotaExceededError');
      return normalGet(name, options);
    };
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1])));
    await expect(
      stageMergeInputsToOpfs(request, 'half-open', { root, skipSourceSelection: true, fetchFn }),
    ).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(root.files.size).toBe(0);
  });
});
