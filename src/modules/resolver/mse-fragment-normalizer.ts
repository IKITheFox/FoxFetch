import { mergeError } from '../merge/errors';

const MAX_METADATA_BOX_BYTES = 32 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 100_000;
const BLOB_COMPARE_WINDOW_BYTES = 256 * 1024;
const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_SEGMENT_ID = 0x18538067;
const WEBM_CLUSTER_ID = 0x1f43b675;
const WEBM_INFO_ID = 0x1549a966;
const WEBM_TRACKS_ID = 0x1654ae6b;

export type CapturedTrackKind = 'video' | 'audio';

export interface CapturedFragmentPart {
  id: string;
  mime: string;
  /** Global capture sequence of the first append stored for this changeType epoch. */
  firstSequence: number;
  /** Immutable stored snapshot for this one SourceBuffer/changeType epoch. */
  blob: Blob;
}

export interface CapturedFragmentNormalizationOptions {
  signal?: AbortSignal;
}

export interface NormalizedCapturedTrack {
  blob: Blob;
  mime: string;
  format: 'mp4' | 'webm';
  partCount: number;
  fragmentCount: number;
  droppedDuplicateCount: number;
  timelineStartSeconds?: number;
  timelineEndSeconds?: number;
  warnings: string[];
}

interface IsoBoxReference {
  type: string;
  start: number;
  end: number;
  headerSize: number;
}

interface MemoryBoxReference {
  type: string;
  start: number;
  end: number;
  bodyStart: number;
}

interface Mp4Initialization {
  blob: Blob;
  bytes: Uint8Array;
  trackId: number;
  timescale: number;
  defaultSampleDuration?: number;
}

interface Mp4Fragment {
  blob: Blob;
  partId: string;
  originalIndex: number;
  sequenceNumber: number;
  decodeStart: bigint;
  decodeEnd: bigint;
}

interface ParsedMp4Part {
  initialization: Mp4Initialization;
  fragments: Mp4Fragment[];
}

interface EbmlElementReference {
  id: number;
  start: number;
  end: number;
  dataStart: number;
  sizeOffset: number;
  sizeLength: number;
  unknownSize: boolean;
}

function failFormat(message: string): never {
  throw mergeError('SOURCE_FORMAT_UNSUPPORTED', message, {
    canDownloadSeparately: true,
  });
}

function failUnreadable(message: string): never {
  throw mergeError('SOURCE_UNREADABLE', message, {
    canDownloadSeparately: true,
  });
}

function failTimeline(message: string): never {
  throw mergeError('TIMELINE_MISMATCH', message, {
    canDownloadSeparately: true,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function baseMime(mime: string): string {
  return mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function formatForMime(mime: string, kind: CapturedTrackKind): 'mp4' | 'webm' {
  const normalized = baseMime(mime);
  if (normalized === `${kind}/mp4` || normalized === 'application/mp4') return 'mp4';
  if (normalized === `${kind}/webm`) return 'webm';
  if (normalized.startsWith(`${kind === 'video' ? 'audio' : 'video'}/`)) {
    failFormat(`${kind === 'video' ? '视频' : '音频'}缓存的 MIME 类型与轨道角色冲突。`);
  }
  failFormat(`暂时无法安全规范化 ${normalized || '未知格式'} 的缓存片段。`);
}

function assertPartOrder(parts: readonly CapturedFragmentPart[]): CapturedFragmentPart[] {
  if (parts.length === 0) failUnreadable('没有可规范化的缓存轨道。');
  const ids = new Set<string>();
  for (const part of parts) {
    if (!part.id || ids.has(part.id)) failFormat('缓存轨道标识缺失或重复。');
    ids.add(part.id);
    if (!Number.isSafeInteger(part.firstSequence) || part.firstSequence < 0) {
      failFormat('缓存轨道缺少可靠的 changeType 顺序。');
    }
    if (part.blob.size <= 0) failUnreadable(`缓存轨道 ${part.id} 为空。`);
  }
  return [...parts].sort(
    (left, right) => left.firstSequence - right.firstSequence || left.id.localeCompare(right.id),
  );
}

function uint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) failUnreadable('MP4 box 字段被截断。');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function uint64(bytes: Uint8Array, offset: number): bigint {
  const high = BigInt(uint32(bytes, offset));
  const low = BigInt(uint32(bytes, offset + 4));
  return (high << 32n) | low;
}

function asciiType(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.byteLength) failUnreadable('MP4 box 类型被截断。');
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function parseMemoryBoxes(bytes: Uint8Array, start: number, end: number): MemoryBoxReference[] {
  const boxes: MemoryBoxReference[] = [];
  let offset = start;
  while (offset < end) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) failFormat('MP4 box 数量异常，已停止解析。');
    if (offset + 8 > end) failUnreadable('MP4 子 box 头被截断。');
    const size32 = uint32(bytes, offset);
    const type = asciiType(bytes, offset + 4);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      const extended = uint64(bytes, offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) failFormat('MP4 box 尺寸超出安全范围。');
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    } else {
      size = size32;
    }
    if (size < headerSize || offset + size > end) failUnreadable(`MP4 ${type} box 尺寸无效。`);
    boxes.push({ type, start: offset, end: offset + size, bodyStart: offset + headerSize });
    offset += size;
  }
  return boxes;
}

