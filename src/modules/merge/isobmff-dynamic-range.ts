import type { MergeFailureReason, MergePacketTimelineDiagnostic } from './types';
import { inspectHevcParameterSets, type HevcColourDescription } from './hevc-configuration';
import { activeSampleDescriptions } from './sample-description';
export type DolbyVisionHevcSampleEntry = 'dvh1' | 'dvhe' | 'hvc1' | 'hev1';
export type IsoBmffDynamicRange = 'SDR' | 'HDR' | 'Dolby Vision' | 'unknown';

export interface IsoBmffBoxEvidence {
  type: 'hvcC' | 'colr' | 'mdcv' | 'clli' | 'dvcC' | 'dvvC' | 'dvwC';
  payloadSize: number;
  payloadSha256: string;
}

export interface IsoBmffSampleEntryEvidence {
  type: string;
  size: number;
  sha256: string;
}

export interface IsoBmffFileTypeEvidence {
  majorBrand: string;
  compatibleBrands: string[];
  /** Source-declared Dolby Vision brands (for example dby1/dv58). */
  dolbyVisionBrands: string[];
}

export interface IsoBmffHevcConfigurationEvidence extends IsoBmffBoxEvidence {
  type: 'hvcC';
  profileSpace: number;
  tierFlag: boolean;
  profileIdc: number;
  profileCompatibilityFlags: number;
  constraintIndicatorFlags: string;
  levelIdc: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  nalLengthSize: number;
  parameterSetsComplete?: boolean;
  parameterSetsConflict?: boolean;
  spsColour?: HevcColourDescription;
}

export interface IsoBmffColourEvidence extends IsoBmffBoxEvidence {
  type: 'colr';
  colourType: string;
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  fullRange?: boolean;
}

export interface IsoBmffDolbyVisionEvidence extends IsoBmffBoxEvidence {
  type: 'dvcC' | 'dvvC' | 'dvwC';
  profile?: number;
  level?: number;
  rpuPresent?: boolean;
  enhancementLayerPresent?: boolean;
  baseLayerPresent?: boolean;
  baseLayerSignalCompatibilityId?: number;
}

/**
 * Evidence read from the video sample entry in an ISO-BMFF file. Merely finding
 * the four-character text in an arbitrary payload is deliberately insufficient.
 */
export interface IsoBmffDynamicRangeEvidence {
  container: 'iso-bmff';
  fileType?: IsoBmffFileTypeEvidence;
  sampleEntryType?: string;
  sampleEntry?: IsoBmffSampleEntryEvidence;
  classification: IsoBmffDynamicRange;
  transfer: 'PQ' | 'HLG' | 'other' | 'unknown';
  hvcC?: IsoBmffHevcConfigurationEvidence;
  colr?: IsoBmffColourEvidence;
  mdcv?: IsoBmffBoxEvidence;
  clli?: IsoBmffBoxEvidence;
  dolbyVision?: IsoBmffDolbyVisionEvidence;
  effectiveColour?: Partial<HevcColourDescription> & {
    source: 'colr' | 'sps-vui' | 'colr+sps-vui';
  };
  colourConflict?: boolean;
  ambiguous: boolean;
}

export interface VideoPacketEquivalenceEvidence {
  timeline?: MergePacketTimelineDiagnostic;
  mismatch?: 'track' | 'count' | 'payload' | 'timeline';
  equivalent: boolean;
  sourcePacketCount: number;
  outputPacketCount: number;
  sourceBytes: number;
  outputBytes: number;
}

export type DynamicRangePreservationResult =
  | {
      preserved: true;
      range: 'HDR';
      transfer: 'PQ' | 'HLG';
      bitDepth: number;
    }
  | {
      preserved: true;
      range: 'Dolby Vision';
      profile: 5 | 8;
      level: number;
      sampleEntryType: DolbyVisionHevcSampleEntry;
    }
  | {
      preserved: false;
      range: 'HDR' | 'Dolby Vision' | 'unknown';
      reason: string;
    };

