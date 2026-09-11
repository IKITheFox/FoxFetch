/** Pause acquisition only for completed output, never for incomplete protocol segments. */
export async function waitForSabrOutput(
  queued: () => number,
  signal: AbortSignal,
  now = () => Date.now(),
): Promise<void> {
  const started = now();
  while (queued() > 8 * 1024 * 1024) {
    signal.throwIfAborted();
    if (now() - started >= 10_000) throw new Error('SABR_WRITE_STALLED');
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 10);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  signal.throwIfAborted();
}
