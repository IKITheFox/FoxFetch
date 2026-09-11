import { describe, expect, it } from 'vitest';
import { publicConfigurationDiagnostic } from '../../src/modules/jobs/public-diagnostics';
import { mergeError, normalizeMergeError } from '../../src/modules/merge/errors';

describe('public video configuration diagnostics', () => {
  it('reconstructs only bounded values and retains observed false/zero without inventing absent fields', () => {
    const result = publicConfigurationDiagnostic({
      source: {
        sampleEntryType: 'hev1',
        profile: 0,
        level: 0,
        rpuPresent: false,
        colourConflict: true,
        colourPrimaries: 2,
        fullRange: false,
        privateUrl: 'https://cdn.test/?token=secret',
        payloadSha256: 'private-hash',
        configBytes: [1, 2, 3],
        headers: { Cookie: 'secret-cookie' },
      },
      output: { parameterSetsComplete: false, parameterSetsConflict: true },
    });
    expect(result).toEqual({
      source: {
        sampleEntryType: 'hev1',
        profile: 0,
        level: 0,
        rpuPresent: false,
        colourConflict: true,
        colourPrimaries: 2,
        fullRange: false,
      },
      output: { parameterSetsComplete: false, parameterSetsConflict: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|hash|headers|configBytes/);
  });
  it.each([
    null,
    [],
    'raw',
    { source: {} },
    {
      source: {
        sampleEntryType: 'https://private',
        profile: 128,
        level: 64,
        rpuPresent: 'true',
        bitDepthLuma: 7,
        bitDepthChroma: 17,
        chromaFormatIdc: 4,
        colourSource: 'guessed',
        colourPrimaries: 256,
        transferCharacteristics: -1,
        matrixCoefficients: 1.5,
        colourConflict: 1,
        fullRange: 'false',
      },
    },
    { output: { profile: Number.NaN, level: Number.POSITIVE_INFINITY } },
  ])('omits unsupported or forged configuration values %#', (value) => {
    expect(publicConfigurationDiagnostic(value)).toBeUndefined();
  });
  it('retains configuration through MergeError creation and normalization', () => {
    const configuration = {
      source: { sampleEntryType: 'hvc1' as const, bitDepthLuma: 10 },
      output: { sampleEntryType: 'hvc1' as const, bitDepthLuma: 8 },
    };
    const failure = mergeError('DYNAMIC_RANGE_UNVERIFIED', 'safe reason', {
      reason: 'HDR_METADATA_MISMATCH',
      stage: 'verify-output',
      configuration,
    });
    expect(normalizeMergeError(failure).detail).toMatchObject({
      configuration,
      reason: 'HDR_METADATA_MISMATCH',
    });
  });
});
