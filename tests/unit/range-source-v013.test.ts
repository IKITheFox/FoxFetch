import { describe, expect, it, vi } from 'vitest';
import { createStrictRangeFetch } from '../../src/modules/merge/range-source';

const url = 'https://media.example/video.m4s?token=not-public';
const init = { headers: { Range: 'bytes=4-7' } };
describe('strict random-access source', () => {
  it('keeps valid bounded 206 and its original payload', async () => {
    const report = vi.fn();
    const fetcher = createStrictRangeFetch(
      vi.fn(
        async () =>
          new Response(new Uint8Array([4, 5, 6, 7]), {
            status: 206,
            headers: { 'Content-Range': 'bytes 4-7/8', 'Content-Length': '4' },
          }),
      ),
      report,
    );
    expect([...new Uint8Array(await (await fetcher(url, init)).arrayBuffer())]).toEqual([
      4, 5, 6, 7,
    ]);
    expect(report).toHaveBeenCalledWith({
      readMode: 'range',
      responseStatus: 206,
      requestStart: 4,
      responseStart: 4,
      responseEnd: 7,
      totalBytes: 8,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('token');
  });
  it('cancels a full 200 response before a bounded UrlSource can consume it', async () => {
    const cancel = vi.fn();
    const fetcher = createStrictRangeFetch(
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    await expect(fetcher(url, init)).rejects.toMatchObject({
      detail: {
        reason: 'RANGE_UNSUPPORTED',
        network: { responseStatus: 200 },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'bytes 0-3/8', 'bytes 4-8/8', 'bytes 4-7/*', 'bytes 4-7/9007199254740992'])(
    'rejects malformed/discontinuous range %s',
    async (range) => {
      const fetcher = createStrictRangeFetch(
        vi.fn(
          async () =>
            new Response(new Uint8Array([1]), {
              status: 206,
              headers: range ? { 'Content-Range': range } : {},
            }),
        ),
      );
      await expect(fetcher(url, init)).rejects.toMatchObject({
        detail: { reason: 'RANGE_INVALID' },
      });
    },
  );
  it('rejects changes in total size or ETag across actual requests', async () => {
    let count = 0;
    const fetcher = createStrictRangeFetch(
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 206,
            headers: { 'Content-Range': 'bytes 4-7/8', etag: ++count === 1 ? '"v1"' : '"v2"' },
          }),
      ),
    );
    await fetcher(url, init);
    await expect(fetcher(url, init)).rejects.toMatchObject({ detail: { reason: 'RANGE_INVALID' } });
  });
  it('leaves non-range requests and HTTP errors for the normal handling path', async () => {
    const ordinary = new Response('playlist');
    expect(await createStrictRangeFetch(vi.fn(async () => ordinary))(url)).toBe(ordinary);
    const denied = new Response(null, { status: 403 });
    expect(await createStrictRangeFetch(vi.fn(async () => denied))(url, init)).toBe(denied);
  });
  it('requires a fresh complete read when multiple ranges have no verifiable resource validator', async () => {
    const cancel = vi.fn();
    const fetcher = createStrictRangeFetch(
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            status: 206,
            headers: { 'Content-Range': 'bytes 4-7/8' },
          }),
      ),
    );
    const first = await fetcher(url, init);
    await expect(fetcher(url, init)).rejects.toMatchObject({
      detail: {
        reason: 'RANGE_UNSUPPORTED',
        network: { fallback: 'range-unavailable', responseStatus: 206 },
      },
    });
    expect(cancel).toHaveBeenCalledOnce();
    await first.body?.cancel();
  });
});
