export const BILIBILI_PAGE_RANGE_CHUNK_BYTES = 1 * 1024 * 1024;
export const BILIBILI_PAGE_RANGE_MAX_TRACK_BYTES = 512 * 1024 * 1024 * 1024;

export interface BilibiliPageRangeRequest {
  /** Random attempt nonce; never a private job id or durable capability. */
  cancellationId?: string;
  bvid: string;
  cid: string;
  /** The first request discovers the current entry revision; every later request pins it. */
  revision?: number;
  url: string;
  kind: 'video' | 'audio';
  representationKey: string;
  start: number;
  end: number;
}

export type BilibiliPageRangeFailureCode =
  | 'INVALID_REQUEST'
  | 'ROUTE_MISMATCH'
  | 'CACHE_MISMATCH'
  | 'CANDIDATE_MISMATCH'
  | 'FETCH_FAILED'
  | 'HTTP_STATUS_INVALID'
  | 'RANGE_RESPONSE_INVALID'
  | 'BODY_SIZE_INVALID';

export type BilibiliPageRangeResult =
  | {
      ok: true;
      status: 206;
      bvid: string;
      cid: string;
      revision: number;
      url: string;
      kind: 'video' | 'audio';
      representationKey: string;
      start: number;
      end: number;
      total: number;
      contentLength: number;
      /** A response validator is optional, but when present the caller pins it across chunks. */
      resourceValidator?: string;
      bytesBase64: string;
    }
  | {
      ok: false;
      code: BilibiliPageRangeFailureCode;
      status?: number;
    };

interface PageRangeScope {
  location: Pick<Location, 'href'>;
  fetch?: typeof fetch;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
  __INITIAL_STATE__?: unknown;
  __playinfo__?: unknown;
  __foxfetchBilibiliManifestCacheV1__?: unknown;
  __foxfetchBilibiliManifestCaptureStateV2__?: unknown;
}

/**
 * Fetch one bounded byte range with the page's original fetch implementation.
 *
 * The body is intentionally self-contained because Chrome serializes this
 * function for `chrome.scripting.executeScript({ world: 'MAIN' })`. It never
 * reads or returns cookies, Authorization headers, storage, or DRM material.
 */
