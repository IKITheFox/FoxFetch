import { describe, expect, it, vi } from 'vitest';

import {
  fetchCapturedBilibiliPageRangeMainWorld,
  type BilibiliPageRangeRequest,
} from '../../src/modules/detector/bilibili-page-range-main';

const BVID = 'BV1RANGE001';
const CID = '42001';
const URL = 'https://upos-test.bilivideo.com/upgcxcode/1/2/range-video.m4s?token=current';
const KEY = 'bilibili:video:80:7:30:sdr:';

function response(
  bytes: Uint8Array,
  options: {
    status?: number;
    url?: string;
    contentRange?: string;
    contentLength?: string;
    etag?: string;
  } = {},
): Response {
  const headers = new Headers();
  if (options.contentRange !== null) {
    headers.set('content-range', options.contentRange ?? `bytes 0-${bytes.byteLength - 1}/4`);
  }
  if (options.contentLength !== null) {
    headers.set('content-length', options.contentLength ?? String(bytes.byteLength));
  }
  if (options.etag) headers.set('etag', options.etag);
  return {
    status: options.status ?? 206,
    ok: (options.status ?? 206) >= 200 && (options.status ?? 206) < 300,
    url: options.url ?? URL,
    headers,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function request(overrides: Partial<BilibiliPageRangeRequest> = {}): BilibiliPageRangeRequest {
  return {
    bvid: BVID,
    cid: CID,
    url: URL,
    kind: 'video',
    representationKey: KEY,
    start: 0,
    end: 3,
    ...overrides,
  };
}

function scope(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    location: { href: `https://www.bilibili.com/video/${BVID}/` },
    // Deliberately stale foreign globals must not defeat the current BVID's
    // fixed cache revision when this SPA URL cannot otherwise prove a CID.
    __INITIAL_STATE__: { bvid: 'BV1STALE999', videoData: { cid: 999 } },
    __playinfo__: { bvid: 'BV1STALE999', cid: 999 },
    __foxfetchBilibiliManifestCacheV1__: {
      version: 1,
      revision: 7,
      entries: [
        {
          version: 1,
          bvid: BVID,
          cid: CID,
          revision: 7,
          capturedAt: Date.now(),
          candidates: [
            {
              url: URL,
              kind: 'video',
              mime: 'video/mp4',
              size: 4,
              representation: {
                provider: 'bilibili',
                bvid: BVID,
                cid: CID,
                key: KEY,
                delivery: 'dash',
              },
            },
          ],
        },
      ],
    },
    __foxfetchBilibiliManifestCaptureStateV2__: {
      version: 3,
      fetch: { source: fetchFn },
    },
    ...overrides,
  };
}

describe('Bilibili MAIN-world page range fetch', () => {
  it('cancels only the current random range attempt and removes its listener', async () => {
    const events = new EventTarget();
    const remove = vi.fn(events.removeEventListener.bind(events));
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      );
    }) as unknown as typeof fetch;
    const cancellationId = 'current-range-attempt-12345';
    const result = fetchCapturedBilibiliPageRangeMainWorld(
      request({ cancellationId }),
      scope(fetchFn, {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: remove,
      }),
    );
    events.dispatchEvent(
      new CustomEvent('foxfetch-cancel-page-range-v1', { detail: 'another-range-attempt-67890' }),
    );
    expect(signal?.aborted).toBe(false);
    events.dispatchEvent(
      new CustomEvent('foxfetch-cancel-page-range-v1', { detail: cancellationId }),
    );
    await expect(result).resolves.toEqual({ ok: false, code: 'FETCH_FAILED' });
    expect(signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('aborts a stalled response body at the bounded range deadline', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const output = response(new Uint8Array([1, 2, 3, 4]));
        output.arrayBuffer = () =>
          new Promise<ArrayBuffer>((_resolve, reject) =>
            signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            ),
          );
        return output;
      }) as unknown as typeof fetch;
      const result = fetchCapturedBilibiliPageRangeMainWorld(request(), scope(fetchFn));
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toEqual({ ok: false, code: 'FETCH_FAILED' });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses only ambient page credentials and returns a strictly validated 206 chunk', async () => {
    const fetchSpy = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) =>
      response(new Uint8Array([1, 2, 3, 4]), { etag: '"stable-resource"' }),
    );
    const fetchFn = fetchSpy as unknown as typeof fetch;

    const result = await fetchCapturedBilibiliPageRangeMainWorld(request(), scope(fetchFn));

    expect(result).toMatchObject({
      ok: true,
      status: 206,
      revision: 7,
      start: 0,
      end: 3,
      total: 4,
      contentLength: 4,
      resourceValidator: 'etag:"stable-resource"',
      bytesBase64: 'AQIDBA==',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { Range: 'bytes=0-3' },
    });
    expect(JSON.stringify(init)).not.toMatch(/cookie|authorization/iu);
  });

  it('rejects a CID that the current same-BVID page state proves is stale', async () => {
    const fetchFn = vi.fn(async () =>
      response(new Uint8Array([1, 2, 3, 4])),
    ) as unknown as typeof fetch;
    const pageScope = scope(fetchFn, {
      __INITIAL_STATE__: { bvid: BVID, videoData: { cid: 42002, pages: [] } },
    });

    await expect(fetchCapturedBilibiliPageRangeMainWorld(request(), pageScope)).resolves.toEqual({
      ok: false,
      code: 'ROUTE_MISMATCH',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('pins the exact cache revision, candidate representation, and capture TTL', async () => {
    const fetchFn = vi.fn(async () =>
      response(new Uint8Array([1, 2, 3, 4])),
    ) as unknown as typeof fetch;
    const currentScope = scope(fetchFn);

    await expect(
      fetchCapturedBilibiliPageRangeMainWorld(request({ revision: 8 }), currentScope),
    ).resolves.toEqual({ ok: false, code: 'CACHE_MISMATCH' });
    await expect(
      fetchCapturedBilibiliPageRangeMainWorld(
        request({ revision: 7, representationKey: `${KEY}:other` }),
        currentScope,
      ),
    ).resolves.toEqual({ ok: false, code: 'CANDIDATE_MISMATCH' });

    const expired = scope(fetchFn);
    (expired.__foxfetchBilibiliManifestCacheV1__.entries[0] as { capturedAt: number }).capturedAt =
      Date.now() - 10 * 60_000 - 1;
    await expect(fetchCapturedBilibiliPageRangeMainWorld(request(), expired)).resolves.toEqual({
      ok: false,
      code: 'CACHE_MISMATCH',
    });
  });

  it.each([
    ['HTTP 200', response(new Uint8Array([1, 2, 3, 4]), { status: 200 }), 'HTTP_STATUS_INVALID'],
    [
      'wrong Content-Range',
      response(new Uint8Array([1, 2, 3, 4]), { contentRange: 'bytes 1-4/5' }),
      'RANGE_RESPONSE_INVALID',
    ],
    [
      'wrong Content-Length',
      response(new Uint8Array([1, 2, 3, 4]), { contentLength: '3' }),
      'RANGE_RESPONSE_INVALID',
    ],
    [
      'redirected resource',
      response(new Uint8Array([1, 2, 3, 4]), {
        url: 'https://upos-other.bilivideo.com/upgcxcode/1/2/range-video.m4s?token=current',
      }),
      'RANGE_RESPONSE_INVALID',
    ],
  ])('fails closed for %s', async (_label, invalidResponse, code) => {
    const fetchFn = vi.fn(async () => invalidResponse) as unknown as typeof fetch;
    await expect(
      fetchCapturedBilibiliPageRangeMainWorld(request(), scope(fetchFn)),
    ).resolves.toMatchObject({ ok: false, code });
  });

  it('rejects a response total that differs from the captured candidate size', async () => {
    const fetchFn = vi.fn(async () =>
      response(new Uint8Array([1, 2, 3, 4]), { contentRange: 'bytes 0-3/5' }),
    ) as unknown as typeof fetch;
    await expect(
      fetchCapturedBilibiliPageRangeMainWorld(request(), scope(fetchFn)),
    ).resolves.toEqual({ ok: false, code: 'RANGE_RESPONSE_INVALID' });
  });
});
