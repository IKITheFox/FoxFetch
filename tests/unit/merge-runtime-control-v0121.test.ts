import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTimedMergeFetch, withMergeDeadline } from '../../src/modules/merge/runtime-control';
import { normalizeMergeError } from '../../src/modules/merge/errors';
import { superviseMergeWorker } from '../../src/entrypoints/offscreen/worker-liveness';

afterEach(() => vi.useRealTimers());

describe('v0.12.1 bounded media I/O', () => {
  it('renews a parser wait only when underlying source bytes actually advance', async () => {
    vi.useFakeTimers();
    let lastAdvance = Date.now();
    const failure = expect(
      withMergeDeadline(new Promise<void>(() => {}), { getLastAdvance: () => lastAdvance }),
    ).rejects.toMatchObject({ detail: { reason: 'PARSER_TIMEOUT' } });
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      lastAdvance = Date.now();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out headers and actually aborts the outstanding fetch', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const request = createTimedMergeFetch(fetchFn)('https://example.test/video');
    const failure = expect(request).rejects.toMatchObject({
      detail: { reason: 'NETWORK_TIMEOUT', stage: 'source-headers' },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await failure;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a stalled body independently of successful headers', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const response = await createTimedMergeFetch(vi.fn(async () => new Response(stream)))(
      'https://example.test/video',
    );
    const failure = expect(response.arrayBuffer()).rejects.toMatchObject({
      detail: { reason: 'BODY_STALLED' },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not impose a total timeout on a continuously progressing long body', async () => {
    vi.useFakeTimers();
    let target!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        target = controller;
      },
    });
    const response = await createTimedMergeFetch(vi.fn(async () => new Response(stream)))(
      'https://example.test/video',
    );
    const bytes = response.arrayBuffer();
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      target.enqueue(new Uint8Array([index]));
      await vi.advanceTimersByTimeAsync(0);
    }
    target.close();
    expect(new Uint8Array(await bytes)).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('empty chunks cannot fake byte progress', async () => {
    vi.useFakeTimers();
    let target!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        target = controller;
      },
    });
    const response = await createTimedMergeFetch(vi.fn(async () => new Response(stream)))(
      'https://example.test/video',
    );
    const failure = expect(response.arrayBuffer()).rejects.toMatchObject({
      detail: { reason: 'BODY_STALLED' },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    target.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
  });

  it('disposes parsing on cancellation and preserves a stable abort reason', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const dispose = vi.fn();
    const work = withMergeDeadline(new Promise<void>(() => {}), {
      signal: controller.signal,
      onStop: dispose,
    });
    const failure = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await failure;
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('separately identifies parser idle and OPFS quota exhaustion', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const failure = expect(
      withMergeDeadline(new Promise<void>(() => {}), { stage: 'decoder-config', onStop: dispose }),
    ).rejects.toMatchObject({ detail: { reason: 'PARSER_TIMEOUT', stage: 'decoder-config' } });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(dispose).toHaveBeenCalledOnce();
    expect(normalizeMergeError(new DOMException('full', 'QuotaExceededError')).detail.reason).toBe(
      'STORAGE_QUOTA',
    );
  });
});

describe('v0.12.1 task-specific worker watchdog', () => {
  it('requires an acknowledgement within 3 seconds', async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const watch = superviseMergeWorker({ fail, terminate: vi.fn() });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fail).toHaveBeenCalledWith('WORKER_START_TIMEOUT');
    watch.close();
  });

  it('heartbeats renew liveness, not processing progress, and stop on cleanup', async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const watch = superviseMergeWorker({ fail, terminate: vi.fn() });
    watch.receive();
    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      watch.receive();
    }
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fail).toHaveBeenCalledWith('WORKER_UNRESPONSIVE');
    watch.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeated cancellation gets a single 2-second bound, without affecting peers', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const peerTerminate = vi.fn();
    const watch = superviseMergeWorker({ fail: vi.fn(), terminate });
    const peer = superviseMergeWorker({ fail: vi.fn(), terminate: peerTerminate });
    watch.receive();
    peer.receive();
    watch.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    watch.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminate).toHaveBeenCalledOnce();
    expect(peerTerminate).not.toHaveBeenCalled();
    peer.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cooperative terminal completion clears the pending force timer', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const watch = superviseMergeWorker({ fail: vi.fn(), terminate });
    watch.receive();
    watch.cancel();
    watch.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