interface RandomAccessReader {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

interface IsoBoxHeader {
  type: string;
  start: number;
  end: number;
  payloadStart: number;
}

interface CollectedBox {
  type: IsoBmffBoxEvidence['type'];
  payload: Uint8Array;
  sampleEntryType: string;
}

interface CollectedSampleEntry {
  type: string;
  bytes: Uint8Array;
}

const SIMPLE_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const VIDEO_SAMPLE_ENTRIES = new Set(['avc1', 'avc3', 'hev1', 'hvc1', 'dvhe', 'dvh1']);
const EVIDENCE_BOXES = new Set<IsoBmffBoxEvidence['type']>([
  'hvcC',
  'colr',
  'mdcv',
  'clli',
  'dvcC',
  'dvvC',
  'dvwC',
]);
const MAX_BOX_COUNT = 10_000;
const MAX_DEPTH = 12;
const MAX_EVIDENCE_PAYLOAD_BYTES = 1 * 1024 * 1024;
const MAX_SAMPLE_ENTRY_BYTES = 2 * 1024 * 1024;

function inputReader(input: Blob | ArrayBuffer | ArrayBufferView): RandomAccessReader {
  if (input instanceof Blob) {
    return {
      size: input.size,
      async read(start, end) {
        return new Uint8Array(await input.slice(start, end).arrayBuffer());
      },
    };
  }
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return {
    size: bytes.byteLength,
    async read(start, end) {
      return bytes.slice(start, end);
    },
  };
}

function uint16(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function uint32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let index = 0; index < length && offset + index < bytes.byteLength; index += 1) {
    result += String.fromCharCode(bytes[offset + index]!);
  }
  return result;
}

function validBoxType(type: string): boolean {
  return (
    type.length === 4 &&
    [...type].every((character) => {
      const value = character.charCodeAt(0);
      return value >= 0x20 && value <= 0x7e;
    })
  );
}

