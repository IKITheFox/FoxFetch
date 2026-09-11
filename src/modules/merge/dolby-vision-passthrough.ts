import {
  assessDolbyVisionPassthroughSource,
  extractIsoBmffDynamicRangeEvidence,
} from './isobmff-dynamic-range';
import { activeSampleDescriptions } from './sample-description';

interface IsoBox {
  type: string;
  start: number;
  end: number;
  payloadStart: number;
  headerSize: 8 | 16;
  extendedSize: boolean;
}

interface VideoSampleEntryLocation {
  entry: IsoBox;
  ancestors: IsoBox[];
  stsd: IsoBox;
  stsc?: IsoBox;
  entryCount: number;
}

const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const SUPPORTED_SOURCE_ENTRIES = new Set(['dvh1', 'dvhe', 'hvc1', 'hev1']);
const SUPPORTED_OUTPUT_ENTRIES = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe']);

function uint32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function uint16(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
}

function uint64(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 8 > bytes.byteLength) return undefined;
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length && offset + index < bytes.byteLength; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

function validBoxType(type: string): boolean {
  return (
    type.length === 4 &&
    [...type].every((character) => {
      const value = character.charCodeAt(0);
      return value >= 0x20 && value <= 0x7e;
    })
  );
}

function parseBox(bytes: Uint8Array, start: number, parentEnd: number): IsoBox | null {
  if (start < 0 || start + 8 > parentEnd || parentEnd > bytes.byteLength) return null;
  const size32 = uint32(bytes, start);
  const type = ascii(bytes, start + 4, 4);
  if (size32 == null || !validBoxType(type)) return null;
  let size = size32;
  let headerSize: 8 | 16 = 8;
  let extendedSize = false;
  if (size32 === 1) {
    size = uint64(bytes, start + 8) ?? 0;
    headerSize = 16;
    extendedSize = true;
  } else if (size32 === 0) {
    size = parentEnd - start;
  }
  if (size < headerSize || start + size > parentEnd || !Number.isSafeInteger(start + size)) {
    return null;
  }
  return {
    type,
    start,
    end: start + size,
    payloadStart: start + headerSize,
    headerSize,
    extendedSize,
  };
}

function directChildren(bytes: Uint8Array, start: number, end: number): IsoBox[] {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = parseBox(bytes, offset, end);
    if (!box) throw new Error('ISO-BMFF 子箱结构无效。');
    boxes.push(box);
    offset = box.end;
  }
  if (offset !== end) throw new Error('ISO-BMFF 子箱末尾存在无法解析的数据。');
  return boxes;
}

function onlyChild(bytes: Uint8Array, parent: IsoBox, type: string): IsoBox {
  const matches = directChildren(bytes, parent.payloadStart, parent.end).filter(
    (box) => box.type === type,
  );
  if (matches.length !== 1) throw new Error(`ISO-BMFF 必须恰好包含一个 ${type} 箱。`);
  return matches[0]!;
}

function handlerType(bytes: Uint8Array, mdia: IsoBox): string | undefined {
  const handlers = directChildren(bytes, mdia.payloadStart, mdia.end).filter(
    (box) => box.type === 'hdlr',
  );
  const handler = handlers[0];
  if (handlers.length !== 1 || !handler || handler.payloadStart + 12 > handler.end)
    return undefined;
  return ascii(bytes, handler.payloadStart + 8, 4);
}

function locateVideoSampleEntry(moovBytes: Uint8Array): VideoSampleEntryLocation {
  const moov = parseBox(moovBytes, 0, moovBytes.byteLength);
  if (!moov || moov.type !== 'moov' || moov.end !== moovBytes.byteLength) {
    throw new Error('ISO-BMFF moov 箱结构无效。');
  }
  const videoTracks = directChildren(moovBytes, moov.payloadStart, moov.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => ({ trak, mdia: onlyChild(moovBytes, trak, 'mdia') }))
    .filter(({ mdia }) => handlerType(moovBytes, mdia) === 'vide');
  if (videoTracks.length !== 1) {
    throw new Error('Dolby Vision 保真路径只支持恰好一条视频轨。');
  }
  const { trak, mdia } = videoTracks[0]!;
  const minf = onlyChild(moovBytes, mdia, 'minf');
  const stbl = onlyChild(moovBytes, minf, 'stbl');
  const stsd = onlyChild(moovBytes, stbl, 'stsd');
  if (stsd.payloadStart + 8 > stsd.end) throw new Error('stsd 箱已截断。');
  const entryCount = uint32(moovBytes, stsd.payloadStart + 4);
  const stscs = directChildren(moovBytes, stbl.payloadStart, stbl.end).filter(
    (box) => box.type === 'stsc',
  );
  if (stscs.length > 1) throw new Error('视频 stsc 不唯一。');
  const stsc = stscs[0];
  const selected = activeSampleDescriptions(
    entryCount ?? 0,
    stsc ? moovBytes.subarray(stsc.payloadStart, stsc.end) : undefined,
  );
  if (selected.size !== 1) throw new Error('Dolby Vision 保真路径只支持一个实际使用的视频样本项。');
  const entries = directChildren(moovBytes, stsd.payloadStart + 8, stsd.end);
  if (entries.length !== entryCount) throw new Error('视频样本项结构无效。');
  const index = [...selected][0]!;
  const entry = entries[index - 1];
  if (!entry) throw new Error('视频样本项引用无效。');
  return {
    entry,
    ancestors: [stsd, stbl, minf, mdia, trak, moov],
    stsd,
    ...(stsc ? { stsc } : {}),
    entryCount: entries.length,
  };
}

