import type { MediaAsset, SourceCaptureView } from '../../shared/types';

/**
 * WebRequest discoveries are useful after a short quiet period (for example while
 * the player buffers), but keeping every signed segment for the lifetime of a SPA
 * makes the list permanently stale. Ten minutes is deliberately longer than the
 * detector's Resource Timing TTL while still providing a finite reconciliation
 * window for same-route players.
 */
export const NETWORK_ASSET_TTL_MS = 10 * 60 * 1_000;

export function isExpiredNetworkAsset(
  asset: MediaAsset,
  now = Date.now(),
  ttlMs = NETWORK_ASSET_TTL_MS,
): boolean {
  if (!asset.detectedBy.includes('network')) return false;
  const lastObservedAt = asset.lastObservedAt ?? asset.discoveredAt;
  return Number.isFinite(lastObservedAt) && now - lastObservedAt > ttlMs;
}

/** Asset ids referenced by a completed/in-progress source capture must remain actionable. */
export function captureProtectedAssetIds(capture?: SourceCaptureView): ReadonlySet<string> {
  return new Set(
    [
      capture?.blobAssetId,
      capture?.directAssetId,
      capture?.videoAssetId,
      capture?.audioAssetId,
    ].filter((id): id is string => Boolean(id)),
  );
}