async function readBlobBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  if (end - start > MAX_METADATA_BOX_BYTES) {
    failFormat('MP4 初始化或 moof 元数据过大，无法安全解析。');
  }
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

async function parseTopLevelIsoBoxes(blob: Blob): Promise<IsoBoxReference[]> {
  const boxes: IsoBoxReference[] = [];
  let offset = 0;
  while (offset < blob.size) {
    if (boxes.length >= MAX_TOP_LEVEL_BOXES) failFormat('MP4 顶层 box 数量异常，已停止解析。');
    const header = new Uint8Array(
      await blob.slice(offset, Math.min(blob.size, offset + 16)).arrayBuffer(),
    );
    if (header.byteLength < 8) failUnreadable('MP4 顶层 box 头被截断。');
    const size32 = uint32(header, 0);
    const type = asciiType(header, 4);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      if (header.byteLength < 16) failUnreadable(`MP4 ${type} 扩展 box 头被截断。`);
      const extended = uint64(header, 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) failFormat('MP4 box 尺寸超出安全范围。');
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = blob.size - offset;
    } else {
      size = size32;
    }
    if (size < headerSize || offset + size > blob.size) {
      failUnreadable(`MP4 ${type} 顶层 box 尺寸无效。`);
    }
    boxes.push({ type, start: offset, end: offset + size, headerSize });
    offset += size;
  }
  return boxes;
}

function exactlyOneBox(
  boxes: readonly MemoryBoxReference[],
  type: string,
  context: string,
): MemoryBoxReference {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length !== 1) failFormat(`${context} 必须恰好包含一个 ${type} box。`);
  return matches[0]!;
}

function parseMp4Initialization(
  initializationBlob: Blob,
  initializationBytes: Uint8Array,
  moovBytes: Uint8Array,
  moovHeaderSize: number,
  kind: CapturedTrackKind,
): Mp4Initialization {
  const moovChildren = parseMemoryBoxes(moovBytes, moovHeaderSize, moovBytes.byteLength);
  const tracks = moovChildren.filter((box) => box.type === 'trak');
  if (tracks.length !== 1) failFormat('每条缓存轨的 MP4 初始化段必须恰好描述一条轨道。');
  const track = tracks[0]!;
  const trackChildren = parseMemoryBoxes(moovBytes, track.bodyStart, track.end);
  const tkhd = exactlyOneBox(trackChildren, 'tkhd', 'MP4 trak');
  const tkhdVersion = moovBytes[tkhd.bodyStart];
  const trackIdOffset = tkhd.bodyStart + (tkhdVersion === 1 ? 20 : 12);
  const trackId = uint32(moovBytes, trackIdOffset);
  if (trackId === 0) failFormat('MP4 初始化段包含无效 track_ID。');

  const mdia = exactlyOneBox(trackChildren, 'mdia', 'MP4 trak');
  const mediaChildren = parseMemoryBoxes(moovBytes, mdia.bodyStart, mdia.end);
  const mdhd = exactlyOneBox(mediaChildren, 'mdhd', 'MP4 mdia');
  const mdhdVersion = moovBytes[mdhd.bodyStart];
  const timescaleOffset = mdhd.bodyStart + (mdhdVersion === 1 ? 20 : 12);
  const timescale = uint32(moovBytes, timescaleOffset);
  if (timescale === 0) failFormat('MP4 初始化段包含无效 timescale。');

  const hdlr = exactlyOneBox(mediaChildren, 'hdlr', 'MP4 mdia');
  const handlerType = asciiType(moovBytes, hdlr.bodyStart + 8);
  const expectedHandler = kind === 'video' ? 'vide' : 'soun';
  if (handlerType !== expectedHandler) {
    failFormat(`${kind === 'video' ? '视频' : '音频'}缓存的 MP4 handler 类型不匹配。`);
  }

  let defaultSampleDuration: number | undefined;
  const mvex = moovChildren.find((box) => box.type === 'mvex');
  if (mvex) {
    const trex = parseMemoryBoxes(moovBytes, mvex.bodyStart, mvex.end).find(
      (box) => box.type === 'trex' && uint32(moovBytes, box.bodyStart + 4) === trackId,
    );
    if (trex) {
      const candidate = uint32(moovBytes, trex.bodyStart + 12);
      if (candidate > 0) defaultSampleDuration = candidate;
    }
  }
  return {
    blob: initializationBlob,
    bytes: initializationBytes,
    trackId,
    timescale,
    ...(defaultSampleDuration == null ? {} : { defaultSampleDuration }),
  };
}

