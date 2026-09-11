import { MERGE_RUNTIME_LIMITS } from '../../modules/merge/runtime-control';

/** Heartbeats prove the worker event loop is alive, never that media bytes advanced. */
export function superviseMergeWorker(callbacks: {
  fail: (reason: 'WORKER_START_TIMEOUT' | 'WORKER_UNRESPONSIVE') => void;
  terminate: () => void;
}) {
  let closed = false;
  let acknowledged = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const ackTimer = setTimeout(() => {
    if (!closed && !acknowledged) callbacks.fail('WORKER_START_TIMEOUT');
  }, MERGE_RUNTIME_LIMITS.workerAckMs);
  const close = () => {
    closed = true;
    clearTimeout(ackTimer);
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
  };
  return {
    receive() {
      if (closed) return;
      acknowledged = true;
      clearTimeout(ackTimer);
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        if (!closed) callbacks.fail('WORKER_UNRESPONSIVE');
      }, MERGE_RUNTIME_LIMITS.heartbeatIdleMs);
    },
    cancel() {
      if (closed || cancelTimer !== undefined) return;
      clearTimeout(ackTimer);
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      cancelTimer = setTimeout(() => {
        close();
        callbacks.terminate();
      }, MERGE_RUNTIME_LIMITS.cancelGraceMs);
    },
    close,
  };
}
