import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import {
  restoreFinalPresentationDuration,
  type ExpectedFinalPresentationDuration,
} from '../../src/modules/merge/final-presentation-duration';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

const expected: ExpectedFinalPresentationDuration = {
  sampleIndex: 1,
  sampleCount: 3,
  timescale: 16000,
  durationTicks: 320,
  timestampSeconds: 0.066,
};

async function fixture(
  options: {
    fragmented?: boolean;
    ordered?: boolean;
    duplicate?: boolean;
    extraVideo?: boolean;
    start?: number;
  } = {},
) {
  const target = new BufferTarget();
  const output = new Output({
    target,
    format: new Mp4OutputFormat({ fastStart: options.fragmented ? 'fragmented' : false }),
  });
  const sources = [new EncodedVideoPacketSource('hevc')];
  if (options.extraVideo) sources.push(new EncodedVideoPacketSource('hevc'));
  for (const source of sources) output.addVideoTrack(source, { frameRate: 57600 });
  await output.start();
  const times = options.ordered ? [0, 0.032, 0.066] : [0, 0.066, options.duplicate ? 0.066 : 0.033];
  for (const source of sources) {
    for (let i = 0; i < times.length; i++) {
      await source.add(
        new EncodedPacket(
          new Uint8Array([0, 0, 0, 4, i ? 0x02 : 0x26, 1, 0x80, i]),
          i ? 'delta' : 'key',
          times[i]! + (options.start ?? 0),
          options.ordered ? 0.033 : i === 1 ? 0.02 : 0.034,
        ),
        {
          decoderConfig: {
            codec: 'hev1.2.4.L120.90',
            codedWidth: 16,
            codedHeight: 16,
            description: makeHevcConfiguration(),
          },
        },
      );
    }
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

async function packets(blob: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const result: EncodedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) result.push(packet);
    return result;
  } finally {
    input.dispose();
  }
}

type Box = { type: string; start: number; end: number };
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    const size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > end) throw new Error('Invalid fixture box');
    result.push({ type, start: offset, end: offset + size });
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'].includes(type))
      result.push(...boxes(bytes, offset + 8, offset + size));
    offset += size;
  }
  return result;
}

async function mutate(blob: Blob, type: string, change: (bytes: Uint8Array, box: Box) => void) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const box = boxes(data).find((item) => item.type === type)!;
  change(data, box);
  return new Blob([data.buffer], { type: blob.type });
}

