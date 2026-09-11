import type { BilibiliDynamicRange, BilibiliDynamicRangeEvidence } from '../../shared/types';

export interface BilibiliDynamicRangeClassification {
  dynamicRange: BilibiliDynamicRange;
  evidence: BilibiliDynamicRangeEvidence[];
  codecProfile?: string;
  dolbyVisionProfile?: number;
}

export interface BilibiliDynamicRangeInput {
  explicit?: string;
  qn?: number;
  codecs?: string;
  description?: string;
  initialization?: BilibiliIsoBmffDynamicRange;
}

export interface BilibiliIsoBmffDynamicRange {
  dynamicRange: 'HDR' | 'Dolby Vision';
  evidence: BilibiliDynamicRangeEvidence;
  dolbyVisionProfile?: number;
}

function boundedDetail(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= 128 ? normalized : normalized?.slice(0, 128);
}

function rangeFromText(value: string | undefined): BilibiliDynamicRange | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/dolby[\s_-]*vision|\bdovi\b|杜比视界/u.test(normalized)) return 'Dolby Vision';
  if (/(?:^|\W)hdr(?:10(?:\+)?|vivid)?(?:\W|$)|(?:^|\W)(?:pq|hlg)(?:\W|$)|真彩/u.test(normalized)) {
    return 'HDR';
  }
  if (/(?:^|\W)sdr(?:\W|$)/u.test(normalized)) return 'SDR';
  if (/unknown|未知/u.test(normalized)) return 'unknown';
  return undefined;
}

export function primaryBilibiliCodecProfile(codecs?: string): string | undefined {
  const primary = codecs
    ?.split(',')
    .map((codec) => codec.trim())
    .find(Boolean);
  return boundedDetail(primary);
}

export function dolbyVisionProfileFromCodec(codecs?: string): number | undefined {
  for (const codec of codecs?.split(',') ?? []) {
    const match = /^(?:dvh1|dvhe)\.(\d{1,2})(?:\.|$)/iu.exec(codec.trim());
    if (!match?.[1]) continue;
    const profile = Number(match[1]);
    if (Number.isInteger(profile) && profile >= 0 && profile <= 127) return profile;
  }
  return undefined;
}

function codecDynamicRange(codecs?: string): BilibiliDynamicRange | undefined {
  return (codecs?.split(',') ?? []).some((codec) => /^(?:dvh1|dvhe)(?:\.|$)/iu.test(codec.trim()))
    ? 'Dolby Vision'
    : undefined;
}

function evidence(
  source: BilibiliDynamicRangeEvidence['source'],
  range: BilibiliDynamicRange | undefined,
  detail?: string,
): BilibiliDynamicRangeEvidence | undefined {
  const normalizedDetail = boundedDetail(detail);
  return range
    ? { source, range, ...(normalizedDetail ? { detail: normalizedDetail } : {}) }
    : undefined;
}

/**
 * Classify a delivered representation from independent evidence in descending
 * trust order. Contradictory evidence is never silently resolved to a premium
 * format: it becomes `unknown`, so product and remux policy can fail closed.
 */
