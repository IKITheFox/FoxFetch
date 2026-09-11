import { describe, expect, it } from 'vitest';
import {
  createIsoBmffTimelineReadView,
  inspectIsoBmffTimeline,
} from '../../src/modules/merge/iso-bmff-timeline';
import { packetTimelineMismatch } from '../../src/modules/merge/packet-timeline';

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(8 + parts.reduce((size, part) => size + part.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  let position = 8;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.length;
  }
  return bytes;
}

function timingHeader(type: 'mvhd' | 'tkhd' | 'mdhd', value: number, version: 0 | 1) {
  // Full standard payloads, not a shortened shared timing prefix. Version 1 changes
  // both timestamps and duration to 64 bits, but keeps the ID/timescale at 32 bits.
  const lengths = { mvhd: [100, 112], tkhd: [84, 96], mdhd: [24, 36] } as const;
  const bytes = new Uint8Array(lengths[type][version]);
  const view = new DataView(bytes.buffer);
  bytes[0] = version;
  if (type === 'tkhd') bytes[3] = 3;
  const field = version ? 20 : 12;
  view.setUint32(field, value);
  const duration = field + (type === 'tkhd' ? 8 : 4);
  if (version) view.setBigUint64(duration, 57600n);
  else view.setUint32(duration, 57600);
  if (type === 'mvhd' || type === 'tkhd') {
    const matrix = type === 'mvhd' ? (version ? 48 : 36) : version ? 52 : 40;
    view.setUint32(matrix, 65536);
    view.setUint32(matrix + 16, 65536);
    view.setUint32(matrix + 32, 1 << 30);
  }
  if (type === 'mvhd') {
    view.setUint32(version ? 32 : 20, 65536);
    view.setUint16(version ? 36 : 24, 256);
    view.setUint32(bytes.length - 4, 3);
  } else if (type === 'mdhd') {
    view.setUint16(bytes.length - 4, 0x55c4); // und
  }
  return bytes;
}

function file(
  edits: Array<{ duration: number; time: number; rate?: number }>,
  version: 0 | 1 = 0,
  fragmented = false,
  clocks = { movie: 57600, media: 48000 },
) {
  const entrySize = version ? 20 : 12;
  const elst = new Uint8Array(8 + edits.length * entrySize);
  elst[0] = version;
  const view = new DataView(elst.buffer);
  view.setUint32(4, edits.length);
  edits.forEach((edit, index) => {
    const offset = 8 + index * entrySize;
    if (version) {
      view.setBigUint64(offset, BigInt(edit.duration));
      view.setBigInt64(offset + 8, BigInt(edit.time));
    } else {
      view.setUint32(offset, edit.duration);
      view.setInt32(offset + 4, edit.time);
    }
    view.setInt32(offset + entrySize - 4, edit.rate ?? 65536);
  });
  const hdlr = new Uint8Array(25);
  hdlr.set(new TextEncoder().encode('soun'), 8);
  const trex = new Uint8Array(24);
  new DataView(trex.buffer).setUint32(4, 2);
  new DataView(trex.buffer).setUint32(8, 1);
  const mfhd = new Uint8Array(8);
  new DataView(mfhd.buffer).setUint32(4, 1);
  const tfhd = new Uint8Array([0, 2, 0, 0, 0, 0, 0, 2]);
  const tfdt = new Uint8Array(8);
  const trun = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
  return new Blob([
    new Uint8Array(box('ftyp', new TextEncoder().encode('isom'), new Uint8Array(4))).buffer,
    new Uint8Array(
      box(
        'moov',
        box('mvhd', timingHeader('mvhd', clocks.movie, version)),
        box(
          'trak',
          box('tkhd', timingHeader('tkhd', 2, version)),
          box('edts', box('elst', elst)),
          box('mdia', box('mdhd', timingHeader('mdhd', clocks.media, version)), box('hdlr', hdlr)),
        ),
        ...(fragmented ? [box('mvex', box('trex', trex))] : []),
      ),
    ).buffer,
    ...(fragmented
      ? [
          new Uint8Array(
            box(
              'moof',
              box('mfhd', mfhd),
              box('traf', box('tfhd', tfhd), box('tfdt', tfdt), box('trun', trun)),
            ),
          ).buffer,
        ]
      : []),
    new Uint8Array(box('mdat', new Uint8Array(8192))).buffer,
  ]);
}

