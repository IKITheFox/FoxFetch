import { describe, expect, it } from 'vitest';
import { inspectHevcParameterSets } from '../../src/modules/merge/hevc-configuration';
import { makeHevcConfiguration } from '../fixtures/hevc-configuration';

describe('bounded HEVC parameter-set evidence', () => {
  it.each([16, 18])('extracts explicit VUI transfer %i after removing EPB bytes', (transfer) => {
    expect(inspectHevcParameterSets(makeHevcConfiguration({ transfer }))).toMatchObject({
      complete: true,
      conflict: false,
      sps: {
        chromaFormatIdc: 1,
        bitDepthLuma: 10,
        bitDepthChroma: 10,
        colour: {
          colourPrimaries: 9,
          transferCharacteristics: transfer,
          matrixCoefficients: 9,
          fullRange: false,
        },
      },
    });
  });
  it('does not invent VUI when it is absent', () => {
    const result = inspectHevcParameterSets(makeHevcConfiguration({ noVui: true }));
    expect(result.complete).toBe(true);
    expect(result.sps?.colour).toBeUndefined();
  });
  it('fails boundedly on every truncated configuration', () => {
    const valid = makeHevcConfiguration();
    for (let end = 0; end < valid.length; end += 1) {
      expect(inspectHevcParameterSets(valid.slice(0, end)).complete).toBe(false);
    }
  });
  it('rejects an array with the wrong NAL header type', () => {
    const invalid = makeHevcConfiguration();
    invalid[28] = 0x42;
    expect(inspectHevcParameterSets(invalid).complete).toBe(false);
  });
  it('reports inconsistent bit depth between hvcC and its SPS', () => {
    const invalid = makeHevcConfiguration();
    invalid[17] = 0xf8;
    expect(inspectHevcParameterSets(invalid)).toMatchObject({ complete: true, conflict: true });
  });
  it('does not select the first of conflicting SPS colour declarations', () => {
    const first = makeHevcConfiguration({ transfer: 16 });
    const other = makeHevcConfiguration({ transfer: 18 });
    const length = new DataView(other.buffer).getUint16(34);
    const extraArray = other.slice(31, 36 + length);
    const mixed = new Uint8Array(first.length + extraArray.length);
    mixed.set(first);
    mixed.set(extraArray, first.length);
    mixed[22] = 4;
    expect(inspectHevcParameterSets(mixed)).toMatchObject({ complete: true, conflict: true });
  });
  it('does not read a huge or unterminated Exp-Golomb from a damaged SPS', () => {
    const invalid = makeHevcConfiguration();
    const length = new DataView(invalid.buffer).getUint16(34);
    invalid.fill(0, 38, 36 + length);
    expect(inspectHevcParameterSets(invalid).complete).toBe(false);
  });
  it('rejects a nonzero layer id instead of treating multilayer SPS as a base layer', () => {
    const invalid = makeHevcConfiguration();
    invalid[37] = 9;
    expect(inspectHevcParameterSets(invalid).complete).toBe(false);
  });
});
