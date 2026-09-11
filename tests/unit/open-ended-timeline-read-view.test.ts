import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { prepareTimelineReadView } from '../../src/modules/merge/timeline-read-view';
import { comparePacketContent } from '../../src/modules/merge/executor';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

type Kind = 'video' | 'audio';
interface Box {
  type: string;
  start: number;
  size: number;
  path: string;
}
interface Scenario {
  label: string;
  kind: Kind;
  clock: number;
  empty: number;
  mediaTime: number;
  shift: number;
}

// These reproduce the reported edit arithmetic, not the user's actual media or
// decoded HDR/DV appearance. Packets and fragment tables are written by Mediabunny.
const scenarios: Scenario[] = [
  { label: 'HDR net-zero edit', kind: 'video', clock: 16000, empty: 67, mediaTime: 1072, shift: 0 },
  {
    label: 'DV minus 0.100125 s edit',
    kind: 'video',
    clock: 16000,
    empty: 0,
    mediaTime: 1602,
    shift: -0.100125,
  },
  {
    label: 'leading-empty plus nonzero media edit',
    kind: 'video',
    clock: 16000,
    empty: 67,
    mediaTime: 2674,
    shift: -0.100125,
  },
  {
    label: 'AAC rounded movie-to-media clock edit',
    kind: 'audio',
    clock: 44100,
    empty: 11,
    mediaTime: 1024,
    shift: (485 - 1024) / 44100,
  },
];

function boxes(bytes: Uint8Array, start = 0, end = bytes.length, parent = ''): Box[] {
  const result: Box[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) throw new Error('Malformed generated test box.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const path = `${parent}/${type}`;
    result.push({ type, start: offset, size, path });
    if (['moov', 'trak', 'mdia', 'edts', 'udta'].includes(type)) {
      result.push(...boxes(bytes, offset + 8, offset + size, path));
    }
    offset += size;
  }
  return result;
}

function writeType(bytes: Uint8Array, offset: number, type: string) {
  bytes.set(new TextEncoder().encode(type), offset);
}