async function readBoxHeader(
  reader: RandomAccessReader,
  offset: number,
  parentEnd: number,
): Promise<IsoBoxHeader | null> {
  if (offset < 0 || offset + 8 > parentEnd) return null;
  const header = await reader.read(offset, Math.min(parentEnd, offset + 16));
  if (header.byteLength < 8) return null;
  const size32 = uint32(header, 0);
  const type = ascii(header, 4, 4);
  if (size32 == null || !validBoxType(type)) return null;
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (header.byteLength < 16) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const extended = view.getBigUint64(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || offset + size > parentEnd || offset + size > reader.size) return null;
  return { type, start: offset, end: offset + size, payloadStart: offset + headerSize };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function collectStructuredBoxes(reader: RandomAccessReader): Promise<{
  boxes: CollectedBox[];
  sampleEntryTypes: Set<string>;
  sampleEntries: CollectedSampleEntry[];
  fileTypes: Uint8Array[];
  ambiguous: boolean;
}> {
  const boxes: CollectedBox[] = [];
  const sampleEntryTypes = new Set<string>();
  const sampleEntries: CollectedSampleEntry[] = [];
  const fileTypes: Uint8Array[] = [];
  let visited = 0;
  let ambiguous = false;
  let videoTables = 0;
  let fragmented = false;
  let multipleDescriptions = false;

  const walk = async (
    start: number,
    end: number,
    depth: number,
    sampleEntryType?: string,
    stsc?: Uint8Array,
  ): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error('ISO-BMFF box nesting exceeds the safety limit.');
    let offset = start;
    while (offset + 8 <= end) {
      if ((visited += 1) > MAX_BOX_COUNT) {
        throw new Error('ISO-BMFF box count exceeds the safety limit.');
      }
      const box = await readBoxHeader(reader, offset, end);
      if (!box) break;
      if (depth === 0 && box.type === 'moof') fragmented = true;

      if (sampleEntryType && EVIDENCE_BOXES.has(box.type as IsoBmffBoxEvidence['type'])) {
        const payloadSize = box.end - box.payloadStart;
        if (payloadSize > MAX_EVIDENCE_PAYLOAD_BYTES) {
          throw new Error(`${box.type} payload exceeds the safety limit.`);
        }
        boxes.push({
          type: box.type as IsoBmffBoxEvidence['type'],
          payload: await reader.read(box.payloadStart, box.end),
          sampleEntryType,
        });
      }

      if (depth === 0 && box.type === 'ftyp') {
        const payloadSize = box.end - box.payloadStart;
        if (payloadSize > MAX_EVIDENCE_PAYLOAD_BYTES) {
          throw new Error('ftyp payload exceeds the safety limit.');
        }
        fileTypes.push(await reader.read(box.payloadStart, box.end));
      }

      if (box.type === 'stbl') {
        let childOffset = box.payloadStart;
        let table: Uint8Array | undefined;
        while (childOffset < box.end) {
          if (++visited > MAX_BOX_COUNT)
            throw new Error('ISO-BMFF box count exceeds the safety limit.');
          const child = await readBoxHeader(reader, childOffset, box.end);
          if (!child) throw new Error('Malformed sample table.');
          if (child.type === 'stsc') {
            if (table || child.end - child.payloadStart > MAX_EVIDENCE_PAYLOAD_BYTES)
              throw new Error('Ambiguous or oversized stsc table.');
            table = await reader.read(child.payloadStart, child.end);
          }
          childOffset = child.end;
        }
        await walk(box.payloadStart, box.end, depth + 1, sampleEntryType, table);
      } else if (SIMPLE_CONTAINERS.has(box.type)) {
        await walk(box.payloadStart, box.end, depth + 1, sampleEntryType);
      } else if (box.type === 'stsd') {
        const header = await reader.read(box.payloadStart, Math.min(box.end, box.payloadStart + 8));
        const count = uint32(header, 4) ?? 0;
        const selected = activeSampleDescriptions(count, stsc);
        let entryOffset = box.payloadStart + 8;
        let hasVideo = false;
        for (let index = 1; index <= count; index += 1) {
          const entry = await readBoxHeader(reader, entryOffset, box.end);
          if (!entry) throw new Error('Malformed stsd description.');
          hasVideo ||= VIDEO_SAMPLE_ENTRIES.has(entry.type);
          if (selected.has(index)) await walk(entry.start, entry.end, depth + 1);
          entryOffset = entry.end;
        }
        if (entryOffset !== box.end)
          throw new Error('stsd description count does not match its payload.');
        if (hasVideo) {
          videoTables += 1;
          multipleDescriptions ||= count > 1;
          ambiguous ||= selected.size !== 1 || videoTables > 1;
        }
      } else if (VIDEO_SAMPLE_ENTRIES.has(box.type)) {
        sampleEntryTypes.add(box.type);
        const sampleEntrySize = box.end - box.start;
        if (sampleEntrySize > MAX_SAMPLE_ENTRY_BYTES) {
          throw new Error('ISO-BMFF video sample entry exceeds the safety limit.');
        }
        sampleEntries.push({
          type: box.type,
          bytes: await reader.read(box.start, box.end),
        });
        // VisualSampleEntry has a 78-byte fixed payload before its child boxes.
        await walk(Math.min(box.end, box.payloadStart + 78), box.end, depth + 1, box.type);
      }
      offset = box.end;
    }
  };

  await walk(0, reader.size, 0);
  // tfhd/trex can override stsc. Until all fragment references are modelled,
  // never use a progressive stsc selection as proof for multi-description fMP4.
  return {
    boxes,
    sampleEntryTypes,
    sampleEntries,
    fileTypes,
    ambiguous: ambiguous || (fragmented && multipleDescriptions),
  };
}

function isDolbyVisionBrand(brand: string): boolean {
  return brand === 'dby1' || (brand.length === 4 && brand.startsWith('dv'));
}

function fileTypeEvidence(payload: Uint8Array): IsoBmffFileTypeEvidence {
  if (payload.byteLength < 8 || (payload.byteLength - 8) % 4 !== 0) {
    throw new Error('ftyp payload is truncated or malformed.');
  }
  const majorBrand = ascii(payload, 0, 4);
  const compatibleBrands: string[] = [];
  for (let offset = 8; offset < payload.byteLength; offset += 4) {
    compatibleBrands.push(ascii(payload, offset, 4));
  }
  return {
    majorBrand,
    compatibleBrands,
    dolbyVisionBrands: [majorBrand, ...compatibleBrands]
      .filter(isDolbyVisionBrand)
      .filter((brand, index, all) => all.indexOf(brand) === index),
  };
}