function parseTfhd(
  bytes: Uint8Array,
  box: MemoryBoxReference,
  expectedTrackId: number,
  trexDefaultDuration?: number,
): number | undefined {
  const flags = uint32(bytes, box.bodyStart) & 0x00ff_ffff;
  const trackId = uint32(bytes, box.bodyStart + 4);
  if (trackId !== expectedTrackId) failFormat('MP4 moof 的 track_ID 与初始化段不一致。');
  if ((flags & 0x000001) !== 0) {
    failFormat('MP4 片段使用绝对 base-data-offset，重排后无法保证数据偏移正确。');
  }
  if ((flags & 0x010000) !== 0) failFormat('MP4 片段声明 duration-is-empty。');

  let cursor = box.bodyStart + 8;
  if ((flags & 0x000002) !== 0) cursor += 4;
  let defaultDuration = trexDefaultDuration;
  if ((flags & 0x000008) !== 0) {
    defaultDuration = uint32(bytes, cursor);
    cursor += 4;
  }
  if ((flags & 0x000010) !== 0) cursor += 4;
  if ((flags & 0x000020) !== 0) cursor += 4;
  if (cursor > box.end) failUnreadable('MP4 tfhd 字段被截断。');
  return defaultDuration && defaultDuration > 0 ? defaultDuration : undefined;
}

function parseTfdt(bytes: Uint8Array, box: MemoryBoxReference): bigint {
  const version = bytes[box.bodyStart];
  const value =
    version === 1 ? uint64(bytes, box.bodyStart + 4) : BigInt(uint32(bytes, box.bodyStart + 4));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) failFormat('MP4 tfdt 超出安全时间范围。');
  return value;
}

function parseTrunDuration(
  bytes: Uint8Array,
  box: MemoryBoxReference,
  defaultDuration?: number,
): bigint {
  const flags = uint32(bytes, box.bodyStart) & 0x00ff_ffff;
  const sampleCount = uint32(bytes, box.bodyStart + 4);
  if (sampleCount > 10_000_000) failFormat('MP4 trun sample 数量异常。');
  let cursor = box.bodyStart + 8;
  if ((flags & 0x000001) !== 0) cursor += 4;
  if ((flags & 0x000004) !== 0) cursor += 4;
  let duration = 0n;
  for (let index = 0; index < sampleCount; index += 1) {
    if ((flags & 0x000100) !== 0) {
      duration += BigInt(uint32(bytes, cursor));
      cursor += 4;
    } else if (defaultDuration != null) {
      duration += BigInt(defaultDuration);
    } else {
      failFormat('MP4 trun 缺少 sample duration，无法证明片段连续性。');
    }
    if ((flags & 0x000200) !== 0) cursor += 4;
    if ((flags & 0x000400) !== 0) cursor += 4;
    if ((flags & 0x000800) !== 0) cursor += 4;
    if (cursor > box.end) failUnreadable('MP4 trun sample 字段被截断。');
  }
  return duration;
}

