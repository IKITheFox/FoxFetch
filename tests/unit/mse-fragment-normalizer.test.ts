import {
  BufferTarget,
  CmafOutputFormat,
  EncodedPacket,
  EncodedVideoPacketSource,
  Output,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
  normalizeCapturedTrackFragments,
  type CapturedFragmentPart,
} from '../../src/modules/resolver/mse-fragment-normalizer';

function concat(...values: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function ascii(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

function box(type: string, ...payload: readonly Uint8Array<ArrayBuffer>[]) {
  const body = concat(...payload);
  return concat(uint32(body.byteLength + 8), ascii(type), body);
}

function fullBox(type: string, flags: number, ...payload: readonly Uint8Array<ArrayBuffer>[]) {
  return box(type, uint32(flags), ...payload);
}

function mp4Initialization(brand = 'isom'): Uint8Array<ArrayBuffer> {
  const trackId = 1;
  const tkhd = fullBox('tkhd', 0, uint32(0), uint32(0), uint32(trackId), uint32(0));
  const mdhd = fullBox('mdhd', 0, uint32(0), uint32(0), uint32(1_000), uint32(0));
  const hdlr = fullBox('hdlr', 0, uint32(0), ascii('vide'));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr));
  const trex = fullBox('trex', 0, uint32(trackId), uint32(1), uint32(0), uint32(0));
  return concat(box('ftyp', ascii(brand), uint32(0)), box('moov', trak, box('mvex', trex)));
}

function mp4Fragment(
  sequenceNumber: number,
  decodeStart: number,
  sampleDurations: readonly number[],
  payloadByte: number,
): Uint8Array<ArrayBuffer> {
  const mfhd = fullBox('mfhd', 0, uint32(sequenceNumber));
  const tfhd = fullBox('tfhd', 0x020000, uint32(1));
  const tfdt = fullBox('tfdt', 0, uint32(decodeStart));
  const trun = fullBox(
    'trun',
    0x000100,
    uint32(sampleDurations.length),
    ...sampleDurations.map(uint32),
  );
  return concat(
    box('moof', mfhd, box('traf', tfhd, tfdt, trun)),
    box('mdat', new Uint8Array([payloadByte])),
  );
}

function part(
  id: string,
  firstSequence: number,
  bytes: Uint8Array<ArrayBuffer>,
): CapturedFragmentPart {
  return {
    id,
    firstSequence,
    mime: 'video/mp4; codecs="avc1.640028"',
    blob: new Blob([bytes], { type: 'video/mp4' }),
  };
}

function findTfdtValues(bytes: Uint8Array): number[] {
  const values: number[] = [];
  const marker = [0x74, 0x66, 0x64, 0x74];
  outer: for (let index = 0; index <= bytes.byteLength - 12; index += 1) {
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (bytes[index + offset] !== marker[offset]) continue outer;
    }
    const version = bytes[index + 4];
    values.push(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        version === 1 ? index + 12 : index + 8,
      ),
    );
  }
  return values;
}

function ebmlElement(id: Uint8Array<ArrayBuffer>, payload = new Uint8Array()) {
  if (payload.byteLength >= 0x7f) throw new Error('test helper only supports one-byte sizes');
  return concat(id, new Uint8Array([0x80 | payload.byteLength]), payload);
}

function webmWithClusters(...clusters: readonly Uint8Array<ArrayBuffer>[]) {
  const header = ebmlElement(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  const info = ebmlElement(new Uint8Array([0x15, 0x49, 0xa9, 0x66]));
  const tracks = ebmlElement(new Uint8Array([0x16, 0x54, 0xae, 0x6b]));
  const clusterElements = clusters.map((payload) =>
    ebmlElement(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]), payload),
  );
  return concat(
    header,
    ebmlElement(new Uint8Array([0x18, 0x53, 0x80, 0x67]), concat(info, tracks, ...clusterElements)),
  );
}

async function realCmafVideoSegment(timestamp: number, duration: number) {
  const initTarget = new BufferTarget();
  const mediaTarget = new BufferTarget();
  const output = new Output({
    format: new CmafOutputFormat(),
    target: mediaTarget,
    initTarget,
  });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source);
  await output.start();
  await source.add(
    new EncodedPacket(new Uint8Array([0x10, 0, 0, 0, 0, 0, 0, 0]), 'key', timestamp, duration),
    { decoderConfig: { codec: 'vp8', codedWidth: 2, codedHeight: 2 } },
  );
  await output.finalize();
  return { initialization: initTarget.buffer!, media: mediaTarget.buffer! };
}

