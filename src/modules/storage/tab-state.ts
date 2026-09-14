import { budgetedSessionStorage, compactManifestHistory, estimateSessionBytes, SESSION_QUOTA_MESSAGE } from './session-budget';
import { MAX_ASSETS_PER_TAB, TAB_STATE_PREFIX } from '../../shared/constants';
import type {
  AgentSnapshot,
  MediaAsset,
  MediaElementInfo,
  TabMediaState,
} from '../../shared/types';
import { mergeMediaAssets } from '../../shared/utils';
import { siteMediaRouteKey } from '../detector/site-media';
import { isYouTubePage } from '../youtube/inspection';
import { validateBoundMediaArtwork } from '../media-products/media-artwork';
import { captureProtectedAssetIds, isExpiredNetworkAsset } from './network-retention';
import type { NetworkRequestContext } from '../network/observer';

const memoryCache = new Map<number, TabMediaState>();
const MEMORY_CACHE_BUDGET = 4 * 1024 * 1024;
const memoryCacheBytes = new Map<number, number>();

function rememberTabState(state: TabMediaState): void {
  memoryCache.delete(state.tabId);
  memoryCacheBytes.delete(state.tabId);
  const bytes = estimateSessionBytes(state);
  // Session storage remains authoritative; large records need not be duplicated in memory.
  if (bytes > MEMORY_CACHE_BUDGET) return;
  let used = [...memoryCacheBytes.values()].reduce((sum, size) => sum + size, 0);
  for (const tabId of memoryCache.keys()) {
    if (used + bytes <= MEMORY_CACHE_BUDGET) break;
    used -= memoryCacheBytes.get(tabId) ?? 0;
    memoryCache.delete(tabId);
    memoryCacheBytes.delete(tabId);
  }
  memoryCache.set(state.tabId, structuredClone(state));
  memoryCacheBytes.set(state.tabId, bytes);
}
const MAIN_WORLD_SNAPSHOT_PREFIX = 'foxfetch:main-world-assets:';
const MAIN_WORLD_SNAPSHOT_STORE_VERSION = 2 as const;
const MAX_MAIN_WORLD_SNAPSHOTS_PER_TAB = 12;
const PENDING_NETWORK_ASSET_PREFIX = 'foxfetch:pending-network-assets:';
const PENDING_NETWORK_ASSET_STORE_VERSION = 1 as const;
const pendingNetworkAssetMutations = new Map<number, Promise<void>>();

export interface PersistedPendingNetworkAsset {
  asset: MediaAsset;
  /** Immutable ownership evidence captured when the request began. */
  context: NetworkRequestContext;
  expiresAt: number;
}

interface PersistedPendingNetworkAssetStore {
  version: typeof PENDING_NETWORK_ASSET_STORE_VERSION;
  entries: PersistedPendingNetworkAsset[];
}

interface PersistedMainWorldAssetSnapshot {
  pageUrl: string;
  routeKey?: string;
  mediaEpoch: number;
  documentId?: string;
  providerIdentity?: string;
  assets: MediaAsset[];
  validatedAt: number;
}

interface PersistedMainWorldAssetSnapshotStore {
  version: typeof MAIN_WORLD_SNAPSHOT_STORE_VERSION;
  entries: PersistedMainWorldAssetSnapshot[];
}

function key(tabId: number): string {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

function mainWorldSnapshotKey(tabId: number): string {
  return `${MAIN_WORLD_SNAPSHOT_PREFIX}${tabId}`;
}

function pendingNetworkAssetKey(tabId: number): string {
  return `${PENDING_NETWORK_ASSET_PREFIX}${tabId}`;
}

function isPendingNetworkAsset(value: unknown): value is PersistedPendingNetworkAsset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedPendingNetworkAsset>;
  const context = candidate.context as Partial<NetworkRequestContext> | undefined;
  const asset = candidate.asset as Partial<MediaAsset> | undefined;
  return Boolean(
    asset &&
    typeof asset.id === 'string' &&
    typeof asset.url === 'string' &&
    context &&
    Number.isInteger(context.frameId) &&
    Number.isInteger(context.mediaEpoch) &&
    (context.documentId === undefined || typeof context.documentId === 'string') &&
    (context.routeKey === undefined || typeof context.routeKey === 'string') &&
    typeof candidate.expiresAt === 'number',
  );
}