async function baseEvidence(box: CollectedBox): Promise<IsoBmffBoxEvidence> {
  return {
    type: box.type,
    payloadSize: box.payload.byteLength,
    payloadSha256: await sha256(box.payload),
  };
}

async function hevcEvidence(box: CollectedBox): Promise<IsoBmffHevcConfigurationEvidence> {
  if (box.payload.byteLength < 23 || box.payload[0] !== 1) {
    throw new Error('hvcC decoder configuration is truncated or unsupported.');
  }
  const profileByte = box.payload[1]!;
  const constraint = box.payload.slice(6, 12);
  const parameters = inspectHevcParameterSets(box.payload);
  return {
    ...(await baseEvidence(box)),
    type: 'hvcC',
    profileSpace: (profileByte >> 6) & 0x03,
    tierFlag: Boolean(profileByte & 0x20),
    profileIdc: profileByte & 0x1f,
    profileCompatibilityFlags: uint32(box.payload, 2) ?? 0,
    constraintIndicatorFlags: [...constraint]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(''),
    levelIdc: box.payload[12]!,
    chromaFormatIdc: box.payload[16]! & 0x03,
    bitDepthLuma: 8 + (box.payload[17]! & 0x07),
    bitDepthChroma: 8 + (box.payload[18]! & 0x07),
    nalLengthSize: 1 + (box.payload[21]! & 0x03),
    parameterSetsComplete: parameters.complete,
    parameterSetsConflict: parameters.conflict,
    ...(parameters.sps?.colour ? { spsColour: parameters.sps.colour } : {}),
  };
}

async function colourEvidence(box: CollectedBox): Promise<IsoBmffColourEvidence> {
  const colourType = ascii(box.payload, 0, 4);
  const common = { ...(await baseEvidence(box)), type: 'colr' as const, colourType };
  if (colourType !== 'nclx' && colourType !== 'nclc') return common;
  const colourPrimaries = uint16(box.payload, 4);
  const transferCharacteristics = uint16(box.payload, 6);
  const matrixCoefficients = uint16(box.payload, 8);
  return {
    ...common,
    ...(colourPrimaries == null ? {} : { colourPrimaries }),
    ...(transferCharacteristics == null ? {} : { transferCharacteristics }),
    ...(matrixCoefficients == null ? {} : { matrixCoefficients }),
    ...(colourType === 'nclx' && box.payload.byteLength > 10
      ? { fullRange: Boolean(box.payload[10]! & 0x80) }
      : {}),
  };
}

async function dolbyVisionEvidence(box: CollectedBox): Promise<IsoBmffDolbyVisionEvidence> {
  const packedProfile = box.payload.byteLength > 2 ? box.payload[2] : undefined;
  const packedLevel = box.payload.byteLength > 3 ? box.payload[3] : undefined;
  return {
    ...(await baseEvidence(box)),
    type: box.type as 'dvcC' | 'dvvC' | 'dvwC',
    ...(packedProfile == null ? {} : { profile: (packedProfile >> 1) & 0x7f }),
    ...(packedLevel == null
      ? {}
      : { level: ((packedProfile! & 0x01) << 5) | ((packedLevel >> 3) & 0x1f) }),
    ...(packedLevel == null
      ? {}
      : {
          rpuPresent: Boolean(packedLevel & 0x04),
          enhancementLayerPresent: Boolean(packedLevel & 0x02),
          baseLayerPresent: Boolean(packedLevel & 0x01),
        }),
    ...(box.payload.byteLength > 4
      ? { baseLayerSignalCompatibilityId: (box.payload[4]! >> 4) & 0x0f }
      : {}),
  };
}

async function sampleEntryEvidence(
  entry: CollectedSampleEntry,
): Promise<IsoBmffSampleEntryEvidence> {
  return {
    type: entry.type,
    size: entry.bytes.byteLength,
    sha256: await sha256(entry.bytes),
  };
}

