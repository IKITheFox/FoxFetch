import type {
  DownloadActivityOwner,
  DownloadActivityView,
  DownloadRecord,
} from '../../shared/types';

export const DOWNLOAD_ACTIVITY_TERMINAL_MS = 12_000;

export function sameDownloadActivityOwner(
  left: DownloadActivityOwner | undefined,
  right: DownloadActivityOwner,
): boolean {
  return (
    left?.tabId === right.tabId &&
    left.pageIdentity === right.pageIdentity &&
    left.mediaEpoch === right.mediaEpoch &&
    left.documentId === right.documentId
  );
}

/** Reconstruct a URL-free status from records owned by this exact player generation. */
export function presentDownloadActivity(
  records: readonly DownloadRecord[],
  owner: DownloadActivityOwner,
  revision: number,
  now = Date.now(),
  pendingStarts = 0,
): DownloadActivityView {
  const owned = records.filter((record) => sameDownloadActivityOwner(record.owner, owner));
  const active = owned.filter(
    (record) => record.state === 'downloading' || record.state === 'queued',
  );
  const pending = Math.max(0, Math.floor(pendingStarts));
  const recent = [...owned].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  let state: DownloadActivityView['state'] = 'idle';
  if (active.some((record) => record.state === 'downloading')) state = 'downloading';
  else if (active.length || pending) state = 'preparing';
  else if (
    recent &&
    now >= recent.updatedAt &&
    now - recent.updatedAt < DOWNLOAD_ACTIVITY_TERMINAL_MS
  ) {
    state =
      recent.state === 'complete'
        ? 'completed'
        : recent.error === 'USER_CANCELED'
          ? 'cancelled'
          : 'failed';
  }
  return {
    pageIdentity: owner.pageIdentity,
    mediaEpoch: owner.mediaEpoch,
    revision,
    state,
    // Only admitted records are counted. A pending batch is not one download.
    activeCount: active.length,
    updatedAt: active.length || pending ? now : (recent?.updatedAt ?? now),
  };
}

/** UI delivery must never gate a download, its result, or its cleanup. */
export function notifyDownloadActivity(publish: () => Promise<void>): void {
  try {
    void publish().catch(() => undefined);
  } catch {
    // The authoritative job/history continues even if a disconnected UI rejects synchronously.
  }
}
