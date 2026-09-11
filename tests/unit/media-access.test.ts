import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FULL_MEDIA_ACCESS_PERMISSIONS,
  assertMediaAccessIntentContext,
  hasFullMediaAccess,
  runMediaAccessIntent,
} from '../../src/modules/permissions/media-access';
import type { MediaAccessIntentAction, TabMediaState } from '../../src/shared/types';

const originalChrome = globalThis.chrome;

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: originalChrome });
});

describe('full media access broker client', () => {
  it('rejects an old merge intent when the route or same-page player epoch changed', () => {
    const state: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Example',
      scannedAt: 1,
      status: 'ready',
      assets: [],
      mediaElements: [],
      mediaEpoch: 4,
    };
    const action: MediaAccessIntentAction = {
      kind: 'merge-assets',
      tabId: 7,
      videoAssetId: 'video',
      audioAssetId: 'audio',
      expectedPageUrl: state.pageUrl,
      expectedMediaEpoch: 4,
    };

    expect(() => assertMediaAccessIntentContext(state, state.pageUrl, action)).not.toThrow();
    expect(() =>
      assertMediaAccessIntentContext(state, state.pageUrl, {
        ...action,
        expectedMediaEpoch: 3,
      }),
    ).toThrow('当前媒体正在自动更新');
    expect(() =>
      assertMediaAccessIntentContext(state, 'https://example.com/other', action),
    ).toThrow('当前媒体正在自动更新');
  });

  it('stages the merge intent and requests the one-time permission before yielding', async () => {
    let settleStage: (() => void) | undefined;
    let settlePermission: ((value: boolean) => void) | undefined;
    const stage = vi.fn(
      () =>
        new Promise<{ intentId: string }>((resolve) => {
          settleStage = () => resolve({ intentId: 'staged' });
        }),
    );
    const request = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settlePermission = resolve;
        }),
    );
    const commit = vi.fn(async (intentId: string) => ({ mode: 'merge' as const, jobId: intentId }));
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { permissions: { request, contains: vi.fn(async () => true) } },
    });

    const pending = runMediaAccessIntent(
      {
        kind: 'merge-assets',
        tabId: 7,
        videoAssetId: 'video',
        audioAssetId: 'audio',
        expectedPageUrl: 'https://example.com/watch',
        expectedMediaEpoch: 1,
      },
      { stage, commit, cancel: vi.fn(async () => undefined) },
    );

    expect(stage).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(FULL_MEDIA_ACCESS_PERMISSIONS);
    expect(commit).not.toHaveBeenCalled();
    settleStage?.();
    settlePermission?.(true);
    await expect(pending).resolves.toMatchObject({ mode: 'merge' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('cancels a staged intent when the user rejects access', async () => {
    const cancel = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        permissions: {
          request: vi.fn(async () => false),
          contains: vi.fn(async () => false),
        },
      },
    });

    await expect(
      runMediaAccessIntent(
        {
          kind: 'merge-assets',
          tabId: 7,
          videoAssetId: 'video',
          audioAssetId: 'audio',
          expectedPageUrl: 'https://example.com/watch',
          expectedMediaEpoch: 1,
        },
        {
          stage: vi.fn(async (intent) => ({ intentId: intent.id })),
          commit: vi.fn(),
          cancel,
        },
      ),
    ).rejects.toThrow('未获得完整媒体访问权限');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('checks the complete optional permission bundle', async () => {
    const contains = vi.fn(async () => true);
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { permissions: { contains } },
    });

    await expect(hasFullMediaAccess()).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith(FULL_MEDIA_ACCESS_PERMISSIONS);
  });
});