async function topLevelBoxes(blob: Blob): Promise<IsoBox[]> {
  const boxes: IsoBox[] = [];
  let offset = 0;
  while (offset + 8 <= blob.size) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) throw new Error('ISO-BMFF 顶层箱数量超出安全限制。');
    const header = new Uint8Array(
      await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer(),
    );
    const size32 = uint32(header, 0);
    const type = ascii(header, 4, 4);
    if (size32 == null || !validBoxType(type)) throw new Error('ISO-BMFF 顶层箱结构无效。');
    let size = size32;
    let headerSize: 8 | 16 = 8;
    let extendedSize = false;
    if (size32 === 1) {
      size = uint64(header, 8) ?? 0;
      headerSize = 16;
      extendedSize = true;
    } else if (size32 === 0) {
      size = blob.size - offset;
    }
    if (size < headerSize || !Number.isSafeInteger(offset + size) || offset + size > blob.size) {
      throw new Error('ISO-BMFF 顶层箱大小无效。');
    }
    boxes.push({
      type,
      start: offset,
      end: offset + size,
      payloadStart: offset + headerSize,
      headerSize,
      extendedSize,
    });
    offset += size;
  }
  if (offset !== blob.size) throw new Error('ISO-BMFF 文件末尾存在无法解析的数据。');
  return boxes;
}

async function readUniqueMoov(
  blob: Blob,
): Promise<{ box: IsoBox; bytes: Uint8Array; top: IsoBox[] }> {
  const top = await topLevelBoxes(blob);
  const matches = top.filter((box) => box.type === 'moov');
  const box = matches[0];
  if (matches.length !== 1 || !box) throw new Error('ISO-BMFF 必须恰好包含一个 moov 箱。');
  const size = box.end - box.start;
  if (size > MAX_MOOV_BYTES) throw new Error('ISO-BMFF moov 箱超出安全限制。');
  return { box, bytes: new Uint8Array(await blob.slice(box.start, box.end).arrayBuffer()), top };
}

interface FileTypeBox {
  box: IsoBox;
  bytes: Uint8Array;
  majorBrand: string;
  compatibleBrands: Array<{ brand: string; offset: number }>;
}

async function readUniqueFileType(blob: Blob, top: readonly IsoBox[]): Promise<FileTypeBox> {
  const matches = top.filter((box) => box.type === 'ftyp');
  const box = matches[0];
  if (matches.length !== 1 || !box) throw new Error('ISO-BMFF 必须恰好包含一个 ftyp 箱。');
  const bytes = new Uint8Array(await blob.slice(box.start, box.end).arrayBuffer());
  const relative = parseBox(bytes, 0, bytes.byteLength);
  if (
    !relative ||
    relative.type !== 'ftyp' ||
    relative.payloadStart + 8 > relative.end ||
    (relative.end - (relative.payloadStart + 8)) % 4 !== 0
  ) {
    throw new Error('ISO-BMFF ftyp 箱结构无效。');
  }
  const compatibleBrands: Array<{ brand: string; offset: number }> = [];
  for (let offset = relative.payloadStart + 8; offset < relative.end; offset += 4) {
    compatibleBrands.push({ brand: ascii(bytes, offset, 4), offset });
  }
  return {
    box,
    bytes,
    majorBrand: ascii(bytes, relative.payloadStart, 4),
    compatibleBrands,
  };
}

function isDolbyVisionBrand(brand: string): boolean {
  return brand === 'dby1' || (brand.length === 4 && brand.startsWith('dv'));
}

