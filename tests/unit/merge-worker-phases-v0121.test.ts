import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobWorkerEvent, JobWorkerRequest } from '../../src/entrypoints/job/worker-protocol';
import type { RemuxProgress } from '../../src/modules/merge/types';

const controls = vi.hoisted(() => ({
  reuse: vi.fn(),
  resolve: vi.fn(),
  stage: vi.fn(),
  preflight: vi.fn(),
  remotePreflight: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('../../src/modules/merge', async (original) => ({
  ...(await original<typeof import('../../src/modules/merge')>()),
  reuseStagedMergeInputsFromOpfs: controls.reuse,
  resolveMergeRequestSources: controls.resolve,
  stageMergeInputsToOpfs: controls.stage,
  preflightCapturedBlobs: controls.preflight,
  preflightSeparateTracks: controls.remotePreflight,
}));

const events: JobWorkerEvent[] = [];
const request: JobWorkerRequest = {
  type: 'PREFLIGHT',
  jobId: 'job',
  attemptId: 'attempt',
  request: {
    video: { url: 'https://example.test/video' },
    audio: { url: 'https://example.test/audio' },
  },
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  events.length = 0;
  controls.reuse.mockReset().mockResolvedValue(null);
  controls.resolve
    .mockReset()
    .mockResolvedValue({ request: request.request, requiresLocalBlobSource: true });
  controls.stage
    .mockReset()
    .mockImplementation(
      async (_request, _jobId, options: { onProgress: (value: RemuxProgress) => void }) => {
        options.onProgress({
          phase: 'fetching',
          ratio: null,
          readBytes: 10,
          message: 'actual staging read',
        });
        return {
          videoBlob: new Blob(['video']),
          audioBlob: new Blob(['audio']),
          readBytes: 10,
          cleanup: controls.cleanup,
        };
      },
    );
  controls.cleanup.mockReset().mockResolvedValue(undefined);
  controls.preflight.mockReset().mockResolvedValue({ status: 'supported', canMerge: true });
  controls.remotePreflight.mockReset().mockResolvedValue({ status: 'supported', canMerge: true });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } });
  vi.stubGlobal('postMessage', (event: JobWorkerEvent) => events.push(event));
  vi.stubGlobal('onmessage', null);
  await import('../../src/entrypoints/job/merge.worker');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function send(message: JobWorkerRequest) {
  (globalThis as unknown as { onmessage: (event: { data: JobWorkerRequest }) => void }).onmessage({
    data: message,
  });
}

describe('worker phase and real-progress contract', () => {
  it('stages once when Range support disappears after a successful preflight probe', async () => {
    controls.resolve.mockResolvedValue({
      request: request.request,
      requiresLocalBlobSource: false,
    });
    controls.remotePreflight.mockResolvedValue({
      status: 'unsupported',
      canMerge: false,
      failure: {
        code: 'RANGE_RESPONSE_INVALID',
        reason: 'RANGE_UNSUPPORTED',
        stage: 'source-headers',
        network: { readMode: 'sequential', responseStatus: 200 },
      },
    });
    send(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.remotePreflight).toHaveBeenCalledTimes(1);
    expect(controls.stage).toHaveBeenCalledTimes(1);
    expect(controls.preflight).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'CAPABILITY',
      capability: { status: 'supported' },
    });
  });

  it('does not reinterpret invalid ranges or genuine codec failures as successful fallback', async () => {
    controls.resolve.mockResolvedValue({
      request: request.request,
      requiresLocalBlobSource: false,
    });
    controls.remotePreflight.mockResolvedValue({
      status: 'unsupported',
      canMerge: false,
      failure: { code: 'DYNAMIC_RANGE_UNVERIFIED', reason: 'HDR_CONFIG_INCOMPLETE' },
    });
    send(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls.stage).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'CAPABILITY',
      capability: {
        failure: { reason: 'HDR_CONFIG_INCOMPLETE' },
      },
    });
  });

  it('ACK precedes all asynchronous work and staging progress is visible before capability ready', async () => {
    send(request);
    expect(events[0]?.type).toBe('ACK');
    await vi.advanceTimersByTimeAsync(0);
    const progress = events.filter(
      (event): event is Extract<JobWorkerEvent, { type: 'PROGRESS' }> => event.type === 'PROGRESS',
    );
    expect(progress.map((event) => event.progress.stage)).toEqual([
      'storage',
      'source-selection',
      'staging',
      'decoder-config',
    ]);
    expect(progress.find((event) => event.progress.stage === 'staging')?.progress).toMatchObject({
      ratio: null,
      readBytes: 10,
      elapsedMs: 0,
      idleMs: 0,
    });
    expect(events.at(-1)?.type).toBe('CAPABILITY');
    expect(controls.cleanup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('heartbeats do not manufacture progress or prevent a local no-progress timeout', async () => {
    controls.reuse.mockImplementation(() => new Promise(() => {}));
    send(request);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(events.filter((event) => event.type === 'HEARTBEAT').length).toBeGreaterThan(10);
    expect(events.filter((event) => event.type === 'PROGRESS')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events.at(-1)).toMatchObject({
      type: 'CAPABILITY',
      capability: { canMerge: false, failure: { reason: 'PARSER_TIMEOUT', stage: 'storage' } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores cancellation from a stale attempt but stops the exact current attempt', async () => {
    controls.reuse.mockImplementation(() => new Promise(() => {}));
    send(request);
    send({ type: 'CANCEL', jobId: request.jobId, attemptId: 'stale-attempt' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((event) => event.type === 'CAPABILITY')).toBe(false);
    send({ type: 'CANCEL', jobId: request.jobId, attemptId: request.attemptId });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({
      type: 'CAPABILITY',
      capability: { failure: { code: 'CANCELLED' } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
