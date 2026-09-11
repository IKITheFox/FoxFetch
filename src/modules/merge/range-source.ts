import { mergeError } from './errors';
import type { MergeNetworkDiagnostic } from './types';

function integer(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

/** Keep non-range/HLS reads unchanged; never hand a sequential body to UrlSource. */
export function createStrictRangeFetch(
  fetchFn: typeof fetch,
  onResponse?: (diagnostic: MergeNetworkDiagnostic) => void,
): typeof fetch {
  const identities = new Map<
    string,
    { total: number; etag: string | null; modified: string | null }
  >();
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const requested = headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/u);
    const response = await fetchFn(input, init);
    if (!requested || !response.ok) return response;
    const requestStart = integer(requested[1]!);
    const requestEnd = requested[2] ? integer(requested[2]) : undefined;
    const stop = () => {
      void response.body?.cancel().catch(() => undefined);
    };
    if (response.status === 200) {
      stop();
      throw mergeError('RANGE_RESPONSE_INVALID', '来源未继续支持分段读取，需改用磁盘顺序暂存。', {
        reason: 'RANGE_UNSUPPORTED',
        stage: 'source-headers',
        retryable: true,
        network: {
          readMode: 'sequential',
          fallback: 'range-unavailable',
          responseStatus: 200,
          ...(requestStart == null ? {} : { requestStart }),
        },
      });
    }
    const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/iu);
    const start = match ? integer(match[1]!) : undefined;
    const end = match ? integer(match[2]!) : undefined;
    const total = match ? integer(match[3]!) : undefined;
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader == null ? undefined : integer(lengthHeader);
    const url = input instanceof Request ? input.url : String(input);
    const previous = identities.get(url);
    const etag = response.headers.get('etag');
    const modified = response.headers.get('last-modified');
    const valid =
      response.status === 206 &&
      requestStart != null &&
      start === requestStart &&
      end != null &&
      total != null &&
      total > 0 &&
      end >= start &&
      end < total &&
      (requestEnd == null || end <= requestEnd) &&
      (lengthHeader == null || length === end - start + 1) &&
      (!previous ||
        (previous.total === total && previous.etag === etag && previous.modified === modified));
    if (!valid) {
      stop();
      throw mergeError(
        'RANGE_RESPONSE_INVALID',
        '来源的分段范围或资源版本发生变化，已停止随机读取。',
        {
          reason: 'RANGE_INVALID',
          stage: 'source-headers',
          retryable: true,
          network: {
            readMode: 'range',
            responseStatus: response.status,
            ...(requestStart == null ? {} : { requestStart }),
          },
        },
      );
    }
    if (previous && !(etag && !etag.startsWith('W/')) && !modified) {
      stop();
      throw mergeError('RANGE_RESPONSE_INVALID', '来源未提供跨分段一致性标记，需从零完整读取。', {
        reason: 'RANGE_UNSUPPORTED',
        stage: 'source-headers',
        retryable: true,
        network: {
          readMode: 'sequential',
          fallback: 'range-unavailable',
          responseStatus: 206,
          requestStart,
        },
      });
    }
    identities.set(url, { total, etag, modified });
    onResponse?.({
      readMode: 'range',
      responseStatus: 206,
      requestStart,
      responseStart: start,
      responseEnd: end,
      totalBytes: total,
    });
    return response;
  };
}
