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
import { comparePacketContent } from '../../src/modules/merge/executor';
import { MergeError } from '../../src/modules/merge/errors';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

// Container/packet-copy fixtures, not a decodable film or proof of HDR appearance.
// The independent box reader below does not call production timeline helpers.
const CLOCK = 16_000;
const CTS_CHANGE = 16; // 1 ms, well above the existing 2-output-tick duration bound.
const ORDER = [0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10];
interface Box {
  type: string;
  start: number;
  end: number;
}
interface NativeSample {
  index: number;
  fragment: number;
  trackId: number;
  description: number;
  dts: number;
  pts: number;
  duration: number;
  size: number;
  payload: number;
  durationOffset: number;
  ctsOffset: number;
  signedCts: boolean;
}
interface NativeFragment {
  start: number;
  end: number;
  samples: NativeSample[];
}

function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error('Truncated fixture box.');
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) throw new Error('Invalid fixture box size.');
    found.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      start: offset,
      end: offset + size,
    });
    offset += size;
  }
  return found;
}

function one(children: Box[], type: string): Box {
  const matches = children.filter((box) => box.type === type);
  if (matches.length !== 1) throw new Error(`Expected exactly one fixture ${type}.`);
  return matches[0]!;
}

function nativeFragments(bytes: Uint8Array): NativeFragment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(bytes);
  let sampleIndex = 0;
  return top
    .filter((box) => box.type === 'moof')
    .map((moof, fragment) => {
      const traf = one(boxes(bytes, moof.start + 8, moof.end), 'traf');
      const children = boxes(bytes, traf.start + 8, traf.end);
      const tfhd = one(children, 'tfhd');
      const flags = view.getUint32(tfhd.start + 8) & 0xffffff;
      const trackId = view.getUint32(tfhd.start + 12);
      let pos = tfhd.start + 16;
      let base = moof.start;
      if (flags & 1) {
        base = Number(view.getBigUint64(pos));
        pos += 8;
      }
      const description = flags & 2 ? view.getUint32(pos) : 1;
      if (flags & 2) pos += 4;
      const defaultDurationOffset = flags & 8 ? pos : -1;
      const defaultDuration = flags & 8 ? view.getUint32(pos) : 0;
      if (flags & 8) pos += 4;
      const defaultSize = flags & 16 ? view.getUint32(pos) : 0;
      if (flags & 16) pos += 4;
      if (flags & 32) pos += 4;
      if (pos !== tfhd.end) throw new Error('Unexpected fixture tfhd fields.');
      const tfdt = one(children, 'tfdt');
      let dts =
        bytes[tfdt.start + 8] === 1
          ? Number(view.getBigUint64(tfdt.start + 12))
          : view.getUint32(tfdt.start + 12);
      const fragmentStart = dts;
      const trun = one(children, 'trun');
      const runFlags = view.getUint32(trun.start + 8) & 0xffffff;
      const signedCts = bytes[trun.start + 8] === 1;
      const count = view.getUint32(trun.start + 12);
      pos = trun.start + 16;
      if (!(runFlags & 1)) throw new Error('Fixture must specify a trun data offset.');
      let payload = base + view.getInt32(pos);
      pos += 4;
      if (runFlags & 4) pos += 4;
      const samples: NativeSample[] = [];
      for (let index = 0; index < count; index++) {
        const durationOffset = runFlags & 0x100 ? pos : defaultDurationOffset;
        const duration = runFlags & 0x100 ? view.getUint32(pos) : defaultDuration;
        if (runFlags & 0x100) pos += 4;
        const size = runFlags & 0x200 ? view.getUint32(pos) : defaultSize;
        if (runFlags & 0x200) pos += 4;
        if (runFlags & 0x400) pos += 4;
        const ctsOffset = runFlags & 0x800 ? pos : -1;
        const cts = ctsOffset < 0 ? 0 : signedCts ? view.getInt32(pos) : view.getUint32(pos);
        if (runFlags & 0x800) pos += 4;
        if (
          !top.some(
            (box) => box.type === 'mdat' && payload >= box.start + 8 && payload + size <= box.end,
          )
        )
          throw new Error('Fixture payload outside mdat.');
        samples.push({
          index: sampleIndex++,
          fragment,
          trackId,
          description,
          dts,
          pts: dts + cts,
          duration,
          size,
          payload,
          durationOffset,
          ctsOffset,
          signedCts,
        });
        dts += duration;
        payload += size;
      }
      if (pos !== trun.end) throw new Error('Unexpected fixture trun fields.');
      return { start: fragmentStart, end: dts, samples };
    });
}