/**
 * Carries source Dolby Vision compatibility brands into Mediabunny's fixed-size
 * ftyp without shifting mdat offsets. `isom`/ISO base brands are retained; if
 * there is no spare compatible-brand slot the operation fails closed.
 */
function patchDolbyVisionFileType(source: FileTypeBox, output: FileTypeBox): Uint8Array {
  const requiredBrands = [source.majorBrand, ...source.compatibleBrands.map(({ brand }) => brand)]
    .filter(isDolbyVisionBrand)
    .filter((brand, index, all) => all.indexOf(brand) === index);
  const existingBrands = new Set([
    output.majorBrand,
    ...output.compatibleBrands.map(({ brand }) => brand),
  ]);
  const missing = requiredBrands.filter((brand) => !existingBrands.has(brand));
  if (missing.length === 0) return output.bytes;

  const replaceable = output.compatibleBrands.filter(
    ({ brand }) =>
      !isDolbyVisionBrand(brand) && brand !== output.majorBrand && !/^iso[0-9m]$/u.test(brand),
  );
  if (replaceable.length < missing.length) {
    throw new Error('输出 ftyp 没有足够的兼容品牌槽位，无法无偏移保留 Dolby Vision 标识。');
  }

  const patched = output.bytes.slice();
  for (let index = 0; index < missing.length; index += 1) {
    const target = replaceable.at(-(index + 1));
    if (!target) throw new Error('输出 ftyp 兼容品牌槽位不足。');
    patched.set(new TextEncoder().encode(missing[index]!), target.offset);
  }
  return patched;
}

function writeBoxSize(bytes: Uint8Array, box: IsoBox, size: number): void {
  if (!Number.isSafeInteger(size) || size < box.headerSize) throw new Error('更新后的箱大小无效。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (box.extendedSize) {
    view.setBigUint64(box.start + 8, BigInt(size));
    return;
  }
  if (size > 0xffff_ffff) throw new Error('更新后的箱大小超出 32-bit 限制。');
  view.setUint32(box.start, size);
}

/**
 * Replaces Mediabunny's generic HEVC sample entry with the exact source
 * DV-bearing HEVC entry. The whole entry is transplanted so every nested decoder,
 * Dolby Vision, colour and mastering-display box is preserved byte-for-byte.
 *
 * This is safe only when all media data precedes `moov`: changing trailing
 * metadata then cannot invalidate chunk offsets into `mdat`.
 */
export async function transplantDolbyVisionSampleEntry(
  sourceVideo: Blob,
  muxedOutput: Blob,
): Promise<Blob> {
  const support = assessDolbyVisionPassthroughSource(
    await extractIsoBmffDynamicRangeEvidence(sourceVideo),
  );
  if (!support.supported) throw new Error(support.reason);
  const [source, output] = await Promise.all([
    readUniqueMoov(sourceVideo),
    readUniqueMoov(muxedOutput),
  ]);
  const [sourceFileType, outputFileType] = await Promise.all([
    readUniqueFileType(sourceVideo, source.top),
    readUniqueFileType(muxedOutput, output.top),
  ]);
  const mdats = output.top.filter((box) => box.type === 'mdat');
  if (
    mdats.length === 0 ||
    mdats.some((box) => box.end > output.box.start) ||
    output.box.end !== muxedOutput.size
  ) {
    throw new Error('输出不是 mdat-before-moov 布局，无法安全替换 Dolby Vision 样本项。');
  }

  const sourceLocation = locateVideoSampleEntry(source.bytes);
  const outputLocation = locateVideoSampleEntry(output.bytes);
  if (!SUPPORTED_SOURCE_ENTRIES.has(sourceLocation.entry.type)) {
    throw new Error('来源视频样本项不是受支持的 HEVC Dolby Vision 类型。');
  }
  if (!SUPPORTED_OUTPUT_ENTRIES.has(outputLocation.entry.type)) {
    throw new Error('临时输出不是兼容的 HEVC 视频样本项。');
  }
  const sourceDataReferenceIndex = uint16(source.bytes, sourceLocation.entry.payloadStart + 6);
  const outputDataReferenceIndex = uint16(output.bytes, outputLocation.entry.payloadStart + 6);
  if (sourceDataReferenceIndex !== 1 || outputDataReferenceIndex !== 1) {
    throw new Error('Dolby Vision 保真路径只支持 data_reference_index=1 的自包含轨道。');
  }

  const sourceEntry = source.bytes.slice(sourceLocation.entry.start, sourceLocation.entry.end);
  const replacedBytes = outputLocation.entry.end - outputLocation.entry.start;
  const delta = sourceEntry.byteLength - replacedBytes;
  const patchedMoov = new Uint8Array(output.bytes.byteLength + delta);
  patchedMoov.set(output.bytes.subarray(0, outputLocation.entry.start), 0);
  patchedMoov.set(sourceEntry, outputLocation.entry.start);
  patchedMoov.set(
    output.bytes.subarray(outputLocation.entry.end),
    outputLocation.entry.start + sourceEntry.byteLength,
  );
  for (const ancestor of outputLocation.ancestors) {
    writeBoxSize(patchedMoov, ancestor, ancestor.end - ancestor.start + delta);
  }

  const patchedFileType = patchDolbyVisionFileType(sourceFileType, outputFileType);

  return new Blob(
    [
      muxedOutput.slice(0, outputFileType.box.start),
      patchedFileType.buffer as ArrayBuffer,
      muxedOutput.slice(outputFileType.box.end, output.box.start),
      patchedMoov.buffer as ArrayBuffer,
    ],
    { type: 'video/mp4' },
  );
}

