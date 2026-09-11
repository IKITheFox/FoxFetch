import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { mergeError } from './errors';
import { createIsoBmffTimelineReadView, inspectIsoBmffTimeline } from './iso-bmff-timeline';
import { checkMergeAborted, withMergeDeadline } from './runtime-control';
import type { RemuxProgress } from './types';

/**
 * The pinned demuxer ignores zero-duration edits. Read every packet's metadata
 * first to prove a finite end; the resulting private view activates the original
 * offset without touching media bytes or publishing its replacement edit box.
 */
export async function prepareTimelineReadView(
  blob: Blob,
  sourceKind: 'video' | 'audio',
  options: { signal?: AbortSignal; onProgress?: (progress: RemuxProgress) => void } = {},
): Promise<Blob> {
  const timeline = await inspectIsoBmffTimeline(blob, options.signal, sourceKind);
  const edited = timeline?.tracks.filter((track) => track.edit?.openEnded);
  if (!edited?.length) return blob;
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: 4 * 1024 * 1024 }),
  });
  const dispose = () => input.dispose();
  const step = <T>(operation: Promise<T>) =>
    withMergeDeadline(operation, {
      ...(options.signal ? { signal: options.signal } : {}),
      stage: 'media-metadata',
      onStop: dispose,
    });
  const invalid = () =>
    mergeError('TIMELINE_MISMATCH', '无法证明开放编辑区间覆盖的原始包时间轴。', {
      reason: 'SOURCE_EDIT_LIST_UNSUPPORTED',
      stage: 'media-metadata',
      sourceTimeline: { issue: 'open-ended-offset', box: 'elst', sourceKind },
    });
  options.signal?.addEventListener('abort', dispose, { once: true });
  try {
    checkMergeAborted(options.signal);
    const tracks = await step(input.getTracks());
    const bounds = new Map<number, number>();
    for (const descriptor of edited) {
      const track = tracks.find((candidate) => candidate.id === descriptor.id);
      if (!track || (await step(track.getTimeResolution())) !== descriptor.timescale)
        throw invalid();
      const packets = new EncodedPacketSink(track).packets(undefined, undefined, {
        metadataOnly: true,
      });
      const iterator = packets[Symbol.asyncIterator]();
      let end = -Infinity;
      let count = 0;
      while (true) {
        checkMergeAborted(options.signal);
        const packet = await step(iterator.next());
        if (packet.done) break;
        const { timestamp, duration } = packet.value;
        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(duration) ||
          duration < 0 ||
          ++count > 10_000_000
        )
          throw invalid();
        end = Math.max(end, timestamp + duration);
        if (count === 1 || count % 512 === 0) {
          options.onProgress?.({
            phase: 'probing',
            stage: 'media-metadata',
            ratio: null,
            packetCount: count,
            message: sourceKind === 'video' ? '正在核对视频编辑时间轴…' : '正在核对音频编辑时间轴…',
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      if (!count || !Number.isFinite(end)) throw invalid();
      bounds.set(track.id, end);
    }
    return await createIsoBmffTimelineReadView(blob, bounds, options.signal, sourceKind);
  } finally {
    options.signal?.removeEventListener('abort', dispose);
    dispose();
  }
}
