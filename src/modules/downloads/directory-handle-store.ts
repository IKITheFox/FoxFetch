import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import {
  createCustomDownloadDirectoryMetadata,
  type CustomDownloadDirectoryMetadata,
  validateDownloadFilename,
  validateDownloadRelativePath,
} from './download-target';

export type DirectoryPermissionMode = 'read' | 'readwrite';
export type DirectoryPermissionState = 'denied' | 'granted' | 'prompt';

export interface DirectoryPermissionDescriptor {
  mode?: DirectoryPermissionMode;
}

/** Experimental methods are declared locally because lib.dom support varies. */
export interface FileSystemDirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission?(descriptor?: DirectoryPermissionDescriptor): Promise<DirectoryPermissionState>;
  requestPermission?(descriptor?: DirectoryPermissionDescriptor): Promise<DirectoryPermissionState>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle?(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
  removeEntry?(name: string): Promise<void>;
}

export interface FileSystemWritableFileLike {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileSystemFileHandleLike {
  readonly kind?: 'file';
  readonly name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileLike>;
  getFile(): Promise<File>;
}

export interface StoredDirectoryHandle {
  metadata: CustomDownloadDirectoryMetadata;
  handle: FileSystemDirectoryHandleLike;
}

interface DirectoryHandleDatabase extends DBSchema {
  handles: {
    key: string;
    value: StoredDirectoryHandle;
  };
}

export interface ExtensionDirectoryHandleStoreOptions {
  dbName?: string;
  now?: () => number;
  /** Disable only in isolated tests that do not run under chrome-extension://. */
  enforceExtensionOrigin?: boolean;
  origin?: string;
}

const DATABASE_NAME = 'foxfetch-download-targets';
const DATABASE_VERSION = 1;
const STORE_NAME = 'handles';

function currentOrigin(): string {
  try {
    return globalThis.location?.origin ?? '';
  } catch {
    return '';
  }
}

export function assertExtensionDirectoryHandleContext(origin = currentOrigin()): void {
  if (!origin.startsWith('chrome-extension://')) {
    throw new DOMException(
      '目录句柄只能存入扩展自身页面或 Service Worker 的 IndexedDB。',
      'SecurityError',
    );
  }
}

function validPermissionState(value: unknown): value is DirectoryPermissionState {
  return value === 'granted' || value === 'prompt' || value === 'denied';
}

function validateDirectoryHandle(handle: FileSystemDirectoryHandleLike): void {
  if (!handle || handle.kind !== 'directory' || typeof handle.name !== 'string' || !handle.name) {
    throw new TypeError('需要有效的 FileSystemDirectoryHandle');
  }
}

function validateStoredDirectoryHandle(
  record: StoredDirectoryHandle,
  expectedHandleId?: string,
): void {
  validateDirectoryHandle(record.handle);
  const metadata = createCustomDownloadDirectoryMetadata(
    record.metadata.handleId,
    record.metadata.name,
    record.metadata.selectedAt,
  );
  if (
    (expectedHandleId != null && metadata.handleId !== expectedHandleId) ||
    metadata.name !== record.handle.name
  ) {
    throw new DOMException('目录句柄元数据不匹配。', 'DataError');
  }
}

/**
 * Persist directory handles under the extension origin. Do not instantiate this
 * class from a content script: its IndexedDB belongs to the host web page.
 */
export class ExtensionDirectoryHandleStore {
  private readonly dbName: string;
  private readonly now: () => number;
  private dbPromise: Promise<IDBPDatabase<DirectoryHandleDatabase>> | undefined;

  constructor(options: ExtensionDirectoryHandleStoreOptions = {}) {
    if (options.enforceExtensionOrigin !== false) {
      assertExtensionDirectoryHandleContext(options.origin ?? currentOrigin());
    }
    this.dbName = options.dbName ?? DATABASE_NAME;
    this.now = options.now ?? Date.now;
  }

