import { describe, expect, it } from 'vitest';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

import {
  assessDolbyVisionPassthroughSource,
  extractIsoBmffDynamicRangeEvidence,
  verifyIsoBmffDynamicRangePreservation,
  type VideoPacketEquivalenceEvidence,
} from '../../src/modules/merge';

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
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

function videoInitialization(sampleEntry: Uint8Array): Uint8Array {
  const stsdHeader = new Uint8Array(8);
  new DataView(stsdHeader.buffer).setUint32(4, 1);
  const stsd = box('stsd', stsdHeader, sampleEntry);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', mdia);
  return box('moov', trak);
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

function fileType(dolbyVision = false): Uint8Array {
  const minorVersion = new Uint8Array(4);
  new DataView(minorVersion.buffer).setUint32(0, 0x200);
  return box(
    'ftyp',
    new TextEncoder().encode('isom'),
    minorVersion,
    new TextEncoder().encode('isom'),
    new TextEncoder().encode(dolbyVision ? 'dv58' : 'mp41'),
  );
}

function hdrInit(options: { clli?: boolean; transfer?: 16 | 18 } = {}): Uint8Array {
  const hvcC = makeHevcConfiguration({ transfer: options.transfer ?? 16 });
  const colr = new Uint8Array(11);
  colr.set(new TextEncoder().encode('nclx'));
  const colrView = new DataView(colr.buffer);
  colrView.setUint16(4, 9);
  colrView.setUint16(6, options.transfer ?? 16);
  colrView.setUint16(8, 9);
  const children = [box('hvcC', hvcC), box('colr', colr)];
  if (options.clli) children.push(box('clli', new Uint8Array([0, 232, 0, 64])));
  const sampleEntry = box('hvc1', new Uint8Array(78), ...children);
  return concat(fileType(), videoInitialization(sampleEntry));
}

function dolbyVisionInit(
  options: {
    profile?: number;
    enhancementLayer?: boolean;
    configType?: 'dvcC' | 'dvvC' | 'dvwC';
    sampleEntryType?: 'dvh1' | 'dvhe' | 'hvc1' | 'hev1';
    bitDepthLuma?: number;
    bitDepthChroma?: number;
  } = {},
): Uint8Array {
  const hvcC = makeHevcConfiguration({
    bitDepthLuma: options.bitDepthLuma ?? 10,
    bitDepthChroma: options.bitDepthChroma ?? 10,
  });
  const profile = options.profile ?? 8;
  const flags = 0b101 | (options.enhancementLayer ? 0b010 : 0);
  const dvConfig = new Uint8Array([1, 0, profile << 1, (6 << 3) | flags, 1 << 4]);
  const sampleEntry = box(
    options.sampleEntryType ?? 'dvh1',
    new Uint8Array(78),
    box('hvcC', hvcC),
    box(options.configType ?? 'dvcC', dvConfig),
  );
  return concat(fileType(true), videoInitialization(sampleEntry));
}

const equivalentPackets: VideoPacketEquivalenceEvidence = {
  equivalent: true,
  sourcePacketCount: 12,
  outputPacketCount: 12,
  sourceBytes: 4096,
  outputBytes: 4096,
};

describe('structured ISO-BMFF dynamic range evidence', () => {
  it('uses explicit SPS VUI when an HDR track has no container colr box', async () => {
    const input = concat(
      fileType(),
      videoInitialization(box('hvc1', new Uint8Array(78), box('hvcC', makeHevcConfiguration()))),
    );
    const evidence = await extractIsoBmffDynamicRangeEvidence(input);
    expect(evidence).toMatchObject({
      classification: 'HDR',
      transfer: 'PQ',
      effectiveColour: { source: 'sps-vui', colourPrimaries: 9, transferCharacteristics: 16 },
    });
    expect(evidence.colr).toBeUndefined();
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', evidence, evidence, equivalentPackets),
    ).toMatchObject({ preserved: true });
  });

  it('rejects explicit disagreement between container colour and SPS VUI', async () => {
    const colr = new Uint8Array(11);
    colr.set(new TextEncoder().encode('nclx'));
    const view = new DataView(colr.buffer);
    view.setUint16(4, 9);
    view.setUint16(6, 18);
    view.setUint16(8, 9);
    const input = concat(
      fileType(),
      videoInitialization(
        box(
          'hvc1',
          new Uint8Array(78),
          box('hvcC', makeHevcConfiguration({ transfer: 16 })),
          box('colr', colr),
        ),
      ),
    );
    const evidence = await extractIsoBmffDynamicRangeEvidence(input);
    expect(evidence.ambiguous).toBe(true);
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', evidence, evidence, equivalentPackets),
    ).toMatchObject({ preserved: false });
  });

  it('uses the stsc-referenced description instead of merging an unused SDR description', async () => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(4, 2);
    const stsc = new Uint8Array(20);
    const view = new DataView(stsc.buffer);
    view.setUint32(4, 1);
    view.setUint32(8, 1);
    view.setUint32(12, 1);
    view.setUint32(16, 2);
    const entries = [
      box(
        'hvc1',
        new Uint8Array(78),
        box('hvcC', makeHevcConfiguration({ transfer: 1, primaries: 1, matrix: 1 })),
      ),
      box('hvc1', new Uint8Array(78), box('hvcC', makeHevcConfiguration())),
    ];
    const input = concat(
      fileType(),
      box(
        'moov',
        box(
          'trak',
          box('mdia', box('minf', box('stbl', box('stsd', header, ...entries), box('stsc', stsc)))),
        ),
      ),
    );
    expect(await extractIsoBmffDynamicRangeEvidence(input)).toMatchObject({
      classification: 'HDR',
      transfer: 'PQ',
      ambiguous: false,
    });
  });

  it('does not treat unspecified SPS CICP values as HDR evidence', async () => {
    const input = concat(
      fileType(),
      videoInitialization(
        box(
          'hvc1',
          new Uint8Array(78),
          box('hvcC', makeHevcConfiguration({ primaries: 2, transfer: 2, matrix: 2 })),
        ),
      ),
    );
    const evidence = await extractIsoBmffDynamicRangeEvidence(input);
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', evidence, evidence, equivalentPackets),
    ).toMatchObject({ preserved: false });
  });

  it('rejects hvcC with missing parameter-set arrays even if colr declares HDR', async () => {
    const good = await extractIsoBmffDynamicRangeEvidence(hdrInit());
    const incomplete = { ...good, hvcC: { ...good.hvcC!, parameterSetsComplete: false } };
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', incomplete, incomplete, equivalentPackets),
    ).toMatchObject({ preserved: false });
  });

  it.each(['hvc1', 'hev1'] as const)(
    'keeps profile/layer/config gates for standard HEVC %s DV entries',
    async (sampleEntryType) => {
      const profile7 = await extractIsoBmffDynamicRangeEvidence(
        dolbyVisionInit({ sampleEntryType, profile: 7 }),
      );
      const dual = await extractIsoBmffDynamicRangeEvidence(
        dolbyVisionInit({ sampleEntryType, enhancementLayer: true }),
      );
      const good = await extractIsoBmffDynamicRangeEvidence(dolbyVisionInit({ sampleEntryType }));
      expect(assessDolbyVisionPassthroughSource(profile7)).toMatchObject({
        supported: false,
        reasonCode: 'DV_PROFILE_UNSUPPORTED',
      });
      expect(assessDolbyVisionPassthroughSource(dual)).toMatchObject({
        supported: false,
        reasonCode: 'DV_LAYERS_UNSUPPORTED',
      });
      expect(
        assessDolbyVisionPassthroughSource({
          ...good,
          hvcC: { ...good.hvcC!, parameterSetsComplete: false },
        }),
      ).toMatchObject({ supported: false, reasonCode: 'HEVC_CONFIG_MISSING' });
    },
  );
  it('extracts HEVC bit depth and BT.2020 PQ from the video sample entry', async () => {
    const evidence = await extractIsoBmffDynamicRangeEvidence(hdrInit());

    expect(evidence).toMatchObject({
      sampleEntryType: 'hvc1',
      classification: 'HDR',
      transfer: 'PQ',
      ambiguous: false,
      hvcC: { bitDepthLuma: 10, bitDepthChroma: 10, nalLengthSize: 4 },
      colr: { colourPrimaries: 9, transferCharacteristics: 16, matrixCoefficients: 9 },
    });
  });

  it('does not treat arbitrary box-like bytes in mdat as Dolby Vision evidence', async () => {
    const payload = box('dvcC', new Uint8Array([1, 0, 8 << 1, 0]));
    const evidence = await extractIsoBmffDynamicRangeEvidence(box('mdat', payload));

    expect(evidence.classification).toBe('unknown');
    expect(evidence.dolbyVision).toBeUndefined();
  });

  it('accepts HDR only when metadata and packet content are equivalent', async () => {
    const source = await extractIsoBmffDynamicRangeEvidence(hdrInit({ clli: true }));
    const exactOutput = await extractIsoBmffDynamicRangeEvidence(hdrInit({ clli: true }));
    const missingClli = await extractIsoBmffDynamicRangeEvidence(hdrInit());

    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', source, exactOutput, equivalentPackets),
    ).toMatchObject({ preserved: true, range: 'HDR', transfer: 'PQ', bitDepth: 10 });
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', source, missingClli, equivalentPackets),
    ).toMatchObject({ preserved: false, reason: expect.stringContaining('clli') });
    expect(
      verifyIsoBmffDynamicRangePreservation('HDR', source, exactOutput, {
        ...equivalentPackets,
        equivalent: false,
      }),
    ).toMatchObject({ preserved: false, reason: expect.stringContaining('packet') });
  });

  it('accepts exact single-layer Profile 5/8 Dolby Vision preservation', async () => {
    const evidence = await extractIsoBmffDynamicRangeEvidence(dolbyVisionInit());

    expect(evidence).toMatchObject({
      sampleEntryType: 'dvh1',
      fileType: { majorBrand: 'isom', compatibleBrands: ['isom', 'dv58'] },
      classification: 'Dolby Vision',
      sampleEntry: { type: 'dvh1', size: expect.any(Number), sha256: expect.any(String) },
      dolbyVision: {
        type: 'dvcC',
        profile: 8,
        level: 6,
        rpuPresent: true,
        enhancementLayerPresent: false,
        baseLayerPresent: true,
      },
    });
    expect(
      verifyIsoBmffDynamicRangePreservation('Dolby Vision', evidence, evidence, equivalentPackets),
    ).toMatchObject({
      preserved: true,
      range: 'Dolby Vision',
      profile: 8,
      level: 6,
      sampleEntryType: 'dvh1',
    });
  });

  it('recognizes dvwC and fails closed for enhancement-layer or unsupported profiles', async () => {
    const profile5 = await extractIsoBmffDynamicRangeEvidence(
      dolbyVisionInit({ profile: 5, configType: 'dvwC', sampleEntryType: 'dvhe' }),
    );
    const dualLayer = await extractIsoBmffDynamicRangeEvidence(
      dolbyVisionInit({ enhancementLayer: true }),
    );
    const profile7 = await extractIsoBmffDynamicRangeEvidence(dolbyVisionInit({ profile: 7 }));

    expect(profile5.dolbyVision?.type).toBe('dvwC');
    expect(assessDolbyVisionPassthroughSource(profile5)).toMatchObject({
      supported: true,
      profile: 5,
      sampleEntryType: 'dvhe',
    });
    expect(assessDolbyVisionPassthroughSource(dualLayer)).toMatchObject({
      supported: false,
      reason: expect.stringContaining('单层'),
    });
    expect(assessDolbyVisionPassthroughSource(profile7)).toMatchObject({
      supported: false,
      reason: expect.stringContaining('Profile 5/8'),
    });
  });

  it.each(
    [5, 8].flatMap((profile) =>
      (
        [
          [8, 8],
          [12, 12],
          [10, 12],
          [12, 10],
        ] as const
      ).map(([bitDepthLuma, bitDepthChroma]) => ({ profile, bitDepthLuma, bitDepthChroma })),
    ),
  )(
    'rejects Profile $profile with $bitDepthLuma/$bitDepthChroma-bit luma/chroma outside the 10-bit contract',
    async ({ profile, bitDepthLuma, bitDepthChroma }) => {
      const supported = await extractIsoBmffDynamicRangeEvidence(dolbyVisionInit({ profile }));
      const unsupported = await extractIsoBmffDynamicRangeEvidence(
        dolbyVisionInit({ profile, bitDepthLuma, bitDepthChroma }),
      );

      expect(unsupported.hvcC).toMatchObject({ bitDepthLuma, bitDepthChroma });
      expect(assessDolbyVisionPassthroughSource(supported)).toMatchObject({ supported: true });
      expect(assessDolbyVisionPassthroughSource(unsupported)).toMatchObject({
        supported: false,
        reasonCode: 'DV_BIT_DEPTH_UNSUPPORTED',
      });
      expect(
        verifyIsoBmffDynamicRangePreservation(
          'Dolby Vision',
          unsupported,
          unsupported,
          equivalentPackets,
        ),
      ).toMatchObject({ preserved: false, reason: expect.stringContaining('10-bit') });
      expect(
        verifyIsoBmffDynamicRangePreservation(
          'Dolby Vision',
          supported,
          unsupported,
          equivalentPackets,
        ),
      ).toMatchObject({ preserved: false, reason: expect.stringContaining('10-bit') });
    },
  );
});
