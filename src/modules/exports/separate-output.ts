import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import {
  ALL_FORMATS,
  BlobSource,
  canEncodeAudio,
  Conversion,
  ConversionCanceledError,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';

import {
  createDeferredCommitFileTarget,
  detectIsoBmffBlobDrm,
  mergeError,
  MergeError,
  normalizeMergeError,
  prepareCapturedAudioTrack,
  prepareCapturedVideoTrack,
  type CapturedBlobProbeOptions,
  type FileSystemFileHandleLike,
  type MergeFailureDetail,
  type RemuxProgress,
  type ResolvedMergeMediaMetadata,
} from '../merge';
import { extractIsoBmffDynamicRangeEvidence } from '../merge/isobmff-dynamic-range';
import { exportOriginalAudioTrack, inspectOriginalAudioTrack } from './original-audio';
import type {
  CompletedStandardSeparateExport,
  CompletedStandardSeparateOutput,
  StandardSeparateOutputKind,
  StandardSeparateOutputOutcome,
  StandardSeparateOutputVerification,
} from './types';

export interface StandardSeparateOutputHandles {
  video: FileSystemFileHandleLike;
  audio: FileSystemFileHandleLike;
}

export interface StandardSeparateExportOptions extends CapturedBlobProbeOptions {
  /** Pair export defaults to original; the legacy cache-track entry defaults to MP3. */
  audioOutput?: 'original' | 'mp3';
  onProgress?: (progress: RemuxProgress) => void;
  metadata?: ResolvedMergeMediaMetadata;
}

const STANDARD_VIDEO_CODECS = new Set<VideoCodec>(['avc', 'hevc', 'av1']);
const VERIFY_BLOB_CACHE_BYTES = 8 * 1024 * 1024;
const PACKET_TIMESTAMP_EPSILON_SECONDS = 1e-6;
const MP3_BITRATE = 192_000;
const MP3_SAMPLE_RATES = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000];
const ORIGINAL_COPY_CHUNK_BYTES = 4 * 1024 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function expectedDuration(
  durationSeconds: number | null,
  firstTimestampSeconds: number,
): number | null {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) return null;
  return Math.max(0, durationSeconds - Math.max(0, firstTimestampSeconds));
}

function durationTolerance(durationSeconds: number): number {
  return Math.max(2, Math.min(10, durationSeconds * 0.01));
}

async function verifyVideoTimeline(track: InputVideoTrack): Promise<void> {
  const sink = new EncodedPacketSink(track);
  let packetCount = 0;
  let currentGopMax = Number.NEGATIVE_INFINITY;
  let previousGopMax: number | null = null;

  for await (const packet of sink.packets(undefined, undefined, {
    verifyKeyPackets: true,
  })) {
    if (packet.timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', '单轨 MP4 包含负时间戳。');
    }
    if (packet.type === 'key') {
      if (packetCount === 0 && packet.timestamp > PACKET_TIMESTAMP_EPSILON_SECONDS) {
        throw mergeError('OUTPUT_TIMELINE_MISMATCH', '单轨 MP4 未从零时间附近的关键帧开始。');
      }
      previousGopMax = packetCount === 0 ? null : currentGopMax;
      currentGopMax = packet.timestamp;
    }
    if (packetCount === 0 && packet.type !== 'key') {
      throw mergeError('OUTPUT_TRACK_MISMATCH', '单轨 MP4 未从可独立解码的关键帧开始。');
    }
    if (
      previousGopMax !== null &&
      packet.timestamp + PACKET_TIMESTAMP_EPSILON_SECONDS < previousGopMax
    ) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', '单轨 MP4 的 GOP 时间戳发生倒退。');
    }
    currentGopMax = Math.max(currentGopMax, packet.timestamp);
    packetCount += 1;
  }

  if (packetCount === 0) {
    throw mergeError('OUTPUT_TRACK_MISMATCH', '单轨 MP4 没有媒体 packet。');
  }
}