  private database(): Promise<IDBPDatabase<DirectoryHandleDatabase>> {
    this.dbPromise ??= openDB<DirectoryHandleDatabase>(this.dbName, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      },
    });
    return this.dbPromise;
  }

  async save(
    handleId: string,
    handle: FileSystemDirectoryHandleLike,
  ): Promise<StoredDirectoryHandle> {
    validateDirectoryHandle(handle);
    const record: StoredDirectoryHandle = {
      metadata: createCustomDownloadDirectoryMetadata(handleId, handle.name, this.now()),
      handle,
    };
    const database = await this.database();
    await database.put(STORE_NAME, record, handleId);
    return record;
  }

  async get(handleId: string): Promise<StoredDirectoryHandle | undefined> {
    const database = await this.database();
    const record = await database.get(STORE_NAME, handleId);
    if (!record) return undefined;
    validateStoredDirectoryHandle(record, handleId);
    return record;
  }

  /** Restore metadata and its grant together after a failed policy commit. */
  async restore(record: StoredDirectoryHandle): Promise<void> {
    validateStoredDirectoryHandle(record, record.metadata.handleId);
    const database = await this.database();
    await database.put(STORE_NAME, record, record.metadata.handleId);
  }

  async listMetadata(): Promise<CustomDownloadDirectoryMetadata[]> {
    const database = await this.database();
    const records = await database.getAll(STORE_NAME);
    return records.map((record) => {
      validateStoredDirectoryHandle(record);
      return record.metadata;
    });
  }

  async remove(handleId: string): Promise<void> {
    const database = await this.database();
    await database.delete(STORE_NAME, handleId);
  }

  async clear(): Promise<void> {
    const database = await this.database();
    await database.clear(STORE_NAME);
  }

  async close(): Promise<void> {
    const database = await this.dbPromise;
    database?.close();
    this.dbPromise = undefined;
  }
}

export async function queryDirectoryPermission(
  handle: FileSystemDirectoryHandleLike,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState> {
  validateDirectoryHandle(handle);
  if (!handle.queryPermission) return 'prompt';
  const state = await handle.queryPermission({ mode });
  if (!validPermissionState(state)) throw new TypeError('浏览器返回了未知的目录权限状态');
  return state;
}

/** Must be called directly from an explicit user action when the state is prompt. */
export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandleLike,
  mode: DirectoryPermissionMode = 'readwrite',
): Promise<DirectoryPermissionState> {
  validateDirectoryHandle(handle);
  if (!handle.requestPermission) {
    throw new DOMException('当前浏览器不支持恢复目录写入权限。', 'NotSupportedError');
  }
  const state = await handle.requestPermission({ mode });
  if (!validPermissionState(state)) throw new TypeError('浏览器返回了未知的目录权限状态');
  return state;
}

export async function verifyDirectoryPermission(
  handle: FileSystemDirectoryHandleLike,
  options: { mode?: DirectoryPermissionMode; request?: boolean } = {},
): Promise<DirectoryPermissionState> {
  const mode = options.mode ?? 'readwrite';
  const current = await queryDirectoryPermission(handle, mode);
  if (current !== 'prompt' || options.request !== true) return current;
  return requestDirectoryPermission(handle, mode);
}

