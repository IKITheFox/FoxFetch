import { budgetedSessionStorage } from '../storage/session-budget';
import type { DownloadRecord, MediaAsset } from '../../shared/types';
import { PERMISSION_INTENT_TTL_MS, type SessionStorageArea } from './pending-intents';

const PERMISSION_DOWNLOAD_PREFIX = 'foxfetch:permission-download-attempt:';

interface PermissionDownloadAssetBinding {
  id: string;
  url: string;
}

export interface PermissionDownloadAttempt {
  intentId: string;
  assets: PermissionDownloadAssetBinding[];
  state: 'started' | 'completed';
  createdAt: number;
  expiresAt: number;
  downloads?: DownloadRecord[];
}

export class PermissionDownloadAttemptStore {
  constructor(
    private readonly storage: SessionStorageArea = budgetedSessionStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private key(intentId: string): string {
    return `${PERMISSION_DOWNLOAD_PREFIX}${intentId}`;
  }

  async read(intentId: string): Promise<PermissionDownloadAttempt | undefined> {
    const key = this.key(intentId);
    const value = (await this.storage.get(key))[key] as PermissionDownloadAttempt | undefined;
    if (!value || value.intentId !== intentId || !Array.isArray(value.assets)) return undefined;
    if (value.expiresAt <= this.now()) {
      await this.storage.remove(key);
      return undefined;
    }
    return value;
  }

  async stage(intentId: string, assets: readonly MediaAsset[]): Promise<PermissionDownloadAttempt> {
    const bindings = assets.map((asset) => ({ id: asset.id, url: asset.url }));
    const existing = await this.read(intentId);
    if (existing) {
      if (JSON.stringify(existing.assets) !== JSON.stringify(bindings)) {
        throw new Error('下载待办与已启动的资源不一致');
      }
      return existing;
    }
    const createdAt = this.now();
    const attempt: PermissionDownloadAttempt = {
      intentId,
      assets: bindings,
      state: 'started',
      createdAt,
      expiresAt: createdAt + PERMISSION_INTENT_TTL_MS,
    };
    await this.storage.set({ [this.key(intentId)]: attempt });
    return attempt;
  }

  async complete(intentId: string, downloads: DownloadRecord[]): Promise<void> {
    const current = await this.read(intentId);
    if (!current) return;
    await this.storage.set({
      [this.key(intentId)]: {
        ...current,
        state: 'completed',
        downloads,
      } satisfies PermissionDownloadAttempt,
    });
  }
}

export interface PermissionIntentDownloadDependencies {
  store: PermissionDownloadAttemptStore;
  history(): Promise<DownloadRecord[]>;
  verifyNativeDownload(record: DownloadRecord): Promise<boolean>;
  execute(assets: MediaAsset[]): Promise<DownloadRecord[]>;
}

/**
 * Gives permission continuations a durable attempt key. On MV3 worker recovery,
 * only history entries backed by a verifiable native Chrome download are
 * reused; a queued entry without a native id is safely started again.
 */
export async function runIdempotentPermissionDownloads(
  intentId: string,
  assets: readonly MediaAsset[],
  dependencies: PermissionIntentDownloadDependencies,
): Promise<DownloadRecord[]> {
  const previous = await dependencies.store.read(intentId);
  const attempt = await dependencies.store.stage(intentId, assets);
  if (attempt.state === 'completed' && attempt.downloads) return attempt.downloads;

  const recoveredByAssetId = new Map<string, DownloadRecord>();
  if (previous) {
    const expected = new Map(attempt.assets.map((asset) => [asset.id, asset.url] as const));
    const history = (await dependencies.history())
      .filter(
        (record) =>
          record.createdAt >= attempt.createdAt && expected.get(record.assetId) === record.url,
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const record of history) {
      if (
        Number.isInteger(record.chromeDownloadId) &&
        (await dependencies.verifyNativeDownload(record).catch(() => false)) &&
        !recoveredByAssetId.has(record.assetId)
      ) {
        recoveredByAssetId.set(record.assetId, record);
      }
    }
  }

  const missing = assets.filter((asset) => !recoveredByAssetId.has(asset.id));
  const started = missing.length > 0 ? await dependencies.execute([...missing]) : [];
  for (const record of started) recoveredByAssetId.set(record.assetId, record);
  const downloads = assets.flatMap((asset) => {
    const record = recoveredByAssetId.get(asset.id);
    return record ? [record] : [];
  });
  if (downloads.length !== assets.length) {
    throw new Error('下载待办未能为全部资源创建记录，请重新点击下载');
  }
  await dependencies.store.complete(intentId, downloads);
  return downloads;
}