async function verifyAudioTimeline(track: InputAudioTrack): Promise<void> {
  const sink = new EncodedPacketSink(track);
  let packetCount = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    if (
      packet.timestamp < -PACKET_TIMESTAMP_EPSILON_SECONDS ||
      packet.timestamp + PACKET_TIMESTAMP_EPSILON_SECONDS < previousTimestamp
    ) {
      throw mergeError('OUTPUT_TIMELINE_MISMATCH', 'MP3 输出时间戳倒退或为负数。');
    }
    previousTimestamp = packet.timestamp;
    packetCount += 1;
  }
  if (packetCount === 0) throw mergeError('OUTPUT_TRACK_MISMATCH', 'MP3 输出没有音频帧。');
}

async function verifyStandardOutput(
  handle: FileSystemFileHandleLike,
  kind: StandardSeparateOutputKind,
  expectedCodec: VideoCodec | AudioCodec,
  expectedDurationSeconds: number | null,
  expectedMetadata?: ResolvedMergeMediaMetadata,
): Promise<StandardSeparateOutputVerification> {
  const file = await handle.getFile();
  if (file.size <= 0) throw mergeError('OUTPUT_PARSE_FAILED', '标准分轨输出为空。');

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: VERIFY_BLOB_CACHE_BYTES }),
  });
  try {
    if (!(await input.canRead()))
      throw mergeError('OUTPUT_PARSE_FAILED', '标准分轨输出无法重新打开。');
    const [format, tracks, videoTrack, audioTrack, metadataTags] = await Promise.all([
      input.getFormat(),
      input.getTracks(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.getMetadataTags(),
    ]);
    if (tracks.length !== 1) {
      throw mergeError('OUTPUT_TRACK_MISMATCH', '标准分轨输出必须且只能包含一条媒体轨。');
    }

    const track = kind === 'video' ? videoTrack : audioTrack;
    if (!track || (kind === 'video' ? audioTrack !== null : videoTrack !== null)) {
      throw mergeError(
        'OUTPUT_TRACK_MISMATCH',
        kind === 'video' ? 'MP4 输出不是纯视频单轨文件。' : 'MP3 输出不是纯音频单轨文件。',
      );
    }
    const [codec, durationSeconds] = await Promise.all([
      track.getCodec(),
      input.getDurationFromMetadata([track]),
    ]);
    if (codec !== expectedCodec) {
      throw mergeError(
        'OUTPUT_TRACK_MISMATCH',
        `标准分轨输出编码不符（期望 ${expectedCodec}，实际 ${codec ?? '未知'}）。`,
      );
    }
    if (kind === 'video') await verifyVideoTimeline(track as InputVideoTrack);
    else await verifyAudioTimeline(track as InputAudioTrack);

    if (durationSeconds !== null && expectedDurationSeconds !== null) {
      const difference = Math.abs(durationSeconds - expectedDurationSeconds);
      if (difference > durationTolerance(expectedDurationSeconds)) {
        throw mergeError(
          'OUTPUT_DURATION_MISMATCH',
          `标准分轨输出时长与来源相差 ${difference.toFixed(2)} 秒。`,
        );
      }
    }
    if (expectedMetadata?.title && metadataTags.title !== expectedMetadata.title) {
      throw mergeError('OUTPUT_METADATA_MISMATCH', '标准分轨输出的标题元数据验证失败。');
    }
    if (kind === 'video' && expectedMetadata?.cover) {
      const expectedCover = expectedMetadata.cover;
      const coverEmbedded = metadataTags.images?.some((image) => {
        if (
          image.kind !== 'coverFront' ||
          image.mimeType !== expectedCover.mimeType ||
          image.data.byteLength !== expectedCover.data.byteLength
        ) {
          return false;
        }
        return image.data.every((byte, index) => byte === expectedCover.data[index]);
      });
      if (!coverEmbedded) {
        throw mergeError('OUTPUT_METADATA_MISMATCH', '视频 MP4 未通过封面元数据复验。');
      }
    }
    return {
      valid: true,
      sizeBytes: file.size,
      formatName: format.name,
      codec,
      durationSeconds,
    };
  } catch (error) {
    if (error instanceof MergeError) throw error;
    throw mergeError(
      'OUTPUT_PARSE_FAILED',
      `标准分轨输出解析失败${error instanceof Error && error.message ? `：${error.message}` : ''}。`,
      { cause: error },
    );
  } finally {
    input.dispose();
  }
}