async function createFixture(scenario: Scenario, editVersion: 0 | 1): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({
    target,
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.07 }),
  });
  if (scenario.kind === 'video') {
    const source = new EncodedVideoPacketSource('hevc');
    output.addVideoTrack(source, {
      frameRate: scenario.clock,
      name: 'reserved-timeline-metadata-'.repeat(8),
    });
    await output.start();
    const decodeOrder = [0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10];
    for (let index = 0; index < decodeOrder.length; index++) {
      const key = index % 4 === 0;
      await source.add(
        new EncodedPacket(
          new Uint8Array([0, 0, 0, 4, key ? 0x26 : 0x02, 0x01, 0x80, index]),
          key ? 'key' : 'delta',
          // 25 fps is exactly representable in the 16000-Hz test clock. Avoid
          // injecting the writer's unrelated one-tick cross-fragment DTS gap.
          0.5 + decodeOrder[index]! / 25,
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
  } else {
    const source = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(source, { name: 'reserved-timeline-metadata-'.repeat(8) });
    await output.start();
    for (let index = 0; index < 24; index++) {
      await source.add(
        new EncodedPacket(
          new Uint8Array([0x21, 0x11, 0x45, 0, 0x14, 0x50, 0x01, 0x47]),
          'key',
          0.5 + (index * 1024) / scenario.clock,
          (index === 23 ? 480 : 1024) / scenario.clock,
        ),
        {
          decoderConfig: {
            codec: 'mp4a.40.2',
            sampleRate: scenario.clock,
            numberOfChannels: 2,
            description: new Uint8Array([0x12, 0x10]),
          },
        },
      );
    }
  }
  await output.finalize();
  const generated = new Uint8Array(target.buffer!);
  const records = boxes(generated);
  expect(records.filter((box) => box.type === 'moof').length).toBeGreaterThan(1);
  const reserved = records.find((box) => box.path === '/moov/trak/udta');
  const mvhd = records.find((box) => box.path === '/moov/mvhd');
  if (!reserved || !mvhd) throw new Error('Expected reserved metadata and movie header.');
  const data = new Uint8Array(generated);
  const view = new DataView(data.buffer);
  // Equal-length replacement preserves every fragment/mdat address, including mfra.
  const entrySize = editVersion ? 20 : 12;
  const edits =
    scenario.empty > 0
      ? [
          { duration: scenario.empty, mediaTime: -1 },
          { duration: 1000, mediaTime: scenario.mediaTime },
        ]
      : [{ duration: 1000, mediaTime: scenario.mediaTime }];
  const elstSize = 16 + edits.length * entrySize;
  const freeSize = reserved.size - 8 - elstSize;
  expect(freeSize).toBeGreaterThanOrEqual(8);
  data.fill(0, reserved.start, reserved.start + reserved.size);
  view.setUint32(reserved.start, reserved.size);
  writeType(data, reserved.start + 4, 'edts');
  const elst = reserved.start + 8;
  view.setUint32(elst, elstSize);
  writeType(data, elst + 4, 'elst');
  data[elst + 8] = editVersion;
  view.setUint32(elst + 12, edits.length);
  for (let index = 0; index < edits.length; index++) {
    const offset = elst + 16 + index * entrySize;
    const { duration, mediaTime } = edits[index]!;
    if (editVersion) {
      view.setBigUint64(offset, BigInt(duration));
      view.setBigInt64(offset + 8, BigInt(mediaTime));
    } else {
      view.setUint32(offset, duration);
      view.setInt32(offset + 4, mediaTime);
    }
    view.setInt32(offset + entrySize - 4, 65536);
  }
  const free = elst + elstSize;
  view.setUint32(free, freeSize);
  writeType(data, free + 4, 'free');
  view.setUint32(mvhd.start + 8 + (data[mvhd.start + 8] ? 20 : 12), 1000);
  // Turn only the terminal media edit into a legal open-ended entry.
  const terminalDuration = elst + 16 + (edits.length - 1) * entrySize;
  if (editVersion) view.setBigUint64(terminalDuration, 0n);
  else view.setUint32(terminalDuration, 0);
  expect(data.length).toBe(generated.length);
  for (const box of records.filter((item) => item.type === 'mdat')) {
    expect(data.slice(box.start, box.start + box.size)).toEqual(
      generated.slice(box.start, box.start + box.size),
    );
  }
  return new Blob([data.buffer], { type: scenario.kind === 'video' ? 'video/mp4' : 'audio/mp4' });
}

async function readPackets(blob: Blob, kind: Kind) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track =
      kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
    if (!track) throw new Error('Missing generated track.');
    const packets: EncodedPacket[] = [];
    for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
    return {
      packets,
      clock: await track.getTimeResolution(),
      first: await track.getFirstTimestamp(),
      metadataEnd: await track.getDurationFromMetadata(),
      computedEnd: await track.computeDuration(),
      decoderConfig: await track.getDecoderConfig(),
    };
  } finally {
    input.dispose();
  }
}

async function correctedOutput(
  blob: Blob,
  kind: Kind,
  shift: number,
  origin: number,
): Promise<Blob> {
  const raw = await readPackets(blob, kind);
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const source =
    kind === 'video' ? new EncodedVideoPacketSource('hevc') : new EncodedAudioPacketSource('aac');
  if (source instanceof EncodedVideoPacketSource)
    output.addVideoTrack(source, { frameRate: raw.clock });
  else output.addAudioTrack(source);
  await output.start();
  for (const packet of raw.packets) {
    const changed = packet.clone({ timestamp: packet.timestamp + shift - origin });
    if (source instanceof EncodedVideoPacketSource)
      await source.add(changed, { decoderConfig: raw.decoderConfig as VideoDecoderConfig });
    else await source.add(changed, { decoderConfig: raw.decoderConfig as AudioDecoderConfig });
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: kind === 'video' ? 'video/mp4' : 'audio/mp4' });
}

