import type { MergeDockView, TabMediaState } from '../../shared/types';
import type { MergeJob } from './types';

export interface MergeWorkspaceLocation {
  tabId: number;
  reused: boolean;
}

export interface MergeWorkspaceChrome {
  tabs: {
    sendMessage(
      tabId: number,
      message:
        | { type: 'AGENT_OPEN_MERGE_DOCK'; view: MergeDockView }
        | { type: 'AGENT_UPDATE_MERGE_DOCK'; view: MergeDockView },
      options: { frameId: 0 },
    ): Promise<unknown>;
  };
}

/** Open a merge task inside the source page's existing Shadow DOM Dock. */
export async function openMergeWorkspace(
  tabId: number,
  view: MergeDockView,
  api: MergeWorkspaceChrome = chrome,
): Promise<MergeWorkspaceLocation> {
  await api.tabs.sendMessage(tabId, { type: 'AGENT_OPEN_MERGE_DOCK', view }, { frameId: 0 });
  return { tabId, reused: true };
}

/** Refresh an already-open Dock without navigating or creating browser UI. */
export async function updateMergeWorkspace(
  tabId: number,
  view: MergeDockView,
  api: MergeWorkspaceChrome = chrome,
): Promise<void> {
  await api.tabs.sendMessage(tabId, { type: 'AGENT_UPDATE_MERGE_DOCK', view }, { frameId: 0 });
}

/** A worker restart must not reopen a Dock the user has minimized in the page. */
export async function restoreMergeDockForOwner(
  jobs: readonly MergeJob[],
  owner: Pick<TabMediaState, 'tabId' | 'pageUrl' | 'mediaEpoch'>,
  publish: (job: MergeJob, open: false) => Promise<unknown>,
): Promise<void> {
  const job = jobs.find(
    (candidate) =>
      candidate.ownerTabId === owner.tabId &&
      (candidate.ownerPageUrl ??
        candidate.videoContext?.pageUrl ??
        candidate.audioContext?.pageUrl ??
        '') === owner.pageUrl &&
      (candidate.ownerMediaEpoch ?? 0) === (owner.mediaEpoch ?? 0) &&
      !['failed', 'completed', 'cancelled', 'blocked_drm'].includes(candidate.state),
  );
  if (job) await publish(job, false);
}
