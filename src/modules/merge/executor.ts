import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  ConversionCanceledError,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import { planCapturedAudioRuns, planCapturedVideoGops } from './captured-timeline';
import {
  createDeferredCommitFileTarget,
  type DeferredCommitFileTarget,
} from './deferred-file-target';
import { mergeError, MergeError, normalizeMergeError } from './errors';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';
import {
  createDolbyVisionHevcCompatibilityView,
  transplantDolbyVisionSampleEntry,
} from './dolby-vision-passthrough';
import {
  extractIsoBmffDynamicRangeEvidence,
  verifyIsoBmffDynamicRangePreservation,
  type VideoPacketEquivalenceEvidence,
} from './isobmff-dynamic-range';
import { unavailableNativeFfmpegHelper } from './native-ffmpeg-helper';
import { createPrivateMergeOutput } from './private-output';
import { inspectIsoBmffTimeline } from './iso-bmff-timeline';
import { inspectFragmentPresentationTimeline } from './fragment-presentation-timeline';
import { restoreFinalPresentationDuration } from './final-presentation-duration';
import { packetTimelineMismatch } from './packet-timeline';
import { videoConfigurationDiagnostic } from './configuration-diagnostic';
import {
  prepareCapturedBlobPair,
  prepareMergePair,
  estimatedDurationAfterTimelineOrigin,
  sharedTimelineOriginSeconds,
  type CapturedBlobProbeOptions,
  type MergeProbeOptions,
  type PreparedMergePair,
} from './probe';
import type {
  CompletedRemux,
  FileSystemFileHandleLike,
  MergeContainer,
  MergePlan,
  OutputVerification,
  RemuxProgress,
  ResolvedMergeMediaMetadata,
  SeparateTrackMergeRequest,
} from './types';

export interface RemuxOptions extends MergeProbeOptions {
  onProgress?: (progress: RemuxProgress) => void;
  metadata?: ResolvedMergeMediaMetadata;
  /** Optional source ISO 639-2/T tag; absent keeps existing callers unchanged. */
  audioLanguageCode?: string;
}

export interface CapturedBlobRemuxOptions
  extends RemuxOptions, Omit<CapturedBlobProbeOptions, 'signal'> {}

export interface CapturedBlobRemuxResult {
  status: 'completed';
  container: MergeContainer;
  extension: MergePlan['extension'];
  mimeType: MergePlan['mimeType'];
  sizeBytes: number;
  durationSeconds: number | null;
}

const STAGED_SCAN_PROGRESS_SHARE = 0.24;
const OUTPUT_VERIFY_BLOB_CACHE_BYTES = 8 * 1024 * 1024;

function stagedLocalProgress(progress: RemuxProgress, downloadedBytes: number): RemuxProgress {
  if (progress.phase === 'probing') {
    return {
      ...progress,
      phase: 'muxing',
      ratio: 0,
      readBytes: downloadedBytes,
      totalBytes: downloadedBytes,
      message: '正在检查本地媒体轨道…',
    };
  }
  if (progress.phase === 'fetching') {
    return {
      ...progress,
      phase: 'muxing',
      ratio:
        progress.ratio == null ? null : Math.min(1, progress.ratio) * STAGED_SCAN_PROGRESS_SHARE,
      readBytes: downloadedBytes,
      totalBytes: downloadedBytes,
      message: '正在整理本地媒体时间线…',
    };
  }
  if (progress.phase === 'muxing') {
    return {
      ...progress,
      ratio:
        progress.ratio == null
          ? null
          : STAGED_SCAN_PROGRESS_SHARE +
            Math.min(1, progress.ratio) * (1 - STAGED_SCAN_PROGRESS_SHARE),
      readBytes: downloadedBytes,
      totalBytes: downloadedBytes,
    };
  }
  return {
    ...progress,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
  };
}

class ByteRangeCounter {
  private ranges: Array<{ start: number; end: number }> = [];

  add(start: number, end: number): number {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return this.total;
    let nextStart = start;
    let nextEnd = end;
    const merged: Array<{ start: number; end: number }> = [];
    let inserted = false;

    for (const range of this.ranges) {
      if (range.end < nextStart) {
        merged.push(range);
      } else if (nextEnd < range.start) {
        if (!inserted) {
          merged.push({ start: nextStart, end: nextEnd });
          inserted = true;
        }
        merged.push(range);
      } else {
        nextStart = Math.min(nextStart, range.start);
        nextEnd = Math.max(nextEnd, range.end);
      }
    }

    if (!inserted) merged.push({ start: nextStart, end: nextEnd });
    this.ranges = merged;
    return this.total;
  }

  get total(): number {
    return this.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  }
}

function outputFormat(container: MergeContainer): OutputFormat {
  if (container === 'mp4') return new Mp4OutputFormat({ fastStart: false });
  if (container === 'webm') return new WebMOutputFormat();
  return new MkvOutputFormat();
}

