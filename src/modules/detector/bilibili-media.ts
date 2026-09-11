import type {
  BilibiliAudioType,
  BilibiliDynamicRange,
  BilibiliDynamicRangeEvidence,
  BilibiliMediaRepresentation,
  BilibiliRepresentationCapabilities,
} from '../../shared/types';
import {
  classifyBilibiliDynamicRange,
  type BilibiliDynamicRangeClassification,
} from './bilibili-dynamic-range';

export type BilibiliTrackKind = 'video' | 'audio';

export interface BilibiliMediaCandidate {
  url: string;
  kind: BilibiliTrackKind;
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  representation?: BilibiliMediaRepresentation;
}

export interface BilibiliManifestIdentity {
  bvid: string;
  cid?: string;
}

export interface ParsedBilibiliManifest {
  identity: BilibiliManifestIdentity;
  candidates: BilibiliMediaCandidate[];
  diagnostics: BilibiliManifestDiagnostics;
}

export interface BilibiliAdvertisedFormatDiagnostic {
  qn: number;
  description?: string;
  dynamicRange: BilibiliDynamicRange;
  dynamicRangeEvidence: BilibiliDynamicRangeEvidence[];
  capabilities: BilibiliRepresentationCapabilities;
}

export interface BilibiliManifestDiagnostics {
  advertisedFormats: BilibiliAdvertisedFormatDiagnostic[];
  deliveredRepresentationKeys: string[];
}

type JsonRecord = Record<string, unknown>;

const MAX_MEDIA_URL_LENGTH = 32_768;
const MAX_CANDIDATES = 256;
const BILIBILI_MEDIA_EXTENSIONS = new Set(['flv', 'm4a', 'm4s', 'mp4']);

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function firstRecord(...values: unknown[]): JsonRecord | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

function firstString(record: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() && value.length <= MAX_MEDIA_URL_LENGTH) {
      return value.trim();
    }
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 && !/[\r\n]/u.test(normalized)
    ? normalized
    : undefined;
}

function frameRate(value: unknown): string | undefined {
  const normalized =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (
    !normalized ||
    normalized.length > 64 ||
    !/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizedFrameRate(value?: string): string {
  if (!value) return 'unknown';
  const [numeratorValue, denominatorValue] = value.split('/');
  const numerator = Number(numeratorValue);
  const denominator = denominatorValue == null ? 1 : Number(denominatorValue);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return value.toLowerCase();
  }
  return String(Math.round((numerator / denominator) * 1_000) / 1_000);
}

function dynamicRangeFor(
  representation: JsonRecord,
  qn: number | undefined,
  description: string | undefined,
  codecs: string | undefined,
): BilibiliDynamicRangeClassification {
  const raw = shortString(
    representation.dynamicRange ??
      representation.dynamic_range ??
      representation.hdrType ??
      representation.hdr_type,
  );
  return classifyBilibiliDynamicRange({
    ...(raw ? { explicit: raw } : {}),
    ...(qn == null ? {} : { qn }),
    ...(codecs ? { codecs } : {}),
    ...(description ? { description } : {}),
  });
}

function supportFormatMap(payload: JsonRecord): Map<number, JsonRecord> {
  const formats = new Map<number, JsonRecord>();
  for (const value of asArray(payload.support_formats ?? payload.supportFormats)) {
    const record = asRecord(value);
    const qn = positiveInteger(record?.quality ?? record?.qn ?? record?.id);
    if (record && qn != null) formats.set(qn, record);
  }
  return formats;
}

function representationMetadata(
  representation: JsonRecord,
  kind: BilibiliTrackKind,
  support: JsonRecord | undefined,
  audioType?: BilibiliAudioType,
): BilibiliMediaRepresentation {
  const id = positiveInteger(representation.id);
  const explicitQuality = positiveInteger(representation.quality);
  const qn = explicitQuality ?? id;
  const codecid = positiveInteger(representation.codecid ?? representation.codec_id);
  const codecs = normalizedCodecList(representation.codecs);
  const rate = frameRate(representation.frameRate ?? representation.frame_rate);
  const bandwidth = positiveInteger(representation.bandwidth);
  const newDescription =
    shortString(representation.new_description ?? representation.newDescription) ??
    shortString(support?.new_description ?? support?.newDescription);
  const legacyDescription =
    shortString(representation.description) ?? shortString(support?.description);
  const description = newDescription ?? legacyDescription;
  const displayDescription =
    shortString(representation.display_desc ?? representation.displayDescription) ??
    shortString(support?.display_desc ?? support?.displayDescription);
  const superscript = shortString(representation.superscript) ?? shortString(support?.superscript);
  const dynamic = dynamicRangeFor(
    representation,
    qn,
    [description, displayDescription, superscript].filter(Boolean).join(' ') || undefined,
    codecs,
  );
  const dynamicRange = dynamic.dynamicRange;
  const identity = [
    kind,
    qn ?? id ?? 'unknown',
    codecid ?? codecs?.toLowerCase() ?? 'unknown',
    normalizedFrameRate(rate),
    dynamicRange.toLowerCase().replace(/\s+/gu, '-'),
    kind === 'audio' ? (audioType ?? 'unknown').toLowerCase() : '',
  ].join(':');
  return {
    provider: 'bilibili',
    key: `bilibili:${identity}`,
    delivery: 'dash',
    ...(id == null ? {} : { id }),
    ...(qn == null ? {} : { qn }),
    ...(explicitQuality == null ? {} : { quality: explicitQuality }),
    ...(codecid == null ? {} : { codecid }),
    ...(codecs ? { codecs } : {}),
    ...(dynamic.codecProfile ? { codecProfile: dynamic.codecProfile } : {}),
    ...(dynamic.dolbyVisionProfile == null
      ? {}
      : { dolbyVisionProfile: dynamic.dolbyVisionProfile }),
    ...(rate ? { frameRate: rate } : {}),
    ...(bandwidth == null ? {} : { bandwidth }),
    ...(description ? { description } : {}),
    ...(newDescription ? { newDescription } : {}),
    ...(displayDescription ? { displayDescription } : {}),
    ...(superscript ? { superscript } : {}),
    dynamicRange,
    dynamicRangeEvidence: dynamic.evidence,
    capabilities: {
      advertised: support != null,
      delivered: true,
      decodable: 'unknown',
      remuxable: dynamic.evidence.some((item) => item.source === 'conflict')
        ? 'unsupported'
        : 'unknown',
    },
    ...(kind === 'audio' ? { audioType: audioType ?? 'unknown' } : {}),
  };
}

export function normalizeBilibiliNumericId(value: unknown): string | undefined {
  const raw =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/u.test(raw)) return undefined;
  const normalized = raw.replace(/^0+(?=\d)/u, '');
  return normalized !== '0' ? normalized : undefined;
}