/** Resolve or create a strictly relative directory below an authorized root. */
export async function resolveDirectoryHandle(
  root: FileSystemDirectoryHandleLike,
  relativeDirectory: string,
  options: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandleLike> {
  validateDirectoryHandle(root);
  const normalized = validateDownloadRelativePath(relativeDirectory);
  let current = root;
  for (const segment of normalized.split('/')) {
    current = await current.getDirectoryHandle(segment, { create: options.create === true });
  }
  return current;
}

function splitFileName(filename: string): { stem: string; extension: string } {
  const index = filename.lastIndexOf('.');
  if (index <= 0) return { stem: filename, extension: '' };
  return { stem: filename.slice(0, index), extension: filename.slice(index) };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

/** Create a new file without silently replacing an existing user file. */
export async function createUniqueDirectoryFile(
  directory: FileSystemDirectoryHandleLike,
  filename: string,
): Promise<FileSystemFileHandleLike> {
  validateDirectoryHandle(directory);
  const getFileHandle = directory.getFileHandle?.bind(directory);
  if (!getFileHandle) {
    throw new DOMException('当前浏览器不支持写入所选目录。', 'NotSupportedError');
  }
  const normalized = validateDownloadFilename(filename);
  const { stem, extension } = splitFileName(normalized);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? normalized : `${stem} (${index})${extension}`;
    try {
      await getFileHandle(candidate);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return getFileHandle(candidate, { create: true });
    }
  }
  throw new DOMException('无法生成不冲突的文件名。', 'InvalidModificationError');
}

export interface WrittenDirectoryFile {
  fileName: string;
  size: number;
}

/**
 * Commit a previously verified local Blob into an authorized directory and
 * re-read it before reporting success. A partial file is removed on failure.
 */
export async function writeVerifiedBlobToDirectory(
  directory: FileSystemDirectoryHandleLike,
  filename: string,
  blob: Blob,
  expectedSize = blob.size,
  options: {
    signal?: AbortSignal;
    /** Persist the actual allocated name before opening a writer. No path or handle escapes. */
    onAllocated?: (file: WrittenDirectoryFile) => Promise<void>;
    /** Called only after removal of this new, uncommitted entry succeeds. */
    onRemoved?: (file: WrittenDirectoryFile) => Promise<void>;
  } = {},
): Promise<WrittenDirectoryFile> {
  options.signal?.throwIfAborted();
  if (!(blob instanceof Blob) || blob.size <= 0 || expectedSize <= 0) {
    throw new DOMException('待保存的媒体文件为空。', 'DataError');
  }
  const permission = await verifyDirectoryPermission(directory);
  if (permission !== 'granted') {
    throw new DOMException('自定义目录需要重新授权，请点击保存位置。', 'NotAllowedError');
  }
  options.signal?.throwIfAborted();
  const handle = await createUniqueDirectoryFile(directory, filename);
  if (options.onAllocated) {
    try {
      await options.onAllocated({ fileName: handle.name, size: expectedSize });
      options.signal?.throwIfAborted();
    } catch (error) {
      // No writer exists yet. Remove only the newly allocated entry; failure
      // must remain visible instead of claiming that ownership was recorded.
      if (!directory.removeEntry) throw new Error('DIRECTORY_CLEANUP_FAILED', { cause: error });
      try {
        await directory.removeEntry(handle.name);
      } catch {
        throw new Error('DIRECTORY_CLEANUP_FAILED');
      }
      await options.onRemoved?.({ fileName: handle.name, size: expectedSize });
      if (options.signal?.aborted) throw error;
      throw new Error('DIRECTORY_CHECKPOINT_FAILED', { cause: error });
    }
  }
  let writable: FileSystemWritableFileLike;
  try {
    writable = await handle.createWritable({ keepExistingData: false });
  } catch (error) {
    // Opt-in task writers recorded this newly allocated entry already. No
    // writer was obtained, so no output was committed by this operation.
    // Preserve the legacy caller behavior when task cancellation is not used.
    if (options.signal) {
      if (!directory.removeEntry) throw new Error('DIRECTORY_CLEANUP_FAILED', { cause: error });
      try {
        await directory.removeEntry(handle.name);
      } catch {
        throw new Error('DIRECTORY_CLEANUP_FAILED', { cause: error });
      }
      await options.onRemoved?.({ fileName: handle.name, size: expectedSize });
    }
    throw error;
  }
  let committed = false;
  let closing = false;
  let aborting: Promise<boolean> | undefined;
  const abort = () => {
    if (!closing && !aborting)
      aborting = Promise.resolve()
        .then(async () => {
          if (!writable.abort) return false;
          await writable.abort(options.signal?.reason);
          return true;
        })
        .catch(() => false);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    if (options.signal) {
      if (!writable.abort)
        throw new DOMException('当前浏览器不支持取消目录写入。', 'NotSupportedError');
      // Opt-in streaming; existing callers keep the original single-Blob write.
      for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        options.signal.throwIfAborted();
        await writable.write(blob.slice(offset, offset + 1024 * 1024));
      }
      options.signal.throwIfAborted();
    } else await writable.write(blob);
    closing = true;
    await writable.close();
    committed = true;
    const file = await handle.getFile();
    if (file.size !== expectedSize) {
      throw new DOMException('保存后的文件大小校验失败。', 'DataError');
    }
    return { fileName: handle.name, size: file.size };
  } catch (error) {
    if (options.signal) {
      // A completed close wins cancellation. Failure to re-read is not proof
      // that a committed file is invalid, so retain it for later verification.
      if (committed) throw error;
      let stopped = aborting
        ? await aborting
        : writable.abort
          ? await writable.abort(error).then(
              () => true,
              () => false,
            )
          : false;
      // FileSystemWritableFileStream may be locked during write(). Now that
      // that write has settled, retry a rejected in-flight abort once.
      if (!stopped && aborting && writable.abort)
        stopped = await writable.abort(error).then(
          () => true,
          () => false,
        );
      if (!stopped) throw new Error('DIRECTORY_WRITE_STATUS_UNAVAILABLE', { cause: error });
      if (!directory.removeEntry) throw new Error('DIRECTORY_CLEANUP_FAILED', { cause: error });
      try {
        await directory.removeEntry(handle.name);
      } catch {
        throw new Error('DIRECTORY_CLEANUP_FAILED');
      }
      await options.onRemoved?.({ fileName: handle.name, size: expectedSize });
    } else {
      if (!committed) await writable.abort?.(error).catch(() => undefined);
      await directory.removeEntry?.(handle.name).catch(() => undefined);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
