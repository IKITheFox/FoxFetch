import type { MergeDockDirectorySelection, MergeDockPathMode } from '../../shared/types';
import { createCustomDownloadDirectoryMetadata } from '../downloads/download-target';
import { displayDownloadDirectory, downloadPlatformDirectory } from '../downloads/download-path';
import type { StorageAreaLike } from './store';

const STORAGE_PREFIX = 'foxfetch:merge-path-policy:';
const SHARED_POLICY_KEY = 'foxfetch:video-save-policy';
const LAST_DIRECTORY_KEY = 'foxfetch:last-video-directory';

export function assertNewVideoSavePolicy(
  pageUrl: string,
  policy: Pick<MergeDownloadPathPolicy, 'mode'>,
): void {
  if (
    ['youtube', 'bilibili'].includes(downloadPlatformDirectory(pageUrl)) &&
    policy.mode === 'custom'
  )
    throw new Error('旧自定义目录已停用，请选择默认位置或保存时选择位置。');
}

export type MergeDownloadPathPolicy =
  | { mode: 'automatic' }
  | { mode: 'ask' }
  | { mode: 'custom'; directory: MergeDockDirectorySelection };

/** Publication must not borrow a newly changed preference for an old running task. */
export async function publicationSavePolicy(
  pageUrl: string,
  fixed: MergeDownloadPathPolicy | undefined,
  storage: StorageAreaLike = chrome.storage.local,
): Promise<MergeDownloadPathPolicy> {
  if (fixed) return structuredClone(fixed);
  if (['youtube', 'bilibili'].includes(downloadPlatformDirectory(pageUrl)))
    throw new Error('旧任务未记录固定保存位置，已停止保存；请取消后重新下载并确认位置。');
  return getMergeDownloadPathPolicy(pageUrl, storage);
}

function storageKey(pageUrl: string): string {
  return `${STORAGE_PREFIX}${downloadPlatformDirectory(pageUrl).toLowerCase()}`;
}

function isPolicy(value: unknown): value is MergeDownloadPathPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    mode?: unknown;
    directory?: Partial<MergeDockDirectorySelection>;
  };
  if (candidate.mode === 'automatic' || candidate.mode === 'ask') return true;
  if (candidate.mode !== 'custom' || !candidate.directory) return false;
  try {
    createCustomDownloadDirectoryMetadata(
      candidate.directory.handleId ?? '',
      candidate.directory.name ?? '',
      candidate.directory.selectedAt,
    );
    return true;
  } catch {
    return false;
  }
}

export async function getMergeDownloadPathPolicy(
  pageUrl: string,
  storage: StorageAreaLike = chrome.storage.local,
): Promise<MergeDownloadPathPolicy> {
  const key = storageKey(pageUrl);
  const useShared = ['youtube', 'bilibili'].includes(downloadPlatformDirectory(pageUrl));
  const shared = useShared ? (await storage.get(SHARED_POLICY_KEY))[SHARED_POLICY_KEY] : undefined;
  const value = isPolicy(shared) ? shared : (await storage.get(key))[key];
  if (isPolicy(value)) return { ...value };
  const settings =
    typeof chrome !== 'undefined' && chrome.storage?.sync
      ? (await chrome.storage.sync.get('foxfetch:settings'))['foxfetch:settings']
      : undefined;
  return {
    mode:
      (settings as { download?: { saveAs?: boolean } } | undefined)?.download?.saveAs === true
        ? 'ask'
        : 'automatic',
  };
}

export async function saveMergeDownloadPathPolicy(
  pageUrl: string,
  value: MergeDockPathMode | MergeDownloadPathPolicy,
  storage: StorageAreaLike = chrome.storage.local,
): Promise<MergeDownloadPathPolicy> {
  const policy: MergeDownloadPathPolicy =
    typeof value === 'string'
      ? value === 'custom'
        ? (() => {
            throw new TypeError('自定义保存位置缺少目录信息');
          })()
        : { mode: value }
      : isPolicy(value)
        ? value.mode === 'custom'
          ? {
              mode: 'custom',
              directory: createCustomDownloadDirectoryMetadata(
                value.directory.handleId,
                value.directory.name,
                value.directory.selectedAt,
              ),
            }
          : { mode: value.mode }
        : (() => {
            throw new TypeError('无效的保存位置策略');
          })();
  const useShared = ['youtube', 'bilibili'].includes(downloadPlatformDirectory(pageUrl));
  assertNewVideoSavePolicy(pageUrl, policy);
  await storage.set({
    [storageKey(pageUrl)]: policy,
    ...(useShared ? { [SHARED_POLICY_KEY]: policy } : {}),
    ...(useShared && policy.mode === 'custom' ? { [LAST_DIRECTORY_KEY]: policy.directory } : {}),
  });
  return policy;
}

export async function getLastVideoDirectory(
  storage: StorageAreaLike = chrome.storage.local,
): Promise<MergeDockDirectorySelection | undefined> {
  const directory = (await storage.get(LAST_DIRECTORY_KEY))[LAST_DIRECTORY_KEY];
  const value = { mode: 'custom', directory };
  return isPolicy(value) && value.mode === 'custom' ? value.directory : undefined;
}

export function presentMergeDownloadPath(
  pageUrl: string,
  policy: MergeDownloadPathPolicy,
): { savePath: string; pathMode: MergeDockPathMode } {
  return {
    savePath:
      policy.mode === 'custom'
        ? policy.directory.name
        : policy.mode === 'ask'
          ? '下载时由系统选择保存位置'
          : displayDownloadDirectory(pageUrl, 'video'),
    pathMode: policy.mode,
  };
}