describe('MSE fragment normalization', () => {
  it('parses and reorders real Mediabunny CMAF fragments', async () => {
    const [early, late] = await Promise.all([
      realCmafVideoSegment(0, 1),
      realCmafVideoSegment(1, 1),
    ]);
    const result = await normalizeCapturedTrackFragments(
      [
        {
          id: 'real-cmaf-video',
          firstSequence: 1,
          mime: 'video/mp4',
          blob: new Blob([early.initialization, late.media, early.media], {
            type: 'video/mp4',
          }),
        },
      ],
      'video',
    );

    expect(result).toMatchObject({
      format: 'mp4',
      fragmentCount: 2,
      timelineStartSeconds: 0,
      timelineEndSeconds: 2,
    });
    expect(findTfdtValues(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0, 57_600]);
  });

  it('sorts MP4 by tfdt while treating repeated mfhd values as diagnostic only', async () => {
    const initialization = mp4Initialization();
    const early = mp4Fragment(1, 0, [400, 600], 0x11);
    const late = mp4Fragment(1, 1_000, [1_000], 0x22);
    const result = await normalizeCapturedTrackFragments(
      [part('video', 1, concat(initialization, late, early))],
      'video',
    );

    expect(result).toMatchObject({
      format: 'mp4',
      fragmentCount: 2,
      droppedDuplicateCount: 0,
      timelineStartSeconds: 0,
      timelineEndSeconds: 2,
    });
    expect(findTfdtValues(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0, 1_000]);
  });

  it('removes an exact duplicate MP4 fragment after restoring decode order', async () => {
    const initialization = mp4Initialization();
    const early = mp4Fragment(7, 0, [1_000], 0x11);
    const late = mp4Fragment(8, 1_000, [1_000], 0x22);
    const result = await normalizeCapturedTrackFragments(
      [part('video', 1, concat(initialization, late, early, early))],
      'video',
    );

    expect(result.droppedDuplicateCount).toBe(1);
    expect(result.fragmentCount).toBe(2);
    expect(findTfdtValues(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0, 1_000]);
  });

  it('blocks non-identical MP4 overlap instead of trimming into a GOP', async () => {
    const bytes = concat(
      mp4Initialization(),
      mp4Fragment(1, 0, [1_000], 0x11),
      mp4Fragment(2, 500, [1_000], 0x22),
    );

    await expect(
      normalizeCapturedTrackFragments([part('video', 1, bytes)], 'video'),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        code: 'TIMELINE_MISMATCH',
        canDownloadSeparately: true,
      }),
    });
  });

  it('joins sequential changeType parts only when their initialization is identical', async () => {
    const initialization = mp4Initialization();
    const result = await normalizeCapturedTrackFragments(
      [
        part('video-before-change', 1, concat(initialization, mp4Fragment(1, 0, [1_000], 0x11))),
        part('video-after-change', 3, concat(initialization, mp4Fragment(2, 1_000, [1_000], 0x22))),
      ],
      'video',
    );

    expect(result).toMatchObject({ partCount: 2, fragmentCount: 2, timelineEndSeconds: 2 });
    expect(findTfdtValues(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0, 1_000]);
  });

  it('blocks a changeType initialization/config mismatch and keeps separate-save eligibility', async () => {
    await expect(
      normalizeCapturedTrackFragments(
        [
          part('old', 1, concat(mp4Initialization('isom'), mp4Fragment(1, 0, [1_000], 0x11))),
          part('new', 2, concat(mp4Initialization('iso6'), mp4Fragment(2, 1_000, [1_000], 0x22))),
        ],
        'video',
      ),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        code: 'SOURCE_FORMAT_UNSUPPORTED',
        canDownloadSeparately: true,
      }),
    });
  });

  it('blocks a discontinuous MP4 capture instead of silently choosing one island', async () => {
    const bytes = concat(
      mp4Initialization(),
      mp4Fragment(1, 0, [1_000], 0x11),
      mp4Fragment(2, 2_000, [1_000], 0x22),
    );

    await expect(
      normalizeCapturedTrackFragments([part('video', 1, bytes)], 'video'),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({ code: 'TIMELINE_MISMATCH' }),
    });
  });

  it('deduplicates only byte-identical WebM Clusters and preserves their order', async () => {
    const first = new Uint8Array([0xe7, 0x81, 0x00, 0xa3, 0x80]);
    const second = new Uint8Array([0xe7, 0x81, 0x01, 0xa3, 0x80]);
    const source = webmWithClusters(first, first, second);
    const result = await normalizeCapturedTrackFragments(
      [
        {
          id: 'webm-video',
          firstSequence: 1,
          mime: 'video/webm; codecs="vp9"',
          blob: new Blob([source], { type: 'video/webm' }),
        },
      ],
      'video',
    );

    expect(result).toMatchObject({
      format: 'webm',
      partCount: 1,
      fragmentCount: 2,
      droppedDuplicateCount: 1,
    });
    expect(result.blob.size).toBeLessThan(source.byteLength);
  });

  it('blocks WebM changeType parts because Cluster time alone cannot prove one config', async () => {
    const source = webmWithClusters(new Uint8Array([0xe7, 0x81, 0x00]));
    const parts: CapturedFragmentPart[] = [
      { id: 'old', firstSequence: 1, mime: 'video/webm', blob: new Blob([source]) },
      { id: 'new', firstSequence: 2, mime: 'video/webm', blob: new Blob([source]) },
    ];

    await expect(normalizeCapturedTrackFragments(parts, 'video')).rejects.toMatchObject({
      detail: expect.objectContaining({
        code: 'SOURCE_FORMAT_UNSUPPORTED',
        canDownloadSeparately: true,
      }),
    });
  });
});
