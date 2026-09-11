import { mergeError } from './errors';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';
import type { MergeSourceTimelineDiagnostic } from './types';

export interface IsoBmffTrackTimeline {
  id: number;
  kind: 'video' | 'audio' | 'other';
  timescale: number;
  /** Only leading empty edits followed by one rate-1 media edit are supported. */
  edit?: { emptyDuration: number; mediaTime: number; mediaDuration: number; openEnded?: true };
}

export interface IsoBmffTimeline {
  movieTimescale: number;
  tracks: IsoBmffTrackTimeline[];
}

type Box = { type: string; payload: number; end: number };
type MutableTrack = Partial<IsoBmffTrackTimeline>;
type OpenEndedEdit = { track: MutableTrack; position: number; width: 4 | 8 };
const MAX_METADATA_BYTES = 4096;

/** Read only ISO-BMFF timing metadata, never media payloads or arbitrary strings. */
async function readIsoBmffTimeline(
  blob: Blob,
  signal?: AbortSignal,
  sourceKind?: 'video' | 'audio',
  openEndedEdits?: OpenEndedEdit[],
): Promise<IsoBmffTimeline | null> {
  let movieTimescale: number | undefined;
  const context = (
    box: string,
    track?: MutableTrack,
    fields: Partial<MergeSourceTimelineDiagnostic> = {},
  ): Omit<MergeSourceTimelineDiagnostic, 'issue'> => ({
    box: (['moov', 'mvhd', 'trak', 'tkhd', 'mdhd', 'hdlr', 'elst'].includes(box)
      ? box
      : 'structure') as MergeSourceTimelineDiagnostic['box'],
    ...(sourceKind ? { sourceKind } : {}),
    ...(movieTimescale == null ? {} : { movieTimescale }),
    ...(track?.timescale == null ? {} : { mediaTimescale: track.timescale }),
    ...fields,
  });
  function unsupported(
    issue: MergeSourceTimelineDiagnostic['issue'],
    details = context('structure'),
  ): never {
    throw mergeError('TIMELINE_MISMATCH', '来源编辑列表或时间基未通过结构校验，未进行无损封装。', {
      reason: 'SOURCE_EDIT_LIST_UNSUPPORTED',
      stage: 'media-metadata',
      sourceTimeline: { ...details, issue },
      canDownloadSeparately: true,
    });
  }
  const read = async (start: number, end: number) => {
    checkMergeAborted(signal);
    return new Uint8Array(
      await withMergeDeadline(blob.slice(start, end).arrayBuffer(), {
        ...(signal ? { signal } : {}),
        stage: 'media-metadata',
      }),
    );
  };
  const ascii = (bytes: Uint8Array, offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const first = await read(0, Math.min(blob.size, 16));
  if (
    first.length < 8 ||
    !['ftyp', 'styp', 'moov', 'free', 'skip', 'mdat'].includes(ascii(first, 4))
  )
    return null;
  let visited = 0;
  const boxes = async (start: number, end: number) => {
    const result: Box[] = [];
    for (let offset = start; offset < end;) {
      if (++visited > 20000) unsupported('metadata-limit');
      if (end - offset < 8) unsupported('invalid-box');
      const bytes = await read(offset, Math.min(end, offset + 16));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let size = view.getUint32(0);
      let header = 8;
      if (size === 1) {
        if (bytes.length < 16) unsupported('invalid-box');
        const extended = view.getBigUint64(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) unsupported('invalid-box');
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || size > end - offset)
        unsupported('invalid-box', context(ascii(bytes, 4)));
      result.push({ type: ascii(bytes, 4), payload: offset + header, end: offset + size });
      offset += size;
    }
    return result;
  };
  const payload = async (box: Box, track?: MutableTrack) => {
    if (box.end - box.payload > MAX_METADATA_BYTES)
      unsupported('metadata-limit', context(box.type, track));
    return read(box.payload, box.end);
  };
  const versioned = (bytes: Uint8Array, box: Box, track?: MutableTrack) => {
    if (bytes.length < 4) unsupported('invalid-box', context(box.type, track));
    if (bytes[0] !== 0 && bytes[0] !== 1)
      unsupported('unsupported-version', context(box.type, track));
    return bytes[0] === 1 ? 20 : 12;
  };
  const uint32 = (bytes: Uint8Array, offset: number, box: Box, track?: MutableTrack) => {
    if (offset + 4 > bytes.length) unsupported('invalid-box', context(box.type, track));
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  };
  let moovCount = 0;
  let movieExtends = false;
  let movieFragments = false;
  let openEndedContext: Omit<MergeSourceTimelineDiagnostic, 'issue'> | undefined;
  const tracks: MutableTrack[] = [];
  const editLists = new Set<MutableTrack>();
  const walk = async (
    start: number,
    end: number,
    depth: number,
    track?: MutableTrack,
  ): Promise<void> => {
    if (depth > 8) unsupported('metadata-limit');
    for (const box of await boxes(start, end)) {
      if (box.type === 'moov') {
        if (++moovCount !== 1) unsupported('duplicate-metadata', context('moov'));
        await walk(box.payload, box.end, depth + 1);
      } else if (box.type === 'trak') {
        const next: MutableTrack = {};
        tracks.push(next);
        await walk(box.payload, box.end, depth + 1, next);
      } else if (box.type === 'mdia' || box.type === 'edts') {
        await walk(box.payload, box.end, depth + 1, track);
      } else if (box.type === 'mvex' && depth === 1 && !track) {
        movieExtends = true;
      } else if (box.type === 'moof' && depth === 0) {
        movieFragments = true;
      } else if (box.type === 'mvhd') {
        if (movieTimescale != null) unsupported('duplicate-metadata', context(box.type));
        const bytes = await payload(box);
        movieTimescale = uint32(bytes, versioned(bytes, box), box);
        if (!movieTimescale)
          unsupported(
            'invalid-timebase',
            context(box.type, undefined, { version: bytes[0] as 0 | 1 }),
          );
      } else if (track && box.type === 'tkhd') {
        if (track.id != null) unsupported('duplicate-metadata', context(box.type, track));
        const bytes = await payload(box, track);
        track.id = uint32(bytes, versioned(bytes, box, track), box, track);
        if (!track.id)
          unsupported('invalid-track', context(box.type, track, { version: bytes[0] as 0 | 1 }));
      } else if (track && box.type === 'mdhd') {
        if (track.timescale != null) unsupported('duplicate-metadata', context(box.type, track));
        const bytes = await payload(box, track);
        track.timescale = uint32(bytes, versioned(bytes, box, track), box, track);
        if (!track.timescale)
          unsupported('invalid-timebase', context(box.type, track, { version: bytes[0] as 0 | 1 }));
      } else if (track && box.type === 'hdlr') {
        const bytes = await payload(box, track);
        if (bytes.length < 12) unsupported('invalid-box', context(box.type, track));
        if (track.kind) unsupported('duplicate-metadata', context(box.type, track));
        const type = ascii(bytes, 8);
        track.kind = type === 'vide' ? 'video' : type === 'soun' ? 'audio' : 'other';
      } else if (track && box.type === 'elst') {
        if (editLists.has(track)) unsupported('duplicate-metadata', context(box.type, track));
        editLists.add(track);
        const bytes = await payload(box, track);
        versioned(bytes, box, track);
        const count = uint32(bytes, 4, box, track);
        const editContext = context(box.type, track, {
          version: bytes[0] as 0 | 1,
          entryCount: count,
        });
        const size = bytes[0] === 1 ? 20 : 12;
        if (count > 128 || bytes.length !== 8 + size * count)
          unsupported('malformed-edit-list', editContext);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let emptyDuration = 0;
        let media: { mediaTime: number; mediaDuration: number; openEnded?: true } | undefined;
        for (let index = 0; index < count; index++) {
          const offset = 8 + index * size;
          const duration = size === 20 ? Number(view.getBigUint64(offset)) : view.getUint32(offset);
          const time =
            size === 20 ? Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4);
          const rate = view.getInt32(offset + size - 4);
          const entryContext = {
            ...editContext,
            entryIndex: index,
            ...(Number.isSafeInteger(duration) ? { duration } : {}),
            ...(Number.isSafeInteger(time) && time >= -1 ? { mediaTime: time } : {}),
            rate,
          };
          if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(time))
            unsupported('malformed-edit-list', entryContext);
          if (rate !== 65536) unsupported('edit-rate', entryContext);
          if (time < -1) unsupported('negative-media-time', entryContext);
          if (media) unsupported('multiple-edits', entryContext);
          if (!duration) {
            // The final duration-0 media edit spans subsequent fragments. Preserve
            // its offset explicitly; callers must use a proven finite read view
            // before demuxing because Mediabunny otherwise ignores this entry.
            if (index !== count - 1) unsupported('multiple-edits', entryContext);
            if (time < 0) unsupported('open-ended-offset', entryContext);
            media = { mediaTime: time, mediaDuration: 0, openEnded: true };
            openEndedContext = entryContext;
            openEndedEdits?.push({
              track,
              position: box.payload + offset,
              width: size === 20 ? 8 : 4,
            });
            continue;
          }
          if (time === -1) {
            emptyDuration += duration;
            if (!Number.isSafeInteger(emptyDuration))
              unsupported('malformed-edit-list', entryContext);
          } else media = { mediaTime: time, mediaDuration: duration };
        }
        if (count && !media) unsupported('empty-edit-list', editContext);
        if (media) track.edit = { emptyDuration, ...media };
      }
    }
  };
  await walk(0, blob.size, 0);
  if (moovCount !== 1) unsupported('invalid-box', context('moov'));
  if (!movieTimescale) unsupported('invalid-timebase', context('mvhd'));
  if (!tracks.length) unsupported('invalid-track', context('trak'));
  if (openEndedContext && (!movieExtends || !movieFragments))
    unsupported('malformed-edit-list', openEndedContext);
  const ids = new Set<number>();
  for (const track of tracks) {
    if (!track.id || ids.has(track.id) || !track.kind)
      unsupported('invalid-track', context('trak', track));
    if (!track.timescale) unsupported('invalid-timebase', context('mdhd', track));
    if (track.edit) {
      // A safe integer duration can still overflow when converted between clocks.
      // Prove the pinned demuxer's rounded empty-edit ticks using exact arithmetic.
      const numerator = BigInt(track.edit.emptyDuration) * BigInt(track.timescale);
      const denominator = BigInt(movieTimescale);
      const emptyTicks = (2n * numerator + denominator) / (2n * denominator);
      const offsetTicks = BigInt(track.edit.mediaTime) - emptyTicks;
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
      const demuxEmptyTicks = Math.round(
        (track.edit.emptyDuration / movieTimescale) * track.timescale,
      );
      if (
        emptyTicks > maxSafe ||
        offsetTicks < -maxSafe ||
        offsetTicks > maxSafe ||
        !Number.isSafeInteger(demuxEmptyTicks) ||
        BigInt(demuxEmptyTicks) !== emptyTicks
      ) {
        unsupported(
          'invalid-timebase',
          context('elst', track, {
            mediaTime: track.edit.mediaTime,
            duration: track.edit.mediaDuration,
            rate: 65536,
          }),
        );
      }
    }
    ids.add(track.id);
  }
  return { movieTimescale, tracks: tracks as IsoBmffTrackTimeline[] };
}