describe('strict final presentation duration restoration', () => {
  it('repairs a non-final decode sample while keeping every PTS, packet and original byte unchanged', async () => {
    const original = await fixture();
    const before = new Uint8Array(await original.arrayBuffer());
    const prior = await packets(original);
    expect(prior[1]!.duration).not.toBeCloseTo(0.02, 4);
    const restored = await restoreFinalPresentationDuration(original, expected);
    const after = await packets(restored);
    expect(after).toHaveLength(3);
    for (let i = 0; i < after.length; i++) {
      expect(after[i]!.timestamp).toBe(prior[i]!.timestamp);
      expect(after[i]!.type).toBe(prior[i]!.type);
      expect(after[i]!.data).toEqual(prior[i]!.data);
    }
    expect(after[1]!.duration).toBe(Math.round(0.02 * 57600) / 57600);
    expect(after[0]!.duration).toBe(prior[0]!.duration);
    expect(after[2]!.duration).toBe(prior[2]!.duration);
    const rewritten = new Uint8Array(await restored.arrayBuffer());
    const moov = boxes(before).find((box) => box.type === 'moov')!;
    expect(rewritten.slice(0, moov.start)).toEqual(before.slice(0, moov.start));
    for (const type of ['stsd', 'stsz', 'stco', 'mdhd', 'tkhd', 'mvhd']) {
      const sourceBox = boxes(before).find((box) => box.type === type)!;
      const outputBox = boxes(rewritten).find((box) => box.type === type)!;
      expect(rewritten.slice(outputBox.start, outputBox.end)).toEqual(
        before.slice(sourceBox.start, sourceBox.end),
      );
    }
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(before);
    expect(await restoreFinalPresentationDuration(restored, expected)).toBe(restored);
  });

  it('returns the original Blob for an already correct tail', async () => {
    const original = await fixture({ ordered: true });
    expect(
      await restoreFinalPresentationDuration(original, {
        ...expected,
        sampleIndex: 2,
        durationTicks: 528,
      }),
    ).toBe(original);
  });

  it('repairs a final decode sample without a preexisting CTTS table', async () => {
    const original = await fixture({ ordered: true });
    expect(
      boxes(new Uint8Array(await original.arrayBuffer())).some((box) => box.type === 'ctts'),
    ).toBe(false);
    const changed = await mutate(original, 'stts', (bytes, box) => {
      const view = new DataView(bytes.buffer);
      const rows = view.getUint32(box.start + 12);
      expect(view.getUint32(box.start + 16 + (rows - 1) * 8)).toBe(1);
      view.setUint32(box.start + 20 + (rows - 1) * 8, 4000);
    });
    const restored = await restoreFinalPresentationDuration(changed, {
      ...expected,
      sampleIndex: 2,
      durationTicks: 528,
    });
    const before = await packets(original);
    const after = await packets(restored);
    expect(after.map((packet) => packet.timestamp)).toEqual(
      before.map((packet) => packet.timestamp),
    );
    expect(after.map((packet) => packet.duration)).toEqual(before.map((packet) => packet.duration));
  });

  it('uses the output edit mapping without independently rebasing the video start', async () => {
    const original = await fixture({ start: 0.25 });
    const prior = await packets(original);
    const restored = await restoreFinalPresentationDuration(original, {
      ...expected,
      timestampSeconds: expected.timestampSeconds + 0.25,
    });
    const after = await packets(restored);
    expect(after.map((packet) => packet.timestamp)).toEqual(
      prior.map((packet) => packet.timestamp),
    );
    expect(after[1]!.duration).toBe(0.02);
  });

  it.each([
    { sampleIndex: 2 },
    { sampleCount: 4 },
    { timescale: 0 },
    { durationTicks: 0 },
    { durationTicks: Number.MAX_SAFE_INTEGER },
    { timestampSeconds: 0.07 },
    { timestampSeconds: Number.NaN },
    { sampleCount: 1_000_001 },
  ])('rejects an unproved expected tail %j', async (change) => {
    await expect(
      restoreFinalPresentationDuration(await fixture(), { ...expected, ...change }),
    ).rejects.toMatchObject({ detail: { reason: 'PACKET_TIMELINE_MISMATCH' } });
  });

  it('rejects duplicate maximum PTS, fragmented output and multiple video tracks', async () => {
    for (const options of [{ duplicate: true }, { fragmented: true }, { extraVideo: true }]) {
      await expect(
        restoreFinalPresentationDuration(await fixture(options), expected),
      ).rejects.toMatchObject({ detail: { reason: 'PACKET_TIMELINE_MISMATCH' } });
    }
  });

  it.each(['mdhd', 'tkhd'])('refuses to rewrite a mismatching %s duration header', async (type) => {
    const malformed = await mutate(await fixture(), type, (bytes, box) => {
      const offset = type === 'mdhd' ? 16 : 20;
      new DataView(bytes.buffer).setUint32(box.start + 8 + offset, 1);
    });
    await expect(restoreFinalPresentationDuration(malformed, expected)).rejects.toMatchObject({
      detail: { reason: 'PACKET_TIMELINE_MISMATCH' },
    });
  });

  it('rejects zero native decode duration and inconsistent sample count before patching', async () => {
    const original = await fixture();
    const zero = await mutate(original, 'stts', (bytes, box) =>
      new DataView(bytes.buffer).setUint32(box.start + 20, 0),
    );
    await expect(restoreFinalPresentationDuration(zero, expected)).rejects.toMatchObject({
      detail: { reason: 'PACKET_TIMELINE_MISMATCH' },
    });
    const count = await mutate(original, 'stsz', (bytes, box) =>
      new DataView(bytes.buffer).setUint32(box.start + 16, 2),
    );
    await expect(restoreFinalPresentationDuration(count, expected)).rejects.toMatchObject({
      detail: { reason: 'PACKET_TIMELINE_MISMATCH' },
    });
  });

  it('honors pre-abort and in-flight cancellation without modifying the source', async () => {
    const original = await fixture();
    const before = new Uint8Array(await original.arrayBuffer());
    const pre = new AbortController();
    pre.abort();
    await expect(
      restoreFinalPresentationDuration(original, expected, pre.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    const pending = restoreFinalPresentationDuration(original, expected, during.signal);
    setTimeout(() => during.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(before);
  });
});