function uniqueOrAmbiguous<T>(
  items: T[],
  signature: (item: T) => string,
): {
  item?: T;
  ambiguous: boolean;
} {
  if (items.length === 0) return { ambiguous: false };
  const hashes = new Set(items.map(signature));
  const item = items[0];
  return item ? { item, ambiguous: hashes.size > 1 } : { ambiguous: false };
}

function resolveColourEvidence(
  colr: IsoBmffColourEvidence | undefined,
  hevc: IsoBmffHevcConfigurationEvidence | undefined,
): { colour?: IsoBmffDynamicRangeEvidence['effectiveColour']; conflict: boolean } {
  const vui = hevc?.spsColour;
  const keys = ['colourPrimaries', 'transferCharacteristics', 'matrixCoefficients'] as const;
  const explicit = (value: number | undefined) => value != null && value !== 2;
  if (!colr) return { ...(vui ? { colour: { ...vui, source: 'sps-vui' } } : {}), conflict: false };
  if (colr.colourType !== 'nclx' && colr.colourType !== 'nclc') return { conflict: !!vui }; // ICC/unknown colour spaces cannot be equated to CICP by guessing.
  if (
    keys.some((key) => colr[key] == null) ||
    (colr.colourType === 'nclx' && colr.fullRange == null)
  )
    return { conflict: true };
  const conflict =
    !!vui &&
    (keys.some((key) => explicit(colr[key]) && explicit(vui[key]) && colr[key] !== vui[key]) ||
      (colr.fullRange != null && colr.fullRange !== vui.fullRange));
  const colour: NonNullable<IsoBmffDynamicRangeEvidence['effectiveColour']> = {
    source: vui ? 'colr+sps-vui' : 'colr',
    ...(colr.fullRange != null
      ? { fullRange: colr.fullRange }
      : vui
        ? { fullRange: vui.fullRange }
        : {}),
  };
  for (const key of keys) {
    const value = explicit(colr[key]) ? colr[key] : (vui?.[key] ?? colr[key]);
    if (value != null) colour[key] = value;
  }
  return { colour, conflict };
}

/**
 * Reads only box headers and the small metadata boxes from a Blob, skipping
 * large `mdat` payloads by offset. This keeps verification memory bounded even
 * when the output `moov` box is located at the end of a large file.
 */
