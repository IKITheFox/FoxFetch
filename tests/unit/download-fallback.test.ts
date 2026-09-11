import { afterEach, describe, expect, it } from 'vitest';

import {
  clearMseDownloadFallbacksForTab,
  rememberMseDownloadFallbacks,
  shouldStartMseCacheFallback,
  takeMseDownloadFallback,
} from '../../src/modules/resolver/download-fallback';
import type { DownloadRecord } from '../../src/shared/types';

const originalChrome = globalThis.chrome;

function record(id: number, assetId: string): DownloadRecord {
  return {
    id: `record-${id}`,
    assetId,
    filename: `${assetId}.mp4`,
    url: `https://cdn.example/${assetId}.mp4`,
    kind: 'video',
    state: 'downloading',
    chromeDownloadId: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

function installStorageMock(): void {
  const values: Record<string, unknown> = {};
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: {
        session: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(values, patch),
        },
      },
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: originalChrome,
  });
});

describe('MSE download fallback context', () => {
  it('persists an asynchronous download mapping and consumes it exactly once', async () => {
    installStorageMock();
    await rememberMseDownloadFallbacks(7, [record(101, 'video')], 1_000);

    await expect(takeMseDownloadFallback(101, 2_000)).resolves.toMatchObject({
      chromeDownloadId: 101,
      tabId: 7,
      assetId: 'video',
    });
    await expect(takeMseDownloadFallback(101, 2_000)).resolves.toBeUndefined();
  });

  it('prunes expired mappings and clears mappings for a closed tab', async () => {
    installStorageMock();
    await rememberMseDownloadFallbacks(7, [record(101, 'video')], 1_000);
    await rememberMseDownloadFallbacks(8, [record(102, 'audio')], 1_000);
    await clearMseDownloadFallbacksForTab(7, 2_000);

    await expect(takeMseDownloadFallback(101, 2_000)).resolves.toBeUndefined();
    await expect(takeMseDownloadFallback(102, 60 * 60_000)).resolves.toBeUndefined();
  });

  it('does not restart capture for an explicit user cancellation', () => {
    expect(shouldStartMseCacheFallback('USER_CANCELED')).toBe(false);
    expect(shouldStartMseCacheFallback('USER_SHUTDOWN')).toBe(false);
    expect(shouldStartMseCacheFallback('FILE_ACCESS_DENIED')).toBe(false);
    expect(shouldStartMseCacheFallback('FILE_NO_SPACE')).toBe(false);
    expect(shouldStartMseCacheFallback('CRASH')).toBe(false);
    expect(shouldStartMseCacheFallback('NETWORK_FAILED')).toBe(true);
    expect(shouldStartMseCacheFallback('SERVER_FORBIDDEN')).toBe(true);
    expect(shouldStartMseCacheFallback()).toBe(true);
  });
});