/** Metadata only: an openEnded edit is evidence, not permission to ignore its offset. */
export async function inspectIsoBmffTimeline(
  blob: Blob,
  signal?: AbortSignal,
  sourceKind?: 'video' | 'audio',
): Promise<IsoBmffTimeline | null> {
  return readIsoBmffTimeline(blob, signal, sourceKind);
}

/**
 * Equal-length demuxer-only view. Bounds must come from an exhaustive raw packet
 * metadata pass over this exact input, keyed by track ID, in presentation seconds.
 * Only edit durations change; original timestamps, sample tables and media bytes do not.
 */
export async function createIsoBmffTimelineReadView(
  blob: Blob,
  sampleEndByTrack: ReadonlyMap<number, number>,
  signal?: AbortSignal,
  sourceKind?: 'video' | 'audio',
): Promise<Blob> {
  const edits: OpenEndedEdit[] = [];
  const timeline = await readIsoBmffTimeline(blob, signal, sourceKind, edits);
  if (!timeline || !edits.length) return blob;
  const parts: BlobPart[] = [];
  let cursor = 0;
  for (const patch of edits.sort((a, b) => a.position - b.position)) {
    checkMergeAborted(signal);
    const track = patch.track as IsoBmffTrackTimeline;
    const edit = track.edit!;
    const rawEnd = sampleEndByTrack.get(track.id);
    const seconds = rawEnd == null ? Number.NaN : rawEnd - edit.mediaTime / track.timescale;
    // Strictly exceed the proven end by at most one movie tick to cover floating
    // conversion rounding; never invent an unbounded/MAX_UINT duration.
    const duration = Math.floor(seconds * timeline.movieTimescale) + 1;
    if (
      rawEnd == null ||
      !Number.isFinite(rawEnd) ||
      !Number.isSafeInteger(Math.round(rawEnd * track.timescale)) ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      (patch.width === 4 && duration > 0xffffffff) ||
      duration / timeline.movieTimescale < seconds
    ) {
      throw mergeError(
        'TIMELINE_MISMATCH',
        '开放时长编辑缺少可证明覆盖全部样本的读取边界，未进行无损封装。',
        {
          reason: 'SOURCE_EDIT_LIST_UNSUPPORTED',
          stage: 'media-metadata',
          canDownloadSeparately: true,
          sourceTimeline: {
            issue: 'open-ended-offset',
            box: 'elst',
            ...(sourceKind ? { sourceKind } : {}),
            version: patch.width === 8 ? 1 : 0,
            movieTimescale: timeline.movieTimescale,
            mediaTimescale: track.timescale,
            mediaTime: edit.mediaTime,
            duration: 0,
            rate: 65536,
          },
        },
      );
    }
    const bytes = new Uint8Array(patch.width);
    const view = new DataView(bytes.buffer);
    if (patch.width === 8) view.setBigUint64(0, BigInt(duration));
    else view.setUint32(0, duration);
    parts.push(blob.slice(cursor, patch.position), bytes);
    cursor = patch.position + patch.width;
  }
  checkMergeAborted(signal);
  parts.push(blob.slice(cursor));
  return new Blob(parts, { type: blob.type });
}
