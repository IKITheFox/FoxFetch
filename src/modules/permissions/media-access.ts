import type {
  MediaAccessIntent,
  MediaAccessIntentAction,
  MediaAccessIntentResult,
  MediaAccessIntentStaged,
  TabMediaState,
} from '../../shared/types';

export const FULL_MEDIA_ACCESS_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ['webRequest'],
  origins: ['http://*/*', 'https://*/*'],
};

export function createMediaAccessIntent(action: MediaAccessIntentAction): MediaAccessIntent {
  return {
    id:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `media-access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    action,
    createdAt: Date.now(),
  };
}

/** Reject a permission continuation if the tab route or player generation changed. */
export function assertMediaAccessIntentContext(
  state: TabMediaState | undefined,
  currentPageUrl: string,
  action: MediaAccessIntentAction,
): asserts state is TabMediaState {
  if (
    !state ||
    state.pageUrl !== currentPageUrl ||
    action.expectedPageUrl !== state.pageUrl ||
    action.expectedMediaEpoch !== (state.mediaEpoch ?? 0)
  ) {
    throw new Error('当前媒体正在自动更新，请重新选择完整视频');
  }
}

export async function hasFullMediaAccess(): Promise<boolean> {
  return chrome.permissions.contains(FULL_MEDIA_ACCESS_PERMISSIONS).catch(() => false);
}

/**
 * Call this directly from a click handler. Do not put an awaited contains()
 * check in front of it: doing so can consume Chrome's transient user gesture.
 * Chrome resolves an already-granted request without showing another prompt.
 */
export function requestFullMediaAccess(): Promise<boolean> {
  return chrome.permissions.request(FULL_MEDIA_ACCESS_PERMISSIONS);
}

export interface MediaAccessIntentClient {
  stage(intent: MediaAccessIntent): Promise<MediaAccessIntentStaged>;
  commit(intentId: string): Promise<MediaAccessIntentResult>;
  cancel(intentId: string): Promise<void>;
}

/**
 * Stage the operation and start Chrome's permission request in the same
 * synchronous user-activation turn. The background may commit independently
 * through permissions.onAdded if the calling action popup closes.
 */
export async function runMediaAccessIntent(
  action: MediaAccessIntentAction,
  client: MediaAccessIntentClient,
): Promise<MediaAccessIntentResult> {
  const intent = createMediaAccessIntent(action);
  const staged = client.stage(intent);
  let cancelled = false;
  let permission: Promise<boolean>;
  try {
    permission = requestFullMediaAccess();
  } catch (error) {
    void staged.then(
      () => client.cancel(intent.id).catch(() => undefined),
      () => undefined,
    );
    throw error;
  }

  try {
    await staged;
    const granted = await permission;
    if (!granted) {
      await client.cancel(intent.id).catch(() => undefined);
      cancelled = true;
      throw new Error('未获得完整媒体访问权限，无法创建合并下载任务');
    }
    return await client.commit(intent.id);
  } catch (error) {
    if (!cancelled && !(await hasFullMediaAccess())) {
      await client.cancel(intent.id).catch(() => undefined);
    }
    throw error;
  }
}
