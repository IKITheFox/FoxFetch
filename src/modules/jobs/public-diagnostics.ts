import type {
  MergeConfigurationDiagnostic,
  MergeVideoConfigurationDiagnostic,
  MergeNetworkDiagnostic,
  MergePacketTimelineDiagnostic,
  MergeSourceTimelineDiagnostic,
} from '../merge/types';

const SOURCE_TIMELINE_ISSUES = [
  'invalid-box',
  'metadata-limit',
  'unsupported-version',
  'invalid-timebase',
  'duplicate-metadata',
  'invalid-track',
  'malformed-edit-list',
  'edit-rate',
  'negative-media-time',
  'open-ended-offset',
  'multiple-edits',
  'empty-edit-list',
] as const;
const SOURCE_TIMELINE_BOXES = [
  'moov',
  'mvhd',
  'trak',
  'tkhd',
  'mdhd',
  'hdlr',
  'elst',
  'structure',
] as const;

/** Rebuild an intentionally small schema; the worker/storage object is never forwarded. */
export function publicSourceTimelineDiagnostic(
  value: unknown,
): MergeSourceTimelineDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.issue !== 'string' ||
    !(SOURCE_TIMELINE_ISSUES as readonly string[]).includes(data.issue) ||
    typeof data.box !== 'string' ||
    !(SOURCE_TIMELINE_BOXES as readonly string[]).includes(data.box)
  )
    return undefined;
  const result: MergeSourceTimelineDiagnostic = {
    issue: data.issue as MergeSourceTimelineDiagnostic['issue'],
    box: data.box as MergeSourceTimelineDiagnostic['box'],
  };
  if (data.sourceKind === 'video' || data.sourceKind === 'audio')
    result.sourceKind = data.sourceKind;
  if (data.version === 0 || data.version === 1) result.version = data.version;
  // Zero clocks remain useful evidence for invalid-timebase. u32 bounds match
  // the header format; v1 time values are retained only when exactly representable.
  const limits = {
    entryCount: [0, 1_000_000],
    entryIndex: [0, 1_000_000],
    movieTimescale: [0, 0xffff_ffff],
    mediaTimescale: [0, 0xffff_ffff],
    duration: [0, Number.MAX_SAFE_INTEGER],
    mediaTime: [-1, Number.MAX_SAFE_INTEGER],
    rate: [-0x8000_0000, 0x7fff_ffff],
  } as const;
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const number = data[key];
    const [minimum, maximum] = limits[key];
    if (
      typeof number === 'number' &&
      Number.isSafeInteger(number) &&
      number >= minimum &&
      number <= maximum
    )
      result[key] = number;
  }
  return result;
}

function publicVideoConfiguration(value: unknown): MergeVideoConfigurationDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const result: MergeVideoConfigurationDiagnostic = {};
  if (
    typeof data.sampleEntryType === 'string' &&
    ['dvh1', 'dvhe', 'hvc1', 'hev1', 'avc1', 'avc3'].includes(data.sampleEntryType)
  )
    result.sampleEntryType = data.sampleEntryType as NonNullable<
      MergeVideoConfigurationDiagnostic['sampleEntryType']
    >;
  if (
    data.colourSource === 'colr' ||
    data.colourSource === 'sps-vui' ||
    data.colourSource === 'colr+sps-vui'
  )
    result.colourSource = data.colourSource;
  for (const key of [
    'rpuPresent',
    'baseLayerPresent',
    'enhancementLayerPresent',
    'parameterSetsComplete',
    'parameterSetsConflict',
    'colourConflict',
    'fullRange',
  ] as const)
    if (typeof data[key] === 'boolean') result[key] = data[key];
  const ranges = {
    profile: [0, 127],
    level: [0, 63],
    bitDepthLuma: [8, 16],
    bitDepthChroma: [8, 16],
    chromaFormatIdc: [0, 3],
    colourPrimaries: [0, 255],
    transferCharacteristics: [0, 255],
    matrixCoefficients: [0, 255],
  } as const;
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const number = data[key];
    const [min, max] = ranges[key];
    if (typeof number === 'number' && Number.isInteger(number) && number >= min && number <= max)
      result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Rebuild both sides from a bounded schema; never spread stored/worker objects into the page. */
export function publicConfigurationDiagnostic(
  value: unknown,
): MergeConfigurationDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const source = publicVideoConfiguration(data.source);
  const output = publicVideoConfiguration(data.output);
  return source || output
    ? { ...(source ? { source } : {}), ...(output ? { output } : {}) }
    : undefined;
}

const TIME_FIELDS = [
  'sourceTimestampSeconds',
  'normalizedSourceTimestampSeconds',
  'outputTimestampSeconds',
  'sourceDurationSeconds',
  'outputDurationSeconds',
  'originSeconds',
  'sourceTimescale',
  'outputTimescale',
  'timestampDeltaSeconds',
  'durationDeltaSeconds',
  'timestampToleranceSeconds',
  'durationToleranceSeconds',
] as const;

/** Reconstruct at the page boundary, even when storage contains extra injected fields. */
export function publicTimelineDiagnostic(
  value: unknown,
): MergePacketTimelineDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (
    (data.track !== 'video' && data.track !== 'audio') ||
    typeof data.mismatch !== 'string' ||
    !['timestamp', 'duration', 'non-finite', 'timebase'].includes(data.mismatch) ||
    !Number.isSafeInteger(data.packetIndex) ||
    Number(data.packetIndex) < 0
  )
    return undefined;
  const result: MergePacketTimelineDiagnostic = {
    track: data.track,
    mismatch: data.mismatch as MergePacketTimelineDiagnostic['mismatch'],
    packetIndex: Number(data.packetIndex),
  };
  for (const key of TIME_FIELDS) {
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) result[key] = data[key];
  }
  return result;
}

export function publicNetworkDiagnostic(value: unknown): MergeNetworkDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.readMode !== 'range' && data.readMode !== 'sequential' && data.readMode !== 'local')
    return undefined;
  const result: MergeNetworkDiagnostic = { readMode: data.readMode };
  if (data.fallback === 'range-unavailable') result.fallback = data.fallback;
  if (
    Number.isInteger(data.responseStatus) &&
    Number(data.responseStatus) >= 100 &&
    Number(data.responseStatus) <= 599
  )
    result.responseStatus = Number(data.responseStatus);
  for (const key of ['requestStart', 'responseStart', 'responseEnd', 'totalBytes'] as const) {
    if (Number.isSafeInteger(data[key]) && Number(data[key]) >= 0) result[key] = Number(data[key]);
  }
  return result;
}