export async function fetchCapturedBilibiliPageRangeMainWorld(
  request: BilibiliPageRangeRequest,
  providedScope?: PageRangeScope,
): Promise<BilibiliPageRangeResult> {
  type JsonRecord = Record<string, unknown>;
  const scope = providedScope ?? (window as unknown as PageRangeScope);
  const failure = (
    code: BilibiliPageRangeFailureCode,
    status?: number,
  ): BilibiliPageRangeResult => ({ ok: false, code, ...(status == null ? {} : { status }) });
  const asRecord = (value: unknown): JsonRecord | undefined =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  const safeGet = (value: unknown, key: PropertyKey): unknown => {
    if ((typeof value !== 'object' || value == null) && typeof value !== 'function') {
      return undefined;
    }
    try {
      return Reflect.get(value, key);
    } catch {
      return undefined;
    }
  };
  const records = (value: unknown): JsonRecord[] =>
    Array.isArray(value) ? value.map(asRecord).filter((entry): entry is JsonRecord => !!entry) : [];
  const normalizedBvid = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return /^BV[0-9A-Z]+$/u.test(normalized) ? normalized : undefined;
  };
  const numericId = (value: unknown): string | undefined => {
    const raw =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/u.test(raw)) return undefined;
    const normalized = raw.replace(/^0+(?=\d)/u, '');
    return normalized !== '0' ? normalized : undefined;
  };
  const positiveInteger = (value: unknown): number | undefined => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const allowedMediaUrl = (value: string): string | undefined => {
    if (!value || value.length > 32_768) return undefined;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
      const hostname = parsed.hostname.toLowerCase();
      const suffix = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
      const allowedHost =
        suffix('bilivideo.com') ||
        suffix('bilivideo.cn') ||
        suffix('mountaintoys.cn') ||
        /^upos-[a-z0-9-]+\.akamaized\.net$/u.test(hostname);
      const pathname = parsed.pathname.toLowerCase();
      const extension = /\.([a-z0-9]{1,8})$/u.exec(pathname)?.[1];
      if (
        !allowedHost ||
        !extension ||
        !['flv', 'm4a', 'm4s', 'mp4'].includes(extension) ||
        !/^\/(?:upgcxcode\/|ugc\/|v1\/resource\/)/u.test(pathname)
      ) {
        return undefined;
      }
      return parsed.href;
    } catch {
      return undefined;
    }
  };
  const currentIdentity = (): { bvid: string; cid?: string } | undefined => {
    let page: URL;
    try {
      page = new URL(scope.location.href);
    } catch {
      return undefined;
    }
    if (!(page.hostname === 'bilibili.com' || page.hostname.endsWith('.bilibili.com'))) {
      return undefined;
    }
    const bvid = normalizedBvid(/\/video\/(BV[0-9A-Za-z]+)/iu.exec(page.pathname)?.[1]);
    if (!bvid) return undefined;
    const routeCid = numericId(page.searchParams.get('cid'));
    const part = numericId(page.searchParams.get('p')) ?? '1';

    const initial = asRecord(safeGet(scope, '__INITIAL_STATE__'));
    const video =
      asRecord(safeGet(initial, 'videoData')) ?? asRecord(safeGet(initial, 'videoInfo'));
    const initialBvid =
      normalizedBvid(safeGet(initial, 'bvid')) ?? normalizedBvid(safeGet(video, 'bvid'));
    const pages = initialBvid === bvid ? records(safeGet(video, 'pages')) : [];
    const selected = pages.find((entry) => numericId(safeGet(entry, 'page')) === part);
    const initialCid =
      initialBvid === bvid
        ? (numericId(safeGet(selected, 'cid')) ??
          (pages.length === 0
            ? numericId(safeGet(video, 'cid') ?? safeGet(initial, 'cid'))
            : undefined))
        : undefined;

    const playInfo = asRecord(safeGet(scope, '__playinfo__'));
    const payload =
      asRecord(safeGet(playInfo, 'data')) ?? asRecord(safeGet(playInfo, 'result')) ?? playInfo;
    const videoInfo =
      asRecord(safeGet(payload, 'video_info')) ?? asRecord(safeGet(payload, 'videoInfo'));
    const playBvid =
      normalizedBvid(safeGet(playInfo, 'bvid')) ??
      normalizedBvid(safeGet(payload, 'bvid')) ??
      normalizedBvid(safeGet(videoInfo, 'bvid'));
    const playCid =
      playBvid === bvid
        ? numericId(
            safeGet(playInfo, 'cid') ?? safeGet(payload, 'cid') ?? safeGet(videoInfo, 'cid'),
          )
        : undefined;
    const cid = routeCid ?? initialCid ?? playCid;
    return { bvid, ...(cid ? { cid } : {}) };
  };
  const parseContentRange = (
    value: string | null,
  ): { start: number; end: number; total: number } | undefined => {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu.exec(value?.trim() ?? '');
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    return Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      Number.isSafeInteger(total) &&
      start >= 0 &&
      end >= start &&
      total > end &&
      total <= 512 * 1024 * 1024 * 1024
      ? { start, end, total }
      : undefined;
  };
  const responseValidator = (headers: Headers): string | undefined => {
    const etag = headers.get('etag')?.trim();
    if (etag && etag.length <= 256 && !etag.startsWith('W/') && !/[\r\n]/u.test(etag)) {
      return `etag:${etag}`;
    }
    const modified = headers.get('last-modified')?.trim();
    return modified && modified.length <= 128 && !/[\r\n]/u.test(modified)
      ? `last-modified:${modified}`
      : undefined;
  };
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
      const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + 32_768));
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  };

  const bvid = normalizedBvid(request?.bvid);
  const cid = numericId(request?.cid);
  const normalizedUrl = typeof request?.url === 'string' ? allowedMediaUrl(request.url) : undefined;
  const revision = request?.revision == null ? undefined : positiveInteger(request.revision);
  if (
    !bvid ||
    !cid ||
    !normalizedUrl ||
    normalizedUrl !== request.url ||
    (request.kind !== 'video' && request.kind !== 'audio') ||
    typeof request.representationKey !== 'string' ||
    request.representationKey.length === 0 ||
    request.representationKey.length > 256 ||
    !Number.isSafeInteger(request.start) ||
    !Number.isSafeInteger(request.end) ||
    request.start < 0 ||
    request.end < request.start ||
    request.end - request.start + 1 > 1 * 1024 * 1024 ||
    request.end >= 512 * 1024 * 1024 * 1024 ||
    (request.revision != null && revision == null)
  ) {
    return failure('INVALID_REQUEST');
  }

  const route = currentIdentity();
  if (!route || route.bvid !== bvid || (route.cid != null && route.cid !== cid)) {
    return failure('ROUTE_MISMATCH');
  }

  const cache = asRecord(safeGet(scope, '__foxfetchBilibiliManifestCacheV1__'));
  const now = Date.now();
  const entries = records(safeGet(cache, 'entries'));
  const matchingEntries = entries.filter(
    (entry) =>
      safeGet(entry, 'version') === 1 &&
      normalizedBvid(safeGet(entry, 'bvid')) === bvid &&
      numericId(safeGet(entry, 'cid')) === cid &&
      positiveInteger(safeGet(entry, 'revision')) != null &&
      typeof safeGet(entry, 'capturedAt') === 'number' &&
      Number.isFinite(safeGet(entry, 'capturedAt')) &&
      now - Number(safeGet(entry, 'capturedAt')) >= -60_000 &&
      now - Number(safeGet(entry, 'capturedAt')) <= 10 * 60_000,
  );
  const entry = matchingEntries.find(
    (candidate) => revision == null || positiveInteger(safeGet(candidate, 'revision')) === revision,
  );
  const entryRevision = positiveInteger(safeGet(entry, 'revision'));
  if (!entry || !entryRevision || (revision != null && entryRevision !== revision)) {
    return failure('CACHE_MISMATCH');
  }

  const candidate = records(safeGet(entry, 'candidates')).find((value) => {
    const representation = asRecord(safeGet(value, 'representation'));
    return (
      safeGet(value, 'url') === request.url &&
      safeGet(value, 'kind') === request.kind &&
      safeGet(representation, 'provider') === 'bilibili' &&
      safeGet(representation, 'key') === request.representationKey &&
      normalizedBvid(safeGet(representation, 'bvid')) === bvid &&
      numericId(safeGet(representation, 'cid')) === cid
    );
  });
  if (!candidate) return failure('CANDIDATE_MISMATCH');

  const installState = asRecord(safeGet(scope, '__foxfetchBilibiliManifestCaptureStateV2__'));
  const fetchBinding = asRecord(safeGet(installState, 'fetch'));
  const originalFetch = safeGet(fetchBinding, 'source');
  if (typeof originalFetch !== 'function') return failure('CACHE_MISMATCH');

  const controller = new AbortController();
  const cancellationId =
    typeof request.cancellationId === 'string' &&
    /^[0-9a-z-]{20,128}$/iu.test(request.cancellationId)
      ? request.cancellationId
      : undefined;
  const cancel: EventListener = (event) => {
    if (cancellationId && (event as CustomEvent<unknown>).detail === cancellationId)
      controller.abort();
  };
  if (cancellationId) scope.addEventListener?.('foxfetch-cancel-page-range-v1', cancel);
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = (await Reflect.apply(originalFetch, scope, [
        request.url,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          headers: { Range: `bytes=${request.start}-${request.end}` },
          signal: controller.signal,
        } satisfies RequestInit,
      ])) as Response;
    } catch {
      return failure('FETCH_FAILED');
    }
    if (!response || response.status !== 206) {
      return failure(
        'HTTP_STATUS_INVALID',
        Number.isInteger(response?.status) ? response.status : undefined,
      );
    }
    let responseUrl: string;
    try {
      responseUrl = new URL(response.url).href;
    } catch {
      return failure('RANGE_RESPONSE_INVALID');
    }
    if (responseUrl !== normalizedUrl) return failure('RANGE_RESPONSE_INVALID');
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') return failure('RANGE_RESPONSE_INVALID');
    const range = parseContentRange(response.headers.get('content-range'));
    const contentLength = positiveInteger(response.headers.get('content-length'));
    if (
      !range ||
      !contentLength ||
      range.start !== request.start ||
      range.end > request.end ||
      (range.end < request.end && range.end !== range.total - 1) ||
      contentLength !== range.end - range.start + 1
    ) {
      return failure('RANGE_RESPONSE_INVALID');
    }
    const declaredCandidateSize = positiveInteger(safeGet(candidate, 'size'));
    if (declaredCandidateSize != null && declaredCandidateSize !== range.total) {
      return failure('RANGE_RESPONSE_INVALID');
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return failure('FETCH_FAILED');
    }
    if (bytes.byteLength !== contentLength || bytes.byteLength > 1 * 1024 * 1024) {
      return failure('BODY_SIZE_INVALID');
    }
    const validator = responseValidator(response.headers);
    return {
      ok: true,
      status: 206,
      bvid,
      cid,
      revision: entryRevision,
      url: request.url,
      kind: request.kind,
      representationKey: request.representationKey,
      start: range.start,
      end: range.end,
      total: range.total,
      contentLength,
      ...(validator ? { resourceValidator: validator } : {}),
      bytesBase64: toBase64(bytes),
    };
  } finally {
    // Rejected headers must not leave an unread network body running either.
    controller.abort();
    clearTimeout(timeout);
    if (cancellationId) scope.removeEventListener?.('foxfetch-cancel-page-range-v1', cancel);
  }
}

/** Serialized into the same document as a bounded in-flight page range. */
export function cancelCapturedBilibiliPageRangeMainWorld(cancellationId: string): void {
  if (!/^[0-9a-z-]{20,128}$/iu.test(cancellationId)) return;
  window.dispatchEvent(
    new CustomEvent('foxfetch-cancel-page-range-v1', { detail: cancellationId }),
  );
}
