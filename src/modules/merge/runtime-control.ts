import { mergeError } from './errors';
import type { MergeDiagnosticStage, MergeFailureReason } from './types';

export const MERGE_RUNTIME_LIMITS = {
  headersMs: 20_000,
  bodyIdleMs: 30_000,
  parserIdleMs: 30_000,
  workerAckMs: 3_000,
  heartbeatMs: 2_000,
  heartbeatIdleMs: 10_000,
  cancelGraceMs: 2_000,
} as const;

export function mergeAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

export function checkMergeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mergeAbortReason(signal);
}

/** The operation must also release its own I/O through onStop; a race alone is not cancellation. */
export async function withMergeDeadline<T>(
  operation: Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    reason?: MergeFailureReason;
    stage?: MergeDiagnosticStage;
    onStop?: (reason: unknown) => void;
    getLastAdvance?: () => number;
  } = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        let stopped = false;
        const stop = (reason: unknown) => {
          if (stopped) return;
          stopped = true;
          try {
            options.onStop?.(reason);
          } finally {
            reject(reason);
          }
        };
        abort = () => stop(mergeAbortReason(options.signal));
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        const startedAt = Date.now();
        const budget = options.timeoutMs ?? MERGE_RUNTIME_LIMITS.parserIdleMs;
        const checkIdle = () => {
          const remaining =
            budget - (Date.now() - Math.max(startedAt, options.getLastAdvance?.() ?? startedAt));
          if (remaining > 0) {
            timer = setTimeout(checkIdle, remaining);
            return;
          }
          stop(
            mergeError(
              options.reason === 'NETWORK_TIMEOUT' || options.reason === 'BODY_STALLED'
                ? 'NETWORK_FAILED'
                : 'INTERNAL_ERROR',
              '当前阶段长时间没有有效进展，已停止本次操作。',
              {
                reason: options.reason ?? 'PARSER_TIMEOUT',
                stage: options.stage ?? 'media-metadata',
                retryable: true,
              },
            ),
          );
        };
        timer = setTimeout(checkIdle, budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}

/** Every actual body read has an idle budget; long continuously progressing files have no total timeout. */
export function createTimedMergeFetch(
  baseFetch: typeof fetch = fetch,
  callerSignal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const signals = [callerSignal, init?.signal].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    const abort = () => controller.abort(signals.find((signal) => signal.aborted)?.reason);
    const release = () => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    };
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    const stop = (reason: unknown) => controller.abort(reason);
    let response: Response;
    try {
      checkMergeAborted(controller.signal);
      response = await withMergeDeadline(baseFetch(input, { ...init, signal: controller.signal }), {
        signal: controller.signal,
        timeoutMs: MERGE_RUNTIME_LIMITS.headersMs,
        reason: 'NETWORK_TIMEOUT',
        stage: 'source-headers',
        onStop: stop,
      });
    } catch (error) {
      release();
      throw error;
    }
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const result = await withMergeDeadline(
            (async () => {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done || chunk.value.byteLength > 0) return chunk;
              }
            })(),
            {
              signal: controller.signal,
              timeoutMs: MERGE_RUNTIME_LIMITS.bodyIdleMs,
              reason: 'BODY_STALLED',
              stage: 'source-body',
              onStop: stop,
            },
          );
          if (result.done) {
            release();
            target.close();
          } else {
            onBytes?.(result.value.byteLength);
            target.enqueue(result.value);
          }
        } catch (error) {
          release();
          void reader.cancel(error).catch(() => undefined);
          target.error(error);
        }
      },
      cancel(reason) {
        release();
        controller.abort(reason);
        // A remote stream may ignore cancellation. Never wait indefinitely on it.
        void reader.cancel(reason).catch(() => undefined);
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  };
}