export function classifyBilibiliDynamicRange(
  input: BilibiliDynamicRangeInput,
): BilibiliDynamicRangeClassification {
  const codecProfile = primaryBilibiliCodecProfile(input.codecs);
  const codecRange = codecDynamicRange(input.codecs);
  const collected = [
    evidence('explicit-field', rangeFromText(input.explicit), input.explicit),
    evidence(
      'quality-number',
      input.qn === 126 ? 'Dolby Vision' : input.qn === 125 ? 'HDR' : undefined,
      input.qn == null ? undefined : `qn=${input.qn}`,
    ),
    evidence('codec', codecRange, codecProfile),
    input.initialization?.evidence,
    evidence('official-description', rangeFromText(input.description), input.description),
  ].filter((item): item is BilibiliDynamicRangeEvidence => item != null);

  const decisiveRanges = new Set(
    collected.map((item) => item.range).filter((range) => range !== 'unknown'),
  );
  if (decisiveRanges.size > 1) {
    const dolbyVisionProfile =
      dolbyVisionProfileFromCodec(input.codecs) ?? input.initialization?.dolbyVisionProfile;
    return {
      dynamicRange: 'unknown',
      evidence: [
        ...collected,
        {
          source: 'conflict',
          range: 'unknown',
          detail: [...decisiveRanges].join(' / '),
        },
      ],
      ...(codecProfile ? { codecProfile } : {}),
      ...(dolbyVisionProfile == null ? {} : { dolbyVisionProfile }),
    };
  }

  const dynamicRange =
    collected.find((item) => item.range !== 'unknown')?.range ??
    (collected.some((item) => item.range === 'unknown') ? 'unknown' : 'SDR');
  const finalEvidence =
    collected.length > 0
      ? collected
      : ([{ source: 'default-sdr', range: 'SDR' }] satisfies BilibiliDynamicRangeEvidence[]);
  const dolbyVisionProfile =
    dolbyVisionProfileFromCodec(input.codecs) ?? input.initialization?.dolbyVisionProfile;
  return {
    dynamicRange,
    evidence: finalEvidence,
    ...(codecProfile ? { codecProfile } : {}),
    ...(dolbyVisionProfile == null ? {} : { dolbyVisionProfile }),
  };
}

function readUint16(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 2 <= bytes.byteLength
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset)
    : undefined;
}

function readUint32(bytes: Uint8Array, offset: number): number | undefined {
  return offset >= 0 && offset + 4 <= bytes.byteLength
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
    : undefined;
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

interface LocatedBox {
  type: string;
  payloadOffset: number;
  end: number;
}

/** Locate only structurally bounded box headers; arbitrary payload text is ignored. */
function locateBoxes(bytes: Uint8Array, expected: readonly string[]): LocatedBox[] {
  const located: LocatedBox[] = [];
  for (let typeOffset = 4; typeOffset + 4 <= bytes.byteLength; typeOffset += 1) {
    const type = expected.find((candidate) => asciiAt(bytes, typeOffset, candidate));
    if (!type) continue;
    const size = readUint32(bytes, typeOffset - 4);
    if (size == null || size < 8) continue;
    const end = typeOffset - 4 + size;
    if (end > bytes.byteLength) continue;
    located.push({ type, payloadOffset: typeOffset + 4, end });
  }
  return located;
}

/**
 * Inspect an ISO-BMFF initialization segment for Dolby Vision configuration or
 * BT.2020 + PQ/HLG `colr` metadata. This is diagnostic evidence only; it never
 * manufactures a representation URL or claims the output muxer preserves it.
 */
export function sniffBilibiliIsoBmffDynamicRange(
  input: ArrayBuffer | ArrayBufferView,
): BilibiliIsoBmffDynamicRange | undefined {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const dolbyBox = locateBoxes(bytes, ['dvcC', 'dvvC', 'dvwC'])[0];
  if (dolbyBox) {
    const packedProfile =
      dolbyBox.payloadOffset + 2 < dolbyBox.end ? bytes[dolbyBox.payloadOffset + 2] : undefined;
    const dolbyVisionProfile = packedProfile == null ? undefined : (packedProfile >> 1) & 0x7f;
    return {
      dynamicRange: 'Dolby Vision',
      evidence: {
        source: 'initialization-segment',
        range: 'Dolby Vision',
        detail: dolbyBox.type,
      },
      ...(dolbyVisionProfile == null ? {} : { dolbyVisionProfile }),
    };
  }

  for (const box of locateBoxes(bytes, ['colr'])) {
    if (!asciiAt(bytes, box.payloadOffset, 'nclx') && !asciiAt(bytes, box.payloadOffset, 'nclc')) {
      continue;
    }
    const colourPrimaries = readUint16(bytes, box.payloadOffset + 4);
    const transferCharacteristics = readUint16(bytes, box.payloadOffset + 6);
    if (
      colourPrimaries === 9 &&
      (transferCharacteristics === 16 || transferCharacteristics === 18)
    ) {
      return {
        dynamicRange: 'HDR',
        evidence: {
          source: 'initialization-segment',
          range: 'HDR',
          detail: `colr:bt2020:${transferCharacteristics === 16 ? 'pq' : 'hlg'}`,
        },
      };
    }
  }
  return undefined;
}
