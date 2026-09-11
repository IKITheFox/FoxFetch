import type { MediaAsset, MediaRequestHeaders } from '../../shared/types';
import {
  classifyMedia,
  extensionFromMime,
  extensionFromUrl,
  filenameFromUrl,
  stableId,
} from '../../shared/utils';
import {
  networkMediaResourceIdentity,
  parseNetworkByteRange,
  resolveNetworkMediaCandidates,
  type NetworkMediaObservation,
} from './media-observation';
import { isBilibiliTrackProbeCandidate, sniffBilibiliNetworkTrack } from './bilibili-track-sniffer';
import { isSupportedMediaVideoPage } from '../detector/media-settlement';
import { siteMediaRouteKey } from '../detector/site-media';

export interface NetworkRequestContext {
  documentId?: string;
  frameId: number;
  /** Stable media route captured when the request began. */
  routeKey?: string;
  /** Media generation captured when the request began. */
  mediaEpoch: number;
}

export type NetworkAssetHandler = (
  tabId: number,
  asset: MediaAsset,
  context: NetworkRequestContext,
) => void | Promise<void>;

export type NetworkObservationHandler = (
  tabId: number,
  observation: NetworkMediaObservation,
) => void | Promise<void>;

export type NetworkMediaEpochProvider = (tabId: number) => number | undefined;

/**
 * A document id survives same-document SPA navigation and cannot identify the
 * playing video. Adopt worker-restart quarantine only with a route-bearing URL
 * or an asset independently confirmed by a non-network detector.
 */
export function canAdoptQuarantinedNetworkAsset(
  asset: MediaAsset,
  currentPageUrl: string,
  authoritativeAssetIds: ReadonlySet<string>,
): boolean {
  const exactAuthoritativeAsset =
    authoritativeAssetIds.has(asset.id) ||
    authoritativeAssetIds.has(`url:${networkMediaResourceIdentity(asset.url)}`);
  if (exactAuthoritativeAsset) return true;
  try {
    const assetUrl = new URL(asset.url);
    const hostname = assetUrl.hostname.toLowerCase();
    if (
      (hostname === 'bilivideo.com' || hostname.endsWith('.bilivideo.com')) &&
      /\.m4s$/iu.test(assetUrl.pathname)
    ) {
      // A recommendation prefetch normally inherits the old page Referer, so
      // route equality cannot prove which BVID/CID owns an opaque DASH URL.
      return false;
    }
  } catch {
    // Invalid URLs cannot be Bilibili DASH resources; retain generic policy.
  }
  const currentRouteKey = siteMediaRouteKey(currentPageUrl);
  const explicitRouteUrls = [asset.requestHeaders?.referer, asset.pageUrl].filter(
    (value): value is string => Boolean(value && isSupportedMediaVideoPage(value)),
  );
  return explicitRouteUrls.some((value) => siteMediaRouteKey(value) === currentRouteKey);
}

export function authoritativeNetworkAssetKeys(asset: MediaAsset): readonly string[] {
  return [asset.id, `url:${networkMediaResourceIdentity(asset.url)}`];
}

let registered = false;
let activeHandler: NetworkAssetHandler | undefined;
let activeObservationHandler: NetworkObservationHandler | undefined;
let activeMediaEpochProvider: NetworkMediaEpochProvider | undefined;
const requestHeadersById = new Map<string, MediaRequestHeaders>();
const requestContextById = new Map<string, Readonly<NetworkRequestContext>>();
const MAX_PENDING_REQUEST_HEADERS = 1_024;

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === name)?.value;
}

function safeHeaderValue(value?: string): string | undefined {
  if (!value || value.length > 16_384 || /[\r\n]/u.test(value)) return undefined;
  return value;
}

