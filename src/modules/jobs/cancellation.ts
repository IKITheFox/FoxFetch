import type { MergeJob } from './types';
import { touchMergeJob, transitionMergeJob } from './state-machine';
import type { MergeJobStore } from './store';

/** A dispatch/queued ACK is not evidence that media work and cleanup stopped. */
export function requireSettledMergeCancellation(response: unknown): void {
  const result = response as { ok?: unknown; settled?: unknown; error?: unknown } | null;
  if (result?.ok === true && result.settled === true) return;
  throw new Error(result?.error === 'CLEANUP_FAILED' ? 'CLEANUP_FAILED' : 'STOP_TIMEOUT');
}

export class MergeJobCancelledError extends Error {
  constructor() {
    super('当前常规下载任务已停止或正在停止。');
    this.name = 'AbortError';
  }
}

export function isMergeJobStopping(job: MergeJob): boolean {
  return (
    job.cancellationRequestedAt != null && job.state !== 'completed' && job.state !== 'cancelled'
  );
}

export function mergeJobAcceptsWork(job: MergeJob): boolean {
  return (
    job.cancellationRequestedAt == null &&
    !['completed', 'cancelled', 'blocked_drm'].includes(job.state)
  );
}

export function requestMergeJobCancellation(job: MergeJob, now = Date.now()): MergeJob {
  if (job.state === 'completed' || job.state === 'cancelled') return job;
  const requested = touchMergeJob(
    {
      ...job,
      cancellationRequestedAt: job.cancellationRequestedAt ?? now,
    },
    now,
  );
  delete requested.cancellationFailure;
  return requested;
}

export function settleMergeJobCancellation(job: MergeJob): MergeJob {
  if (job.state === 'completed' || job.state === 'cancelled') return job;
  const cancelled = transitionMergeJob(job, 'cancelled', {
    progress: { ...job.progress, message: '常规下载任务已停止。' },
  });
  delete cancelled.failure;
  delete cancelled.cancellationFailure;
  cancelled.publicationPending = false;
  return cancelled;
}

/** A late save cannot erase a cancellation fence or resurrect a committed task. */
export function assertMergeJobWriteAllowed(
  previous: MergeJob | undefined,
  incoming: MergeJob,
): void {
  if (!previous) return;
  if (previous.state === 'completed' && incoming.state !== 'completed')
    throw new MergeJobCancelledError();
  if (
    previous.state === 'cancelled' &&
    incoming.state !== 'cancelled' &&
    !(incoming.state === 'completed' && incoming.publicationCommitted === true)
  ) {
    throw new MergeJobCancelledError();
  }
  if (
    previous.cancellationRequestedAt != null &&
    incoming.cancellationRequestedAt !== previous.cancellationRequestedAt &&
    !(incoming.state === 'completed' && incoming.publicationCommitted === true)
  ) {
    throw new MergeJobCancelledError();
  }
}

export interface MergeCancellationLifecycle {
  store: Pick<MergeJobStore, 'get' | 'save'>;
  /** Must resolve after actual work cessation/cleanup, never on a queued ACK. */
  stop(job: MergeJob): Promise<void>;
  release(job: MergeJob): Promise<MergeJob>;
  publish(job: MergeJob): Promise<unknown>;
}

/** Persist the fence first; only a verified publication may beat cancellation. */
export async function cancelMergeJobWithLifecycle(
  initial: MergeJob,
  lifecycle: MergeCancellationLifecycle,
): Promise<MergeJob> {
  let current = (await lifecycle.store.get(initial.id)) ?? initial;
  if (current.state === 'completed' || current.state === 'cancelled') return current;
  current = requestMergeJobCancellation(current);
  await lifecycle.store.save(current);
  await lifecycle.publish(current);
  try {
    await lifecycle.stop(current);
    current = (await lifecycle.store.get(current.id)) ?? current;
    if (current.state === 'completed') return current;
    current = await lifecycle.release(current);
    current = settleMergeJobCancellation(current);
    await lifecycle.store.save(current);
    await lifecycle.publish(current);
    return current;
  } catch (error) {
    current = (await lifecycle.store.get(current.id)) ?? current;
    if (current.state === 'completed') return current;
    current = touchMergeJob({
      ...current,
      cancellationFailure:
        error instanceof Error && error.message === 'CLEANUP_FAILED'
          ? 'CLEANUP_FAILED'
          : 'STOP_TIMEOUT',
    });
    await lifecycle.store.save(current);
    await lifecycle.publish(current);
    throw new Error(
      current.cancellationFailure === 'CLEANUP_FAILED'
        ? '任务已停止，临时资源清理失败，请重试返回。'
        : '尚未确认任务停止，请重试返回。',
      { cause: error },
    );
  }
}
