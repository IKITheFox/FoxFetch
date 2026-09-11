import type { StreamTargetChunk } from 'mediabunny';

import type { FileSystemFileHandleLike, FileSystemWritableLike } from './types';

export interface PrivateMergeOutput {
  readonly handle: FileSystemFileHandleLike;
  getBlob(): Promise<Blob>;
  remove(): Promise<void>;
}

const MEMORY_FALLBACK_LIMIT_BYTES = 128 * 1024 * 1024;
const PRIVATE_DIRECTORY = 'foxfetch-private-merge-v1';
const PRIVATE_OUTPUT_TTL_MS = 24 * 60 * 60 * 1_000;

interface PrivateMergeDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry(name: string): Promise<void>;
  entries?: () => AsyncIterableIterator<[string, { kind?: string }]>;
}

function uniqueName(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `dv-${Date.now()}-${id}.mp4`;
}

/** Removes only expired files created by this private DV output allocator. */
export async function cleanupStalePrivateMergeOutputs(
  directory: Pick<PrivateMergeDirectory, 'entries' | 'removeEntry'>,
  options: { now?: number; ttlMs?: number } = {},
): Promise<void> {
  if (typeof directory.entries !== 'function') return;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? PRIVATE_OUTPUT_TTL_MS;
  for await (const [name, entry] of directory.entries()) {
    if (entry.kind !== 'file') continue;
    const match = /^dv-(\d{10,16})-[a-z0-9-]+\.mp4$/iu.exec(name);
    const createdAt = match?.[1] ? Number(match[1]) : Number.NaN;
    if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt <= ttlMs) continue;
    await directory.removeEntry(name).catch(() => undefined);
  }
}

function asMediaFile(blob: Blob, name: string): File {
  if (typeof File === 'function') return new File([blob], name, { type: 'video/mp4' });
  Object.defineProperty(blob, 'name', { configurable: true, value: name });
  return blob as File;
}

function memoryPrivateOutput(): PrivateMergeOutput {
  const name = uniqueName();
  let bytes = new Uint8Array(0);
  let logicalSize = 0;
  let closed = false;
  let removed = false;

  const handle: FileSystemFileHandleLike = {
    name,
    async createWritable() {
      if (closed || removed)
        throw new DOMException('Temporary output is unavailable.', 'InvalidStateError');
      const writable = {
        async write(chunk: StreamTargetChunk) {
          if (closed || removed)
            throw new DOMException('Temporary output is closed.', 'InvalidStateError');
          const end = chunk.position + chunk.data.byteLength;
          if (
            !Number.isSafeInteger(chunk.position) ||
            chunk.position < 0 ||
            !Number.isSafeInteger(end) ||
            end > MEMORY_FALLBACK_LIMIT_BYTES
          ) {
            throw new DOMException(
              'Private output exceeds the bounded in-memory fallback.',
              'QuotaExceededError',
            );
          }
          if (end > bytes.byteLength) {
            let capacity = Math.max(bytes.byteLength, 1024 * 1024);
            while (capacity < end) {
              capacity = Math.min(MEMORY_FALLBACK_LIMIT_BYTES, capacity * 2);
              if (capacity < end && capacity === MEMORY_FALLBACK_LIMIT_BYTES) break;
            }
            const expanded = new Uint8Array(Math.max(end, capacity));
            expanded.set(bytes);
            bytes = expanded;
          }
          bytes.set(chunk.data, chunk.position);
          logicalSize = Math.max(logicalSize, end);
        },
        async close() {
          closed = true;
        },
        async abort() {
          removed = true;
          bytes = new Uint8Array(0);
          logicalSize = 0;
        },
      } as unknown as FileSystemWritableLike;
      return writable;
    },
    async getFile() {
      if (!closed || removed)
        throw new DOMException('Temporary output is unavailable.', 'InvalidStateError');
      return asMediaFile(new Blob([bytes.slice(0, logicalSize)], { type: 'video/mp4' }), name);
    },
  };

  return {
    handle,
    async getBlob() {
      return handle.getFile();
    },
    async remove() {
      removed = true;
      bytes = new Uint8Array(0);
      logicalSize = 0;
    },
  };
}

/**
 * Allocates a private, extension-origin MP4 target. Production Chromium uses
 * OPFS so a large Dolby Vision file never needs to be held in the JS heap.
 * The bounded memory implementation exists only for test/non-OPFS runtimes.
 */
export async function createPrivateMergeOutput(): Promise<PrivateMergeOutput> {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') return memoryPrivateOutput();

  const root = await storage.getDirectory();
  const directory = (await root.getDirectoryHandle(PRIVATE_DIRECTORY, {
    create: true,
  })) as unknown as PrivateMergeDirectory;
  await cleanupStalePrivateMergeOutputs(directory).catch(() => undefined);
  const name = uniqueName();
  const nativeHandle = await directory.getFileHandle(name, { create: true });
  const handle = nativeHandle as unknown as FileSystemFileHandleLike;
  return {
    handle,
    async getBlob() {
      const file = await nativeHandle.getFile();
      return file.slice(0, file.size, 'video/mp4');
    },
    async remove() {
      await directory.removeEntry(name).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
        throw error;
      });
    },
  };
}
