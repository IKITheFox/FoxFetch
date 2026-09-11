import type { MediaRequestHeaders } from '../../shared/types';
import {
  isAllowedBilibiliMediaUrl,
  sniffIsoBmffTrackKind,
  type BilibiliTrackKind,
} from '../detector/bilibili-media';

const MAX_INIT_BYTES = 128 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_CACHE_ENTRIES = 128;

type FetchLike = typeof fetch;

const probes = new Map<string, Promise<BilibiliTrackKind | undefined>>();

function isBilibiliM4sUrl(value: string): boolean {
  if (!isAllowedBilibiliMediaUrl(value)) return false;
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.m4s');
  } catch {
    return false;
  }
}

async function readPrefix(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= MAX_INIT_BYTES ? bytes : bytes.subarray(0, MAX_INIT_BYTES);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < MAX_INIT_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value || next.value.byteLength === 0) continue;
      const remaining = MAX_INIT_BYTES - length;
      const chunk =
        next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value;
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (length === 0) return undefined;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function probeHeaders(requestHeaders?: MediaRequestHeaders): Headers {
  const headers = new Headers({ Range: `bytes=0-${MAX_INIT_BYTES - 1}` });
  if (requestHeaders?.accept) headers.set('Accept', requestHeaders.accept);
  if (requestHeaders?.authorization) headers.set('Authorization', requestHeaders.authorization);
  return headers;
}

async function executeProbe(
  url: string,
  requestHeaders: MediaRequestHeaders | undefined,
  fetchImpl: FetchLike,
): Promise<BilibiliTrackKind | undefined> {
  if (!isBilibiliM4sUrl(url)) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: probeHeaders(requestHeaders),
      credentials: 'include',
      signal: controller.signal,
      ...(requestHeaders?.referer ? { referrer: requestHeaders.referer } : {}),
    });
    if (!response.ok) return undefined;
    const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mime?.startsWith('text/') || mime?.includes('json') || mime?.includes('xml')) {
      return undefined;
    }
    const prefix = await readPrefix(response);
    if (!prefix) return undefined;
    const kind = sniffIsoBmffTrackKind(prefix);
    return kind === 'muxed' ? 'video' : kind;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe only the initialization prefix of a validated Bilibili M4S resource.
 * Results and in-flight work are coalesced so repeated range observations do
 * not create repeated network traffic.
 */
export function sniffBilibiliNetworkTrack(
  url: string,
  requestHeaders?: MediaRequestHeaders,
  fetchImpl: FetchLike = fetch,
): Promise<BilibiliTrackKind | undefined> {
  const cached = probes.get(url);
  if (cached) return cached;
  const probe = executeProbe(url, requestHeaders, fetchImpl);
  probes.set(url, probe);
  while (probes.size > MAX_PROBE_CACHE_ENTRIES) {
    const oldest = probes.keys().next().value as string | undefined;
    if (!oldest) break;
    probes.delete(oldest);
  }
  return probe;
}

export function isBilibiliTrackProbeCandidate(url: string): boolean {
  return isBilibiliM4sUrl(url);
}

/** Test and lifecycle helper; no media data is retained here. */
export function clearBilibiliTrackProbeCache(): void {
  probes.clear();
}
