import type { MediaKind } from '../../shared/types';
import { parseBilibiliMediaManifest } from './bilibili-media';

const MAX_INLINE_JSON_CHARS = 8 * 1024 * 1024;
const BILIBILI_ASSIGNMENT = /(?:^|[;\r\n])\s*window\s*\.\s*__playinfo__\s*=/gu;
const YOUTUBE_ASSIGNMENT = /(?:^|[;\r\n])\s*(?:var\s+)?ytInitialPlayerResponse\s*=/gu;

type JsonRecord = Record<string, unknown>;

export interface SiteMediaCandidate {
  url: string;
  source: 'manifest';
  kind: Extract<MediaKind, 'video' | 'audio'>;
  mime?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
}

interface ScriptCacheEntry {
  routeKey: string;
  text: string;
  candidates: SiteMediaCandidate[];
}

const scriptCache = new WeakMap<HTMLScriptElement, ScriptCacheEntry>();

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(record: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function byteSize(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number != null && Number.isSafeInteger(number) ? number : undefined;
}

function millisecondsToSeconds(value: unknown): number | undefined {
  const milliseconds = positiveNumber(value);
  return milliseconds == null ? undefined : milliseconds / 1_000;
}

/** Validate a media URL without rewriting its signed query string. */
function signedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function jsonObjectEnd(source: string, start: number): number | undefined {
  if (source[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    if (index - start > MAX_INLINE_JSON_CHARS) return undefined;
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    if (depth === 0) return index + 1;
    if (depth < 0) return undefined;
  }
  return undefined;
}

function assignedJsonObjects(source: string, assignment: RegExp): JsonRecord[] {
  const expression = new RegExp(assignment.source, assignment.flags);
  const values: JsonRecord[] = [];

  while (expression.exec(source) != null) {
    let start = expression.lastIndex;
    while (/\s/u.test(source[start] ?? '')) start += 1;
    const end = jsonObjectEnd(source, start);
    if (end == null) continue;
    try {
      const value = asRecord(JSON.parse(source.slice(start, end)) as unknown);
      if (value) values.push(value);
    } catch {
      // Inline data changes frequently; malformed or non-JSON assignments are ignored.
    }
    expression.lastIndex = end;
  }
  return values;
}

function hostMatches(pageUrl: string, domain: string): boolean {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function currentBilibiliId(pageUrl: string): string | undefined {
  try {
    return /\/video\/(BV[0-9A-Za-z]+)/u.exec(new URL(pageUrl).pathname)?.[1]?.toUpperCase();
  } catch {
    return undefined;
  }
}

function numericIdentifier(value: unknown): string | undefined {
  const raw =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/u.test(raw)) return undefined;
  return raw.replace(/^0+(?=\d)/u, '');
}

function currentBilibiliCid(pageUrl: string): string | undefined {
  try {
    return numericIdentifier(new URL(pageUrl).searchParams.get('cid'));
  } catch {
    return undefined;
  }
}

function currentYouTubeId(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    const candidate =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
    return candidate && /^[0-9A-Za-z_-]{6,32}$/u.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the identity of the media page rather than the complete browser URL.
 *
 * YouTube frequently changes playlist/tracking query parameters without changing
 * the playing item. Bilibili does the same for non-media query parameters. Keeping
 * those URLs on one route prevents a harmless query update from discarding a live
 * media snapshot, while a video id/part change still starts a clean snapshot.
 */
export function siteMediaRouteKey(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    if (hostMatches(pageUrl, 'youtube.com') || hostMatches(pageUrl, 'youtube-nocookie.com')) {
      const videoId = currentYouTubeId(pageUrl);
      if (videoId) return `youtube:${videoId}`;
    }
    if (hostMatches(pageUrl, 'bilibili.com')) {
      const videoId = currentBilibiliId(pageUrl);
      if (videoId) {
        const part = numericIdentifier(url.searchParams.get('p')) ?? '1';
        const cid = currentBilibiliCid(pageUrl) ?? '';
        return `bilibili:${videoId}:p=${part}:cid=${cid}`;
      }
    }

    // Hash routes are meaningful on generic SPAs, unlike YouTube/Bilibili's
    // playback-time and UI-only query parameters handled above.
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return pageUrl;
  }
}

function deduplicate(candidates: readonly SiteMediaCandidate[]): SiteMediaCandidate[] {
  const unique = new Map<string, SiteMediaCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.kind}\u0000${candidate.url}`, candidate);
  }
  return [...unique.values()];
}

function bilibiliCandidates(value: JsonRecord, pageUrl: string): SiteMediaCandidate[] {
  const pageVideoId = currentBilibiliId(pageUrl);
  if (!pageVideoId) return [];
  const pageCid = currentBilibiliCid(pageUrl);
  const parsed = parseBilibiliMediaManifest(value, {
    bvid: pageVideoId,
    ...(pageCid ? { cid: pageCid } : {}),
  });
  return (
    parsed?.candidates.map((candidate) => ({
      ...candidate,
      source: 'manifest' as const,
    })) ?? []
  );
}

function youTubeFormat(value: unknown, fallbackDuration?: number): SiteMediaCandidate | undefined {
  const format = asRecord(value);
  if (!format) return undefined;
  const url = signedHttpUrl(format.url);
  const mime = firstString(format, 'mimeType');
  const normalizedMime = mime?.toLowerCase();
  const kind = normalizedMime?.startsWith('video/')
    ? 'video'
    : normalizedMime?.startsWith('audio/')
      ? 'audio'
      : undefined;
  if (!url || !mime || !kind) return undefined;

  const width = kind === 'video' ? positiveNumber(format.width) : undefined;
  const height = kind === 'video' ? positiveNumber(format.height) : undefined;
  const duration = millisecondsToSeconds(format.approxDurationMs) ?? fallbackDuration;
  const size = byteSize(format.contentLength);
  return {
    url,
    source: 'manifest',
    kind,
    mime,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(duration == null ? {} : { duration }),
    ...(size == null ? {} : { size }),
  };
}

function youTubeCandidates(value: JsonRecord, pageUrl: string): SiteMediaCandidate[] {
  const currentVideoId = currentYouTubeId(pageUrl);
  const videoDetails = asRecord(value.videoDetails);
  const responseVideoId = firstString(videoDetails, 'videoId');
  if (!currentVideoId || responseVideoId !== currentVideoId) return [];

  const streamingData = asRecord(value.streamingData);
  if (!streamingData) return [];
  const fallbackDuration = positiveNumber(videoDetails?.lengthSeconds);
  const candidates: SiteMediaCandidate[] = [];
  for (const format of [
    ...asArray(streamingData.formats),
    ...asArray(streamingData.adaptiveFormats),
  ]) {
    const candidate = youTubeFormat(format, fallbackDuration);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function extractSiteMediaCandidatesFromScripts(
  scripts: readonly string[],
  pageUrl: string,
): SiteMediaCandidate[] {
  const candidates: SiteMediaCandidate[] = [];
  if (hostMatches(pageUrl, 'bilibili.com')) {
    for (const source of scripts) {
      for (const value of assignedJsonObjects(source, BILIBILI_ASSIGNMENT)) {
        candidates.push(...bilibiliCandidates(value, pageUrl));
      }
    }
  } else if (hostMatches(pageUrl, 'youtube.com') || hostMatches(pageUrl, 'youtube-nocookie.com')) {
    for (const source of scripts) {
      for (const value of assignedJsonObjects(source, YOUTUBE_ASSIGNMENT)) {
        candidates.push(...youTubeCandidates(value, pageUrl));
      }
    }
  }
  return deduplicate(candidates);
}

export function collectInlineSiteMedia(doc: Document): SiteMediaCandidate[] {
  const candidates: SiteMediaCandidate[] = [];
  const routeKey = siteMediaRouteKey(doc.URL);
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script:not([src])')) {
    const text = script.textContent ?? '';
    const cached = scriptCache.get(script);
    if (cached?.text === text) {
      // A script node left behind by an SPA can contain a Bilibili playinfo object
      // without an explicit bvid/cid. Do not reinterpret that unchanged payload as
      // belonging to the next route. A newly inserted or updated script is parsed
      // normally below.
      if (cached.routeKey === routeKey) candidates.push(...cached.candidates);
      continue;
    }
    const extracted = extractSiteMediaCandidatesFromScripts([text], doc.URL);
    scriptCache.set(script, { routeKey, text, candidates: extracted });
    candidates.push(...extracted);
  }
  return deduplicate(candidates);
}
