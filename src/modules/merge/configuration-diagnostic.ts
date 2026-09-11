import type { IsoBmffDynamicRangeEvidence } from './isobmff-dynamic-range';
import type { MergeVideoConfigurationDiagnostic } from './types';

/** Pick actual parsed metadata explicitly: do not serialize the evidence object (it contains hashes). */
export function videoConfigurationDiagnostic(
  evidence: IsoBmffDynamicRangeEvidence,
): MergeVideoConfigurationDiagnostic {
  const result: MergeVideoConfigurationDiagnostic = {};
  const entry = evidence.sampleEntryType;
  if (
    entry === 'hvc1' ||
    entry === 'hev1' ||
    entry === 'dvh1' ||
    entry === 'dvhe' ||
    entry === 'avc1' ||
    entry === 'avc3'
  )
    result.sampleEntryType = entry;
  const dv = evidence.dolbyVision;
  for (const key of [
    'profile',
    'level',
    'rpuPresent',
    'baseLayerPresent',
    'enhancementLayerPresent',
  ] as const) {
    // These groups are copied separately to preserve exact optional property types.
    if (key === 'profile' || key === 'level') {
      if (dv?.[key] != null) result[key] = dv[key];
    } else if (dv?.[key] != null) result[key] = dv[key];
  }
  const hevc = evidence.hvcC;
  if (hevc) {
    result.bitDepthLuma = hevc.bitDepthLuma;
    result.bitDepthChroma = hevc.bitDepthChroma;
    result.chromaFormatIdc = hevc.chromaFormatIdc;
    if (hevc.parameterSetsComplete != null)
      result.parameterSetsComplete = hevc.parameterSetsComplete;
    if (hevc.parameterSetsConflict != null)
      result.parameterSetsConflict = hevc.parameterSetsConflict;
  }
  const colour = evidence.effectiveColour;
  if (evidence.colourConflict != null) result.colourConflict = evidence.colourConflict;
  if (colour) {
    result.colourSource = colour.source;
    for (const key of ['colourPrimaries', 'transferCharacteristics', 'matrixCoefficients'] as const)
      if (colour[key] != null) result[key] = colour[key];
    if (colour.fullRange != null) result.fullRange = colour.fullRange;
  }
  return result;
}
