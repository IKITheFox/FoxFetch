import { expect, it, vi } from 'vitest';
import { YouTubePermissionContinuation } from '../../src/modules/youtube/permission-continuation';
import type {
  YouTubeTaskRequest,
  YouTubeTaskSnapshot,
} from '../../src/modules/youtube/background-task';
import type { SessionStorageArea } from '../../src/modules/permissions/pending-intents';

function setup() {
  const values: Record<string, unknown> = {};
  const storage: SessionStorageArea = {
    get: async (keys) =>
      keys == null
        ? structuredClone(values)
        : Object.fromEntries(
            (typeof keys === 'string' ? [keys] : keys).map((key) => [
              key,
              structuredClone(values[key]),
            ]),
          ),
    set: async (items) => {
      Object.assign(values, structuredClone(items));
    },
    remove: async (keys) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key];
    },
  };
  const request: YouTubeTaskRequest = {
    jobId: 'same-job',
    owner: {
      tabId: 4,
      documentId: 'doc',
      pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      navigationEpoch: 1,
      mediaEpoch: 2,
    },
    selection: {
      videoId: 'abcdefghijk',
      videoTrackId: 'vp9',
      audioTrackId: 'opus',
      container: 'webm',
      mode: 'merge',
    },
  };
  const snapshot: YouTubeTaskSnapshot = {
    jobId: request.jobId,
    videoId: 'abcdefghijk',
    state: 'resolving',
    files: [],
    readBytes: 0,
    cleanupPending: false,
  };
  const start = vi.fn(async () => snapshot);
  const assertCurrent = vi.fn(async () => {});
  const hasAccess = vi.fn(async () => true);
  const dependencies = { storage, start, assertCurrent, hasAccess };
  return {
    request,
    start,
    assertCurrent,
    hasAccess,
    dependencies,
    flow: new YouTubePermissionContinuation(dependencies),
  };
}

it('shares foreground and permission event completion, preserving the original request', async () => {
  const s = setup();
  await s.flow.stage(s.request);
  const original = structuredClone(s.request);
  s.request.selection.videoTrackId = 'changed-after-stage';
  await Promise.all([s.flow.commit(original.jobId, original.owner), s.flow.resumePending()]);
  expect(s.start).toHaveBeenCalledTimes(1);
  expect(s.start).toHaveBeenCalledWith(original);
  await new YouTubePermissionContinuation(s.dependencies).commit(original.jobId, original.owner);
  expect(s.start).toHaveBeenCalledTimes(1);
});

it('rejects other documents and navigation, and does not run denied or canceled intents', async () => {
  const s = setup();
  await s.flow.stage(s.request);
  await expect(
    s.flow.commit(s.request.jobId, { ...s.request.owner, documentId: 'other' }),
  ).rejects.toThrow('页面已变化');
  s.hasAccess.mockResolvedValue(false);
  await s.flow.resumePending();
  expect(s.start).not.toHaveBeenCalled();
  await s.flow.cancel(s.request.jobId, s.request.owner);
  s.hasAccess.mockResolvedValue(true);
  await s.flow.resumePending();
  expect(s.start).not.toHaveBeenCalled();
  const next = { ...s.request, jobId: 'next-job' };
  await s.flow.stage(next);
  s.assertCurrent.mockRejectedValue(new Error('PAGE_IDENTITY_CHANGED'));
  await s.flow.resumePending();
  expect(s.start).not.toHaveBeenCalled();
});

it('serializes simultaneous staging so another selection cannot replace the original', async () => {
  const s = setup();
  const changed = structuredClone(s.request);
  changed.selection.videoTrackId = 'other-track';
  const result = await Promise.allSettled([s.flow.stage(s.request), s.flow.stage(changed)]);
  expect(result.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  await s.flow.commit(s.request.jobId, s.request.owner);
  expect(s.start).toHaveBeenCalledWith(s.request);
});

it('never confirms cancellation of an intent whose start already won the race', async () => {
  const s = setup();
  await s.flow.stage(s.request);
  const result = await Promise.allSettled([
    s.flow.commit(s.request.jobId, s.request.owner),
    s.flow.cancel(s.request.jobId, s.request.owner),
  ]);
  expect(result.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(s.start).toHaveBeenCalledTimes(1);
});

it('does not start when cancellation wins against an authorization notification', async () => {
  const s = setup();
  await s.flow.stage(s.request);
  await Promise.all([s.flow.cancel(s.request.jobId, s.request.owner), s.flow.resumePending()]);
  expect(s.start).not.toHaveBeenCalled();
});
