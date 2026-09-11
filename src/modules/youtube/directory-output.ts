import {
  ExtensionDirectoryHandleStore,
  verifyDirectoryPermission,
  writeVerifiedBlobToDirectory,
  type StoredDirectoryHandle,
  type WrittenDirectoryFile,
} from '../downloads/directory-handle-store';
import { validateDownloadFilename } from '../downloads/download-target';

type DirectoryLookup = { get(handleId: string): Promise<StoredDirectoryHandle | undefined> };

function assertYouTubeDirectoryId(handleId: string): void {
  if (
    !/^youtube-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      handleId,
    )
  )
    throw new Error('DIRECTORY_TARGET_INVALID');
}

export interface YouTubeDirectoryTarget {
  /** An opaque YouTube-specific handle identity, never a filesystem path. */
  handleId: string;
}

export interface YouTubeDirectoryAllocation extends WrittenDirectoryFile {
  handleId: string;
}

/** Revalidate an already-bound task target; this never grants page authority or
 * requests permission. The caller authenticates and fixes the target at start. */
export async function assertYouTubeDirectoryAccess(
  target: YouTubeDirectoryTarget,
  options: { signal: AbortSignal; assertCurrent: () => Promise<void>; store?: DirectoryLookup },
): Promise<void> {
  const handleId = target.handleId;
  assertYouTubeDirectoryId(handleId);
  options.signal.throwIfAborted();
  await options.assertCurrent();
  options.signal.throwIfAborted();
  const ownedStore = options.store ? undefined : new ExtensionDirectoryHandleStore();
  try {
    const record = await (options.store ?? ownedStore!).get(handleId);
    options.signal.throwIfAborted();
    if (
      !record ||
      record.metadata.handleId !== handleId ||
      record.metadata.name !== record.handle.name
    )
      throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
    if ((await verifyDirectoryPermission(record.handle)) !== 'granted')
      throw new Error('DIRECTORY_PERMISSION_REQUIRED');
    options.signal.throwIfAborted();
    await options.assertCurrent();
    options.signal.throwIfAborted();
  } finally {
    await ownedStore?.close();
  }
}

/** Read-only verification against a still-owned, already-verified source Blob.
 * Never create, delete or repair a file while deciding whether it was saved. */
export async function verifyYouTubeDirectoryOutput(
  allocation: YouTubeDirectoryAllocation,
  verifiedFile: Blob,
  options: { signal: AbortSignal; store?: DirectoryLookup },
): Promise<void> {
  const { handleId, fileName, size } = allocation;
  assertYouTubeDirectoryId(handleId);
  if (validateDownloadFilename(fileName) !== fileName)
    throw new Error('DIRECTORY_FILENAME_INVALID');
  if (
    !(verifiedFile instanceof Blob) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    verifiedFile.size !== size
  )
    throw new Error('DIRECTORY_SOURCE_SIZE_INVALID');
  options.signal.throwIfAborted();
  const ownedStore = options.store ? undefined : new ExtensionDirectoryHandleStore();
  const store = options.store ?? ownedStore!;
  try {
    const record = await store.get(handleId);
    options.signal.throwIfAborted();
    if (
      !record ||
      record.metadata.handleId !== handleId ||
      record.metadata.name !== record.handle.name
    )
      throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
    if ((await verifyDirectoryPermission(record.handle)) !== 'granted')
      throw new Error('DIRECTORY_PERMISSION_REQUIRED');
    options.signal.throwIfAborted();
    if (!record.handle.getFileHandle) throw new Error('DIRECTORY_READ_UNAVAILABLE');
    const handle = await record.handle.getFileHandle(fileName);
    const saved = await handle.getFile();
    if (saved.size !== size) throw new Error('DIRECTORY_OUTPUT_MISMATCH');
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      options.signal.throwIfAborted();
      const [actual, expected] = await Promise.all([
        saved.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        verifiedFile.slice(offset, offset + 1024 * 1024).arrayBuffer(),
      ]);
      options.signal.throwIfAborted();
      const bytes = new Uint8Array(actual),
        reference = new Uint8Array(expected);
      if (
        bytes.length !== reference.length ||
        bytes.some((value, index) => value !== reference[index])
      )
        throw new Error('DIRECTORY_OUTPUT_MISMATCH');
    }
    const after = await handle.getFile();
    options.signal.throwIfAborted();
    if (after.size !== size || after.lastModified !== saved.lastModified)
      throw new Error('DIRECTORY_OUTPUT_CHANGED');
  } finally {
    await ownedStore?.close();
  }
}

/** Internal extension-origin adapter. The task owner must persist allocations
 * and keep them when status/cleanup is unknown; this is not a UI download grant. */
export async function saveYouTubeDirectoryOutput(
  target: YouTubeDirectoryTarget,
  filename: string,
  verifiedFile: Blob,
  expectedBytes: number,
  options: {
    signal: AbortSignal;
    recordAllocation: (allocation: YouTubeDirectoryAllocation) => Promise<void>;
    recordRemoval?: (allocation: YouTubeDirectoryAllocation) => Promise<void>;
    store?: DirectoryLookup;
  },
): Promise<YouTubeDirectoryAllocation> {
  // Capture the chosen target before an asynchronous lookup; later UI changes
  // must not redirect an already-started save.
  const handleId = target.handleId;
  assertYouTubeDirectoryId(handleId);
  if (
    !(verifiedFile instanceof Blob) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    verifiedFile.size !== expectedBytes
  )
    throw new Error('DIRECTORY_SOURCE_SIZE_INVALID');
  options.signal.throwIfAborted();
  const store = options.store ?? new ExtensionDirectoryHandleStore();
  const ownedStore = options.store ? undefined : (store as ExtensionDirectoryHandleStore);
  try {
    const record = await store.get(handleId);
    options.signal.throwIfAborted();
    if (
      !record ||
      record.metadata.handleId !== handleId ||
      record.metadata.name !== record.handle.name
    )
      throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
    // Query only: permission prompts require an explicit picker user gesture.
    if ((await verifyDirectoryPermission(record.handle)) !== 'granted')
      throw new Error('DIRECTORY_PERMISSION_REQUIRED');
    options.signal.throwIfAborted();
    const result = await writeVerifiedBlobToDirectory(
      record.handle,
      filename,
      verifiedFile,
      expectedBytes,
      {
        signal: options.signal,
        onAllocated: async (file) => options.recordAllocation({ handleId, ...file }),
        ...(options.recordRemoval
          ? {
              onRemoved: async (file: WrittenDirectoryFile) =>
                options.recordRemoval!({ handleId, ...file }),
            }
          : {}),
      },
    );
    const allocation = { handleId, ...result };
    // The writer has already committed. A late cancel must not relabel that
    // output as canceled; finish read-only verification without deleting it.
    await verifyYouTubeDirectoryOutput(allocation, verifiedFile, {
      signal: new AbortController().signal,
      store,
    });
    return allocation;
  } finally {
    await ownedStore?.close();
  }
}
