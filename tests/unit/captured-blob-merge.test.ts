import { makeHevcConfiguration } from '../fixtures/hevc-configuration';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CmafOutputFormat,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import {
  planCapturedVideoGops,
  extractIsoBmffDynamicRangeEvidence,
  preflightCapturedBlobs,
  remuxCapturedBlobsToFile,
  remuxStagedBlobsToFile,
} from '../../src/modules/merge';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableLike,
} from '../../src/modules/merge/types';

const TEST_VP8_PACKET = new Uint8Array([0x10, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
const TEST_VP8_SECOND_PACKET = new Uint8Array([0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe]);

async function makeHevcVideoBlob(hdr = false, rpu = false, containerColour = true): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const source = new EncodedVideoPacketSource('hevc');
  output.addVideoTrack(source);
  await output.start();
  const hvcC = makeHevcConfiguration({ noVui: !hdr });
  const idr = new Uint8Array([
    0,
    0,
    0,
    3,
    0x26,
    0x01,
    0x80,
    ...(rpu ? [0, 0, 0, 3, 0x7c, 0x01, 0x80] : []),
  ]);
  await source.add(new EncodedPacket(idr, 'key', 0.5, 1), {
    decoderConfig: {
      codec: 'hev1.2.4.L120.90',
      codedWidth: 16,
      codedHeight: 16,
      description: hvcC,
      // Mediabunny's ISO-BMFF writer supports these CICP values, while the
      // installed lib.dom still models only SDR WebCodecs color-space strings.
      ...(hdr && containerColour
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
  });
  await source.add(
    new EncodedPacket(new Uint8Array([0, 0, 0, 3, 0x02, 0x01, 0x80]), 'delta', 1.5, 1),
  );
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

async function makeAacAudioBlob(): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const source = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(source);
  await output.start();
  await source.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60]), 'key', 0.5, 1), {
    decoderConfig: {
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 2,
      description: new Uint8Array([0x11, 0x90]),
    },
  });
  await source.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x61]), 'key', 1.5, 1));
  await output.finalize();
  return new Blob([target.buffer!], { type: 'audio/mp4' });
}

function injectProfile8DolbyVision(
  video: Blob,
  options: {
    profile?: number;
    enhancementLayer?: boolean;
    sampleEntry?: 'dvh1' | 'dvhe' | 'hvc1' | 'hev1';
  } = {},
): Promise<Blob> {
  return video.arrayBuffer().then((buffer) => {
    const source = new Uint8Array(buffer);
    const typeBytes = new TextEncoder().encode('hvc1');
    const starts = new Map<string, number>();
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1']) {
      const needle = new TextEncoder().encode(type);
      for (let index = 4; index <= source.byteLength - 4; index += 1) {
        if (needle.every((value, offset) => source[index + offset] === value)) {
          starts.set(type, index - 4);
          break;
        }
      }
    }
    const entryStart = starts.get('hvc1');
    if (
      entryStart == null ||
      !typeBytes.every((value, index) => source[entryStart + 4 + index] === value)
    ) {
      throw new Error('Generated HEVC fixture has no hvc1 sample entry.');
    }
    const entrySize = new DataView(source.buffer).getUint32(entryStart);
    const flags = 0b101 | (options.enhancementLayer ? 0b010 : 0);
    const config = new Uint8Array([1, 0, (options.profile ?? 8) << 1, (6 << 3) | flags, 0x10]);
    const dvBox = new Uint8Array(8 + config.byteLength);
    new DataView(dvBox.buffer).setUint32(0, dvBox.byteLength);
    dvBox.set(new TextEncoder().encode('dvcC'), 4);
    dvBox.set(config, 8);
    const insertAt = entryStart + entrySize;
    const outputBytes = new Uint8Array(source.byteLength + dvBox.byteLength);
    outputBytes.set(source.subarray(0, insertAt));
    outputBytes.set(dvBox, insertAt);
    outputBytes.set(source.subarray(insertAt), insertAt + dvBox.byteLength);
    outputBytes.set(new TextEncoder().encode(options.sampleEntry ?? 'dvh1'), entryStart + 4);
    const mp41 = new TextEncoder().encode('mp41');
    for (let index = 0; index <= outputBytes.byteLength - mp41.byteLength; index += 1) {
      if (mp41.every((value, offset) => outputBytes[index + offset] === value)) {
        outputBytes.set(new TextEncoder().encode('dv58'), index);
        break;
      }
    }
    const view = new DataView(outputBytes.buffer);
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'hvc1']) {
      const start = starts.get(type);
      if (start == null) throw new Error(`Generated HEVC fixture has no ${type} box.`);
      view.setUint32(start, new DataView(source.buffer).getUint32(start) + dvBox.byteLength);
    }
    return new Blob([outputBytes.buffer], { type: 'video/mp4' });
  });
}