/**
 * Gate the DV compatibility view independently of callers. Generic HEVC alone
 * never becomes Dolby Vision merely because its fourCC is supported.
 */
export async function createDolbyVisionHevcCompatibilityView(sourceVideo: Blob): Promise<Blob> {
  const support = assessDolbyVisionPassthroughSource(
    await extractIsoBmffDynamicRangeEvidence(sourceVideo),
  );
  if (!support.supported) throw new Error(support.reason);
  return createHevcSampleDescriptionView(sourceVideo);
}

/**
 * Mediabunny 1.55 overwrites its decoder config while visiting every stsd entry.
 * A read-only, equal-length view exposes only the one actually used description:
 * unused entries become a sibling free box and stsc references become index 1.
 * No mdat/chunk offsets, parameter-set bytes or original source bytes change.
 * Multiple active/unknown descriptions fail closed in locateVideoSampleEntry.
 */
export async function createHevcSampleDescriptionView(sourceVideo: Blob): Promise<Blob> {
  const source = await readUniqueMoov(sourceVideo);
  const location = locateVideoSampleEntry(source.bytes);
  if (!SUPPORTED_SOURCE_ENTRIES.has(location.entry.type)) {
    throw new Error('来源视频样本项不是受支持的 HEVC Dolby Vision 类型。');
  }
  if (location.entryCount > 1 && source.top.some((box) => box.type === 'moof'))
    throw new Error('分段文件包含多个样本项，不能仅按 stsc 推断 tfhd/trex 引用。');
  if (uint16(source.bytes, location.entry.payloadStart + 6) !== 1)
    throw new Error('HEVC 读取视图只支持自包含 data_reference_index=1。');
  const compatibleType =
    location.entry.type === 'dvh1'
      ? 'hvc1'
      : location.entry.type === 'dvhe'
        ? 'hev1'
        : location.entry.type;
  if (location.entryCount === 1) {
    if (compatibleType === location.entry.type) return sourceVideo;
    const typeOffset = source.box.start + location.entry.start + 4;
    return new Blob(
      [
        sourceVideo.slice(0, typeOffset),
        new TextEncoder().encode(compatibleType),
        sourceVideo.slice(typeOffset + 4),
      ],
      { type: sourceVideo.type || 'video/mp4' },
    );
  }
  if (!location.stsc) throw new Error('多个视频样本项缺少明确的 stsc 引用。');
  const patched = source.bytes.slice();
  const entryBytes = source.bytes.slice(location.entry.start, location.entry.end);
  entryBytes.set(new TextEncoder().encode(compatibleType), 4);
  const entryStart = location.stsd.payloadStart + 8;
  const newEnd = entryStart + entryBytes.length;
  const freeSize = location.stsd.end - newEnd;
  if (freeSize < 8) throw new Error('无法在不移动媒体偏移的情况下规范样本项。');
  patched.fill(0, entryStart, location.stsd.end);
  patched.set(entryBytes, entryStart);
  writeBoxSize(patched, location.stsd, newEnd - location.stsd.start);
  const view = new DataView(patched.buffer);
  view.setUint32(location.stsd.payloadStart + 4, 1);
  view.setUint32(newEnd, freeSize);
  patched.set(new TextEncoder().encode('free'), newEnd + 4);
  const count = uint32(source.bytes, location.stsc.payloadStart + 4)!;
  for (let index = 0; index < count; index += 1)
    view.setUint32(location.stsc.payloadStart + 16 + index * 12, 1);
  return new Blob(
    [sourceVideo.slice(0, source.box.start), patched.buffer, sourceVideo.slice(source.box.end)],
    { type: sourceVideo.type || 'video/mp4' },
  );
}
