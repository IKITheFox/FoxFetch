// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { acquireYouTubeDirectFile } from '../../src/modules/youtube/sources/direct-file';

const address = 'https://r1.googlevideo.com/videoplayback?sig=private';
it.each([200, 206])('publishes verified full size before reading (%i)', async (status) => {
  const events: unknown[] = [];
  await acquireYouTubeDirectFile(address, {
    destination: new WritableStream<Uint8Array>(),
    signal: new AbortController().signal,
    fetch: async () =>
      new Response(new Uint8Array(3), {
        status,
        headers: {
          'content-length': '3',
          ...(status === 206 ? { 'content-range': 'bytes 0-2/3' } : {}),
        },
      }),
    onTotal: (total) => events.push(['total', total]),
    onProgress: (read) => events.push(['read', read]),
  });
  expect(events).toEqual([
    ['total', 3],
    ['read', 3],
  ]);
});
it('does not invent length and invalidates a mismatched length', async () => {
  const totals: (number | null)[] = [];
  await acquireYouTubeDirectFile(address, {
    destination: new WritableStream<Uint8Array>(),
    signal: new AbortController().signal,
    fetch: async () => new Response(new Uint8Array(3)),
    onTotal: (total) => totals.push(total),
  });
  expect(totals).toEqual([null]);
  await expect(
    acquireYouTubeDirectFile(address, {
      destination: new WritableStream<Uint8Array>(),
      signal: new AbortController().signal,
      fetch: async () => new Response(new Uint8Array(3), { headers: { 'content-length': '2' } }),
      onTotal: (total) => totals.push(total),
    }),
  ).rejects.toThrow('SOURCE_SIZE_MISMATCH');
  expect(totals.slice(-2)).toEqual([2, null]);
});
it.each(['write', 'close'] as const)(
  'reports local %s failure separately from network failure',
  async (phase) => {
    const destination = new WritableStream<Uint8Array>({
      [phase]: () => {
        throw new DOMException(address, 'QuotaExceededError');
      },
    });
    let failure: unknown;
    try {
      await acquireYouTubeDirectFile(address, {
        destination,
        signal: new AbortController().signal,
        fetch: async () => new Response(new Uint8Array([1, 2, 3])),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('SOURCE_STORAGE_FULL');
    expect((failure as Error).cause).toBeUndefined();
    expect(destination.locked).toBe(false);
  },
);
function output() {
  const write = vi.fn();
  const close = vi.fn();
  const abort = vi.fn();
  const destination = new WritableStream<Uint8Array>({ write, close, abort });
  return { destination, write, close, abort };
}
it.each([200, 206])(
  'reads the full exact response with backpressure and no media-success claim: %i',
  async (status) => {
    const s = output();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status,
        headers: {
          'content-length': '3',
          ...(status === 206 ? { 'content-range': 'bytes 0-2/3' } : {}),
        },
      }),
    );
    expect(
      await acquireYouTubeDirectFile(address, {
        destination: s.destination,
        signal: new AbortController().signal,
        expectedBytes: 3,
        fetch: request,
      }),
    ).toEqual({ bytes: 3, declaredBytes: 3, responseStatus: status, mediaVerified: false });
    expect(request).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ credentials: 'omit', redirect: 'error', method: 'GET' }),
    );
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.abort).not.toHaveBeenCalled();
    expect(s.destination.locked).toBe(false);
  },
);
it.each([
  {
    status: 206,
    headers: { 'content-range': 'bytes 1-2/3' },
    size: 2,
    code: 'SOURCE_PARTIAL_RESPONSE',
  },
  {
    status: 206,
    headers: { 'content-range': 'bytes 0-1/3' },
    size: 2,
    code: 'SOURCE_PARTIAL_RESPONSE',
  },
  { status: 200, headers: { 'content-length': '4' }, size: 3, code: 'SOURCE_SIZE_MISMATCH' },
  { status: 200, headers: { 'content-length': '2' }, size: 3, code: 'SOURCE_SIZE_MISMATCH' },
  { status: 200, headers: { 'content-length': 'NaN' }, size: 3, code: 'SOURCE_SIZE_INVALID' },
  { status: 403, headers: {}, size: 1, code: 'SOURCE_ADDRESS_REJECTED' },
])(
  'rejects an incomplete or invalid response: $code ($status)',
  async ({ status, headers, size, code }) => {
    const s = output();
    await expect(
      acquireYouTubeDirectFile(address, {
        destination: s.destination,
        signal: new AbortController().signal,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(new Uint8Array(size), { status, headers: headers as HeadersInit }),
          ),
      }),
    ).rejects.toThrow(code);
    expect(s.close).not.toHaveBeenCalled();
    expect(s.abort).toHaveBeenCalledTimes(1);
    expect(s.destination.locked).toBe(false);
  },
);
it('aborts the transport and writer on cancellation without publishing progress afterward', async () => {
  const s = output();
  const controller = new AbortController();
  let networkSignal: AbortSignal | undefined;
  const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    networkSignal = init!.signal!;
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const progress = vi.fn(() => controller.abort());
  await expect(
    acquireYouTubeDirectFile(address, {
      destination: s.destination,
      signal: controller.signal,
      fetch: request,
      onProgress: progress,
    }),
  ).rejects.toThrow('DOWNLOAD_CANCELED');
  expect(networkSignal!.aborted).toBe(true);
  expect(progress).toHaveBeenCalledTimes(1);
  expect(s.close).not.toHaveBeenCalled();
  expect(s.abort).toHaveBeenCalledTimes(1);
});
it('times out an idle header request without exposing the signed address', async () => {
  const s = output();
  const request = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error(address)), { once: true });
      }),
  );
  await expect(
    acquireYouTubeDirectFile(address, {
      destination: s.destination,
      signal: new AbortController().signal,
      fetch: request,
      idleTimeoutMs: 10,
    }),
  ).rejects.toThrow('SOURCE_READ_TIMEOUT');
  expect(s.abort).toHaveBeenCalledTimes(1);
});
it('does not fetch an unrelated address or mutate an invalid expected size into a valid one', async () => {
  const request = vi.fn<typeof fetch>();
  for (const url of [
    'http://r1.googlevideo.com/videoplayback',
    'https://googlevideo.com.example.org/videoplayback',
    'https://r1.googlevideo.com:4433/videoplayback',
  ]) {
    await expect(
      acquireYouTubeDirectFile(url, {
        destination: output().destination,
        signal: new AbortController().signal,
        fetch: request,
      }),
    ).rejects.toThrow('SOURCE_NOT_ALLOWED');
  }
  await expect(
    acquireYouTubeDirectFile(address, {
      destination: output().destination,
      signal: new AbortController().signal,
      fetch: request,
      expectedBytes: -1,
    }),
  ).rejects.toThrow('SOURCE_SIZE_INVALID');
  expect(request).not.toHaveBeenCalled();
});
