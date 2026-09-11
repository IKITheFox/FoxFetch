export interface SegmentProgress {
  video: { completed: number; total: number };
  audio: { completed: number; total: number };
}

/** Owned by one acquisition attempt, never shared across retries or changed selections. */
export function createSegmentProgressTracker() {
  let last: SegmentProgress | null = null;
  return (next: SegmentProgress | null): SegmentProgress | null => {
    const ratio = segmentProgressRatio(next);
    if (next && ratio !== null) {
      const oldRatio = segmentProgressRatio(last);
      if (
        !last ||
        next.video.total !== last.video.total ||
        next.audio.total !== last.audio.total ||
        oldRatio === null ||
        ratio >= oldRatio
      ) {
        last = { video: { ...next.video }, audio: { ...next.audio } };
      }
    }
    return last ? { video: { ...last.video }, audio: { ...last.audio } } : null;
  };
}

/** The library map means enqueued, not written. A segment counts only after its
 * entire FIFO byte range has passed the destination writer successfully. */
export function writtenSegmentProgress(
  format:
    | {
        formatInitializationMetadata: { endSegmentNumber?: unknown };
        downloadedSegments: Map<
          number,
          { segmentNumber: number; mediaHeader: { contentLength?: unknown } }
        >;
      }
    | undefined,
  writtenBytes: number,
): { completed: number; total: number } | null {
  if (!format || !Number.isSafeInteger(writtenBytes) || writtenBytes < 0) return null;
  const end = Number(format.formatInitializationMetadata.endSegmentNumber);
  if (!Number.isSafeInteger(end) || end < 1) return null;
  let offset = 0,
    completed = 0,
    expected = 0;
  for (const [key, segment] of format.downloadedSegments) {
    if (key !== expected++ || segment.segmentNumber !== key || key > end) return null;
    const length = Number(segment.mediaHeader.contentLength);
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    offset += length;
    if (!Number.isSafeInteger(offset)) return null;
    if (offset <= writtenBytes) completed++;
  }
  if (writtenBytes > offset) return null;
  return { completed, total: end + 1 };
}

export function segmentProgressRatio(value: SegmentProgress | null | undefined): number | null {
  if (!value) return null;
  const tracks = [value.video, value.audio];
  if (
    tracks.some(
      (t) =>
        !t ||
        !Number.isSafeInteger(t.total) ||
        t.total < 2 ||
        !Number.isSafeInteger(t.completed) ||
        t.completed < 0 ||
        t.completed > t.total,
    )
  )
    return null;
  return Math.min(...tracks.map((t) => t.completed / t.total));
}
