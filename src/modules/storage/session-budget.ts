/** Estimates are for proactive budgeting only, not Chrome's quota accounting. */
export function estimateSessionBytes(value: unknown): number {
  return JSON.stringify(value)?.length * 2 || 0;
}

const HIGH_WATER = 7 * 1024 * 1024;
const TARGET = 5 * 1024 * 1024;
export const SESSION_QUOTA_MESSAGE =
  'Temporary storage is full. Finish active downloads, close unused media tabs, then refresh resource detection. / 临时状态存储空间不足，请等待下载完成、关闭不使用的媒体页面后刷新资源识别。';

export function isSessionQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === SESSION_QUOTA_MESSAGE ||
    /session storage quota|quota.*bytes.*exceeded/i.test(message)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep whole ownership groups: never turn ambiguous BVID/CID history into a match. */
export function compactManifestHistory<
  T extends {
    pageUrl: string;
    routeKey?: string;
    documentId?: string;
    validatedAt: number;
  },
>(entries: T[], budget = 512 * 1024): T[] {
  const sorted = [...entries].sort((a, b) => b.validatedAt - a.validatedAt);
  // Legacy entries can omit documentId, so retain every identity on the route.
  const group = (entry: T) => entry.routeKey ?? entry.pageUrl;
  const groups = [...new Set(sorted.map(group))];
  let kept = sorted;
  while (groups.length > 1 && estimateSessionBytes(kept) > budget) {
    const oldest = groups.pop();
    kept = kept.filter((entry) => group(entry) !== oldest);
  }
  return kept;
}

/** Conservative allowlist. Task contexts, grants and current A/V assets are never evicted. */
export function reclaimableSessionValue(key: string, value: unknown, now: number): unknown {
  if (key.startsWith('foxfetch:tab:') && record(value) && Array.isArray(value.assets)) {
    const assets = value.assets.map((asset) =>
      record(asset) && typeof asset.url === 'string' ? stripPersistedImageBody(asset as unknown as MediaAsset) : asset);
    return assets.some((asset, index) => asset !== (value.assets as unknown[])[index]) ? { ...value, assets } : value;
  }
  const live = (entry: unknown) =>
    !record(entry) || typeof entry.expiresAt !== 'number' || entry.expiresAt > now;
  if (key === 'foxfetch:source-capture-sessions' || key === 'foxfetch:mse-download-fallbacks') {
    return Array.isArray(value) ? value.filter(live) : value;
  }
  if (
    key.startsWith('foxfetch:pending-network-assets:') &&
    record(value) &&
    Array.isArray(value.entries)
  ) {
    return { ...value, entries: value.entries.filter(live) };
  }
  if (
    key.startsWith('foxfetch:main-world-assets:') &&
    record(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        record(entry) && typeof entry.pageUrl === 'string' && typeof entry.validatedAt === 'number',
    )
  ) {
    return { ...value, entries: compactManifestHistory(value.entries, 0) };
  }
  return value;
}

export interface SessionArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

export function createSessionBudget(area: () => SessionArea) {
  let tail: Promise<void> = Promise.resolve();
  async function reclaim(excluded: Set<string>): Promise<void> {
    const storage = area();
    const items = await storage.get(null);
    // Existing entries are included, including records from a previous worker.
    for (const [key, previous] of Object.entries(items)) {
      if (excluded.has(key)) continue;
      const next = reclaimableSessionValue(key, previous, Date.now());
      if (estimateSessionBytes(next) >= estimateSessionBytes(previous)) continue;
      try {
        await storage.set({ [key]: next });
      } catch (error) {
        // Another extension context may fill the remaining quota concurrently.
        if (!isSessionQuotaError(error)) throw error;
      }
      if (storage.getBytesInUse && (await storage.getBytesInUse(null)) <= TARGET) break;
    }
  }
  async function write(items: Record<string, unknown>): Promise<void> {
    const storage = area();
    const keys = Object.keys(items);
    const excluded = new Set(keys);
    if (storage.getBytesInUse) {
      const used = await storage.getBytesInUse(null);
      const replaced = await storage.getBytesInUse(keys);
      if (used - replaced + estimateSessionBytes(items) > HIGH_WATER) await reclaim(excluded);
    }
    try {
      await storage.set(items);
    } catch (error) {
      if (!isSessionQuotaError(error)) throw error;
      await reclaim(excluded);
      // Bounded retry, with only expired/history data removed from the incoming write.
      const reduced = Object.fromEntries(
        Object.entries(items).map(([key, value]) => [
          key,
          reclaimableSessionValue(key, value, Date.now()),
        ]),
      );
      try {
        await storage.set(reduced);
      } catch (retryError) {
        if (!isSessionQuotaError(retryError)) throw retryError;
        throw new Error(SESSION_QUOTA_MESSAGE, { cause: retryError });
      }
    }
  }
  return {
    get: (keys?: string | string[] | null) => area().get(keys),
    remove: (keys: string | string[]) => {
      const result = tail.then(() => area().remove(keys));
      tail = result.catch(() => undefined);
      return result;
    },
    set: (items: Record<string, unknown>) => {
      const snapshot = structuredClone(items);
      const result = tail.then(() => write(snapshot));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** Background writers share one queue; browser quota remains the cross-context arbiter. */
export const budgetedSessionStorage = createSessionBudget(() => chrome.storage.session);

/** Explicit diagnostics contain category totals only, never URLs, titles or credentials. */
export async function sessionStorageUsage(): Promise<Record<string, number>> {
  const storage = chrome.storage.session;
  const items = await storage.get(null);
  const totals: Record<string, number> = { total: await storage.getBytesInUse(null) };
  for (const key of Object.keys(items)) {
    const category =
      [
        'tab',
        'main-world-assets',
        'pending-network-assets',
        'merge-context',
        'source-capture-sessions',
      ].find((name) => key === `foxfetch:${name}` || key.startsWith(`foxfetch:${name}:`)) ??
      'other';
    totals[category] = (totals[category] ?? 0) + (await storage.getBytesInUse(key));
  }
  return totals;
}
import { stripPersistedImageBody } from '../detector/inline-images';
import type { MediaAsset } from '../../shared/types';