export async function extractIsoBmffDynamicRangeEvidence(
  input: Blob | ArrayBuffer | ArrayBufferView,
): Promise<IsoBmffDynamicRangeEvidence> {
  const collected = await collectStructuredBoxes(inputReader(input));
  const { boxes, sampleEntryTypes, sampleEntries, fileTypes } = collected;
  const hvcCItems = await Promise.all(
    boxes.filter((box) => box.type === 'hvcC').map((box) => hevcEvidence(box)),
  );
  const colrItems = await Promise.all(
    boxes.filter((box) => box.type === 'colr').map((box) => colourEvidence(box)),
  );
  const mdcvItems = await Promise.all(
    boxes
      .filter((box) => box.type === 'mdcv')
      .map(async (box) => ({ ...(await baseEvidence(box)), type: 'mdcv' as const })),
  );
  const clliItems = await Promise.all(
    boxes
      .filter((box) => box.type === 'clli')
      .map(async (box) => ({ ...(await baseEvidence(box)), type: 'clli' as const })),
  );
  const dolbyItems = await Promise.all(
    boxes
      .filter((box) => box.type === 'dvcC' || box.type === 'dvvC' || box.type === 'dvwC')
      .map((box) => dolbyVisionEvidence(box)),
  );
  const sampleEntryItems = await Promise.all(
    sampleEntries.map((entry) => sampleEntryEvidence(entry)),
  );
  const fileType = uniqueOrAmbiguous(
    fileTypes.map((payload) => fileTypeEvidence(payload)),
    (item) => `${item.majorBrand}:${item.compatibleBrands.join(',')}`,
  );
  const boxSignature = (item: IsoBmffBoxEvidence) => `${item.type}:${item.payloadSha256}`;
  const hvcC = uniqueOrAmbiguous(hvcCItems, boxSignature);
  const colr = uniqueOrAmbiguous(colrItems, boxSignature);
  const mdcv = uniqueOrAmbiguous(mdcvItems, boxSignature);
  const clli = uniqueOrAmbiguous(clliItems, boxSignature);
  const dolbyVision = uniqueOrAmbiguous(dolbyItems, boxSignature);
  const sampleEntry = uniqueOrAmbiguous(sampleEntryItems, (item) => `${item.type}:${item.sha256}`);
  const effectiveColour = resolveColourEvidence(colr.item, hvcC.item);
  const transfer =
    effectiveColour.colour?.transferCharacteristics === 16
      ? 'PQ'
      : effectiveColour.colour?.transferCharacteristics === 18
        ? 'HLG'
        : effectiveColour.colour?.transferCharacteristics == null
          ? 'unknown'
          : 'other';
  const hdrColour =
    effectiveColour.colour?.colourPrimaries === 9 && (transfer === 'PQ' || transfer === 'HLG');
  const classification: IsoBmffDynamicRange = dolbyVision.item
    ? 'Dolby Vision'
    : hdrColour || mdcv.item || clli.item
      ? 'HDR'
      : boxes.length > 0
        ? 'SDR'
        : 'unknown';

  return {
    container: 'iso-bmff',
    ...(fileType.item ? { fileType: fileType.item } : {}),
    ...(sampleEntryTypes.size === 1 ? { sampleEntryType: [...sampleEntryTypes][0] } : {}),
    ...(sampleEntry.item
      ? {
          sampleEntry: {
            type: sampleEntry.item.type,
            size: sampleEntry.item.size,
            sha256: sampleEntry.item.sha256,
          },
        }
      : {}),
    classification,
    transfer,
    ...(hvcC.item ? { hvcC: hvcC.item } : {}),
    ...(colr.item ? { colr: colr.item } : {}),
    ...(mdcv.item ? { mdcv: mdcv.item } : {}),
    ...(clli.item ? { clli: clli.item } : {}),
    ...(dolbyVision.item ? { dolbyVision: dolbyVision.item } : {}),
    ...(effectiveColour.colour ? { effectiveColour: effectiveColour.colour } : {}),
    ...(colr.item || hvcC.item?.spsColour ? { colourConflict: effectiveColour.conflict } : {}),
    ambiguous:
      collected.ambiguous ||
      effectiveColour.conflict ||
      hvcC.item?.parameterSetsConflict === true ||
      sampleEntryTypes.size > 1 ||
      fileType.ambiguous ||
      sampleEntry.ambiguous ||
      hvcC.ambiguous ||
      colr.ambiguous ||
      mdcv.ambiguous ||
      clli.ambiguous ||
      dolbyVision.ambiguous,
  };
}

export type SupportedDolbyVisionSource =
  | {
      supported: true;
      profile: 5 | 8;
      level: number;
      sampleEntryType: DolbyVisionHevcSampleEntry;
    }
  | { supported: false; reason: string; reasonCode: MergeFailureReason };

/**
 * Admits only the deliberately narrow browser-side Dolby Vision passthrough
 * subset. All other profiles, enhancement-layer layouts and incomplete sample
 * descriptions remain downloadable only as their untouched original track.
 */