interface ExecuteConversionOptions {
  kind: StandardSeparateOutputKind;
  input: Input;
  handle: FileSystemFileHandleLike;
  format: OutputFormat;
  configure: (output: Output) => Promise<Conversion>;
  expectedCodec: VideoCodec | AudioCodec;
  expectedDurationSeconds: number | null;
  signal?: AbortSignal;
  onProgress?: (ratio: number, processedSeconds: number) => void;
  metadata?: ResolvedMergeMediaMetadata;
}

async function executeConversion(
  options: ExecuteConversionOptions,
): Promise<StandardSeparateOutputVerification> {
  let output: Output | null = null;
  let conversion: Conversion | null = null;
  let fileTarget: ReturnType<typeof createDeferredCommitFileTarget> | null = null;
  let cancellationRequested = false;
  let cancellationWindowOpen = true;
  let cancelPromise: Promise<void> | null = null;
  const cancel = (): Promise<void> => {
    cancelPromise ??= Promise.allSettled([
      ...(conversion ? [conversion.cancel()] : []),
      ...(output ? [output.cancel()] : []),
    ]).then(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    if (!cancellationWindowOpen) return;
    cancellationRequested = true;
    void cancel();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    throwIfAborted(options.signal);
    const writable = await options.handle.createWritable();
    fileTarget = createDeferredCommitFileTarget(writable);
    const target = new StreamTarget(fileTarget.stream, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
    });
    output = new Output({ format: options.format, target });
    conversion = await options.configure(output);
    if (options.metadata?.title || options.metadata?.cover) {
      output.setMetadataTags({
        ...(options.metadata.title ? { title: options.metadata.title } : {}),
        ...(options.kind === 'video' && options.metadata.cover
          ? {
              images: [
                {
                  kind: 'coverFront' as const,
                  mimeType: options.metadata.cover.mimeType,
                  data: options.metadata.cover.data,
                },
              ],
            }
          : {}),
      });
    }
    conversion.onProgress = (ratio, seconds) => options.onProgress?.(ratio, seconds);
    throwIfAborted(options.signal);
    await output.start();
    await conversion.execute();
    throwIfAborted(options.signal);
    await output.finalize();
    output = null;
    throwIfAborted(options.signal);
    cancellationWindowOpen = false;
    options.signal?.removeEventListener('abort', onAbort);
    await fileTarget.commit();
    return verifyStandardOutput(
      options.handle,
      options.kind,
      options.expectedCodec,
      options.expectedDurationSeconds,
      options.metadata,
    );
  } catch (error) {
    await cancel();
    await fileTarget?.abort(error);
    if (error instanceof ConversionCanceledError || cancellationRequested) {
      throw mergeError('CANCELLED', '分别导出已取消，未提交未验证的文件。', { cause: error });
    }
    throw normalizeMergeError(error);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function exportVideo(
  blob: Blob,
  handle: FileSystemFileHandleLike,
  options: StandardSeparateExportOptions,
  onProgress: (ratio: number, seconds: number) => void,
): Promise<CompletedStandardSeparateOutput> {
  const prepared = await prepareCapturedVideoTrack(blob, options);
  try {
    const codec = prepared.probe.codec as VideoCodec;
    if (!STANDARD_VIDEO_CODECS.has(codec)) {
      throw mergeError(
        'CONTAINER_INCOMPATIBLE',
        `${codec.toUpperCase()} 不能在“不转码”约束下导出为标准 MP4；未生成伪 MP4。`,
      );
    }
    const verification = await executeConversion({
      kind: 'video',
      input: prepared.input,
      handle,
      format: new Mp4OutputFormat({ fastStart: false }),
      expectedCodec: codec,
      expectedDurationSeconds: expectedDuration(
        prepared.probe.durationSeconds,
        prepared.probe.firstTimestampSeconds,
      ),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      onProgress,
      configure: async (output) => {
        const conversion = await Conversion.init({
          input: prepared.input,
          output,
          tracks: 'all',
          video: (track) =>
            track === prepared.track ? { codec, forceTranscode: false } : { discard: true },
          audio: { discard: true },
          composable: true,
          showWarnings: false,
        });
        const videoTracks = output.tracks.filter((track) => track.isVideoTrack());
        if (
          !conversion.utilizedTracks.includes(prepared.track) ||
          videoTracks.length !== 1 ||
          !(videoTracks[0]?.source instanceof EncodedVideoPacketSource)
        ) {
          throw mergeError(
            'TRANSCODE_REQUIRED',
            `${codec.toUpperCase()} 视频不能无损转封装为 MP4；未生成伪 MP4。`,
          );
        }
        return conversion;
      },
    });
    return {
      status: 'completed',
      kind: 'video',
      extension: '.mp4',
      mimeType: 'video/mp4',
      sourceCodec: codec,
      outputCodec: codec,
      outputMode: 'standard-remux',
      verification,
    };
  } finally {
    prepared.input.dispose();
  }
}

async function blobsEqual(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false;
  for (let offset = 0; offset < left.size; offset += ORIGINAL_COPY_CHUNK_BYTES) {
    const end = Math.min(left.size, offset + ORIGINAL_COPY_CHUNK_BYTES);
    const [leftBytes, rightBytes] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);
    const leftChunk = new Uint8Array(leftBytes);
    const rightChunk = new Uint8Array(rightBytes);
    if (!leftChunk.every((byte, index) => byte === rightChunk[index])) {
      return false;
    }
  }
  return true;
}

export async function exportOriginalVideoTrack(
  blob: Blob,
  handle: FileSystemFileHandleLike,
  options: StandardSeparateExportOptions,
  evidence: Awaited<ReturnType<typeof extractIsoBmffDynamicRangeEvidence>>,
  onProgress: (ratio: number, seconds: number) => void = () => undefined,
): Promise<CompletedStandardSeparateOutput> {
  if (options.drmSignals && options.drmSignals.length > 0) {
    throw mergeError('DRM_PROTECTED', '检测到加密或 DRM 信号；不会保存受保护的原始轨。', {
      canDownloadSeparately: false,
      drmSignals: options.drmSignals,
    });
  }
  const drmSignals = await detectIsoBmffBlobDrm(blob);
  if (drmSignals.length > 0) {
    throw mergeError('DRM_PROTECTED', '检测到加密或 DRM 信号；不会保存受保护的原始轨。', {
      canDownloadSeparately: false,
      drmSignals,
    });
  }
  const sampleEntry = evidence.sampleEntryType?.toLowerCase();
  const structuralCodec: VideoCodec | undefined =
    sampleEntry === 'hvc1' ||
    sampleEntry === 'hev1' ||
    sampleEntry === 'dvh1' ||
    sampleEntry === 'dvhe'
      ? 'hevc'
      : sampleEntry === 'avc1' || sampleEntry === 'avc3'
        ? 'avc'
        : undefined;
  let prepared: Awaited<ReturnType<typeof prepareCapturedVideoTrack>> | null = null;
  try {
    prepared = await prepareCapturedVideoTrack(blob, options);
  } catch (error) {
    const normalized = normalizeMergeError(error);
    if (normalized.detail.code === 'DRM_PROTECTED' || !structuralCodec) throw normalized;
    // A raw fallback must not depend on the remux engine understanding dvcC/dvvC.
    // The structured sample entry, DRM scan, exact copy, and boundary signature
    // remain the verification authority for this branch.
  }
  let fileTarget: ReturnType<typeof createDeferredCommitFileTarget> | null = null;
  try {
    const codec = (prepared?.probe.codec as VideoCodec | undefined) ?? structuralCodec;
    if (!codec) throw mergeError('CODEC_UNKNOWN', '原始视频轨编码无法识别。');
    const sourceHeader = new Uint8Array(await blob.slice(0, 4_096).arrayBuffer());
    if (!hasMp4Signature(sourceHeader)) {
      throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '原始视频轨不是有效的 ISO-BMFF/MP4 文件。');
    }
    const writable = await handle.createWritable();
    fileTarget = createDeferredCommitFileTarget(writable);
    const writer = fileTarget.stream.getWriter();
    try {
      for (let offset = 0; offset < blob.size; offset += ORIGINAL_COPY_CHUNK_BYTES) {
        throwIfAborted(options.signal);
        const end = Math.min(blob.size, offset + ORIGINAL_COPY_CHUNK_BYTES);
        const data = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
        await writer.write({ type: 'write', position: offset, data });
        onProgress(blob.size > 0 ? end / blob.size : 1, 0);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
    throwIfAborted(options.signal);
    await fileTarget.commit();
    const file = await handle.getFile();
    if (!(await blobsEqual(blob, file))) {
      throw mergeError(
        'OUTPUT_VERIFY_FAILED',
        '写入后的视频内容与原始视频不一致，未生成可保存的文件。',
      );
    }
    const outputHeader = new Uint8Array(await file.slice(0, 4_096).arrayBuffer());
    if (!hasMp4Signature(outputHeader)) {
      throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '原始视频轨写入后 MP4 文件头验证失败。');
    }
    const outputEvidence = await extractIsoBmffDynamicRangeEvidence(file);
    if (JSON.stringify(outputEvidence) !== JSON.stringify(evidence)) {
      throw mergeError('OUTPUT_VERIFY_FAILED', '原始视频轨写入后动态范围结构证据发生变化。');
    }
    const verification: StandardSeparateOutputVerification = {
      valid: true,
      sizeBytes: file.size,
      formatName: 'ISO BMFF (byte-for-byte original track)',
      codec,
      durationSeconds: prepared?.probe.durationSeconds ?? null,
    };
    return {
      status: 'completed',
      kind: 'video',
      extension: '.mp4',
      mimeType: 'video/mp4',
      sourceCodec: codec,
      outputCodec: codec,
      outputMode: 'original-track',
      verification: {
        ...verification,
        sourceBytesPreserved: true,
        dynamicRange: evidence,
      },
    };
  } catch (error) {
    await fileTarget?.abort(error);
    throw normalizeMergeError(error);
  } finally {
    prepared?.input.dispose();
  }
}

function nearestMp3SampleRate(sampleRate: number): number {
  return MP3_SAMPLE_RATES.reduce((nearest, candidate) =>
    Math.abs(candidate - sampleRate) < Math.abs(nearest - sampleRate) ? candidate : nearest,
  );
}

async function exportAudio(
  blob: Blob,
  handle: FileSystemFileHandleLike,
  options: StandardSeparateExportOptions,
  onProgress: (ratio: number, seconds: number) => void,
): Promise<CompletedStandardSeparateOutput> {
  const prepared = await prepareCapturedAudioTrack(blob, options);
  try {
    const sourceCodec = prepared.probe.codec as AudioCodec;
    const [sourceChannels, sourceSampleRate] = await Promise.all([
      prepared.track.getNumberOfChannels(),
      prepared.track.getSampleRate(),
    ]);
    const numberOfChannels = Math.max(1, Math.min(2, sourceChannels));
    const sampleRate = nearestMp3SampleRate(sourceSampleRate);
    const encoderOptions = { numberOfChannels, sampleRate, bitrate: MP3_BITRATE };
    if (!(await canEncodeAudio('mp3', encoderOptions))) registerMp3Encoder();
    if (!(await canEncodeAudio('mp3', encoderOptions))) {
      throw mergeError('TRANSCODE_REQUIRED', '当前浏览器无法启动 MP3 编码器；未生成改后缀音频。');
    }

    const verification = await executeConversion({
      kind: 'audio',
      input: prepared.input,
      handle,
      format: new Mp3OutputFormat(),
      expectedCodec: 'mp3',
      expectedDurationSeconds: expectedDuration(
        prepared.probe.durationSeconds,
        prepared.probe.firstTimestampSeconds,
      ),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.metadata?.title ? { metadata: { title: options.metadata.title } } : {}),
      onProgress,
      configure: async (output) => {
        const conversion = await Conversion.init({
          input: prepared.input,
          output,
          tracks: 'all',
          video: { discard: true },
          audio: (track) =>
            track === prepared.track
              ? sourceCodec === 'mp3'
                ? { codec: 'mp3', forceTranscode: false }
                : {
                    codec: 'mp3',
                    numberOfChannels,
                    sampleRate,
                    bitrate: MP3_BITRATE,
                    forceTranscode: true,
                  }
              : { discard: true },
          composable: true,
          showWarnings: false,
        });
        const audioTracks = output.tracks.filter((track) => track.isAudioTrack());
        if (!conversion.utilizedTracks.includes(prepared.track) || audioTracks.length !== 1) {
          const reason = conversion.discardedTracks.find(
            (discarded) => discarded.track === prepared.track,
          )?.reason;
          throw mergeError(
            'TRANSCODE_REQUIRED',
            `${sourceCodec.toUpperCase()} 音频无法解码并转换为 MP3${reason ? `（${reason}）` : ''}；未生成改后缀音频。`,
          );
        }
        return conversion;
      },
    });
    return {
      status: 'completed',
      kind: 'audio',
      extension: '.mp3',
      mimeType: 'audio/mpeg',
      sourceCodec,
      outputCodec: 'mp3',
      outputMode: 'audio-transcode',
      verification,
    };
  } finally {
    prepared.input.dispose();
  }
}

