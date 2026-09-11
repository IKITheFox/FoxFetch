import { describe, expect, it } from 'vitest';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

import {
  createDolbyVisionHevcCompatibilityView,
  createHevcSampleDescriptionView,
  transplantDolbyVisionSampleEntry,
} from '../../src/modules/merge/dolby-vision-passthrough';
import { cleanupStalePrivateMergeOutputs } from '../../src/modules/merge/private-output';
import {
  assessDolbyVisionPassthroughSource,
  extractIsoBmffDynamicRangeEvidence,
  verifyIsoBmffDynamicRangePreservation,
} from '../../src/modules/merge';

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payloadSize = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const bytes = new Uint8Array(8 + payloadSize);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  new TextEncoder().encodeInto(type, bytes.subarray(4, 8));
  let offset = 8;
  for (const payload of payloads) {
    bytes.set(payload, offset);
    offset += payload.byteLength;
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function videoMoov(
  entryType: 'dvh1' | 'dvhe' | 'hvc1' | 'hev1',
  includeDolby: boolean,
  dataReferenceIndex = 1,
  activeSecondDescription = false,
) {
  const hvcC = makeHevcConfiguration();
  const children = [box('hvcC', hvcC)];
  if (includeDolby) {
    children.push(box('dvcC', new Uint8Array([1, 0, 8 << 1, (6 << 3) | 0b101, 0x10])));
    children.push(box('colr', new TextEncoder().encode('nclx\0\x09\0\x10\0\x09\0')));
    children.push(box('mdcv', new Uint8Array([1, 2, 3, 4])));
    children.push(box('clli', new Uint8Array([5, 6, 7, 8])));
  }
  const visualSampleEntry = new Uint8Array(78);
  new DataView(visualSampleEntry.buffer).setUint16(6, dataReferenceIndex);
  const entry = box(entryType, visualSampleEntry, ...children);
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, activeSecondDescription ? 2 : 1);
  const unused = box(
    'hvc1',
    visualSampleEntry,
    box('hvcC', makeHevcConfiguration({ primaries: 1, transfer: 1, matrix: 1 })),
  );
  const stsd = box('stsd', stsdHeader, ...(activeSecondDescription ? [unused, entry] : [entry]));
  const stsc = new Uint8Array(20);
  const stscView = new DataView(stsc.buffer);
  stscView.setUint32(4, 1);
  stscView.setUint32(8, 1);
  stscView.setUint32(12, 1);
  stscView.setUint32(16, 2);
  const stbl = box('stbl', stsd, ...(activeSecondDescription ? [box('stsc', stsc)] : []));
  const minf = box('minf', stbl);
  const handler = new Uint8Array(12);
  new TextEncoder().encodeInto('vide', handler.subarray(8, 12));
  const mdia = box('mdia', box('hdlr', handler), minf);
  return box('moov', box('trak', mdia));
}

function file(moov: Uint8Array, moovLast: boolean, dolbyVisionBrand = false): Blob {
  const minorVersion = new Uint8Array(4);
  new DataView(minorVersion.buffer).setUint32(0, 0x200);
  const ftyp = box(
    'ftyp',
    new TextEncoder().encode('isom'),
    minorVersion,
    new TextEncoder().encode('isom'),
    new TextEncoder().encode(dolbyVisionBrand ? 'dv58' : 'mp41'),
  );
  const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]));
  const bytes = moovLast ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: 'video/mp4',
  });
}

