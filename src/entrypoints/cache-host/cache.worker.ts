import {
  isMseCacheHostRequest,
  MSE_CACHE_HOST_PROTOCOL_VERSION,
  type MseCacheHostErrorResponse,
  type MseCacheHostRequest,
  type MseCacheHostSuccessResponse,
} from '../../modules/resolver/mse-cache-host-protocol';
import { exportStandardSeparateTrack } from '../../modules/exports';
import {
  MergeError,
  type FileSystemFileHandleLike,
  type FileSystemWritableLike,
} from '../../modules/merge';
import {
  normalizeCapturedTrackFragments,
  type CapturedFragmentPart,
} from '../../modules/resolver/mse-fragment-normalizer';

const CACHE_ROOT = 'foxfetch-mse-cache-v2';
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MERGE_OUTPUT_FILENAME = 'merged-output.bin';

type CacheErrorCode = NonNullable<MseCacheHostErrorResponse['code']>;

class CacheHostError extends Error {
  constructor(
    readonly code: CacheErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CacheHostError';
  }
}

interface SyncAccessHandleLike {
  getSize(): number;
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

interface TrackWriter {
  sessionId: string;
  trackId: string;
  file: FileSystemFileHandle;
  access: SyncAccessHandleLike;
  size: number;
}

interface OutputWriter {
  sessionId: string;
  outputId: string;
  file: FileSystemFileHandle;
  size: number;
  access?: SyncAccessHandleLike;
  writable?: FileSystemWritableFileStream;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function safeEntryName(prefix: string, value: string): string {
  const readable = value
    .normalize('NFKC')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 56);
  return `${prefix}-${readable || 'item'}-${shortHash(value)}`;
}

function trackKey(sessionId: string, trackId: string): string {
  return `${sessionId}\u0000${trackId}`;
}

function outputKey(sessionId: string, outputId: string): string {
  return `${sessionId}\u0000${outputId}`;
}

function assertIdentifier(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 160 ||
    [...value].some((character) => ['\0', '\r', '\n'].includes(character))
  ) {
    throw new CacheHostError('INVALID_REQUEST', `${label}无效。`);
  }
}

function normalizeMaxBytes(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new CacheHostError('INVALID_REQUEST', '缓存快照长度无效。');
  }
  return Math.floor(value);
}

class ExtensionOriginCacheBackend {
  private readonly writers = new Map<string, TrackWriter>();
  private readonly outputWriters = new Map<string, OutputWriter>();
  private readonly sessionTouches = new Map<string, { marker: string; touchedAt: number }>();
  private rootPromise?: Promise<FileSystemDirectoryHandle>;
  private sweepPromise?: Promise<void>;

