import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedPacket,
  EncodedAudioPacketSource,
  EncodedVideoPacketSource,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import {
  exportStandardSeparateTrack,
  exportStandardSeparateOutputs,
  prepareVerifiedStandardSeparateBlob,
} from '../../src/modules/exports';
import type { FileSystemFileHandleLike, FileSystemWritableLike } from '../../src/modules/merge';

class MemoryFileHandle implements FileSystemFileHandleLike {
  private bytes = new Uint8Array();
  readonly close = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => {
    this.bytes = new Uint8Array();
  });

  constructor(readonly name: string) {}

  async createWritable(): Promise<FileSystemWritableLike> {
    this.bytes = new Uint8Array();
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
      close: this.close,
      abort: this.abort,
    } as unknown as FileSystemWritableLike;
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name);
  }
}

function avcDecoderDescription(): Uint8Array {
  const sps = new Uint8Array([
    0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0x2d, 0xc8, 0x08, 0x80, 0x00, 0x00, 0x03, 0x00, 0x80,
    0x00, 0x00, 0x19, 0x47, 0x8b, 0x17, 0x50,
  ]);
  const pps = new Uint8Array([0x68, 0xce, 0x06, 0xe2]);
  return new Uint8Array([
    1,
    0x42,
    0xc0,
    0x1e,
    0xff,
    0xe1,
    0,
    sps.length,
    ...sps,
    1,
    0,
    pps.length,
    ...pps,
  ]);
}

async function makeAvcVideoBlob(): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source);
  await output.start();
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x0a, 0xf2]);
  await source.add(new EncodedPacket(new Uint8Array([0, 0, 0, idr.length, ...idr]), 'key', 0, 1), {
    decoderConfig: {
      codec: 'avc1.42c01e',
      codedWidth: 640,
      codedHeight: 360,
      description: avcDecoderDescription(),
    },
  });
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

async function makeMp3AudioBlob(): Promise<Blob> {
  registerMp3Encoder();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const source = new AudioSampleSource({
    codec: 'mp3',
    bitrate: 128_000,
  });
  output.addAudioTrack(source);
  await output.start();
  const frames = 4_410;
  const sample = new AudioSample({
    data: new Float32Array(frames),
    format: 'f32',
    numberOfChannels: 1,
    sampleRate: 44_100,
    timestamp: 0,
  });
  await source.add(sample);
  sample.close();
  await output.finalize();
  return new Blob([target.buffer!], { type: 'audio/mpeg' });
}

async function makeAacAudioBlob(trackCount = 1): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const sources = Array.from({ length: trackCount }, () => new EncodedAudioPacketSource('aac'));
  sources.forEach((source) => output.addAudioTrack(source));
  await output.start();
  for (const source of sources) {
    for (let index = 0; index < 3; index++) {
      await source.add(
        new EncodedPacket(
          new Uint8Array([0x21, 0x11, 0x45, 0x00, 0x14, 0x50, 0x01, 0x47]),
          'key',
          (index * 1024) / 48000,
          1024 / 48000,
        ),
        {
          decoderConfig: {
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
            description: new Uint8Array([0x11, 0x90]),
          },
        },
      );
    }
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'audio/mp4' });
}

function isoBox(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payloadSize = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const bytes = new Uint8Array(8 + payloadSize);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = type.charCodeAt(index);
  let offset = 8;
  for (const payload of payloads) {
    bytes.set(payload, offset);
    offset += payload.byteLength;
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function dynamicRangeVideoBlob(range: 'HDR' | 'Dolby Vision'): Blob {
  const children: Uint8Array[] = [];
  const sampleEntryType = range === 'HDR' ? 'hvc1' : 'dvh1';
  if (range === 'HDR') {
    const hvcC = new Uint8Array(23);
    hvcC[0] = 1;
    hvcC[1] = 2;
    hvcC[12] = 120;
    hvcC[16] = 0xfd;
    hvcC[17] = 0xfa;
    hvcC[18] = 0xfa;
    hvcC[21] = 0xff;
    const colr = new Uint8Array(11);
    colr.set(new TextEncoder().encode('nclx'));
    const view = new DataView(colr.buffer);
    view.setUint16(4, 9);
    view.setUint16(6, 16);
    view.setUint16(8, 9);
    children.push(isoBox('hvcC', hvcC), isoBox('colr', colr));
  } else {
    children.push(isoBox('dvcC', new Uint8Array([1, 0, 8 << 1, 6 << 3])));
  }
  const sampleEntry = isoBox(sampleEntryType, new Uint8Array(78), ...children);
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1);
  const moov = isoBox(
    'moov',
    isoBox(
      'trak',
      isoBox('mdia', isoBox('minf', isoBox('stbl', isoBox('stsd', stsdHeader, sampleEntry)))),
    ),
  );
  const bytes = concatBytes(
    isoBox('ftyp', new TextEncoder().encode('isom'), new Uint8Array(4)),
    moov,
  );
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: 'video/mp4',
  });
}