/**
 * Converts one captured elementary track into its real standard download
 * container. The returned metadata is only produced after the output has been
 * reopened and verified; callers must discard the handle when this throws.
 */
export async function exportStandardSeparateTrack(
  blob: Blob,
  kind: StandardSeparateOutputKind,
  handle: FileSystemFileHandleLike,
  downloadedBytes: number,
  options: StandardSeparateExportOptions = {},
): Promise<CompletedStandardSeparateOutput> {
  const report = (ratio: number, processedSeconds: number) => {
    options.onProgress?.({
      phase: 'muxing',
      ratio,
      processedSeconds,
      readBytes: downloadedBytes,
      totalBytes: downloadedBytes,
      message:
        kind === 'video'
          ? '正在无损转封装缓存视频轨为 MP4…'
          : options.audioOutput === 'original'
            ? '正在逐字节保存原音轨…'
            : '正在将缓存音频轨转码为 MP3…',
    });
  };
  if (kind === 'audio')
    return options.audioOutput === 'original'
      ? exportOriginalAudioTrack(blob, handle, options, report)
      : exportAudio(blob, handle, options, report);
  const evidence = await extractIsoBmffDynamicRangeEvidence(blob);
  const preserveOriginal =
    options.videoDynamicRange?.range === 'HDR' ||
    options.videoDynamicRange?.range === 'Dolby Vision' ||
    evidence.classification === 'HDR' ||
    evidence.classification === 'Dolby Vision';
  return preserveOriginal
    ? exportOriginalVideoTrack(blob, handle, options, evidence, report)
    : exportVideo(blob, handle, options, report);
}

