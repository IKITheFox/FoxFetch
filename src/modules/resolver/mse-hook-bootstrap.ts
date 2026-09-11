import { installMseCaptureMainWorld, type MseCaptureHookInstallResult } from './mse-capture-main';

export interface MseHookBootstrapOptions {
  install?: () => MseCaptureHookInstallResult;
  retryWindowMs?: number;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [0, 10, 25, 50, 100, 200, 500] as const;

/**
 * Chromium can expose the MSE constructors a few tasks after document_start.
 * Retry quickly enough to beat player initialization, then stop after a small
 * bounded window so unsupported pages do not retain timers or listeners.
 */
export function bootstrapMseCaptureMainWorld(
  options: MseHookBootstrapOptions = {},
): MseCaptureHookInstallResult {
  const install = options.install ?? installMseCaptureMainWorld;
  const retryWindowMs = Math.max(0, options.retryWindowMs ?? 5_000);
  const retryDelaysMs =
    options.retryDelaysMs && options.retryDelaysMs.length > 0
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
  const initial = install();
  if (initial.health !== 'unsupported' || retryWindowMs === 0) return initial;

  const startedAt = Date.now();
  let settled = false;
  let retryIndex = 0;
  let timerId: number | undefined;

  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    if (timerId != null) window.clearTimeout(timerId);
    timerId = undefined;
    document.removeEventListener('DOMContentLoaded', attempt);
    window.removeEventListener('load', attempt);
  };

  const schedule = (): void => {
    const remaining = retryWindowMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      cleanup();
      return;
    }
    const configuredDelay = retryDelaysMs[Math.min(retryIndex, retryDelaysMs.length - 1)]!;
    retryIndex += 1;
    timerId = window.setTimeout(attempt, Math.min(Math.max(0, configuredDelay), remaining));
  };

  function attempt(): void {
    if (settled) return;
    if (timerId != null) window.clearTimeout(timerId);
    timerId = undefined;
    const result = install();
    if (result.health !== 'unsupported' || Date.now() - startedAt >= retryWindowMs) {
      cleanup();
      return;
    }
    schedule();
  }

  document.addEventListener('DOMContentLoaded', attempt);
  window.addEventListener('load', attempt);
  queueMicrotask(attempt);
  return initial;
}
