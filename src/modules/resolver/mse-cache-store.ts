import {
  isMseCacheHostResponse,
  MSE_CACHE_HOST_AUTH_PORT_PREFIX,
  MSE_CACHE_HOST_CONNECT,
  MSE_CACHE_HOST_PROTOCOL_VERSION,
  type MseCacheHostRequest,
  type MseCacheHostResponse,
} from './mse-cache-host-protocol';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableLike,
  MergeFailureDetail,
} from '../merge';
import type { CompletedStandardSeparateOutput, StandardSeparateOutputKind } from '../exports';

/**
 * Binary storage used by the MSE capture runtime.
 *
 * The runtime keeps only timing/index metadata in memory. Chromium builds write
 * media bytes to OPFS so a long video does not grow the tab heap linearly.
 * Tests and browsers without OPFS fall back to the in-memory implementation.
 */
export interface MseCacheChunkStore {
  readonly kind: 'opfs' | 'memory';
  append(
    sessionId: string,
    trackId: string,
    bytes: ArrayBuffer,
  ): MseCacheAppendResult | Promise<MseCacheAppendResult>;
  getBlob(sessionId: string, trackId: string, mime: string, maxBytes?: number): Promise<Blob>;
  clearSession(sessionId: string): Promise<void>;
  downloadTrack?(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes: number,
    filename: string,
  ): Promise<MseCacheDownloadResult>;
  createStandardTrackOutput?(
    sessionId: string,
    parts: readonly MseCacheStandardTrackPart[],
    outputId: string,
    kind: StandardSeparateOutputKind,
  ): Promise<MseCacheStandardTrackOutput>;
  createMergeOutput?(
    sessionId: string,
    outputId: string,
    filename: string,
    mime: string,
  ): Promise<MseCacheMergeOutput>;
  dispose?(): void | Promise<void>;
}

export interface MseCacheAppendResult {
  persistedBytes: number;
  availableBytes?: number;
}

export type MseCacheDownloadResult = { downloadId: number } | { customSaved: true };

export interface MseCacheOutputDownloadOptions {
  pageUrl?: string;
  saveAs?: boolean;
}

/** Immutable click-time boundaries for one logical SourceBuffer/changeType track. */
export interface MseCacheStandardTrackPart {
  trackId: string;
  mime: string;
  maxBytes: number;
  firstSequence: number;
}

/**
 * A temporary, extension-origin output used by the cache remuxer. Writes are
 * forwarded in bounded chunks to OPFS; only the final browser download is
 * exposed outside the cache host.
 */
export interface MseCacheMergeOutput {
  readonly handle: FileSystemFileHandleLike;
  download(
    filename: string,
    options?: MseCacheOutputDownloadOptions,
  ): Promise<MseCacheDownloadResult>;
  remove(): Promise<void>;
}

/** A verified MP4/MP3 derived from one normalized logical cache track. */
export interface MseCacheStandardTrackOutput {
  readonly result: CompletedStandardSeparateOutput;
  download(
    filename: string,
    options?: MseCacheOutputDownloadOptions,
  ): Promise<MseCacheDownloadResult>;
  remove(): Promise<void>;
}

export class MseCacheStorageError extends Error {
  constructor(
    message: string,
    options?: ErrorOptions & { code?: string; failure?: MergeFailureDetail },
  ) {
    super(message, options);
    this.name = 'MseCacheStorageError';
    this.code = options?.code;
    this.failure = options?.failure;
  }

  readonly code: string | undefined;
  readonly failure: MergeFailureDetail | undefined;
}

function storageKey(sessionId: string, trackId: string): string {
  return `${sessionId}\u0000${trackId}`;
}

/** Deterministic suffix that also prevents sanitized track-name collisions. */
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

export class MemoryMseCacheChunkStore implements MseCacheChunkStore {
  readonly kind = 'memory' as const;
  private readonly chunks = new Map<string, ArrayBuffer[]>();

  append(sessionId: string, trackId: string, bytes: ArrayBuffer): MseCacheAppendResult {
    const key = storageKey(sessionId, trackId);
    const chunks = this.chunks.get(key) ?? [];
    chunks.push(bytes);
    this.chunks.set(key, chunks);
    return { persistedBytes: bytes.byteLength };
  }