export function normalizeBilibiliBvid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return /^BV[0-9A-Z]+$/u.test(normalized) ? normalized : undefined;
}

function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Bilibili currently serves UGC files from its own bilivideo domains, selected
 * mountaintoys mirrors, and narrowly named Akamai UPOS mirrors. A domain suffix
 * alone is insufficient for the third-party CDNs, so every accepted URL must
 * also use the immutable UGC media path and a known media extension.
 */
export function isAllowedBilibiliMediaUrl(value: string): boolean {
  if (!value || value.length > MAX_MEDIA_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    const firstParty =
      hostnameMatches(hostname, 'bilivideo.com') || hostnameMatches(hostname, 'bilivideo.cn');
    const mountainMirror = hostnameMatches(hostname, 'mountaintoys.cn');
    const akamaiMirror = /^upos-[a-z0-9-]+\.akamaized\.net$/u.test(hostname);
    if (!firstParty && !mountainMirror && !akamaiMirror) return false;

    const pathname = url.pathname.toLowerCase();
    const extension = /\.([a-z0-9]{1,8})$/u.exec(pathname)?.[1];
    if (!extension || !BILIBILI_MEDIA_EXTENSIONS.has(extension)) return false;
    return /^\/(?:upgcxcode\/|ugc\/|v1\/resource\/)/u.test(pathname);
  } catch {
    return false;
  }
}

export function isBilibiliPlayurlApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'api.bilibili.com' &&
      /^\/x\/player\/(?:wbi\/)?playurl$/u.test(url.pathname) &&
      normalizeBilibiliBvid(url.searchParams.get('bvid')) != null &&
      normalizeBilibiliNumericId(url.searchParams.get('cid')) != null
    );
  } catch {
    return false;
  }
}

function normalizedCodecList(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 192 ||
    !/^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized.replace(/\s*,\s*/gu, ', ');
}

function mediaMimeForUrl(
  url: string,
  kind: BilibiliTrackKind,
  declared?: string,
  codecs?: unknown,
): string {
  const normalized = declared?.trim();
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  // A durl is a progressive A/V resource. The audio codec marker lets the
  // product layer distinguish it from a video-only DASH representation.
  const base =
    normalized?.toLowerCase().startsWith(`${kind}/`) && normalized.length <= 256
      ? normalized
      : kind === 'audio'
        ? 'audio/mp4'
        : extension === 'flv'
          ? 'video/x-flv; codecs="mp4a"'
          : 'video/mp4; codecs="mp4a"';
  if (/;\s*codecs\s*=/iu.test(base)) return base;
  const codecList = normalizedCodecList(codecs);
  return codecList ? `${base}; codecs="${codecList}"` : base;
}