async function readPendingNetworkAssetStore(
  tabId: number,
): Promise<PersistedPendingNetworkAssetStore> {
  const storageKey = pendingNetworkAssetKey(tabId);
  const stored = (await budgetedSessionStorage.get(storageKey))[storageKey] as
    Partial<PersistedPendingNetworkAssetStore> | undefined;
  return stored?.version === PENDING_NETWORK_ASSET_STORE_VERSION &&
    Array.isArray(stored.entries) &&
    stored.entries.every(isPendingNetworkAsset)
    ? { version: PENDING_NETWORK_ASSET_STORE_VERSION, entries: stored.entries }
    : { version: PENDING_NETWORK_ASSET_STORE_VERSION, entries: [] };
}

async function mutatePendingNetworkAssets<T>(
  tabId: number,
  mutation: (entries: PersistedPendingNetworkAsset[]) => Promise<T> | T,
): Promise<T> {
  const previous = pendingNetworkAssetMutations.get(tabId) ?? Promise.resolve();
  let result!: T;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const store = await readPendingNetworkAssetStore(tabId);
      result = await mutation(store.entries.map((entry) => structuredClone(entry)));
    });
  pendingNetworkAssetMutations.set(tabId, current);
  try {
    await current;
    return result;
  } finally {
    if (pendingNetworkAssetMutations.get(tabId) === current) {
      pendingNetworkAssetMutations.delete(tabId);
    }
  }
}

export async function appendPendingNetworkAsset(
  tabId: number,
  entry: PersistedPendingNetworkAsset,
  maxEntries: number,
  now = Date.now(),
): Promise<void> {
  await mutatePendingNetworkAssets(tabId, async (entries) => {
    const byteBudget = 512 * 1024;
    if (estimateSessionBytes([entry]) > byteBudget) throw new Error(SESSION_QUOTA_MESSAGE);
    const next = [...entries.filter((candidate) => candidate.expiresAt > now), entry].slice(
      -maxEntries,
    );
    // Same FIFO retention as the count limit, without truncating ownership or signed URLs.
    let bytes = estimateSessionBytes(next);
    while (bytes > byteBudget && next.length > 1) {
      bytes -= estimateSessionBytes(next.shift()) + 2;
    }
    await budgetedSessionStorage.set({
      [pendingNetworkAssetKey(tabId)]: {
        version: PENDING_NETWORK_ASSET_STORE_VERSION,
        entries: next,
      } satisfies PersistedPendingNetworkAssetStore,
    });
  });
}

/**
 * Returns live quarantine entries without claiming/removing them. A service
 * worker can therefore stop at any point and safely retry the same entries.
 */
export async function peekPendingNetworkAssets(
  tabId: number,
  now = Date.now(),
): Promise<PersistedPendingNetworkAsset[]> {
  return mutatePendingNetworkAssets(tabId, async (entries) => {
    const live = entries.filter((candidate) => candidate.expiresAt > now);
    if (live.length > 0 && live.length !== entries.length) {
      await budgetedSessionStorage.set({
        [pendingNetworkAssetKey(tabId)]: {
          version: PENDING_NETWORK_ASSET_STORE_VERSION,
          entries: live,
        } satisfies PersistedPendingNetworkAssetStore,
      });
    } else if (live.length === 0) {
      await budgetedSessionStorage.remove(pendingNetworkAssetKey(tabId));
    }
    return live;
  });
}