describe('Dolby Vision ISO-BMFF passthrough', () => {
  it('preserves the actually referenced DV description rather than an unused first description', async () => {
    const source = file(videoMoov('dvh1', true, 1, true), false, true);
    const evidence = await extractIsoBmffDynamicRangeEvidence(source);
    expect(evidence).toMatchObject({ sampleEntryType: 'dvh1', ambiguous: false });
    const compatible = await createDolbyVisionHevcCompatibilityView(source);
    expect(compatible.size).toBe(source.size);
    expect(new Uint8Array(await compatible.slice(-12).arrayBuffer())).toEqual(
      new Uint8Array(await source.slice(-12).arrayBuffer()),
    );
    expect(await extractIsoBmffDynamicRangeEvidence(compatible)).toMatchObject({
      sampleEntryType: 'hvc1',
      ambiguous: false,
    });
    const restored = await transplantDolbyVisionSampleEntry(
      source,
      file(videoMoov('hvc1', false), true),
    );
    expect((await extractIsoBmffDynamicRangeEvidence(restored)).sampleEntry).toEqual(
      evidence.sampleEntry,
    );
  });

  it('does not infer fragment tfhd/trex references from a progressive stsc table', async () => {
    const progressive = file(videoMoov('hvc1', true, 1, true), false, true);
    const fragmented = new Blob([progressive, box('moof').buffer as ArrayBuffer], {
      type: 'video/mp4',
    });
    expect(await extractIsoBmffDynamicRangeEvidence(fragmented)).toMatchObject({ ambiguous: true });
    await expect(createDolbyVisionHevcCompatibilityView(fragmented)).rejects.toThrow();
    await expect(createHevcSampleDescriptionView(fragmented)).rejects.toThrow('tfhd/trex');
  });
  it.each(['hvc1', 'hev1'] as const)(
    'preserves a structured Profile 8 %s entry without rewriting its source type or metadata',
    async (entryType) => {
      const source = file(videoMoov(entryType, true), false, true);
      const before = new Uint8Array(await source.arrayBuffer());
      const evidence = await extractIsoBmffDynamicRangeEvidence(source);
      expect(assessDolbyVisionPassthroughSource(evidence)).toMatchObject({
        supported: true,
        sampleEntryType: entryType,
      });
      const view = await createDolbyVisionHevcCompatibilityView(source);
      expect(new Uint8Array(await view.arrayBuffer())).toEqual(before);
      const restored = await transplantDolbyVisionSampleEntry(
        source,
        file(videoMoov('hvc1', false), true),
      );
      const restoredEvidence = await extractIsoBmffDynamicRangeEvidence(restored);
      expect(restoredEvidence.sampleEntry).toEqual(evidence.sampleEntry);
      expect(restoredEvidence.dolbyVision).toEqual(evidence.dolbyVision);
      const packets = {
        equivalent: true,
        sourcePacketCount: 3,
        outputPacketCount: 3,
        sourceBytes: 25,
        outputBytes: 25,
      };
      expect(
        verifyIsoBmffDynamicRangePreservation('Dolby Vision', evidence, restoredEvidence, packets),
      ).toMatchObject({ preserved: true, sampleEntryType: entryType });
      expect(
        verifyIsoBmffDynamicRangePreservation('Dolby Vision', evidence, restoredEvidence, {
          ...packets,
          equivalent: false,
          mismatch: 'payload',
        }),
      ).toMatchObject({ preserved: false });
      expect(new Uint8Array(await source.arrayBuffer())).toEqual(before);
    },
  );

  it.each(['hvc1', 'hev1'] as const)('does not admit ordinary %s as Dolby Vision', async (type) => {
    const source = file(videoMoov(type, false), false);
    await expect(createDolbyVisionHevcCompatibilityView(source)).rejects.toThrow();
    await expect(
      transplantDolbyVisionSampleEntry(source, file(videoMoov('hvc1', false), true)),
    ).rejects.toThrow();
  });
  it('retains the narrow DV gate while exposing safe configuration subreasons', async () => {
    const source = await extractIsoBmffDynamicRangeEvidence(
      file(videoMoov('dvh1', true), false, true),
    );
    expect(assessDolbyVisionPassthroughSource(source).supported).toBe(true);
    expect(assessDolbyVisionPassthroughSource({ ...source, classification: 'SDR' })).toMatchObject({
      supported: false,
      reasonCode: 'DV_CONFIG_MISSING',
    });
    expect(assessDolbyVisionPassthroughSource({ ...source, ambiguous: true })).toMatchObject({
      supported: false,
      reasonCode: 'DV_STRUCTURE_AMBIGUOUS',
    });
    expect(
      assessDolbyVisionPassthroughSource({ ...source, sampleEntryType: 'avc1' }),
    ).toMatchObject({ supported: false, reasonCode: 'DV_SAMPLE_ENTRY_UNSUPPORTED' });
    expect(
      assessDolbyVisionPassthroughSource({ ...source, hvcC: { ...source.hvcC!, bitDepthLuma: 8 } }),
    ).toMatchObject({ supported: false, reasonCode: 'DV_BIT_DEPTH_UNSUPPORTED' });
    expect(
      assessDolbyVisionPassthroughSource({
        ...source,
        dolbyVision: { ...source.dolbyVision!, profile: 7 },
      }),
    ).toMatchObject({ supported: false, reasonCode: 'DV_PROFILE_UNSUPPORTED' });
    expect(
      assessDolbyVisionPassthroughSource({
        ...source,
        dolbyVision: { ...source.dolbyVision!, enhancementLayerPresent: true },
      }),
    ).toMatchObject({ supported: false, reasonCode: 'DV_LAYERS_UNSUPPORTED' });
  });
  it('transplants the complete source sample entry into a trailing-moov packet-copy output', async () => {
    const source = file(videoMoov('dvh1', true), false, true);
    const output = file(videoMoov('hvc1', false), true);
    const restored = await transplantDolbyVisionSampleEntry(source, output);
    const [sourceEvidence, restoredEvidence] = await Promise.all([
      extractIsoBmffDynamicRangeEvidence(source),
      extractIsoBmffDynamicRangeEvidence(restored),
    ]);

    expect(restoredEvidence).toMatchObject({
      sampleEntryType: 'dvh1',
      classification: 'Dolby Vision',
      hvcC: sourceEvidence.hvcC,
      colr: sourceEvidence.colr,
      mdcv: sourceEvidence.mdcv,
      clli: sourceEvidence.clli,
      dolbyVision: sourceEvidence.dolbyVision,
      sampleEntry: sourceEvidence.sampleEntry,
      fileType: { compatibleBrands: ['isom', 'dv58'], dolbyVisionBrands: ['dv58'] },
    });
  });

  it('creates a zero-length-change HEVC compatibility view without altering the source', async () => {
    const source = file(videoMoov('dvhe', true), false, true);
    const compatible = await createDolbyVisionHevcCompatibilityView(source);
    const [sourceEvidence, compatibleEvidence] = await Promise.all([
      extractIsoBmffDynamicRangeEvidence(source),
      extractIsoBmffDynamicRangeEvidence(compatible),
    ]);

    expect(compatible.size).toBe(source.size);
    expect(sourceEvidence.sampleEntryType).toBe('dvhe');
    expect(compatibleEvidence.sampleEntryType).toBe('hev1');
    expect(compatibleEvidence.dolbyVision).toEqual(sourceEvidence.dolbyVision);
    expect(new Uint8Array(await source.arrayBuffer())).not.toEqual(
      new Uint8Array(await compatible.arrayBuffer()),
    );
  });

  it('fails closed when changing moov size could shift a following top-level box', async () => {
    const source = file(videoMoov('dvh1', true), false, true);
    const unsafeOutput = file(videoMoov('hvc1', false), false);

    await expect(transplantDolbyVisionSampleEntry(source, unsafeOutput)).rejects.toThrow(
      'mdat-before-moov',
    );
  });

  it('fails closed for a non-default source data reference', async () => {
    const source = file(videoMoov('dvh1', true, 2), false, true);
    const output = file(videoMoov('hvc1', false), true);

    await expect(transplantDolbyVisionSampleEntry(source, output)).rejects.toThrow(
      'data_reference_index=1',
    );
  });

  it('cleans only expired private DV outputs after an interrupted worker', async () => {
    const now = 2_000_000_000_000;
    const old = `dv-${now - 10_001}-old-id.mp4`;
    const fresh = `dv-${now - 9_999}-fresh-id.mp4`;
    const removed: string[] = [];
    const directory = {
      async *entries(): AsyncIterableIterator<[string, { kind: string }]> {
        yield [old, { kind: 'file' }];
        yield [fresh, { kind: 'file' }];
        yield ['unrelated.mp4', { kind: 'file' }];
        yield [`dv-${now - 20_000}-folder.mp4`, { kind: 'directory' }];
      },
      async removeEntry(name: string) {
        removed.push(name);
      },
    };

    await cleanupStalePrivateMergeOutputs(directory, { now, ttlMs: 10_000 });
    expect(removed).toEqual([old]);
  });
});