/** Only used with the generated trailing-moov single-track fixtures above. */
async function withInactiveSdrDescription(
  video: Blob,
  activePosition: 'first' | 'last',
): Promise<Blob> {
  const bytes = new Uint8Array(await video.arrayBuffer());
  const unusedBytes = new Uint8Array(await (await makeHevcVideoBlob()).arrayBuffer());
  const findBox = (data: Uint8Array, type: string) => {
    const needle = new TextEncoder().encode(type);
    for (let index = 4; index <= data.length - 4; index += 1)
      if (needle.every((value, offset) => data[index + offset] === value)) return index - 4;
    throw new Error(`Missing fixture ${type}`);
  };
  const unusedStart = findBox(unusedBytes, 'hvc1');
  const unused = unusedBytes.slice(
    unusedStart,
    unusedStart + new DataView(unusedBytes.buffer).getUint32(unusedStart),
  );
  const stsd = findBox(bytes, 'stsd');
  const insertAt =
    activePosition === 'first' ? stsd + new DataView(bytes.buffer).getUint32(stsd) : stsd + 16;
  const result = new Uint8Array(bytes.length + unused.length);
  result.set(bytes.subarray(0, insertAt));
  result.set(unused, insertAt);
  result.set(bytes.subarray(insertAt), insertAt + unused.length);
  const view = new DataView(result.buffer);
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']) {
    const start = findBox(bytes, type);
    view.setUint32(start, new DataView(bytes.buffer).getUint32(start) + unused.length);
  }
  view.setUint32(stsd + 12, 2);
  const stsc = findBox(result, 'stsc');
  const count = view.getUint32(stsc + 12);
  for (let index = 0; index < count; index += 1)
    view.setUint32(stsc + 24 + index * 12, activePosition === 'first' ? 1 : 2);
  return new Blob([result.buffer], { type: 'video/mp4' });
}

async function makeVideoBlob(timestamp = 0): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source);
  await output.start();
  await source.add(new EncodedPacket(TEST_VP8_PACKET, 'key', timestamp, 1), {
    decoderConfig: { codec: 'vp8', codedWidth: 2, codedHeight: 2 },
  });
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/webm' });
}

async function makeBitstreamDeltaFirstVideoBlob(): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source);
  await output.start();
  await source.add(new EncodedPacket(TEST_VP8_PACKET, 'key', 0, 1), {
    decoderConfig: { codec: 'vp8', codedWidth: 2, codedHeight: 2 },
  });
  await source.add(new EncodedPacket(TEST_VP8_SECOND_PACKET, 'key', 1, 1));
  await output.finalize();

  const bytes = new Uint8Array(target.buffer!);
  const packetOffsets: number[] = [];

  outer: for (let index = 0; index <= bytes.byteLength - TEST_VP8_PACKET.byteLength; index += 1) {
    for (let packetIndex = 0; packetIndex < TEST_VP8_PACKET.byteLength; packetIndex += 1) {
      if (bytes[index + packetIndex] !== TEST_VP8_PACKET[packetIndex]) continue outer;
    }
    packetOffsets.push(index);
  }

  if (packetOffsets.length !== 1) {
    throw new Error(
      `Expected one test VP8 packet in generated WebM, found ${packetOffsets.length}.`,
    );
  }
  bytes[packetOffsets[0]!] = TEST_VP8_PACKET[0]! | 1;
  return new Blob([bytes], { type: 'video/webm' });
}

async function makeAudioBlob(timestamp = 0): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new EncodedAudioPacketSource('opus');
  output.addAudioTrack(source);
  await output.start();
  await source.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', timestamp, 1), {
    decoderConfig: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
  });
  await output.finalize();
  return new Blob([target.buffer!], { type: 'audio/webm' });
}

