import { describe, expect, it, vi } from 'vitest';
import {
  FRAGMENT_TIMELINE_LIMITS,
  inspectFragmentPresentationTimeline,
} from '../../src/modules/merge/fragment-presentation-timeline';

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function u32(...values: number[]) {
  const result = new Uint8Array(values.length * 4);
  values.forEach((value, index) => new DataView(result.buffer).setUint32(index * 4, value));
  return result;
}
function box(type: string, ...parts: Uint8Array[]) {
  const content = join(...parts);
  return join(u32(content.length + 8), new TextEncoder().encode(type), content);
}
type FixtureSample = { duration: number; cts: number; size?: number };
type FixtureOptions = {
  samples?: FixtureSample[][];
  timescale?: number;
  decodeStart?: number;
  secondDecodeShift?: number;
  dataOffsetShift?: number;
  declaredSizeShift?: number;
  descriptionIndex?: number;
  sampleEntry?: string;
  duplicateDescription?: boolean;
  trunVersion?: number;
  trunFlagsExtra?: number;
  countExtra?: number;
  trexDefaults?: boolean;
  absoluteBase?: boolean;
  implicitBase?: boolean;
  orphanMdat?: boolean;
  duplicateRun?: boolean;
  trailingMetadata?: boolean;
  hdlrPadding?: number;
};
function fixture(options: FixtureOptions = {}) {
  const samples = options.samples ?? [
    // B-frame decode order. First fragment's maximum PTS is not last decode sample.
    [
      { duration: 10, cts: 10 },
      { duration: 10, cts: 21 },
      { duration: 10, cts: 0 },
    ],
    [
      { duration: 10, cts: 10 },
      { duration: 10, cts: 20 },
      { duration: 10, cts: 0 },
    ],
  ];
  const mvhd = new Uint8Array(100),
    tkhd = new Uint8Array(84),
    mdhd = new Uint8Array(24);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(tkhd.buffer).setUint32(12, 1);
  new DataView(mdhd.buffer).setUint32(12, options.timescale ?? 1000);
  const hdlr = new Uint8Array(25 + (options.hdlrPadding ?? 0));
  hdlr.set(new TextEncoder().encode('vide'), 8);
  const visual = new Uint8Array(78);
  new DataView(visual.buffer).setUint16(6, 1);
  new DataView(visual.buffer).setUint16(24, 1920);
  new DataView(visual.buffer).setUint16(26, 1080);
  const entry = box(options.sampleEntry ?? 'hvc1', visual);
  const stsd = box(
    'stsd',
    u32(0, options.duplicateDescription ? 2 : 1),
    entry,
    ...(options.duplicateDescription ? [entry] : []),
  );
  const moov = box(
    'moov',
    box('mvhd', mvhd),
    box(
      'trak',
      box('tkhd', tkhd),
      box(
        'mdia',
        box('mdhd', mdhd),
        box('hdlr', hdlr),
        box(
          'minf',
          box(
            'stbl',
            stsd,
            box('stts', u32(0, 0)),
            box('stsc', u32(0, 0)),
            box('stsz', u32(0, 0, 0)),
            box('stco', u32(0, 0)),
          ),
        ),
      ),
    ),
    box(
      'mvex',
      box('trex', u32(0, 1, 1, options.trexDefaults ? 10 : 0, options.trexDefaults ? 2 : 0, 0)),
    ),
  );
  const parts = [box('ftyp', new TextEncoder().encode('isom'), u32(0)), moov];
  let position = parts.reduce((sum, part) => sum + part.length, 0);
  let dts = options.decodeStart ?? 0;
  samples.forEach((group, fragmentIndex) => {
    const makeMoof = (offset: number) => {
      const tfhdFlags = options.absoluteBase ? 1 : options.implicitBase ? 0 : 0x020000;
      const tfhd = box(
        'tfhd',
        u32(tfhdFlags | 2, 1),
        ...(options.absoluteBase ? [u32(0, position)] : []),
        u32(options.descriptionIndex ?? 1),
      );
      const baseDecode = dts + (fragmentIndex === 1 ? (options.secondDecodeShift ?? 0) : 0);
      const tfdt = box(
        'tfdt',
        u32(0x01000000, Math.floor(baseDecode / 0x100000000), baseDecode % 0x100000000),
      );
      const flags = (options.trexDefaults ? 0x801 : 0xb01) | (options.trunFlagsExtra ?? 0);
      const trun = box(
        'trun',
        u32(
          ((options.trunVersion ?? 1) << 24) | flags,
          group.length + (options.countExtra ?? 0),
          offset + (options.dataOffsetShift ?? 0),
        ),
        ...group.map((sample) =>
          options.trexDefaults
            ? u32(sample.cts)
            : u32(
                sample.duration,
                (sample.size ?? 2) + (options.declaredSizeShift ?? 0),
                sample.cts,
              ),
        ),
      );
      return box(
        'moof',
        box('mfhd', u32(0, fragmentIndex + 1)),
        box('traf', tfhd, tfdt, trun, ...(options.duplicateRun ? [trun] : [])),
      );
    };
    const preliminary = makeMoof(0),
      moof = makeMoof(preliminary.length + 8);
    const mdat = box(
      'mdat',
      new Uint8Array(group.reduce((sum, sample) => sum + (sample.size ?? 2), 0)),
    );
    parts.push(moof, mdat);
    position += moof.length + mdat.length;
    dts += group.reduce((sum, sample) => sum + sample.duration, 0);
  });
  if (options.orphanMdat) parts.push(box('mdat', new Uint8Array(1)));
  if (options.trailingMetadata) parts.push(new Uint8Array([0]));
  return new Blob(parts.map((part) => new Uint8Array(part).buffer));
}

