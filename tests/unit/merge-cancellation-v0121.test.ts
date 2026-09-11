import { describe, expect, it, vi } from 'vitest';
import {
  ChromeMergeJobStore,
  cancelMergeJobWithLifecycle,
  mergeJobFromSeed,
  mergeJobAcceptsWork,
  presentMergeDockJob,
  requestMergeJobCancellation,
  requireSettledMergeCancellation,
  settleMergeJobCancellation,
  touchMergeJob,
  type MergeJob,
  type StorageAreaLike,
} from '../../src/modules/jobs';

class MemoryStorage implements StorageAreaLike {
  values: Record<string, unknown> = {};
  async get(keys?: string | string[] | null) {
    return keys == null
      ? { ...this.values }
      : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((key) => [key, this.values[key]]),
        );
  }
  async set(values: Record<string, unknown>) {
    Object.assign(this.values, structuredClone(values));
  }
  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}

function createJob(state: MergeJob['state'] = 'resolving'): MergeJob {
  return {
    ...mergeJobFromSeed({
      id: crypto.randomUUID(),
      videoUrl: 'https://cdn.example/video?token=private',
      audioUrl: 'https://cdn.example/audio?token=secret',
      ownerTabId: 42,
      ownerPageUrl: 'https://www.bilibili.com/video/BV1test/',
      ownerMediaEpoch: 3,
      createdAt: 100,
    }),
    state,
  };
}
function present(job: MergeJob) {
  return presentMergeDockJob(
    job,
    { actionToken: 'opaque-action', pathToken: 'opaque-path' },
    { savePath: 'Downloads/FoxFetch/Bilibili', pathMode: 'automatic' },
  );
}
async function setup(initial = createJob()) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const store = new ChromeMergeJobStore(local, session);
  await store.save(initial);
  return { initial, local, session, store };
}

