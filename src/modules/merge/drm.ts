import type { Box } from 'mp4box';
import type { DrmSignal } from './types';
import { createTimedMergeFetch } from './runtime-control';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface CapturedIsoBmffRange {
  bytes: ArrayBuffer;
  fileStart: number;
}

export interface GuardedFetchInspector {
  fetch: typeof fetch;
  getSignals(): Promise<DrmSignal[]>;
  /** Last unresolved non-OK status observed by the guarded UrlSource fetch. */
  getFailureHttpStatus(): number | undefined;
}

export class ProtectedMediaDetectedError extends Error {
  readonly signals: DrmSignal[];

  constructor(signals: DrmSignal[]) {
    super('Encrypted or DRM-protected media was detected.');
    this.name = 'ProtectedMediaDetectedError';
    this.signals = uniqueSignals(signals);
  }
}

function uniqueSignals(signals: Iterable<DrmSignal>): DrmSignal[] {
  return [...new Set(signals)];
}

function parseHlsAttributeList(line: string): Map<string, string> {
  const result = new Map<string, string>();
  const colon = line.indexOf(':');
  if (colon < 0) return result;

  const body = line.slice(colon + 1);
  for (const match of body.matchAll(/(?:^|,)([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi)) {
    const key = match[1]?.toUpperCase();
    const raw = match[2];
    if (!key || raw === undefined) continue;
    result.set(key, raw.replace(/^"|"$/g, ''));
  }
  return result;
}

export function detectManifestDrm(text: string): DrmSignal[] {
  const signals: DrmSignal[] = [];
  const normalized = text.replace(/^\uFEFF/, '');

  if (/^\s*#EXTM3U/m.test(normalized)) {
    for (const line of normalized.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!/^#EXT-X-(?:SESSION-)?KEY:/i.test(trimmed)) continue;
      const attributes = parseHlsAttributeList(trimmed);
      const method = attributes.get('METHOD')?.toUpperCase();
      const keyFormat = attributes.get('KEYFORMAT');
      if (method && method !== 'NONE') signals.push('hls-key');
      if (method?.includes('SAMPLE-AES')) signals.push('hls-sample-aes');
      if (keyFormat && keyFormat.toLowerCase() !== 'identity') signals.push('hls-keyformat');
    }
  }

  if (/<(?:[\w.-]+:)?ContentProtection\b/i.test(normalized)) {
    signals.push('dash-content-protection');
  }
  if (/(?:cenc:)?default_KID\s*=/i.test(normalized)) signals.push('dash-default-kid');
  if (/<(?:[\w.-]+:)?pssh\b/i.test(normalized)) signals.push('dash-pssh');

  return uniqueSignals(signals);
}

function isManifestResponse(url: string, response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // The URL is validated by the caller. Keep this helper defensive for injected fetch implementations.
  }
  return (
    contentType.includes('mpegurl') ||
    contentType.includes('dash+xml') ||
    pathname.endsWith('.m3u8') ||
    pathname.endsWith('.mpd')
  );
}

function isIsoBmffResponse(url: string, response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // See isManifestResponse.
  }
  return (
    contentType.includes('video/mp4') ||
    contentType.includes('audio/mp4') ||
    contentType.includes('application/mp4') ||
    /\.(?:mp4|m4a|m4v|mov|cmfv|cmfa)$/.test(pathname)
  );
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      parts.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    // A cloned Response uses a tee'd stream. Awaiting cancellation can wait for the untouched
    // original branch and deadlock guardedFetch before it has a chance to return that branch.
    void reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function responseRangeStart(response: Response): number {
  const contentRange = response.headers.get('content-range');
  const match = contentRange?.match(/^bytes\s+(\d+)-/i);
  return match?.[1] ? Number(match[1]) : 0;
}

function inputUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function combineAbortSignals(
  first: AbortSignal | null | undefined,
  second?: AbortSignal,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  if (first.aborted) return first;
  if (second.aborted) return second;

  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function visitBoxTree(root: Box[], BoxClass: typeof Box): Set<string> {
  const types = new Set<string>();
  const seen = new WeakSet<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) return;
    seen.add(value);

    if (value instanceof BoxClass) {
      types.add(value.type);
    }

    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child instanceof BoxClass || Array.isArray(child)) visit(child);
    }
  };

  visit(root);
  return types;
}