  async getBlob(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes?: number,
  ): Promise<Blob> {
    const blob = new Blob(this.chunks.get(storageKey(sessionId, trackId)) ?? [], { type: mime });
    return maxBytes == null ? blob : blob.slice(0, Math.max(0, maxBytes), mime);
  }

  async clearSession(sessionId: string): Promise<void> {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) this.chunks.delete(key);
    }
  }
}

type OpfsStorageManager = StorageManager & {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
};

interface WritableFileHandle extends FileSystemFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

export class OpfsMseCacheChunkStore implements MseCacheChunkStore {
  readonly kind = 'opfs' as const;
  private rootPromise?: Promise<FileSystemDirectoryHandle>;
  private persistRequested = false;

  constructor(private readonly storage: OpfsStorageManager) {}

  async append(
    sessionId: string,
    trackId: string,
    bytes: ArrayBuffer,
  ): Promise<MseCacheAppendResult> {
    try {
      await this.requestPersistenceOnce();
      const directory = await this.sessionDirectory(sessionId, true);
      const handle = (await directory.getFileHandle(safeEntryName('track', trackId), {
        create: true,
      })) as WritableFileHandle;
      const existing = await handle.getFile();
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(existing.size);
      await writable.write(bytes);
      await writable.close();
      return { persistedBytes: bytes.byteLength };
    } catch (error) {
      const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
      throw new MseCacheStorageError(
        quota
          ? '浏览器缓存空间不足，已安全停止捕获；已写入的数据仍会保留。'
          : '无法写入浏览器磁盘缓存，已安全停止捕获。',
        { cause: error },
      );
    }
  }

  async getBlob(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes?: number,
  ): Promise<Blob> {
    try {
      const directory = await this.sessionDirectory(sessionId, false);
      const handle = await directory.getFileHandle(safeEntryName('track', trackId));
      const file = await handle.getFile();
      return file.slice(0, maxBytes == null ? file.size : Math.max(0, maxBytes), mime);
    } catch (error) {
      throw new MseCacheStorageError('无法读取已捕获的磁盘缓存。', { cause: error });
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    try {
      const root = await this.root();
      await root.removeEntry(safeEntryName('session', sessionId), { recursive: true });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      throw new MseCacheStorageError('无法清理浏览器磁盘缓存。', { cause: error });
    }
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= this.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle('foxfetch-mse-cache-v1', { create: true }));
    return this.rootPromise;
  }

  private async sessionDirectory(
    sessionId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle> {
    const root = await this.root();
    return root.getDirectoryHandle(safeEntryName('session', sessionId), { create });
  }

  private async requestPersistenceOnce(): Promise<void> {
    if (this.persistRequested) return;
    this.persistRequested = true;
    await this.storage.persist?.().catch(() => false);
  }
}

interface PendingHostRequest {
  resolve: (response: MseCacheHostResponse) => void;
  reject: (error: Error) => void;
  timer: number;
}

const CACHE_HOST_READY_REQUEST_ID = '__foxfetch_cache_host_ready__';
const CACHE_HOST_REQUEST_TIMEOUT_MS = 120_000;
const CACHE_HOST_STANDARD_EXPORT_TIMEOUT_MS = 30 * 60_000;
const CACHE_HOST_CONNECT_TIMEOUT_MS = 15_000;

/**
 * A capability-authenticated bridge into a hidden extension-origin iframe.
 * Binary data crosses a MessageChannel with transfer semantics; it never uses
 * Chrome's JSON-only runtime messaging and never touches the host site's OPFS.
 */
export class ExtensionFrameMseCacheChunkStore implements MseCacheChunkStore {
  readonly kind = 'opfs' as const;
  private readonly pending = new Map<string, PendingHostRequest>();
  private connectionPromise: Promise<MessagePort> | undefined;
  private port: MessagePort | undefined;
  private host: HTMLElement | undefined;
  private requestSequence = 0;
  private disposed = false;

