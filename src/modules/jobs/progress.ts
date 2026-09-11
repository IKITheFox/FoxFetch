import type { MergeJobProgress } from './types';

/** Public progress is deliberately split into a download budget and a local-work budget. */
export const MERGE_DOWNLOAD_PROGRESS_END = 0.7;
export const MERGE_MUX_PROGRESS_END = 0.94;
export const MERGE_FINALIZE_PROGRESS = 0.95;
export const MERGE_VERIFY_PROGRESS_START = 0.97;
export const MERGE_SAVE_PROGRESS = 0.99;

const PHASE_ORDER: Readonly<Record<MergeJobProgress['phase'], number>> = {
  idle: 0,
  probing: 1,
  fetching: 2,
  muxing: 3,
  saving: 4,
  verifying: 5,
};

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function projectRatio(progress: MergeJobProgress): number | null {
  const ratio = progress.ratio == null ? null : clampUnit(progress.ratio);
  switch (progress.phase) {
    case 'idle':
      return ratio == null ? null : Math.min(MERGE_SAVE_PROGRESS, ratio);
    case 'probing':
      return null;
    case 'fetching':
      return ratio == null ? null : ratio * MERGE_DOWNLOAD_PROGRESS_END;
    case 'muxing':
      return ratio == null
        ? MERGE_DOWNLOAD_PROGRESS_END
        : MERGE_DOWNLOAD_PROGRESS_END +
            ratio * (MERGE_MUX_PROGRESS_END - MERGE_DOWNLOAD_PROGRESS_END);
    case 'saving':
      return MERGE_FINALIZE_PROGRESS;
    case 'verifying':
      return ratio == null
        ? MERGE_VERIFY_PROGRESS_START
        : MERGE_VERIFY_PROGRESS_START + ratio * (MERGE_SAVE_PROGRESS - MERGE_VERIFY_PROGRESS_START);
  }
}

function normalizedBytes(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

/**
 * Maps worker-local phase progress onto the single progress bar shown to users.
 *
 * A delayed event from an earlier phase may still arrive while the worker is
 * switching streams. It is allowed to contribute byte counters, but it can
 * never move either the visible phase or the visible percentage backwards.
 */
export function projectMergeJobProgress(
  previous: MergeJobProgress,
  incoming: MergeJobProgress,
): MergeJobProgress {
  const previousRatio =
    previous.ratio == null ? null : Math.max(0, Math.min(MERGE_SAVE_PROGRESS, previous.ratio));
  const incomingIsStale = PHASE_ORDER[incoming.phase] < PHASE_ORDER[previous.phase];
  const nextRatio = incomingIsStale ? previousRatio : projectRatio(incoming);
  const monotonicRatio =
    nextRatio == null
      ? previousRatio
      : previousRatio == null
        ? nextRatio
        : Math.max(previousRatio, nextRatio);

  return {
    phase: incomingIsStale ? previous.phase : incoming.phase,
    ratio: monotonicRatio,
    readBytes: Math.max(normalizedBytes(previous.readBytes), normalizedBytes(incoming.readBytes)),
    totalBytes:
      incoming.totalBytes == null
        ? previous.totalBytes
        : previous.totalBytes == null
          ? Math.max(0, Number.isFinite(incoming.totalBytes) ? incoming.totalBytes : 0)
          : Math.max(
              previous.totalBytes,
              Math.max(0, Number.isFinite(incoming.totalBytes) ? incoming.totalBytes : 0),
            ),
    message: incomingIsStale ? previous.message : incoming.message,
  };
}

/** Unknown source length stays indeterminate until a real total is observed. */
export function projectInitialMergeJobProgress(incoming: MergeJobProgress): MergeJobProgress {
  return {
    ...incoming,
    ratio: projectRatio(incoming),
    readBytes: normalizedBytes(incoming.readBytes),
    totalBytes:
      incoming.totalBytes == null
        ? null
        : Math.max(0, Number.isFinite(incoming.totalBytes) ? incoming.totalBytes : 0),
  };
}