export async function detectIsoBmffDrm(ranges: CapturedIsoBmffRange[]): Promise<DrmSignal[]> {
  if (ranges.length === 0) return [];

  const { Box, MP4BoxBuffer, createFile } = await import('mp4box');
  const file = createFile(false);
  file.onError = () => undefined;

  for (const range of [...ranges].sort((a, b) => a.fileStart - b.fileStart)) {
    if (range.bytes.byteLength === 0) continue;
    try {
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(range.bytes, range.fileStart));
    } catch {
      // A range may begin inside an mdat. Other captured ranges and the internal codec ID remain useful.
    }
  }

  try {
    file.flush();
  } catch {
    // Partial probing is expected; parsed boxes are still safe to inspect.
  }

  const types = visitBoxTree(file.boxes, Box);
  const signals: DrmSignal[] = [];
  if (types.has('pssh')) signals.push('mp4-pssh');
  if (types.has('encv')) signals.push('mp4-encrypted-video-entry');
  if (types.has('enca')) signals.push('mp4-encrypted-audio-entry');
  if (types.has('sinf')) signals.push('mp4-sinf');
  if (types.has('tenc')) signals.push('mp4-tenc');
  return uniqueSignals(signals);
}

/** Memory-bounded DRM inspection for a locally staged ISO-BMFF representation. */
export async function detectIsoBmffBlobDrm(blob: Blob): Promise<DrmSignal[]> {
  const headEnd = Math.min(blob.size, 16 * 1024 * 1024);
  const tailStart = Math.max(headEnd, blob.size - 4 * 1024 * 1024);
  const ranges: CapturedIsoBmffRange[] = [
    { bytes: await blob.slice(0, headEnd).arrayBuffer(), fileStart: 0 },
  ];
  if (tailStart < blob.size) {
    ranges.push({ bytes: await blob.slice(tailStart).arrayBuffer(), fileStart: tailStart });
  }
  return detectIsoBmffDrm(ranges);
}

/** Wraps fetch so every HLS child playlist and MP4 range loaded by UrlSource is inspected. */
export function createGuardedFetchInspector(
  options: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    onReadBytes?: (bytes: number) => void;
  } = {},
): GuardedFetchInspector {
  const baseFetch = createTimedMergeFetch(
    options.fetchFn ?? globalThis.fetch.bind(globalThis),
    options.signal,
    options.onReadBytes,
  );
  const signals = new Set<DrmSignal>();
  const capturedRanges: CapturedIsoBmffRange[] = [];
  let captureIsoBmff = true;
  let capturedBytes = 0;
  let failureHttpStatus: number | undefined;

  const guardedFetch: typeof fetch = async (input, init) => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const signal = combineAbortSignals(init?.signal, options.signal);
    const response = await baseFetch(input, { ...init, ...(signal ? { signal } : {}) });
    const url = inputUrl(input);

    if (response.ok) failureHttpStatus = undefined;
    else if (Number.isInteger(response.status) && response.status >= 400) {
      failureHttpStatus = response.status;
    }

    if (response.ok && isManifestResponse(url, response)) {
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
        return response;
      }
      const bytes = await readLimited(response.clone(), MAX_MANIFEST_BYTES);
      const text = new TextDecoder().decode(bytes);
      const manifestSignals = detectManifestDrm(text);
      for (const signalName of manifestSignals) signals.add(signalName);
      if (manifestSignals.length > 0) throw new ProtectedMediaDetectedError(manifestSignals);
    } else if (response.ok && captureIsoBmff && isIsoBmffResponse(url, response)) {
      const remainingCaptureBudget = Math.max(0, 16 * 1024 * 1024 - capturedBytes);
      const bytes = await readLimited(
        response.clone(),
        Math.min(MAX_CAPTURE_BYTES, remainingCaptureBudget),
      );
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      capturedRanges.push({
        bytes: copy,
        fileStart: responseRangeStart(response),
      });
      capturedBytes += copy.byteLength;
    }

    return response;
  };

  return {
    fetch: guardedFetch,
    getFailureHttpStatus: () => failureHttpStatus,
    async getSignals() {
      for (const signal of await detectIsoBmffDrm(capturedRanges)) signals.add(signal);
      // Track probing has already forced the init/moov metadata to load. Continuing to retain every
      // media range during a multi-gigabyte remux would defeat the streaming design.
      captureIsoBmff = false;
      capturedRanges.length = 0;
      capturedBytes = 0;
      return uniqueSignals(signals);
    },
  };
}

export function signalsFromInternalCodecId(
  internalCodecId: string | number | Uint8Array<ArrayBufferLike> | null,
): DrmSignal[] {
  if (typeof internalCodecId !== 'string') return [];
  const normalized = internalCodecId.toLowerCase();
  if (normalized === 'encv') return ['mp4-encrypted-video-entry'];
  if (normalized === 'enca') return ['mp4-encrypted-audio-entry'];
  return [];
}
