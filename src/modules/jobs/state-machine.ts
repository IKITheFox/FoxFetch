import type { MergeJob, MergeJobPatch, MergeJobState } from './types';
import { MERGE_SAVE_PROGRESS, projectMergeJobProgress } from './progress';

const TRANSITIONS: Readonly<Record<MergeJobState, readonly MergeJobState[]>> = {
  queued: ['resolving', 'cancelled'],
  resolving: ['permission_required', 'ready', 'failed', 'cancelled', 'blocked_drm'],
  permission_required: ['resolving', 'cancelled', 'failed'],
  ready: ['resolving', 'fetching', 'cancelled', 'failed', 'blocked_drm'],
  fetching: ['muxing', 'paused', 'failed', 'cancelled', 'blocked_drm'],
  muxing: ['saving', 'paused', 'failed', 'cancelled', 'blocked_drm'],
  saving: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  paused: ['fetching', 'muxing', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued', 'resolving', 'cancelled'],
  cancelled: ['queued'],
  blocked_drm: ['cancelled'],
};

export class InvalidMergeJobTransitionError extends Error {
  constructor(from: MergeJobState, to: MergeJobState) {
    super(`Invalid merge job transition: ${from} -> ${to}`);
    this.name = 'InvalidMergeJobTransitionError';
  }
}

export function canTransitionMergeJob(from: MergeJobState, to: MergeJobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Presentation ordering cannot depend on Date.now() resolution or clock direction. */
export function nextMergeJobRevision(job: MergeJob): number {
  const revision = Number.isSafeInteger(job.revision) ? (job.revision ?? 0) : 0;
  return Math.max(0, revision) + 1;
}

export function touchMergeJob(job: MergeJob, now = Date.now()): MergeJob {
  return { ...job, revision: nextMergeJobRevision(job), updatedAt: now };
}

function normalizedStoredProgress(progress: MergeJob['progress']): MergeJob['progress'] {
  return {
    ...progress,
    ratio:
      progress.ratio === null
        ? null
        : Math.max(
            0,
            Math.min(MERGE_SAVE_PROGRESS, Number.isFinite(progress.ratio) ? progress.ratio : 0),
          ),
    readBytes: Math.max(0, progress.readBytes),
    totalBytes: progress.totalBytes === null ? null : Math.max(0, progress.totalBytes),
  };
}

export function transitionMergeJob(
  job: MergeJob,
  nextState: MergeJobState,
  patch: MergeJobPatch = {},
  now = Date.now(),
): MergeJob {
  if (!canTransitionMergeJob(job.state, nextState)) {
    throw new InvalidMergeJobTransitionError(job.state, nextState);
  }

  const clearFailure =
    (nextState === 'queued' || nextState === 'resolving' || nextState === 'ready') &&
    patch.failure === undefined;
  const base = Object.fromEntries(
    Object.entries(job).filter(([key]) => key !== 'failure' && key !== 'resumeState'),
  ) as Omit<MergeJob, 'failure' | 'resumeState'>;
  const next: MergeJob = {
    ...base,
    ...(clearFailure ? {} : job.failure ? { failure: job.failure } : {}),
    ...(nextState === 'paused'
      ? { resumeState: job.state === 'muxing' ? 'muxing' : 'fetching' }
      : patch.resumeState
        ? { resumeState: patch.resumeState }
        : {}),
    ...patch,
    progress:
      nextState === 'completed'
        ? {
            ...normalizedStoredProgress(patch.progress ?? job.progress),
            ratio: 1,
          }
        : nextState === 'failed' || nextState === 'cancelled' || nextState === 'blocked_drm'
          ? {
              ...normalizedStoredProgress(patch.progress ?? job.progress),
              ratio: job.progress.ratio,
            }
          : normalizedStoredProgress(patch.progress ?? job.progress),
    state: nextState,
    revision: nextMergeJobRevision(job),
    ...(nextState === 'queued' || nextState === 'resolving' || nextState === 'completed'
      ? { publicationPending: false }
      : {}),
    updatedAt: now,
  };

  if (nextState === 'completed' && !next.outputSizeBytes) {
    throw new Error('A completed merge job requires a verified outputSizeBytes value.');
  }
  if (nextState === 'blocked_drm' && next.failure?.code !== 'DRM_PROTECTED') {
    throw new Error('blocked_drm requires a DRM_PROTECTED failure.');
  }
  if (nextState === 'failed' && !next.failure) {
    throw new Error('A failed merge job requires failure details.');
  }
  return next;
}

export function updateMergeJobProgress(
  job: MergeJob,
  progress: MergeJob['progress'],
  now = Date.now(),
): MergeJob {
  if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'blocked_drm') {
    throw new Error(`Cannot update progress for terminal job state ${job.state}.`);
  }
  return {
    ...job,
    progress: projectMergeJobProgress(job.progress, progress),
    revision: nextMergeJobRevision(job),
    updatedAt: now,
  };
}

export function isTerminalMergeJobState(state: MergeJobState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'blocked_drm';
}
