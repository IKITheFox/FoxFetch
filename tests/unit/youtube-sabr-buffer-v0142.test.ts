// @vitest-environment node
import { expect, it } from 'vitest';
import { SabrStream } from 'googlevideo/sabr-stream';

/** White-box dependency-patch test; no network acquisition is claimed here. */
it('counts actual byte queues and unfinished segments, releasing consumed bytes', async () => {
  const stream = new SabrStream();
  const internals = stream as unknown as {
    videoController: ReadableStreamDefaultController<Uint8Array>;
    audioController: ReadableStreamDefaultController<Uint8Array>;
    videoStream: ReadableStream<Uint8Array>;
    audioStream: ReadableStream<Uint8Array>;
    partialSegmentQueue: Map<number, { bufferedChunks: Uint8Array[] }>;
  };
  expect(stream.getBufferedByteLength()).toBe(0);
  internals.videoController.enqueue(new Uint8Array(100));
  internals.audioController.enqueue(new Uint8Array(20));
  internals.partialSegmentQueue.set(1, { bufferedChunks: [new Uint8Array(7), new Uint8Array(8)] });
  expect(stream.getBufferedByteLength()).toBe(135);
  const video = internals.videoStream.getReader();
  const audio = internals.audioStream.getReader();
  await video.read();
  expect(stream.getBufferedByteLength()).toBe(35);
  await audio.read();
  expect(stream.getBufferedByteLength()).toBe(15);
  internals.partialSegmentQueue.delete(1);
  expect(stream.getBufferedByteLength()).toBe(0);
  video.releaseLock();
  audio.releaseLock();
  stream.abort();
});
