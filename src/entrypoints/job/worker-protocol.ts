import type {
  CompletedRemux,
  FileSystemFileHandleLike,
  MergeCapability,
  MergeFailureDetail,
  RemuxProgress,
  SeparateTrackMergeRequest,
} from '../../modules/merge';
import type {
  CompletedStandardSeparateExport,
  StandardSeparateOutputHandles,
} from '../../modules/exports';

export type JobWorkerRequest =
  | {
      type: 'PREFLIGHT';
      jobId: string;
      attemptId: string;
      request: SeparateTrackMergeRequest;
    }
  | {
      type: 'START';
      jobId: string;
      attemptId: string;
      request: SeparateTrackMergeRequest;
      handle: FileSystemFileHandleLike;
    }
  | {
      type: 'EXPORT_SEPARATE';
      jobId: string;
      attemptId: string;
      request: SeparateTrackMergeRequest;
      handles: StandardSeparateOutputHandles;
    }
  | { type: 'CANCEL'; jobId: string; attemptId: string };

export type JobWorkerEvent =
  | { type: 'ACK' | 'HEARTBEAT'; jobId: string; attemptId: string }
  | { type: 'CAPABILITY'; jobId: string; attemptId: string; capability: MergeCapability }
  | { type: 'PROGRESS'; jobId: string; attemptId: string; progress: RemuxProgress }
  | { type: 'COMPLETED'; jobId: string; attemptId: string; result: CompletedRemux }
  | {
      type: 'SEPARATE_COMPLETED';
      jobId: string;
      attemptId: string;
      result: CompletedStandardSeparateExport;
    }
  | { type: 'FAILED'; jobId: string; attemptId: string; failure: MergeFailureDetail };

export function isCurrentJobWorkerAttempt(
  event: Pick<JobWorkerEvent, 'jobId' | 'attemptId'>,
  expected: { jobId: string; attemptId: string },
): boolean {
  return event.jobId === expected.jobId && event.attemptId === expected.attemptId;
}