function pendingNetworkAssetFingerprint(entry: PersistedPendingNetworkAsset): string {
  return JSON.stringify([
    entry.asset.id,
    entry.asset.url,
    entry.context.frameId,
    entry.context.documentId ?? '',
    entry.context.routeKey ?? '',
    entry.context.mediaEpoch,
    entry.expiresAt,
  ]);
}

/**
 * Acknowledge only entries that were conclusively merged or rejected. Entries
 * appended during processing and unhandled entries remain available for the
 * next convergence flight.
 */
export async function acknowledgePendingNetworkAssets(
  tabId: number,
  handled: readonly PersistedPendingNetworkAsset[],
  now = Date.now(),
): Promise<void> {
  if (handled.length === 0) return;
  const fingerprints = new Set(handled.map(pendingNetworkAssetFingerprint));
  await mutatePendingNetworkAssets(tabId, async (entries) => {
    const next = entries.filter(
      (entry) => entry.expiresAt > now && !fingerprints.has(pendingNetworkAssetFingerprint(entry)),
    );
    if (next.length > 0) {
      await budgetedSessionStorage.set({
        [pendingNetworkAssetKey(tabId)]: {
          version: PENDING_NETWORK_ASSET_STORE_VERSION,
          entries: next,
        } satisfies PersistedPendingNetworkAssetStore,
      });
    } else {
      await budgetedSessionStorage.remove(pendingNetworkAssetKey(tabId));
    }
  });
}

export async function clearPendingNetworkAssets(tabId: number): Promise<void> {
  await mutatePendingNetworkAssets(tabId, async () => {
    await budgetedSessionStorage.remove(pendingNetworkAssetKey(tabId));
  });
}

function isPersistedMainWorldAssetSnapshot(
  value: unknown,
): value is PersistedMainWorldAssetSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PersistedMainWorldAssetSnapshot>;
  return (
    typeof snapshot.pageUrl === 'string' &&
    Number.isInteger(snapshot.mediaEpoch) &&
    (snapshot.documentId === undefined || typeof snapshot.documentId === 'string') &&
    Array.isArray(snapshot.assets) &&
    typeof snapshot.validatedAt === 'number'
  );
}

function isPersistedMainWorldAssetSnapshotStore(
  value: unknown,
): value is PersistedMainWorldAssetSnapshotStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<PersistedMainWorldAssetSnapshotStore>;
  return (
    store.version === MAIN_WORLD_SNAPSHOT_STORE_VERSION &&
    Array.isArray(store.entries) &&
    store.entries.every(isPersistedMainWorldAssetSnapshot)
  );
}

function snapshotRouteKey(snapshot: PersistedMainWorldAssetSnapshot): string {
  return snapshot.routeKey ?? siteMediaRouteKey(snapshot.pageUrl);
}