function applyOutputMetadata(output: Output, metadata: ResolvedMergeMediaMetadata | undefined) {
  if (!metadata?.title && !metadata?.cover) return;
  output.setMetadataTags({
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.cover
      ? {
          images: [
            {
              kind: 'coverFront' as const,
              mimeType: metadata.cover.mimeType,
              data: metadata.cover.data,
            },
          ],
        }
      : {}),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function report(options: RemuxOptions, progress: RemuxProgress): void {
  options.onProgress?.(progress);
}

function assertPacketCopy(output: Output, plan: MergePlan): void {
  const videoTracks = output.tracks.filter((track) => track.isVideoTrack());
  const audioTracks = output.tracks.filter((track) => track.isAudioTrack());
  const videoSource = videoTracks[0]?.source;
  const audioSource = audioTracks[0]?.source;
  if (
    videoTracks.length !== 1 ||
    audioTracks.length !== 1 ||
    !(videoSource instanceof EncodedVideoPacketSource) ||
    !(audioSource instanceof EncodedAudioPacketSource)
  ) {
    throw mergeError(
      'TRANSCODE_REQUIRED',
      `${plan.video.codec.toUpperCase()} 与 ${plan.audio.codec.toUpperCase()} 无法直接合并，目前不支持转码。`,
      { canDownloadSeparately: true },
    );
  }
}

const PACKET_TIMESTAMP_EPSILON_SECONDS = 1e-6;
const CAPTURED_AUDIO_FORWARD_GAP_SECONDS = 0.25;

interface CapturedVideoGop {
  packetCount: number;
  startTimestamp: number;
  minTimestamp: number;
  maxTimestamp: number;
  originalIndex: number;
  fingerprint: PacketFingerprint;
}

interface CapturedAudioRun {
  packetCount: number;
  startTimestamp: number;
  minTimestamp: number;
  maxTimestamp: number;
  originalIndex: number;
  fingerprint: PacketFingerprint;
}

interface PacketFingerprint {
  hashA: number;
  hashB: number;
  byteLength: number;
}

function packetEndTimestamp(packet: EncodedPacket, kind: 'video' | 'audio'): number {
  const endTimestamp = packet.timestamp + packet.duration;
  if (
    !Number.isFinite(packet.timestamp) ||
    !Number.isFinite(packet.duration) ||
    packet.duration < 0 ||
    !Number.isFinite(endTimestamp)
  ) {
    throw mergeError(
      'TIMELINE_MISMATCH',
      `${kind === 'video' ? '视频' : '音频'}缓存包含无效的 packet 时间范围。`,
      { canDownloadSeparately: true },
    );
  }
  return endTimestamp;
}

function createPacketFingerprint(): PacketFingerprint {
  return { hashA: 0x811c9dc5, hashB: 0x9747b28c, byteLength: 0 };
}

function fingerprintByte(fingerprint: PacketFingerprint, byte: number): void {
  fingerprint.hashA = Math.imul(fingerprint.hashA ^ byte, 0x01000193) >>> 0;
  fingerprint.hashB = Math.imul(fingerprint.hashB ^ byte, 0x5bd1e995) >>> 0;
  fingerprint.byteLength += 1;
}

function fingerprintInteger(fingerprint: PacketFingerprint, value: number): void {
  const normalized = Math.max(0, Math.trunc(value));
  fingerprintByte(fingerprint, normalized & 0xff);
  fingerprintByte(fingerprint, Math.floor(normalized / 0x100) & 0xff);
  fingerprintByte(fingerprint, Math.floor(normalized / 0x1_0000) & 0xff);
  fingerprintByte(fingerprint, Math.floor(normalized / 0x1_0000_00) & 0xff);
  fingerprintByte(fingerprint, Math.floor(normalized / 0x1_0000_0000) & 0xff);
  fingerprintByte(fingerprint, Math.floor(normalized / 0x1_0000_0000_00) & 0xff);
}

function fingerprintPacket(fingerprint: PacketFingerprint, packet: EncodedPacket): void {
  fingerprintByte(fingerprint, packet.type === 'key' ? 1 : 0);
  fingerprintInteger(fingerprint, Math.round((packet.timestamp + 3600) * 1_000_000));
  fingerprintInteger(fingerprint, Math.round(packet.duration * 1_000_000));
  fingerprintInteger(fingerprint, packet.byteLength);
  for (const byte of packet.data) fingerprintByte(fingerprint, byte);
  const alpha = packet.sideData.alpha;
  if (alpha) {
    fingerprintByte(fingerprint, 0xa1);
    for (const byte of alpha) fingerprintByte(fingerprint, byte);
  }
}

function packetFingerprintString(fingerprint: PacketFingerprint, packetCount: number): string {
  return [
    packetCount,
    fingerprint.byteLength,
    fingerprint.hashA.toString(16).padStart(8, '0'),
    fingerprint.hashB.toString(16).padStart(8, '0'),
  ].join(':');
}

/**
 * Finds video GOP boundaries without retaining every encoded packet. We retain
 * only compact timing/count/hash metadata. The second pass seeks back by the
 * key timestamp and streams packet bytes in the repaired presentation order.
 */
async function scanCapturedVideoGops(
  sink: EncodedPacketSink,
  throwIfCancelled: () => void,
): Promise<CapturedVideoGop[]> {
  const gops: CapturedVideoGop[] = [];
  let current: CapturedVideoGop | null = null;

  for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
    throwIfCancelled();
    const endTimestamp = packetEndTimestamp(packet, 'video');
    if (packet.type === 'key') {
      current = {
        packetCount: 0,
        startTimestamp: packet.timestamp,
        minTimestamp: packet.timestamp,
        maxTimestamp: endTimestamp,
        originalIndex: gops.length,
        fingerprint: createPacketFingerprint(),
      };
      gops.push(current);
    }

    if (!current) {
      throw mergeError(
        'TIMELINE_MISMATCH',
        '视频缓存从非关键帧开始；无损复制无法保证可解码开头，请保留分轨下载或从更早的关键帧重新捕获。',
        { canDownloadSeparately: true },
      );
    }
    current.packetCount += 1;
    fingerprintPacket(current.fingerprint, packet);
    current.minTimestamp = Math.min(current.minTimestamp, packet.timestamp);
    current.maxTimestamp = Math.max(current.maxTimestamp, endTimestamp);
  }

  return gops;
}

/**
 * Audio packets normally have monotonic PTS. A decrease marks the boundary
 * between independently appended MSE fragments/runs. Keeping just the first
 * packet and count of each run allows a memory-bounded second pass.
 */
async function scanCapturedAudioRuns(
  sink: EncodedPacketSink,
  throwIfCancelled: () => void,
): Promise<CapturedAudioRun[]> {
  const runs: CapturedAudioRun[] = [];
  let current: CapturedAudioRun | null = null;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let previousDuration = 0;

  for await (const packet of sink.packets()) {
    throwIfCancelled();
    const endTimestamp = packetEndTimestamp(packet, 'audio');
    const expectedNextTimestamp = previousTimestamp + previousDuration;
    if (
      !current ||
      packet.timestamp + PACKET_TIMESTAMP_EPSILON_SECONDS < previousTimestamp ||
      packet.timestamp - expectedNextTimestamp > CAPTURED_AUDIO_FORWARD_GAP_SECONDS
    ) {
      current = {
        packetCount: 0,
        startTimestamp: packet.timestamp,
        minTimestamp: packet.timestamp,
        maxTimestamp: endTimestamp,
        originalIndex: runs.length,
        fingerprint: createPacketFingerprint(),
      };
      runs.push(current);
    }

    current.packetCount += 1;
    fingerprintPacket(current.fingerprint, packet);
    current.minTimestamp = Math.min(current.minTimestamp, packet.timestamp);
    current.maxTimestamp = Math.max(current.maxTimestamp, endTimestamp);
    previousTimestamp = packet.timestamp;
    previousDuration = Math.max(0, packet.duration);
  }

  return runs;
}

async function packetSequence(
  sink: EncodedPacketSink,
  firstPacket: EncodedPacket,
  packetCount: number,
  visit: (packet: EncodedPacket) => Promise<void>,
): Promise<void> {
  let packet: EncodedPacket | null = firstPacket;
  for (let index = 0; index < packetCount; index += 1) {
    if (!packet) {
      throw mergeError('SOURCE_UNREADABLE', '缓存轨在时间轴整理期间提前结束。', {
        canDownloadSeparately: true,
      });
    }
    await visit(packet);
    if (index + 1 < packetCount) packet = await sink.getNextPacket(packet);
  }
}

async function* controlledPackets(
  track: InputVideoTrack | InputAudioTrack,
  options: RemuxOptions,
  dispose: () => void,
) {
  const sequence = new EncodedPacketSink(track).packets(undefined, undefined, {
    metadataOnly: true,
  });
  const packets = sequence[Symbol.asyncIterator]();
  let count = 0;
  while (true) {
    checkMergeAborted(options.signal);
    const packet = await withMergeDeadline(packets.next(), {
      ...(options.signal ? { signal: options.signal } : {}),
      stage: 'verify-output',
      onStop: dispose,
    });
    if (packet.done) return;
    count += 1;
    if (count === 1 || count % 256 === 0) {
      report(options, {
        phase: 'verifying',
        stage: 'verify-output',
        ratio: null,
        packetCount: count,
        message: '正在检查视频和音频的播放时间信息。',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    yield packet.value;
  }
}

async function verifyVideoPacketTimeline(
  track: InputVideoTrack,
  options: RemuxOptions,
  dispose: () => void,
): Promise<void> {
  let packetCount = 0;
  let currentGopMax = Number.NEGATIVE_INFINITY;
  let previousGopMax: number | null = null;

  for await (const packet of controlledPackets(track, options, dispose)) {
    if (packet.timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', '输出视频轨包含负时间戳。', {
        canDownloadSeparately: true,
      });
    }
    if (packet.type === 'key') {
      if (Number.isFinite(currentGopMax)) previousGopMax = currentGopMax;
      currentGopMax = packet.timestamp;
    } else if (packetCount === 0) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', '输出视频轨没有从关键帧开始。', {
        canDownloadSeparately: true,
      });
    }
    if (
      previousGopMax !== null &&
      packet.timestamp + PACKET_TIMESTAMP_EPSILON_SECONDS < previousGopMax
    ) {
      throw mergeError(
        'OUTPUT_TIMELINE_MISMATCH',
        `输出视频 GOP 时间戳倒退（${packet.timestamp.toFixed(6)} < ${previousGopMax.toFixed(6)}）。`,
        { canDownloadSeparately: true },
      );
    }
    currentGopMax = Math.max(currentGopMax, packet.timestamp);
    packetCount += 1;
  }

  if (packetCount === 0) {
    throw mergeError('OUTPUT_TRACK_MISMATCH', '输出视频轨没有媒体 packet。', {
      canDownloadSeparately: true,
    });
  }
}