async function inspectSingleTrack(file: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const [tracks, video, audio] = await Promise.all([
    input.getTracks(),
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ]);
  const codec = await (video ?? audio)?.getCodec();
  input.dispose();
  return { tracks: tracks.length, video: Boolean(video), audio: Boolean(audio), codec };
}

async function inspectMetadata(file: Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    return await input.getMetadataTags();
  } finally {
    input.dispose();
  }
}

describe('standard separate output', () => {
  it('defaults ordinary separate download to byte-preserved AAC M4A without a decoder', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeAvcVideoBlob(), makeAacAudioBlob()]);
    const handles = {
      video: new MemoryFileHandle('video.partial'),
      audio: new MemoryFileHandle('audio.partial'),
    };
    const result = await exportStandardSeparateOutputs(
      videoBlob,
      audioBlob,
      handles,
      videoBlob.size + audioBlob.size,
    );
    const audio = result.outcomes[1];
    expect(audio).toMatchObject({
      status: 'completed',
      kind: 'audio',
      extension: '.m4a',
      mimeType: 'audio/mp4',
      sourceCodec: 'aac',
      outputCodec: 'aac',
      outputMode: 'original-track',
      verification: {
        sourceBytesPreserved: true,
        originalAudio: { codec: 'aac', packetCount: 3, sampleRate: 48000, numberOfChannels: 2 },
      },
    });
    if (audio.status !== 'completed') throw new Error('Expected original AAC success.');
    const file = await handles.audio.getFile();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(await audioBlob.arrayBuffer()),
    );
    expect((await prepareVerifiedStandardSeparateBlob(file, audio)).type).toBe('audio/mp4');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const packet = [0x21, 0x11, 0x45, 0x00, 0x14, 0x50, 0x01, 0x47];
    const offset = bytes.findIndex((_, index) =>
      packet.every((value, i) => bytes[index + i] === value),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes[offset + 7] = 0x48;
    await expect(
      prepareVerifiedStandardSeparateBlob(new Blob([bytes.buffer]), audio),
    ).rejects.toMatchObject({ detail: { code: 'OUTPUT_VERIFY_FAILED' } });
  });

  it('rejects non-single-track AAC and a truncated container before publishing audio', async () => {
    const video = await makeAvcVideoBlob();
    const audio = await makeAacAudioBlob(2);
    for (const invalid of [audio, (await makeAacAudioBlob()).slice(0, 50, 'audio/mp4')]) {
      const handles = {
        video: new MemoryFileHandle('v.partial'),
        audio: new MemoryFileHandle('a.partial'),
      };
      const result = await exportStandardSeparateOutputs(
        video,
        invalid,
        handles,
        video.size + invalid.size,
      );
      expect(result.status).toBe('partial');
      expect(result.outcomes[1]).toMatchObject({ status: 'failed', kind: 'audio' });
      expect(handles.audio.close).not.toHaveBeenCalled();
    }
  });

  it('keeps an explicit MP3 path and never guesses original AAC from a renamed MP3 blob', async () => {
    const [video, audio] = await Promise.all([makeAvcVideoBlob(), makeMp3AudioBlob()]);
    const handles = {
      video: new MemoryFileHandle('v.partial'),
      audio: new MemoryFileHandle('a.partial'),
    };
    const result = await exportStandardSeparateOutputs(
      video,
      audio,
      handles,
      video.size + audio.size,
      { audioOutput: 'mp3' },
    );
    expect(result.outcomes[1]).toMatchObject({
      status: 'completed',
      extension: '.mp3',
      mimeType: 'audio/mpeg',
    });
    const original = await exportStandardSeparateTrack(
      audio.slice(0, audio.size, 'audio/mp4'),
      'audio',
      handles.audio,
      audio.size,
      { audioOutput: 'original' },
    );
    expect(original).toMatchObject({
      extension: '.mp3',
      mimeType: 'audio/mpeg',
      outputMode: 'original-track',
      sourceCodec: 'mp3',
      outputCodec: 'mp3',
    });
  });

  it('rejects an unsupported Opus original source without silently invoking MP3 conversion', async () => {
    const target = new BufferTarget();
    const output = new Output({ target, format: new WebMOutputFormat() });
    const source = new EncodedAudioPacketSource('opus');
    output.addAudioTrack(source);
    await output.start();
    await source.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', 0, 0.02), {
      decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    });
    await output.finalize();
    const blob = new Blob([target.buffer!], { type: 'audio/webm' });
    const handle = new MemoryFileHandle('unsupported.partial');
    await expect(
      exportStandardSeparateTrack(blob, 'audio', handle, blob.size, { audioOutput: 'original' }),
    ).rejects.toMatchObject({ detail: { code: 'SOURCE_FORMAT_UNSUPPORTED' } });
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('does not write or publish a late audio handle after cancellation during permission/open', async () => {
    const blob = await makeAacAudioBlob();
    const controller = new AbortController();
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let release!: (writer: FileSystemWritableLike) => void;
    const pending = new Promise<FileSystemWritableLike>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const handle = {
      name: 'late.partial',
      createWritable: vi.fn(async () => {
        opened();
        return pending;
      }),
      getFile: vi.fn(async () => new File([], 'late.partial')),
    };
    const operation = exportStandardSeparateTrack(blob, 'audio', handle, blob.size, {
      audioOutput: 'original',
      signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
    await opening;
    controller.abort();
    release({ write, abort, close } as unknown as FileSystemWritableLike);
    await rejected;
    expect(write).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalled();
  });

  it('times out a stalled native open but retains its owner until the late writable is aborted', async () => {
    const blob = await makeAacAudioBlob();
    const handle = new MemoryFileHandle('timed-open.partial');
    let release!: (writer: FileSystemWritableLike) => void;
    handle.createWritable = vi.fn(
      async () =>
        new Promise<FileSystemWritableLike>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    vi.useFakeTimers();
    const delayed = exportStandardSeparateTrack(blob, 'audio', handle, blob.size, {
      audioOutput: 'original',
    });
    const rejected = expect(delayed).rejects.toMatchObject({
      detail: { reason: 'PARSER_TIMEOUT', stage: 'storage' },
    });
    void delayed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(handle.createWritable).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      const lateWrite = vi.fn(async () => undefined);
      const lateClose = vi.fn(async () => undefined);
      const lateAbort = vi.fn(async () => undefined);
      release({
        write: lateWrite,
        close: lateClose,
        abort: lateAbort,
      } as unknown as FileSystemWritableLike);
      await rejected;
      expect(lateAbort).toHaveBeenCalled();
      expect(lateWrite).not.toHaveBeenCalled();
      expect(lateClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests native abort on a pending write but never settles cancellation before that write stops', async () => {
    const blob = await makeAacAudioBlob();
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn(async () => pending);
    const close = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const getFile = vi.fn(async () => new File([], 'pending.partial'));
    const operation = exportStandardSeparateTrack(
      blob,
      'audio',
      {
        name: 'pending.partial',
        createWritable: async () => ({ write, close, abort }) as unknown as FileSystemWritableLike,
        getFile,
      },
      blob.size,
      { audioOutput: 'original', signal: controller.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    const stopRequestedBeforeWriteSettled = abort.mock.calls.length > 0;
    const settledBeforeWriteEnded = settled;
    release();
    await rejected;
    expect(stopRequestedBeforeWriteSettled).toBe(true);
    expect(settledBeforeWriteEnded).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
  });

  it('does not report a completed original file when cancellation races its native close', async () => {
    const blob = await makeAacAudioBlob();
    const controller = new AbortController();
    let release!: () => void;
    const pendingClose = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => pendingClose);
    const getFile = vi.fn(async () => new File([], 'close.partial'));
    const operation = exportStandardSeparateTrack(
      blob,
      'audio',
      {
        name: 'close.partial',
        createWritable: async () =>
          ({
            write: async () => undefined,
            close,
            abort: async () => undefined,
          }) as unknown as FileSystemWritableLike,
        getFile,
      },
      blob.size,
      { audioOutput: 'original', signal: controller.signal },
    );
    const rejected = expect(operation).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    controller.abort();
    await Promise.resolve();
    const settledBeforeNativeClose = settled;
    release();
    await rejected;
    expect(settledBeforeNativeClose).toBe(false);
    expect(getFile).not.toHaveBeenCalled();
  });

  it('does not add title or artwork to byte-preserved original audio and rejects DRM evidence', async () => {
    const blob = await makeAacAudioBlob();
    const handle = new MemoryFileHandle('audio.partial');
    const result = await exportStandardSeparateTrack(blob, 'audio', handle, blob.size, {
      audioOutput: 'original',
      metadata: { title: 'Must not rewrite original bytes' },
    });
    expect(result.verification.sourceBytesPreserved).toBe(true);
    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(
      new Uint8Array(await blob.arrayBuffer()),
    );
    const protectedHandle = new MemoryFileHandle('protected.partial');
    await expect(
      exportStandardSeparateTrack(blob, 'audio', protectedHandle, blob.size, {
        audioOutput: 'original',
        drmSignals: ['eme'],
      }),
    ).rejects.toMatchObject({ detail: { code: 'DRM_PROTECTED' } });
    expect(protectedHandle.close).not.toHaveBeenCalled();
  });
  it('can preserve the original video representation byte-for-byte', async () => {
    const videoBlob = await makeAvcVideoBlob();
    const handle = new MemoryFileHandle('original-video.partial');
    const result = await exportStandardSeparateTrack(videoBlob, 'video', handle, videoBlob.size, {
      videoDynamicRange: {
        provider: 'bilibili',
        range: 'HDR',
        remuxable: 'unknown',
      },
    });
    const output = await handle.getFile();

    expect(result).toMatchObject({
      status: 'completed',
      kind: 'video',
      outputMode: 'original-track',
      verification: { valid: true, sourceBytesPreserved: true },
    });
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(
      new Uint8Array(await videoBlob.arrayBuffer()),
    );
  });

  it.each(['HDR', 'Dolby Vision'] as const)(
    'preserves a structured %s ISO-BMFF track and rejects same-size metadata tampering at publish',
    async (range) => {
      const videoBlob = dynamicRangeVideoBlob(range);
      const handle = new MemoryFileHandle(`${range}.partial`);
      const result = await exportStandardSeparateTrack(videoBlob, 'video', handle, videoBlob.size);
      const output = await handle.getFile();

      expect(result).toMatchObject({
        status: 'completed',
        kind: 'video',
        extension: '.mp4',
        mimeType: 'video/mp4',
        outputMode: 'original-track',
        verification: {
          valid: true,
          sourceBytesPreserved: true,
          dynamicRange: { classification: range },
        },
      });
      expect(new Uint8Array(await output.arrayBuffer())).toEqual(
        new Uint8Array(await videoBlob.arrayBuffer()),
      );
      await expect(prepareVerifiedStandardSeparateBlob(output, result)).resolves.toHaveProperty(
        'type',
        'video/mp4',
      );

      const tamperedBytes = new Uint8Array(await output.arrayBuffer());
      const tamperedIndex = tamperedBytes.byteLength - 1;
      tamperedBytes[tamperedIndex] = tamperedBytes[tamperedIndex]! ^ 0x01;
      await expect(
        prepareVerifiedStandardSeparateBlob(
          new Blob([tamperedBytes.buffer as ArrayBuffer], { type: 'video/mp4' }),
          result,
        ),
      ).rejects.toMatchObject({ detail: { code: 'OUTPUT_VERIFY_FAILED' } });
    },
  );

  it('exports independently verified MP4 and MP3 through the cache-track entry point', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeAvcVideoBlob(), makeMp3AudioBlob()]);
    const videoHandle = new MemoryFileHandle('cache-video.partial');
    const audioHandle = new MemoryFileHandle('cache-audio.partial');

    const [video, audio] = await Promise.all([
      exportStandardSeparateTrack(videoBlob, 'video', videoHandle, videoBlob.size),
      exportStandardSeparateTrack(audioBlob, 'audio', audioHandle, audioBlob.size),
    ]);

    expect(video).toMatchObject({
      status: 'completed',
      kind: 'video',
      extension: '.mp4',
      mimeType: 'video/mp4',
      verification: { valid: true },
    });
    expect(audio).toMatchObject({
      status: 'completed',
      kind: 'audio',
      extension: '.mp3',
      mimeType: 'audio/mpeg',
      verification: { valid: true },
    });
    await expect(inspectSingleTrack(await videoHandle.getFile())).resolves.toMatchObject({
      tracks: 1,
      video: true,
      audio: false,
    });
    await expect(inspectSingleTrack(await audioHandle.getFile())).resolves.toMatchObject({
      tracks: 1,
      video: false,
      audio: true,
      codec: 'mp3',
    });
  });

  it('exports a real single-track MP4 and MP3 and verifies both before completion', async () => {
    const [videoBlob, audioBlob] = await Promise.all([makeAvcVideoBlob(), makeMp3AudioBlob()]);
    const handles = {
      video: new MemoryFileHandle('video.partial'),
      audio: new MemoryFileHandle('audio.partial'),
    };

    const result = await exportStandardSeparateOutputs(
      videoBlob,
      audioBlob,
      handles,
      videoBlob.size + audioBlob.size,
    );
    expect(result.status).toBe('completed');
    expect(result.outcomes).toMatchObject([
      { status: 'completed', kind: 'video', extension: '.mp4', outputCodec: 'avc' },
      { status: 'completed', kind: 'audio', extension: '.mp3', outputCodec: 'mp3' },
    ]);
    const [videoFile, audioFile] = await Promise.all([
      handles.video.getFile(),
      handles.audio.getFile(),
    ]);
    await expect(inspectSingleTrack(videoFile)).resolves.toEqual({
      tracks: 1,
      video: true,
      audio: false,
      codec: 'avc',
    });
    await expect(inspectSingleTrack(audioFile)).resolves.toEqual({
      tracks: 1,
      video: false,
      audio: true,
      codec: 'mp3',
    });
    expect(videoFile.size).toBeGreaterThan(0);
    expect(audioFile.size).toBeGreaterThan(0);
  });

  it('embeds and re-verifies the current title and cover in the exported MP4', async () => {
    const videoBlob = await makeAvcVideoBlob();
    const videoHandle = new MemoryFileHandle('video-with-cover.partial');
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    const video = await exportStandardSeparateTrack(
      videoBlob,
      'video',
      videoHandle,
      videoBlob.size,
      {
        metadata: {
          title: 'Current Bilibili video',
          cover: { data: cover, mimeType: 'image/jpeg' },
        },
      },
    );
    const metadata = await inspectMetadata(await videoHandle.getFile());

    expect(video.verification.valid).toBe(true);
    expect(metadata.title).toBe('Current Bilibili video');
    expect(metadata.images?.[0]).toMatchObject({
      kind: 'coverFront',
      mimeType: 'image/jpeg',
      data: cover,
    });
  });

  it('keeps a valid sibling output when the other codec cannot become MP4', async () => {
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    await output.cancel();
    const unsupportedVideo = new Blob([target.buffer ?? new ArrayBuffer(8)], {
      type: 'video/mp4',
    });
    const audioBlob = await makeMp3AudioBlob();
    const handles = {
      video: new MemoryFileHandle('video.partial'),
      audio: new MemoryFileHandle('audio.partial'),
    };

    const result = await exportStandardSeparateOutputs(
      unsupportedVideo,
      audioBlob,
      handles,
      unsupportedVideo.size + audioBlob.size,
    );
    expect(result.status).toBe('partial');
    expect(result.outcomes[0]).toMatchObject({ status: 'failed', kind: 'video' });
    expect(result.outcomes[1]).toMatchObject({
      status: 'completed',
      kind: 'audio',
      extension: '.mp3',
    });
  });

  it('rejects renamed or empty payloads at the native-download boundary', async () => {
    const fakeMp4 = {
      status: 'completed',
      kind: 'video',
      extension: '.mp4',
      mimeType: 'video/mp4',
      sourceCodec: 'avc',
      outputCodec: 'avc',
      verification: {
        valid: true,
        sizeBytes: 5,
        formatName: 'ISO BMFF',
        codec: 'avc',
        durationSeconds: 1,
      },
    } as const;
    await expect(
      prepareVerifiedStandardSeparateBlob(new Blob(['hello']), fakeMp4),
    ).rejects.toMatchObject({ detail: { code: 'OUTPUT_SIGNATURE_MISMATCH' } });
  });
});
