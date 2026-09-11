import {
  BILIBILI_MANIFEST_HOOK_STATUS_EVENT,
  BILIBILI_MANIFEST_HOOK_VERSION,
  BILIBILI_MANIFEST_READY_EVENT,
  BILIBILI_ROUTE_CHANGED_EVENT,
  type BilibiliManifestHookStatusDetail,
} from '../detector/bilibili-manifest-capture-main';

export {
  BILIBILI_MANIFEST_HOOK_STATUS_EVENT,
  BILIBILI_MANIFEST_HOOK_VERSION,
  BILIBILI_MANIFEST_READY_EVENT,
  BILIBILI_ROUTE_CHANGED_EVENT,
};
export type { BilibiliManifestHookStatusDetail };

/** URL-free request for the MAIN-world capture hook to verify its installation. */
export const BILIBILI_MANIFEST_HOOK_CHECK_EVENT = 'foxfetch:bilibili-manifest-hook-check';

export interface FoxFetchManifestReadyIdentity {
  bvid: string;
  cid: string;
  revision: number;
}

export interface FoxFetchBilibiliRouteIdentity {
  bvid: string;
  cid?: string;
}

function currentBilibiliRoute(pageUrl: string): FoxFetchBilibiliRouteIdentity | undefined {
  try {
    const url = new URL(pageUrl);
    if (url.hostname !== 'bilibili.com' && !url.hostname.endsWith('.bilibili.com'))
      return undefined;
    const bvid = /\/video\/(BV[0-9A-Za-z]{6,32})/u.exec(url.pathname)?.[1]?.toUpperCase();
    if (!bvid) return undefined;
    const cid = (url.searchParams.get('cid') ?? '').replace(/^0+(?=\d)/u, '');
    return { bvid, ...(cid ? { cid } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Validate the deliberately URL-free MAIN-to-isolated notification. A CID is
 * compared whenever the current route exposes one; Bilibili's normal watch URL
 * only exposes the BVID, so the current BVID remains the required boundary.
 */
export function manifestReadyIdentityForCurrentRoute(
  pageUrl: string,
  detail: unknown,
): FoxFetchManifestReadyIdentity | undefined {
  try {
    if (!detail || typeof detail !== 'object') return undefined;
    const keys = Object.keys(detail);
    if (
      keys.length !== 3 ||
      !keys.includes('bvid') ||
      !keys.includes('cid') ||
      !keys.includes('revision')
    ) {
      return undefined;
    }
    const candidate = detail as Partial<FoxFetchManifestReadyIdentity>;
    if (
      typeof candidate.bvid !== 'string' ||
      !/^BV[0-9A-Za-z]{6,32}$/u.test(candidate.bvid) ||
      typeof candidate.cid !== 'string' ||
      !/^\d{1,20}$/u.test(candidate.cid) ||
      typeof candidate.revision !== 'number' ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision <= 0
    ) {
      return undefined;
    }
    const bvid = candidate.bvid.toUpperCase();
    const cid = candidate.cid.replace(/^0+(?=\d)/u, '');
    if (cid === '0') return undefined;
    const current = currentBilibiliRoute(pageUrl);
    if (!current || current.bvid !== bvid) return undefined;
    if (current.cid && current.cid !== cid) return undefined;
    return { bvid, cid, revision: candidate.revision };
  } catch {
    // Page-dispatched events are untrusted and may carry hostile accessors/proxies.
    return undefined;
  }
}

/** Validate the URL-free status response emitted for every hook check. */
export function bilibiliManifestHookStatus(
  detail: unknown,
): BilibiliManifestHookStatusDetail | undefined {
  try {
    if (!detail || typeof detail !== 'object') return undefined;
    const keys = Object.keys(detail);
    const expectedKeys = [
      'version',
      'checkRevision',
      'captureRevision',
      'fetch',
      'xhr',
      'routeBridgeBound',
    ];
    if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
      return undefined;
    }
    const candidate = detail as Partial<BilibiliManifestHookStatusDetail>;
    if (
      candidate.version !== BILIBILI_MANIFEST_HOOK_VERSION ||
      typeof candidate.checkRevision !== 'number' ||
      !Number.isSafeInteger(candidate.checkRevision) ||
      candidate.checkRevision <= 0 ||
      typeof candidate.captureRevision !== 'number' ||
      !Number.isSafeInteger(candidate.captureRevision) ||
      candidate.captureRevision < 0 ||
      typeof candidate.fetch !== 'boolean' ||
      typeof candidate.xhr !== 'boolean' ||
      typeof candidate.routeBridgeBound !== 'boolean'
    ) {
      return undefined;
    }
    return {
      version: BILIBILI_MANIFEST_HOOK_VERSION,
      checkRevision: candidate.checkRevision,
      captureRevision: candidate.captureRevision,
      fetch: candidate.fetch,
      xhr: candidate.xhr,
      routeBridgeBound: candidate.routeBridgeBound,
    };
  } catch {
    return undefined;
  }
}

/** Validate an identity-only History/popstate notification for the current route. */
export function bilibiliRouteChangedIdentityForCurrentRoute(
  pageUrl: string,
  detail: unknown,
): FoxFetchBilibiliRouteIdentity | undefined {
  try {
    if (!detail || typeof detail !== 'object') return undefined;
    const keys = Object.keys(detail);
    if (
      (keys.length !== 1 && keys.length !== 2) ||
      !keys.includes('bvid') ||
      keys.some((key) => key !== 'bvid' && key !== 'cid')
    ) {
      return undefined;
    }
    const candidate = detail as Partial<FoxFetchBilibiliRouteIdentity>;
    if (typeof candidate.bvid !== 'string' || !/^BV[0-9A-Za-z]{6,32}$/iu.test(candidate.bvid)) {
      return undefined;
    }
    if (
      candidate.cid != null &&
      (typeof candidate.cid !== 'string' || !/^\d{1,20}$/u.test(candidate.cid))
    ) {
      return undefined;
    }
    const current = currentBilibiliRoute(pageUrl);
    const bvid = candidate.bvid.toUpperCase();
    const cid = candidate.cid?.replace(/^0+(?=\d)/u, '');
    if (!current || current.bvid !== bvid || cid === '0') return undefined;
    if (current.cid && current.cid !== cid) return undefined;
    return { bvid, ...(cid ? { cid } : {}) };
  } catch {
    return undefined;
  }
}
