import type {
  StoredDirectoryHandle,
  FileSystemDirectoryHandleLike,
} from '../downloads/directory-handle-store';
import type { MergeDownloadPathPolicy } from './path-policy';

/** One platform owns one remembered directory, so mutations share one queue. */
export class MergeDirectoryPolicyQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(platform: string, operation: () => Promise<T>): Promise<T> {
    if (platform === 'youtube' || platform === 'bilibili') platform = 'video';
    const previous = this.tails.get(platform) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.tails.set(platform, result);
    void result
      .finally(() => {
        if (this.tails.get(platform) === result) this.tails.delete(platform);
      })
      .catch(() => undefined);
    return result;
  }
}

export interface DirectoryPolicyCommitStore {
  get(id: string): Promise<StoredDirectoryHandle | undefined>;
  save(id: string, handle: FileSystemDirectoryHandleLike): Promise<StoredDirectoryHandle>;
  restore(record: StoredDirectoryHandle): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Chrome storage and IndexedDB cannot share an atomic transaction. Serialize
 * callers per platform and compensate both stores on any failed commit. No
 * directory contents are read, changed, or removed by this metadata operation.
 */
export async function commitMergeDirectoryPolicy(options: {
  store: DirectoryPolicyCommitStore;
  handleId: string;
  incoming?: StoredDirectoryHandle;
  policy: MergeDownloadPathPolicy;
  readPolicy: () => Promise<MergeDownloadPathPolicy>;
  writePolicy: (policy: MergeDownloadPathPolicy) => Promise<unknown>;
  validate: () => Promise<void>;
  finalize?: () => Promise<void>;
}): Promise<MergeDownloadPathPolicy> {
  await options.validate();
  const [previousDirectory, previousPolicy] = await Promise.all([
    options.store.get(options.handleId),
    options.readPolicy(),
  ]);
  await options.validate();
  let directoryAttempted = false;
  let policyAttempted = false;
  try {
    let nextPolicy = options.policy;
    if (options.incoming) {
      directoryAttempted = true;
      const promoted = await options.store.save(options.handleId, options.incoming.handle);
      nextPolicy = { mode: 'custom', directory: promoted.metadata };
    }
    await options.validate();
    policyAttempted = true;
    await options.writePolicy(nextPolicy);
    await options.validate();
    await options.finalize?.();
    return nextPolicy;
  } catch (error) {
    let rollbackFailed = false;
    if (directoryAttempted) {
      await (
        previousDirectory
          ? options.store.restore(previousDirectory)
          : options.store.remove(options.handleId)
      ).catch(() => {
        rollbackFailed = true;
      });
    }
    if (policyAttempted) {
      await options.writePolicy(previousPolicy).catch(() => {
        rollbackFailed = true;
      });
    }
    if (rollbackFailed) {
      throw new Error('保存位置提交失败，原授权恢复尚未确认；请重新选择保存位置后再下载。', {
        cause: error,
      });
    }
    throw error;
  }
}
