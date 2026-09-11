import { describe, expect, it, vi } from 'vitest';
import {
  commitMergeDirectoryPolicy,
  MergeDirectoryPolicyQueue,
  type DirectoryPolicyCommitStore,
  type MergeDownloadPathPolicy,
} from '../../src/modules/jobs';
import type { StoredDirectoryHandle } from '../../src/modules/downloads/directory-handle-store';

function record(name: string, handleId = 'merge-bilibili'): StoredDirectoryHandle {
  return {
    metadata: { handleId, name, selectedAt: 123 },
    handle: { kind: 'directory', name, getDirectoryHandle: vi.fn() },
  };
}

function fixture() {
  const original = record('原目录');
  const incoming = record('新目录', 'pending-session');
  let current: StoredDirectoryHandle | undefined = original;
  let policy: MergeDownloadPathPolicy = { mode: 'custom', directory: original.metadata };
  const store = {
    get: vi.fn(async () => current),
    save: vi.fn<DirectoryPolicyCommitStore['save']>(async (handleId, handle) => {
      current = { handle, metadata: { handleId, name: handle.name, selectedAt: 456 } };
      return current;
    }),
    restore: vi.fn(async (value: StoredDirectoryHandle) => {
      current = value;
    }),
    remove: vi.fn(async () => {
      current = undefined;
    }),
  };
  const writePolicy = vi.fn(async (value: MergeDownloadPathPolicy) => {
    policy = value;
  });
  const options = {
    store,
    handleId: 'merge-bilibili',
    incoming,
    policy: { mode: 'custom', directory: incoming.metadata } as MergeDownloadPathPolicy,
    readPolicy: vi.fn(async () => policy),
    writePolicy,
    validate: vi.fn(async () => undefined),
  };
  return { original, incoming, store, options, current: () => current, policy: () => policy };
}

describe('directory policy compensation transaction', () => {
  it('promotes a confirmed grant and policy together, using only promoted metadata', async () => {
    const f = fixture();
    const finalize = vi.fn(async () => undefined);
    const result = await commitMergeDirectoryPolicy({ ...f.options, finalize });
    expect(result).toEqual({
      mode: 'custom',
      directory: { handleId: 'merge-bilibili', name: '新目录', selectedAt: 456 },
    });
    expect(f.current()?.handle).toBe(f.incoming.handle);
    expect(f.policy()).toEqual(result);
    expect(finalize).toHaveBeenCalledOnce();
    expect(f.store.restore).not.toHaveBeenCalled();
  });

  it('restores the exact old handle, selectedAt and policy when policy storage rejects', async () => {
    const f = fixture();
    f.options.writePolicy.mockImplementationOnce(async () => {
      throw new Error('policy failed');
    });
    await expect(commitMergeDirectoryPolicy(f.options)).rejects.toThrow('policy failed');
    expect(f.current()).toBe(f.original);
    expect(f.policy()).toEqual({ mode: 'custom', directory: f.original.metadata });
    expect(f.store.restore).toHaveBeenCalledWith(f.original);
    expect(f.store.remove).not.toHaveBeenCalled();
  });

  it('never writes directory or path metadata for an already expired session', async () => {
    const f = fixture();
    f.options.validate.mockRejectedValueOnce(new Error('session expired'));
    await expect(commitMergeDirectoryPolicy(f.options)).rejects.toThrow('session expired');
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.options.writePolicy).not.toHaveBeenCalled();
    expect(f.current()).toBe(f.original);
  });

  it('rolls back both stores if source/session expires after policy write or finalization fails', async () => {
    const f = fixture();
    await expect(
      commitMergeDirectoryPolicy({
        ...f.options,
        finalize: async () => {
          throw new Error('session expired');
        },
      }),
    ).rejects.toThrow('session expired');
    expect(f.current()).toBe(f.original);
    expect(f.policy()).toEqual({ mode: 'custom', directory: f.original.metadata });
    expect(f.options.writePolicy).toHaveBeenCalledTimes(2);
  });

  it('does not change the remembered grant when choosing default and compensates policy failure', async () => {
    const f = fixture();
    const options: Parameters<typeof commitMergeDirectoryPolicy>[0] = { ...f.options };
    delete options.incoming;
    await expect(
      commitMergeDirectoryPolicy({
        ...options,
        policy: { mode: 'automatic' },
        finalize: async () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.store.restore).not.toHaveBeenCalled();
    expect(f.current()).toBe(f.original);
    expect(f.policy()).toEqual({ mode: 'custom', directory: f.original.metadata });
  });

  it('reports a rollback failure instead of claiming the original grant is unchanged', async () => {
    const f = fixture();
    f.options.writePolicy.mockRejectedValueOnce(new Error('policy failed'));
    f.store.restore.mockRejectedValueOnce(new Error('database failed'));
    await expect(commitMergeDirectoryPolicy(f.options)).rejects.toThrow('原授权恢复尚未确认');
  });

  it('serializes same-platform changes through rollback, while other platforms can progress', async () => {
    const queue = new MergeDirectoryPolicyQueue();
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = queue
      .run('bilibili', () =>
        commitMergeDirectoryPolicy({
          ...f.options,
          finalize: async () => {
            firstStarted();
            await held;
            throw new Error('first failed');
          },
        }),
      )
      .catch((error: Error) => error.message);
    await started;
    const options: Parameters<typeof commitMergeDirectoryPolicy>[0] = { ...f.options };
    delete options.incoming;
    const second = vi.fn(() =>
      commitMergeDirectoryPolicy({
        ...options,
        policy: { mode: 'automatic' },
      }),
    );
    const next = queue.run('youtube', second);
    await expect(queue.run('vimeo', async () => 'independent')).resolves.toBe('independent');
    expect(second).not.toHaveBeenCalled();
    release();
    expect(await first).toBe('first failed');
    await expect(next).resolves.toEqual({ mode: 'automatic' });
    expect(f.current()).toBe(f.original);
    expect(f.policy()).toEqual({ mode: 'automatic' });
  });
});
