import { EncodedPacketSink, Mp3InputFormat, Mp4InputFormat } from 'mediabunny';
import {
  createDeferredCommitFileTarget,
  detectIsoBmffBlobDrm,
  mergeError,
  normalizeMergeError,
  prepareCapturedAudioTrack,
  type CapturedBlobProbeOptions,
  type FileSystemFileHandleLike,
} from '../merge';
import { inspectIsoBmffTimeline } from '../merge/iso-bmff-timeline';
import { checkMergeAborted, withMergeDeadline } from '../merge/runtime-control';
import type { CompletedStandardSeparateOutput, OriginalAudioTrackEvidence } from './types';

const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * The logical deadline stops further work, but is not proof that native OPFS
 * stopped. Keep the raw promise (and late-result cleanup) owned until it settles;
 * a permanently blocked native operation must be terminated by the job host.
 */
async function ownedNativeAudioStep<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onStop?: (reason: unknown) => Promise<void>,
  onLateResult?: (value: T, reason: unknown) => Promise<void>,
): Promise<T> {
  let stopCleanup: Promise<void> | undefined;
  const stop = (reason: unknown) => {
    if (stopCleanup) return;
    try {
      stopCleanup = Promise.resolve(onStop?.(reason)).catch(() => undefined);
    } catch {
      stopCleanup = Promise.resolve();
    }
  };
  try {
    const result = await withMergeDeadline(operation, {
      ...(signal ? { signal } : {}),
      stage: 'storage',
      onStop: stop,
    });
    checkMergeAborted(signal);
    return result;
  } catch (error) {
    stop(error);
    // Deliberately do not let the deadline race discard ownership of this
    // promise. In particular, createWritable may allocate its handle late.
    await operation
      .then(
        (value) => onLateResult?.(value, error),
        () => undefined,
      )
      .catch(() => undefined);
    await stopCleanup;
    throw error;
  }
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Structural and full-packet validation; no decoder or encoder is requested. */
export async function inspectOriginalAudioTrack(
  blob: Blob,
  options: CapturedBlobProbeOptions = {},
): Promise<OriginalAudioTrackEvidence> {
  checkMergeAborted(options.signal);
  const prepared = await prepareCapturedAudioTrack(blob, options);
  const dispose = () => prepared.input.dispose();
  const step = <T>(promise: Promise<T>) =>
    withMergeDeadline(promise, {
      ...(options.signal ? { signal: options.signal } : {}),
      stage: 'verify-audio',
      onStop: dispose,
    });
  try {
    const [format, tracks, codec, sampleRate, numberOfChannels] = await step(
      Promise.all([
        prepared.input.getFormat(),
        prepared.input.getTracks(),
        prepared.track.getCodec(),
        prepared.track.getSampleRate(),
        prepared.track.getNumberOfChannels(),
      ]),
    );
    if (tracks.length !== 1 || !tracks[0]?.isAudioTrack()) {
      throw mergeError(
        'OUTPUT_TRACK_MISMATCH',
        '原音轨必须是完整的单音轨文件，不能包含其他媒体轨。',
      );
    }
    let container: OriginalAudioTrackEvidence['container'];
    if (codec === 'aac' && format instanceof Mp4InputFormat) {
      const decoderConfig = await step(prepared.track.getDecoderConfig());
      if (!decoderConfig?.description?.byteLength)
        throw mergeError(
          'OUTPUT_TRACK_MISMATCH',
          'AAC 原音轨缺少 AudioSpecificConfig，无法确认完整音频结构。',
        );
      const header = new Uint8Array(await step(blob.slice(0, 8).arrayBuffer()));
      const timeline = await inspectIsoBmffTimeline(blob, options.signal, 'audio');
      if (
        String.fromCharCode(...header.subarray(4, 8)) !== 'ftyp' ||
        timeline?.tracks.length !== 1 ||
        timeline.tracks[0]?.kind !== 'audio'
      ) {
        throw mergeError(
          'OUTPUT_SIGNATURE_MISMATCH',
          'AAC 原音轨必须是包含初始化信息的完整 ISO-BMFF 单轨文件，不能将裸分片改为 M4A。',
        );
      }
      const drmSignals = await step(detectIsoBmffBlobDrm(blob));
      if (drmSignals.length)
        throw mergeError('DRM_PROTECTED', '检测到受保护的原音轨，未保存文件。', {
          drmSignals,
          canDownloadSeparately: false,
        });
      container = 'iso-bmff';
    } else if (codec === 'mp3' && format instanceof Mp3InputFormat) {
      container = 'mp3';
    } else {
      throw mergeError(
        'SOURCE_FORMAT_UNSUPPORTED',
        '当前来源不能作为受支持的原音轨保存；仅支持完整 AAC/M4A 或原生 MP3，不会自动转码或更改后缀。',
        { canDownloadSeparately: false },
      );
    }
    if (
      !Number.isSafeInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isSafeInteger(numberOfChannels) ||
      numberOfChannels <= 0
    ) {
      throw mergeError('OUTPUT_TRACK_MISMATCH', '原音轨的采样率或声道结构不完整。');
    }
    let packetCount = 0;
    let lastTimestamp = Number.NEGATIVE_INFINITY;
    const packets = new EncodedPacketSink(prepared.track).packets()[Symbol.asyncIterator]();
    while (true) {
      checkMergeAborted(options.signal);
      const packet = await step(packets.next());
      if (packet.done) break;
      if (
        !packet.value.byteLength ||
        !Number.isFinite(packet.value.timestamp) ||
        !Number.isFinite(packet.value.duration) ||
        packet.value.duration < 0 ||
        packet.value.timestamp < lastTimestamp
      ) {
        throw mergeError(
          'OUTPUT_TIMELINE_MISMATCH',
          '原始音频数据缺失或无效，未生成可保存的文件。',
        );
      }
      lastTimestamp = packet.value.timestamp;
      packetCount++;
    }
    if (!packetCount) throw mergeError('OUTPUT_TRACK_MISMATCH', '原音轨没有完整可读取的音频包。');
    const chunkSha256: string[] = [];
    for (let offset = 0; offset < blob.size; offset += COPY_CHUNK_BYTES) {
      checkMergeAborted(options.signal);
      chunkSha256.push(
        await step(sha256(await step(blob.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer()))),
      );
    }
    return {
      container,
      codec,
      sampleRate,
      numberOfChannels,
      packetCount,
      durationSeconds: prepared.probe.durationSeconds,
      chunkSha256,
    };
  } finally {
    dispose();
  }
}

/** Byte-preserved AAC/M4A or native MP3. The caller owns deletion of failed temporary handles. */
export async function exportOriginalAudioTrack(
  blob: Blob,
  handle: FileSystemFileHandleLike,
  options: CapturedBlobProbeOptions,
  onProgress: (ratio: number, seconds: number) => void = () => undefined,
): Promise<CompletedStandardSeparateOutput> {
  const sourceEvidence = await inspectOriginalAudioTrack(blob, options);
  let fileTarget: ReturnType<typeof createDeferredCommitFileTarget> | null = null;
  const native = <T>(operation: Promise<T>) =>
    ownedNativeAudioStep(
      operation,
      options.signal,
      (reason) => fileTarget?.abort(reason) ?? Promise.resolve(),
    );
  try {
    checkMergeAborted(options.signal);
    const writable = await ownedNativeAudioStep(
      handle.createWritable(),
      options.signal,
      undefined,
      (late, reason) => late.abort(reason),
    );
    fileTarget = createDeferredCommitFileTarget(writable);
    checkMergeAborted(options.signal);
    const writer = fileTarget.stream.getWriter();
    try {
      for (let offset = 0; offset < blob.size; offset += COPY_CHUNK_BYTES) {
        checkMergeAborted(options.signal);
        const data = new Uint8Array(
          await native(blob.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer()),
        );
        checkMergeAborted(options.signal);
        await native(writer.write({ type: 'write', position: offset, data }));
        onProgress(Math.min(1, (offset + data.length) / blob.size), 0);
      }
      await native(writer.close());
    } catch (error) {
      await ownedNativeAudioStep(writer.abort(error)).catch(() => undefined);
      throw error;
    }
    checkMergeAborted(options.signal);
    await native(fileTarget.commit());
    checkMergeAborted(options.signal);
    const file = await native(handle.getFile());
    checkMergeAborted(options.signal);
    if (file.size !== blob.size)
      throw mergeError(
        'OUTPUT_SIZE_MISMATCH',
        '写入后的音频大小与原始音频不一致，未生成可保存的文件。',
      );
    for (let offset = 0; offset < blob.size; offset += COPY_CHUNK_BYTES) {
      checkMergeAborted(options.signal);
      const [sourceBytes, outputBytes] = await native(
        Promise.all([
          blob.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer(),
          file.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer(),
        ]),
      );
      const source = new Uint8Array(sourceBytes);
      const output = new Uint8Array(outputBytes);
      if (source.length !== output.length || !source.every((byte, index) => byte === output[index]))
        throw mergeError(
          'OUTPUT_VERIFY_FAILED',
          '写入后的音频内容与原始音频不一致，未生成可保存的文件。',
        );
    }
    const outputEvidence = await inspectOriginalAudioTrack(file, options);
    if (JSON.stringify(sourceEvidence) !== JSON.stringify(outputEvidence))
      throw mergeError(
        'OUTPUT_VERIFY_FAILED',
        '写入后的音频结构或内容与原始音频不一致，未生成可保存的文件。',
      );
    checkMergeAborted(options.signal);
    return {
      status: 'completed',
      kind: 'audio',
      extension: sourceEvidence.codec === 'aac' ? '.m4a' : '.mp3',
      mimeType: sourceEvidence.codec === 'aac' ? 'audio/mp4' : 'audio/mpeg',
      sourceCodec: sourceEvidence.codec,
      outputCodec: sourceEvidence.codec,
      outputMode: 'original-track',
      verification: {
        valid: true,
        sizeBytes: file.size,
        formatName:
          sourceEvidence.container === 'iso-bmff'
            ? 'ISO BMFF (byte-for-byte original audio)'
            : 'MP3 (byte-for-byte original audio)',
        codec: sourceEvidence.codec,
        durationSeconds: sourceEvidence.durationSeconds,
        sourceBytesPreserved: true,
        originalAudio: sourceEvidence,
      },
    };
  } catch (error) {
    if (fileTarget) await ownedNativeAudioStep(fileTarget.abort(error));
    throw normalizeMergeError(error);
  }
}