function parseMp4Fragment(
  moofBytes: Uint8Array,
  moofHeaderSize: number,
  fragmentBlob: Blob,
  initialization: Mp4Initialization,
  partId: string,
  originalIndex: number,
): Mp4Fragment {
  const children = parseMemoryBoxes(moofBytes, moofHeaderSize, moofBytes.byteLength);
  const mfhd = exactlyOneBox(children, 'mfhd', 'MP4 moof');
  const sequenceNumber = uint32(moofBytes, mfhd.bodyStart + 4);
  const trafs = children.filter((box) => box.type === 'traf');
  if (trafs.length !== 1) failFormat('每个缓存 moof 必须恰好包含一个 traf。');
  const trafChildren = parseMemoryBoxes(moofBytes, trafs[0]!.bodyStart, trafs[0]!.end);
  const tfhd = exactlyOneBox(trafChildren, 'tfhd', 'MP4 traf');
  const tfdt = exactlyOneBox(trafChildren, 'tfdt', 'MP4 traf');
  const truns = trafChildren.filter((box) => box.type === 'trun');
  if (truns.length === 0) failFormat('MP4 traf 缺少 trun。');
  const defaultDuration = parseTfhd(
    moofBytes,
    tfhd,
    initialization.trackId,
    initialization.defaultSampleDuration,
  );
  const decodeStart = parseTfdt(moofBytes, tfdt);
  const duration = truns.reduce(
    (total, trun) => total + parseTrunDuration(moofBytes, trun, defaultDuration),
    0n,
  );
  if (duration <= 0n) failFormat('MP4 moof 没有可用的媒体时长。');
  return {
    blob: fragmentBlob,
    partId,
    originalIndex,
    sequenceNumber,
    decodeStart,
    decodeEnd: decodeStart + duration,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function equalBlobs(left: Blob, right: Blob, signal?: AbortSignal): Promise<boolean> {
  if (left.size !== right.size) return false;
  for (let offset = 0; offset < left.size; offset += BLOB_COMPARE_WINDOW_BYTES) {
    throwIfAborted(signal);
    const end = Math.min(left.size, offset + BLOB_COMPARE_WINDOW_BYTES);
    const [leftBytes, rightBytes] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);
    if (!equalBytes(new Uint8Array(leftBytes), new Uint8Array(rightBytes))) return false;
  }
  return true;
}

async function parseMp4Part(
  part: CapturedFragmentPart,
  kind: CapturedTrackKind,
  originalIndexBase: number,
): Promise<ParsedMp4Part> {
  const boxes = await parseTopLevelIsoBoxes(part.blob);
  let pendingFtyp: IsoBoxReference | undefined;
  let currentInitialization: Mp4Initialization | undefined;
  let canonicalInitialization: Mp4Initialization | undefined;
  const fragments: Mp4Fragment[] = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]!;
    if (box.type === 'ftyp') {
      if (pendingFtyp) failFormat(`缓存轨道 ${part.id} 包含未闭合的重复 ftyp。`);
      pendingFtyp = box;
      continue;
    }
    if (box.type === 'moov') {
      if (!pendingFtyp) failFormat(`缓存轨道 ${part.id} 的 moov 前缺少 ftyp。`);
      const initializationBlob = part.blob.slice(pendingFtyp.start, box.end, baseMime(part.mime));
      const [initializationBytes, moovBytes] = await Promise.all([
        readBlobBytes(part.blob, pendingFtyp.start, box.end),
        readBlobBytes(part.blob, box.start, box.end),
      ]);
      currentInitialization = parseMp4Initialization(
        initializationBlob,
        initializationBytes,
        moovBytes,
        box.headerSize,
        kind,
      );
      if (
        canonicalInitialization &&
        !equalBytes(canonicalInitialization.bytes, currentInitialization.bytes)
      ) {
        failFormat(`缓存轨道 ${part.id} 包含不同的 MP4 初始化段，无法安全跨 changeType 拼接。`);
      }
      canonicalInitialization ??= currentInitialization;
      pendingFtyp = undefined;
      continue;
    }
    if (box.type === 'mdat') {
      failUnreadable(`缓存轨道 ${part.id} 包含没有对应 moof 的 mdat。`);
    }
    if (box.type !== 'moof') continue;
    if (pendingFtyp || !currentInitialization) {
      failFormat(`缓存轨道 ${part.id} 的媒体片段前缺少完整初始化段。`);
    }

    let cursor = index + 1;
    let lastMdat: IsoBoxReference | undefined;
    while (cursor < boxes.length) {
      const following = boxes[cursor]!;
      if (following.type === 'moof' || following.type === 'ftyp' || following.type === 'moov') {
        break;
      }
      if (following.type === 'mdat') lastMdat = following;
      cursor += 1;
    }
    if (!lastMdat) failUnreadable(`缓存轨道 ${part.id} 的 moof 后缺少完整 mdat。`);
    const moofBytes = await readBlobBytes(part.blob, box.start, box.end);
    const fragmentBlob = part.blob.slice(box.start, lastMdat.end, baseMime(part.mime));
    fragments.push(
      parseMp4Fragment(
        moofBytes,
        box.headerSize,
        fragmentBlob,
        currentInitialization,
        part.id,
        originalIndexBase + fragments.length,
      ),
    );
    index = cursor - 1;
  }

  if (pendingFtyp) failUnreadable(`缓存轨道 ${part.id} 的初始化段不完整。`);
  if (!canonicalInitialization) failFormat(`缓存轨道 ${part.id} 缺少 MP4 初始化段。`);
  if (fragments.length === 0) failUnreadable(`缓存轨道 ${part.id} 没有完整 moof/mdat 片段。`);
  return { initialization: canonicalInitialization, fragments };
}