  constructor(
    private readonly view: Window,
    private readonly doc: Document,
  ) {}

  async append(
    sessionId: string,
    trackId: string,
    bytes: ArrayBuffer,
  ): Promise<MseCacheAppendResult> {
    const expectedBytes = bytes.byteLength;
    const response = await this.request(
      {
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        operation: 'append',
        sessionId,
        trackId,
        bytes,
      },
      [bytes],
    );
    if (response.persistedBytes !== expectedBytes) {
      throw new MseCacheStorageError('部分缓存片段未能完整写入。', { code: 'STORAGE_FAILED' });
    }
    return {
      persistedBytes: response.persistedBytes,
      ...(response.availableBytes == null ? {} : { availableBytes: response.availableBytes }),
    };
  }

  async getBlob(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes?: number,
  ): Promise<Blob> {
    const response = await this.request({
      protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      operation: 'get-blob',
      sessionId,
      trackId,
      mime,
      ...(maxBytes == null ? {} : { maxBytes }),
    });
    if (!(response.blob instanceof Blob)) {
      throw new MseCacheStorageError('后台缓存程序未返回有效文件。', { code: 'STORAGE_FAILED' });
    }
    return response.blob;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.request({
      protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      operation: 'clear-session',
      sessionId,
    });
  }

  async downloadTrack(
    sessionId: string,
    trackId: string,
    mime: string,
    maxBytes: number,
    filename: string,
  ): Promise<MseCacheDownloadResult> {
    const response = await this.request({
      protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      operation: 'download-track',
      sessionId,
      trackId,
      mime,
      maxBytes,
      filename,
    });
    if (!Number.isInteger(response.downloadId) || Number(response.downloadId) < 0) {
      throw new MseCacheStorageError('浏览器没有创建缓存下载任务。', {
        code: 'DOWNLOAD_FAILED',
      });
    }
    return { downloadId: Number(response.downloadId) };
  }

  async createStandardTrackOutput(
    sessionId: string,
    parts: readonly MseCacheStandardTrackPart[],
    outputId: string,
    kind: StandardSeparateOutputKind,
  ): Promise<MseCacheStandardTrackOutput> {
    const response = await this.request({
      protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      operation: 'export-standard-track',
      sessionId,
      parts: parts.map((part) => ({ ...part })),
      outputId,
      kind,
    });
    const result = response.standardOutput;
    const expectedExtension = kind === 'video' ? '.mp4' : '.mp3';
    const expectedMime = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
    if (
      result?.status !== 'completed' ||
      result.kind !== kind ||
      result.extension !== expectedExtension ||
      result.mimeType !== expectedMime ||
      result.verification.valid !== true ||
      !Number.isSafeInteger(result.verification.sizeBytes) ||
      result.verification.sizeBytes <= 0 ||
      response.sizeBytes !== result.verification.sizeBytes
    ) {
      await this.request({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        operation: 'delete-output',
        sessionId,
        outputId,
      }).catch(() => undefined);
      throw new MseCacheStorageError('后台缓存程序未返回通过检查的媒体文件。', {
        code: 'STORAGE_FAILED',
      });
    }

    let removed = false;
    let downloadSubmitted = false;
    const remove = async (): Promise<void> => {
      if (removed || downloadSubmitted) return;
      await this.request({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        operation: 'delete-output',
        sessionId,
        outputId,
      });
      removed = true;
    };
    return {
      result,
      download: async (filename, options = {}) => {
        if (removed) {
          throw new MseCacheStorageError('生成的缓存文件已被清除。', {
            code: 'DOWNLOAD_FAILED',
          });
        }
        if (!filename.toLowerCase().endsWith(result.extension)) {
          throw new MseCacheStorageError(
            `标准缓存${kind === 'video' ? '视频' : '音频'}必须使用 ${result.extension} 文件名。`,
            { code: 'DOWNLOAD_FAILED' },
          );
        }
        const download = await this.request({
          protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
          requestId: this.nextRequestId(),
          operation: 'download-output',
          sessionId,
          outputId,
          mime: result.mimeType,
          filename,
          ...(options.pageUrl ? { pageUrl: options.pageUrl } : {}),
          ...(options.saveAs == null ? {} : { saveAs: options.saveAs }),
          standardOutput: result,
        });
        if (download.customSaved === true) {
          downloadSubmitted = true;
          return { customSaved: true };
        }
        if (!Number.isInteger(download.downloadId) || Number(download.downloadId) < 0) {
          throw new MseCacheStorageError('浏览器没有创建标准缓存下载任务。', {
            code: 'DOWNLOAD_FAILED',
          });
        }
        downloadSubmitted = true;
        return { downloadId: Number(download.downloadId) };
      },
      remove,
    };
  }

