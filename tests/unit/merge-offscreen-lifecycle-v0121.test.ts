import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobWorkerEvent, JobWorkerRequest } from '../../src/entrypoints/job/worker-protocol';
import type {
  MergeOffscreenCommand,
  MergeOffscreenEvent,
} from '../../src/modules/jobs/offscreen-protocol';

const hooks = vi.hoisted(() => ({ verifyOutput: vi.fn() }));
vi.mock('../../src/modules/merge', async (original) => ({
  ...(await original<typeof import('../../src/modules/merge')>()),
  prepareVerifiedMergeDownloadBlob: (...args: unknown[]) => hooks.verifyOutput(...args),
}));

type Listener = (
  message: unknown,
  sender: { id: string; url: string },
  reply: (value: unknown) => void,
) => unknown;
let listener: Listener;
const sent: MergeOffscreenEvent[] = [];
const removed: string[] = [];
let removalError: Error | undefined;
let removeOverride: ((name: string) => Promise<void>) | undefined;
const workers: FakeWorker[] = [];
const getOutputHandle = vi.fn<() => Promise<FileSystemFileHandle>>();

class FakeWorker {
  onmessage: ((message: MessageEvent<JobWorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: JobWorkerRequest[] = [];
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(message: JobWorkerRequest) {
    this.requests.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(value: Omit<JobWorkerEvent, 'jobId' | 'attemptId'>) {
    const request = this.requests[0]!;
    this.onmessage?.({
      data: { ...value, jobId: request.jobId, attemptId: request.attemptId },
    } as MessageEvent<JobWorkerEvent>);
  }
}

function command(type: 'PREFLIGHT' | 'START' | 'START_SEPARATE' | 'CANCEL', jobId: string) {
  const request = {
    video: { url: 'https://example.test/video' },
    audio: { url: 'https://example.test/audio' },
  };
  const message: MergeOffscreenCommand = {
    channel: 'foxfetch-merge-offscreen-v1',
    target: 'offscreen',
    type,
    jobId,
    ...(type !== 'CANCEL' ? { request } : {}),
  } as MergeOffscreenCommand;
  return dispatch(message);
}

function dispatch(message: MergeOffscreenCommand) {
  return new Promise<unknown>((resolve) =>
    listener(message, { id: 'test', url: 'chrome-extension://test/background.js' }, resolve),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  sent.length = 0;
  removed.length = 0;
  workers.length = 0;
  removalError = undefined;
  removeOverride = undefined;
  hooks.verifyOutput.mockReset().mockImplementation(async (file: Blob) => file);
  getOutputHandle.mockReset().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: getOutputHandle,
        removeEntry: async (name: string) => {
          removed.push(name);
          if (removeOverride) return removeOverride(name);
          if (removalError) throw removalError;
          throw new DOMException('missing', 'NotFoundError');
        },
      }),
    },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener: (handler: Listener) => {
          listener = handler;
        },
      },
      sendMessage: async (event: MergeOffscreenEvent) => {
        sent.push(event);
      },
    },
  });
  await import('../../src/entrypoints/offscreen/main');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('offscreen cancel settlement and stale event isolation', () => {
  it('an obsolete queued page-stage failure cannot clean staging after a same-job retry supersedes it', async () => {
    getOutputHandle.mockResolvedValue({} as FileSystemFileHandle);
    await command('PREFLIGHT', 'page-race');
    await vi.advanceTimersByTimeAsync(0);
    const obsolete = dispatch({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PAGE_STAGE_BEGIN',
      jobId: 'page-race',
      stageId: 'old-stage-000000000001',
      request: {
        video: { url: 'https://example.test/video' },
        audio: { url: 'https://example.test/audio' },
      },
    });
    await command('START_SEPARATE', 'page-race');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await obsolete).toMatchObject({ ok: false });
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests[0]?.type).toBe('EXPORT_SEPARATE');
    expect(removed).toHaveLength(3);
    expect(removed.every((name) => name.endsWith('.partial'))).toBe(true);
  });

  it('a cleanup deadline does not forget the real pending removals or falsely settle repeated cancel', async () => {
    const releases: Array<() => void> = [];
    removeOverride = () => new Promise((resolve) => releases.push(resolve));
    const first = command('CANCEL', 'cleanup-pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toEqual({ ok: false, settled: false, error: 'CLEANUP_FAILED' });
    const removalsInFlight = removed.length;
    expect(removalsInFlight).toBeGreaterThan(0);
    const second = command('CANCEL', 'cleanup-pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toEqual({ ok: false, settled: false, error: 'STOP_TIMEOUT' });
    expect(removed).toHaveLength(removalsInFlight);
    removeOverride = undefined;
    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);
    const final = command('CANCEL', 'cleanup-pending');
    await vi.advanceTimersByTimeAsync(0);
    expect(await final).toEqual({ ok: true, settled: true, forced: false });
  });
  it('a timed-out completion cannot delete a same-job separate retry when old verification rejects late', async () => {
    let rejectOld!: (error: Error) => void;
    hooks.verifyOutput.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    getOutputHandle.mockResolvedValue({
      getFile: async () => new Blob(['temporary']),
    } as unknown as FileSystemFileHandle);
    await command('START', 'same-job');
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.emit({ type: 'COMPLETED', result: {} } as Omit<
      Extract<JobWorkerEvent, { type: 'COMPLETED' }>,
      'jobId' | 'attemptId'
    >);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent.filter((event) => event.type === 'FAILED')).toHaveLength(1);
    const removalsBeforeRetry = removed.length;
    await command('START_SEPARATE', 'same-job');
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    expect(getOutputHandle).toHaveBeenCalledTimes(1);
    expect(removed).toHaveLength(removalsBeforeRetry);
    rejectOld(new Error('old readback failed late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests[0]?.type).toBe('EXPORT_SEPARATE');
    expect(getOutputHandle).toHaveBeenCalledTimes(3);
    // Only the new attempt may remove the one prior merge partial. No old catch clean(jobId).
    expect(removed).toHaveLength(removalsBeforeRetry + 1);
    expect(sent.filter((event) => event.type === 'FAILED')).toHaveLength(1);
  });

  it('cancel remains unsettled while a timed-out original completion handler still runs', async () => {
    let rejectOld!: (error: Error) => void;
    hooks.verifyOutput.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    getOutputHandle.mockResolvedValue({
      getFile: async () => new Blob(['temporary']),
    } as unknown as FileSystemFileHandle);
    await command('START', 'raw-handler');
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.emit({ type: 'COMPLETED', result: {} } as Omit<
      Extract<JobWorkerEvent, { type: 'COMPLETED' }>,
      'jobId' | 'attemptId'
    >);
    await vi.advanceTimersByTimeAsync(30_000);
    const beforeCancel = removed.length;
    const cancellation = command('CANCEL', 'raw-handler');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cancellation).toEqual({ ok: false, settled: false, error: 'STOP_TIMEOUT' });
    expect(removed).toHaveLength(beforeCancel);
    rejectOld(new Error('late cleanup can now finish'));
    await vi.advanceTimersByTimeAsync(0);
    const settled = command('CANCEL', 'raw-handler');
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toEqual({ ok: true, settled: true, forced: false });
  });
  it('bounds output-handle metadata before a worker exists and keeps unabortable I/O unsettled', async () => {
    let release!: (value: FileSystemFileHandle) => void;
    getOutputHandle.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await command('START', 'metadata-timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(workers).toHaveLength(0);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'FAILED',
        failure: expect.objectContaining({ reason: 'PARSER_TIMEOUT', stage: 'storage' }),
      }),
    );
    const cancellation = command('CANCEL', 'metadata-timeout');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cancellation).toEqual({ ok: false, settled: false, error: 'STOP_TIMEOUT' });
    release({} as FileSystemFileHandle);
    await vi.advanceTimersByTimeAsync(0);
    const settled = command('CANCEL', 'metadata-timeout');
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toEqual({ ok: true, settled: true, forced: false });
  });

  it('never starts late worker work after cancellation during output metadata allocation', async () => {
    let release!: (value: FileSystemFileHandle) => void;
    getOutputHandle.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await command('START', 'metadata-cancel');
    await vi.advanceTimersByTimeAsync(0);
    const cancellation = command('CANCEL', 'metadata-cancel');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cancellation).toEqual({ ok: false, settled: false, error: 'STOP_TIMEOUT' });
    release({} as FileSystemFileHandle);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
  it('accepts cooperative terminal cancellation without forcing the worker', async () => {
    await command('PREFLIGHT', 'cooperative');
    await vi.advanceTimersByTimeAsync(0);
    const cancellation = command('CANCEL', 'cooperative');
    workers[0]!.emit({
      type: 'FAILED',
      failure: {
        code: 'CANCELLED',
        message: 'cancelled',
        retryable: false,
        canDownloadSeparately: true,
      },
    } as Omit<Extract<JobWorkerEvent, { type: 'FAILED' }>, 'jobId' | 'attemptId'>);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cancellation).toEqual({ ok: true, settled: true, forced: false });
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('forwards real preflight progress but never forwards heartbeats as progress', async () => {
    await command('PREFLIGHT', 'phase');
    await vi.advanceTimersByTimeAsync(0);
    const worker = workers[0]!;
    worker.emit({ type: 'ACK' });
    worker.emit({ type: 'HEARTBEAT' });
    worker.emit({
      type: 'PROGRESS',
      progress: {
        phase: 'fetching',
        stage: 'staging',
        readBytes: 1024,
        ratio: null,
        message: 'staging',
      },
    } as Omit<Extract<JobWorkerEvent, { type: 'PROGRESS' }>, 'jobId' | 'attemptId'>);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'PROGRESS',
      progress: { stage: 'staging', readBytes: 1024, ratio: null },
    });
  });

  it('does not acknowledge cancellation until the worker stops and temporary cleanup completes', async () => {
    await command('PREFLIGHT', 'stop');
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.emit({ type: 'ACK' });
    let done = false;
    const cancellation = command('CANCEL', 'stop').then((reply) => {
      done = true;
      return reply;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    expect(removed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cancellation).toEqual({ ok: true, settled: true, forced: true });
    expect(workers[0]!.terminated).toBe(true);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((name) => name.includes('stop'))).toBe(true);
    workers[0]!.emit({
      type: 'PROGRESS',
      progress: { phase: 'muxing', ratio: 1, message: 'late' },
    } as Omit<Extract<JobWorkerEvent, { type: 'PROGRESS' }>, 'jobId' | 'attemptId'>);
    expect(sent).toHaveLength(0);
  });

  it('shares duplicate cancellation without resetting the grace timer', async () => {
    await command('PREFLIGHT', 'repeat');
    await vi.advanceTimersByTimeAsync(0);
    const first = command('CANCEL', 'repeat');
    await vi.advanceTimersByTimeAsync(1_000);
    const second = command('CANCEL', 'repeat');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toEqual(await second);
    expect(workers[0]!.requests.filter((message) => message.type === 'CANCEL')).toHaveLength(1);
  });

  it('cancels a queued job without waiting for or terminating another running job', async () => {
    await command('PREFLIGHT', 'running');
    await vi.advanceTimersByTimeAsync(0);
    await command('PREFLIGHT', 'queued');
    const cancellation = command('CANCEL', 'queued');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cancellation).toEqual({ ok: true, settled: true, forced: false });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(removed.every((name) => name.includes('queued'))).toBe(true);
  });

  it('reports failed cleanup rather than claiming a stopped-and-cleaned task', async () => {
    removalError = new DOMException('busy', 'InvalidStateError');
    const cancellation = command('CANCEL', 'cleanup-failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cancellation).toEqual({ ok: false, settled: false, error: 'CLEANUP_FAILED' });
  });

  it('worker startup timeout fails the job and releases its queue', async () => {
    await command('PREFLIGHT', 'unresponsive');
    await vi.advanceTimersByTimeAsync(0);
    await command('PREFLIGHT', 'next');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'FAILED',
        failure: expect.objectContaining({ reason: 'WORKER_START_TIMEOUT' }),
      }),
    );
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  });
});