export function assessDolbyVisionPassthroughSource(
  evidence: IsoBmffDynamicRangeEvidence,
): SupportedDolbyVisionSource {
  if (evidence.classification !== 'Dolby Vision') {
    return {
      supported: false,
      reasonCode: 'DV_CONFIG_MISSING',
      reason: '来源没有结构化 Dolby Vision 配置。',
    };
  }
  if (evidence.ambiguous) {
    return {
      supported: false,
      reasonCode: 'DV_STRUCTURE_AMBIGUOUS',
      reason: '来源包含多个相互冲突的视频样本项或配置。',
    };
  }
  if (
    evidence.sampleEntryType !== 'dvh1' &&
    evidence.sampleEntryType !== 'dvhe' &&
    evidence.sampleEntryType !== 'hvc1' &&
    evidence.sampleEntryType !== 'hev1'
  ) {
    return {
      supported: false,
      reasonCode: 'DV_SAMPLE_ENTRY_UNSUPPORTED',
      reason: '仅支持带完整 DV 配置的 dvh1/dvhe/hvc1/hev1 HEVC 样本项。',
    };
  }
  if (!evidence.sampleEntry || evidence.sampleEntry.type !== evidence.sampleEntryType) {
    return {
      supported: false,
      reasonCode: 'DV_SOURCE_INCOMPLETE',
      reason: '无法取得完整的 Dolby Vision 视频样本项。',
    };
  }
  if (!evidence.fileType) {
    return {
      supported: false,
      reasonCode: 'DV_SOURCE_INCOMPLETE',
      reason: '来源缺少可验证的 ftyp 文件类型。',
    };
  }
  if (!evidence.hvcC) {
    return {
      supported: false,
      reasonCode: 'HEVC_CONFIG_MISSING',
      reason: 'Dolby Vision 来源缺少 hvcC HEVC 配置。',
    };
  }
  if (evidence.hvcC.bitDepthLuma !== 10 || evidence.hvcC.bitDepthChroma !== 10) {
    return {
      supported: false,
      reasonCode: 'DV_BIT_DEPTH_UNSUPPORTED',
      reason: 'Dolby Vision 来源不是可验证的 10-bit HEVC。',
    };
  }
  if (!evidence.hvcC.parameterSetsComplete || evidence.hvcC.parameterSetsConflict) {
    return {
      supported: false,
      reasonCode: 'HEVC_CONFIG_MISSING',
      reason: 'Dolby Vision 来源缺少完整、无冲突的 VPS/SPS/PPS 参数集。',
    };
  }
  const dolby = evidence.dolbyVision;
  if (!dolby || (dolby.profile !== 5 && dolby.profile !== 8) || dolby.level == null) {
    return {
      supported: false,
      reasonCode: 'DV_PROFILE_UNSUPPORTED',
      reason: '仅支持可验证的 Dolby Vision Profile 5/8。',
    };
  }
  if (!dolby.rpuPresent || dolby.enhancementLayerPresent || !dolby.baseLayerPresent) {
    return {
      supported: false,
      reasonCode: 'DV_LAYERS_UNSUPPORTED',
      reason: '仅支持同时包含 RPU 与基础层、且不含增强层的单层 Dolby Vision。',
    };
  }
  return {
    supported: true,
    profile: dolby.profile,
    level: dolby.level,
    sampleEntryType: evidence.sampleEntryType,
  };
}

function sameBox(
  source: IsoBmffBoxEvidence | undefined,
  output: IsoBmffBoxEvidence | undefined,
): boolean {
  return (
    source != null &&
    output != null &&
    source.type === output.type &&
    source.payloadSize === output.payloadSize &&
    source.payloadSha256 === output.payloadSha256
  );
}