describe('v0.12.1 regular-download cancellation', () => {
  it.each([
    undefined,
    null,
    {},
    { ok: true },
    { ok: true, queued: true },
    { ok: true, settled: false },
  ])('does not treat a dispatch ACK as settled cancellation: %j', (response) => {
    expect(() => requireSettledMergeCancellation(response)).toThrow('STOP_TIMEOUT');
  });

  it('accepts only an explicit settled success and normalizes untrusted cancellation errors', () => {
    expect(() =>
      requireSettledMergeCancellation({ ok: true, settled: true, forced: false }),
    ).not.toThrow();
    expect(() =>
      requireSettledMergeCancellation({ ok: true, settled: true, forced: true }),
    ).not.toThrow();
    expect(() =>
      requireSettledMergeCancellation({ ok: false, settled: false, error: 'CLEANUP_FAILED' }),
    ).toThrow('CLEANUP_FAILED');
    expect(() =>
      requireSettledMergeCancellation({ ok: false, error: 'https://private.example?token=secret' }),
    ).toThrow('STOP_TIMEOUT');
  });

  it.each([
    'queued',
    'resolving',
    'permission_required',
    'ready',
    'fetching',
    'muxing',
    'saving',
    'verifying',
    'paused',
    'failed',
  ] as const)(
    'stops %s, makes no failure, and releases only its own source data',
    async (state) => {
      const { initial, store } = await setup(createJob(state));
      const other = createJob('fetching');
      await store.save(other);
      const stop = vi.fn(async (job: MergeJob) => {
        expect((await store.get(job.id))?.cancellationRequestedAt).toBeDefined();
        expect(mergeJobAcceptsWork(job)).toBe(false);
      });
      const publish = vi.fn(async (_job: MergeJob) => {});
      const result = await cancelMergeJobWithLifecycle(initial, {
        store,
        stop,
        release: async (job) => job,
        publish,
      });
      expect(result.state).toBe('cancelled');
      expect(result.failure).toBeUndefined();
      expect(present(result)).toMatchObject({
        state: 'cancelled',
        status: '任务已停止',
        mergeEnabled: false,
        separateEnabled: false,
      });
      expect(present(result).error).toBeUndefined();
      expect((await store.get(other.id))?.state).toBe('fetching');
      expect((await store.get(initial.id))?.videoUrl).toBe('https://redacted.invalid/');
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it('does not resolve or claim cancelled while the stop/cleanup operation is pending', async () => {
    const { initial, store } = await setup();
    let release!: () => void;
    let markStopping!: () => void;
    const started = new Promise<void>((resolve) => {
      markStopping = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = vi.fn();
    const operation = cancelMergeJobWithLifecycle(initial, {
      store,
      stop: async () => {
        markStopping();
        await pending;
      },
      release: async (job) => job,
      publish: async () => {},
    }).then((value) => {
      finished();
      return value;
    });
    await started;
    expect(present((await store.get(initial.id))!)).toMatchObject({
      state: 'cancelling',
      busy: true,
      mergeEnabled: false,
      separateEnabled: false,
    });
    expect(finished).not.toHaveBeenCalled();
    release();
    await operation;
    expect(finished).toHaveBeenCalledOnce();
  });

  it.each(['STOP_TIMEOUT', 'CLEANUP_FAILED'])(
    'retains a retryable cancellation fence after %s',
    async (code) => {
      const { initial, store } = await setup();
      await expect(
        cancelMergeJobWithLifecycle(initial, {
          store,
          stop: async () => {
            throw new Error(code);
          },
          release: async (job) => job,
          publish: async () => {},
        }),
      ).rejects.toThrow(/重试返回/u);
      const stopped = (await store.get(initial.id))!;
      expect(stopped.state).not.toBe('cancelled');
      expect(present(stopped)).toMatchObject({ state: 'cancelling', cancelEnabled: true });
      expect(present(stopped).error).not.toContain('任务失败');
      const retried = await cancelMergeJobWithLifecycle(stopped, {
        store,
        stop: async () => {},
        release: async (job) => job,
        publish: async () => {},
      });
      expect(retried.state).toBe('cancelled');
    },
  );

  it('refuses late ready/permission/progress writes after a persisted fence, including a new store instance', async () => {
    const { initial, store, local, session } = await setup();
    await store.save(requestMergeJobCancellation(initial, 250));
    const restarted = new ChromeMergeJobStore(local, session);
    for (const state of ['ready', 'permission_required', 'fetching', 'failed'] as const) {
      await expect(restarted.save(touchMergeJob({ ...initial, state }))).rejects.toMatchObject({
        name: 'AbortError',
      });
    }
    const terminal = settleMergeJobCancellation((await store.get(initial.id))!);
    await store.save(terminal);
    await expect(
      store.save({ ...initial, state: 'completed', outputSizeBytes: 100 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves an independently confirmed file commit which wins while cancellation is pending', async () => {
    const { initial, store } = await setup(createJob('verifying'));
    const result = await cancelMergeJobWithLifecycle(initial, {
      store,
      stop: async () => {
        const latest = (await store.get(initial.id))!;
        await store.save(
          touchMergeJob({
            ...latest,
            state: 'completed',
            publicationCommitted: true,
            outputSizeBytes: 123,
          }),
        );
      },
      release: async () => {
        throw new Error('committed output must not be released as cancelled');
      },
      publish: async () => {},
    });
    expect(result).toMatchObject({ state: 'completed', outputSizeBytes: 123 });
    expect(present(result)).toMatchObject({ state: 'completed', progress: 1 });
  });

  it('does not stop again after cancellation or successful publication', async () => {
    for (const state of ['completed', 'cancelled'] as const) {
      const { initial, store } = await setup({ ...createJob(state), outputSizeBytes: 100 });
      const stop = vi.fn();
      const result = await cancelMergeJobWithLifecycle(initial, {
        store,
        stop,
        release: async (job) => job,
        publish: async () => {},
      });
      expect(result.state).toBe(state);
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it('requires confirmation for live/permission states, but ready cleanup does not prompt', () => {
    for (const state of [
      'queued',
      'resolving',
      'permission_required',
      'fetching',
      'muxing',
      'saving',
      'verifying',
      'paused',
    ] as const) {
      expect(present(createJob(state)).returnRequiresConfirmation).toBe(true);
    }
    expect(present(createJob('ready'))).toMatchObject({
      returnRequiresConfirmation: false,
      cancelEnabled: true,
    });
  });

  it('exposes real initialization bytes and whitelisted subreasons without source URLs', () => {
    const source = createJob();
    source.progress = {
      ...source.progress,
      stage: 'staging',
      readBytes: 2048,
      totalBytes: 4096,
      message: 'https://private.example?token=secret',
      lastProgressAt: 200,
    };
    const initializing = present(source);
    expect(initializing).toMatchObject({
      state: 'preparing',
      progress: null,
      busy: true,
      mergeEnabled: false,
    });
    expect(initializing.status).toContain('2 KB');
    expect(initializing.diagnostics).toMatchObject({
      stage: '正在暂存媒体',
      readBytes: 2048,
      totalBytes: 4096,
      lastProgressAt: 200,
    });
    const failed = present({
      ...source,
      state: 'failed',
      failure: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'DV_CONFIG_MISSING',
        message: 'https://private.example?token=secret',
        retryable: false,
        canDownloadSeparately: true,
      },
    });
    expect(failed.error).toContain('缺少杜比视界配置');
    expect(JSON.stringify(failed)).not.toMatch(/https?:|secret|private/u);
  });
});
