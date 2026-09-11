import type { MergeJobSeed } from '../../shared/types';
import type { MergeContainerPreference, MergeFailureDetail, MergePlan, RemuxPhase } from '../merge';

export type MergeJobState =
  | 'queued'
  | 'resolving'
  | 'permission_required'
  | 'ready'
  | 'fetching'
  | 'muxing'
  | 'saving'
  | 'verifying'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked_drm';

export interface MergeJobProgress {
  phase: RemuxPhase | 'idle';
  ratio: number | null;
  readBytes: number;
  totalBytes: number | null;
  message: string;
  /** Explicit worker stage, separately presented from the task lifecycle. */
  stage?: string;
  lastProgressAt?: number;
  network?: import('../merge/types').MergeNetworkDiagnostic;
}

export interface MergeJob extends MergeJobSeed {
  /** Frozen at execution start; later preference changes only affect new jobs. */
  savePathPolicy?: import('./path-policy').MergeDownloadPathPolicy;
  /** An explicit repeat click, never set by opening the download panel. */
  repeatAction?: 'merge' | 'separate';
  repeatedByJobId?: string;
  schemaVersion: 1;
  /** Stable public presentation key; unrelated to the private job identifier. */
  viewKey?: string;
  /** Monotonic mutation revision, including mutations within one clock tick. */
  revision?: number;
  /** Local verification finished; browser/custom-directory publication is pending. */
  publicationPending?: boolean;
  /** Persistent cancellation fence. It must survive late callbacks and worker restarts. */
  cancellationRequestedAt?: number;
  cancellationFailure?: 'STOP_TIMEOUT' | 'CLEANUP_FAILED';
  /** Set only after an actual browser/custom-directory commit, not mux completion. */
  publicationCommitted?: boolean;
  state: MergeJobState;
  preferredContainer: MergeContainerPreference;
  fileName: string;
  progress: MergeJobProgress;
  plan?: MergePlan;
  failure?: MergeFailureDetail;
  outputSizeBytes?: number;
  resumeState?: 'fetching' | 'muxing';
  /** Session DNR rule ids; retained only so a reloaded job page can clean stale rules. */
  requestRuleIds?: number[];
  /** Persisted fail-closed guard: one job may enter page-assisted staging at most once. */
  pageAssistedAttempted?: boolean;
  updatedAt: number;
}

export type MergeJobPatch = Partial<
  Pick<
    MergeJob,
    | 'preferredContainer'
    | 'fileName'
    | 'progress'
    | 'plan'
    | 'failure'
    | 'outputSizeBytes'
    | 'resumeState'
    | 'requestRuleIds'
    | 'pageAssistedAttempted'
    | 'title'
  >
>;
