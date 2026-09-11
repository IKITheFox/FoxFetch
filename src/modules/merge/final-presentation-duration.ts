import { mergeError } from './errors';
import { inspectIsoBmffTimeline } from './iso-bmff-timeline';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';

export interface ExpectedFinalPresentationDuration {
  /** Zero-based decode/sample-table index, independently obtained from the source. */
  sampleIndex: number;
  sampleCount: number;
  timescale: number;
  durationTicks: number;
  /** Source presentation timestamp after its edit mapping and the shared A/V origin. */
  timestampSeconds: number;
}

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 1_000_000;
const UINT32_MAX = 0xffffffff;
type Box = { type: string; start: number; end: number; children?: Box[] };
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

function invalid(): never {
  throw mergeError('TIMELINE_MISMATCH', '无法恢复视频结尾的播放时间信息，未生成可保存的文件。', {
    reason: 'PACKET_TIMELINE_MISMATCH',
    stage: 'verify-video',
  });
}

/**
 * Repair only the last presentation sample's native duration in the pinned
 * muxer's non-fragmented, trailing-moov output. This is not a fidelity bypass:
 * the caller must subsequently verify every packet against the original source.
 * All DTS changes are exactly counteracted in CTTS, so no PTS or media byte moves.
 */
export async function restoreFinalPresentationDuration(
  outputBlob: Blob,
  expected: ExpectedFinalPresentationDuration,
  signal?: AbortSignal,
): Promise<Blob> {
  if (
    !Number.isSafeInteger(expected.sampleCount) ||
    expected.sampleCount < 1 ||
    expected.sampleCount > MAX_SAMPLES ||
    !Number.isSafeInteger(expected.sampleIndex) ||
    expected.sampleIndex < 0 ||
    expected.sampleIndex >= expected.sampleCount ||
    !Number.isSafeInteger(expected.timescale) ||
    expected.timescale < 1 ||
    expected.timescale > UINT32_MAX ||
    !Number.isSafeInteger(expected.durationTicks) ||
    expected.durationTicks < 1 ||
    !Number.isFinite(expected.timestampSeconds) ||
    expected.timestampSeconds < 0
  )
    invalid();
  const read = async (start: number, end: number) => {
    checkMergeAborted(signal);
    return new Uint8Array(
      await withMergeDeadline(outputBlob.slice(start, end).arrayBuffer(), {
        ...(signal ? { signal } : {}),
        stage: 'verify-video',
      }),
    );
  };
  let moovStart = -1;
  let mdatCount = 0;
  let mdatBytes = 0;
  let topCount = 0;
  for (let offset = 0; offset < outputBlob.size;) {
    if (++topCount > 64 || outputBlob.size - offset < 8) invalid();
    const bytes = await read(offset, Math.min(outputBlob.size, offset + 16));
    const view = new DataView(bytes.buffer);
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1) {
      if (bytes.length < 16) invalid();
      const value = view.getBigUint64(8);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(value);
      header = 16;
    }
    if (size < header || size > outputBlob.size - offset) invalid();
    if (type === 'mdat') {
      mdatCount++;
      mdatBytes += size - header;
    } else if (type === 'moov') {
      if (
        moovStart !== -1 ||
        mdatCount !== 1 ||
        header !== 8 ||
        offset + size !== outputBlob.size ||
        size > MAX_METADATA_BYTES
      )
        invalid();
      moovStart = offset;
    } else if (!['ftyp', 'free', 'skip', 'wide'].includes(type)) invalid();
    offset += size;
  }
  if (moovStart < 0 || mdatCount !== 1) invalid();
  const moovBlob = outputBlob.slice(moovStart);
  const bytes = await read(moovStart, outputBlob.size);
  const view = new DataView(bytes.buffer);
  let visited = 0;
  const parse = (start: number, end: number, depth = 0): Box[] => {
    if (depth > 8) invalid();
    const result: Box[] = [];
    for (let offset = start; offset < end;) {
      if (++visited > 20_000 || end - offset < 8) invalid();
      const size = view.getUint32(offset);
      if (size < 8 || size > end - offset) invalid();
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (['mvex', 'moof', 'traf'].includes(type)) invalid();
      const box: Box = { type, start: offset, end: offset + size };
      if (containers.has(type)) box.children = parse(offset + 8, offset + size, depth + 1);
      result.push(box);
      offset += size;
    }
    return result;
  };
  const root = parse(0, bytes.length)[0]!;
  const one = (parent: Box, type: string): Box => {
    const matches = parent.children?.filter((box) => box.type === type) ?? [];
    if (matches.length !== 1) invalid();
    return matches[0]!;
  };
  const uint = (box: Box, offset: number): number => {
    if (box.start + 8 + offset + 4 > box.end) invalid();
    return view.getUint32(box.start + 8 + offset);
  };
  const version = (box: Box): 0 | 1 => {
    const value = bytes[box.start + 8];
    if (value !== 0 && value !== 1) invalid();
    return value;
  };
  const duration = (box: Box, offset0: number, offset1: number): number => {
    if (!version(box)) return uint(box, offset0);
    if (box.start + 8 + offset1 + 8 > box.end) invalid();
    const value = view.getBigUint64(box.start + 8 + offset1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  };
  const tracks = root.children?.filter((box) => box.type === 'trak') ?? [];
  if (!tracks.length || tracks.length > 16) invalid();
  const videos = tracks.filter((box) => {
    const handler = one(one(box, 'mdia'), 'hdlr');
    return uint(handler, 8) === 0x76696465;
  });
  if (videos.length !== 1) invalid();
  const track = videos[0]!;
  const tkhd = one(track, 'tkhd');
  const mdia = one(track, 'mdia');
  const mdhd = one(mdia, 'mdhd');
  const stbl = one(one(mdia, 'minf'), 'stbl');
  const stts = one(stbl, 'stts');
  const stsz = one(stbl, 'stsz');
  const cttsBoxes = stbl.children!.filter((box) => box.type === 'ctts');
  if (cttsBoxes.length > 1) invalid();
  const ctts = cttsBoxes[0];
  const timeline = await inspectIsoBmffTimeline(outputBlob, signal, 'video');
  const id = uint(tkhd, version(tkhd) ? 20 : 12);
  const descriptor = timeline?.tracks.find((candidate) => candidate.id === id);
  const clock = uint(mdhd, version(mdhd) ? 20 : 12);
  if (
    !timeline ||
    !descriptor ||
    descriptor.kind !== 'video' ||
    descriptor.timescale !== clock ||
    !clock ||
    descriptor.edit?.openEnded
  )
    invalid();
  const count = uint(stsz, 8);
  const fixedSize = uint(stsz, 4);
  if (
    uint(stsz, 0) !== 0 ||
    count !== expected.sampleCount ||
    stsz.end - stsz.start !== 20 + (fixedSize ? 0 : count * 4)
  )
    invalid();
  let totalSampleBytes = 0;
  for (let i = 0; i < count; i++) {
    const size = fixedSize || uint(stsz, 12 + i * 4);
    if (!size) invalid();
    totalSampleBytes += size;
  }
  if (!Number.isSafeInteger(totalSampleBytes) || totalSampleBytes > mdatBytes) invalid();
  const deltas = new Uint32Array(count);
  const offsets = new Float64Array(count);
  const expand = (box: Box, target: Uint32Array | Float64Array, composition: boolean) => {
    const v = version(box);
    if ((!composition && v !== 0) || (uint(box, 0) & 0xffffff) !== 0) invalid();
    const entries = uint(box, 4);
    if (entries < 1 || entries > count || box.end - box.start !== 16 + entries * 8) invalid();
    let index = 0;
    for (let row = 0; row < entries; row++) {
      const run = uint(box, 8 + row * 8);
      const value =
        composition && v === 1
          ? view.getInt32(box.start + 8 + 12 + row * 8)
          : uint(box, 12 + row * 8);
      if (!run || run > count - index || (!composition && value === 0)) invalid();
      target.fill(value, index, index + run);
      index += run;
    }
    if (index !== count) invalid();
  };
  expand(stts, deltas, false);
  if (ctts) expand(ctts, offsets, true);
  const editTicks = descriptor.edit
    ? Math.round((descriptor.edit.emptyDuration / timeline.movieTimescale) * clock) -
      descriptor.edit.mediaTime
    : 0;
  const scaled =
    (2n * BigInt(expected.durationTicks) * BigInt(clock) + BigInt(expected.timescale)) /
    (2n * BigInt(expected.timescale));
  if (scaled < 1n || scaled > BigInt(UINT32_MAX)) invalid();
  const wanted = Number(scaled);
  let dts = 0;
  let firstPts = Infinity;
  let maxPts = -Infinity;
  let maxIndex = -1;
  let duplicatedMax = false;
  let otherEnd = -Infinity;
  for (let i = 0; i < count; i++) {
    if (i % 4096 === 0) {
      checkMergeAborted(signal);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const pts = dts + offsets[i]!;
    if (!Number.isSafeInteger(pts) || !Number.isSafeInteger(dts + deltas[i]!)) invalid();
    firstPts = Math.min(firstPts, pts);
    if (pts > maxPts) {
      maxPts = pts;
      maxIndex = i;
      duplicatedMax = false;
    } else if (pts === maxPts) duplicatedMax = true;
    if (i !== expected.sampleIndex) otherEnd = Math.max(otherEnd, pts + deltas[i]!);
    dts += deltas[i]!;
  }
  if (duplicatedMax || maxIndex !== expected.sampleIndex || otherEnd > maxPts + wanted) invalid();
  const firstSeconds = (firstPts + editTicks) / clock;
  const lastSeconds = (maxPts + editTicks) / clock;
  const end = expected.timestampSeconds + expected.durationTicks / expected.timescale;
  const floatError = 32 * Number.EPSILON * Math.max(1, end);
  const editError = descriptor.edit ? 0.5 / timeline.movieTimescale + 0.5 / clock : 0;
  if (Math.abs(lastSeconds - expected.timestampSeconds) > 1 / clock + editError + floatError)
    invalid();
  // These headers already describe the original presentation span. Never patch
  // them to make an unexpected end fit, and do not compare the audio-owned MVHD.
  if (
    Math.abs(duration(mdhd, 16, 24) / clock - (end - firstSeconds)) >
      2 / clock + editError + floatError ||
    Math.abs(duration(tkhd, 20, 28) / timeline.movieTimescale - end) >
      1 / timeline.movieTimescale + 1 / clock + editError + floatError
  )
    invalid();
  const change = wanted - deltas[expected.sampleIndex]!;
  if (!change) {
    checkMergeAborted(signal);
    return outputBlob;
  }
  deltas[expected.sampleIndex] = wanted;
  let signed = ctts ? version(ctts) === 1 : true;
  for (let i = expected.sampleIndex + 1; i < count; i++) offsets[i] = offsets[i]! - change;
  for (const offset of offsets) {
    if (!Number.isSafeInteger(offset) || offset < -0x80000000 || offset > UINT32_MAX) invalid();
    if (offset < 0) signed = true;
  }
  if (signed && offsets.some((offset) => offset > 0x7fffffff)) invalid();
  const rle = (type: 'stts' | 'ctts', values: Uint32Array | Float64Array, signedValues = false) => {
    let runs = 0;
    for (let i = 0; i < values.length; i++) if (!i || values[i] !== values[i - 1]) runs++;
    const data = new Uint8Array(16 + runs * 8);
    const target = new DataView(data.buffer);
    target.setUint32(0, data.length);
    data.set(new TextEncoder().encode(type), 4);
    data[8] = Number(signedValues);
    target.setUint32(12, runs);
    let row = -1;
    for (let i = 0; i < values.length; i++) {
      if (!i || values[i] !== values[i - 1]) {
        row++;
        target.setUint32(16 + row * 8, 1);
        if (signedValues) target.setInt32(20 + row * 8, values[i]!);
        else target.setUint32(20 + row * 8, values[i]!);
      } else target.setUint32(16 + row * 8, target.getUint32(16 + row * 8) + 1);
    }
    return data;
  };
  const newStts = rle('stts', deltas);
  const newCtts = rle('ctts', offsets, signed);
  const rebuild = (box: Box): { parts: BlobPart[]; size: number } => {
    if (box === stts) return { parts: [newStts.buffer], size: newStts.length };
    if (box === ctts) return { parts: [newCtts.buffer], size: newCtts.length };
    if (!box.children)
      return { parts: [moovBlob.slice(box.start, box.end)], size: box.end - box.start };
    const children = box.children.map(rebuild);
    if (box === stbl && !ctts) children.push({ parts: [newCtts.buffer], size: newCtts.length });
    const size = 8 + children.reduce((sum, child) => sum + child.size, 0);
    if (size > MAX_METADATA_BYTES) invalid();
    const header = bytes.slice(box.start, box.start + 8);
    new DataView(header.buffer).setUint32(0, size);
    return { parts: [header.buffer, ...children.flatMap((child) => child.parts)], size };
  };
  const rebuilt = rebuild(root);
  checkMergeAborted(signal);
  return new Blob([outputBlob.slice(0, moovStart), ...rebuilt.parts], { type: outputBlob.type });
}