describe('v0.13 ISO-BMFF edit-list evidence', () => {
  // Metadata values copied from the user's two locally retained original video tracks
  // on 2026-09-06. This is a timing-only container fixture, not either real media file.
  it.each([
    {
      label: 'HDR',
      edits: [
        { duration: 67, time: -1 },
        { duration: 0, time: 1072 },
      ],
      rawEnd: 304.771,
      finiteDuration: 304705,
      offset: 0,
    },
    {
      label: 'DV',
      edits: [{ duration: 0, time: 1602 }],
      rawEnd: 218.618375,
      finiteDuration: 218519,
      offset: -0.100125,
    },
  ])(
    'preserves the actual $label source edit numbers while proving a finite read interval',
    async ({ edits, rawEnd, finiteDuration, offset }) => {
      const source = file(edits, 0, true, { movie: 1000, media: 16000 });
      const metadata = await inspectIsoBmffTimeline(source);
      const edit = metadata!.tracks[0]!.edit!;
      expect(
        edit.emptyDuration / metadata!.movieTimescale -
          edit.mediaTime / metadata!.tracks[0]!.timescale,
      ).toBe(offset);
      const view = await createIsoBmffTimelineReadView(source, new Map([[2, rawEnd]]));
      expect((await inspectIsoBmffTimeline(view))!.tracks[0]!.edit).toEqual({
        emptyDuration: edit.emptyDuration,
        mediaTime: edit.mediaTime,
        mediaDuration: finiteDuration,
      });
    },
  );
  it.each([0, 1] as const)(
    'accepts a version-%i single open-ended identity edit in a fragmented movie',
    async (version) => {
      const evidence = await inspectIsoBmffTimeline(
        file([{ duration: 0, time: 0 }], version, true),
      );
      expect(evidence).toEqual({
        movieTimescale: 57600,
        tracks: [
          {
            id: 2,
            kind: 'audio',
            timescale: 48000,
            edit: { emptyDuration: 0, mediaTime: 0, mediaDuration: 0, openEnded: true },
          },
        ],
      });
    },
  );
  it.each([0, 1] as const)(
    'retains a version-%i open-ended nonzero composition offset as explicit evidence',
    async (version) => {
      await expect(
        inspectIsoBmffTimeline(file([{ duration: 0, time: 1024 }], version, true)),
      ).resolves.toMatchObject({
        tracks: [{ edit: { mediaTime: 1024, mediaDuration: 0, openEnded: true } }],
      });
    },
  );
  it.each([0, 1] as const)(
    'creates only an equal-length duration patch for a version-%i open-ended media edit',
    async (version) => {
      const source = file(
        [
          { duration: 576, time: -1 },
          { duration: 0, time: 1024 },
        ],
        version,
        true,
      );
      const before = new Uint8Array(await source.arrayBuffer());
      const view = await createIsoBmffTimelineReadView(source, new Map([[2, 12.5]]));
      const expectedDuration = Math.floor((12.5 - 1024 / 48000) * 57600) + 1;
      expect(view.size).toBe(source.size);
      expect(await inspectIsoBmffTimeline(view)).toMatchObject({
        tracks: [
          {
            edit: {
              emptyDuration: 576,
              mediaTime: 1024,
              mediaDuration: expectedDuration,
            },
          },
        ],
      });
      expect((await inspectIsoBmffTimeline(view))?.tracks[0]?.edit).not.toHaveProperty('openEnded');
      expect((await inspectIsoBmffTimeline(source))?.tracks[0]?.edit).toMatchObject({
        mediaDuration: 0,
        openEnded: true,
      });
      expect(new Uint8Array(await source.arrayBuffer())).toEqual(before);
      const after = new Uint8Array(await view.arrayBuffer());
      const elstType = before.findIndex((_, index) =>
        ['e', 'l', 's', 't'].every((char, part) => before[index + part] === char.charCodeAt(0)),
      );
      const field = elstType + 12 + (version ? 20 : 12);
      const changed = [...before.keys()].filter((index) => before[index] !== after[index]);
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((index) => index >= field && index < field + (version ? 8 : 4))).toBe(
        true,
      );
      expect(await createIsoBmffTimelineReadView(view, new Map())).toBe(view);
    },
  );
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1024 / 48000, 1e15])(
    'refuses an unproven or unrepresentable open-ended bound (%s)',
    async (bound) => {
      const source = file([{ duration: 0, time: 1024 }], 0, true);
      await expect(
        createIsoBmffTimelineReadView(
          source,
          new Map(bound == null ? [] : [[2, bound]]),
          undefined,
          'audio',
        ),
      ).rejects.toMatchObject({
        detail: {
          reason: 'SOURCE_EDIT_LIST_UNSUPPORTED',
          sourceTimeline: { sourceKind: 'audio', box: 'elst', issue: 'open-ended-offset' },
        },
      });
    },
  );
  it('does not treat a zero-length non-fragmented edit or positive empty-only edit as identity', async () => {
    for (const source of [
      file([{ duration: 0, time: 0 }]),
      file([{ duration: 576, time: -1 }], 0, true),
    ]) {
      await expect(inspectIsoBmffTimeline(source)).rejects.toMatchObject({
        detail: { reason: 'SOURCE_EDIT_LIST_UNSUPPORTED' },
      });
    }
  });
  it('classifies a rate failure with only exact source and edit numeric evidence', async () => {
    await expect(
      inspectIsoBmffTimeline(
        file([{ duration: 100, time: 1024, rate: 32768 }]),
        undefined,
        'audio',
      ),
    ).rejects.toMatchObject({
      detail: {
        sourceTimeline: {
          issue: 'edit-rate',
          box: 'elst',
          sourceKind: 'audio',
          version: 0,
          movieTimescale: 57600,
          entryCount: 1,
          entryIndex: 0,
          duration: 100,
          mediaTime: 1024,
          rate: 32768,
        },
      },
    });
  });
  it('classifies invalid media clocks separately from complex edits', async () => {
    await expect(
      inspectIsoBmffTimeline(file([], 0, false, { movie: 1000, media: 0 }), undefined, 'video'),
    ).rejects.toMatchObject({
      detail: {
        sourceTimeline: {
          issue: 'invalid-timebase',
          box: 'mdhd',
          sourceKind: 'video',
          movieTimescale: 1000,
          mediaTimescale: 0,
        },
      },
    });
  });
  it('does not expose an unsupported full-box version or unsafe edit integer as a guessed value', async () => {
    const bytes = new Uint8Array(await file([{ duration: 1, time: 0 }], 1).arrayBuffer());
    const typePosition = (type: string) =>
      bytes.findIndex((_, start) =>
        [...type].every((character, index) => bytes[start + index] === character.charCodeAt(0)),
      );
    const elst = typePosition('elst') + 4;
    new DataView(bytes.buffer).setBigUint64(elst + 8, 2n ** 63n);
    await expect(inspectIsoBmffTimeline(new Blob([bytes]))).rejects.toMatchObject({
      detail: { sourceTimeline: { issue: 'malformed-edit-list', box: 'elst', version: 1 } },
    });
    try {
      await inspectIsoBmffTimeline(new Blob([bytes]));
    } catch (error) {
      expect(
        (error as { detail: { sourceTimeline: unknown } }).detail.sourceTimeline,
      ).not.toHaveProperty('duration');
    }
    bytes[elst] = 2;
    try {
      await inspectIsoBmffTimeline(new Blob([bytes]));
      throw new Error('Expected version rejection');
    } catch (error) {
      expect(error).toMatchObject({
        detail: { sourceTimeline: { issue: 'unsupported-version', box: 'elst' } },
      });
      expect(
        (error as { detail: { sourceTimeline: unknown } }).detail.sourceTimeline,
      ).not.toHaveProperty('version');
    }
  });
  it('refuses an empty-edit scale product whose resulting offset cannot be represented exactly', async () => {
    const source = file(
      [
        { duration: Number.MAX_SAFE_INTEGER, time: -1 },
        { duration: 0, time: 0 },
      ],
      1,
      true,
      { movie: 1, media: 0xffffffff },
    );
    await expect(inspectIsoBmffTimeline(source)).rejects.toMatchObject({
      detail: { sourceTimeline: { issue: 'invalid-timebase', box: 'elst' } },
    });
  });
  it('proves non-integral empty-edit clock conversion using exact rounded media ticks', async () => {
    const source = file(
      [
        { duration: 1, time: -1 },
        { duration: 0, time: 10 },
      ],
      1,
      true,
      { movie: 3, media: 10 },
    );
    const view = await createIsoBmffTimelineReadView(source, new Map([[2, 2]]));
    expect((await inspectIsoBmffTimeline(view))?.tracks[0]?.edit).toEqual({
      emptyDuration: 1,
      mediaTime: 10,
      mediaDuration: 4,
    });
  });
  it('refuses cancellation before constructing an open-ended read view', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await expect(
      createIsoBmffTimelineReadView(
        file([{ duration: 0, time: 0 }], 0, true),
        new Map([[2, 1]]),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each([0, 1] as const)(
    'accepts a valid version-%i leading empty edit and single media edit without applying it twice',
    async (version) => {
      const evidence = await inspectIsoBmffTimeline(
        file(
          [
            { duration: 576, time: -1 },
            { duration: 57600, time: 1024 },
          ],
          version,
        ),
      );
      expect(evidence).toEqual({
        movieTimescale: 57600,
        tracks: [
          {
            id: 2,
            kind: 'audio',
            timescale: 48000,
            edit: { emptyDuration: 576, mediaTime: 1024, mediaDuration: 57600 },
          },
        ],
      });
    },
  );
  it.each([
    [
      { duration: 57600, time: 0 },
      { duration: 100, time: 48000 },
    ],
    [{ duration: 57600, time: 0, rate: 32768 }],
    [{ duration: 57600, time: -2 }],
    [
      { duration: 57600, time: 0 },
      { duration: 100, time: -1 },
    ],
  ])(
    'fails closed for an edit list that the demuxer would otherwise partially ignore (%j)',
    async (...edits) => {
      await expect(inspectIsoBmffTimeline(file(edits))).rejects.toMatchObject({
        detail: { reason: 'SOURCE_EDIT_LIST_UNSUPPORTED', stage: 'media-metadata' },
      });
    },
  );
  it('skips non-ISO inputs without treating them as malformed MP4', async () => {
    expect(
      await inspectIsoBmffTimeline(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])])),
    ).toBeNull();
  });
});

