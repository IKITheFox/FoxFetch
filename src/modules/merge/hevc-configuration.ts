/** CICP values explicitly present in a HEVC SPS VUI; no decoder defaults. */
export interface HevcColourDescription {
  colourPrimaries: number;
  transferCharacteristics: number;
  matrixCoefficients: number;
  fullRange: boolean;
}

export interface HevcSpsEvidence {
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  colour?: HevcColourDescription;
}

class Bits {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    if (count < 0 || count > 32 || this.offset + count > this.bytes.length * 8)
      throw new Error('Truncated HEVC syntax.');
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + ((this.bytes[this.offset >>> 3]! >>> (7 - (this.offset & 7))) & 1);
      this.offset += 1;
    }
    return value;
  }
  skip(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.length * 8)
      throw new Error('Truncated HEVC syntax.');
    this.offset += count;
  }
  ue(max = 65535): number {
    let zeros = 0;
    while (this.read(1) === 0) {
      if (++zeros > 20) throw new Error('HEVC Exp-Golomb exceeds the safety limit.');
    }
    const value = 2 ** zeros - 1 + this.read(zeros);
    if (value > max) throw new Error('HEVC syntax exceeds the supported bounds.');
    return value;
  }
}

function rbsp(nal: Uint8Array): Uint8Array {
  const result: number[] = [];
  let zeros = 0;
  for (let index = 2; index < nal.length; index += 1) {
    const byte = nal[index]!;
    if (zeros >= 2 && byte === 3) {
      if (index + 1 >= nal.length || nal[index + 1]! > 3)
        throw new Error('Invalid HEVC emulation-prevention byte.');
      zeros = 0;
      continue;
    }
    result.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(result);
}

function readSps(nal: Uint8Array): HevcSpsEvidence {
  const bits = new Bits(rbsp(nal));
  bits.skip(4);
  const sublayers = bits.read(3);
  if (sublayers > 6) throw new Error('Unsupported HEVC sublayers.');
  bits.skip(1);
  bits.skip(96); // general profile_tier_level, including level_idc
  const layers: Array<{ profile: number; level: number }> = [];
  for (let index = 0; index < sublayers; index += 1)
    layers.push({ profile: bits.read(1), level: bits.read(1) });
  if (sublayers > 0) bits.skip((8 - sublayers) * 2);
  for (const layer of layers) {
    if (layer.profile) bits.skip(88);
    if (layer.level) bits.skip(8);
  }
  bits.ue(15); // SPS id
  const chromaFormatIdc = bits.ue(3);
  if (chromaFormatIdc === 3) bits.skip(1);
  bits.ue();
  bits.ue(); // dimensions
  if (bits.read(1)) for (let index = 0; index < 4; index += 1) bits.ue();
  const bitDepthLuma = 8 + bits.ue(8);
  const bitDepthChroma = 8 + bits.ue(8);
  const pocBits = 4 + bits.ue(12);
  const allLayerOrdering = bits.read(1);
  for (let index = allLayerOrdering ? 0 : sublayers; index <= sublayers; index += 1) {
    bits.ue(16);
    bits.ue(16);
    bits.ue();
  }
  for (let index = 0; index < 6; index += 1) bits.ue(32);
  if (bits.read(1) && bits.read(1)) {
    for (let size = 0; size < 4; size += 1) {
      for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
        if (!bits.read(1)) bits.ue(6);
        else {
          if (size > 1) bits.ue(255); // signed Exp-Golomb code has the same bit length
          for (let index = 0; index < Math.min(64, 2 ** (4 + 2 * size)); index += 1) bits.ue(511);
        }
      }
    }
  }
  bits.skip(2); // AMP and SAO
  if (bits.read(1)) {
    bits.skip(8);
    bits.ue(32);
    bits.ue(32);
    bits.skip(1);
  }
  const referenceSets = bits.ue(64);
  const deltaCounts: number[] = [];
  for (let index = 0; index < referenceSets; index += 1) {
    let count = 0;
    if (index > 0 && bits.read(1)) {
      bits.skip(1);
      bits.ue();
      const previous = deltaCounts[index - 1]!;
      for (let ref = 0; ref <= previous; ref += 1) {
        const used = bits.read(1);
        const useDelta = used || bits.read(1);
        if (useDelta) count += 1;
      }
    } else {
      count = bits.ue(64) + bits.ue(64);
      if (count > 64) throw new Error('Too many HEVC reference pictures.');
      for (let ref = 0; ref < count; ref += 1) {
        bits.ue();
        bits.skip(1);
      }
    }
    if (count > 64) throw new Error('Too many HEVC reference pictures.');
    deltaCounts.push(count);
  }
  if (bits.read(1)) {
    const count = bits.ue(32);
    for (let index = 0; index < count; index += 1) bits.skip(pocBits + 1);
  }
  bits.skip(2);
  const evidence: HevcSpsEvidence = { chromaFormatIdc, bitDepthLuma, bitDepthChroma };
  if (!bits.read(1)) return evidence;
  if (bits.read(1) && bits.read(8) === 255) bits.skip(32); // aspect_ratio_info
  if (bits.read(1)) bits.skip(1); // overscan
  if (bits.read(1)) {
    bits.skip(3);
    const fullRange = Boolean(bits.read(1));
    if (bits.read(1)) {
      evidence.colour = {
        colourPrimaries: bits.read(8),
        transferCharacteristics: bits.read(8),
        matrixCoefficients: bits.read(8),
        fullRange,
      };
    }
  }
  return evidence;
}