describe('open-ended timeline private read view', () => {
  for (const scenario of scenarios) {
    it.each([0, 1] as const)(
      `preserves every packet and applies ${scenario.label} once (elst v%i)`,
      async (version) => {
        const original = await createFixture(scenario, version);
        const before = new Uint8Array(await original.arrayBuffer());
        const raw = await readPackets(original, scenario.kind);
        expect(raw.packets).toHaveLength(scenario.kind === 'video' ? 12 : 24);
        if (scenario.kind === 'video') {
          expect(
            raw.packets.some(
              (packet, index) => index > 0 && packet.timestamp < raw.packets[index - 1]!.timestamp,
            ),
          ).toBe(true);
        }
        const view = await prepareTimelineReadView(original, scenario.kind);
        const corrected = await readPackets(view, scenario.kind);
        const integerShift =
          (Math.round((scenario.empty * scenario.clock) / 1000) - scenario.mediaTime) /
          scenario.clock;
        expect(integerShift).toBe(scenario.shift);
        expect(view.size).toBe(original.size);
        expect(corrected.clock).toBe(scenario.clock);
        expect(corrected.packets).toHaveLength(raw.packets.length);
        raw.packets.forEach((packet, index) => {
          const actual = corrected.packets[index]!;
          expect(actual.timestamp).toBeCloseTo(packet.timestamp + integerShift, 12);
          expect(actual.duration).toBe(packet.duration);
          expect(actual.type).toBe(packet.type);
          expect(actual.data).toEqual(packet.data);
        });
        expect(corrected.first).toBeCloseTo(raw.first + integerShift, 12);
        expect(corrected.computedEnd).toBeCloseTo(raw.computedEnd + integerShift, 12);
        if (raw.metadataEnd == null) expect(corrected.metadataEnd).toBeNull();
        else expect(corrected.metadataEnd).toBeCloseTo(raw.metadataEnd + integerShift, 12);
        expect(await prepareTimelineReadView(view, scenario.kind)).toBe(view);
        expect(new Uint8Array(await original.arrayBuffer())).toEqual(before);
        const after = new Uint8Array(await view.arrayBuffer());
        for (const box of boxes(before).filter((item) => item.type === 'mdat')) {
          expect(after.slice(box.start, box.start + box.size)).toEqual(
            before.slice(box.start, box.start + box.size),
          );
        }
        const origin = 0.25; // Same externally chosen nonzero origin, never a per-track rebase.
        const output = await correctedOutput(original, scenario.kind, integerShift, origin);
        expect(await comparePacketContent(original, output, scenario.kind, origin)).toMatchObject({
          equivalent: true,
          sourcePacketCount: raw.packets.length,
          outputPacketCount: raw.packets.length,
        });
      },
    );
  }

  it.each(scenarios.filter((scenario) => scenario.shift !== 0))(
    'rejects missing and duplicated offsets for $label',
    async (scenario) => {
      const source = await createFixture(scenario, 0);
      for (const shift of [0, scenario.shift * 2]) {
        const output = await correctedOutput(source, scenario.kind, shift, 0.25);
        expect(await comparePacketContent(source, output, scenario.kind, 0.25)).toMatchObject({
          equivalent: false,
          mismatch: 'timeline',
          timeline: { track: scenario.kind, mismatch: 'timestamp' },
        });
      }
    },
  );

  it('honors pre-abort and cancellation during its packet-metadata proof without changing source bytes', async () => {
    const source = await createFixture(scenarios[1]!, 0);
    const before = new Uint8Array(await source.arrayBuffer());
    const pre = new AbortController();
    pre.abort();
    await expect(
      prepareTimelineReadView(source, 'video', { signal: pre.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    await expect(
      prepareTimelineReadView(source, 'video', {
        signal: during.signal,
        onProgress: () => during.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(before);
  });
});
