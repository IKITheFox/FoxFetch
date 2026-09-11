import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MseCaptureHookInstallResult } from '../../src/modules/resolver/mse-capture-main';
import { bootstrapMseCaptureMainWorld } from '../../src/modules/resolver/mse-hook-bootstrap';

const unsupported = (): MseCaptureHookInstallResult => ({
  version: 3,
  supported: false,
  protocolVersion: 3,
  buildId: 'foxfetch-mse-hook-v3',
  health: 'unsupported',
  installedNow: false,
});

const ready = (): MseCaptureHookInstallResult => ({
  version: 3,
  supported: true,
  protocolVersion: 3,
  buildId: 'foxfetch-mse-hook-v3',
  health: 'ready',
  installedNow: true,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MSE hook document_start bootstrap', () => {
  it('retries before DOMContentLoaded and stops as soon as the hook is ready', async () => {
    vi.useFakeTimers();
    const install = vi
      .fn<() => MseCaptureHookInstallResult>()
      .mockReturnValueOnce(unsupported())
      .mockReturnValueOnce(unsupported())
      .mockReturnValue(ready());

    bootstrapMseCaptureMainWorld({ install, retryWindowMs: 100, retryDelaysMs: [0, 10] });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    expect(install).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds retries and removes timers on pages that never expose MSE', async () => {
    vi.useFakeTimers();
    const install = vi.fn<() => MseCaptureHookInstallResult>().mockImplementation(unsupported);

    bootstrapMseCaptureMainWorld({ install, retryWindowMs: 30, retryDelaysMs: [10] });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);

    expect(install.mock.calls.length).toBeGreaterThan(1);
    expect(install.mock.calls.length).toBeLessThanOrEqual(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces a lifecycle retry with the pending timer', async () => {
    vi.useFakeTimers();
    const install = vi
      .fn<() => MseCaptureHookInstallResult>()
      .mockReturnValueOnce(unsupported())
      .mockReturnValue(ready());

    bootstrapMseCaptureMainWorld({ install, retryWindowMs: 100, retryDelaysMs: [50] });
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);

    expect(install).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
