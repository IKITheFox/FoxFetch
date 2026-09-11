import type { MergeDockDirectorySelection, MergeDockView } from '../../shared/types';
import { downloadPlatformDirectory } from '../downloads/download-path';
import {
  verifyDirectoryPermission,
  type StoredDirectoryHandle,
} from '../downloads/directory-handle-store';

export interface RememberedDirectoryStore {
  get(handleId: string): Promise<StoredDirectoryHandle | undefined>;
}

/** Query existing permission only; a status refresh must never show a prompt. */
export async function presentRememberedMergeDirectory(
  pageUrl: string,
  store: RememberedDirectoryStore,
): Promise<MergeDockView['rememberedDirectory']> {
  const stored = await store
    .get(`merge-${downloadPlatformDirectory(pageUrl)}`)
    .catch(() => undefined);
  if (!stored) return undefined;
  return {
    name: stored.metadata.name,
    available: (await verifyDirectoryPermission(stored.handle).catch(() => 'denied')) === 'granted',
  };
}

/** Restore only a live grant. The caller writes policy after this resolves. */
export async function resolveRememberedMergeDirectory(
  pageUrl: string,
  store: RememberedDirectoryStore,
): Promise<MergeDockDirectorySelection> {
  const stored = await store.get(`merge-${downloadPlatformDirectory(pageUrl)}`);
  if (!stored || (await verifyDirectoryPermission(stored.handle)) !== 'granted') {
    throw new Error('已记忆目录需要重新授权，请选择新的自定义目录；原位置未更改。');
  }
  return { ...stored.metadata };
}