function setPts(bytes: Uint8Array, sample: NativeSample, pts: number) {
  if (sample.ctsOffset < 0) throw new Error('Fixture must carry composition offsets.');
  const cts = pts - sample.dts;
  if (!sample.signedCts && cts < 0) throw new Error('Cannot write negative unsigned fixture CTS.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sample.signedCts) view.setInt32(sample.ctsOffset, cts);
  else view.setUint32(sample.ctsOffset, cts);
}

function maximumPts(fragment: NativeFragment) {
  return fragment.samples.reduce((maximum, sample) =>
    sample.pts > maximum.pts ? sample : maximum,
  );
}

async function makeSource(): Promise<{ original: Uint8Array; modified: Uint8Array }> {
  const target = new BufferTarget();
  const writer = new Output({
    target,
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.07 }),
  });
  const source = new EncodedVideoPacketSource('hevc');
  writer.addVideoTrack(source, { frameRate: CLOCK });
  await writer.start();
  for (let index = 0; index < ORDER.length; index++) {
    const key = index % 4 === 0;
    await source.add(
      new EncodedPacket(
        new Uint8Array([0, 0, 0, 4, key ? 0x26 : 0x02, 0x01, 0x80, index]),
        key ? 'key' : 'delta',
        0.5 + ORDER[index]! / 25,
        1 / 25,
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
  await writer.finalize();
  const original = new Uint8Array(target.buffer!);
  const modified = new Uint8Array(original);
  const fragments = nativeFragments(modified);
  expect(fragments).toHaveLength(3);
  expect(fragments.map((fragment) => fragment.samples.length)).toEqual([4, 4, 4]);
  const lastPresentation = maximumPts(fragments[0]!);
  expect(lastPresentation.index).toBe(1); // Not the final sample in decode order.
  setPts(modified, lastPresentation, lastPresentation.pts + CTS_CHANGE);
  return { original, modified };
}

function blob(bytes: Uint8Array) {
  return new Blob([new Uint8Array(bytes).buffer], { type: 'video/mp4' });
}

async function readPackets(file: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('Fixture has no video.');
    const packets: EncodedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
    return {
      packets,
      clock: await track.getTimeResolution(),
      config: await track.getDecoderConfig(),
    };
  } finally {
    input.dispose();
  }
}

async function nonFragmentedOutput(
  source: Blob,
  mutate?: (packet: EncodedPacket, index: number) => EncodedPacket,
) {
  const read = await readPackets(source);
  const target = new BufferTarget();
  const writer = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const sink = new EncodedVideoPacketSource('hevc');
  writer.addVideoTrack(sink, { frameRate: read.clock });
  await writer.start();
  for (const [index, packet] of read.packets.entries())
    await sink.add(mutate?.(packet, index) ?? packet, { decoderConfig: read.config! });
  await writer.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

async function expectRejected(source: Blob, output: Blob) {
  // A specific production native-proof rejection is also a refusal. Never
  // turn arbitrary runtime/fixture exceptions into a passing negative case.
  try {
    const result = await comparePacketContent(source, output, 'video', 0);
    expect(result.equivalent).toBe(false);
  } catch (error) {
    if (!(error instanceof MergeError)) throw error;
    expect(error.detail).toMatchObject({
      code: 'TIMELINE_MISMATCH',
      reason: 'PACKET_TIMELINE_MISMATCH',
    });
  }
}

async function shiftRegularCts(output: Blob, packetIndex: number, delta: number): Promise<Blob> {
  const bytes = new Uint8Array(await output.arrayBuffer());
  let children = boxes(bytes);
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl']) {
    const child = one(children, type);
    children = boxes(bytes, child.start + 8, child.end);
  }
  const ctts = one(children, 'ctts');
  const view = new DataView(bytes.buffer);
  const entries = view.getUint32(ctts.start + 12);
  let sample = 0;
  for (let index = 0; index < entries; index++) {
    const offset = ctts.start + 16 + index * 8;
    const count = view.getUint32(offset);
    if (packetIndex >= sample && packetIndex < sample + count) {
      if (count !== 1) throw new Error('Target fixture CTTS entry must be a single sample.');
      if (bytes[ctts.start + 8] === 1) view.setInt32(offset + 4, view.getInt32(offset + 4) + delta);
      else view.setUint32(offset + 4, view.getUint32(offset + 4) + delta);
      return blob(bytes);
    }
    sample += count;
  }
  throw new Error('Fixture CTTS target not found.');
}

async function extendFinalPresentationDuration(output: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await output.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const top = boxes(bytes);
  // mdat precedes moov for fastStart:false, so growing tables cannot move payload.
  expect(one(top, 'mdat').end).toBeLessThanOrEqual(one(top, 'moov').start);
  const delta = 160; // 10 ms at the same native 16 kHz clock.
  function rewrite(records: Box[]): Uint8Array {
    const chunks = records.map((record): Uint8Array => {
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(record.type)) {
        const payload = rewrite(boxes(bytes, record.start + 8, record.end));
        const result = new Uint8Array(8 + payload.length);
        result.set(bytes.subarray(record.start, record.start + 8));
        new DataView(result.buffer).setUint32(0, result.length);
        result.set(payload, 8);
        return result;
      }
      if (record.type !== 'stts' && record.type !== 'ctts')
        return bytes.slice(record.start, record.end);
      const values: number[] = [];
      const entries = view.getUint32(record.start + 12);
      for (let index = 0; index < entries; index++) {
        const position = record.start + 16 + index * 8;
        const count = view.getUint32(position);
        const value =
          record.type === 'ctts' && bytes[record.start + 8] === 1
            ? view.getInt32(position + 4)
            : view.getUint32(position + 4);
        for (let sample = 0; sample < count; sample++) values.push(value);
      }
      expect(values).toHaveLength(ORDER.length);
      const result = new Uint8Array(16 + values.length * 8);
      result.set(bytes.subarray(record.start, record.start + 16));
      const changed = new DataView(result.buffer);
      changed.setUint32(0, result.length);
      changed.setUint32(12, values.length);
      values.forEach((value, index) => {
        changed.setUint32(16 + index * 8, 1);
        const updated =
          record.type === 'stts'
            ? value + (index === 9 ? delta : 0)
            : value - (index > 9 ? delta : 0);
        if (record.type === 'ctts' && bytes[record.start + 8] === 1)
          changed.setInt32(20 + index * 8, updated);
        else {
          expect(updated).toBeGreaterThanOrEqual(0);
          changed.setUint32(20 + index * 8, updated);
        }
      });
      return result;
    });
    const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let position = 0;
    for (const chunk of chunks) {
      result.set(chunk, position);
      position += chunk.length;
    }
    return result;
  }
  return blob(rewrite(top));
}

