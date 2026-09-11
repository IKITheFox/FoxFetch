const TIMESTAMP_EPSILON_SECONDS = 1e-6;

export interface CapturedTimelineWindow<T> {
  value: T;
  originalIndex: number;
  startTimestamp: number;
  maxTimestamp: number;
  /** Stable hash of packet timing, type, length and encoded bytes. */
  fingerprint: string;
}

export interface CapturedTimelinePlan<T> {
  ordered: CapturedTimelineWindow<T>[];
  droppedDuplicateCount: number;
  conflictingOverlapCount: number;
}

function planNonOverlappingCapturedWindows<T>(
  windows: CapturedTimelineWindow<T>[],
): CapturedTimelinePlan<T> {
  const sorted = windows
    .filter(
      (window) =>
        Number.isFinite(window.startTimestamp) &&
        Number.isFinite(window.maxTimestamp) &&
        window.maxTimestamp + TIMESTAMP_EPSILON_SECONDS >= window.startTimestamp,
    )
    .sort(
      (left, right) =>
        left.startTimestamp - right.startTimestamp ||
        right.maxTimestamp - left.maxTimestamp ||
        left.fingerprint.localeCompare(right.fingerprint) ||
        left.originalIndex - right.originalIndex,
    );

  const ordered: CapturedTimelineWindow<T>[] = [];
  const acceptedFingerprints = new Set<string>();
  let largestTimestamp = Number.NEGATIVE_INFINITY;
  let droppedDuplicateCount = 0;
  let conflictingOverlapCount = 0;

  for (const window of sorted) {
    if (window.startTimestamp + TIMESTAMP_EPSILON_SECONDS < largestTimestamp) {
      if (acceptedFingerprints.has(window.fingerprint)) {
        droppedDuplicateCount += 1;
      } else {
        // Packet-copy cannot trim into the middle of a GOP/run. An overlap with
        // different bytes is real conflicting media, not a safe duplicate.
        conflictingOverlapCount += 1;
      }
      continue;
    }

    ordered.push(window);
    acceptedFingerprints.add(window.fingerprint);
    largestTimestamp = Math.max(largestTimestamp, window.maxTimestamp);
  }

  return { ordered, droppedDuplicateCount, conflictingOverlapCount };
}

/**
 * Restores presentation order while preserving every video's GOP decode order.
 * No timestamps are shifted. Only byte-identical repeated GOPs are removed;
 * overlapping GOPs with different content are surfaced as conflicts.
 */
export function planCapturedVideoGops<T>(
  windows: CapturedTimelineWindow<T>[],
): CapturedTimelinePlan<T> {
  return planNonOverlappingCapturedWindows(windows);
}

/**
 * Audio equivalent of {@link planCapturedVideoGops}. Runs are split at seeks or
 * forward gaps before this planner is called.
 */
export function planCapturedAudioRuns<T>(
  windows: CapturedTimelineWindow<T>[],
): CapturedTimelinePlan<T> {
  return planNonOverlappingCapturedWindows(windows);
}