describe('bounded native fragment presentation proof', () => {
  it('changes only the non-final fragment max-PTS semantic duration', async () => {
    const proof = (await inspectFragmentPresentationTimeline(fixture()))!;
    expect(proof.trackId).toBe(1);
    expect(proof.samples).toHaveLength(6);
    expect(proof.fragmentCount).toBe(2);
    expect([...proof.tailOverrides]).toEqual([[1, 9]]);
    expect(proof.samples[1]).toMatchObject({
      index: 1,
      timestampTicks: 31,
      decodeTimestampTicks: 10,
      durationTicks: 10,
      size: 2,
    });
    expect(proof.finalPresentation).toEqual({ index: 4, timestampTicks: 60, durationTicks: 10 });
    expect(proof.minTimestampTicks).toBe(10);
    expect(proof.maxTimestampTicks).toBe(60);
    expect(proof.samples[1]!.sequenceNumber - proof.samples[0]!.sequenceNumber).toBe(1);
    expect(proof.samples[1]!.dataOffset - proof.samples[0]!.dataOffset).toBe(2);
  });
  it.each([{ trexDefaults: true }, { absoluteBase: true }, { implicitBase: true }])(
    'resolves standard defaults/base modes %j',
    async (options) => {
      expect([
        ...(await inspectFragmentPresentationTimeline(fixture(options)))!.tailOverrides,
      ]).toEqual([[1, 9]]);
    },
  );
  it('returns null for non-ISO or nonfragmented data', async () => {
    expect(await inspectFragmentPresentationTimeline(new Blob(['not mp4']))).toBeNull();
    expect(
      await inspectFragmentPresentationTimeline(
        new Blob([new Uint8Array(box('ftyp', u32(0, 0))).buffer]),
      ),
    ).toBeNull();
  });
  it.each([
    { secondDecodeShift: 1 },
    { secondDecodeShift: -1 },
    { timescale: 0 },
    { dataOffsetShift: -8 },
    { dataOffsetShift: 1 },
    { declaredSizeShift: 1 },
    { descriptionIndex: 2 },
    { duplicateDescription: true },
    { sampleEntry: 'unknown' },
    { trunVersion: 2 },
    { trunFlagsExtra: 0x10 },
    { countExtra: 1 },
    { orphanMdat: true },
    { duplicateRun: true },
    { trailingMetadata: true },
    { countExtra: 1_000_000 },
    { decodeStart: Number.MAX_SAFE_INTEGER - 5 },
    {
      samples: [
        [
          { duration: 10, cts: 10 },
          { duration: 10, cts: 0 },
        ],
      ],
    },
    { samples: [[{ duration: 10, cts: 40 }], [{ duration: 10, cts: 0 }]] },
    { samples: [[{ duration: 0, cts: 0 }]] },
  ])('rejects unsafe or ambiguous structures %j', async (options) => {
    await expect(inspectFragmentPresentationTimeline(fixture(options))).rejects.toMatchObject({
      detail: { code: 'TIMELINE_MISMATCH' },
    });
  });
  it('honors pre-cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectFragmentPresentationTimeline(fixture(), controller.signal),
    ).rejects.toBeDefined();
  });
  it('retains signed composition offsets without clipping negative raw PTS', async () => {
    const proof = (await inspectFragmentPresentationTimeline(
      fixture({ samples: [[{ duration: 10, cts: -2 }], [{ duration: 10, cts: -2 }]] }),
    ))!;
    expect(proof.minTimestampTicks).toBe(-2);
    expect([...proof.tailOverrides]).toEqual([[0, 10]]);
  });
  it('retains version-0 unsigned composition offsets', async () => {
    const proof = (await inspectFragmentPresentationTimeline(
      fixture({
        trunVersion: 0,
        samples: [[{ duration: 10, cts: 0x80000000 }], [{ duration: 10, cts: 0x80000000 }]],
      }),
    ))!;
    expect(proof.minTimestampTicks).toBe(0x80000000);
  });
  it('refuses an oversized child before reading its claimed payload', async () => {
    const bytes = new Uint8Array(await fixture().arrayBuffer());
    const marker = new TextEncoder().encode('trun');
    let at = -1;
    for (let index = 4; index + 4 <= bytes.length; index++) {
      if (marker.every((value, n) => bytes[index + n] === value)) {
        at = index;
        break;
      }
    }
    expect(at).toBeGreaterThan(0);
    new DataView(bytes.buffer).setUint32(at - 4, 32 * 1024 * 1024 + 8);
    await expect(
      inspectFragmentPresentationTimeline(new Blob([bytes.buffer])),
    ).rejects.toMatchObject({ detail: { code: 'TIMELINE_MISMATCH' } });
  });
  it('enforces its actual total metadata budget before allocating the large payload', async () => {
    const source = fixture({ hdlrPadding: FRAGMENT_TIMELINE_LIMITS.metadataBytes });
    const slice = vi.spyOn(source, 'slice');
    await expect(inspectFragmentPresentationTimeline(source)).rejects.toMatchObject({
      detail: { code: 'TIMELINE_MISMATCH' },
    });
    expect(
      slice.mock.calls.every(
        ([start = 0, end = source.size]) => end - start < FRAGMENT_TIMELINE_LIMITS.metadataBytes,
      ),
    ).toBe(true);
  });
  it('never reads encoded sample payloads while proving their exact mdat coverage', async () => {
    const source = fixture();
    const slice = vi.spyOn(source, 'slice');
    const proof = (await inspectFragmentPresentationTimeline(source))!;
    for (const sample of proof.samples) {
      expect(
        slice.mock.calls.every(
          ([start = 0, end = source.size]) =>
            end <= sample.dataOffset || start >= sample.dataOffset + sample.size,
        ),
      ).toBe(true);
    }
  });
  it('checks cancellation again after an asynchronous metadata read', async () => {
    const source = fixture(),
      controller = new AbortController();
    const original = source.slice.bind(source);
    vi.spyOn(source, 'slice').mockImplementation((start, end, type) => {
      const part = original(start, end, type);
      const originalBuffer = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => {
        const bytes = await originalBuffer();
        controller.abort();
        return bytes;
      };
      return part;
    });
    await expect(
      inspectFragmentPresentationTimeline(source, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