  async createMergeOutput(
    sessionId: string,
    outputId: string,
    filename: string,
    mime: string,
  ): Promise<MseCacheMergeOutput> {
    await this.request({
      protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      operation: 'create-output',
      sessionId,
      outputId,
    });

    let writableCreated = false;
    let closed = false;
    let removed = false;
    let downloadSubmitted = false;
    const deleteOutput = async (): Promise<void> => {
      if (removed || downloadSubmitted) return;
      await this.request({
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        operation: 'delete-output',
        sessionId,
        outputId,
      });
      removed = true;
    };
    const handle: FileSystemFileHandleLike = {
      name: filename,
      createWritable: async () => {
        if (writableCreated || removed) {
          throw new MseCacheStorageError('缓存合并临时文件已被使用或清理。', {
            code: 'STORAGE_FAILED',
          });
        }
        writableCreated = true;
        const writable = {
          write: async (chunk: Parameters<FileSystemWritableLike['write']>[0]) => {
            if (closed || removed) {
              throw new MseCacheStorageError('缓存合并临时文件已经关闭。', {
                code: 'STORAGE_FAILED',
              });
            }
            if (
              !chunk ||
              chunk.type !== 'write' ||
              !(chunk.data instanceof Uint8Array) ||
              !Number.isSafeInteger(chunk.position) ||
              chunk.position < 0
            ) {
              throw new MseCacheStorageError('缓存合并写入请求无效。', {
                code: 'INVALID_REQUEST',
              });
            }
            // Do not detach a buffer still owned by the muxer. The bounded
            // StreamTarget chunk is copied once, then transferred to the host.
            const bytes = chunk.data.slice().buffer;
            const expectedBytes = bytes.byteLength;
            const response = await this.request(
              {
                protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
                requestId: this.nextRequestId(),
                operation: 'write-output',
                sessionId,
                outputId,
                position: chunk.position,
                bytes,
              },
              [bytes],
            );
            if (response.persistedBytes !== expectedBytes) {
              throw new MseCacheStorageError('部分合并缓存未能完整写入。', {
                code: 'STORAGE_FAILED',
              });
            }
          },
          close: async () => {
            if (closed || removed) return;
            await this.request({
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: this.nextRequestId(),
              operation: 'close-output',
              sessionId,
              outputId,
            });
            closed = true;
          },
          abort: async () => {
            closed = true;
            await deleteOutput();
          },
        } as unknown as FileSystemWritableLike;
        return writable;
      },
      getFile: async () => {
        if (!closed || removed) {
          throw new MseCacheStorageError('缓存合并临时文件尚未提交或已被清理。', {
            code: 'STORAGE_FAILED',
          });
        }
        const response = await this.request({
          protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
          requestId: this.nextRequestId(),
          operation: 'get-output',
          sessionId,
          outputId,
          mime,
        });
        if (!(response.blob instanceof Blob)) {
          throw new MseCacheStorageError('后台缓存程序未返回有效的合并文件。', {
            code: 'STORAGE_FAILED',
          });
        }
        // OPFS returns an immutable File snapshot. Keep that backing store
        // instead of rebuilding the whole output in the content-script heap.
        return response.blob as File;
      },
    };

    return {
      handle,
      download: async (downloadFilename, options = {}) => {
        if (!closed || removed) {
          throw new MseCacheStorageError('缓存合并临时文件尚未完成，无法下载。', {
            code: 'DOWNLOAD_FAILED',
          });
        }
        const response = await this.request({
          protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
          requestId: this.nextRequestId(),
          operation: 'download-output',
          sessionId,
          outputId,
          mime,
          filename: downloadFilename,
          ...(options.pageUrl ? { pageUrl: options.pageUrl } : {}),
          ...(options.saveAs == null ? {} : { saveAs: options.saveAs }),
        });
        if (response.customSaved === true) {
          downloadSubmitted = true;
          return { customSaved: true };
        }
        if (!Number.isInteger(response.downloadId) || Number(response.downloadId) < 0) {
          throw new MseCacheStorageError('浏览器没有创建缓存合并下载任务。', {
            code: 'DOWNLOAD_FAILED',
          });
        }
        downloadSubmitted = true;
        return { downloadId: Number(response.downloadId) };
      },
      remove: deleteOutput,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.port) {
      const request: MseCacheHostRequest = {
        protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
        requestId: this.nextRequestId(),
        operation: 'dispose',
      };
      try {
        this.port.postMessage(request);
      } catch {
        // The document may already be unloading.
      }
      this.port.close();
    }
    this.port = undefined;
    this.host?.remove();
    this.host = undefined;
    for (const pending of this.pending.values()) {
      this.view.clearTimeout(pending.timer);
      pending.reject(new MseCacheStorageError('后台缓存程序已关闭。'));
    }
    this.pending.clear();
  }

