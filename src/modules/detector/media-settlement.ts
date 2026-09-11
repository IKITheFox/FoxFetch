import type { MediaElementInfo } from '../../shared/types';
import { siteMediaRouteKey } from './site-media';

// Player shells and their manifests are often mounted several seconds after an
// SPA route becomes visible. Keep the retry window bounded, but long enough to
// converge without requiring a full page refresh.
export const MEDIA_SETTLEMENT_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000, 5_000] as const;

export interface MediaSettlementProductLike {
  capabilities: { complete: boolean };
}

export interface MediaScanSettlementInput {
  pageUrl: string;
  mediaEpoch: number;
  mediaElements: readonly Pick<MediaElementInfo, 'kind'>[];
  products: readonly MediaSettlementProductLike[];
  retryExhausted?: boolean;
}

export type MediaScanSettlementReason =
  'unsupported-route' | 'no-video-player' | 'complete' | 'incomplete';

export interface MediaScanSettlement {
  key: string;
  status: 'settling' | 'complete' | 'degraded';
  shouldRetry: boolean;
  reason: MediaScanSettlementReason;
}

/** A retry generation is owned by the stable media route and player epoch. */
export function mediaScanSettlementKey(pageUrl: string, mediaEpoch: number): string {
  return JSON.stringify([siteMediaRouteKey(pageUrl), mediaEpoch]);
}

export function isSupportedMediaVideoPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
      return /\/video\/BV[0-9A-Za-z]+/iu.test(url.pathname);
    }
    if (
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com')
    ) {
      if (url.pathname === '/watch') {
        return /^[0-9A-Za-z_-]{6,32}$/u.test(url.searchParams.get('v') ?? '');
      }
      return /^\/(?:embed|live|shorts)\/[0-9A-Za-z_-]{6,32}/u.test(url.pathname);
    }
  } catch {
    // Malformed and browser-internal URLs are not retryable media pages.
  }
  return false;
}

/**
 * Decide whether a current player needs a short, bounded manifest-settlement
 * pass. A missing player is retryable on supported routes because closed
 * shadow roots and late framework mounts do not always produce an observable
 * isolated-world mutation.
 */
export function assessMediaScanSettlement(input: MediaScanSettlementInput): MediaScanSettlement {
  const key = mediaScanSettlementKey(input.pageUrl, input.mediaEpoch);
  if (!isSupportedMediaVideoPage(input.pageUrl)) {
    return { key, status: 'complete', shouldRetry: false, reason: 'unsupported-route' };
  }
  if (input.products.some((product) => product.capabilities.complete)) {
    return { key, status: 'complete', shouldRetry: false, reason: 'complete' };
  }
  if (input.retryExhausted) {
    return {
      key,
      status: 'degraded',
      shouldRetry: false,
      reason: input.mediaElements.some((element) => element.kind === 'video')
        ? 'incomplete'
        : 'no-video-player',
    };
  }
  if (!input.mediaElements.some((element) => element.kind === 'video')) {
    return { key, status: 'settling', shouldRetry: true, reason: 'no-video-player' };
  }
  return { key, status: 'settling', shouldRetry: true, reason: 'incomplete' };
}