function isBilibiliVideoRoute(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return (
      (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) &&
      /\/video\/BV[0-9A-Za-z]+/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function getMainWorldSnapshotStore(
  tabId: number,
): Promise<PersistedMainWorldAssetSnapshotStore> {
  const storageKey = mainWorldSnapshotKey(tabId);
  const stored = (await budgetedSessionStorage.get(storageKey))[storageKey];
  const store = isPersistedMainWorldAssetSnapshotStore(stored)
    ? stored
    : isPersistedMainWorldAssetSnapshot(stored)
      ? { version: MAIN_WORLD_SNAPSHOT_STORE_VERSION, entries: [stored] }
      : { version: MAIN_WORLD_SNAPSHOT_STORE_VERSION, entries: [] };
  return store;
}

function findMainWorldSnapshot(
  entries: readonly PersistedMainWorldAssetSnapshot[],
  pageUrl: string,
  documentId?: string,
  providerIdentity?: string,
): PersistedMainWorldAssetSnapshot | undefined {
  const routeKey = siteMediaRouteKey(pageUrl);
  const matching = entries
    .filter((snapshot) => {
      if (snapshotRouteKey(snapshot) !== routeKey) return false;
      if (documentId && snapshot.documentId && snapshot.documentId !== documentId) return false;
      if (
        providerIdentity &&
        snapshot.providerIdentity &&
        snapshot.providerIdentity !== providerIdentity
      ) {
        return false;
      }
      return true;
    })
    .sort((left, right) => right.validatedAt - left.validatedAt);
  if (providerIdentity) return matching[0];

  // A BVID route normally omits CID. Rebind only when the document/route has a
  // single provider identity; choosing the newest of several identities could
  // cross-wire parts or a prefetched recommendation.
  const identities = new Set(matching.map((snapshot) => snapshot.providerIdentity ?? ''));
  return identities.size <= 1 ? matching[0] : undefined;
}

/**
 * MAIN-world manifests are the only reliable source for many split A/V sites.
 * Keep the latest validated generation in session storage so an MV3 worker
 * restart cannot turn a complete product into a video-only product.
 */
export async function getMainWorldAssetSnapshot(
  tabId: number,
  pageUrl: string,
  mediaEpoch: number,
  documentId?: string,
  providerIdentity?: string,
): Promise<MediaAsset[]> {
  const store = await getMainWorldSnapshotStore(tabId);
  const snapshot = findMainWorldSnapshot(store.entries, pageUrl, documentId, providerIdentity);
  if (!snapshot) return [];
  // mediaEpoch is intentionally not part of the lookup. Bilibili reuses one
  // route/document while emitting multiple src/emptied/loadedmetadata cycles;
  // the validated BVID/CID-owned manifest remains authoritative across those
  // lifecycle-only generations.
  void mediaEpoch;
  return snapshot.assets.map((asset) => ({ ...asset }));
}

export async function saveMainWorldAssetSnapshot(
  tabId: number,
  pageUrl: string,
  mediaEpoch: number,
  assets: readonly MediaAsset[],
  documentId?: string,
  providerIdentity?: string,
): Promise<MediaAsset[]> {
  if (assets.length === 0) {
    return getMainWorldAssetSnapshot(tabId, pageUrl, mediaEpoch, documentId, providerIdentity);
  }
  const store = await getMainWorldSnapshotStore(tabId);
  const previousSnapshot = findMainWorldSnapshot(
    store.entries,
    pageUrl,
    documentId,
    providerIdentity,
  );
  const assetMap = new Map((previousSnapshot?.assets ?? []).map((asset) => [asset.id, asset]));
  for (const asset of assets) {
    const current = assetMap.get(asset.id);
    assetMap.set(asset.id, current ? mergeMediaAssets(current, asset) : { ...asset });
  }
  const effectiveProviderIdentity = providerIdentity ?? previousSnapshot?.providerIdentity;
  const snapshot: PersistedMainWorldAssetSnapshot = {
    pageUrl,
    routeKey: siteMediaRouteKey(pageUrl),
    mediaEpoch,
    ...(documentId ? { documentId } : {}),
    ...(effectiveProviderIdentity ? { providerIdentity: effectiveProviderIdentity } : {}),
    assets: [...assetMap.values()]
      .sort((left, right) => right.discoveredAt - left.discoveredAt)
      .slice(0, MAX_ASSETS_PER_TAB),
    validatedAt: Date.now(),
  };
  const entries = compactManifestHistory([snapshot, ...store.entries.filter((entry) => entry !== previousSnapshot)].slice(
    0,
    MAX_MAIN_WORLD_SNAPSHOTS_PER_TAB,
  ));
  const nextStore: PersistedMainWorldAssetSnapshotStore = {
    version: MAIN_WORLD_SNAPSHOT_STORE_VERSION,
    entries,
  };
  await budgetedSessionStorage.set({ [mainWorldSnapshotKey(tabId)]: nextStore });
  return snapshot.assets.map((asset) => ({ ...asset }));
}

export async function clearMainWorldAssetSnapshot(tabId: number): Promise<void> {
  await budgetedSessionStorage.remove(mainWorldSnapshotKey(tabId));
}

export interface RouteTransitionStateOptions {
  preserveSourceCapture?: boolean;
  now?: number;
}

/**
 * Build the only state that may be shown while a document or SPA route is
 * changing. Route-scoped assets, media elements and errors must never leak into
 * the next video; a deliberately preserved reload capture is the sole exception.
 */
export function createRouteTransitionState(
  tabId: number,
  pageUrl: string,
  pageTitle: string,
  current?: TabMediaState,
  options: RouteTransitionStateOptions = {},
): TabMediaState {
  return {
    tabId,
    pageUrl,
    pageTitle,
    scannedAt: options.now ?? Date.now(),
    status: 'scanning',
    assets: [],
    mediaElements: [],
    ...(options.preserveSourceCapture && current?.sourceCapture
      ? { sourceCapture: current.sourceCapture }
      : {}),
  };
}

export async function getTabState(tabId: number): Promise<TabMediaState | undefined> {
  const cached = memoryCache.get(tabId);
  if (cached) return structuredClone(cached);
  const stored = await budgetedSessionStorage.get(key(tabId));
  const state = stored[key(tabId)] as TabMediaState | undefined;
  if (state) state.assets = state.assets.map(stripPersistedImageBody);
  if (state) rememberTabState(state);
  return state;
}

/** Caller holds the tab mutation queue so migration cannot overwrite a fresh scan. */
export async function migrateTabInlineImages(tabId: number): Promise<void> {
  const stored = (await budgetedSessionStorage.get(key(tabId)))[key(tabId)] as TabMediaState | undefined;
  if (!stored || !Array.isArray(stored.assets)) return;
  const assets = stored.assets.map(stripPersistedImageBody);
  if (assets.some((asset, index) => asset !== stored.assets[index])) {
    await setTabState({ ...stored, assets });
  }
}

export async function setTabState(state: TabMediaState): Promise<TabMediaState> {
  state.assets = state.assets.map((asset) => {
    const safe = stripPersistedImageBody(asset);
    return safe.inlineImage ? { ...safe, inlineImage: { ...safe.inlineImage, tabId: state.tabId } } : safe;
  });
  // v0.14.0 is a discovery release. Network-observed tracks are not proof of
  // complete YouTube downloads and must not bypass the candidate-only UI.
  if (isYouTubePage(state.pageUrl)) {
    state.assets = state.assets.map((asset) =>
      asset.kind === 'image' ? asset : { ...asset, downloadable: false },
    );
  }
  await budgetedSessionStorage.set({ [key(state.tabId)]: state });
  rememberTabState(state);
  return state;
}

export async function mergeAgentSnapshots(
  tabId: number,
  snapshots: Array<AgentSnapshot & { frameId: number }>,
  fallback: Pick<TabMediaState, 'pageUrl' | 'pageTitle'>,
): Promise<TabMediaState> {
  const topFrameSnapshot = snapshots.find((snapshot) => snapshot.frameId === 0);
  const topSnapshot = topFrameSnapshot ?? snapshots[0];
  const pageUrl = topSnapshot?.pageUrl || fallback.pageUrl;
  const current = await getTabState(tabId);
  const reconciledFrameIds = new Set(snapshots.map((snapshot) => snapshot.frameId));
  const currentSnapshotAssetIds = new Set(
    snapshots.flatMap((snapshot) => snapshot.assets.map((asset) => asset.id)),
  );
  const protectedAssetIds = captureProtectedAssetIds(current?.sourceCapture);
  const now = Date.now();
  if (
    current?.pageUrl === pageUrl &&
    current.mediaEpoch != null &&
    topFrameSnapshot != null &&
    topFrameSnapshot.mediaEpoch < current.mediaEpoch
  ) {
    // A scan may finish after a same-URL player switch. Keep the newer event
    // snapshot instead of allowing the old executeScript result to roll the
    // active player and its media list backwards.
    const stable: TabMediaState = { ...current };
    delete stable.error;
    return setTabState({ ...stable, scannedAt: now, status: 'ready' });
  }
  const mediaEpochAdvanced =
    current?.pageUrl === pageUrl &&
    current.mediaEpoch != null &&
    topFrameSnapshot != null &&
    topFrameSnapshot.mediaEpoch > current.mediaEpoch;
  const preserveManifestAcrossLifecycle =
    current?.pageUrl === pageUrl && isBilibiliVideoRoute(pageUrl);
  const preservedAuthoritativeAssets =
    current?.pageUrl === pageUrl
      ? current.assets.filter((asset) => {
          if (
            asset.detectedBy.includes('manifest') &&
            (!mediaEpochAdvanced || preserveManifestAcrossLifecycle) &&
            reconciledFrameIds.has(asset.frameId)
          ) {
            // An isolated-world omission is not evidence that a validated
            // MAIN manifest track disappeared. Preserve the complete
            // generation until an explicit route/player generation change.
            return true;
          }
          return (
            asset.detectedBy.includes('network') &&
            (!mediaEpochAdvanced ||
              !reconciledFrameIds.has(asset.frameId) ||
              currentSnapshotAssetIds.has(asset.id)) &&
            (!reconciledFrameIds.has(asset.frameId) ||
              currentSnapshotAssetIds.has(asset.id) ||
              protectedAssetIds.has(asset.id) ||
              !isExpiredNetworkAsset(asset, now))
          );
        })
      : [];
  const assetMap = new Map<string, MediaAsset>(
    preservedAuthoritativeAssets.map((asset) => [asset.id, asset]),
  );
  const elementMap = new Map<string, MediaElementInfo>();

  for (const snapshot of snapshots) {
    for (const asset of snapshot.assets) {
      const normalized = { ...asset, frameId: snapshot.frameId };
      const previous = assetMap.get(normalized.id);
      assetMap.set(normalized.id, previous ? mergeMediaAssets(previous, normalized) : normalized);
    }
    for (const element of snapshot.mediaElements) {
      elementMap.set(`${snapshot.frameId}:${element.elementId}`, {
        ...element,
        frameId: snapshot.frameId,
      });
    }
  }

  const state: TabMediaState = {
    tabId,
    pageUrl,
    pageTitle: topSnapshot?.pageTitle || fallback.pageTitle,
    scannedAt: now,
    status: 'ready',
    assets: [...assetMap.values()]
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
      .slice(0, MAX_ASSETS_PER_TAB),
    mediaElements: [...elementMap.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt || b.visibleArea - a.visibleArea,
    ),
    ...(topFrameSnapshot
      ? {
          mediaEpoch: topFrameSnapshot.mediaEpoch,
          ...(topFrameSnapshot.activeMedia ? { activeMedia: topFrameSnapshot.activeMedia } : {}),
        }
      : {
          ...(current?.mediaEpoch == null ? {} : { mediaEpoch: current.mediaEpoch }),
          ...(current?.activeMedia ? { activeMedia: current.activeMedia } : {}),
        }),
    ...(current?.sourceCapture ? { sourceCapture: current.sourceCapture } : {}),
  };
  const artwork = validateBoundMediaArtwork(
    topFrameSnapshot ? topFrameSnapshot.artwork : current?.artwork,
    {
      ...state,
      ...(current?.pageUrl === pageUrl && current.providerIdentity
        ? { providerIdentity: current.providerIdentity }
        : {}),
    },
  );
  if (artwork) state.artwork = artwork;
  return setTabState(state);
}

export async function clearTabState(tabId: number): Promise<void> {
  memoryCache.delete(tabId);
  memoryCacheBytes.delete(tabId);
  await clearPendingNetworkAssets(tabId);
  await budgetedSessionStorage.remove([key(tabId), mainWorldSnapshotKey(tabId)]);
}
import { stripPersistedImageBody } from '../detector/inline-images';