  private async request(
    request: MseCacheHostRequest,
    transfer: Transferable[] = [],
  ): Promise<Extract<MseCacheHostResponse, { ok: true }>> {
    if (this.disposed) throw new MseCacheStorageError('后台缓存程序已关闭。');
    const port = await this.connect();
    return new Promise((resolve, reject) => {
      const timeoutMs =
        request.operation === 'export-standard-track'
          ? CACHE_HOST_STANDARD_EXPORT_TIMEOUT_MS
          : CACHE_HOST_REQUEST_TIMEOUT_MS;
      const timer = this.view.setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new MseCacheStorageError('浏览器磁盘缓存响应超时。'));
      }, timeoutMs);
      this.pending.set(request.requestId, {
        resolve: (response) => {
          if (!response.ok) {
            reject(
              new MseCacheStorageError(response.error, {
                ...(response.code == null ? {} : { code: response.code }),
                ...(response.failure == null ? {} : { failure: response.failure }),
              }),
            );
            return;
          }
          resolve(response);
        },
        reject,
        timer,
      });
      try {
        port.postMessage(request, transfer);
      } catch (error) {
        this.view.clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(
          error instanceof Error
            ? error
            : new MseCacheStorageError('无法发送浏览器磁盘缓存请求。', { cause: error }),
        );
      }
    });
  }

  private connect(): Promise<MessagePort> {
    this.connectionPromise ??= this.openConnection().catch((error: unknown) => {
      this.connectionPromise = undefined;
      throw error;
    });
    return this.connectionPromise;
  }

  private async openConnection(): Promise<MessagePort> {
    const root = await this.documentRoot();
    const host = this.doc.createElement('span');
    host.setAttribute('aria-hidden', 'true');
    host.style.setProperty('display', 'none', 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const frame = this.doc.createElement('iframe');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('aria-hidden', 'true');
    const source = chrome.runtime.getURL('cache-host.html');
    const nonce = this.createNonce();
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = this.view.setTimeout(
        () => reject(new MseCacheStorageError('后台缓存程序加载超时。')),
        CACHE_HOST_CONNECT_TIMEOUT_MS,
      );
      frame.addEventListener(
        'load',
        () => {
          this.view.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      frame.addEventListener(
        'error',
        () => {
          this.view.clearTimeout(timer);
          reject(new MseCacheStorageError('无法加载后台缓存程序。'));
        },
        { once: true },
      );
    });
    // Scope runtime.onConnect authorization to this exact iframe. Multiple
    // tabs may host cache frames and Chrome broadcasts extension connections
    // to every eligible extension context.
    frame.src = `${source}#${encodeURIComponent(nonce)}`;
    shadow.append(frame);
    root.append(host);
    this.host = host;

    try {
      await loaded;
      await this.authorizeNonce(nonce);
      const channel = new MessageChannel();
      const ready = new Promise<void>((resolve, reject) => {
        const timer = this.view.setTimeout(
          () => reject(new MseCacheStorageError('连接后台缓存程序超时。')),
          CACHE_HOST_CONNECT_TIMEOUT_MS,
        );
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          if (!isMseCacheHostResponse(event.data)) return;
          if (event.data.requestId !== CACHE_HOST_READY_REQUEST_ID || !event.data.ok) return;
          this.view.clearTimeout(timer);
          resolve();
        };
      });
      const target = frame.contentWindow;
      if (!target) throw new MseCacheStorageError('无法访问后台缓存窗口。');
      target.postMessage(
        {
          type: MSE_CACHE_HOST_CONNECT,
          protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
          nonce,
        },
        new URL(source).origin,
        [channel.port2],
      );
      await ready;
      channel.port1.onmessage = this.handlePortMessage;
      channel.port1.onmessageerror = this.handlePortFailure;
      channel.port1.start();
      this.port = channel.port1;
      return channel.port1;
    } catch (error) {
      host.remove();
      this.host = undefined;
      throw error;
    }
  }

  private documentRoot(): Promise<HTMLElement> {
    if (this.doc.documentElement) return Promise.resolve(this.doc.documentElement);
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (!this.doc.documentElement) return;
        observer.disconnect();
        this.view.clearTimeout(timer);
        resolve(this.doc.documentElement);
      });
      const timer = this.view.setTimeout(() => {
        observer.disconnect();
        reject(new MseCacheStorageError('网页尚未创建文档根节点。'));
      }, CACHE_HOST_CONNECT_TIMEOUT_MS);
      observer.observe(this.doc, { childList: true });
    });
  }

  private authorizeNonce(nonce: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: `${MSE_CACHE_HOST_AUTH_PORT_PREFIX}:${nonce}` });
      const timer = this.view.setTimeout(() => {
        port.disconnect();
        reject(new MseCacheStorageError('后台缓存程序授权超时。'));
      }, CACHE_HOST_CONNECT_TIMEOUT_MS);
      port.onMessage.addListener((value: unknown) => {
        const response = value as { ok?: unknown; protocolVersion?: unknown; nonce?: unknown };
        if (
          response.ok !== true ||
          response.protocolVersion !== MSE_CACHE_HOST_PROTOCOL_VERSION ||
          response.nonce !== nonce
        ) {
          return;
        }
        this.view.clearTimeout(timer);
        port.disconnect();
        resolve();
      });
      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) {
          this.view.clearTimeout(timer);
          reject(
            new MseCacheStorageError(chrome.runtime.lastError.message ?? '后台缓存程序授权失败。'),
          );
        }
      });
    });
  }

  private createNonce(): string {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `cache-${this.requestSequence}-${Date.now().toString(36)}`;
  }

  private readonly handlePortMessage = (event: MessageEvent<unknown>): void => {
    if (!isMseCacheHostResponse(event.data)) return;
    const pending = this.pending.get(event.data.requestId);
    if (!pending) return;
    this.pending.delete(event.data.requestId);
    this.view.clearTimeout(pending.timer);
    pending.resolve(event.data);
  };

  private readonly handlePortFailure = (): void => {
    const error = new MseCacheStorageError('无法与后台缓存程序通信。');
    for (const pending of this.pending.values()) {
      this.view.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.port?.close();
    this.port = undefined;
    this.connectionPromise = undefined;
    this.host?.remove();
    this.host = undefined;
  };
}

export function createMseCacheChunkStore(
  view: Pick<Window, 'navigator'> & Partial<Pick<Window, 'document'>> = window,
  doc: Document | undefined = view.document,
): MseCacheChunkStore {
  if (
    doc &&
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.getURL === 'function' &&
    typeof chrome.runtime?.connect === 'function'
  ) {
    return new ExtensionFrameMseCacheChunkStore(view as Window, doc);
  }
  return new MemoryMseCacheChunkStore();
}
