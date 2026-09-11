/** Synthetic syntax-only HEVC configuration. Not a decodable real-video fixture. */
export function makeHevcConfiguration(
  options: {
    primaries?: number;
    transfer?: number;
    matrix?: number;
    fullRange?: boolean;
    noVui?: boolean;
    bitDepthLuma?: number;
    bitDepthChroma?: number;
  } = {},
): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let index = count - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  const ue = (value: number) => {
    const encoded = value + 1;
    const width = Math.floor(Math.log2(encoded));
    put(0, width);
    put(encoded, width + 1);
  };
  put(0, 4);
  put(0, 3);
  put(1, 1); // VPS id, sublayers, temporal nesting
  put(2, 8);
  put(0, 32);
  put(0, 32);
  put(0, 16);
  put(120, 8); // profile_tier_level
  ue(0);
  ue(1);
  ue(16);
  ue(16);
  put(0, 1); // SPS id, chroma, dimensions, crop
  ue((options.bitDepthLuma ?? 10) - 8);
  ue((options.bitDepthChroma ?? 10) - 8);
  ue(0);
  put(0, 1);
  ue(0);
  ue(0);
  ue(0); // POC/order
  for (let index = 0; index < 6; index += 1) ue(0);
  put(0, 1);
  put(0, 1);
  put(0, 1);
  put(0, 1); // scaling/amp/SAO/PCM
  ue(0);
  put(0, 1);
  put(0, 1);
  put(0, 1); // short/long references, MVP/smoothing
  put(options.noVui ? 0 : 1, 1);
  if (!options.noVui) {
    put(0, 1);
    put(0, 1);
    put(1, 1); // aspect, overscan, video signal
    put(5, 3);
    put(options.fullRange ? 1 : 0, 1);
    put(1, 1);
    put(options.primaries ?? 9, 8);
    put(options.transfer ?? 16, 8);
    put(options.matrix ?? 9, 8);
    put(0, 1);
    put(0, 1);
    put(0, 1);
    put(0, 1);
    put(0, 1);
    put(0, 1);
    put(0, 1);
  }
  put(0, 1);
  put(1, 1); // no SPS extension, rbsp_stop_one_bit
  while (bits.length % 8) bits.push(0);
  const rbsp: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    rbsp.push(bits.slice(index, index + 8).reduce((value, bit) => value * 2 + bit, 0));
  }
  const ebsp: number[] = [0x42, 1];
  let zeros = 0;
  for (const value of rbsp) {
    if (zeros >= 2 && value <= 3) {
      ebsp.push(3);
      zeros = 0;
    }
    ebsp.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  const nals = [
    new Uint8Array([0x40, 1, 0x80]),
    new Uint8Array(ebsp),
    new Uint8Array([0x44, 1, 0x80]),
  ];
  const bytes = new Uint8Array(23 + nals.reduce((total, nal) => total + 5 + nal.length, 0));
  bytes[0] = 1;
  bytes[1] = 2;
  bytes[12] = 120;
  bytes[16] = 0xfd;
  bytes[17] = 0xf8 | ((options.bitDepthLuma ?? 10) - 8);
  bytes[18] = 0xf8 | ((options.bitDepthChroma ?? 10) - 8);
  bytes[21] = 0xff;
  bytes[22] = nals.length;
  const view = new DataView(bytes.buffer);
  let offset = 23;
  for (const [index, nal] of nals.entries()) {
    bytes[offset] = 0x80 | (32 + index);
    view.setUint16(offset + 1, 1);
    view.setUint16(offset + 3, nal.length);
    bytes.set(nal, offset + 5);
    offset += 5 + nal.length;
  }
  return bytes;
}