async function normalizeMp4(
  parts: readonly CapturedFragmentPart[],
  kind: CapturedTrackKind,
  options: CapturedFragmentNormalizationOptions,
): Promise<NormalizedCapturedTrack> {
  const parsedParts: ParsedMp4Part[] = [];
  let originalIndexBase = 0;
  for (const part of parts) {
    throwIfAborted(options.signal);
    const parsed = await parseMp4Part(part, kind, originalIndexBase);
    parsedParts.push(parsed);
    originalIndexBase += parsed.fragments.length;
  }
  const initialization = parsedParts[0]!.initialization;
  for (const parsed of parsedParts.slice(1)) {
    if (!equalBytes(initialization.bytes, parsed.initialization.bytes)) {
      failFormat('changeType 顺序轨道使用了不同的 MP4 初始化段，无法安全合并。');
    }
  }

  const sorted = parsedParts
    .flatMap((part) => part.fragments)
    .sort(
      (left, right) =>
        (left.decodeStart < right.decodeStart
          ? -1
          : left.decodeStart > right.decodeStart
            ? 1
            : 0) ||
        left.sequenceNumber - right.sequenceNumber ||
        left.originalIndex - right.originalIndex,
    );
  const unique: Mp4Fragment[] = [];
  const identities = new Map<string, Mp4Fragment[]>();
  let droppedDuplicateCount = 0;
  for (const fragment of sorted) {
    throwIfAborted(options.signal);
    const identity = `${fragment.sequenceNumber}:${fragment.decodeStart}`;
    const candidates = identities.get(identity) ?? [];
    let duplicate = false;
    for (const candidate of candidates) {
      if (await equalBlobs(candidate.blob, fragment.blob, options.signal)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      droppedDuplicateCount += 1;
      continue;
    }
    if (candidates.length > 0) {
      failTimeline(
        `MP4 mfhd=${fragment.sequenceNumber}、tfdt=${fragment.decodeStart} 对应了不同内容，无法判断哪一份正确。`,
      );
    }
    candidates.push(fragment);
    identities.set(identity, candidates);
    unique.push(fragment);
  }

  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1]!;
    const current = unique[index]!;
    if (current.decodeStart < previous.decodeEnd) {
      failTimeline(
        `MP4 片段时间重叠：${previous.partId} [${previous.decodeStart}, ${previous.decodeEnd}) 与 ${current.partId} [${current.decodeStart}, ${current.decodeEnd})。`,
      );
    }
    if (current.decodeStart > previous.decodeEnd) {
      failTimeline(
        `MP4 缓存的播放时间不连续：${previous.decodeEnd} 到 ${current.decodeStart}。未自动删除这些片段。`,
      );
    }
  }
  const first = unique[0];
  const last = unique[unique.length - 1];
  if (!first || !last) failUnreadable('MP4 缓存没有可用的连续媒体片段。');
  const mime = `${kind}/mp4`;
  return {
    blob: new Blob([initialization.blob, ...unique.map((fragment) => fragment.blob)], {
      type: mime,
    }),
    mime,
    format: 'mp4',
    partCount: parts.length,
    fragmentCount: unique.length,
    droppedDuplicateCount,
    timelineStartSeconds: Number(first.decodeStart) / initialization.timescale,
    timelineEndSeconds: Number(last.decodeEnd) / initialization.timescale,
    warnings:
      droppedDuplicateCount > 0
        ? [`已按 mfhd/tfdt 去除 ${droppedDuplicateCount} 个字节完全相同的重复 MP4 片段。`]
        : [],
  };
}

