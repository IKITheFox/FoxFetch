/** Transport evidence only. A complete HTTP response does not prove that its
 * media tracks, duration, language or codec match the selected video.
 */
export interface YouTubeDirectReadEvidence {
  bytes: number;
  declaredBytes: number | null;
  responseStatus: 200 | 206;
  mediaVerified: false;
}

/** Reads the exact supplied source without signature rewriting or fallback.
 * The caller must privately bind this address to the current selected format,
 * then verify the staged media before making any output available to Chrome.
 */
export async function acquireYouTubeDirectFile(
  address: string,
  options: {
    destination: WritableStream<Uint8Array>;
    signal: AbortSignal;
    expectedBytes?: number;
    fetch?: typeof fetch;
    onProgress?: (bytes: number) => void;
    onTotal?: (bytes: number | null) => void;
    idleTimeoutMs?: number;
  },
): Promise<YouTubeDirectReadEvidence> {
  options.signal.throwIfAborted();
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('SOURCE_NOT_ALLOWED');
  }
  if (
    address.length > 32768 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) ||
    url.pathname !== '/videoplayback'
  )
    throw new Error('SOURCE_NOT_ALLOWED');
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0)
  )
    throw new Error('SOURCE_SIZE_INVALID');
  const timeout = options.idleTimeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300_000)
    throw new Error('SOURCE_TIMEOUT_INVALID');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  };
  const abort = () => controller.abort();
  const writer = options.destination.getWriter();
  options.signal.addEventListener('abort', abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writing = false;
  try {
    resetTimer();
    const response = await (options.fetch ?? fetch)(address, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error('DIRECT_READ_ABORTED');
    if (response.status !== 200 && response.status !== 206)
      throw new Error(
        response.status === 401 || response.status === 403 || response.status === 410
          ? 'SOURCE_ADDRESS_REJECTED'
          : 'SOURCE_HTTP_ERROR',
      );
    const numericSize = (value: string | null): number | null => {
      if (value === null) return null;
      const size = /^\d+$/u.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error('SOURCE_SIZE_INVALID');
      return size;
    };
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') throw new Error('SOURCE_ENCODING_UNSUPPORTED');
    const contentLength = numericSize(response.headers.get('content-length'));
    let declaredBytes = contentLength;
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
      if (!range) throw new Error('SOURCE_PARTIAL_RESPONSE');
      declaredBytes = numericSize(range[2]!);
      if (
        Number(range[1]) !== declaredBytes! - 1 ||
        (contentLength !== null && contentLength !== declaredBytes)
      )
        throw new Error('SOURCE_PARTIAL_RESPONSE');
    } else if (response.headers.has('content-range')) throw new Error('SOURCE_PARTIAL_RESPONSE');
    if (
      options.expectedBytes !== undefined &&
      declaredBytes !== null &&
      options.expectedBytes !== declaredBytes
    )
      throw new Error('SOURCE_SIZE_MISMATCH');
    declaredBytes ??= options.expectedBytes ?? null;
    options.onTotal?.(declaredBytes);
    if (!response.body) throw new Error('SOURCE_BODY_MISSING');
    reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      resetTimer();
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw new Error('DIRECT_READ_ABORTED');
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > 32 * 1024 * 1024)
        throw new Error('SOURCE_CHUNK_INVALID');
      bytes += value.byteLength;
      if (!Number.isSafeInteger(bytes) || (declaredBytes !== null && bytes > declaredBytes))
        throw new Error('SOURCE_SIZE_MISMATCH');
      clearTimeout(timer); // Local storage backpressure is not a network idle timeout.
      writing = true;
      await writer.write(value);
      writing = false;
      if (controller.signal.aborted) throw new Error('DIRECT_READ_ABORTED');
      options.onProgress?.(bytes);
    }
    clearTimeout(timer);
    if (!bytes || (declaredBytes !== null && bytes !== declaredBytes))
      throw new Error('SOURCE_SIZE_MISMATCH');
    writing = true;
    await writer.close();
    writing = false;
    options.signal.throwIfAborted();
    return { bytes, declaredBytes, responseStatus: response.status, mediaVerified: false };
  } catch (error) {
    options.onTotal?.(null);
    controller.abort();
    await Promise.allSettled([reader?.cancel(), writer.abort()]);
    /* eslint-disable preserve-caught-error -- Network causes may contain private signed media URLs. */
    if (options.signal.aborted) throw new Error('DOWNLOAD_CANCELED');
    if (timedOut) throw new Error('SOURCE_READ_TIMEOUT');
    if (writing)
      throw new Error(
        error instanceof Error && error.name === 'QuotaExceededError'
          ? 'SOURCE_STORAGE_FULL'
          : 'SOURCE_STORAGE_FAILED',
      );
    // Never include the signed address or raw network exception in diagnostics.
    const code = error instanceof Error ? error.message : '';
    throw new Error(/^SOURCE_[A-Z_]+$/u.test(code) ? code : 'SOURCE_READ_FAILED');
    /* eslint-enable preserve-caught-error */
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    reader?.releaseLock();
    writer.releaseLock();
  }
}