async function makeCmafTrackSegment(
  kind: 'video' | 'audio',
  timestamp: number,
  duration = 1,
): Promise<{ init: ArrayBuffer; media: ArrayBuffer }> {
  const initTarget = new BufferTarget();
  const mediaTarget = new BufferTarget();
  const output = new Output({
    format: new CmafOutputFormat(),
    target: mediaTarget,
    initTarget,
  });

  if (kind === 'video') {
    const source = new EncodedVideoPacketSource('vp8');
    output.addVideoTrack(source);
    await output.start();
    await source.add(
      new EncodedPacket(new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 0]), 'key', timestamp, duration),
      { decoderConfig: { codec: 'vp8', codedWidth: 2, codedHeight: 2 } },
    );
  } else {
    const source = new EncodedAudioPacketSource('opus');
    output.addAudioTrack(source);
    await output.start();
    await source.add(
      new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', timestamp, duration),
      {
        decoderConfig: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
      },
    );
  }

  await output.finalize();
  return { init: initTarget.buffer!, media: mediaTarget.buffer! };
}

class MemoryFileHandle implements FileSystemFileHandleLike {
  readonly name = 'captured.webm';
  protected bytes = new Uint8Array();
  readonly close = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => {
    this.bytes = new Uint8Array();
  });

  async createWritable(): Promise<FileSystemWritableLike> {
    const writable = {
      write: async (chunk: StreamTargetChunk) => {
        const end = chunk.position + chunk.data.byteLength;
        if (end > this.bytes.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(this.bytes);
          this.bytes = expanded;
        }
        this.bytes.set(chunk.data, chunk.position);
      },
      close: this.close,
      abort: this.abort,
    };
    return writable as unknown as FileSystemWritableLike;
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { type: 'video/webm' });
  }
}

class CorruptingFinalAudioHandle extends MemoryFileHandle {
  constructor(private readonly packet = [0x21, 0x10, 0x04, 0x60]) {
    super();
  }
  override async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.bytes);
    const packet = this.packet;
    let foundAt = -1;
    for (let index = 0; index <= bytes.byteLength - packet.length; index += 1) {
      if (packet.every((value, offset) => bytes[index + offset] === value)) {
        foundAt = index;
        break;
      }
    }
    if (foundAt < 0) throw new Error('Fixture packet not found in final output.');
    const lastPacketByte = foundAt + packet.length - 1;
    bytes[lastPacketByte] = bytes[lastPacketByte]! ^ 0x01;
    return new File([bytes], this.name, { type: 'video/mp4' });
  }
}

class ConflictingFinalHdrColourHandle extends MemoryFileHandle {
  override async getFile(): Promise<File> {
    const bytes = new Uint8Array(this.bytes);
    const type = new TextEncoder().encode('nclx');
    const offset = bytes.findIndex((_, start) =>
      type.every((value, index) => bytes[start + index] === value),
    );
    if (offset < 0) throw new Error('Missing fixture nclx');
    new DataView(bytes.buffer).setUint16(offset + 6, 18);
    return new File([bytes], this.name, { type: 'video/mp4' });
  }
}