function vintLength(firstByte: number, maximum: number): number {
  for (let length = 1; length <= maximum; length += 1) {
    if ((firstByte & (0x80 >> (length - 1))) !== 0) return length;
  }
  failFormat('WebM EBML VINT 头无效。');
}

async function readEbmlElement(
  blob: Blob,
  offset: number,
  parentEnd: number,
): Promise<EbmlElementReference> {
  const header = new Uint8Array(
    await blob.slice(offset, Math.min(parentEnd, offset + 12)).arrayBuffer(),
  );
  if (header.byteLength < 2) failUnreadable('WebM EBML 元素头被截断。');
  const idLength = vintLength(header[0]!, 4);
  if (header.byteLength <= idLength) failUnreadable('WebM EBML size 字段被截断。');
  const sizeLength = vintLength(header[idLength]!, 8);
  if (header.byteLength < idLength + sizeLength) failUnreadable('WebM EBML size 字段被截断。');
  let id = 0;
  for (let index = 0; index < idLength; index += 1) id = id * 256 + header[index]!;
  let size = BigInt(header[idLength]! & (0xff >> sizeLength));
  for (let index = 1; index < sizeLength; index += 1) {
    size = (size << 8n) | BigInt(header[idLength + index]!);
  }
  const unknownMarker = (1n << BigInt(7 * sizeLength)) - 1n;
  const unknownSize = size === unknownMarker;
  const dataStart = offset + idLength + sizeLength;
  if (!unknownSize && size > BigInt(Number.MAX_SAFE_INTEGER)) {
    failFormat('WebM EBML 元素尺寸超出安全范围。');
  }
  const end = unknownSize ? parentEnd : dataStart + Number(size);
  if (end > parentEnd || end < dataStart) failUnreadable('WebM EBML 元素尺寸无效。');
  return {
    id,
    start: offset,
    end,
    dataStart,
    sizeOffset: offset + idLength,
    sizeLength,
    unknownSize,
  };
}

function encodeEbmlSize(value: number, length: number): Uint8Array<ArrayBuffer> {
  const maximum = (1n << BigInt(7 * length)) - 1n;
  const numeric = BigInt(value);
  if (numeric >= maximum) failFormat('规范化后的 WebM Segment 尺寸无法保持原 VINT 长度。');
  let encoded = numeric | (1n << BigInt(7 * length));
  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return bytes;
}

