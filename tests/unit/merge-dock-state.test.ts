import { describe, expect, it } from 'vitest';
import {
  mergeJobFromSeed,
  presentMergeDockJob,
  touchMergeJob,
  transitionMergeJob,
  updateMergeJobProgress,
  type MergeJob,
  type MergeJobState,
} from '../../src/modules/jobs';
import { shouldAcceptMergeDockView } from '../../src/shared/merge-dock-state';

function job(): MergeJob {
  return mergeJobFromSeed({
    id: 'private-job',
    videoUrl: 'https://cdn.example/video?token=secret',
    audioUrl: 'https://cdn.example/audio?token=secret',
    ownerTabId: 1,
    ownerPageUrl: 'https://www.bilibili.com/video/BV1CURRENT',
    ownerMediaEpoch: 7,
    createdAt: 100,
  });
}

function view(source: MergeJob) {
  return presentMergeDockJob(
    source,
    { actionToken: 'action', pathToken: 'path' },
    { savePath: 'Downloads/FoxFetch/Bilibili', pathMode: 'automatic' },
  );
}

describe('v0.12.0 public merge lifecycle', () => {
  it.each(['queued', 'resolving', 'permission_required'] as const)(
    'keeps %s initialization/permission ahead of auxiliary fetching',
    (state) => {
      const source = {
        ...job(),
        state,
        progress: {
          phase: 'fetching' as const,
          ratio: 0.9,
          readBytes: 900,
          totalBytes: 1000,
          message: 'fetch https://private.example/?token=secret',
        },
      };
      const snapshot = view(source);
      expect(snapshot.phase).toBe(state);
      expect(snapshot.progress).toBeNull();
      expect(snapshot.state).toBe(state === 'permission_required' ? state : 'preparing');
      expect(snapshot.status).not.toContain('已下载');
      expect(JSON.stringify(snapshot)).not.toContain('secret');
    },
  );

  it.each([
    ['ready', 'ready', 0],
    ['fetching', 'fetching', 0.8],
    ['muxing', 'muxing', 0.2],
    ['saving', 'saving', 0.95],
    ['verifying', 'verifying', 0.99],
    ['paused', 'paused', 0.6],
    ['completed', 'completed', 1],
    ['failed', 'failed', 0.7],
    ['cancelled', 'cancelled', 0.7],
    ['blocked_drm', 'blocked_drm', 0.7],
  ] as const)('maps %s by real state rather than percentage thresholds', (state, phase, ratio) => {
    const snapshot = view({
      ...job(),
      state,
      progress: { phase: 'fetching', ratio, readBytes: 1, totalBytes: 2, message: 'private' },
    });
    expect(snapshot.phase).toBe(phase);
    expect(snapshot.progress).toBe(ratio);
  });

  it('uses an explicit publication event rather than 99 percent to show saving', () => {
    const verifying = { ...job(), state: 'verifying' as const, publicationPending: false };
    verifying.progress.ratio = 0.99;
    expect(view(verifying).status).toBe('正在检查生成的文件');
    const publishing = view({ ...verifying, publicationPending: true });
    expect(publishing.phase).toBe('saving');
    expect(publishing.status).toBe('正在保存文件');
  });

  it('orders changes independently of wall clock and keeps stable presentation identity', () => {
    const initial = job();
    const resolving = transitionMergeJob(initial, 'resolving', {}, 1);
    const ready = transitionMergeJob(resolving, 'ready', {}, 1);
    const progress = updateMergeJobProgress(ready, { ...ready.progress, phase: 'probing' }, 0);
    const pathChanged = touchMergeJob(progress, 0);
    expect([initial, resolving, ready, progress, pathChanged].map((item) => item.revision)).toEqual(
      [0, 1, 2, 3, 4],
    );
    expect(view(pathChanged).snapshot?.taskKey).toBe(view(initial).snapshot?.taskKey);
    expect(JSON.stringify(view(pathChanged))).not.toContain('private-job');
    expect(shouldAcceptMergeDockView(view(pathChanged), view(resolving))).toBe(false);
    expect(shouldAcceptMergeDockView(view(resolving), view(pathChanged))).toBe(true);
  });

  it('accepts only an explicitly opened new task and refuses stale media or unversioned updates', () => {
    const previous = view(job());
    const replacement = view({ ...job(), ownerMediaEpoch: 8 });
    expect(shouldAcceptMergeDockView(previous, replacement)).toBe(false);
    expect(shouldAcceptMergeDockView(previous, replacement, { allowTaskChange: true })).toBe(true);
    expect(shouldAcceptMergeDockView(replacement, previous, { allowTaskChange: true })).toBe(false);
    const legacy = { ...previous };
    delete legacy.snapshot;
    expect(shouldAcceptMergeDockView(previous, legacy)).toBe(false);
    expect(shouldAcceptMergeDockView(legacy, previous)).toBe(true);
  });

  it('accepts rotated capabilities at the same revision without exposing a private error', () => {
    const source = {
      ...job(),
      state: 'failed' as MergeJobState,
      failure: {
        code: 'DYNAMIC_RANGE_UNVERIFIED' as const,
        message: 'https://private.example?token=secret',
        retryable: false,
        canDownloadSeparately: true,
      },
    };
    const previous = view(source);
    const fresh = { ...previous, actionToken: 'rotated' };
    expect(shouldAcceptMergeDockView(previous, fresh)).toBe(true);
    expect(previous.error).toContain('信息未通过检查');
    expect(JSON.stringify(previous)).not.toContain('secret');
  });
});