function appendRepresentation(
  output: BilibiliMediaCandidate[],
  seen: Set<string>,
  value: unknown,
  kind: BilibiliTrackKind,
  duration?: number,
  support?: JsonRecord,
  audioType?: BilibiliAudioType,
): void {
  const representation = asRecord(value);
  if (!representation) return;
  const declaredMime = firstString(representation, 'mimeType', 'mime_type');
  const width = kind === 'video' ? positiveInteger(representation.width) : undefined;
  const height = kind === 'video' ? positiveInteger(representation.height) : undefined;
  const size = positiveInteger(representation.contentLength ?? representation.content_length);
  const metadata = representationMetadata(representation, kind, support, audioType);
  for (const [sourceIndex, rawUrl] of [
    representation.baseUrl,
    representation.base_url,
    ...asList(representation.backupUrl),
    ...asList(representation.backup_url),
  ].entries()) {
    if (typeof rawUrl !== 'string') continue;
    const url = rawUrl.trim();
    if (!isAllowedBilibiliMediaUrl(url)) continue;
    const mime = mediaMimeForUrl(url, kind, declaredMime, representation.codecs);
    const key = `${kind}\u0000${url}`;
    if (seen.has(key) || output.length >= MAX_CANDIDATES) continue;
    seen.add(key);
    output.push({
      url,
      kind,
      mime,
      ...(width == null ? {} : { width }),
      ...(height == null ? {} : { height }),
      ...(duration == null ? {} : { duration }),
      ...(size == null ? {} : { size }),
      representation: { ...metadata, sourceIndex },
    });
  }
}

function appendDurl(
  output: BilibiliMediaCandidate[],
  seen: Set<string>,
  value: unknown,
  fallbackDuration?: number,
): void {
  const entries = asArray(value);
  for (const [index, item] of entries.entries()) {
    const record = asRecord(item);
    if (!record) continue;
    const itemDurationMs = positiveNumber(record.length);
    const duration = itemDurationMs == null ? fallbackDuration : itemDurationMs / 1_000;
    const size = positiveInteger(record.size);
    const quality = positiveInteger(record.quality);
    const metadata: BilibiliMediaRepresentation = {
      provider: 'bilibili',
      key: `bilibili:durl:${quality ?? 'unknown'}:${index}`,
      delivery: 'durl',
      ...(quality == null ? {} : { qn: quality, quality }),
      audioType: 'AAC',
      dynamicRange: 'SDR',
      dynamicRangeEvidence: [{ source: 'default-sdr', range: 'SDR' }],
      capabilities: {
        advertised: false,
        delivered: true,
        decodable: 'unknown',
        remuxable: 'unknown',
      },
    };
    for (const [sourceIndex, rawUrl] of [
      record.url,
      ...asList(record.backupUrl),
      ...asList(record.backup_url),
    ].entries()) {
      if (typeof rawUrl !== 'string') continue;
      const url = rawUrl.trim();
      if (!isAllowedBilibiliMediaUrl(url)) continue;
      const key = `video\u0000${url}`;
      if (seen.has(key) || output.length >= MAX_CANDIDATES) continue;
      seen.add(key);
      output.push({
        url,
        kind: 'video',
        mime: mediaMimeForUrl(url, 'video'),
        ...(duration == null ? {} : { duration }),
        ...(size == null ? {} : { size }),
        representation: { ...metadata, sourceIndex },
      });
    }
  }
}