/**
 * Bounded hvcC array/SPS inspection, not a video decoder. Unknown syntax never
 * supplies colour evidence. All hvcC bytes remain covered by the outer hash.
 */
export function inspectHevcParameterSets(bytes: Uint8Array): {
  complete: boolean;
  conflict: boolean;
  sps?: HevcSpsEvidence;
} {
  try {
    if (bytes.length < 23 || bytes.length > 1024 * 1024 || bytes[0] !== 1)
      throw new Error('Invalid hvcC header.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const types = new Set<number>();
    const sps: HevcSpsEvidence[] = [];
    let offset = 23;
    for (let array = 0; array < bytes[22]!; array += 1) {
      if (offset + 3 > bytes.length) throw new Error('Truncated hvcC array.');
      const type = bytes[offset]! & 63;
      const count = view.getUint16(offset + 1);
      offset += 3;
      if (count > 1024) throw new Error('Too many hvcC NAL units.');
      for (let index = 0; index < count; index += 1) {
        if (offset + 2 > bytes.length) throw new Error('Truncated hvcC NAL size.');
        const length = view.getUint16(offset);
        offset += 2;
        if (length < 3 || offset + length > bytes.length) throw new Error('Invalid hvcC NAL.');
        const nal = bytes.subarray(offset, offset + length);
        offset += length;
        if (nal[0]! & 0x80 || ((nal[0]! >>> 1) & 63) !== type || !(nal[1]! & 7))
          throw new Error('Invalid hvcC NAL header.');
        // Multilayer syntax is intentionally not inferred as a single-layer SPS.
        if (nal[0]! & 1 || nal[1]! & 0xf8) throw new Error('Multilayer hvcC syntax.');
        types.add(type);
        if (type === 33) sps.push(readSps(nal));
      }
    }
    if (offset !== bytes.length) throw new Error('Unexpected hvcC trailing bytes.');
    const first = sps[0];
    const conflict =
      sps.some((item) => JSON.stringify(item) !== JSON.stringify(first)) ||
      sps.some(
        (item) =>
          item.chromaFormatIdc !== (bytes[16]! & 3) ||
          item.bitDepthLuma !== 8 + (bytes[17]! & 7) ||
          item.bitDepthChroma !== 8 + (bytes[18]! & 7),
      );
    return {
      complete: [32, 33, 34].every((type) => types.has(type)) && !!first,
      conflict,
      ...(first ? { sps: first } : {}),
    };
  } catch {
    return { complete: false, conflict: false };
  }
}
