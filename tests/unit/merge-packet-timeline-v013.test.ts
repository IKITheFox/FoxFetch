import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  type StreamTargetChunk,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { comparePacketContent, remuxStagedBlobsToFile } from '../../src/modules/merge/executor';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableLike,
} from '../../src/modules/merge/types';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

type Timing = { pts: number; duration: number; key?: boolean };

async function videoFile(timings: Timing[], timescale = 57600, hdr = false) {
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const source = new EncodedVideoPacketSource('hevc');
  output.addVideoTrack(source, { frameRate: timescale });
  await output.start();
  const description = new Uint8Array(23);
  description[0] = 1;
  description[1] = 2;
  description[12] = 120;
  description[16] = 0xfd;
  description[17] = description[18] = 0xfa;
  description[21] = 0xff;
  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index]!;
    const key = timing.key ?? index === 0;
    await source.add(
      new EncodedPacket(
        new Uint8Array([0, 0, 0, 4, key ? 0x26 : 0x02, 0x01, 0x80, index]),
        key ? 'key' : 'delta',
        timing.pts,
        timing.duration,
      ),
      {
        decoderConfig: {
          codec: 'hev1.2.4.L120.90',
          codedWidth: 16,
          codedHeight: 16,
          description: hdr ? makeHevcConfiguration() : description,
          ...(hdr
            ? {
                colorSpace: {
                  primaries: 'bt2020',
                  transfer: 'pq',
                  matrix: 'bt2020-ncl',
                  fullRange: false,
                } as unknown as VideoColorSpaceInit,
              }
            : {}),
        },
      },
    );
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

async function audioFile(rate: 44100 | 48000, timings: Timing[]) {
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const source = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(source);
  await output.start();
  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index]!;
    await source.add(
      new EncodedPacket(
        // AAC LC silence from a previously decoded local 48 kHz SDR sample;
        // the 44.1 kHz case verifies container clocks with its own ASC, not decoding.
        new Uint8Array([0x21, 0x11, 0x45, 0x00, 0x14, 0x50, 0x01, 0x47]),
        'key',
        timing.pts,
        timing.duration,
      ),
      {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: rate,
          numberOfChannels: 2,
          description: new Uint8Array(rate === 44100 ? [0x12, 0x10] : [0x11, 0x90]),
        },
      },
    );
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'audio/mp4' });
}

class ChangedAudioTailHandle implements FileSystemFileHandleLike {
  readonly name = 'timing.mp4';
  private bytes = new Uint8Array();
  async createWritable(): Promise<FileSystemWritableLike> {
    return {
      write: async (chunk: StreamTargetChunk) => {
        const end = chunk.position + chunk.data.byteLength;
        if (end > this.bytes.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(this.bytes);
          this.bytes = expanded;
        }
        this.bytes.set(chunk.data, chunk.position);
      },
      close: async () => undefined,
      abort: async () => undefined,
    } as unknown as FileSystemWritableLike;
  }
  async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.bytes);
    const view = new DataView(bytes.buffer);
    const needle = new TextEncoder().encode('stts');
    let last = -1;
    for (let i = 4; i < bytes.length - 16; i++) {
      if (needle.every((value, offset) => bytes[i + offset] === value)) last = i;
    }
    if (last < 0) throw new Error('Expected audio STTS in generated fixture.');
    const count = view.getUint32(last + 8);
    const deltaOffset = last + 16 + (count - 1) * 8;
    if (view.getUint32(deltaOffset) !== 480) throw new Error('Expected shortened AAC tail.');
    view.setUint32(deltaOffset, 1024);
    return new File([bytes.buffer], this.name, { type: 'video/mp4' });
  }
}

