import {
  ExtensionDirectoryHandleStore,
  writeVerifiedBlobToDirectory,
  type StoredDirectoryHandle,
  type WrittenDirectoryFile,
} from './directory-handle-store';

export interface DirectoryHandleLookup {
  get(handleId: string): Promise<StoredDirectoryHandle | undefined>;
}

/**
 * Resolve a handle only under the extension origin and commit a verified Blob.
 * Content scripts receive metadata and opaque ids, never the handle itself.
 */
export async function exportBlobToStoredDirectory(
  handleId: string,
  filename: string,
  blob: Blob,
  expectedSize: number,
  lookup: DirectoryHandleLookup = new ExtensionDirectoryHandleStore(),
): Promise<WrittenDirectoryFile> {
  const record = await lookup.get(handleId);
  if (!record) {
    throw new DOMException('自定义目录已失效，请点击保存位置重新选择。', 'NotFoundError');
  }
  return writeVerifiedBlobToDirectory(record.handle, filename, blob, expectedSize);
}