  async append(
    sessionId: string,
    trackId: string,
    bytes: ArrayBuffer,
  ): Promise<{ persistedBytes: number; availableBytes?: number }> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(trackId, '缓存轨道');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
      throw new CacheHostError('INVALID_REQUEST', '缓存分片大小无效。');
    }
    await this.ensureSwept();
    const availableBytes = await this.ensureQuota(bytes.byteLength);
    const directory = await this.sessionDirectory(sessionId, true);
    await this.touchSession(sessionId, directory);
    const key = trackKey(sessionId, trackId);
    let writer = this.writers.get(key);
    if (!writer) writer = await this.openSyncWriter(sessionId, trackId, directory);

    if (writer) {
      const source = new Uint8Array(bytes);
      let written = 0;
      while (written < source.byteLength) {
        const count = writer.access.write(source.subarray(written), {
          at: writer.size + written,
        });
        if (!Number.isFinite(count) || count <= 0) {
          throw new CacheHostError('STORAGE_FAILED', '浏览器磁盘缓存只写入了部分数据。');
        }
        written += count;
      }
      writer.size += written;
      writer.access.flush();
      return {
        persistedBytes: written,
        ...(availableBytes == null
          ? {}
          : { availableBytes: Math.max(0, availableBytes - written) }),
      };
    }

    const file = await directory.getFileHandle(safeEntryName('track', trackId), { create: true });
    const existing = await file.getFile();
    const writable = await file.createWritable({ keepExistingData: true });
    try {
      await writable.seek(existing.size);
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw error;
    }
    return {
      persistedBytes: bytes.byteLength,
      ...(availableBytes == null
        ? {}
        : { availableBytes: Math.max(0, availableBytes - bytes.byteLength) }),
    };
  }

  async getBlob(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes?: number,
  ): Promise<Blob> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(trackId, '缓存轨道');
    await this.closeWriter(sessionId, trackId);
    const directory = await this.sessionDirectory(sessionId, false);
    const file = await directory.getFileHandle(safeEntryName('track', trackId));
    const snapshot = await file.getFile();
    const limit = normalizeMaxBytes(maxBytes);
    return snapshot.slice(0, limit == null ? snapshot.size : Math.min(limit, snapshot.size), mime);
  }

  async createOutput(sessionId: string, outputId: string): Promise<void> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(outputId, '合并输出');
    await this.ensureSwept();
    await this.closeOutputWriter(sessionId, outputId, true);
    const root = await this.root();
    // Keep committed merge outputs outside the raw-track session directory.
    // clearAfterDownload may remove that session immediately after Chrome
    // accepts the download, while this snapshot must live until downloads.onChanged.
    const directoryName = safeEntryName('output', outputKey(sessionId, outputId));
    await root.removeEntry(directoryName, { recursive: true }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    });
    const directory = await root.getDirectoryHandle(directoryName, { create: true });
    await this.touchSession(outputKey(sessionId, outputId), directory);
    const file = (await directory.getFileHandle(MERGE_OUTPUT_FILENAME, {
      create: true,
    })) as SyncFileHandle;
    const key = outputKey(sessionId, outputId);
    if (typeof file.createSyncAccessHandle === 'function') {
      const access = await file.createSyncAccessHandle();
      access.truncate(0);
      this.outputWriters.set(key, { sessionId, outputId, file, access, size: 0 });
      return;
    }
    const writable = await file.createWritable();
    this.outputWriters.set(key, { sessionId, outputId, file, writable, size: 0 });
  }

  async writeOutput(
    sessionId: string,
    outputId: string,
    position: number,
    bytes: ArrayBuffer,
  ): Promise<{ persistedBytes: number; availableBytes?: number; sizeBytes: number }> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(outputId, '合并输出');
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      bytes.byteLength === 0 ||
      bytes.byteLength > MAX_CHUNK_BYTES
    ) {
      throw new CacheHostError('INVALID_REQUEST', '缓存合并分片位置或大小无效。');
    }
    const endPosition = position + bytes.byteLength;
    if (!Number.isSafeInteger(endPosition)) {
      throw new CacheHostError('INVALID_REQUEST', '缓存合并分片结束位置无效。');
    }
    const writer = this.outputWriters.get(outputKey(sessionId, outputId));
    if (!writer) throw new CacheHostError('INVALID_REQUEST', '缓存合并临时文件尚未创建。');
    const growthBytes = Math.max(0, endPosition - writer.size);
    const availableBytes = await this.ensureQuota(growthBytes);
    const source = new Uint8Array(bytes);
    if (writer.access) {
      let written = 0;
      while (written < source.byteLength) {
        const count = writer.access.write(source.subarray(written), { at: position + written });
        if (!Number.isFinite(count) || count <= 0) {
          throw new CacheHostError('STORAGE_FAILED', '缓存合并分片只写入了部分数据。');
        }
        written += count;
      }
      writer.size = Math.max(writer.size, endPosition);
      writer.access.flush();
    } else if (writer.writable) {
      await writer.writable.write({ type: 'write', position, data: source });
      writer.size = Math.max(writer.size, endPosition);
    } else {
      throw new CacheHostError('STORAGE_FAILED', '缓存合并写入器不可用。');
    }
    return {
      persistedBytes: source.byteLength,
      sizeBytes: writer.size,
      ...(availableBytes == null
        ? {}
        : { availableBytes: Math.max(0, availableBytes - growthBytes) }),
    };
  }

  async closeOutput(sessionId: string, outputId: string): Promise<number> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(outputId, '合并输出');
    await this.closeOutputWriter(sessionId, outputId, false);
    const directory = await this.outputDirectory(sessionId, outputId, false);
    const file = await directory.getFileHandle(MERGE_OUTPUT_FILENAME);
    return (await file.getFile()).size;
  }

  async getOutput(sessionId: string, outputId: string, mime: string): Promise<Blob> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(outputId, '合并输出');
    await this.closeOutputWriter(sessionId, outputId, false);
    const directory = await this.outputDirectory(sessionId, outputId, false);
    const file = await directory.getFileHandle(MERGE_OUTPUT_FILENAME);
    const snapshot = await file.getFile();
    return snapshot.slice(0, snapshot.size, mime);
  }

  async deleteOutput(sessionId: string, outputId: string): Promise<void> {
    assertIdentifier(sessionId, '缓存会话');
    assertIdentifier(outputId, '合并输出');
    await this.closeOutputWriter(sessionId, outputId, true);
    try {
      const root = await this.root();
      await root.removeEntry(safeEntryName('output', outputKey(sessionId, outputId)), {
        recursive: true,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    this.sessionTouches.delete(outputKey(sessionId, outputId));
  }

  async clearSession(sessionId: string): Promise<void> {
    assertIdentifier(sessionId, '缓存会话');
    await this.closeSessionWriters(sessionId);
    await this.closeSessionOutputWriters(sessionId);
    const root = await this.root();
    try {
      await root.removeEntry(safeEntryName('session', sessionId), { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    this.sessionTouches.delete(sessionId);
  }

  async dispose(): Promise<void> {
    for (const writer of [...this.writers.values()]) {
      try {
        writer.access.flush();
        writer.access.close();
      } catch {
        // The browser also releases an OPFS sync handle when this worker exits.
      }
    }
    this.writers.clear();
    for (const writer of [...this.outputWriters.values()]) {
      await this.deleteOutput(writer.sessionId, writer.outputId).catch(() => undefined);
    }
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(CACHE_ROOT, { create: true }));
    return this.rootPromise;
  }

  private async sessionDirectory(
    sessionId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await this.root();
    return root.getDirectoryHandle(safeEntryName('session', sessionId), { create });
  }

  private async outputDirectory(
    sessionId: string,
    outputId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await this.root();
    return root.getDirectoryHandle(safeEntryName('output', outputKey(sessionId, outputId)), {
      create,
    });
  }

  private async openSyncWriter(
    sessionId: string,
    trackId: string,
    directory: FileSystemDirectoryHandle,
  ): Promise<TrackWriter | undefined> {
    const file = (await directory.getFileHandle(safeEntryName('track', trackId), {
      create: true,
    })) as SyncFileHandle;
    if (typeof file.createSyncAccessHandle !== 'function') return undefined;
    const access = await file.createSyncAccessHandle();
    const writer: TrackWriter = {
      sessionId,
      trackId,
      file,
      access,
      size: access.getSize(),
    };
    this.writers.set(trackKey(sessionId, trackId), writer);
    return writer;
  }

  private async closeWriter(sessionId: string, trackId: string): Promise<void> {
    const key = trackKey(sessionId, trackId);
    const writer = this.writers.get(key);
    if (!writer) return;
    this.writers.delete(key);
    writer.access.flush();
    writer.access.close();
  }

  private async closeSessionWriters(sessionId: string): Promise<void> {
    for (const writer of [...this.writers.values()]) {
      if (writer.sessionId === sessionId) await this.closeWriter(sessionId, writer.trackId);
    }
  }

  private async closeOutputWriter(
    sessionId: string,
    outputId: string,
    abort: boolean,
  ): Promise<void> {
    const key = outputKey(sessionId, outputId);
    const writer = this.outputWriters.get(key);
    if (!writer) return;
    if (writer.access) {
      if (!abort) writer.access.flush();
      writer.access.close();
      this.outputWriters.delete(key);
      return;
    }
    if (!writer.writable) return;
    if (abort) await writer.writable.abort();
    else await writer.writable.close();
    this.outputWriters.delete(key);
  }

  private async closeSessionOutputWriters(sessionId: string): Promise<void> {
    for (const writer of [...this.outputWriters.values()]) {
      if (writer.sessionId === sessionId) {
        await this.deleteOutput(sessionId, writer.outputId);
      }
    }
  }

  private async ensureQuota(incomingBytes: number): Promise<number | undefined> {
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota;
    const usage = estimate.usage;
    if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota == null || usage == null) {
      return undefined;
    }
    const reserve = Math.min(
      512 * 1024 * 1024,
      Math.max(32 * 1024 * 1024, quota * 0.02),
      quota * 0.1,
    );
    const available = Math.max(0, quota - usage - reserve);
    if (incomingBytes > available) {
      throw new CacheHostError('QUOTA_EXCEEDED', '浏览器可用磁盘空间不足，已停止接收新缓存。');
    }
    return available;
  }

  private ensureSwept(): Promise<void> {
    this.sweepPromise ??= this.sweepExpiredSessions().catch(() => undefined);
    return this.sweepPromise;
  }

  private async touchSession(
    sessionId: string,
    directory: FileSystemDirectoryHandle,
  ): Promise<void> {
    const now = Date.now();
    const previous = this.sessionTouches.get(sessionId);
    if (previous && now - previous.touchedAt < TOUCH_INTERVAL_MS) return;
    const marker = `updated-${now}`;
    await directory.getFileHandle(marker, { create: true });
    if (previous?.marker && previous.marker !== marker) {
      await directory.removeEntry(previous.marker).catch(() => undefined);
    }
    this.sessionTouches.set(sessionId, { marker, touchedAt: now });
  }

  private async sweepExpiredSessions(): Promise<void> {
    const root = (await this.root()) as IterableDirectoryHandle;
    const cutoff = Date.now() - SESSION_TTL_MS;
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory') continue;
      let newestTouch = 0;
      const directory = handle as IterableDirectoryHandle;
      for await (const [entryName] of directory.entries()) {
        const match = /^updated-(\d+)$/u.exec(entryName);
        const timestamp = match?.[1] ? Number(match[1]) : 0;
        if (Number.isFinite(timestamp)) newestTouch = Math.max(newestTouch, timestamp);
      }
      if (newestTouch === 0 || newestTouch < cutoff) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
    }
  }
}

async function createStandardOutputHandle(
  backend: ExtensionOriginCacheBackend,
  sessionId: string,
  outputId: string,
): Promise<FileSystemFileHandleLike> {
  await backend.createOutput(sessionId, outputId);
  let writableCreated = false;
  let closed = false;
  let removed = false;
  return {
    name: `${outputId}.partial`,
    createWritable: async () => {
      if (writableCreated || removed) {
        throw new CacheHostError('STORAGE_FAILED', '标准缓存临时文件已被使用或清理。');
      }
      writableCreated = true;
      return {
        write: async (chunk) => {
          if (
            closed ||
            removed ||
            !chunk ||
            chunk.type !== 'write' ||
            !(chunk.data instanceof Uint8Array) ||
            !Number.isSafeInteger(chunk.position) ||
            chunk.position < 0
          ) {
            throw new CacheHostError('INVALID_REQUEST', '标准缓存输出分片无效。');
          }
          await backend.writeOutput(sessionId, outputId, chunk.position, chunk.data.slice().buffer);
        },
        close: async () => {
          if (closed || removed) return;
          await backend.closeOutput(sessionId, outputId);
          closed = true;
        },
        abort: async () => {
          if (removed) return;
          closed = true;
          await backend.deleteOutput(sessionId, outputId);
          removed = true;
        },
      } as FileSystemWritableLike;
    },
    getFile: async () => {
      if (!closed || removed) {
        throw new CacheHostError('STORAGE_FAILED', '标准缓存输出尚未提交或已被清理。');
      }
      return (await backend.getOutput(sessionId, outputId, 'application/octet-stream')) as File;
    },
  };
}

function errorResponse(requestId: string, error: unknown): MseCacheHostErrorResponse {
  const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
  const value =
    error instanceof CacheHostError
      ? error
      : new CacheHostError(
          quota ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED',
          quota
            ? '浏览器可用磁盘空间不足，已停止接收新缓存。'
            : error instanceof Error
              ? error.message
              : '浏览器磁盘缓存操作失败。',
          { cause: error },
        );
  return {
    protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: value.message,
    code: value.code,
    ...(error instanceof MergeError ? { failure: error.detail } : {}),
  };
}

function attachPort(port: MessagePort): void {
  const backend = new ExtensionOriginCacheBackend();
  type StandardExportRequest = Extract<MseCacheHostRequest, { operation: 'export-standard-track' }>;
  const activeExports = new Map<
    string,
    { sessionId: string; controller: AbortController; settled: Promise<void> }
  >();
  const postResponse = (response: MseCacheHostSuccessResponse | MseCacheHostErrorResponse) => {
    try {
      port.postMessage(response);
    } catch {
      // A closed caller must not keep an export or the short-operation queue alive.
    }
  };
  const cancelExports = async (sessionId?: string): Promise<void> => {
    const matching = [...activeExports.values()].filter(
      (entry) => sessionId == null || entry.sessionId === sessionId,
    );
    for (const entry of matching) entry.controller.abort();
    await Promise.allSettled(matching.map((entry) => entry.settled));
  };
  const startStandardExport = (
    request: StandardExportRequest,
    parts: readonly CapturedFragmentPart[],
    handle: FileSystemFileHandleLike,
  ): void => {
    const controller = new AbortController();
    const settled = Promise.resolve()
      .then(async () => {
        try {
          const normalized = await normalizeCapturedTrackFragments(parts, request.kind, {
            signal: controller.signal,
          });
          const standardOutput = await exportStandardSeparateTrack(
            normalized.blob,
            request.kind,
            handle,
            parts.reduce((total, part) => total + part.blob.size, 0),
            { signal: controller.signal },
          );
          postResponse({
            protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            standardOutput,
            sizeBytes: standardOutput.verification.sizeBytes,
          });
        } catch (error) {
          await backend.deleteOutput(request.sessionId, request.outputId).catch(() => undefined);
          postResponse(errorResponse(request.requestId, error));
        }
      })
      .finally(() => {
        activeExports.delete(request.requestId);
      });
    activeExports.set(request.requestId, {
      sessionId: request.sessionId,
      controller,
      settled,
    });
  };
  let requestTail = Promise.resolve();
  port.onmessage = (event: MessageEvent<unknown>) => {
    const candidate = event.data;
    const fallbackRequestId =
      candidate && typeof candidate === 'object' && 'requestId' in candidate
        ? String((candidate as { requestId?: unknown }).requestId ?? '')
        : '';
    requestTail = requestTail
      .catch(() => undefined)
      .then(async () => {
        if (!isMseCacheHostRequest(candidate)) {
          if (fallbackRequestId) {
            postResponse(
              errorResponse(
                fallbackRequestId,
                new CacheHostError('INVALID_REQUEST', '缓存宿主请求无效。'),
              ),
            );
          }
          return;
        }
        const request = candidate as MseCacheHostRequest;
        try {
          let response: MseCacheHostSuccessResponse;
          if (request.operation === 'append') {
            const result = await backend.append(request.sessionId, request.trackId, request.bytes);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              ...result,
            };
          } else if (request.operation === 'get-blob') {
            const blob = await backend.getBlob(
              request.sessionId,
              request.trackId,
              request.mime,
              request.maxBytes,
            );
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              blob,
            };
          } else if (request.operation === 'export-standard-track') {
            const parts = await Promise.all(
              request.parts.map(async (part): Promise<CapturedFragmentPart> => ({
                id: part.trackId,
                mime: part.mime,
                firstSequence: part.firstSequence,
                blob: await backend.getBlob(
                  request.sessionId,
                  part.trackId,
                  part.mime,
                  part.maxBytes,
                ),
              })),
            );
            const handle = await createStandardOutputHandle(
              backend,
              request.sessionId,
              request.outputId,
            );
            // Snapshot and allocate under the short OPFS queue, then release it.
            // MP3 encoding may take minutes and must not block subsequent MSE
            // append acknowledgements for the still-playing page.
            startStandardExport(request, parts, handle);
            return;
          } else if (request.operation === 'create-output') {
            await backend.createOutput(request.sessionId, request.outputId);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              sizeBytes: 0,
            };
          } else if (request.operation === 'write-output') {
            const result = await backend.writeOutput(
              request.sessionId,
              request.outputId,
              request.position,
              request.bytes,
            );
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              ...result,
            };
          } else if (request.operation === 'close-output') {
            const sizeBytes = await backend.closeOutput(request.sessionId, request.outputId);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              sizeBytes,
            };
          } else if (request.operation === 'get-output') {
            const blob = await backend.getOutput(request.sessionId, request.outputId, request.mime);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              blob,
              sizeBytes: blob.size,
            };
          } else if (request.operation === 'delete-output') {
            await backend.deleteOutput(request.sessionId, request.outputId);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
            };
          } else if (request.operation === 'clear-session') {
            await cancelExports(request.sessionId);
            await backend.clearSession(request.sessionId);
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
            };
          } else if (request.operation === 'dispose') {
            await cancelExports();
            await backend.dispose();
            response = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
            };
          } else {
            throw new CacheHostError('INVALID_REQUEST', '下载请求必须由扩展页面处理。');
          }
          postResponse(response);
          if (request.operation === 'dispose') port.close();
        } catch (error) {
          postResponse(errorResponse(request.requestId, error));
        }
      });
  };
  port.start();
}

const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  const message = event.data as { type?: unknown } | null;
  const port = event.ports[0];
  if (message?.type !== 'attach-port' || !port) return;
  attachPort(port);
};