/** Parse and sanitize one Bilibili playurl-style response. */
export function parseBilibiliMediaManifest(
  value: unknown,
  expected: BilibiliManifestIdentity,
): ParsedBilibiliManifest | undefined {
  const envelope = asRecord(value);
  if (!envelope) return undefined;
  const payload = firstRecord(envelope.data, envelope.result, envelope) ?? envelope;
  const videoInfo = firstRecord(payload.video_info, payload.videoInfo);
  const explicitBvid =
    normalizeBilibiliBvid(envelope.bvid) ??
    normalizeBilibiliBvid(payload.bvid) ??
    normalizeBilibiliBvid(videoInfo?.bvid);
  if (explicitBvid && explicitBvid !== expected.bvid) return undefined;
  const explicitCid =
    normalizeBilibiliNumericId(envelope.cid) ??
    normalizeBilibiliNumericId(payload.cid) ??
    normalizeBilibiliNumericId(videoInfo?.cid);
  if (expected.cid && explicitCid && expected.cid !== explicitCid) return undefined;
  const cid = expected.cid ?? explicitCid;

  const durationMs = positiveNumber(
    payload.timelength ?? videoInfo?.timelength ?? envelope.timelength,
  );
  const dash = firstRecord(payload.dash, videoInfo?.dash);
  const supportFormats = supportFormatMap(payload);
  const duration =
    durationMs != null ? durationMs / 1_000 : (positiveNumber(dash?.duration) ?? undefined);
  const candidates: BilibiliMediaCandidate[] = [];
  const seen = new Set<string>();
  if (dash) {
    for (const representation of asArray(dash.video)) {
      const record = asRecord(representation);
      const qn = positiveInteger(record?.quality ?? record?.id);
      appendRepresentation(
        candidates,
        seen,
        representation,
        'video',
        duration,
        qn == null ? undefined : supportFormats.get(qn),
      );
    }
    for (const representation of asArray(dash.audio)) {
      appendRepresentation(candidates, seen, representation, 'audio', duration, undefined, 'AAC');
    }
    const dolby = asRecord(dash.dolby);
    for (const representation of asList(dolby?.audio)) {
      appendRepresentation(candidates, seen, representation, 'audio', duration, undefined, 'Dolby');
    }
    const flac = asRecord(dash.flac);
    for (const representation of asList(flac?.audio)) {
      appendRepresentation(candidates, seen, representation, 'audio', duration, undefined, 'FLAC');
    }
  }
  appendDurl(candidates, seen, payload.durl, duration);
  const identity = { bvid: expected.bvid, ...(cid ? { cid } : {}) };
  const deliveredKeys = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'video')
      .map((candidate) => candidate.representation?.key)
      .filter((key): key is string => Boolean(key)),
  );
  const deliveredQns = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'video')
      .map((candidate) => candidate.representation?.qn)
      .filter((qn): qn is number => qn != null),
  );
  const advertisedFormats = [...supportFormats.entries()].map(
    ([qn, support]): BilibiliAdvertisedFormatDiagnostic => {
      const description =
        shortString(support.new_description ?? support.newDescription) ??
        shortString(support.description) ??
        shortString(support.display_desc ?? support.displayDescription);
      const dynamic = classifyBilibiliDynamicRange({
        qn,
        ...(description ? { description } : {}),
      });
      return {
        qn,
        ...(description ? { description } : {}),
        dynamicRange: dynamic.dynamicRange,
        dynamicRangeEvidence: dynamic.evidence,
        capabilities: {
          advertised: true,
          delivered: deliveredQns.has(qn),
          decodable: 'unknown',
          remuxable:
            dynamic.evidence.some((item) => item.source === 'conflict') ||
            (dynamic.dynamicRange === 'Dolby Vision' && !deliveredQns.has(qn))
              ? 'unsupported'
              : 'unknown',
        },
      };
    },
  );
  return {
    identity,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.representation
        ? { representation: { ...candidate.representation, ...identity } }
        : {}),
    })),
    diagnostics: {
      advertisedFormats,
      deliveredRepresentationKeys: [...deliveredKeys],
    },
  };
}

function readUint32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function boxType(bytes: Uint8Array, offset: number): string | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

/**
 * Determine an ISO-BMFF track from its initialization bytes. This walks actual
 * box boundaries and reads the hdlr handler_type field; it never guesses from
 * Bilibili's numeric representation id or scans arbitrary media payload bytes.
 */
export function sniffIsoBmffTrackKind(
  input: ArrayBuffer | ArrayBufferView,
): BilibiliTrackKind | 'muxed' | undefined {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const handlers = new Set<BilibiliTrackKind>();
  const containers = new Set(['moov', 'trak', 'mdia']);

  const visit = (start: number, limit: number, depth: number): void => {
    if (depth > 8 || start < 0 || limit > bytes.byteLength) return;
    let offset = start;
    while (offset + 8 <= limit) {
      const size32 = readUint32(bytes, offset);
      const type = boxType(bytes, offset + 4);
      if (size32 == null || !type) return;
      let headerSize = 8;
      let size = size32;
      if (size32 === 1) {
        if (offset + 16 > limit) return;
        const high = readUint32(bytes, offset + 8);
        const low = readUint32(bytes, offset + 12);
        if (high == null || low == null || high > 0x1fffff) return;
        size = high * 0x100000000 + low;
        headerSize = 16;
      } else if (size32 === 0) {
        size = limit - offset;
      }
      if (size < headerSize || offset + size > limit) return;
      const payloadStart = offset + headerSize;
      if (type === 'hdlr' && payloadStart + 12 <= offset + size) {
        const handler = boxType(bytes, payloadStart + 8);
        if (handler === 'vide') handlers.add('video');
        else if (handler === 'soun') handlers.add('audio');
      } else if (containers.has(type)) {
        visit(payloadStart, offset + size, depth + 1);
      }
      offset += size;
    }
  };

  visit(0, bytes.byteLength, 0);
  if (handlers.size === 2) return 'muxed';
  return handlers.values().next().value as BilibiliTrackKind | undefined;
}
