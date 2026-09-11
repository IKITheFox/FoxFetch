import { mergeError } from './errors';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';

export interface FragmentPresentationSample {
  /** Original decode/packet sequence, zero based. All clocks below precede elst. */
  index: number;
  fragmentIndex: number;
  timestampTicks: number;
  decodeTimestampTicks: number;
  durationTicks: number;
  size: number;
  dataOffset: number;
  /** Pinned demuxer's fragment.moofOffset + within-fragment sample index. */
  sequenceNumber: number;
}

export interface FragmentPresentationTimeline {
  trackId: number;
  timescale: number;
  samples: readonly FragmentPresentationSample[];
  /** Only non-final fragment maximum-PTS samples; values are presentation ticks. */
  tailOverrides: ReadonlyMap<number, number>;
  finalPresentation: { index: number; timestampTicks: number; durationTicks: number };
  minTimestampTicks: number;
  maxTimestampTicks: number;
  fragmentCount: number;
}

export const FRAGMENT_TIMELINE_LIMITS = Object.freeze({
  metadataBytes: 32 * 1024 * 1024,
  samples: 1_000_000,
  boxes: 100_000,
});

type Box = { type: string; start: number; payload: number; end: number };
type FragmentSummary = { minimum: number; maximum: number; tail: FragmentPresentationSample };

function invalid(): never {
  throw mergeError(
    'TIMELINE_MISMATCH',
    '分片视频的原生时间轴或样本位置未通过结构校验，未进行无损封装。',
    {
      reason: 'PACKET_TIMELINE_MISMATCH',
      stage: 'media-metadata',
      canDownloadSeparately: true,
    },
  );
}

/**
 * Narrow proof for a complete, single-video fMP4. It reads no mdat payload and
 * changes nothing. It does not establish codec/DRM/payload fidelity, and never
 * applies edits: callers must prove those separately and match every packet's
 * sequence, raw PTS and byte size before consuming a tail override.
 *
 * A fragmented demuxer can retain decode duration for each fragment's last
 * presentation sample, while a flat demuxer uses global next-PTS duration. Only
 * these proven boundaries are normalized; the global final sample stays native.
 */