describe('v0.13 clock-derived packet bounds', () => {
  const context = {
    track: 'audio' as const,
    packetIndex: 1,
    originSeconds: 0,
    sourceTimescale: 48000,
    outputTimescale: 48000,
    outputUsesEditList: false,
  };
  it('does not use the old blanket 0.1 ms allowance for a high-resolution audio clock', () => {
    expect(
      packetTimelineMismatch(
        { timestamp: 1, duration: 1024 / 48000 },
        { timestamp: 1.00009, duration: 1024 / 48000 },
        context,
      )?.mismatch,
    ).toBe('timestamp');
  });
  it('includes only finite white-listed numeric diagnostics for invalid packets', () => {
    const result = packetTimelineMismatch(
      { timestamp: Number.NaN, duration: 1 },
      { timestamp: 0, duration: Number.POSITIVE_INFINITY },
      context,
    );
    expect(result).toMatchObject({ track: 'audio', packetIndex: 1, mismatch: 'non-finite' });
    expect(result).not.toHaveProperty('sourceTimestampSeconds');
    expect(result).not.toHaveProperty('outputDurationSeconds');
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity|null|https?:/);
  });
  it('rejects an unproven timebase instead of giving it a fallback tolerance', () => {
    expect(
      packetTimelineMismatch(
        { timestamp: 0, duration: 1 },
        { timestamp: 0, duration: 1 },
        { ...context, outputTimescale: 0 },
      )?.mismatch,
    ).toBe('timebase');
  });
  it('never permits an independently shifted track even if all packet durations are unchanged', () => {
    expect(
      packetTimelineMismatch(
        { timestamp: 2.05, duration: 0.02 },
        { timestamp: 0, duration: 0.02 },
        { ...context, originSeconds: 2 },
      )?.mismatch,
    ).toBe('timestamp');
  });
});