function httpUrlHeader(value?: string): string | undefined {
  const safe = safeHeaderValue(value);
  if (!safe) return undefined;
  try {
    const parsed = new URL(safe);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Capture only replay-critical headers; Cookie is browser-managed and never retained. */
export function mediaRequestHeadersFromWebRequest(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): MediaRequestHeaders | undefined {
  const referer = httpUrlHeader(headerValue(headers, 'referer'));
  const originValue = httpUrlHeader(headerValue(headers, 'origin'));
  const origin = originValue ? new URL(originValue).origin : undefined;
  const authorization = safeHeaderValue(headerValue(headers, 'authorization'));
  const accept = safeHeaderValue(headerValue(headers, 'accept'));
  if (!referer && !origin && !authorization && !accept) return undefined;
  return {
    ...(referer ? { referer } : {}),
    ...(origin ? { origin } : {}),
    ...(authorization ? { authorization } : {}),
    ...(accept ? { accept } : {}),
  };
}

function onBeforeSendHeaders(
  details: chrome.webRequest.OnBeforeSendHeadersDetails,
): chrome.webRequest.BlockingResponse | undefined {
  if (details.tabId < 0 || (!activeHandler && !activeObservationHandler)) return undefined;
  if (!/^https?:\/\//iu.test(details.url)) return undefined;
  const requestHeaders = mediaRequestHeadersFromWebRequest(details.requestHeaders);
  if (requestHeaders) requestHeadersById.set(details.requestId, requestHeaders);
  else requestHeadersById.delete(details.requestId);
  const routeUrl = requestHeaders?.referer ?? details.initiator;
  requestContextById.set(
    details.requestId,
    Object.freeze({
      frameId: details.frameId,
      mediaEpoch: activeMediaEpochProvider?.(details.tabId) ?? -1,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      ...(routeUrl ? { routeKey: siteMediaRouteKey(routeUrl) } : {}),
    }),
  );

  while (requestHeadersById.size > MAX_PENDING_REQUEST_HEADERS) {
    const oldest = requestHeadersById.keys().next().value as string | undefined;
    if (!oldest) break;
    requestHeadersById.delete(oldest);
  }
  while (requestContextById.size > MAX_PENDING_REQUEST_HEADERS) {
    const oldest = requestContextById.keys().next().value as string | undefined;
    if (!oldest) break;
    requestContextById.delete(oldest);
  }
  return undefined;
}

function clearRequestContext(details: { requestId: string }): void {
  requestHeadersById.delete(details.requestId);
  requestContextById.delete(details.requestId);
}

export function responseSizeFromHeaders(
  statusCode: number,
  headers: chrome.webRequest.HttpHeader[] | undefined,
): number | undefined {
  const contentRange = headerValue(headers, 'content-range');
  const totalFromRange = /\bbytes\s+\d+-\d+\/(\d+|\*)/iu.exec(contentRange ?? '')?.[1];
  if (totalFromRange && totalFromRange !== '*') {
    const total = Number(totalFromRange);
    if (Number.isFinite(total) && total > 0) return total;
  }
  if (statusCode === 206) return undefined;
  const contentLength = Number(headerValue(headers, 'content-length'));
  return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
}

function dispatchNetworkObservation(
  details: chrome.webRequest.OnHeadersReceivedDetails,
  observation: NetworkMediaObservation,
  context: Readonly<NetworkRequestContext>,
): void {
  if (activeObservationHandler) {
    void Promise.resolve(activeObservationHandler(details.tabId, observation)).catch(
      () => undefined,
    );
  }

  // HEAD can enrich capture metadata, but chrome.downloads would replay it as a
  // GET. Non-GET endpoints (notably analytics beacons) are never downloadable.
  if (details.method.toUpperCase() !== 'GET') return;

  const resolved = resolveNetworkMediaCandidates([observation])[0];
  const resolvedKind =
    resolved &&
    resolved.role !== 'unknown' &&
    resolved.confidence !== 'low' &&
    (resolved.kind === 'video' || resolved.kind === 'audio' || resolved.kind === 'playlist')
      ? resolved.kind
      : undefined;
  const assetUrl = resolved?.url ?? details.url;
  const assetMime = resolved?.mime ?? observation.mime;
  const assetSize = resolved?.size ?? observation.size;
  const fallbackKind =
    resolved && resolved.role !== 'unknown' ? classifyMedia(assetUrl, assetMime) : undefined;
  const kind = resolvedKind ?? fallbackKind;
  if (!kind || !activeHandler) return;
  const extension = extensionFromMime(assetMime) ?? extensionFromUrl(assetUrl);
  const observedAt = Date.now();
  const asset: MediaAsset = {
    id: stableId(`${kind}:${networkMediaResourceIdentity(details.url)}`),
    url: assetUrl,
    pageUrl: details.initiator ?? '',
    pageTitle: '',
    frameId: details.frameId,
    kind,
    detectedBy: ['network'],
    ...(assetMime ? { mime: assetMime } : {}),
    ...(extension ? { extension } : {}),
    filename: filenameFromUrl(assetUrl, `${kind}-${stableId(assetUrl)}`),
    ...(assetSize == null ? {} : { size: assetSize }),
    ...(observation.requestHeaders ? { requestHeaders: { ...observation.requestHeaders } } : {}),
    downloadable: !details.url.startsWith('blob:'),
    discoveredAt: observedAt,
    lastObservedAt: observedAt,
  };
  void Promise.resolve(
    activeHandler(details.tabId, asset, {
      ...context,
    }),
  ).catch(() => undefined);
}

function onHeadersReceived(
  details: chrome.webRequest.OnHeadersReceivedDetails,
): chrome.webRequest.BlockingResponse | undefined {
  if (details.tabId < 0 || (!activeHandler && !activeObservationHandler)) return undefined;
  if (!/^https?:\/\//i.test(details.url)) return undefined;
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return undefined;
  const mime = headerValue(details.responseHeaders, 'content-type')?.split(';')[0]?.trim();
  const size = responseSizeFromHeaders(details.statusCode, details.responseHeaders);
  const range = parseNetworkByteRange(headerValue(details.responseHeaders, 'content-range') ?? '');
  const requestHeaders = requestHeadersById.get(details.requestId);
  const requestContext =
    requestContextById.get(details.requestId) ??
    Object.freeze({
      frameId: details.frameId,
      mediaEpoch: -1,
      ...(details.documentId ? { documentId: details.documentId } : {}),
      ...(details.initiator ? { routeKey: siteMediaRouteKey(details.initiator) } : {}),
    });
  const observation: NetworkMediaObservation = {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    ...(details.initiator ? { initiator: details.initiator } : {}),
    ...(details.documentId ? { documentId: details.documentId } : {}),
    frameId: details.frameId,
    resourceType: details.type,
    ...(mime ? { mime } : {}),
    status: details.statusCode,
    ...(size == null ? {} : { size }),
    time: details.timeStamp,
    ...(range ? { range } : {}),
    ...(requestHeaders ? { requestHeaders: { ...requestHeaders } } : {}),
  };
  if (details.method.toUpperCase() === 'GET' && isBilibiliTrackProbeCandidate(details.url)) {
    void sniffBilibiliNetworkTrack(details.url, requestHeaders).then((sniffedKind) => {
      dispatchNetworkObservation(
        details,
        sniffedKind ? { ...observation, sniffedKind } : observation,
        requestContext,
      );
    });
    return undefined;
  }
  dispatchNetworkObservation(details, observation, requestContext);
  return undefined;
}

function onBeforeRedirect(details: chrome.webRequest.OnBeforeRedirectDetails): void {
  if (details.tabId < 0 || !activeObservationHandler) return;
  if (!/^https?:\/\//i.test(details.url) || !/^https?:\/\//i.test(details.redirectUrl)) return;
  if (details.documentLifecycle && details.documentLifecycle !== 'active') return;
  const mime = headerValue(details.responseHeaders, 'content-type')?.split(';')[0]?.trim();
  const size = responseSizeFromHeaders(details.statusCode, details.responseHeaders);
  const range = parseNetworkByteRange(headerValue(details.responseHeaders, 'content-range') ?? '');
  const requestHeaders = requestHeadersById.get(details.requestId);
  const observation: NetworkMediaObservation = {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    ...(details.initiator ? { initiator: details.initiator } : {}),
    ...(details.documentId ? { documentId: details.documentId } : {}),
    frameId: details.frameId,
    resourceType: details.type,
    ...(mime ? { mime } : {}),
    status: details.statusCode,
    ...(size == null ? {} : { size }),
    time: details.timeStamp,
    ...(range ? { range } : {}),
    ...(requestHeaders ? { requestHeaders: { ...requestHeaders } } : {}),
    redirect: {
      fromUrl: details.url,
      toUrl: details.redirectUrl,
      status: details.statusCode,
      time: details.timeStamp,
    },
  };
  void Promise.resolve(activeObservationHandler(details.tabId, observation)).catch(() => undefined);
}

export async function hasFullDetectionPermission(): Promise<boolean> {
  return chrome.permissions.contains({
    permissions: ['webRequest'],
    origins: ['http://*/*', 'https://*/*'],
  });
}

export function startNetworkObserver(
  handler: NetworkAssetHandler,
  observationHandler?: NetworkObservationHandler,
  mediaEpochProvider?: NetworkMediaEpochProvider,
): boolean {
  activeHandler = handler;
  activeObservationHandler = observationHandler;
  activeMediaEpochProvider = mediaEpochProvider;
  if (registered) return true;
  try {
    // MV3 event listeners must be registered synchronously when the worker starts.
    // Chrome filters delivery until the optional webRequest and host grants exist.
    chrome.webRequest.onHeadersReceived.addListener(
      onHeadersReceived,
      { urls: ['http://*/*', 'https://*/*'] },
      ['responseHeaders'],
    );
    chrome.webRequest.onBeforeRedirect.addListener(
      onBeforeRedirect,
      { urls: ['http://*/*', 'https://*/*'] },
      ['responseHeaders'],
    );
    chrome.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      { urls: ['http://*/*', 'https://*/*'] },
      ['requestHeaders', 'extraHeaders'],
    );
    chrome.webRequest.onCompleted.addListener(clearRequestContext, {
      urls: ['http://*/*', 'https://*/*'],
    });
    chrome.webRequest.onErrorOccurred.addListener(clearRequestContext, {
      urls: ['http://*/*', 'https://*/*'],
    });
    registered = true;
    return true;
  } catch {
    return false;
  }
}

export function stopNetworkObserver(): void {
  activeHandler = undefined;
  activeObservationHandler = undefined;
  activeMediaEpochProvider = undefined;
  if (!registered) return;
  requestHeadersById.clear();
  requestContextById.clear();
  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  chrome.webRequest.onBeforeRedirect.removeListener(onBeforeRedirect);
  chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
  chrome.webRequest.onCompleted.removeListener(clearRequestContext);
  chrome.webRequest.onErrorOccurred.removeListener(clearRequestContext);
  registered = false;
}
