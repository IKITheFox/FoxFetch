import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Output,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import {
  preflightCapturedBlobs,
  preflightSeparateTracks,
  remuxSeparateTracksToFile,
  sharedTimelineOriginSeconds,
} from '../../src/modules/merge';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableLike,
  MergeSourceRequest,
} from '../../src/modules/merge/types';

const VIDEO_URL = 'https://media.example.test/video.webm';
const AUDIO_URL = 'https://media.example.test/audio.webm';
const TEST_VP8_PACKET = new Uint8Array([0x10, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);

function isoBox(type: string, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + payload.byteLength);
  new DataView(output.buffer).setUint32(0, output.byteLength);
  output.set(
    [...type].map((character) => character.charCodeAt(0)),
    4,
  );
  output.set(payload, 8);
  return output;
}

async function makeVideoBlob(timestamp: number): Promise<Blob> {
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

async function makeAudioBlob(timestamp: number): Promise<Blob> {
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

function blobFetch(blobs: ReadonlyMap<string, Blob>): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const blob = blobs.get(url);
    if (!blob) return new Response(null, { status: 404 });

    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const range = requestHeaders.get('range')?.match(/^bytes=(\d*)-(\d*)$/u);
    let start = 0;
    let end = blob.size - 1;
    let status = 200;
    if (range) {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
      status = 206;
    }
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'content-length': String(Math.max(0, end - start + 1)),
      'content-type': blob.type,
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${blob.size}` } : {}),
    });
    const bytes = new Uint8Array(await blob.slice(start, end + 1).arrayBuffer());
    const body =
      method.toUpperCase() === 'HEAD'
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
    return {
      ok: true,
      status,
      statusText: status === 206 ? 'Partial Content' : 'OK',
      headers,
      body,
      redirected: false,
      url,
    } as Response;
  });
}

class MemoryFileHandle implements FileSystemFileHandleLike {
  readonly name = 'ordinary-url.webm';
  private bytes = new Uint8Array();
  readonly close = vi.fn(async () => undefined);
  readonly abort = vi.fn(async () => {
    this.bytes = new Uint8Array();
  });

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
      close: this.close,
      abort: this.abort,
    } as unknown as FileSystemWritableLike;
  }

  async getFile(): Promise<File> {
    return new File([this.bytes], this.name, { type: 'video/webm' });
  }
}

async function inspectOutput(handle: MemoryFileHandle) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await handle.getFile()) });
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack || !audioTrack) {
    input.dispose();
    throw new Error('Expected an audio/video output pair.');
  }
  const [videoStart, audioStart] = await Promise.all([
    videoTrack.getFirstTimestamp(),
    audioTrack.getFirstTimestamp(),
  ]);
  input.dispose();
  return { videoStart, audioStart };
}

async function inspectMetadata(handle: MemoryFileHandle) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await handle.getFile()) });
  try {
    return await input.getMetadataTags();
  } finally {
    input.dispose();
  }
}

async function sources(videoStart: number, audioStart: number) {
  const [videoBlob, audioBlob] = await Promise.all([
    makeVideoBlob(videoStart),
    makeAudioBlob(audioStart),
  ]);
  return {
    fetchFn: blobFetch(
      new Map([
        [VIDEO_URL, videoBlob],
        [AUDIO_URL, audioBlob],
      ]),
    ),
    request: {
      video: { url: VIDEO_URL },
      audio: { url: AUDIO_URL },
    },
  };
}

describe('ordinary URL merge timeline', () => {
  it.each([
    [
      'declared Dolby Vision',
      {
        url: VIDEO_URL,
        declaredMimeType: 'video/mp4; codecs="dvh1.08.07"',
        dynamicRange: {
          provider: 'bilibili',
          range: 'Dolby Vision',
          remuxable: 'unsupported',
        },
      },
    ],
    [
      'conflicting unknown range',
      {
        url: VIDEO_URL,
        declaredMimeType: 'video/mp4; codecs="hev1.2.4.L120.90"',
        dynamicRange: { provider: 'bilibili', range: 'unknown', remuxable: 'unsupported' },
      },
    ],
  ] satisfies Array<[string, MergeSourceRequest]>)(
    'fails closed before network access for %s metadata',
    async (_label, video) => {
      const fetchFn = vi.fn<typeof fetch>(async () => {
        throw new Error('dynamic-range policy must run before fetch');
      });
      const result = await preflightSeparateTracks(
        { video, audio: { url: AUDIO_URL } },
        { fetchFn },
      );

      expect(result).toMatchObject({
        status: 'unsupported',
        canMerge: false,
        canDownloadSeparately: true,
        failure: { code: 'DYNAMIC_RANGE_UNVERIFIED' },
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('rejects a provisional HDR declaration on VP8/Opus instead of offering an unverifiable WebM', async () => {
    const fixture = await sources(0, 0);
    const result = await preflightSeparateTracks(
      {
        ...fixture.request,
        video: {
          ...fixture.request.video,
          dynamicRange: { provider: 'bilibili', range: 'HDR', remuxable: 'unknown' },
        },
      },
      { fetchFn: fixture.fetchFn },
    );

    expect(result).toMatchObject({
      status: 'unsupported',
      canMerge: false,
      canDownloadSeparately: true,
      failure: { code: 'CONTAINER_INCOMPATIBLE' },
    });
  });

  it('rejects captured Dolby Vision initialization data before attempting packet-copy', async () => {
    const video = new Blob([isoBox('dvcC', new Uint8Array([1, 0, 8 << 1])).buffer as ArrayBuffer], {
      type: 'video/mp4',
    });
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/mp4' });

    await expect(preflightCapturedBlobs(video, audio)).resolves.toMatchObject({
      status: 'unsupported',
      canMerge: false,
      canDownloadSeparately: true,
      failure: { code: 'DYNAMIC_RANGE_UNVERIFIED' },
    });
  });

  it('retains provider HDR policy when URL inputs are staged into local blobs', async () => {
    const video = new Blob([new Uint8Array([1]).buffer], { type: 'video/mp4' });
    const audio = new Blob([new Uint8Array([1]).buffer], { type: 'audio/mp4' });

    await expect(
      preflightCapturedBlobs(video, audio, {
        videoDynamicRange: {
          provider: 'bilibili',
          range: 'HDR',
          remuxable: 'unsupported',
        },
      }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      canMerge: false,
      canDownloadSeparately: true,
      failure: { code: 'DYNAMIC_RANGE_UNVERIFIED' },
    });
  });

  it('embeds and re-verifies the current video title and cover', async () => {
    const fixture = await sources(0, 0);
    const handle = new MemoryFileHandle();
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    const result = await remuxSeparateTracksToFile(fixture.request, handle, {
      fetchFn: fixture.fetchFn,
      metadata: {
        title: 'Current video',
        cover: { data: cover, mimeType: 'image/jpeg' },
      },
    });
    const metadata = await inspectMetadata(handle);

    expect(result.verification.metadata).toEqual({
      title: 'Current video',
      coverEmbedded: true,
    });
    expect(metadata.title).toBe('Current video');
    expect(metadata.images?.[0]).toMatchObject({
      kind: 'coverFront',
      mimeType: 'image/jpeg',
      data: cover,
    });
  });

  it.each([0, 49, 51, 75, 99, 100])(
    'preserves a %d ms A/V offset with one shared origin',
    async (offsetMilliseconds) => {
      const origin = 15.05;
      const offset = offsetMilliseconds / 1_000;
      // Matches the reported Bilibili shape: video begins after audio.
      const fixture = await sources(origin + offset, origin);
      const handle = new MemoryFileHandle();

      const result = await remuxSeparateTracksToFile(fixture.request, handle, {
        fetchFn: fixture.fetchFn,
      });
      const output = await inspectOutput(handle);

      expect(result.plan.estimatedDurationSeconds).toBeCloseTo(1 + offset, 6);
      expect(output.audioStart).toBeCloseTo(0, 6);
      expect(output.audioStart - output.videoStart).toBeCloseTo(-offset, 3);
      expect(handle.close).toHaveBeenCalledOnce();
      expect(handle.abort).not.toHaveBeenCalled();
    },
  );

  it('rejects a 101 ms mismatch during preflight', async () => {
    const fixture = await sources(15.05, 15.151);

    await expect(
      preflightSeparateTracks(fixture.request, { fetchFn: fixture.fetchFn }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      failure: { code: 'TIMELINE_MISMATCH' },
    });
  });

  it('preserves a 133.3125 ms offset when both tracks have the same strong identity', async () => {
    const offset = 0.1333125;
    const fixture = await sources(15.05 + offset, 15.05);
    const request = {
      video: { ...fixture.request.video, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
      audio: { ...fixture.request.audio, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
    };
    const handle = new MemoryFileHandle();

    const result = await remuxSeparateTracksToFile(request, handle, {
      fetchFn: fixture.fetchFn,
    });
    const output = await inspectOutput(handle);

    expect(result.plan.warnings).toContain(
      '检测到 133 ms 正常编码延迟；合并将保留原始音画同步偏移。',
    );
    expect(output.audioStart - output.videoStart).toBeCloseTo(-offset, 3);
  });

  it('accepts the inclusive 500 ms identity-boundary during preflight', async () => {
    const fixture = await sources(15.55, 15.05);
    const request = {
      video: { ...fixture.request.video, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
      audio: { ...fixture.request.audio, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
    };

    await expect(
      preflightSeparateTracks(request, { fetchFn: fixture.fetchFn }),
    ).resolves.toMatchObject({ status: 'supported', canMerge: true });
  });

  it('still rejects second-scale offsets and different strong identities', async () => {
    const secondsApart = await sources(17.05, 15.05);
    const secondsApartRequest = {
      video: { ...secondsApart.request.video, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
      audio: { ...secondsApart.request.audio, streamIdentity: 'bilibili:BV1CURRENT:cid=42' },
    };
    await expect(
      preflightSeparateTracks(secondsApartRequest, { fetchFn: secondsApart.fetchFn }),
    ).resolves.toMatchObject({ status: 'unsupported', failure: { code: 'TIMELINE_MISMATCH' } });

    const wrongIdentity = await sources(15.05, 15.05);
    const wrongIdentityRequest = {
      video: { ...wrongIdentity.request.video, streamIdentity: 'bilibili:BV1VIDEO:cid=42' },
      audio: { ...wrongIdentity.request.audio, streamIdentity: 'bilibili:BV1OTHER:cid=43' },
    };
    await expect(
      preflightSeparateTracks(wrongIdentityRequest, { fetchFn: wrongIdentity.fetchFn }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      failure: { code: 'TIMELINE_MISMATCH', message: expect.stringContaining('不同的媒体身份') },
    });
  });

  it('rejects negative preroll in the shared packet-copy timeline policy', () => {
    let thrown: unknown;
    try {
      sharedTimelineOriginSeconds({ firstTimestampSeconds: -0.01 }, { firstTimestampSeconds: 0 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      detail: { code: 'TIMELINE_MISMATCH', canDownloadSeparately: true },
    });
  });

  it('preserves a typed 403 from Mediabunny range probing only after every mirror fails', async () => {
    const requestedRanges: string[] = [];
    const requestedUrls: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      requestedUrls.push(input instanceof Request ? input.url : String(input));
      requestedRanges.push(new Headers(init?.headers).get('range') ?? '');
      return new Response(null, { status: 403 });
    });
    const capability = await preflightSeparateTracks(
      {
        video: {
          url: 'https://media.example.test/denied-video.webm',
          sources: [{ url: 'https://mirror.example.test/denied-video.webm' }],
        },
        audio: {
          url: 'https://media.example.test/denied-audio.webm',
          sources: [{ url: 'https://mirror.example.test/denied-audio.webm' }],
        },
      },
      { fetchFn },
    );

    expect(capability).toMatchObject({
      status: 'unsupported',
      failure: { code: 'NETWORK_FAILED', httpStatus: 403 },
    });
    expect(requestedUrls).toEqual(
      expect.arrayContaining([
        'https://media.example.test/denied-video.webm',
        'https://mirror.example.test/denied-video.webm',
        'https://media.example.test/denied-audio.webm',
        'https://mirror.example.test/denied-audio.webm',
      ]),
    );
    expect(requestedRanges.some((value) => /^bytes=0-/u.test(value))).toBe(true);
  });

  it('does not let a primary 403 hide a later valid same-track mirror', async () => {
    const fixture = await sources(15.05, 15.05);
    const denied = 'https://media.example.test/primary-denied-video.webm';
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === denied) return new Response(null, { status: 403 });
      return fixture.fetchFn(input, init);
    });

    await expect(
      preflightSeparateTracks(
        {
          video: { url: denied, sources: [{ url: VIDEO_URL }] },
          audio: fixture.request.audio,
        },
        { fetchFn },
      ),
    ).resolves.toMatchObject({ status: 'supported', canMerge: true });
    expect(fetchFn.mock.calls.some(([input]) => String(input) === denied)).toBe(true);
    expect(fetchFn.mock.calls.some(([input]) => String(input) === VIDEO_URL)).toBe(true);
  });
});