describe('v0.13 packet timeline equivalence', () => {
  it('accepts only bounded output tick quantization for fractional video frame times', async () => {
    const timings = Array.from({ length: 12 }, (_, index) => ({
      pts: (index * 1001) / 30000,
      duration: 1001 / 30000,
    }));
    const source = await videoFile(timings, 90000);
    const output = await videoFile(timings, 1000);
    expect(await comparePacketContent(source, output, 'video', 0)).toMatchObject({
      equivalent: true,
      sourcePacketCount: 12,
      outputPacketCount: 12,
    });
  });

  it.each([44100, 48000] as const)(
    'preserves %d Hz AAC 1024-sample cadence, final duration and a common nonzero origin',
    async (rate) => {
      const start = 137 / rate;
      const sourceTimings = Array.from({ length: 24 }, (_, index) => ({
        pts: start + (index * 1024) / rate,
        duration: (index === 23 ? 480 : 1024) / rate,
      }));
      const source = await audioFile(rate, sourceTimings);
      const output = await audioFile(
        rate,
        sourceTimings.map((timing) => ({ ...timing, pts: timing.pts - start })),
      );
      expect(await comparePacketContent(source, output, 'audio', start)).toMatchObject({
        equivalent: true,
        sourcePacketCount: 24,
        outputPacketCount: 24,
      });
    },
  );

  it('preserves B-frame decode ordering while comparing presentation timing', async () => {
    const timings = [0, 3, 1, 2, 6, 4, 5].map((index) => ({
      pts: (index * 1001) / 30000,
      duration: 1001 / 30000,
    }));
    const source = await videoFile(timings, 90000);
    const output = await videoFile(timings, 57600);
    expect(await comparePacketContent(source, output, 'video', 0)).toMatchObject({
      equivalent: true,
      sourcePacketCount: 7,
      outputPacketCount: 7,
    });
  });

  it('reports the first actual timestamp mismatch without accepting cumulative drift', async () => {
    const sourceTimings = Array.from({ length: 12 }, (_, index) => ({
      pts: index / 30,
      duration: 1 / 30,
    }));
    const source = await videoFile(sourceTimings);
    const output = await videoFile(
      sourceTimings.map((timing, index) => ({ ...timing, pts: timing.pts + index * 0.003 })),
    );
    const result = await comparePacketContent(source, output, 'video', 0);
    expect(result).toMatchObject({
      equivalent: false,
      mismatch: 'timeline',
      timeline: {
        track: 'video',
        packetIndex: expect.any(Number),
        mismatch: expect.stringMatching(/timestamp|duration/),
        sourceTimestampSeconds: expect.any(Number),
        outputTimestampSeconds: expect.any(Number),
        originSeconds: 0,
        sourceTimescale: 57600,
        outputTimescale: 57600,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/https?:|payload|token|undefined|NaN/);
  });

  it('does not ignore an AAC tail duration change', async () => {
    const source = await audioFile(48000, [
      { pts: 0, duration: 1024 / 48000 },
      { pts: 1024 / 48000, duration: 480 / 48000 },
    ]);
    const output = await audioFile(48000, [
      { pts: 0, duration: 1024 / 48000 },
      { pts: 1024 / 48000, duration: 1024 / 48000 },
    ]);
    expect(await comparePacketContent(source, output, 'audio', 0)).toMatchObject({
      equivalent: false,
      mismatch: 'timeline',
      // The second packet is index 1, matching the public zero-based label.
      timeline: { track: 'audio', packetIndex: 1, mismatch: 'duration' },
    });
  });

  it('preserves first-failure timing diagnostics through the strict HDR executor error', async () => {
    const video = await videoFile(
      [
        { pts: 0, duration: 1 / 30 },
        { pts: 1 / 30, duration: 1 / 30 },
      ],
      57600,
      true,
    );
    const audio = await audioFile(48000, [
      { pts: 0, duration: 1024 / 48000 },
      { pts: 1024 / 48000, duration: 480 / 48000 },
    ]);
    await expect(
      remuxStagedBlobsToFile(video, audio, new ChangedAudioTailHandle(), video.size + audio.size, {
        videoDynamicRange: { provider: 'bilibili', range: 'HDR', remuxable: 'unknown' },
        videoStreamIdentity: 'timeline-fixture',
        audioStreamIdentity: 'timeline-fixture',
      }),
    ).rejects.toMatchObject({
      detail: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'PACKET_TIMELINE_MISMATCH',
        stage: 'verify-audio',
        timeline: {
          track: 'audio',
          packetIndex: 1,
          mismatch: 'duration',
          sourceDurationSeconds: 0.01,
          outputDurationSeconds: 1024 / 48000,
          sourceTimescale: 48000,
          outputTimescale: 48000,
        },
      },
    });
  });

  it('still rejects packet removal and payload mutation independently of clock bounds', async () => {
    const timings = [
      { pts: 0, duration: 1 / 30 },
      { pts: 1 / 30, duration: 1 / 30 },
    ];
    const source = await videoFile(timings);
    const missing = await videoFile(timings.slice(0, 1));
    expect(await comparePacketContent(source, missing, 'video', 0)).toMatchObject({
      equivalent: false,
      mismatch: 'count',
    });
    const data = new Uint8Array(await source.arrayBuffer());
    const packet = [0, 0, 0, 4, 0x26, 0x01, 0x80, 0];
    const start = data.findIndex((_, index) =>
      packet.every((value, offset) => data[index + offset] === value),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    data[start + 7] = 99;
    expect(await comparePacketContent(source, new Blob([data.buffer]), 'video', 0)).toMatchObject({
      equivalent: false,
      mismatch: 'payload',
    });
  });
});
