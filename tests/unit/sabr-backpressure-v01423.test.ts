// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { waitForSabrOutput } from '../../src/modules/youtube/sources/output-backpressure';
import { SabrStream } from 'googlevideo/sabr-stream';
afterEach(() => vi.useRealTimers());
it('waits for completed media queues to drain before accepting more input', async () => {
  vi.useFakeTimers();
  let bytes = 12 * 1024 * 1024;
  let done = false;
  const work = waitForSabrOutput(() => bytes, new AbortController().signal).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(false);
  bytes = 0;
  await vi.advanceTimersByTimeAsync(10);
  await work;
  expect(done).toBe(true);
});
it('cancels immediately while waiting, without leaving timers', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const result = waitForSabrOutput(() => 10 * 1024 * 1024, controller.signal).catch((e) => e);
  controller.abort(new Error('CANCELED'));
  expect((await result).message).toBe('CANCELED');
  expect(vi.getTimerCount()).toBe(0);
});
it('does not confuse incomplete segments with drainable output', () => {
  const stream = new SabrStream();
  (
    stream as unknown as { partialSegmentQueue: Map<number, { bufferedChunks: Uint8Array[] }> }
  ).partialSegmentQueue.set(1, { bufferedChunks: [new Uint8Array(1024)] });
  expect(stream.getBufferedByteLength()).toBe(1024);
  expect(stream.getQueuedByteLength()).toBe(0);
  stream.abort();
});
