import { describe, expect, it, vi } from 'vitest';

import {
  createMseCacheChunkStore,
  ExtensionFrameMseCacheChunkStore,
  MemoryMseCacheChunkStore,
  MseCacheStorageError,
  OpfsMseCacheChunkStore,
} from '../../src/modules/resolver/mse-cache-store';
import {
  MSE_CACHE_HOST_PROTOCOL_VERSION,
  type MseCacheHostRequest,
  type MseCacheHostSuccessResponse,
} from '../../src/modules/resolver/mse-cache-host-protocol';

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

describe('MSE cache chunk storage', () => {
  it('keeps an immutable byte-length snapshot while capture continues', async () => {
    const store = new MemoryMseCacheChunkStore();
    await store.append('session', 'video', bytes('first'));
    await store.append('session', 'video', bytes('-second'));

    await expect((await store.getBlob('session', 'video', 'video/mp4', 5)).text()).resolves.toBe(
      'first',
    );
    await expect((await store.getBlob('session', 'video', 'video/mp4')).text()).resolves.toBe(
      'first-second',
    );
    await store.clearSession('session');
    expect((await store.getBlob('session', 'video', 'video/mp4')).size).toBe(0);
  });

  it('falls back to memory only when OPFS is unavailable', () => {
    const store = createMseCacheChunkStore({ navigator: {} as Navigator });
    expect(store).toBeInstanceOf(MemoryMseCacheChunkStore);
    expect(store.kind).toBe('memory');
  });

  it('appends to OPFS, requests persistence once, slices snapshots, and clears sessions', async () => {
    const sessionDirectories = new Map<string, Map<string, Uint8Array>>();
    const persist = vi.fn(async () => true);
    const getDirectory = vi.fn(async () => {
      const root = {
        async getDirectoryHandle(name: string) {
          expect(name).toBe('foxfetch-mse-cache-v1');
          return {
            async getDirectoryHandle(sessionName: string, options?: { create?: boolean }) {
              let files = sessionDirectories.get(sessionName);
              if (!files && options?.create) {
                files = new Map();
                sessionDirectories.set(sessionName, files);
              }
              if (!files) throw new DOMException('missing', 'NotFoundError');
              return {
                async getFileHandle(fileName: string, fileOptions?: { create?: boolean }) {
                  if (!files!.has(fileName) && fileOptions?.create) {
                    files!.set(fileName, new Uint8Array());
                  }
                  if (!files!.has(fileName)) throw new DOMException('missing', 'NotFoundError');
                  return {
                    async getFile() {
                      const contents = files!.get(fileName)!;
                      const snapshot = contents.buffer.slice(
                        contents.byteOffset,
                        contents.byteOffset + contents.byteLength,
                      ) as ArrayBuffer;
                      return new File([snapshot], fileName);
                    },
                    async createWritable() {
                      let position = 0;
                      return {
                        async seek(nextPosition: number) {
                          position = nextPosition;
                        },
                        async write(value: ArrayBuffer) {
                          const previous = files!.get(fileName) ?? new Uint8Array();
                          const incoming = new Uint8Array(value);
                          const next = new Uint8Array(
                            Math.max(previous.byteLength, position + incoming.byteLength),
                          );
                          next.set(previous);
                          next.set(incoming, position);
                          files!.set(fileName, next);
                          position += incoming.byteLength;
                        },
                        async close() {},
                      };
                    },
                  };
                },
              };
            },
            async removeEntry(sessionName: string) {
              if (!sessionDirectories.delete(sessionName)) {
                throw new DOMException('missing', 'NotFoundError');
              }
            },
          };
        },
      };
      return root;
    });
    const store = new OpfsMseCacheChunkStore({
      getDirectory,
      persist,
    } as unknown as StorageManager & { getDirectory(): Promise<FileSystemDirectoryHandle> });

    await store.append('session', 'video', bytes('abc'));
    await store.append('session', 'video', bytes('def'));
    expect(store.kind).toBe('opfs');
    expect(persist).toHaveBeenCalledOnce();
    expect(getDirectory).toHaveBeenCalledOnce();
    await expect((await store.getBlob('session', 'video', 'video/mp4', 4)).text()).resolves.toBe(
      'abcd',
    );

    await store.clearSession('session');
    await expect(store.getBlob('session', 'video', 'video/mp4')).rejects.toBeInstanceOf(
      MseCacheStorageError,
    );
  });

  it('streams random-position merge output through the extension host and delegates cleanup after download', async () => {
    const outputBlob = new Blob(['merged-output'], { type: 'video/mp4' });
    const request = vi.fn(
      async (message: MseCacheHostRequest): Promise<MseCacheHostSuccessResponse> => ({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: message.requestId,
        ok: true,
        ...(message.operation === 'write-output'
          ? { persistedBytes: message.bytes.byteLength, sizeBytes: 128 }
          : {}),
        ...(message.operation === 'get-output' ? { blob: outputBlob } : {}),
        ...(message.operation === 'download-output' ? { downloadId: 23 } : {}),
      }),
    );
    const store = new ExtensionFrameMseCacheChunkStore(window, document);
    Object.defineProperty(store, 'request', { value: request });

    const output = await store.createMergeOutput('session', 'output', 'Demo.mp4', 'video/mp4');
    const writable = await output.handle.createWritable();
    const original = new Uint8Array([1, 2, 3, 4]);
    await writable.write({ type: 'write', position: 64, data: original });
    expect([...original]).toEqual([1, 2, 3, 4]);
    await writable.close();
    await expect(output.handle.getFile()).resolves.toBe(outputBlob);
    await expect(output.download('FoxFetch/Bilibili/Demo.mp4')).resolves.toEqual({
      downloadId: 23,
    });
    await output.remove();

    const operations = request.mock.calls.map(([message]) => message.operation);
    expect(operations).toEqual([
      'create-output',
      'write-output',
      'close-output',
      'get-output',
      'download-output',
    ]);
    const writeRequest = request.mock.calls.find(
      ([message]) => message.operation === 'write-output',
    )?.[0];
    expect(writeRequest).toMatchObject({ position: 64 });
    if (writeRequest?.operation !== 'write-output') throw new Error('write request missing');
    expect(writeRequest.bytes).not.toBe(original.buffer);
    expect([...new Uint8Array(writeRequest.bytes)]).toEqual([1, 2, 3, 4]);
  });

  it('removes an abandoned merge output exactly once', async () => {
    const request = vi.fn(
      async (message: MseCacheHostRequest): Promise<MseCacheHostSuccessResponse> => ({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: message.requestId,
        ok: true,
      }),
    );
    const store = new ExtensionFrameMseCacheChunkStore(window, document);
    Object.defineProperty(store, 'request', { value: request });
    const output = await store.createMergeOutput('session', 'abandoned', 'Demo.mp4', 'video/mp4');

    await output.remove();
    await output.remove();
    expect(request.mock.calls.map(([message]) => message.operation)).toEqual([
      'create-output',
      'delete-output',
    ]);
  });

  it('exports a captured track through the verified standard-output host before download', async () => {
    const standardOutput = {
      status: 'completed' as const,
      kind: 'audio' as const,
      extension: '.mp3' as const,
      mimeType: 'audio/mpeg' as const,
      sourceCodec: 'aac' as const,
      outputCodec: 'mp3' as const,
      verification: {
        valid: true as const,
        sizeBytes: 4096,
        formatName: 'MP3',
        codec: 'mp3' as const,
        durationSeconds: 12,
      },
    };
    const request = vi.fn(
      async (message: MseCacheHostRequest): Promise<MseCacheHostSuccessResponse> => ({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: message.requestId,
        ok: true,
        ...(message.operation === 'export-standard-track'
          ? { standardOutput, sizeBytes: standardOutput.verification.sizeBytes }
          : {}),
        ...(message.operation === 'download-output' ? { customSaved: true as const } : {}),
      }),
    );
    const store = new ExtensionFrameMseCacheChunkStore(window, document);
    Object.defineProperty(store, 'request', { value: request });

    const output = await store.createStandardTrackOutput(
      'session',
      [
        {
          trackId: 'audio-track',
          mime: 'audio/mp4; codecs="mp4a.40.2"',
          maxBytes: 8192,
          firstSequence: 4,
        },
      ],
      'standard-audio',
      'audio',
    );
    expect(output.result).toEqual(standardOutput);
    await expect(output.download('FoxFetch/Bilibili/Demo.m4a')).rejects.toThrow(
      '必须使用 .mp3 文件名',
    );
    await expect(
      output.download('FoxFetch/Bilibili/Demo.mp3', {
        pageUrl: 'https://www.bilibili.com/video/BV1test',
        saveAs: true,
      }),
    ).resolves.toEqual({ customSaved: true });
    await output.remove();

    expect(request.mock.calls.map(([message]) => message.operation)).toEqual([
      'export-standard-track',
      'download-output',
    ]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: 'audio',
      parts: [
        {
          trackId: 'audio-track',
          maxBytes: 8192,
          firstSequence: 4,
        },
      ],
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      mime: 'audio/mpeg',
      filename: 'FoxFetch/Bilibili/Demo.mp3',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
      saveAs: true,
      standardOutput,
    });
  });
});