function failedOutcome(
  kind: StandardSeparateOutputKind,
  error: unknown,
): StandardSeparateOutputOutcome {
  return { status: 'failed', kind, failure: normalizeMergeError(error).detail };
}

/**
 * Produces independently verified standard files. Each branch is isolated so
 * an unsupported decoder/codec on one branch does not discard a valid sibling
 * output. Cancellation remains atomic and discards both branches.
 */
export async function exportStandardSeparateOutputs(
  videoBlob: Blob,
  audioBlob: Blob,
  handles: StandardSeparateOutputHandles,
  downloadedBytes: number,
  options: StandardSeparateExportOptions = {},
): Promise<CompletedStandardSeparateExport> {
  const outcomes: StandardSeparateOutputOutcome[] = [];
  const branchRatios: [number, number] = [0, 0];
  const reportBranch = (index: 0 | 1, label: string) => (ratio: number, seconds: number) => {
    branchRatios[index] = Math.max(branchRatios[index], Math.max(0, Math.min(1, ratio)));
    options.onProgress?.({
      phase: 'muxing',
      ratio: (branchRatios[0] + branchRatios[1]) / 2,
      processedSeconds: seconds,
      readBytes: downloadedBytes,
      totalBytes: downloadedBytes,
      message: label,
    });
  };

  options.onProgress?.({
    phase: 'muxing',
    ratio: 0,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
    message:
      options.audioOutput === 'mp3'
        ? '下载完成，正在生成标准 MP4 与 MP3…'
        : '下载完成，正在生成视频文件并逐字节保留原音轨…',
  });

  try {
    const videoEvidence = await extractIsoBmffDynamicRangeEvidence(videoBlob);
    const preserveOriginalVideo =
      options.videoDynamicRange?.range === 'HDR' ||
      options.videoDynamicRange?.range === 'Dolby Vision' ||
      videoEvidence.classification === 'HDR' ||
      videoEvidence.classification === 'Dolby Vision';
    outcomes.push(
      await (preserveOriginalVideo
        ? exportOriginalVideoTrack(
            videoBlob,
            handles.video,
            options,
            videoEvidence,
            reportBranch(0, '正在逐字节保存原始 HDR/Dolby Vision 视频轨…'),
          )
        : exportVideo(
            videoBlob,
            handles.video,
            options,
            reportBranch(0, '正在无损转封装视频轨为 MP4…'),
          )),
    );
    branchRatios[0] = 1;
  } catch (error) {
    throwIfAborted(options.signal);
    outcomes.push(failedOutcome('video', error));
    branchRatios[0] = 1;
  }

  try {
    outcomes.push(
      await (options.audioOutput === 'mp3' ? exportAudio : exportOriginalAudioTrack)(
        audioBlob,
        handles.audio,
        options,
        reportBranch(
          1,
          options.audioOutput === 'mp3'
            ? '正在转码音频轨为 MP3…'
            : '正在逐字节保存原音轨（AAC/M4A 或原生 MP3）…',
        ),
      ),
    );
    branchRatios[1] = 1;
  } catch (error) {
    throwIfAborted(options.signal);
    outcomes.push(failedOutcome('audio', error));
    branchRatios[1] = 1;
  }

  throwIfAborted(options.signal);
  options.onProgress?.({
    phase: 'saving',
    ratio: 1,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
    message: '标准分轨已写入临时存储，正在核验提交结果…',
  });
  options.onProgress?.({
    phase: 'verifying',
    ratio: 1,
    readBytes: downloadedBytes,
    totalBytes: downloadedBytes,
    message: '标准分轨验证完成，正在交给浏览器保存…',
  });

  const tuple = outcomes as [StandardSeparateOutputOutcome, StandardSeparateOutputOutcome];
  const successCount = tuple.filter((outcome) => outcome.status === 'completed').length;
  return {
    status: successCount === 2 ? 'completed' : successCount === 1 ? 'partial' : 'failed',
    outcomes: tuple,
  };
}