async function normalizeWebM(
  parts: readonly CapturedFragmentPart[],
  kind: CapturedTrackKind,
  options: CapturedFragmentNormalizationOptions,
): Promise<NormalizedCapturedTrack> {
  if (parts.length !== 1) {
    failFormat('WebM changeType 多轨缺少可验证的统一初始化信息，首版不会猜测拼接。');
  }
  const source = parts[0]!.blob;
  const header = await readEbmlElement(source, 0, source.size);
  if (header.id !== EBML_HEADER_ID || header.unknownSize)
    failFormat('WebM 缓存缺少完整 EBML Header。');
  const segment = await readEbmlElement(source, header.end, source.size);
  if (segment.id !== EBML_SEGMENT_ID) failFormat('WebM 缓存缺少 Segment。');
  if (segment.end !== source.size) failFormat('WebM Segment 后存在无法归属的数据。');

  const elements: EbmlElementReference[] = [];
  let offset = segment.dataStart;
  let infoCount = 0;
  let tracksCount = 0;
  while (offset < segment.end) {
    throwIfAborted(options.signal);
    if (elements.length >= MAX_TOP_LEVEL_BOXES) failFormat('WebM Segment 元素数量异常。');
    const element = await readEbmlElement(source, offset, segment.end);
    if (element.unknownSize) failFormat('WebM 子元素使用未知长度，无法安全划分并去重。');
    if (element.id === EBML_HEADER_ID || element.id === EBML_SEGMENT_ID) {
      failFormat('WebM 缓存包含重复初始化文档，无法判断 changeType 配置是否一致。');
    }
    if (element.id === WEBM_INFO_ID) infoCount += 1;
    if (element.id === WEBM_TRACKS_ID) tracksCount += 1;
    elements.push(element);
    offset = element.end;
  }
  if (infoCount !== 1 || tracksCount !== 1) {
    failFormat('WebM 缓存必须恰好包含一组 Info 与 Tracks 初始化信息。');
  }

  const accepted: EbmlElementReference[] = [];
  const acceptedClustersBySize = new Map<number, EbmlElementReference[]>();
  let droppedDuplicateCount = 0;
  let clusterCount = 0;
  for (const element of elements) {
    if (element.id !== WEBM_CLUSTER_ID) {
      accepted.push(element);
      continue;
    }
    const size = element.end - element.start;
    const candidates = acceptedClustersBySize.get(size) ?? [];
    let duplicate = false;
    for (const candidate of candidates) {
      if (
        await equalBlobs(
          source.slice(candidate.start, candidate.end),
          source.slice(element.start, element.end),
          options.signal,
        )
      ) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      droppedDuplicateCount += 1;
      continue;
    }
    candidates.push(element);
    acceptedClustersBySize.set(size, candidates);
    accepted.push(element);
    clusterCount += 1;
  }
  if (clusterCount === 0) failUnreadable('WebM 缓存没有完整 Cluster。');
  if (droppedDuplicateCount === 0) {
    return {
      blob: source.slice(0, source.size, `${kind}/webm`),
      mime: `${kind}/webm`,
      format: 'webm',
      partCount: 1,
      fragmentCount: clusterCount,
      droppedDuplicateCount: 0,
      warnings: ['仅删除内容完全相同的重复 WebM 数据块，其他数据块的顺序保持不变。'],
    };
  }

  const retainedBytes = accepted.reduce((total, element) => total + element.end - element.start, 0);
  const prefix: BlobPart[] = segment.unknownSize
    ? [source.slice(0, segment.dataStart)]
    : [
        source.slice(0, segment.sizeOffset),
        encodeEbmlSize(retainedBytes, segment.sizeLength),
        source.slice(segment.sizeOffset + segment.sizeLength, segment.dataStart),
      ];
  const mime = `${kind}/webm`;
  return {
    blob: new Blob(
      [...prefix, ...accepted.map((element) => source.slice(element.start, element.end))],
      { type: mime },
    ),
    mime,
    format: 'webm',
    partCount: 1,
    fragmentCount: clusterCount,
    droppedDuplicateCount,
    warnings: [
      `已删除 ${droppedDuplicateCount} 个内容完全相同的重复 WebM 数据块，其他数据块的顺序保持不变。`,
    ],
  };
}

/**
 * Normalizes immutable SourceBuffer snapshots before Mediabunny sees them.
 * MP4 uses decode-time metadata (mfhd/tfdt/trun), never presentation-order
 * heuristics. WebM deliberately limits itself to exact Cluster deduplication.
 */
export async function normalizeCapturedTrackFragments(
  rawParts: readonly CapturedFragmentPart[],
  kind: CapturedTrackKind,
  options: CapturedFragmentNormalizationOptions = {},
): Promise<NormalizedCapturedTrack> {
  throwIfAborted(options.signal);
  const parts = assertPartOrder(rawParts);
  const format = formatForMime(parts[0]!.mime, kind);
  for (const part of parts.slice(1)) {
    if (formatForMime(part.mime, kind) !== format) {
      failFormat('同一 changeType 顺序轨道混用了 MP4 与 WebM，无法组成单一输入。');
    }
  }
  return format === 'mp4'
    ? normalizeMp4(parts, kind, options)
    : normalizeWebM(parts, kind, options);
}

export async function normalizeCapturedTrackPair(
  videoParts: readonly CapturedFragmentPart[],
  audioParts: readonly CapturedFragmentPart[],
  options: CapturedFragmentNormalizationOptions = {},
): Promise<{ video: NormalizedCapturedTrack; audio: NormalizedCapturedTrack }> {
  const [video, audio] = await Promise.all([
    normalizeCapturedTrackFragments(videoParts, 'video', options),
    normalizeCapturedTrackFragments(audioParts, 'audio', options),
  ]);
  return { video, audio };
}