/** Fail-closed post-output policy for browser-side advanced dynamic range remux. */
export function verifyIsoBmffDynamicRangePreservation(
  range: 'HDR' | 'Dolby Vision' | 'unknown',
  source: IsoBmffDynamicRangeEvidence,
  output: IsoBmffDynamicRangeEvidence,
  packets: VideoPacketEquivalenceEvidence,
): DynamicRangePreservationResult {
  if (range === 'Dolby Vision') {
    const sourceSupport = assessDolbyVisionPassthroughSource(source);
    if (!sourceSupport.supported) return { preserved: false, range, reason: sourceSupport.reason };
    const outputSupport = assessDolbyVisionPassthroughSource(output);
    if (!outputSupport.supported) {
      return { preserved: false, range, reason: `输出不在受支持范围内：${outputSupport.reason}` };
    }
    if (!packets.equivalent || packets.sourcePacketCount !== packets.outputPacketCount) {
      return { preserved: false, range, reason: '输出视频 packet 与来源不完全等价。' };
    }
    if (
      !source.sampleEntry ||
      !output.sampleEntry ||
      source.sampleEntry.type !== output.sampleEntry.type ||
      source.sampleEntry.size !== output.sampleEntry.size ||
      source.sampleEntry.sha256 !== output.sampleEntry.sha256
    ) {
      return { preserved: false, range, reason: '输出 Dolby Vision 视频样本项未逐字节保留。' };
    }
    if (!sameBox(source.hvcC, output.hvcC)) {
      return { preserved: false, range, reason: '输出 hvcC 与来源不完全等价。' };
    }
    if (!sameBox(source.dolbyVision, output.dolbyVision)) {
      return { preserved: false, range, reason: '输出 dvcC/dvvC/dvwC 与来源不完全等价。' };
    }
    if (
      !source.fileType ||
      !output.fileType ||
      source.fileType.dolbyVisionBrands.some(
        (brand) =>
          output.fileType?.majorBrand !== brand &&
          !output.fileType?.compatibleBrands.includes(brand),
      )
    ) {
      return { preserved: false, range, reason: '输出 ftyp 未保留来源 Dolby Vision 兼容品牌。' };
    }
    if (source.colr && !sameBox(source.colr, output.colr)) {
      return { preserved: false, range, reason: '来源 colr 色彩配置未被完整保留。' };
    }
    if (source.mdcv && !sameBox(source.mdcv, output.mdcv)) {
      return {
        preserved: false,
        range,
        reason: '来源 mdcv mastering-display 元数据未被完整保留。',
      };
    }
    if (source.clli && !sameBox(source.clli, output.clli)) {
      return { preserved: false, range, reason: '来源 clli MaxCLL/MaxFALL 元数据未被完整保留。' };
    }
    return {
      preserved: true,
      range,
      profile: sourceSupport.profile,
      level: sourceSupport.level,
      sampleEntryType: sourceSupport.sampleEntryType,
    };
  }
  if (range !== 'HDR') {
    return {
      preserved: false,
      range,
      reason: '无法确认视频的色彩范围类型，不能生成保留原色彩范围的合并文件。',
    };
  }
  if (source.ambiguous || output.ambiguous) {
    return { preserved: false, range, reason: '检测到多个相互冲突的视频样本项或动态范围配置。' };
  }
  if (!packets.equivalent || packets.sourcePacketCount !== packets.outputPacketCount) {
    return { preserved: false, range, reason: '输出视频 packet 与来源不完全等价。' };
  }
  if (!source.hvcC || !output.hvcC || !sameBox(source.hvcC, output.hvcC)) {
    return { preserved: false, range, reason: '输出 hvcC 与来源不完全等价。' };
  }
  if (!source.hvcC.parameterSetsComplete || !output.hvcC.parameterSetsComplete) {
    return {
      preserved: false,
      range,
      reason: 'HDR 来源或输出缺少完整、可解析的 VPS/SPS/PPS 参数集。',
    };
  }
  if (
    source.hvcC.bitDepthLuma < 10 ||
    source.hvcC.bitDepthChroma < 10 ||
    output.hvcC.bitDepthLuma !== source.hvcC.bitDepthLuma ||
    output.hvcC.bitDepthChroma !== source.hvcC.bitDepthChroma
  ) {
    return { preserved: false, range, reason: 'HDR 视频位深不足或输出位深发生变化。' };
  }
  if (
    source.effectiveColour?.colourPrimaries !== 9 ||
    output.effectiveColour?.colourPrimaries !== 9 ||
    (source.transfer !== 'PQ' && source.transfer !== 'HLG') ||
    output.transfer !== source.transfer ||
    source.effectiveColour.matrixCoefficients !== output.effectiveColour.matrixCoefficients ||
    source.effectiveColour.fullRange !== output.effectiveColour.fullRange ||
    (source.colr != null && !sameBox(source.colr, output.colr))
  ) {
    return { preserved: false, range, reason: 'BT.2020 与 PQ/HLG 色彩配置未被完整保留。' };
  }
  if (source.mdcv && !sameBox(source.mdcv, output.mdcv)) {
    return { preserved: false, range, reason: '来源 mdcv mastering-display 元数据未被完整保留。' };
  }
  if (source.clli && !sameBox(source.clli, output.clli)) {
    return { preserved: false, range, reason: '来源 clli MaxCLL/MaxFALL 元数据未被完整保留。' };
  }
  return {
    preserved: true,
    range,
    transfer: source.transfer,
    bitDepth: Math.min(source.hvcC.bitDepthLuma, source.hvcC.bitDepthChroma),
  };
}