function hasMp4Signature(header: Uint8Array): boolean {
  return (
    header.byteLength >= 8 &&
    header[4] === 0x66 &&
    header[5] === 0x74 &&
    header[6] === 0x79 &&
    header[7] === 0x70
  );
}

function hasMp3Signature(header: Uint8Array): boolean {
  if (header.byteLength >= 3 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    return true;
  }
  for (let index = 0; index + 1 < header.byteLength; index += 1) {
    if (header[index] === 0xff && (header[index + 1]! & 0xe0) === 0xe0) return true;
  }
  return false;
}

/** Re-establishes verified MIME metadata at the native download boundary. */
export async function prepareVerifiedStandardSeparateBlob(
  file: Blob,
  result: CompletedStandardSeparateOutput,
): Promise<Blob> {
  if (
    result.verification.sizeBytes <= 0 ||
    !Number.isSafeInteger(result.verification.sizeBytes) ||
    file.size !== result.verification.sizeBytes
  ) {
    throw mergeError('OUTPUT_SIZE_MISMATCH', '标准分轨大小与验证结果不一致。');
  }
  const header = new Uint8Array(await file.slice(0, 4_096).arrayBuffer());
  const isOriginalAac =
    result.kind === 'audio' &&
    result.outputMode === 'original-track' &&
    result.outputCodec === 'aac';
  const valid =
    result.kind === 'video' || isOriginalAac ? hasMp4Signature(header) : hasMp3Signature(header);
  if (!valid) {
    throw mergeError(
      'OUTPUT_SIGNATURE_MISMATCH',
      result.kind === 'video'
        ? '视频输出不是有效 MP4 文件头。'
        : isOriginalAac
          ? '原音轨输出不是有效 M4A 文件头。'
          : '音频输出不是有效 MP3 文件头。',
    );
  }
  const expected =
    result.kind === 'video'
      ? { extension: '.mp4', mimeType: 'video/mp4' }
      : isOriginalAac
        ? { extension: '.m4a', mimeType: 'audio/mp4' }
        : { extension: '.mp3', mimeType: 'audio/mpeg' };
  if (result.extension !== expected.extension || result.mimeType !== expected.mimeType) {
    throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '标准分轨扩展名与 MIME 类型不一致。');
  }
  if (result.outputMode === 'original-track' && result.kind === 'audio') {
    if (
      result.verification.sourceBytesPreserved !== true ||
      !result.verification.originalAudio ||
      result.sourceCodec !== result.outputCodec
    ) {
      throw mergeError('OUTPUT_VERIFY_FAILED', '原音轨缺少逐字节保真证明。');
    }
    const evidence = await inspectOriginalAudioTrack(file);
    if (
      evidence.codec !== result.outputCodec ||
      JSON.stringify(evidence) !== JSON.stringify(result.verification.originalAudio)
    ) {
      throw mergeError(
        'OUTPUT_VERIFY_FAILED',
        '保存前再次检查时发现音频结构或内容与原始音频不一致。',
      );
    }
  } else if (result.outputMode === 'original-track') {
    if (result.verification.sourceBytesPreserved !== true || !result.verification.dynamicRange) {
      throw mergeError('OUTPUT_VERIFY_FAILED', '原始视频轨缺少逐字节保真证明。');
    }
    const evidence = await extractIsoBmffDynamicRangeEvidence(file);
    if (JSON.stringify(evidence) !== JSON.stringify(result.verification.dynamicRange)) {
      throw mergeError('OUTPUT_VERIFY_FAILED', '保存前再次检查时发现视频结构与原始视频不一致。');
    }
  }
  return file.slice(0, file.size, expected.mimeType);
}

export function summarizeStandardSeparateFailures(
  result: CompletedStandardSeparateExport,
): MergeFailureDetail | null {
  const failures = result.outcomes.filter(
    (outcome): outcome is Extract<StandardSeparateOutputOutcome, { status: 'failed' }> =>
      outcome.status === 'failed',
  );
  if (failures.length === 0) return null;
  return {
    code: failures[0]!.failure.code,
    message: failures
      .map(
        (outcome) =>
          `${outcome.kind === 'video' ? '视频 MP4' : '音频'}：${outcome.failure.message}`,
      )
      .join('；'),
    retryable: failures.some((outcome) => outcome.failure.retryable),
    canDownloadSeparately: true,
  };
}