async function verifyAudioPacketTimeline(
  track: InputAudioTrack,
  options: RemuxOptions,
  dispose: () => void,
): Promise<void> {
  let packetCount = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  for await (const packet of controlledPackets(track, options, dispose)) {
    if (
      packet.timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS ||
      packet.timestamp + PACKET_TIMESTAMP_EPSILON_SECONDS < previousTimestamp
    ) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', '输出音频轨时间戳倒退或为负数。', {
        canDownloadSeparately: true,
      });
    }
    previousTimestamp = packet.timestamp;
    packetCount += 1;
  }

  if (packetCount === 0) {
    throw mergeError('OUTPUT_TRACK_MISMATCH', '输出音频轨没有媒体 packet。', {
      canDownloadSeparately: true,
    });
  }
}

async function verifyOutputBlob(
  file: Blob,
  plan: MergePlan,
  expectedMetadata?: ResolvedMergeMediaMetadata,
  options: RemuxOptions = {},
): Promise<OutputVerification> {
  if (file.size <= 0) {
    throw mergeError('OUTPUT_PARSE_FAILED', '生成的文件为空，处理未完成。', {
      canDownloadSeparately: true,
    });
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: OUTPUT_VERIFY_BLOB_CACHE_BYTES }),
  });
  const dispose = () => input.dispose();
  options.signal?.addEventListener('abort', dispose, { once: true });
  const step = <T>(operation: Promise<T>) =>
    withMergeDeadline(operation, {
      ...(options.signal ? { signal: options.signal } : {}),
      stage: 'verify-output',
      onStop: dispose,
    });
  try {
    checkMergeAborted(options.signal);
    if (!(await step(input.canRead()))) {
      throw mergeError('OUTPUT_PARSE_FAILED', '无法重新读取生成的文件，处理未完成。', {
        canDownloadSeparately: true,
      });
    }

    const [format, videoTrack, audioTrack, metadataTags] = await step(
      Promise.all([
        input.getFormat(),
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
        input.getMetadataTags(),
      ]),
    );
    if (!videoTrack || !audioTrack) {
      throw mergeError('OUTPUT_TRACK_MISMATCH', '生成的文件缺少视频或音频。', {
        canDownloadSeparately: true,
      });
    }

    const [videoCodec, audioCodec, durationSeconds] = await step(
      Promise.all([
        videoTrack.getCodec(),
        audioTrack.getCodec(),
        input.getDurationFromMetadata([videoTrack, audioTrack]),
      ]),
    );
    if (!videoCodec || !audioCodec) {
      throw mergeError('OUTPUT_TRACK_MISMATCH', '输出轨道编码无法识别。', {
        canDownloadSeparately: true,
      });
    }
    if (videoCodec !== plan.video.codec || audioCodec !== plan.audio.codec) {
      throw mergeError(
        'OUTPUT_TRACK_MISMATCH',
        `输出编码与计划不一致（${videoCodec}/${audioCodec}），任务不会标记为成功。`,
        { canDownloadSeparately: true },
      );
    }

    await Promise.all([
      verifyVideoPacketTimeline(videoTrack, options, dispose),
      verifyAudioPacketTimeline(audioTrack, options, dispose),
    ]);
    const [videoFirstTimestamp, audioFirstTimestamp] = await Promise.all([
      videoTrack.getFirstTimestamp(),
      audioTrack.getFirstTimestamp(),
    ]);
    const expectedOffset = plan.audio.firstTimestampSeconds - plan.video.firstTimestampSeconds;
    const actualOffset = audioFirstTimestamp - videoFirstTimestamp;
    if (Math.abs(actualOffset - expectedOffset) > 0.05) {
      throw mergeError(
        'OUTPUT_AV_OFFSET_MISMATCH',
        `输出音画起点偏移异常（期望 ${expectedOffset.toFixed(3)} 秒，实际 ${actualOffset.toFixed(3)} 秒）。`,
        { canDownloadSeparately: true },
      );
    }

    if (durationSeconds !== null && plan.estimatedDurationSeconds !== null) {
      const difference = Math.abs(durationSeconds - plan.estimatedDurationSeconds);
      const tolerance = Math.max(2, Math.min(10, plan.estimatedDurationSeconds * 0.01));
      if (difference > tolerance) {
        throw mergeError(
          'OUTPUT_DURATION_MISMATCH',
          `输出时长与计划相差 ${difference.toFixed(2)} 秒，任务不会标记为成功。`,
          { canDownloadSeparately: true },
        );
      }
    }

    if (expectedMetadata?.title && metadataTags.title !== expectedMetadata.title) {
      throw mergeError('OUTPUT_METADATA_MISMATCH', '输出文件的视频标题元数据验证失败。', {
        canDownloadSeparately: true,
      });
    }
    const embeddedCover = expectedMetadata?.cover
      ? metadataTags.images?.some(
          (image) =>
            image.kind === 'coverFront' &&
            image.mimeType === expectedMetadata.cover?.mimeType &&
            equalBytes(image.data, expectedMetadata.cover.data),
        ) === true
      : false;
    if (expectedMetadata?.cover && !embeddedCover) {
      throw mergeError(
        'OUTPUT_METADATA_MISMATCH',
        'MP4 文件的封面信息未通过检查，暂不能确认保存成功。',
        {
          canDownloadSeparately: true,
        },
      );
    }

    return {
      valid: true,
      sizeBytes: file.size,
      formatName: format.name,
      videoCodec: videoCodec as VideoCodec,
      audioCodec: audioCodec as AudioCodec,
      durationSeconds,
      ...(expectedMetadata
        ? {
            metadata: {
              ...(expectedMetadata.title ? { title: expectedMetadata.title } : {}),
              coverEmbedded: embeddedCover,
            },
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof MergeError) throw error;
    throw mergeError('OUTPUT_PARSE_FAILED', '无法解析生成的文件，处理未完成。', {
      cause: error,
      canDownloadSeparately: true,
    });
  } finally {
    options.signal?.removeEventListener('abort', dispose);
    input.dispose();
  }
}

async function verifyOutput(
  handle: FileSystemFileHandleLike,
  plan: MergePlan,
  expectedMetadata?: ResolvedMergeMediaMetadata,
  options: RemuxOptions = {},
): Promise<OutputVerification> {
  return verifyOutputBlob(await handle.getFile(), plan, expectedMetadata, options);
}

/**
 * Proves that packet-copy kept the complete encoded stream and its timing. The
 * source timestamp is normalized by the same shared A/V origin used by the
 * muxer; a constant rebasing is therefore allowed, per-packet drift is not.
 */
export async function comparePacketContent(
  sourceBlob: Blob,
  outputBlob: Blob,
  kind: 'video' | 'audio',
  timelineOriginSeconds: number,
  options: RemuxOptions = {},
): Promise<VideoPacketEquivalenceEvidence> {
  const sourceInput = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(sourceBlob, { maxCacheSize: OUTPUT_VERIFY_BLOB_CACHE_BYTES }),
  });
  const outputInput = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(outputBlob, { maxCacheSize: OUTPUT_VERIFY_BLOB_CACHE_BYTES }),
  });
  let sourcePacketCount = 0;
  let outputPacketCount = 0;
  let sourceBytes = 0;
  let outputBytes = 0;
  const stage = kind === 'video' ? 'verify-video' : 'verify-audio';
  const dispose = () => {
    sourceInput.dispose();
    outputInput.dispose();
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  const step = <T>(operation: Promise<T>) =>
    withMergeDeadline(operation, {
      ...(options.signal ? { signal: options.signal } : {}),
      stage,
      onStop: dispose,
    });
  try {
    checkMergeAborted(options.signal);
    const [sourceTrack, outputTrack] = await step(
      Promise.all(
        kind === 'video'
          ? [sourceInput.getPrimaryVideoTrack(), outputInput.getPrimaryVideoTrack()]
          : [sourceInput.getPrimaryAudioTrack(), outputInput.getPrimaryAudioTrack()],
      ),
    );
    if (!sourceTrack || !outputTrack) {
      return {
        equivalent: false,
        mismatch: 'track',
        sourcePacketCount,
        outputPacketCount,
        sourceBytes,
        outputBytes,
      };
    }
    const [sourceTimescale, outputTimescale, sourceTimeline, outputTimeline] = await step(
      Promise.all([
        sourceTrack.getTimeResolution(),
        outputTrack.getTimeResolution(),
        inspectIsoBmffTimeline(sourceBlob, options.signal, kind),
        inspectIsoBmffTimeline(outputBlob, options.signal, kind),
      ]),
    );
    const outputTrackTimeline = outputTimeline?.tracks.find((track) => track.id === outputTrack.id);
    const sourceTrackTimeline = sourceTimeline?.tracks.find((track) => track.id === sourceTrack.id);
    const sourceEdit = sourceTrackTimeline?.edit;
    const fragmentTimeline =
      kind === 'video'
        ? await inspectFragmentPresentationTimeline(sourceBlob, options.signal)
        : null;
    if (
      fragmentTimeline &&
      (fragmentTimeline.trackId !== sourceTrack.id ||
        fragmentTimeline.timescale !== sourceTimescale)
    ) {
      throw mergeError('TIMELINE_MISMATCH', '来源分片时间轴与实际视频轨不一致。', {
        stage,
        reason: 'PACKET_TIMELINE_MISMATCH',
      });
    }
    const fullSourceEditOffset =
      sourceEdit && sourceTimeline
        ? (Math.round(
            (sourceEdit.emptyDuration / sourceTimeline.movieTimescale) * sourceTimescale,
          ) -
            sourceEdit.mediaTime) /
          sourceTimescale
        : 0;
    // The source here is deliberately NOT the duration-patched engine view.
    // The pinned demuxer ignores its open-ended edit, so derive the intended
    // movie PTS independently from the original edit's integer-clock mapping.
    const sourceEditOffset = sourceEdit?.openEnded ? fullSourceEditOffset : 0;
    const sourcePackets = new EncodedPacketSink(sourceTrack).packets()[Symbol.asyncIterator]();
    const outputPackets = new EncodedPacketSink(outputTrack).packets()[Symbol.asyncIterator]();
    while (true) {
      checkMergeAborted(options.signal);
      const [source, output] = await step(
        Promise.all([sourcePackets.next(), outputPackets.next()]),
      );
      if (source.done || output.done) {
        const complete =
          source.done === output.done &&
          (!fragmentTimeline || sourcePacketCount === fragmentTimeline.samples.length);
        return {
          equivalent: complete,
          ...(!complete ? { mismatch: 'count' as const } : {}),
          sourcePacketCount,
          outputPacketCount,
          sourceBytes,
          outputBytes,
        };
      }
      sourcePacketCount += 1;
      outputPacketCount += 1;
      sourceBytes += source.value.byteLength;
      outputBytes += output.value.byteLength;
      const sourceAlpha = source.value.sideData.alpha;
      const outputAlpha = output.value.sideData.alpha;
      const payloadMismatch =
        source.value.type !== output.value.type ||
        source.value.byteLength !== output.value.byteLength ||
        !equalBytes(source.value.data, output.value.data) ||
        Boolean(sourceAlpha) !== Boolean(outputAlpha) ||
        !!(sourceAlpha && outputAlpha && !equalBytes(sourceAlpha, outputAlpha));
      let sourcePresentationDuration = source.value.duration;
      if (fragmentTimeline) {
        const index = sourcePacketCount - 1;
        const nativeSample = fragmentTimeline.samples[index];
        const expectedReadTimestamp = nativeSample
          ? nativeSample.timestampTicks / sourceTimescale +
            (sourceEdit?.openEnded ? 0 : fullSourceEditOffset)
          : NaN;
        const roundoff = 32 * Number.EPSILON * Math.max(1, Math.abs(expectedReadTimestamp));
        if (
          !nativeSample ||
          nativeSample.size !== source.value.byteLength ||
          nativeSample.sequenceNumber !== source.value.sequenceNumber ||
          !Number.isFinite(expectedReadTimestamp) ||
          Math.abs(source.value.timestamp - expectedReadTimestamp) > roundoff
        ) {
          throw mergeError('TIMELINE_MISMATCH', '原始分片样本与读取到的视频包无法一一对应。', {
            stage,
            reason: 'PACKET_TIMELINE_MISMATCH',
          });
        }
        // Only a proven fragment's last presentation sample has different
        // duration semantics in the pinned demuxer. All PTS/payload checks and
        // the final presentation sample's native duration remain strict.
        const crossFragmentDuration = fragmentTimeline.tailOverrides.get(index);
        if (crossFragmentDuration !== undefined) {
          sourcePresentationDuration = crossFragmentDuration / sourceTimescale;
        }
      }
      const timelineMismatch = packetTimelineMismatch(
        {
          timestamp: source.value.timestamp + sourceEditOffset,
          duration: sourcePresentationDuration,
        },
        output.value,
        {
          track: kind,
          packetIndex: sourcePacketCount - 1,
          originSeconds: timelineOriginSeconds,
          sourceTimescale,
          outputTimescale,
          ...(outputTimeline ? { outputMovieTimescale: outputTimeline.movieTimescale } : {}),
          outputUsesEditList: outputTrackTimeline?.edit != null,
        },
      );
      if (payloadMismatch || timelineMismatch) {
        return {
          equivalent: false,
          mismatch: payloadMismatch ? 'payload' : 'timeline',
          ...(!payloadMismatch && timelineMismatch ? { timeline: timelineMismatch } : {}),
          sourcePacketCount,
          outputPacketCount,
          sourceBytes,
          outputBytes,
        };
      }
      if (sourcePacketCount === 1 || sourcePacketCount % 256 === 0) {
        report(options, {
          phase: 'verifying',
          stage,
          ratio: null,
          packetCount: sourcePacketCount,
          message: kind === 'video' ? '正在逐包核对视频及时间轴…' : '正在逐包核对音频及时间轴…',
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', dispose);
    sourceInput.dispose();
    outputInput.dispose();
  }
}

async function verifyStagedDynamicRangeOutput(
  sourceVideo: Blob,
  sourceAudio: Blob,
  output: Blob,
  completed: CompletedRemux,
  expectedMetadata?: ResolvedMergeMediaMetadata,
  options: RemuxOptions = {},
): Promise<CompletedRemux> {
  const requirement = completed.plan.dynamicRangeVerification;
  if (!requirement) return completed;

  const [sourceEvidence, outputEvidence] = await Promise.all([
    extractIsoBmffDynamicRangeEvidence(sourceVideo),
    extractIsoBmffDynamicRangeEvidence(output),
  ]);
  const configuration = {
    source: videoConfigurationDiagnostic(sourceEvidence),
    output: videoConfigurationDiagnostic(outputEvidence),
  };
  let packetSource = sourceVideo;
  let packetOutput = output;
  if (requirement.range === 'Dolby Vision') {
    try {
      [packetSource, packetOutput] = await Promise.all([
        createDolbyVisionHevcCompatibilityView(sourceVideo),
        createDolbyVisionHevcCompatibilityView(output),
      ]);
    } catch (error) {
      checkMergeAborted(options.signal);
      throw mergeError(
        'DYNAMIC_RANGE_UNVERIFIED',
        'Dolby Vision 输出配置无法通过保真读取校验，未发布文件。',
        {
          reason: 'DV_METADATA_MISMATCH',
          stage: 'verify-output',
          configuration,
          canDownloadSeparately: true,
          cause: error,
        },
      );
    }
  }
  let baseVerification: OutputVerification;
  try {
    baseVerification = await verifyOutputBlob(
      packetOutput,
      completed.plan,
      expectedMetadata,
      options,
    );
  } catch (error) {
    const normalized = normalizeMergeError(error);
    throw mergeError(normalized.detail.code, normalized.detail.message, {
      ...normalized.detail,
      configuration,
      cause: error,
    });
  }
  const timelineOriginSeconds = sharedTimelineOriginSeconds(
    completed.plan.video,
    completed.plan.audio,
  );
  const [packets, audioPackets] = await Promise.all([
    comparePacketContent(packetSource, packetOutput, 'video', timelineOriginSeconds, options),
    comparePacketContent(sourceAudio, packetOutput, 'audio', timelineOriginSeconds, options),
  ]);
  if (
    !audioPackets.equivalent ||
    audioPackets.sourcePacketCount !== audioPackets.outputPacketCount
  ) {
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      `${requirement.range} 合并输出的 AAC packet 或时间轴与来源不完全等价；未发布文件，可分别保存原始轨道。`,
      {
        reason:
          audioPackets.mismatch === 'timeline'
            ? 'PACKET_TIMELINE_MISMATCH'
            : 'AUDIO_PACKET_MISMATCH',
        stage: 'verify-audio',
        ...(audioPackets.timeline ? { timeline: audioPackets.timeline } : {}),
        configuration,
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range: requirement.range,
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
  const proof = verifyIsoBmffDynamicRangePreservation(
    requirement.range,
    sourceEvidence,
    outputEvidence,
    packets,
  );
  if (!proof.preserved) {
    throw mergeError(
      'DYNAMIC_RANGE_UNVERIFIED',
      `${requirement.range} 合并输出未通过动态范围保真验证：${proof.reason} 已验证的原始视频轨仍可分别保存。`,
      {
        reason: packets.equivalent
          ? requirement.range === 'HDR'
            ? 'HDR_METADATA_MISMATCH'
            : 'DV_METADATA_MISMATCH'
          : packets.mismatch === 'timeline'
            ? 'PACKET_TIMELINE_MISMATCH'
            : 'VIDEO_PACKET_MISMATCH',
        stage: packets.equivalent ? 'verify-output' : 'verify-video',
        ...(packets.timeline ? { timeline: packets.timeline } : {}),
        configuration,
        canDownloadSeparately: true,
        dynamicRangeCapability: {
          range: requirement.range,
          browserVerifiedMerge: false,
          originalVideoTrackFallback: true,
          nativeHelper: unavailableNativeFfmpegHelper(),
        },
      },
    );
  }
  return {
    ...completed,
    verification: {
      ...baseVerification,
      dynamicRange: {
        range: requirement.range,
        source: sourceEvidence,
        output: outputEvidence,
        packets,
        audioPackets,
      },
    },
  };
}

async function publishVerifiedBlob(
  blob: Blob,
  handle: FileSystemFileHandleLike,
  options: RemuxOptions,
): Promise<void> {
  let target: DeferredCommitFileTarget | null = null;
  let writer: WritableStreamDefaultWriter<import('mediabunny').StreamTargetChunk> | null = null;
  try {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    target = createDeferredCommitFileTarget(await handle.createWritable());
    writer = target.stream.getWriter();
    const chunkSize = 4 * 1024 * 1024;
    for (let position = 0; position < blob.size; position += chunkSize) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const data = new Uint8Array(
        await blob.slice(position, Math.min(blob.size, position + chunkSize)).arrayBuffer(),
      );
      await writer.write({ type: 'write', data, position });
      report(options, {
        phase: 'saving',
        ratio: blob.size > 0 ? Math.min(1, (position + data.byteLength) / blob.size) : 1,
        message: '保真复验通过，正在保存文件…',
      });
    }
    await writer.close();
    writer = null;
    await target.commit();
  } catch (error) {
    await writer?.abort(error).catch(() => undefined);
    await target?.abort(error).catch(() => undefined);
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw mergeError('CANCELLED', '任务已取消，未生成可保存的文件。', {
        cause: error,
        canDownloadSeparately: true,
      });
    }
    throw mergeError('OUTPUT_WRITE_FAILED', '无法将已检查的文件写入所选位置。', {
      cause: error,
      canDownloadSeparately: true,
    });
  }
}

async function remuxPreparedPairToFile(
  prepared: PreparedMergePair,
  handle: FileSystemFileHandleLike,
  options: RemuxOptions = {},
): Promise<CompletedRemux> {
  let fileTarget: DeferredCommitFileTarget | null = null;
  let output: Output | null = null;
  let videoConversion: Conversion | null = null;
  let audioConversion: Conversion | null = null;
  let cancelPromise: Promise<void> | null = null;
  let cancellationWindowOpen = true;
  let cancellationRequested = false;

  const cancel = (): Promise<void> => {
    cancelPromise ??= Promise.allSettled([
      ...(videoConversion ? [videoConversion.cancel()] : []),
      ...(audioConversion ? [audioConversion.cancel()] : []),
      ...(output ? [output.cancel()] : []),
    ]).then(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    if (!cancellationWindowOpen) return;
    cancellationRequested = true;
    prepared.dispose();
    void cancel();
  };
  const throwIfCancelled = (): void => {
    if (!options.signal?.aborted) return;
    cancellationRequested = true;
    throw new DOMException('Aborted', 'AbortError');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    throwIfCancelled();
    const writable = await handle.createWritable();
    fileTarget = createDeferredCommitFileTarget(writable);
    throwIfCancelled();
    const target = new StreamTarget(fileTarget.stream, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
    });
    output = new Output({ format: outputFormat(prepared.plan.container), target });

    const videoCodec = prepared.plan.video.codec as VideoCodec;
    const audioCodec = prepared.plan.audio.codec as AudioCodec;
    const timelineOriginSeconds = sharedTimelineOriginSeconds(
      prepared.plan.video,
      prepared.plan.audio,
    );
    videoConversion = await Conversion.init({
      input: prepared.video.input,
      output,
      tracks: 'all',
      video: (track) =>
        track === prepared.video.track
          ? { codec: videoCodec, forceTranscode: false }
          : { discard: true },
      audio: { discard: true },
      trim: { start: timelineOriginSeconds },
      composable: true,
      showWarnings: false,
    });
    audioConversion = await Conversion.init({
      input: prepared.audio.input,
      output,
      tracks: 'all',
      video: { discard: true },
      audio: (track) =>
        track === prepared.audio.track
          ? { codec: audioCodec, forceTranscode: false }
          : { discard: true },
      trim: { start: timelineOriginSeconds },
      composable: true,
      showWarnings: false,
    });

    if (
      !videoConversion.utilizedTracks.includes(prepared.video.track) ||
      !audioConversion.utilizedTracks.includes(prepared.audio.track)
    ) {
      throw mergeError('CONTAINER_INCOMPATIBLE', '媒体引擎拒绝了所选轨道。', {
        canDownloadSeparately: true,
      });
    }
    assertPacketCopy(output, prepared.plan);
    applyOutputMetadata(output, options.metadata);

    const videoByteCounter = new ByteRangeCounter();
    const audioByteCounter = new ByteRangeCounter();
    const totalBytes = prepared.plan.estimatedInputBytes;
    const reportRead = (): void => {
      const readBytes = videoByteCounter.total + audioByteCounter.total;
      report(options, {
        phase: output?.state === 'started' ? 'muxing' : 'fetching',
        ratio: totalBytes ? Math.min(1, readBytes / totalBytes) : null,
        readBytes,
        ...(totalBytes !== null ? { totalBytes } : {}),
        message: '正在读取并写入文件。',
      });
    };
    const removeVideoRead = prepared.video.source.on('read', ({ start, end }) => {
      videoByteCounter.add(start, end);
      reportRead();
    });
    const removeAudioRead = prepared.audio.source.on('read', ({ start, end }) => {
      audioByteCounter.add(start, end);
      reportRead();
    });

    const conversionRatios: [number, number] = [0, 0];
    const updateConversionProgress = (index: 0 | 1, ratio: number, processedSeconds: number) => {
      conversionRatios[index] = ratio;
      report(options, {
        phase: 'muxing',
        ratio: (conversionRatios[0] + conversionRatios[1]) / 2,
        processedSeconds,
        message: '正在无损合并视频轨与音频轨…',
      });
    };
    videoConversion.onProgress = (ratio, seconds) => updateConversionProgress(0, ratio, seconds);
    audioConversion.onProgress = (ratio, seconds) => updateConversionProgress(1, ratio, seconds);

    try {
      report(options, { phase: 'fetching', ratio: 0, message: '正在建立媒体读取流…' });
      await output.start();
      report(options, {
        phase: 'muxing',
        ratio: 0,
        message: '已确认无需转码，正在合并文件。',
      });
      await Promise.all([videoConversion.execute(), audioConversion.execute()]);
    } finally {
      removeVideoRead();
      removeAudioRead();
    }

    throwIfCancelled();
    report(options, { phase: 'saving', ratio: null, message: '正在完成容器索引并提交文件…' });
    await output.finalize();
    output = null;
    throwIfCancelled();

    // FileSystemWritableFileStream.close() is the atomic commit boundary. From this point onward
    // the UI no longer offers cancellation, and late AbortSignals cannot turn a committed file
    // into a misleading "cancelled" result.
    cancellationWindowOpen = false;
    options.signal?.removeEventListener('abort', onAbort);
    await fileTarget.commit();

    report(options, {
      phase: 'verifying',
      ratio: null,
      message: '正在重新读取文件并检查视频和音频。',
    });
    const verification = await verifyOutput(handle, prepared.plan, options.metadata, options);
    return { status: 'completed', plan: prepared.plan, verification };
  } catch (error) {
    await cancel();
    await fileTarget?.abort(error);
    if (error instanceof ConversionCanceledError || cancellationRequested) {
      throw mergeError('CANCELLED', '任务已取消，未生成已验证的完成文件。', {
        cause: error,
        canDownloadSeparately: true,
      });
    }
    throw normalizeMergeError(error);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    prepared.dispose();
  }
}

/**
 * Captured MSE blobs need a stricter packet-copy path than ordinary URL inputs.
 * SourceBuffer may append a later fragment and then an earlier fragment after a
 * seek (for example 0 -> 20 -> 15 seconds). Conversion preserves that physical
 * order, which makes the muxer reject the regressing GOP. This path performs a
 * memory-bounded discovery pass and then streams packets in repaired timeline
 * order without decoding or re-encoding either track.
 */
async function remuxCapturedPreparedPairToFile(
  prepared: PreparedMergePair,
  handle: FileSystemFileHandleLike,
  options: RemuxOptions = {},
): Promise<CompletedRemux> {
  let fileTarget: DeferredCommitFileTarget | null = null;
  let output: Output | null = null;
  let cancelPromise: Promise<void> | null = null;
  let cancellationWindowOpen = true;
  let cancellationRequested = false;

  const cancel = (): Promise<void> => {
    cancelPromise ??= Promise.allSettled(output ? [output.cancel()] : []).then(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    if (!cancellationWindowOpen) return;
    cancellationRequested = true;
    prepared.dispose();
    void cancel();
  };
  const throwIfCancelled = (): void => {
    if (!options.signal?.aborted) return;
    cancellationRequested = true;
    throw new DOMException('Aborted', 'AbortError');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const videoByteCounter = new ByteRangeCounter();
  const audioByteCounter = new ByteRangeCounter();
  const totalBytes = prepared.plan.estimatedInputBytes;
  let scanningTimeline = true;
  const reportRead = (): void => {
    if (!scanningTimeline) return;
    const readBytes = videoByteCounter.total + audioByteCounter.total;
    report(options, {
      phase: 'fetching',
      ratio: totalBytes ? Math.min(1, readBytes / totalBytes) : null,
      readBytes,
      ...(totalBytes !== null ? { totalBytes } : {}),
      message: '正在整理缓存时间轴…',
    });
  };
  const removeVideoRead = prepared.video.source.on('read', ({ start, end }) => {
    videoByteCounter.add(start, end);
    reportRead();
  });
  const removeAudioRead = prepared.audio.source.on('read', ({ start, end }) => {
    audioByteCounter.add(start, end);
    reportRead();
  });

  try {
    throwIfCancelled();
    report(options, {
      phase: 'fetching',
      ratio: 0,
      message: '正在识别并整理缓存中的 GOP 与音频区间…',
    });

    const videoSink = new EncodedPacketSink(prepared.video.track);
    const audioSink = new EncodedPacketSink(prepared.audio.track);
    const [videoGops, audioRuns, videoDecoderConfig, audioDecoderConfig, rotation] =
      await Promise.all([
        scanCapturedVideoGops(videoSink, throwIfCancelled),
        scanCapturedAudioRuns(audioSink, throwIfCancelled),
        prepared.video.track.getDecoderConfig(),
        prepared.audio.track.getDecoderConfig(),
        prepared.video.track.getRotation(),
      ]);
    scanningTimeline = false;
    throwIfCancelled();

    const videoPlan = planCapturedVideoGops(
      videoGops.map((gop) => ({
        value: gop,
        originalIndex: gop.originalIndex,
        startTimestamp: gop.startTimestamp,
        maxTimestamp: gop.maxTimestamp,
        fingerprint: packetFingerprintString(gop.fingerprint, gop.packetCount),
      })),
    );
    const audioPlan = planCapturedAudioRuns(
      audioRuns.map((run) => ({
        value: run,
        originalIndex: run.originalIndex,
        startTimestamp: run.startTimestamp,
        maxTimestamp: run.maxTimestamp,
        fingerprint: packetFingerprintString(run.fingerprint, run.packetCount),
      })),
    );
    if (videoPlan.conflictingOverlapCount > 0 || audioPlan.conflictingOverlapCount > 0) {
      throw mergeError(
        'TIMELINE_MISMATCH',
        `检测到 ${videoPlan.conflictingOverlapCount} 个视频 GOP、${audioPlan.conflictingOverlapCount} 个音频区间发生内容不同的时间重叠；为避免丢帧或音画错位，不会把它当作重复缓存。`,
        { canDownloadSeparately: true },
      );
    }
    if (videoPlan.ordered.length === 0 || audioPlan.ordered.length === 0) {
      throw mergeError(
        videoPlan.ordered.length === 0 ? 'VIDEO_TRACK_MISSING' : 'AUDIO_TRACK_MISSING',
        '缓存轨没有可安全复制的完整媒体 packet。',
        { canDownloadSeparately: true },
      );
    }

    const timelineOrigin = Math.min(
      ...videoPlan.ordered.map(({ value }) => value.minTimestamp),
      ...audioPlan.ordered.map(({ value }) => value.minTimestamp),
    );
    if (!Number.isFinite(timelineOrigin)) {
      throw mergeError('TIMELINE_MISMATCH', '缓存轨缺少有效时间戳。', {
        canDownloadSeparately: true,
      });
    }
    const repairedPlan: MergePlan = {
      ...prepared.plan,
      estimatedDurationSeconds: estimatedDurationAfterTimelineOrigin(
        prepared.plan.video,
        prepared.plan.audio,
        timelineOrigin,
      ),
      warnings: [
        ...prepared.plan.warnings,
        '本地缓存已按共同时间原点整理；视频 GOP 与音频区间保持原始相对时间。',
      ],
    };

    const writable = await handle.createWritable();
    fileTarget = createDeferredCommitFileTarget(writable);
    throwIfCancelled();
    const target = new StreamTarget(fileTarget.stream, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
    });
    output = new Output({ format: outputFormat(prepared.plan.container), target });

    const videoSource = new EncodedVideoPacketSource(prepared.plan.video.codec as VideoCodec);
    const audioSource = new EncodedAudioPacketSource(prepared.plan.audio.codec as AudioCodec);
    output.addVideoTrack(videoSource, {
      rotation,
      ...(videoDecoderConfig ? { decoderConfig: videoDecoderConfig } : {}),
    });
    output.addAudioTrack(audioSource, {
      ...(audioDecoderConfig ? { decoderConfig: audioDecoderConfig } : {}),
      ...(options.audioLanguageCode ? { languageCode: options.audioLanguageCode } : {}),
    });

    applyOutputMetadata(output, options.metadata);

    await output.start();
    report(options, {
      phase: 'muxing',
      ratio: 0,
      message:
        videoPlan.droppedDuplicateCount + audioPlan.droppedDuplicateCount > 0
          ? `已按原始时间轴排序，并去除 ${videoPlan.droppedDuplicateCount} 个重复 GOP、${audioPlan.droppedDuplicateCount} 个重复音频区间。`
          : '已按原始播放顺序整理数据，正在合并文件。',
    });

    let processedSeconds = 0;
    let lastReportedSeconds = 0;
    const reportPacket = (endTimestamp: number): void => {
      processedSeconds = Math.max(processedSeconds, endTimestamp);
      if (processedSeconds - lastReportedSeconds < 0.25) return;
      lastReportedSeconds = processedSeconds;
      report(options, {
        phase: 'muxing',
        ratio:
          repairedPlan.estimatedDurationSeconds && repairedPlan.estimatedDurationSeconds > 0
            ? Math.min(1, processedSeconds / repairedPlan.estimatedDurationSeconds)
            : null,
        processedSeconds,
        message: '正在按修复后的共同时间轴无损合并…',
      });
    };

    const pumpVideo = async (): Promise<void> => {
      let sequenceNumber = 0;
      let firstPacket = true;
      try {
        for (const plannedGop of videoPlan.ordered) {
          throwIfCancelled();
          const startPacket = await videoSink.getKeyPacket(plannedGop.startTimestamp, {
            verifyKeyPackets: true,
          });
          if (
            !startPacket ||
            Math.abs(startPacket.timestamp - plannedGop.startTimestamp) >
              PACKET_TIMESTAMP_EPSILON_SECONDS
          ) {
            throw mergeError('SOURCE_UNREADABLE', '无法重新定位已排序的视频 GOP。', {
              canDownloadSeparately: true,
            });
          }
          await packetSequence(
            videoSink,
            startPacket,
            plannedGop.value.packetCount,
            async (packet) => {
              throwIfCancelled();
              const timestamp = packet.timestamp - timelineOrigin;
              if (timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS) {
                throw mergeError('TIMELINE_MISMATCH', '视频缓存包含无法归一化的负时间戳。', {
                  canDownloadSeparately: true,
                });
              }
              const repairedPacket = packet.clone({
                timestamp: Math.max(0, timestamp),
                sequenceNumber,
              });
              sequenceNumber += 1;
              await videoSource.add(
                repairedPacket,
                firstPacket && videoDecoderConfig
                  ? { decoderConfig: videoDecoderConfig }
                  : undefined,
              );
              firstPacket = false;
              reportPacket(repairedPacket.timestamp + repairedPacket.duration);
            },
          );
        }
      } finally {
        videoSource.close();
      }
    };

    const pumpAudio = async (): Promise<void> => {
      let sequenceNumber = 0;
      let firstPacket = true;
      try {
        for (const plannedRun of audioPlan.ordered) {
          throwIfCancelled();
          const startPacket = await audioSink.getPacket(plannedRun.startTimestamp);
          if (
            !startPacket ||
            Math.abs(startPacket.timestamp - plannedRun.startTimestamp) >
              PACKET_TIMESTAMP_EPSILON_SECONDS
          ) {
            throw mergeError('SOURCE_UNREADABLE', '无法重新定位已排序的音频区间。', {
              canDownloadSeparately: true,
            });
          }
          await packetSequence(
            audioSink,
            startPacket,
            plannedRun.value.packetCount,
            async (packet) => {
              throwIfCancelled();
              const timestamp = packet.timestamp - timelineOrigin;
              if (timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS) {
                throw mergeError('TIMELINE_MISMATCH', '音频缓存包含无法归一化的负时间戳。', {
                  canDownloadSeparately: true,
                });
              }
              const repairedPacket = packet.clone({
                timestamp: Math.max(0, timestamp),
                sequenceNumber,
              });
              sequenceNumber += 1;
              await audioSource.add(
                repairedPacket,
                firstPacket && audioDecoderConfig
                  ? { decoderConfig: audioDecoderConfig }
                  : undefined,
              );
              firstPacket = false;
              reportPacket(repairedPacket.timestamp + repairedPacket.duration);
            },
          );
        }
      } finally {
        audioSource.close();
      }
    };

    await Promise.all([pumpVideo(), pumpAudio()]);
    throwIfCancelled();
    report(options, { phase: 'saving', ratio: null, message: '正在完成容器索引并提交文件…' });
    await output.finalize();
    output = null;
    throwIfCancelled();

    cancellationWindowOpen = false;
    options.signal?.removeEventListener('abort', onAbort);
    await fileTarget.commit();

    report(options, {
      phase: 'verifying',
      ratio: null,
      message: '正在重新读取文件并检查视频和音频。',
    });
    const verification = await verifyOutput(handle, repairedPlan, options.metadata, options);
    return { status: 'completed', plan: repairedPlan, verification };
  } catch (error) {
    await cancel();
    await fileTarget?.abort(error);
    if (cancellationRequested) {
      throw mergeError('CANCELLED', '任务已取消，未生成已验证的完成文件。', {
        cause: error,
        canDownloadSeparately: true,
      });
    }
    throw normalizeMergeError(error);
  } finally {
    removeVideoRead();
    removeAudioRead();
    options.signal?.removeEventListener('abort', onAbort);
    prepared.dispose();
  }
}

export async function remuxSeparateTracksToFile(
  request: SeparateTrackMergeRequest,
  handle: FileSystemFileHandleLike,
  options: RemuxOptions = {},
): Promise<CompletedRemux> {
  report(options, {
    phase: 'probing',
    ratio: null,
    message: '正在重新确认来源、DRM 与轨道信息…',
  });
  const prepared = await prepareMergePair(request, options);
  return remuxPreparedPairToFile(prepared, handle, options);
}

export async function remuxCapturedBlobsToFile(
  videoBlob: Blob,
  audioBlob: Blob,
  handle: FileSystemFileHandleLike,
  options: CapturedBlobRemuxOptions = {},
): Promise<CapturedBlobRemuxResult> {
  report(options, {
    phase: 'probing',
    ratio: null,
    message: '正在检查本地缓存轨、DRM 与时间轴…',
  });
  const prepared = await prepareCapturedBlobPair(videoBlob, audioBlob, options);
  const completed = await remuxCapturedPreparedPairToFile(prepared, handle, options);
  return {
    status: 'completed',
    container: completed.plan.container,
    extension: completed.plan.extension,
    mimeType: completed.plan.mimeType,
    sizeBytes: completed.verification.sizeBytes,
    durationSeconds: completed.verification.durationSeconds,
  };
}

/**
 * Remuxes complete URL representations that have already been downloaded in
 * source order to local durable storage. These are ordinary media files, not
 * append-order MSE captures, so they must preserve every source packet and must
 * not pass through captured-fragment overlap repair. Local inspection and
 * packet-copy are projected onto one continuous mux phase; the preceding
 * network download remains a separate fetching phase.
 */
export async function remuxStagedBlobsToFile(
  videoBlob: Blob,
  audioBlob: Blob,
  handle: FileSystemFileHandleLike,
  downloadedBytes: number,
  options: CapturedBlobRemuxOptions = {},
): Promise<CompletedRemux> {
  report(options, {
    phase: 'muxing',
    ratio: 0,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
    message: '下载完成，正在检查本地媒体轨道…',
  });
  const { onProgress, ...forwardedOptions } = options;
  const remuxOptions: RemuxOptions = {
    ...forwardedOptions,
    ...(onProgress
      ? {
          onProgress: (progress: RemuxProgress) =>
            onProgress(stagedLocalProgress(progress, downloadedBytes)),
        }
      : {}),
  };
  const prepared = await prepareCapturedBlobPair(videoBlob, audioBlob, {
    ...options,
    ...remuxOptions,
    allowDolbyVisionPassthrough: true,
  });

  let fragmentTimeline: Awaited<ReturnType<typeof inspectFragmentPresentationTimeline>> = null;
  try {
    if (prepared.plan.dynamicRangeVerification) {
      fragmentTimeline = await inspectFragmentPresentationTimeline(videoBlob, options.signal);
    }
  } catch (error) {
    prepared.dispose();
    throw error;
  }
  const isDolbyVision = prepared.plan.dynamicRangeVerification?.range === 'Dolby Vision';
  if (isDolbyVision || fragmentTimeline) {
    const dynamicRange = prepared.plan.dynamicRangeVerification!;
    let privateOutput: Awaited<ReturnType<typeof createPrivateMergeOutput>> | null = null;
    let handedToRemuxer = false;
    try {
      privateOutput = await createPrivateMergeOutput();
      handedToRemuxer = true;
      const completed = await remuxPreparedPairToFile(prepared, privateOutput.handle, remuxOptions);
      const temporaryBlob = await privateOutput.getBlob();
      let restoredBlob: Blob = temporaryBlob;
      try {
        if (isDolbyVision) {
          report(options, {
            phase: 'verifying',
            stage: 'dv-restore',
            ratio: null,
            message: '正在恢复并检查 Dolby Vision 配置…',
          });
          restoredBlob = await transplantDolbyVisionSampleEntry(videoBlob, temporaryBlob);
        }
      } catch (error) {
        throw mergeError(
          'DYNAMIC_RANGE_UNVERIFIED',
          '无法安全恢复 Dolby Vision 视频样本项；未发布合并文件，可分别保存原始轨道。',
          {
            reason: 'DV_RESTORE_FAILED',
            stage: 'dv-restore',
            cause: error,
            canDownloadSeparately: true,
            dynamicRangeCapability: {
              range: 'Dolby Vision',
              browserVerifiedMerge: false,
              originalVideoTrackFallback: true,
              nativeHelper: unavailableNativeFfmpegHelper(),
            },
          },
        );
      }
      if (fragmentTimeline) {
        const sourceTimeline = await inspectIsoBmffTimeline(videoBlob, options.signal, 'video');
        const edit = sourceTimeline?.tracks.find(
          (track) => track.id === fragmentTimeline.trackId,
        )?.edit;
        const editOffset =
          edit && sourceTimeline
            ? (Math.round(
                (edit.emptyDuration / sourceTimeline.movieTimescale) * fragmentTimeline.timescale,
              ) -
                edit.mediaTime) /
              fragmentTimeline.timescale
            : 0;
        const origin = sharedTimelineOriginSeconds(prepared.plan.video, prepared.plan.audio);
        const final = fragmentTimeline.finalPresentation;
        report(options, {
          phase: 'verifying',
          stage: 'verify-video',
          ratio: null,
          message: '正在保留最后呈现帧的原始结束时间…',
        });
        restoredBlob = await restoreFinalPresentationDuration(
          restoredBlob,
          {
            sampleIndex: final.index,
            sampleCount: fragmentTimeline.samples.length,
            timescale: fragmentTimeline.timescale,
            durationTicks: final.durationTicks,
            timestampSeconds:
              final.timestampTicks / fragmentTimeline.timescale + editOffset - origin,
          },
          options.signal,
        );
      }
      report(options, {
        phase: 'verifying',
        ratio: null,
        readBytes: downloadedBytes,
        totalBytes: downloadedBytes,
        message: '正在复验动态范围配置、完整视频包与呈现时间轴…',
      });
      let verified: CompletedRemux;
      try {
        verified = await verifyStagedDynamicRangeOutput(
          videoBlob,
          audioBlob,
          restoredBlob,
          completed,
          options.metadata,
          options,
        );
      } catch (error) {
        if (error instanceof MergeError) throw error;
        throw mergeError(
          'DYNAMIC_RANGE_UNVERIFIED',
          `${dynamicRange.range} 合并输出无法完成严格复验；未发布文件，可分别保存原始轨道。`,
          {
            reason: 'VERIFICATION_INCOMPLETE',
            stage: 'verify-output',
            cause: error,
            canDownloadSeparately: true,
            dynamicRangeCapability: {
              range: dynamicRange.range,
              browserVerifiedMerge: false,
              originalVideoTrackFallback: true,
              nativeHelper: unavailableNativeFfmpegHelper(),
            },
          },
        );
      }
      // The user-visible destination is not opened until all strict evidence
      // checks above have succeeded.
      await publishVerifiedBlob(restoredBlob, handle, options);
      report(options, {
        phase: 'verifying',
        ratio: null,
        readBytes: downloadedBytes,
        totalBytes: downloadedBytes,
        message: '正在复核最终保存的动态范围视频文件…',
      });
      try {
        return await verifyStagedDynamicRangeOutput(
          videoBlob,
          audioBlob,
          await handle.getFile(),
          verified,
          options.metadata,
          options,
        );
      } catch (error) {
        if (error instanceof MergeError) throw error;
        throw mergeError(
          'OUTPUT_VERIFY_FAILED',
          `最终保存的 ${dynamicRange.range} 文件未通过读回复验，任务不会标记为成功。`,
          {
            cause: error,
            canDownloadSeparately: true,
            reason: 'OUTPUT_READBACK_FAILED',
            stage: 'verify-output',
          },
        );
      }
    } finally {
      if (!handedToRemuxer) prepared.dispose();
      await privateOutput?.remove().catch(() => undefined);
    }
  }

  const completed = await remuxPreparedPairToFile(prepared, handle, remuxOptions);
  report(options, {
    phase: 'verifying',
    ratio: null,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
    message: completed.plan.dynamicRangeVerification
      ? `正在核对 ${completed.plan.dynamicRangeVerification.range} 配置、色彩元数据与视频 packet…`
      : '正在完成文件检查。',
  });
  return verifyStagedDynamicRangeOutput(
    videoBlob,
    audioBlob,
    await handle.getFile(),
    completed,
    options.metadata,
    options,
  );
}