export async function inspectFragmentPresentationTimeline(
  blob: Blob,
  signal?: AbortSignal,
): Promise<FragmentPresentationTimeline | null> {
  let metadataBytes = 0;
  let visited = 0;
  const safe = (value: number) => {
    if (!Number.isSafeInteger(value)) invalid();
    return value;
  };
  const read = async (start: number, end: number): Promise<DataView> => {
    checkMergeAborted(signal);
    safe(start);
    safe(end);
    if (start < 0 || end < start || end > blob.size) invalid();
    metadataBytes += end - start;
    if (metadataBytes > FRAGMENT_TIMELINE_LIMITS.metadataBytes) invalid();
    const buffer = await withMergeDeadline(blob.slice(start, end).arrayBuffer(), {
      ...(signal ? { signal } : {}),
      stage: 'media-metadata',
    });
    if (buffer.byteLength !== end - start) invalid();
    return new DataView(buffer);
  };
  const typeAt = (view: DataView, offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  const uint64 = (view: DataView, offset: number) => {
    const value = view.getBigUint64(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  };
  if (blob.size < 8) {
    checkMergeAborted(signal);
    return null;
  }
  const first = await read(0, 8);
  if (!['ftyp', 'styp', 'moov', 'moof', 'free', 'skip', 'mdat'].includes(typeAt(first, 4)))
    return null;
  const boxes = async (start: number, end: number): Promise<Box[]> => {
    const result: Box[] = [];
    for (let at = start; at < end;) {
      if (++visited > FRAGMENT_TIMELINE_LIMITS.boxes || end - at < 8) invalid();
      const header = await read(at, at + 8);
      let size = header.getUint32(0),
        length = 8;
      if (size === 1) {
        if (end - at < 16) invalid();
        size = uint64(await read(at + 8, at + 16), 0);
        length = 16;
      } else if (!size) size = end - at;
      if (size < length || size > end - at) invalid();
      result.push({ type: typeAt(header, 4), start: at, payload: at + length, end: at + size });
      at += size;
    }
    return result;
  };
  const children = (box: Box) => boxes(box.payload, box.end);
  const one = (list: Box[], type: string): Box => {
    const matches = list.filter((box) => box.type === type);
    if (matches.length !== 1) invalid();
    return matches[0]!;
  };
  const payload = (box: Box) => read(box.payload, box.end);
  const fullBox = (
    view: DataView,
    length: number,
    versions: readonly number[] = [0],
    flags = 0,
  ) => {
    if (
      view.byteLength !== length ||
      !versions.includes(view.getUint8(0)) ||
      (view.getUint32(0) & 0xffffff) !== flags
    )
      invalid();
  };
  const top = await boxes(0, blob.size);
  const moofs = top.filter((box) => box.type === 'moof');
  if (!moofs.length) return null;
  const moov = one(top, 'moov');
  if (moov.end > moofs[0]!.start) invalid();
  const movie = await children(moov);
  const tracks = movie.filter((box) => box.type === 'trak');
  if (tracks.length !== 1) invalid();
  const track = await children(tracks[0]!);
  const tkhd = await payload(one(track, 'tkhd'));
  if (
    tkhd.byteLength < 4 ||
    ![0, 1].includes(tkhd.getUint8(0)) ||
    tkhd.byteLength !== (tkhd.getUint8(0) ? 96 : 84)
  )
    invalid();
  const trackId = tkhd.getUint32(tkhd.getUint8(0) ? 20 : 12);
  if (!trackId) invalid();
  const media = await children(one(track, 'mdia'));
  const mdhd = await payload(one(media, 'mdhd'));
  if (
    mdhd.byteLength < 4 ||
    ![0, 1].includes(mdhd.getUint8(0)) ||
    mdhd.byteLength !== (mdhd.getUint8(0) ? 36 : 24)
  )
    invalid();
  const timescale = mdhd.getUint32(mdhd.getUint8(0) ? 20 : 12);
  if (!timescale || mdhd.getUint32(0) & 0xffffff) invalid();
  const hdlr = await payload(one(media, 'hdlr'));
  if (hdlr.byteLength < 24 || hdlr.getUint32(0) !== 0 || typeAt(hdlr, 8) !== 'vide') invalid();
  const stbl = await children(one(await children(one(media, 'minf')), 'stbl'));
  const stsdBox = one(stbl, 'stsd');
  if (stsdBox.end - stsdBox.payload < 8) invalid();
  const stsd = await read(stsdBox.payload, stsdBox.payload + 8);
  if (stsd.getUint32(0) !== 0 || stsd.getUint32(4) !== 1) invalid();
  const entries = await boxes(stsdBox.payload + 8, stsdBox.end);
  if (
    entries.length !== 1 ||
    !['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp09'].includes(entries[0]!.type) ||
    entries[0]!.end - entries[0]!.payload < 78
  )
    invalid();
  const visual = await read(entries[0]!.payload, entries[0]!.payload + 78);
  if (visual.getUint16(6) !== 1 || !visual.getUint16(24) || !visual.getUint16(26)) invalid();
  // No hidden nonfragmented samples or ambiguous alternate descriptions.
  for (const type of ['stts', 'stsc']) {
    const table = await payload(one(stbl, type));
    fullBox(table, 8);
    if (table.getUint32(4)) invalid();
  }
  const sizes = await payload(one(stbl, 'stsz'));
  fullBox(sizes, 12);
  if (sizes.getUint32(4) || sizes.getUint32(8) || stbl.some((box) => box.type === 'stz2'))
    invalid();
  const offsets = stbl.filter((box) => box.type === 'stco' || box.type === 'co64');
  if (offsets.length !== 1) invalid();
  const chunks = await payload(offsets[0]!);
  fullBox(chunks, 8);
  if (chunks.getUint32(4)) invalid();
  const extended = await children(one(movie, 'mvex'));
  const trex = await payload(one(extended, 'trex'));
  fullBox(trex, 24);
  if (trex.getUint32(4) !== trackId || trex.getUint32(8) !== 1) invalid();
  const defaultDuration = trex.getUint32(12),
    defaultSize = trex.getUint32(16);
  const mdats = top.filter((box) => box.type === 'mdat');
  if (!mdats.length || mdats.some((box) => box.payload === box.end)) invalid();
  const inMedia = (start: number, end: number) => {
    let low = 0,
      high = mdats.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1,
        box = mdats[middle]!;
      if (start < box.payload) high = middle - 1;
      else if (start >= box.end) low = middle + 1;
      else return end <= box.end;
    }
    return false;
  };
  const samples: FragmentPresentationSample[] = [];
  const summaries: FragmentSummary[] = [];
  let expectedDecode: number | undefined;
  let previousSequence: number | undefined;
  for (let fragmentIndex = 0; fragmentIndex < moofs.length; fragmentIndex++) {
    checkMergeAborted(signal);
    const moof = moofs[fragmentIndex]!;
    const fragment = await children(moof);
    const mfhd = await payload(one(fragment, 'mfhd'));
    fullBox(mfhd, 8);
    const sequence = mfhd.getUint32(4);
    if (previousSequence != null && sequence <= previousSequence) invalid();
    previousSequence = sequence;
    const traf = await children(one(fragment, 'traf'));
    if (traf.some((box) => !['tfhd', 'tfdt', 'trun', 'sdtp'].includes(box.type))) invalid();
    const tfhd = await payload(one(traf, 'tfhd'));
    if (tfhd.byteLength < 8 || tfhd.getUint8(0) !== 0) invalid();
    const flags = tfhd.getUint32(0) & 0xffffff;
    if (flags & ~0x02003b || (flags & 1 && flags & 0x020000) || tfhd.getUint32(4) !== trackId)
      invalid();
    const expectedLength =
      8 +
      (flags & 1 ? 8 : 0) +
      (flags & 2 ? 4 : 0) +
      (flags & 8 ? 4 : 0) +
      (flags & 16 ? 4 : 0) +
      (flags & 32 ? 4 : 0);
    if (tfhd.byteLength !== expectedLength) invalid();
    let at = 8;
    // For a first (here sole) traf, omitted base also means this moof's start.
    let base = moof.start;
    if (flags & 1) {
      base = uint64(tfhd, at);
      at += 8;
    }
    if (flags & 2) {
      if (tfhd.getUint32(at) !== 1) invalid();
      at += 4;
    }
    let durationDefault = defaultDuration,
      sizeDefault = defaultSize;
    if (flags & 8) {
      durationDefault = tfhd.getUint32(at);
      at += 4;
    }
    if (flags & 16) {
      sizeDefault = tfhd.getUint32(at);
    }
    const tfdt = await payload(one(traf, 'tfdt'));
    if (tfdt.byteLength < 4) invalid();
    fullBox(tfdt, tfdt.getUint8(0) === 1 ? 12 : 8, [0, 1]);
    let dts = tfdt.getUint8(0) ? uint64(tfdt, 4) : tfdt.getUint32(4);
    if (expectedDecode != null && dts !== expectedDecode) invalid();
    let dataCursor = base;
    const firstIndex = samples.length;
    const runs = traf.filter((box) => box.type === 'trun');
    if (!runs.length) invalid();
    for (const run of runs) {
      const trun = await payload(run);
      if (trun.byteLength < 8 || ![0, 1].includes(trun.getUint8(0))) invalid();
      const runFlags = trun.getUint32(0) & 0xffffff;
      if (runFlags & ~0xf05 || (runFlags & 4 && runFlags & 0x400)) invalid();
      const count = trun.getUint32(4);
      if (!count || samples.length + count > FRAGMENT_TIMELINE_LIMITS.samples) invalid();
      const stride =
        (runFlags & 0x100 ? 4 : 0) +
        (runFlags & 0x200 ? 4 : 0) +
        (runFlags & 0x400 ? 4 : 0) +
        (runFlags & 0x800 ? 4 : 0);
      let cursor = 8 + (runFlags & 1 ? 4 : 0) + (runFlags & 4 ? 4 : 0);
      if (trun.byteLength !== cursor + count * stride) invalid();
      if (runFlags & 1) dataCursor = safe(base + trun.getInt32(8));
      for (let index = 0; index < count; index++) {
        if ((index & 1023) === 0) checkMergeAborted(signal);
        let duration = durationDefault,
          size = sizeDefault,
          cts = 0;
        if (runFlags & 0x100) {
          duration = trun.getUint32(cursor);
          cursor += 4;
        }
        if (runFlags & 0x200) {
          size = trun.getUint32(cursor);
          cursor += 4;
        }
        if (runFlags & 0x400) cursor += 4;
        if (runFlags & 0x800) {
          cts = trun.getUint8(0) ? trun.getInt32(cursor) : trun.getUint32(cursor);
          cursor += 4;
        }
        if (!duration || !size) invalid();
        const end = safe(dataCursor + size),
          pts = safe(dts + cts);
        if (!inMedia(dataCursor, end)) invalid();
        samples.push({
          index: samples.length,
          fragmentIndex,
          timestampTicks: pts,
          decodeTimestampTicks: dts,
          durationTicks: duration,
          size,
          dataOffset: dataCursor,
          sequenceNumber: safe(moof.start + samples.length - firstIndex),
        });
        dts = safe(dts + duration);
        safe(pts + duration);
        dataCursor = end;
      }
    }
    expectedDecode = dts;
    const sorted = samples.slice(firstIndex).sort((a, b) => a.timestampTicks - b.timestampTicks);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index]!.timestampTicks === sorted[index - 1]!.timestampTicks) invalid();
    }
    const tail = sorted.at(-1)!;
    const minimum = sorted[0]!.timestampTicks;
    if (summaries.length && minimum <= summaries.at(-1)!.maximum) invalid();
    summaries.push({ minimum, maximum: tail.timestampTicks, tail });
  }
  // Every byte in this narrow single-video mdat set must be referenced once.
  // This rules out aliased offsets, missing samples, unaccounted tracks and gaps.
  const byPosition = [...samples].sort((a, b) => a.dataOffset - b.dataOffset);
  let sampleIndex = 0;
  for (const mdat of mdats) {
    let position = mdat.payload;
    while (sampleIndex < byPosition.length && byPosition[sampleIndex]!.dataOffset < mdat.end) {
      const sample = byPosition[sampleIndex++]!;
      if (sample.dataOffset !== position) invalid();
      position += sample.size;
    }
    if (position !== mdat.end) invalid();
  }
  if (sampleIndex !== samples.length || !summaries.length) invalid();
  const tailOverrides = new Map<number, number>();
  for (let index = 0; index + 1 < summaries.length; index++) {
    const current = summaries[index]!;
    tailOverrides.set(current.tail.index, safe(summaries[index + 1]!.minimum - current.maximum));
  }
  const final = summaries.at(-1)!.tail;
  checkMergeAborted(signal);
  return {
    trackId,
    timescale,
    samples,
    tailOverrides,
    finalPresentation: {
      index: final.index,
      timestampTicks: final.timestampTicks,
      durationTicks: final.durationTicks,
    },
    minTimestampTicks: summaries[0]!.minimum,
    maxTimestampTicks: final.timestampTicks,
    fragmentCount: moofs.length,
  };
}
