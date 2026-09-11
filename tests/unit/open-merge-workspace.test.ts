import { describe, expect, it, vi } from 'vitest';

import {
  openMergeWorkspace,
  restoreMergeDockForOwner,
  updateMergeWorkspace,
  type MergeWorkspaceChrome,
} from '../../src/modules/jobs/open-workspace';
import type { MergeDockView } from '../../src/shared/types';
import { mergeJobFromSeed } from '../../src/modules/jobs/store';
import type { MergeJob } from '../../src/modules/jobs/types';

function api(overrides: Partial<MergeWorkspaceChrome> = {}): MergeWorkspaceChrome {
  return {
    tabs: { sendMessage: vi.fn(async () => ({ ok: true })) },
    ...overrides,
  };
}

const view: MergeDockView = {
  actionToken: 'action-token',
  pathToken: 'path-token',
  title: '示例视频',
  state: 'ready',
  status: '可以合并下载',
  progress: 0,
  savePath: 'Downloads/FoxFetch/Bilibili',
  pathMode: 'automatic',
  mergeEnabled: true,
  separateEnabled: true,
  busy: false,
};

describe('inline merge workspace', () => {
  it('opens the source tab Dock without creating browser UI', async () => {
    const chromeApi = api();
    await expect(openMergeWorkspace(19, view, chromeApi)).resolves.toEqual({
      tabId: 19,
      reused: true,
    });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(
      19,
      { type: 'AGENT_OPEN_MERGE_DOCK', view },
      { frameId: 0 },
    );
  });

  it('updates the same Dock with a sanitized snapshot', async () => {
    const chromeApi = api();
    await expect(updateMergeWorkspace(32, view, chromeApi)).resolves.toBeUndefined();
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(
      32,
      { type: 'AGENT_UPDATE_MERGE_DOCK', view },
      { frameId: 0 },
    );
  });

  it.each([
    'queued',
    'resolving',
    'permission_required',
    'ready',
    'fetching',
    'muxing',
    'saving',
    'verifying',
  ] as const)(
    'passively restores %s after a worker restart without reopening a minimized Dock',
    async (state) => {
      const chromeApi = api();
      const job: MergeJob = {
        ...mergeJobFromSeed({
          id: 'restored',
          videoUrl: 'https://media.example/video',
          audioUrl: 'https://media.example/audio',
          createdAt: 100,
          ownerTabId: 32,
          ownerPageUrl: 'https://page.example/video',
          ownerMediaEpoch: 4,
        }),
        state,
      };
      const publish = vi.fn(async (_job: MergeJob, open: false) => {
        if (open) await openMergeWorkspace(32, view, chromeApi);
        else await updateMergeWorkspace(32, view, chromeApi);
      });
      await restoreMergeDockForOwner(
        [job],
        { tabId: 32, pageUrl: 'https://page.example/video', mediaEpoch: 4 },
        publish,
      );
      expect(publish).toHaveBeenCalledWith(job, false);
      expect(chromeApi.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(
        32,
        { type: 'AGENT_UPDATE_MERGE_DOCK', view },
        { frameId: 0 },
      );
    },
  );

  it('does not restore terminal or other-page task snapshots', async () => {
    const seed = mergeJobFromSeed({
      id: 'old-task',
      videoUrl: 'https://media.example/video',
      audioUrl: 'https://media.example/audio',
      createdAt: 100,
      ownerTabId: 32,
      ownerPageUrl: 'https://page.example/video',
      ownerMediaEpoch: 4,
    });
    const publish = vi.fn();
    const owner = { tabId: 32, pageUrl: 'https://page.example/video', mediaEpoch: 4 };
    await restoreMergeDockForOwner(
      ['failed', 'completed', 'cancelled', 'blocked_drm'].map((state) => ({
        ...seed,
        state: state as MergeJob['state'],
      })),
      owner,
      publish,
    );
    await restoreMergeDockForOwner(
      [{ ...seed, state: 'fetching', ownerMediaEpoch: 3 }],
      owner,
      publish,
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