describe('fragment-native versus global presentation duration', () => {
  it('proves the source is legal B-frame native timing with unchanged decode clocks and payload', async () => {
    const { original, modified } = await makeSource();
    const before = nativeFragments(original);
    const after = nativeFragments(modified);
    const beforeSamples = before.flatMap((fragment) => fragment.samples);
    const samples = after.flatMap((fragment) => fragment.samples);
    expect(samples.map((sample) => sample.pts)).not.toEqual(
      [...samples.map((sample) => sample.pts)].sort((a, b) => a - b),
    );
    expect(new Set(samples.map((sample) => sample.pts)).size).toBe(ORDER.length);
    expect(new Set(samples.map((sample) => `${sample.trackId}:${sample.description}`)).size).toBe(
      1,
    );
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      const previous = beforeSamples[index]!;
      expect(sample.duration).toBeGreaterThan(0);
      expect(sample.duration).toBe(previous.duration);
      expect(sample.dts).toBe(previous.dts);
      expect(sample.pts - previous.pts).toBe(index === 1 ? CTS_CHANGE : 0);
      expect(modified.slice(sample.payload, sample.payload + sample.size)).toEqual(
        original.slice(previous.payload, previous.payload + previous.size),
      );
      if (index > 0)
        expect(sample.dts).toBe(samples[index - 1]!.dts + samples[index - 1]!.duration);
    }
    after.slice(1).forEach((fragment, index) => {
      expect(fragment.start).toBe(after[index]!.end);
      expect(Math.min(...fragment.samples.map((sample) => sample.pts))).toBeGreaterThan(
        maximumPts(after[index]!).pts,
      );
    });
    const source = await readPackets(blob(modified));
    const output = await readPackets(await nonFragmentedOutput(blob(modified)));
    expect(source.clock).toBe(CLOCK);
    source.packets.forEach((packet, index) => {
      expect(output.packets[index]!.timestamp).toBeCloseTo(packet.timestamp, 12);
      expect(output.packets[index]!.data).toEqual(packet.data);
      expect(output.packets[index]!.type).toBe(packet.type);
    });
    expect(source.packets[1]!.duration - output.packets[1]!.duration).toBeCloseTo(
      CTS_CHANGE / CLOCK,
      8,
    );
  });

  it('accepts equal packet content and all PTS despite the nonterminal fragment tail duration semantic difference', async () => {
    const { modified } = await makeSource();
    const source = blob(modified);
    expect(
      await comparePacketContent(source, await nonFragmentedOutput(source), 'video', 0),
    ).toMatchObject({ equivalent: true, sourcePacketCount: 12, outputPacketCount: 12 });
  });

  it.each(['pts', 'payload', 'last-presentation-duration'] as const)(
    'still refuses output %s mutation',
    async (change) => {
      const { modified } = await makeSource();
      const source = blob(modified);
      let output = await nonFragmentedOutput(source, (packet, index) => {
        if (change === 'pts' && index === 5)
          return packet.clone({ timestamp: packet.timestamp + 0.005 });
        if (change === 'payload' && index === 5) {
          const bytes = new Uint8Array(packet.data);
          bytes[7] = 99;
          return packet.clone({ data: bytes });
        }
        return packet;
      });
      if (change === 'last-presentation-duration')
        output = await extendFinalPresentationDuration(output);
      const read = await readPackets(output);
      const sourceRead = await readPackets(source);
      if (change === 'last-presentation-duration')
        expect(read.packets[9]!.duration - sourceRead.packets[9]!.duration).toBeCloseTo(0.01, 8);
      if (change === 'last-presentation-duration')
        expect(read.packets.map((packet) => packet.timestamp)).toEqual(
          sourceRead.packets.map((packet) => packet.timestamp),
        );
      if (change === 'pts')
        expect(read.packets[5]!.timestamp - sourceRead.packets[5]!.timestamp).toBeCloseTo(0.005, 8);
      if (change === 'payload')
        expect(read.packets[5]!.data).not.toEqual(sourceRead.packets[5]!.data);
      await expectRejected(source, output);
    },
  );

  it.each([
    'zero-duration',
    'decode-discontinuity',
    'duplicate-pts',
    'interleaved-fragments',
  ] as const)('does not apply the correction to %s', async (change) => {
    const { modified } = await makeSource();
    const fragments = nativeFragments(modified);
    const first = fragments[0]!;
    const view = new DataView(modified.buffer);
    let interleavedOutput: Blob | undefined;
    if (change === 'zero-duration' || change === 'decode-discontinuity') {
      const sample = first.samples.at(-1)!;
      expect(sample.durationOffset).toBeGreaterThan(0);
      view.setUint32(
        sample.durationOffset,
        change === 'zero-duration' ? 0 : sample.duration + CTS_CHANGE,
      );
      // Uniform writer output uses tfhd default_sample_duration. Changing that
      // native field affects every sample in this fragment, and is still an
      // invalid source: next tfdt is deliberately not patched to hide the gap.
      expect(nativeFragments(modified)[0]!.end).not.toBe(fragments[1]!.start);
    } else if (change === 'duplicate-pts') {
      setPts(modified, first.samples[2]!, first.samples[0]!.pts);
      expect(
        new Set(
          nativeFragments(modified).flatMap((fragment) =>
            fragment.samples.map((sample) => sample.pts),
          ),
        ).size,
      ).toBeLessThan(ORDER.length);
    } else {
      const regular = await nonFragmentedOutput(blob(modified));
      const targetPts = fragments[1]!.samples[0]!.pts + CTS_CHANGE;
      interleavedOutput = await shiftRegularCts(
        regular,
        maximumPts(first).index,
        targetPts - maximumPts(first).pts,
      );
      setPts(modified, maximumPts(first), targetPts);
      expect(maximumPts(nativeFragments(modified)[0]!).pts).toBeGreaterThan(
        fragments[1]!.samples[0]!.pts,
      );
    }
    const source = blob(modified);
    const output = interleavedOutput ?? (await nonFragmentedOutput(source));
    if (change === 'interleaved-fragments') {
      expect((await readPackets(output)).packets.map((packet) => packet.timestamp)).toEqual(
        (await readPackets(source)).packets.map((packet) => packet.timestamp),
      );
    }
    await expectRejected(source, output);
  });
});