describe('captured Blob merge', () => {
  it('reports HDR_METADATA_MISMATCH with actual source/output configuration when final colr changes', async () => {
    const [video, audio] = await Promise.all([makeHevcVideoBlob(true), makeAacAudioBlob()]);
    const handle = new ConflictingFinalHdrColourHandle();
    await expect(
      remuxStagedBlobsToFile(video, audio, handle, video.size + audio.size, {
        videoDynamicRange: { provider: 'bilibili', range: 'HDR', remuxable: 'unknown' },
      }),
    ).rejects.toMatchObject({
      detail: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'HDR_METADATA_MISMATCH',
        stage: 'verify-output',
        configuration: {
          source: {
            sampleEntryType: 'hvc1',
            bitDepthLuma: 10,
            colourConflict: false,
            transferCharacteristics: 16,
          },
          output: {
            sampleEntryType: 'hvc1',
            bitDepthLuma: 10,
            colourConflict: true,
            transferCharacteristics: 18,
          },
        },
      },
    });
  });
  it('preserves staged Main10 HDR + AAC MP4 packets and rejects an alternate container early', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeHevcVideoBlob(true), makeAacAudioBlob()]);
    const handle = new MemoryFileHandle();
    const options = {
      videoDynamicRange: {
        provider: 'bilibili' as const,
        range: 'HDR' as const,
        remuxable: 'unknown' as const,
      },
      videoStreamIdentity: 'bilibili:BV1HDRFIXTURE:1',
      audioStreamIdentity: 'bilibili:BV1HDRFIXTURE:1',
    };
    const result = await remuxStagedBlobsToFile(
      videoBlob,
      audioBlob,
      handle,
      videoBlob.size + audioBlob.size,
      options,
    );
    expect(result).toMatchObject({
      status: 'completed',
      plan: { container: 'mp4', dynamicRangeVerification: { range: 'HDR' } },
      verification: {
        dynamicRange: {
          range: 'HDR',
          packets: { equivalent: true },
          audioPackets: { equivalent: true },
        },
      },
    });
    const rejected = new MemoryFileHandle();
    await expect(
      remuxStagedBlobsToFile(videoBlob, audioBlob, rejected, videoBlob.size + audioBlob.size, {
        ...options,
        preferredContainer: 'mkv',
      }),
    ).rejects.toMatchObject({ detail: { code: 'CONTAINER_INCOMPATIBLE' } });
    expect(rejected.close).not.toHaveBeenCalled();
  });
  it('packet-copies HDR proven by SPS VUI without inventing a source colr box', async () => {
    const [video, audio] = await Promise.all([
      makeHevcVideoBlob(true, false, false),
      makeAacAudioBlob(),
    ]);
    const source = await extractIsoBmffDynamicRangeEvidence(video);
    expect(source.colr).toBeUndefined();
    expect(source.effectiveColour).toMatchObject({
      source: 'sps-vui',
      transferCharacteristics: 16,
    });
    const handle = new MemoryFileHandle();
    await expect(
      remuxStagedBlobsToFile(video, audio, handle, video.size + audio.size, {
        videoDynamicRange: { provider: 'bilibili', range: 'HDR', remuxable: 'unknown' },
      }),
    ).resolves.toMatchObject({ status: 'completed', verification: { valid: true } });
    const output = await extractIsoBmffDynamicRangeEvidence(await handle.getFile());
    expect(output.hvcC?.payloadSha256).toBe(source.hvcC?.payloadSha256);
    expect(output.transfer).toBe('PQ');
  });

  it.each(['first', 'last'] as const)(
    'packet-copies the active %s HDR description, not the last parsed stsd entry',
    async (position) => {
      const [active, audio] = await Promise.all([makeHevcVideoBlob(true), makeAacAudioBlob()]);
      const video = await withInactiveSdrDescription(active, position);
      const originalBytes = new Uint8Array(await video.arrayBuffer());
      const source = await extractIsoBmffDynamicRangeEvidence(video);
      expect(source).toMatchObject({ classification: 'HDR', ambiguous: false });
      const handle = new MemoryFileHandle();
      await expect(
        remuxStagedBlobsToFile(video, audio, handle, video.size + audio.size, {
          videoDynamicRange: { provider: 'bilibili', range: 'HDR', remuxable: 'unknown' },
        }),
      ).resolves.toMatchObject({ status: 'completed' });
      expect((await extractIsoBmffDynamicRangeEvidence(await handle.getFile())).hvcC).toEqual(
        source.hvcC,
      );
      expect(new Uint8Array(await video.arrayBuffer())).toEqual(originalBytes);
    },
  );

  it.each(
    ([5, 8] as const).flatMap((profile) =>
      (['dvh1', 'dvhe', 'hvc1', 'hev1'] as const).map((sampleEntry) => ({ profile, sampleEntry })),
    ),
  )(
    'packet-copies synthetic Profile $profile $sampleEntry with RPU bytes only after strict restoration proof',
    async ({ profile, sampleEntry }) => {
      const [genericVideo, audioBlob] = await Promise.all([
        makeHevcVideoBlob(false, true),
        makeAacAudioBlob(),
      ]);
      const videoBlob = await injectProfile8DolbyVision(genericVideo, { profile, sampleEntry });
      const handle = new MemoryFileHandle();

      const result = await remuxStagedBlobsToFile(
        videoBlob,
        audioBlob,
        handle,
        videoBlob.size + audioBlob.size,
        {
          videoDynamicRange: {
            provider: 'bilibili',
            range: 'Dolby Vision',
            remuxable: 'unknown',
          },
          videoStreamIdentity: 'bilibili:BV1DVFIXTURE:1',
          audioStreamIdentity: 'bilibili:BV1DVFIXTURE:1',
        },
      );
      const evidence = await extractIsoBmffDynamicRangeEvidence(await handle.getFile());

      expect(result).toMatchObject({
        status: 'completed',
        plan: {
          container: 'mp4',
          dynamicRangeVerification: { range: 'Dolby Vision' },
        },
        verification: {
          valid: true,
          videoCodec: 'hevc',
          audioCodec: 'aac',
          dynamicRange: {
            range: 'Dolby Vision',
            packets: { equivalent: true },
            audioPackets: { equivalent: true },
          },
        },
      });
      expect(evidence).toMatchObject({
        classification: 'Dolby Vision',
        sampleEntryType: sampleEntry,
        dolbyVision: { profile, enhancementLayerPresent: false },
        fileType: { dolbyVisionBrands: ['dv58'] },
      });
    },
  );

  it('keeps Dolby Vision MSE capture and unsupported profiles on separate-track fallback', async () => {
    const [genericVideo, audioBlob] = await Promise.all([makeHevcVideoBlob(), makeAacAudioBlob()]);
    const profile8 = await injectProfile8DolbyVision(genericVideo);
    const profile7 = await injectProfile8DolbyVision(genericVideo, { profile: 7 });
    const capturedHandle = new MemoryFileHandle();

    await expect(
      remuxCapturedBlobsToFile(profile8, audioBlob, capturedHandle, {
        videoDynamicRange: {
          provider: 'bilibili',
          range: 'Dolby Vision',
          remuxable: 'unknown',
        },
      }),
    ).rejects.toMatchObject({ detail: { code: 'DYNAMIC_RANGE_UNVERIFIED' } });
    expect(capturedHandle.close).not.toHaveBeenCalled();

    await expect(
      preflightCapturedBlobs(profile7, audioBlob, {
        videoDynamicRange: {
          provider: 'bilibili',
          range: 'Dolby Vision',
          remuxable: 'unknown',
        },
      }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      canDownloadSeparately: true,
      failure: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'DV_PROFILE_UNSUPPORTED',
        stage: 'decoder-config',
        configuration: {
          source: {
            sampleEntryType: 'dvh1',
            profile: 7,
            level: 6,
            bitDepthLuma: 10,
            bitDepthChroma: 10,
            rpuPresent: true,
            baseLayerPresent: true,
            enhancementLayerPresent: false,
            parameterSetsComplete: true,
          },
        },
      },
    });
  });

  it('does not report success when the final destination changes an AAC packet', async () => {
    const [genericVideo, audioBlob] = await Promise.all([makeHevcVideoBlob(), makeAacAudioBlob()]);
    const videoBlob = await injectProfile8DolbyVision(genericVideo);
    const handle = new CorruptingFinalAudioHandle();

    await expect(
      remuxStagedBlobsToFile(videoBlob, audioBlob, handle, videoBlob.size + audioBlob.size, {
        videoDynamicRange: {
          provider: 'bilibili',
          range: 'Dolby Vision',
          remuxable: 'unknown',
        },
      }),
    ).rejects.toMatchObject({
      detail: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'AUDIO_PACKET_MISMATCH',
        stage: 'verify-audio',
      },
    });
  });

  it('rejects a changed RPU byte in the final standard-entry DV output', async () => {
    const [generic, audio] = await Promise.all([
      makeHevcVideoBlob(false, true),
      makeAacAudioBlob(),
    ]);
    const video = await injectProfile8DolbyVision(generic, { sampleEntry: 'hvc1' });
    const handle = new CorruptingFinalAudioHandle([0, 0, 0, 3, 0x7c, 1, 0x80]);
    await expect(
      remuxStagedBlobsToFile(video, audio, handle, video.size + audio.size, {
        videoDynamicRange: { provider: 'bilibili', range: 'Dolby Vision', remuxable: 'unknown' },
      }),
    ).rejects.toMatchObject({
      detail: { code: 'DYNAMIC_RANGE_UNVERIFIED', reason: 'VIDEO_PACKET_MISMATCH' },
    });
  });

  it('reproduces the Mediabunny GOP guard for the reported 20.038s -> 15.046s order', async () => {
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const source = new EncodedVideoPacketSource('vp8');
    output.addVideoTrack(source);
    await output.start();
    const decoderConfig = { codec: 'vp8', codedWidth: 2, codedHeight: 2 };

    await source.add(
      new EncodedPacket(new Uint8Array([0x10, 0, 0, 0]), 'key', 20.038866213151927, 1),
      { decoderConfig },
    );
    await expect(
      source.add(new EncodedPacket(new Uint8Array([0x10, 0, 0, 0]), 'key', 15.046575963718821, 1), {
        decoderConfig,
      }),
    ).rejects.toThrow(/Timestamps cannot be smaller.*15\.046575963718821s.*20\.038866213151927s/su);
    await output.cancel();
  });

  it('reorders a 15.046s GOP captured after a 20.038s GOP without retiming media', () => {
    const regressingTimestamp = 15.046575963718821;
    const previousLargestTimestamp = 20.038866213151927;
    const plan = planCapturedVideoGops([
      {
        value: 'physically-first-20s-gop',
        originalIndex: 0,
        startTimestamp: previousLargestTimestamp,
        maxTimestamp: 25.02,
        fingerprint: 'gop-20',
      },
      {
        value: 'physically-second-15s-gop',
        originalIndex: 1,
        startTimestamp: regressingTimestamp,
        maxTimestamp: 20.02,
        fingerprint: 'gop-15',
      },
    ]);

    expect(plan.ordered.map(({ value }) => value)).toEqual([
      'physically-second-15s-gop',
      'physically-first-20s-gop',
    ]);
    expect(plan.droppedDuplicateCount).toBe(0);
    expect(plan.conflictingOverlapCount).toBe(0);
  });

  it('removes only a byte-identical repeated GOP', () => {
    const plan = planCapturedVideoGops([
      {
        value: 'first-copy',
        originalIndex: 0,
        startTimestamp: 15,
        maxTimestamp: 20,
        fingerprint: 'same-packet-hash',
      },
      {
        value: 'repeated-copy',
        originalIndex: 1,
        startTimestamp: 15,
        maxTimestamp: 20,
        fingerprint: 'same-packet-hash',
      },
      {
        value: 'next-gop',
        originalIndex: 2,
        startTimestamp: 20.04,
        maxTimestamp: 25,
        fingerprint: 'next-packet-hash',
      },
    ]);

    expect(plan.ordered.map(({ value }) => value)).toEqual(['first-copy', 'next-gop']);
    expect(plan.droppedDuplicateCount).toBe(1);
    expect(plan.conflictingOverlapCount).toBe(0);
  });

  it('distinguishes a partially overlapping GOP with a novel tail from a duplicate', () => {
    const plan = planCapturedVideoGops([
      {
        value: 'first',
        originalIndex: 0,
        startTimestamp: 10,
        maxTimestamp: 20,
        fingerprint: 'first-hash',
      },
      {
        value: 'unsafe-novel-tail',
        originalIndex: 1,
        startTimestamp: 15,
        maxTimestamp: 25,
        fingerprint: 'different-hash',
      },
    ]);

    expect(plan.ordered.map(({ value }) => value)).toEqual(['first']);
    expect(plan.droppedDuplicateCount).toBe(0);
    expect(plan.conflictingOverlapCount).toBe(1);
  });

  it('rejects real CMAF GOP overlap measured through packet end timestamps', async () => {
    const [videoFirst, videoOverlap, audioFirst, audioSecond] = await Promise.all([
      makeCmafTrackSegment('video', 0, 2),
      makeCmafTrackSegment('video', 1.5, 1),
      makeCmafTrackSegment('audio', 0, 1.5),
      makeCmafTrackSegment('audio', 1.5, 1),
    ]);
    const videoBlob = new Blob([videoFirst.init, videoFirst.media, videoOverlap.media], {
      type: 'video/mp4',
    });
    const audioBlob = new Blob([audioFirst.init, audioFirst.media, audioSecond.media], {
      type: 'audio/mp4',
    });
    const handle = new MemoryFileHandle();
    const createWritable = vi.spyOn(handle, 'createWritable');

    await expect(remuxCapturedBlobsToFile(videoBlob, audioBlob, handle)).rejects.toMatchObject({
      detail: { code: 'TIMELINE_MISMATCH', canDownloadSeparately: true },
    });
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('keeps every GOP when complete sequential inputs are remuxed from staging', async () => {
    // Fragment sample durations can cross the following key packet's PTS (for
    // example around B-frame GOP boundaries). That is not evidence that a
    // complete, sequentially downloaded representation contains duplicate MSE
    // appends, so the captured-blob overlap repair must not run on this path.
    const [videoFirst, videoSecond, audioFirst, audioSecond] = await Promise.all([
      makeCmafTrackSegment('video', 0, 1.0000625),
      makeCmafTrackSegment('video', 1, 1),
      makeCmafTrackSegment('audio', 0, 1),
      makeCmafTrackSegment('audio', 1, 1),
    ]);
    const videoBlob = new Blob([videoFirst.init, videoFirst.media, videoSecond.media], {
      type: 'video/mp4',
    });
    const audioBlob = new Blob([audioFirst.init, audioFirst.media, audioSecond.media], {
      type: 'audio/mp4',
    });
    const capturedHandle = new MemoryFileHandle();
    const handle = new MemoryFileHandle();
    const downloadedBytes = videoBlob.size + audioBlob.size;
    const progress: Array<{
      phase: string;
      ratio: number | null;
      readBytes?: number;
      totalBytes?: number;
    }> = [];

    // This one-timescale-tick (62.5 microsecond) boundary difference matches
    // the live AVC regression. It remains unsafe to reinterpret as an MSE
    // duplicate, but it must not affect a complete staged representation.
    await expect(
      remuxCapturedBlobsToFile(videoBlob, audioBlob, capturedHandle),
    ).rejects.toMatchObject({ detail: { code: 'TIMELINE_MISMATCH' } });

    const result = await remuxStagedBlobsToFile(videoBlob, audioBlob, handle, downloadedBytes, {
      onProgress: (value) => progress.push(value),
    });

    expect(result).toMatchObject({ status: 'completed', plan: { mode: 'packet-copy' } });
    expect(progress).not.toContainEqual(expect.objectContaining({ phase: 'fetching' }));
    expect(progress).not.toContainEqual(expect.objectContaining({ phase: 'probing' }));
    expect(progress.every((value) => value.readBytes === downloadedBytes)).toBe(true);
    expect(progress.every((value) => value.totalBytes === downloadedBytes)).toBe(true);
    expect(
      progress.some(
        (value) => value.phase === 'muxing' && value.ratio !== null && value.ratio >= 0.24,
      ),
    ).toBe(true);

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(await handle.getFile()),
    });
    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      expect(videoTrack).not.toBeNull();
      const videoPackets = [];
      for await (const packet of new EncodedPacketSink(videoTrack!).packets()) {
        videoPackets.push(packet.timestamp);
      }
      expect(videoPackets).toHaveLength(2);
    } finally {
      input.dispose();
    }
  });

  it('rejects a bitstream-verified delta-first video during captured Blob preflight', async () => {
    const [videoBlob, audioBlob] = await Promise.all([
      makeBitstreamDeltaFirstVideoBlob(),
      makeAudioBlob(),
    ]);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      expect(track).not.toBeNull();
      const packets = [];
      for await (const packet of new EncodedPacketSink(track!).packets(undefined, undefined, {
        verifyKeyPackets: true,
      })) {
        packets.push({ type: packet.type, timestamp: packet.timestamp });
      }
      expect(packets).toEqual([
        { type: 'delta', timestamp: 0 },
        { type: 'key', timestamp: 1 },
      ]);
    } finally {
      input.dispose();
    }

    const capability = await preflightCapturedBlobs(videoBlob, audioBlob);

    expect(capability).toMatchObject({
      status: 'unsupported',
      canMerge: false,
      canDownloadSeparately: true,
      failure: { code: 'TIMELINE_MISMATCH' },
    });

    const handle = new MemoryFileHandle();
    const createWritable = vi.spyOn(handle, 'createWritable');
    await expect(remuxCapturedBlobsToFile(videoBlob, audioBlob, handle)).rejects.toMatchObject({
      detail: { code: 'TIMELINE_MISMATCH', canDownloadSeparately: true },
    });
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('remuxes real CMAF fragments captured in 20.038s -> 15.046s physical order', async () => {
    const laterTimestamp = 20.038866213151927;
    const earlierTimestamp = 15.046575963718821;
    const [videoLater, videoEarlier, audioLater, audioEarlier] = await Promise.all([
      makeCmafTrackSegment('video', laterTimestamp),
      makeCmafTrackSegment('video', earlierTimestamp),
      makeCmafTrackSegment('audio', laterTimestamp),
      makeCmafTrackSegment('audio', earlierTimestamp),
    ]);
    const videoBlob = new Blob([videoLater.init, videoLater.media, videoEarlier.media], {
      type: 'video/mp4',
    });
    const audioBlob = new Blob([audioLater.init, audioLater.media, audioEarlier.media], {
      type: 'audio/mp4',
    });
    const handle = new MemoryFileHandle();

    const result = await remuxCapturedBlobsToFile(videoBlob, audioBlob, handle);

    expect(result).toMatchObject({ status: 'completed', container: 'webm', extension: '.webm' });
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(await handle.getFile()),
    });
    try {
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      expect(videoTrack).not.toBeNull();
      expect(audioTrack).not.toBeNull();
      const videoPackets = [];
      for await (const packet of new EncodedPacketSink(videoTrack!).packets()) {
        videoPackets.push(packet.timestamp);
      }
      const audioPackets = [];
      for await (const packet of new EncodedPacketSink(audioTrack!).packets()) {
        audioPackets.push(packet.timestamp);
      }
      expect(videoPackets).toHaveLength(2);
      expect(audioPackets).toHaveLength(2);
      expect(videoPackets[0]).toBeCloseTo(0, 6);
      expect(audioPackets[0]).toBeCloseTo(0, 6);
      expect(videoPackets[1]).toBeCloseTo(laterTimestamp - earlierTimestamp, 3);
      expect(audioPackets[1]).toBeCloseTo(laterTimestamp - earlierTimestamp, 3);
    } finally {
      input.dispose();
    }
  });

  it('preflights and packet-copies independent video/audio Blobs into one streamed file', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeVideoBlob(), makeAudioBlob()]);
    const capability = await preflightCapturedBlobs(videoBlob, audioBlob);

    expect(capability).toMatchObject({
      status: 'supported',
      canMerge: true,
      plan: {
        mode: 'packet-copy',
        container: 'webm',
        extension: '.webm',
        mimeType: 'video/webm',
        estimatedInputBytes: videoBlob.size + audioBlob.size,
      },
    });

    const handle = new MemoryFileHandle();
    const result = await remuxCapturedBlobsToFile(videoBlob, audioBlob, handle);

    expect(result).toMatchObject({
      status: 'completed',
      container: 'webm',
      extension: '.webm',
      mimeType: 'video/webm',
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationSeconds === null || result.durationSeconds >= 0).toBe(true);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(handle.abort).not.toHaveBeenCalled();

    const outputFile = await handle.getFile();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(outputFile) });
    try {
      expect(await input.canRead()).toBe(true);
      expect(await input.getVideoTracks()).toHaveLength(1);
      expect(await input.getAudioTracks()).toHaveLength(1);
    } finally {
      input.dispose();
    }
  });

  it('uses one shared origin and preserves the captured A/V start offset', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeVideoBlob(15.05), makeAudioBlob(15.08)]);
    const handle = new MemoryFileHandle();

    await remuxCapturedBlobsToFile(videoBlob, audioBlob, handle);

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(await handle.getFile()),
    });
    try {
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      expect(videoTrack).not.toBeNull();
      expect(audioTrack).not.toBeNull();
      const [videoStart, audioStart] = await Promise.all([
        videoTrack!.getFirstTimestamp(),
        audioTrack!.getFirstTimestamp(),
      ]);
      expect(videoStart).toBeCloseTo(0, 6);
      expect(audioStart - videoStart).toBeCloseTo(0.03, 3);
    } finally {
      input.dispose();
    }
  });

  it('rejects an empty cache before opening an output file', async () => {
    const handle = new MemoryFileHandle();
    const createWritable = vi.spyOn(handle, 'createWritable');
    const capability = await preflightCapturedBlobs(
      new Blob([], { type: 'video/mp4' }),
      new Blob([new Uint8Array([1])], { type: 'audio/mp4' }),
    );

    expect(capability).toMatchObject({
      status: 'unsupported',
      canMerge: false,
      failure: { code: 'SOURCE_UNREADABLE' },
    });
    await expect(
      remuxCapturedBlobsToFile(
        new Blob([], { type: 'video/mp4' }),
        new Blob([new Uint8Array([1])], { type: 'audio/mp4' }),
        handle,
      ),
    ).rejects.toMatchObject({ detail: { code: 'SOURCE_UNREADABLE' } });
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('blocks declared DRM before reading either Blob', async () => {
    const capability = await preflightCapturedBlobs(
      new Blob([new Uint8Array([1])]),
      new Blob([new Uint8Array([2])]),
      {
        drmSignals: ['eme'],
      },
    );

    expect(capability).toMatchObject({
      status: 'blocked',
      canMerge: false,
      canDownloadSeparately: false,
      failure: { code: 'DRM_PROTECTED', drmSignals: ['eme'] },
    });
  });

  it('rejects a cache whose declared MIME contradicts its expected role', async () => {
    const capability = await preflightCapturedBlobs(
      new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      new Blob([new Uint8Array([2])], { type: 'audio/webm' }),
    );

    expect(capability).toMatchObject({
      status: 'unsupported',
      failure: { code: 'SOURCE_FORMAT_UNSUPPORTED' },
    });
  });
});
