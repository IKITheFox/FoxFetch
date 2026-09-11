import {
  normalizeBilibiliBvid,
  normalizeBilibiliNumericId,
  parseBilibiliMediaManifest,
  type BilibiliMediaCandidate,
  type BilibiliManifestDiagnostics,
} from './bilibili-media';

export const BILIBILI_MANIFEST_CACHE_KEY = '__foxfetchBilibiliManifestCacheV1__';
export const BILIBILI_MANIFEST_READY_EVENT = 'foxfetch:bilibili-manifest-ready';
export const BILIBILI_MANIFEST_HOOK_STATUS_EVENT = 'foxfetch:bilibili-manifest-hook-status';
export const BILIBILI_ROUTE_CHANGED_EVENT = 'foxfetch:bilibili-route-changed';
export const BILIBILI_MANIFEST_HOOK_VERSION = 3 as const;

const CACHE_VERSION = 1 as const;
const LEGACY_INSTALL_STATE_VERSION = 2 as const;
const INSTALL_STATE_VERSION = BILIBILI_MANIFEST_HOOK_VERSION;
const MAX_CAPTURE_BODY_CHARS = 8 * 1024 * 1024;
// Bilibili can prefetch a fairly deep recommendation rail before the user
// chooses the next item. Six identities was small enough for the desired item
// to be evicted before its SPA route became current. Keep a wider, short-lived
// identity cache and additionally cap its estimated payload size below.
const MAX_CAPTURED_MANIFESTS = 32;
const MAX_CAPTURED_CANDIDATES = 256;
const CAPTURED_MANIFEST_TTL_MS = 10 * 60_000;
const MAX_CAPTURED_CACHE_WEIGHT = 2 * 1024 * 1024;
const MAX_PLAYURL_REQUEST_URL_CHARS = 32_768;
const MANIFEST_REPLAY_DEBOUNCE_MS = 250;
const RECENT_RESOURCE_WINDOW_MS = 30_000;
const RECENT_RESOURCE_REPLAY_LIMIT = 4;
const INSTALL_STATE_KEY = '__foxfetchBilibiliManifestCaptureStateV2__';

interface BilibiliManifestRequestIdentity {
  readonly bvid: string;
  readonly cid: string;
}

export interface BilibiliManifestReadyDetail extends BilibiliManifestRequestIdentity {
  readonly revision: number;
}

export interface BilibiliRouteChangedDetail {
  readonly bvid: string;
  readonly cid?: string;
}

export interface BilibiliManifestHookStatusDetail {
  readonly version: typeof BILIBILI_MANIFEST_HOOK_VERSION;
  readonly checkRevision: number;
  readonly captureRevision: number;
  readonly fetch: boolean;
  readonly xhr: boolean;
  readonly routeBridgeBound: boolean;
}

export interface CapturedBilibiliManifest {
  version: typeof CACHE_VERSION;
  bvid: string;
  cid: string;
  /** Monotonic per-document revision assigned after a sanitized capture is committed. */
  revision: number;
  /** Validated API request retained only inside MAIN world; fragments are removed. */
  requestUrl?: string;
  requestCredentials?: RequestCredentials;
  /** Legacy cache entries may contain it; capture identity never depends on the current route part. */
  part?: number;
  capturedAt: number;
  candidates: BilibiliMediaCandidate[];
  diagnostics?: BilibiliManifestDiagnostics;
}

export interface BilibiliManifestCache {
  version: typeof CACHE_VERSION;
  /** Highest committed capture revision in this document. */
  revision: number;
  entries: CapturedBilibiliManifest[];
}

interface CaptureScope {
  location: Pick<Location, 'href'>;
  history?: Pick<History, 'pushState' | 'replaceState'>;
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  CustomEvent?: typeof CustomEvent;
  dispatchEvent?: (event: Event) => boolean;
  addEventListener?: Window['addEventListener'];
  removeEventListener?: Window['removeEventListener'];
  performance?: Pick<Performance, 'getEntriesByType' | 'now'>;
  __INITIAL_STATE__?: unknown;
  __playinfo__?: unknown;
  [BILIBILI_MANIFEST_CACHE_KEY]?: BilibiliManifestCache;
}

interface XhrRequestMetadata {
  identity: BilibiliManifestRequestIdentity;
  requestUrl: string;
}

interface FetchCaptureBinding {
  source: typeof fetch;
  wrapped: typeof fetch;
}

interface XhrCaptureBinding {
  prototype: XMLHttpRequest;
  sourceOpen: XMLHttpRequest['open'];
  sourceSend: XMLHttpRequest['send'];
  open: XMLHttpRequest['open'];
  send: XMLHttpRequest['send'];
}

interface RouteBridgeBinding {
  history: Pick<History, 'pushState' | 'replaceState'>;
  sourcePushState: History['pushState'];
  sourceReplaceState: History['replaceState'];
  pushState: History['pushState'];
  replaceState: History['replaceState'];
  popstateListener: EventListener;
  popstateBound: boolean;
}

interface CaptureInstallState {
  version: typeof LEGACY_INSTALL_STATE_VERSION | typeof INSTALL_STATE_VERSION;
  fetch?: FetchCaptureBinding;
  xhr?: XhrCaptureBinding;
  routeBridge?: RouteBridgeBinding;
  checkRevision?: number;
  replayAttempts?: Array<{ key: string; attemptedAt: number }>;
  lastReplayKey?: string;
  lastReplayAt?: number;
}

type JsonRecord = Record<string, unknown>;

interface CurrentRouteIdentity extends BilibiliRouteChangedDetail {
  readonly aid?: string;
}

function safeGet(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== 'object' || value == null) && typeof value !== 'function') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function safeArray(value: unknown): unknown[] {
  try {
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizedRecordBvid(record: JsonRecord | undefined): string | undefined {
  return normalizeBilibiliBvid(safeGet(record, 'bvid'));
}

/**
 * Resolve the route's CID only from data that proves ownership by the current
 * BVID. This deliberately rejects stale SPA globals and ambiguous multipart
 * entries instead of choosing the newest cached CID.
 */
function currentRouteIdentity(scope: CaptureScope): CurrentRouteIdentity | undefined {
  try {
    const page = new URL(scope.location.href);
    const bvid = normalizeBilibiliBvid(/\/video\/(BV[0-9A-Za-z]+)/iu.exec(page.pathname)?.[1]);
    if (!bvid) return undefined;
    const routeCid = normalizeBilibiliNumericId(page.searchParams.get('cid'));
    const part = normalizeBilibiliNumericId(page.searchParams.get('p')) ?? '1';

    const initialState = asRecord(safeGet(scope, '__INITIAL_STATE__'));
    const initialVideo =
      asRecord(safeGet(initialState, 'videoData')) ?? asRecord(safeGet(initialState, 'videoInfo'));
    const initialBvid = normalizedRecordBvid(initialState) ?? normalizedRecordBvid(initialVideo);
    const stateBelongsToRoute = initialBvid === bvid;
    const pages = stateBelongsToRoute ? safeArray(safeGet(initialVideo, 'pages')) : [];
    const selectedPage = pages
      .map(asRecord)
      .find((candidate) => normalizeBilibiliNumericId(safeGet(candidate, 'page')) === part);
    const selectedPageCid = normalizeBilibiliNumericId(safeGet(selectedPage, 'cid'));
    const initialCid = stateBelongsToRoute
      ? (selectedPageCid ??
        (pages.length === 0
          ? normalizeBilibiliNumericId(safeGet(initialVideo, 'cid') ?? safeGet(initialState, 'cid'))
          : undefined))
      : undefined;
    const initialAid = stateBelongsToRoute
      ? normalizeBilibiliNumericId(
          safeGet(initialVideo, 'aid') ??
            safeGet(initialVideo, 'avid') ??
            safeGet(initialState, 'aid') ??
            safeGet(initialState, 'avid'),
        )
      : undefined;

    const playInfo = asRecord(safeGet(scope, '__playinfo__'));
    const payload =
      asRecord(safeGet(playInfo, 'data')) ?? asRecord(safeGet(playInfo, 'result')) ?? playInfo;
    const videoInfo =
      asRecord(safeGet(payload, 'video_info')) ?? asRecord(safeGet(payload, 'videoInfo'));
    const playInfoBvid =
      normalizedRecordBvid(playInfo) ??
      normalizedRecordBvid(payload) ??
      normalizedRecordBvid(videoInfo);
    const playInfoCid =
      playInfoBvid === bvid
        ? normalizeBilibiliNumericId(
            safeGet(playInfo, 'cid') ?? safeGet(payload, 'cid') ?? safeGet(videoInfo, 'cid'),
          )
        : undefined;
    const playInfoAid =
      playInfoBvid === bvid
        ? normalizeBilibiliNumericId(
            safeGet(playInfo, 'aid') ??
              safeGet(playInfo, 'avid') ??
              safeGet(payload, 'aid') ??
              safeGet(payload, 'avid') ??
              safeGet(videoInfo, 'aid') ??
              safeGet(videoInfo, 'avid'),
          )
        : undefined;

    const cid = routeCid ?? initialCid ?? playInfoCid;
    const aid = initialAid ?? playInfoAid;
    return Object.freeze({ bvid, ...(cid ? { cid } : {}), ...(aid ? { aid } : {}) });
  } catch {
    return undefined;
  }
}

function isBilibiliPlayurlEndpoint(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.hostname.toLowerCase() === 'api.bilibili.com' &&
    /^\/x\/player\/(?:wbi\/)?playurl$/u.test(url.pathname)
  );
}

function requestIdentity(
  scope: CaptureScope,
  requestUrl: string,
): BilibiliManifestRequestIdentity | undefined {
  try {
    const url = new URL(requestUrl);
    if (!isBilibiliPlayurlEndpoint(url)) return undefined;
    const cid = normalizeBilibiliNumericId(url.searchParams.get('cid'));
    if (!cid) return undefined;

    const rawBvid = url.searchParams.get('bvid');
    if (rawBvid != null) {
      const bvid = normalizeBilibiliBvid(rawBvid);
      return bvid ? Object.freeze({ bvid, cid }) : undefined;
    }

    // aid/avid requests are safe only when the current page state proves the
    // exact AID, BVID and CID mapping. A next-video prefetch that cannot yet be
    // mapped remains intentionally uncaptured rather than being cross-wired.
    const aid = normalizeBilibiliNumericId(url.searchParams.get('avid'));
    const legacyAid = normalizeBilibiliNumericId(url.searchParams.get('aid'));
    if (aid && legacyAid && aid !== legacyAid) return undefined;
    const requestedAid = aid ?? legacyAid;
    const current = currentRouteIdentity(scope);
    if (!requestedAid || !current?.aid || !current.cid) return undefined;
    if (requestedAid !== current.aid || cid !== current.cid) return undefined;
    return Object.freeze({ bvid: current.bvid, cid });
  } catch {
    return undefined;
  }
}

function validatedRequestUrl(
  scope: CaptureScope,
  requestUrl: string,
  expected: BilibiliManifestRequestIdentity,
): string | undefined {
  if (!requestUrl || requestUrl.length > MAX_PLAYURL_REQUEST_URL_CHARS) return undefined;
  try {
    const url = new URL(requestUrl);
    if (!isBilibiliPlayurlEndpoint(url)) return undefined;
    const identity = requestIdentity(scope, url.href);
    if (!identity || identity.bvid !== expected.bvid || identity.cid !== expected.cid) {
      return undefined;
    }
    url.hash = '';
    const normalized = url.href;
    return normalized.length <= MAX_PLAYURL_REQUEST_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function normalizedRequestCredentials(value: unknown): RequestCredentials | undefined {
  return value === 'omit' || value === 'same-origin' || value === 'include' ? value : undefined;
}

function requestCredentialsFromFetch(input: unknown, init: unknown): RequestCredentials {
  const initCredentials = normalizedRequestCredentials(safeGet(init, 'credentials'));
  if (initCredentials) return initCredentials;
  return normalizedRequestCredentials(safeGet(input, 'credentials')) ?? 'same-origin';
}

function nextCaptureRevision(cache: BilibiliManifestCache | undefined): number {
  let revision = normalizeCaptureRevision(safeGet(cache, 'revision')) ?? 0;
  for (const entry of Array.isArray(cache?.entries) ? cache.entries : []) {
    revision = Math.max(revision, normalizeCaptureRevision(safeGet(entry, 'revision')) ?? 0);
  }
  return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : 1;
}

function normalizeCaptureRevision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function cloneCandidate(candidate: BilibiliMediaCandidate): BilibiliMediaCandidate {
  return {
    ...candidate,
    ...(candidate.representation ? { representation: { ...candidate.representation } } : {}),
  };
}

function candidateRepresentationKey(candidate: BilibiliMediaCandidate): string {
  return candidate.representation?.key ?? `${candidate.kind}:url:${candidate.url}`;
}

/**
 * Responses for one BVID/CID are incremental. Replace signed URLs and mirrors
 * for representations present in the newest response, while retaining every
 * representation that only appeared in an earlier authorized response.
 */
function mergeManifestCandidates(
  previous: readonly BilibiliMediaCandidate[],
  incoming: readonly BilibiliMediaCandidate[],
): BilibiliMediaCandidate[] {
  const incomingKeys = new Set(incoming.map(candidateRepresentationKey));
  const merged = [
    ...incoming.map(cloneCandidate),
    ...previous
      .filter((candidate) => !incomingKeys.has(candidateRepresentationKey(candidate)))
      .map(cloneCandidate),
  ];
  const seenUrls = new Set<string>();
  return merged.filter((candidate) => {
    const key = `${candidate.kind}\u0000${candidate.url}`;
    if (seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
}

function mergeManifestDiagnostics(
  previous: BilibiliManifestDiagnostics | undefined,
  incoming: BilibiliManifestDiagnostics,
  candidates: readonly BilibiliMediaCandidate[],
): BilibiliManifestDiagnostics {
  const formats = new Map<number, BilibiliManifestDiagnostics['advertisedFormats'][number]>();
  for (const format of previous?.advertisedFormats ?? []) formats.set(format.qn, { ...format });
  for (const format of incoming.advertisedFormats) formats.set(format.qn, { ...format });
  const deliveredQns = new Set(
    candidates
      .filter((candidate) => candidate.kind === 'video')
      .map((candidate) => candidate.representation?.qn)
      .filter((qn): qn is number => qn != null),
  );
  return {
    advertisedFormats: [...formats.values()]
      .map((format) => ({
        ...format,
        capabilities: {
          ...format.capabilities,
          advertised: true,
          delivered: deliveredQns.has(format.qn),
        },
      }))
      .sort((left, right) => right.qn - left.qn),
    deliveredRepresentationKeys: [
      ...new Set(
        candidates
          .filter((candidate) => candidate.kind === 'video')
          .map((candidate) => candidate.representation?.key)
          .filter((key): key is string => Boolean(key)),
      ),
    ],
  };
}

function manifestWeight(entry: CapturedBilibiliManifest): number {
  let weight =
    72 +
    entry.bvid.length +
    entry.cid.length +
    (typeof entry.requestUrl === 'string' ? entry.requestUrl.length : 0);
  for (const candidate of entry.candidates) {
    weight +=
      96 +
      candidate.url.length +
      candidate.mime.length +
      (candidate.width == null ? 0 : 8) +
      (candidate.height == null ? 0 : 8) +
      (candidate.duration == null ? 0 : 8) +
      (candidate.size == null ? 0 : 8);
    if (candidate.representation) {
      weight += JSON.stringify(candidate.representation).length;
    }
  }
  if (entry.diagnostics) weight += JSON.stringify(entry.diagnostics).length;
  return weight;
}

function boundedManifestEntries(
  entries: readonly CapturedBilibiliManifest[],
  now: number,
): CapturedBilibiliManifest[] {
  const retained: CapturedBilibiliManifest[] = [];
  let weight = 0;
  for (const entry of entries) {
    if (
      entry == null ||
      entry.version !== CACHE_VERSION ||
      !normalizeBilibiliBvid(entry.bvid) ||
      !normalizeBilibiliNumericId(entry.cid) ||
      !Number.isFinite(entry.capturedAt) ||
      now - entry.capturedAt > CAPTURED_MANIFEST_TTL_MS ||
      !Array.isArray(entry.candidates)
    ) {
      continue;
    }
    const nextWeight = manifestWeight(entry);
    if (
      retained.length >= MAX_CAPTURED_MANIFESTS ||
      weight + nextWeight > MAX_CAPTURED_CACHE_WEIGHT
    ) {
      continue;
    }
    retained.push({
      ...entry,
      revision: normalizeCaptureRevision(safeGet(entry, 'revision')) ?? 0,
    });
    weight += nextWeight;
  }
  return retained;
}

function migrateLegacyCacheRevisions(scope: CaptureScope, now = Date.now()): void {
  const cache = scope[BILIBILI_MANIFEST_CACHE_KEY];
  if (cache?.version !== CACHE_VERSION || !Array.isArray(cache.entries)) return;
  const entries = boundedManifestEntries(cache.entries, now);
  const legacy = entries.filter((entry) => !normalizeCaptureRevision(entry.revision));
  if (legacy.length === 0 && normalizeCaptureRevision(safeGet(cache, 'revision'))) return;

  let revision = Math.max(
    normalizeCaptureRevision(safeGet(cache, 'revision')) ?? 0,
    ...entries.map((entry) => normalizeCaptureRevision(entry.revision) ?? 0),
  );
  const assigned = new Map<CapturedBilibiliManifest, number>();
  for (const entry of [...legacy].sort((left, right) => left.capturedAt - right.capturedAt)) {
    revision = revision < Number.MAX_SAFE_INTEGER ? revision + 1 : 1;
    assigned.set(entry, revision);
  }
  const migrated: BilibiliManifestCache = {
    version: CACHE_VERSION,
    revision,
    entries: entries.map((entry) => ({
      ...entry,
      revision: assigned.get(entry) ?? entry.revision,
    })),
  };
  try {
    Object.defineProperty(scope, BILIBILI_MANIFEST_CACHE_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: migrated,
    });
  } catch {
    scope[BILIBILI_MANIFEST_CACHE_KEY] = migrated;
  }
}

function cacheManifest(
  scope: CaptureScope,
  identity: BilibiliManifestRequestIdentity,
  body: unknown,
  request?: { url: string; credentials: RequestCredentials },
  capturedAt = Date.now(),
): number | undefined {
  const parsed = parseBilibiliMediaManifest(body, identity);
  if (!parsed || parsed.identity.cid !== identity.cid) return undefined;
  const incomingCandidates = parsed.candidates
    .slice(0, MAX_CAPTURED_CANDIDATES)
    .map(cloneCandidate);
  if (incomingCandidates.length === 0) return undefined;

  const cache = scope[BILIBILI_MANIFEST_CACHE_KEY];
  const revision = nextCaptureRevision(cache);
  const previousEntries = boundedManifestEntries(
    cache?.version === CACHE_VERSION && Array.isArray(cache.entries) ? cache.entries : [],
    capturedAt,
  );
  const previous = previousEntries.find(
    (entry) => entry.bvid === identity.bvid && entry.cid === identity.cid,
  );
  const candidates = mergeManifestCandidates(previous?.candidates ?? [], incomingCandidates).slice(
    0,
    MAX_CAPTURED_CANDIDATES,
  );
  const next: CapturedBilibiliManifest = {
    version: CACHE_VERSION,
    ...identity,
    revision,
    ...(request == null
      ? previous?.requestUrl
        ? {
            requestUrl: previous.requestUrl,
            ...(previous.requestCredentials
              ? { requestCredentials: previous.requestCredentials }
              : {}),
          }
        : {}
      : (() => {
          const requestUrl = validatedRequestUrl(scope, request.url, identity);
          return requestUrl
            ? { requestUrl, requestCredentials: request.credentials }
            : previous?.requestUrl
              ? {
                  requestUrl: previous.requestUrl,
                  ...(previous.requestCredentials
                    ? { requestCredentials: previous.requestCredentials }
                    : {}),
                }
              : {};
        })()),
    capturedAt,
    candidates,
    diagnostics: mergeManifestDiagnostics(previous?.diagnostics, parsed.diagnostics, candidates),
  };
  const entries = boundedManifestEntries(
    [
      next,
      ...previousEntries.filter(
        (entry) => entry.bvid !== identity.bvid || entry.cid !== identity.cid,
      ),
    ],
    capturedAt,
  );
  const nextCache: BilibiliManifestCache = { version: CACHE_VERSION, revision, entries };
  try {
    Object.defineProperty(scope, BILIBILI_MANIFEST_CACHE_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: nextCache,
    });
  } catch {
    scope[BILIBILI_MANIFEST_CACHE_KEY] = nextCache;
  }
  notifyManifestReady(scope, { ...identity, revision });
  return revision;
}

function notifyManifestReady(scope: CaptureScope, identity: BilibiliManifestReadyDetail): void {
  if (typeof scope.dispatchEvent !== 'function' || typeof scope.CustomEvent !== 'function') return;
  try {
    const detail: BilibiliManifestReadyDetail = Object.freeze({
      bvid: identity.bvid,
      cid: identity.cid,
      revision: identity.revision,
    });
    const event = new scope.CustomEvent(BILIBILI_MANIFEST_READY_EVENT, { detail });
    Reflect.apply(scope.dispatchEvent, scope, [event]);
  } catch {
    // A page can replace DOM constructors or event methods; cache capture must remain passive.
  }
}

function notifyRouteChanged(scope: CaptureScope): BilibiliRouteChangedDetail | undefined {
  const current = currentRouteIdentity(scope);
  if (!current) return undefined;
  const detail: BilibiliRouteChangedDetail = Object.freeze({
    bvid: current.bvid,
    ...(current.cid ? { cid: current.cid } : {}),
  });
  if (typeof scope.dispatchEvent !== 'function' || typeof scope.CustomEvent !== 'function') {
    return detail;
  }
  try {
    const event = new scope.CustomEvent(BILIBILI_ROUTE_CHANGED_EVENT, { detail });
    Reflect.apply(scope.dispatchEvent, scope, [event]);
  } catch {
    // Route observation must not alter History or popstate semantics.
  }
  return detail;
}

function bindPopstateListener(scope: CaptureScope, listener: EventListener): boolean {
  if (
    typeof scope.addEventListener !== 'function' ||
    typeof scope.removeEventListener !== 'function'
  ) {
    return false;
  }
  try {
    Reflect.apply(scope.removeEventListener, scope, ['popstate', listener]);
    Reflect.apply(scope.addEventListener, scope, ['popstate', listener]);
    return true;
  } catch {
    return false;
  }
}

function unbindPopstateListener(
  scope: CaptureScope,
  binding: RouteBridgeBinding | undefined,
): void {
  if (!binding?.popstateBound || typeof scope.removeEventListener !== 'function') return;
  try {
    Reflect.apply(scope.removeEventListener, scope, ['popstate', binding.popstateListener]);
  } catch {
    // A page can replace EventTarget methods; History wrapping remains passive.
  }
}

function afterBilibiliRouteTransition(scope: CaptureScope): void {
  notifyRouteChanged(scope);
  replayCachedBilibiliManifestReadyForCurrentRoute(scope);
}

function installRouteBridge(
  scope: CaptureScope,
  previous?: RouteBridgeBinding,
  reuseHealthyBinding = true,
): RouteBridgeBinding | undefined {
  const history = scope.history;
  if (
    !history ||
    typeof history.pushState !== 'function' ||
    typeof history.replaceState !== 'function'
  ) {
    unbindPopstateListener(scope, previous);
    return undefined;
  }

  const healthyPrevious =
    previous?.history === history &&
    history.pushState === previous.pushState &&
    history.replaceState === previous.replaceState;
  if (healthyPrevious && reuseHealthyBinding) {
    const popstateBound = bindPopstateListener(scope, previous.popstateListener);
    return { ...previous, popstateBound };
  }

  const sourcePushState =
    previous?.history === history && history.pushState === previous.pushState
      ? previous.sourcePushState
      : history.pushState;
  const sourceReplaceState =
    previous?.history === history && history.replaceState === previous.replaceState
      ? previous.sourceReplaceState
      : history.replaceState;
  const routeChanged = (): void => afterBilibiliRouteTransition(scope);
  const pushState = new Proxy(sourcePushState, {
    apply(target, thisArgument, argumentsList) {
      const result = Reflect.apply(target, thisArgument, argumentsList);
      routeChanged();
      return result;
    },
  });
  const replaceState = new Proxy(sourceReplaceState, {
    apply(target, thisArgument, argumentsList) {
      const result = Reflect.apply(target, thisArgument, argumentsList);
      routeChanged();
      return result;
    },
  });
  const popstateListener: EventListener = () => routeChanged();
  unbindPopstateListener(scope, previous);

  const currentPushState = history.pushState;
  const currentReplaceState = history.replaceState;
  try {
    history.pushState = pushState;
    history.replaceState = replaceState;
    if (history.pushState !== pushState || history.replaceState !== replaceState) {
      throw new Error('History methods are not writable');
    }
  } catch {
    try {
      if (history.pushState === pushState) history.pushState = currentPushState;
      if (history.replaceState === replaceState) history.replaceState = currentReplaceState;
    } catch {
      // Best effort rollback only; the wrappers preserve native semantics.
    }
    return undefined;
  }

  const popstateBound = bindPopstateListener(scope, popstateListener);
  return {
    history,
    sourcePushState,
    sourceReplaceState,
    pushState,
    replaceState,
    popstateListener,
    popstateBound,
  };
}

function cachedManifestForCurrentRoute(
  scope: CaptureScope,
  now = Date.now(),
): CapturedBilibiliManifest | undefined {
  const current = currentRouteIdentity(scope);
  const cache = scope[BILIBILI_MANIFEST_CACHE_KEY];
  if (!current || cache?.version !== CACHE_VERSION || !Array.isArray(cache.entries)) {
    return undefined;
  }
  const entries = boundedManifestEntries(cache.entries, now).filter(
    (entry) => normalizeBilibiliBvid(entry.bvid) === current.bvid,
  );
  if (entries.length === 0) return undefined;
  const entry = current.cid
    ? entries.find((candidate) => normalizeBilibiliNumericId(candidate.cid) === current.cid)
    : new Set(entries.map((candidate) => normalizeBilibiliNumericId(candidate.cid))).size === 1
      ? entries[0]
      : undefined;
  return entry && normalizeCaptureRevision(entry.revision) ? entry : undefined;
}

/**
 * Re-emit an identity-only notification for a manifest captured before its SPA
 * route became current. No URLs or response data cross into the isolated world.
 */
export function replayCachedBilibiliManifestReadyForCurrentRoute(
  providedScope?: CaptureScope,
): boolean {
  const scope = providedScope ?? (window as unknown as CaptureScope);
  const entry = cachedManifestForCurrentRoute(scope);
  if (!entry) return false;
  notifyManifestReady(scope, {
    bvid: entry.bvid,
    cid: entry.cid,
    revision: entry.revision,
  });
  return true;
}

async function captureText(
  scope: CaptureScope,
  identity: BilibiliManifestRequestIdentity,
  readText: () => Promise<string>,
  request?: { url: string; credentials: RequestCredentials },
): Promise<number | undefined> {
  try {
    const text = await readText();
    if (!text || text.length > MAX_CAPTURE_BODY_CHARS) return undefined;
    return cacheManifest(scope, identity, JSON.parse(text) as unknown, request);
  } catch {
    // Network bodies, clones, and JSON parsing are page-owned and optional.
    return undefined;
  }
}

function readCaptureInstallState(scope: CaptureScope): CaptureInstallState | undefined {
  const marked = safeGet(scope, INSTALL_STATE_KEY);
  if (marked == null || typeof marked !== 'object') return undefined;
  const version = safeGet(marked, 'version');
  return version === LEGACY_INSTALL_STATE_VERSION || version === INSTALL_STATE_VERSION
    ? (marked as CaptureInstallState)
    : undefined;
}

function claimReplayAttempt(
  state: CaptureInstallState,
  key: string,
  now: number,
  ttlMs = CAPTURED_MANIFEST_TTL_MS,
): boolean {
  const retained = (state.replayAttempts ?? []).filter(
    (attempt) =>
      attempt != null &&
      typeof attempt.key === 'string' &&
      Number.isFinite(attempt.attemptedAt) &&
      now - attempt.attemptedAt <= ttlMs,
  );
  if (retained.some((attempt) => attempt.key === key)) {
    state.replayAttempts = retained;
    return false;
  }
  state.replayAttempts = [{ key, attemptedAt: now }, ...retained].slice(0, 64);
  return true;
}

async function fetchAndCaptureManifest(
  scope: CaptureScope,
  state: CaptureInstallState,
  identity: BilibiliManifestRequestIdentity,
  requestUrl: string,
  credentials: RequestCredentials,
): Promise<boolean> {
  const validatedUrl = validatedRequestUrl(scope, requestUrl, identity);
  if (!validatedUrl) return false;
  const fetchSource = state.fetch?.source ?? scope.fetch;
  if (typeof fetchSource !== 'function') return false;
  try {
    const response = (await Reflect.apply(fetchSource, scope, [validatedUrl, { credentials }])) as
      Response | undefined;
    if (!response) return false;
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BODY_CHARS) return false;
    const clone = response.clone();
    return (
      (await captureText(scope, identity, () => clone.text(), {
        url: validatedUrl,
        credentials,
      })) != null
    );
  } catch {
    return false;
  }
}

/**
 * Refresh a previously captured current-route manifest at most once for each
 * BVID/CID/capture revision. The validated request URL never leaves MAIN world.
 */
export async function replayCapturedBilibiliManifestRequestForCurrentRoute(
  providedScope?: CaptureScope,
): Promise<boolean> {
  const scope = providedScope ?? (window as unknown as CaptureScope);
  const current = currentRouteIdentity(scope);
  const entry = cachedManifestForCurrentRoute(scope);
  if (!current?.cid || !entry?.requestUrl || current.cid !== entry.cid) return false;
  const state = readCaptureInstallState(scope);
  if (!state || state.version !== INSTALL_STATE_VERSION) return false;
  const key = `captured:${entry.bvid}:${entry.cid}:${entry.revision}`;
  if (!claimReplayAttempt(state, key, Date.now())) return false;
  const captured = await fetchAndCaptureManifest(
    scope,
    state,
    { bvid: entry.bvid, cid: entry.cid },
    entry.requestUrl,
    entry.requestCredentials ?? 'same-origin',
  );
  if (captured) {
    const refreshed = cachedManifestForCurrentRoute(scope);
    if (refreshed) {
      claimReplayAttempt(
        state,
        `captured:${refreshed.bvid}:${refreshed.cid}:${refreshed.revision}`,
        Date.now(),
      );
    }
  }
  return captured;
}

async function recoverRecentCurrentRouteManifest(
  scope: CaptureScope,
  state: CaptureInstallState,
): Promise<boolean> {
  const current = currentRouteIdentity(scope);
  if (!current?.cid || cachedManifestForCurrentRoute(scope)) return false;
  const performance = scope.performance;
  if (!performance || typeof performance.getEntriesByType !== 'function') return false;

  let entries: PerformanceEntry[];
  let performanceNow: number;
  try {
    entries = performance.getEntriesByType('resource');
    performanceNow = typeof performance.now === 'function' ? performance.now() : Number.NaN;
  } catch {
    return false;
  }
  if (!Array.isArray(entries) || !Number.isFinite(performanceNow)) return false;

  const requests = entries
    .slice(-64)
    .reverse()
    .flatMap((entry) => {
      const name = typeof safeGet(entry, 'name') === 'string' ? String(safeGet(entry, 'name')) : '';
      const end = Number(safeGet(entry, 'responseEnd') ?? safeGet(entry, 'startTime'));
      if (!name || !Number.isFinite(end) || performanceNow - end > RECENT_RESOURCE_WINDOW_MS) {
        return [];
      }
      const identity = requestIdentity(scope, name);
      if (!identity || identity.bvid !== current.bvid || identity.cid !== current.cid) return [];
      const requestUrl = validatedRequestUrl(scope, name, identity);
      return requestUrl ? [{ identity, requestUrl }] : [];
    })
    .slice(0, RECENT_RESOURCE_REPLAY_LIMIT);

  for (const request of requests) {
    const key = `resource:${request.identity.bvid}:${request.identity.cid}:${request.requestUrl}`;
    if (!claimReplayAttempt(state, key, Date.now(), RECENT_RESOURCE_WINDOW_MS)) continue;
    // Resource Timing cannot expose the original credentials mode. Bilibili's
    // authenticated playurl API is same-site but cross-origin, so `include` is
    // the only bounded recovery mode that preserves the page's signed-in view.
    if (
      await fetchAndCaptureManifest(scope, state, request.identity, request.requestUrl, 'include')
    ) {
      return true;
    }
  }
  return false;
}

function requestUrlFromFetch(input: unknown, baseUrl: string): string | undefined {
  try {
    let rawUrl: string | undefined;
    if (typeof input === 'string') rawUrl = input;
    if (typeof URL !== 'undefined' && input instanceof URL) rawUrl = input.href;
    const reflectedUrl = safeGet(input, 'url');
    if (typeof reflectedUrl === 'string') rawUrl = reflectedUrl;
    if (!rawUrl) return undefined;
    return new URL(rawUrl, baseUrl).href;
  } catch {
    return undefined;
  }
}

function requestMethodFromFetch(input: unknown, init: unknown): string {
  const initMethod = safeGet(init, 'method');
  if (typeof initMethod === 'string' && initMethod.trim()) return initMethod.trim().toUpperCase();
  const inputMethod = safeGet(input, 'method');
  if (typeof inputMethod === 'string' && inputMethod.trim())
    return inputMethod.trim().toUpperCase();
  return 'GET';
}

function installFetchCapture(
  scope: CaptureScope,
  previous?: FetchCaptureBinding,
  reuseHealthyBinding = true,
): FetchCaptureBinding | undefined {
  const current = scope.fetch;
  if (typeof current !== 'function') return undefined;
  if (previous && current === previous.wrapped && reuseHealthyBinding) return previous;
  const source = previous && current === previous.wrapped ? previous.source : current;
  const wrapped = new Proxy(source, {
    apply(target, thisArgument, argumentsList) {
      const result = Reflect.apply(target, thisArgument, argumentsList) as ReturnType<typeof fetch>;
      const requestUrl = requestUrlFromFetch(argumentsList[0], scope.location.href);
      const identity =
        requestUrl && requestMethodFromFetch(argumentsList[0], argumentsList[1]) === 'GET'
          ? requestIdentity(scope, requestUrl)
          : undefined;
      if (identity && requestUrl) {
        const capturedRequestUrl = requestUrl;
        const credentials = requestCredentialsFromFetch(argumentsList[0], argumentsList[1]);
        void Promise.resolve(result)
          .then((response) => {
            const contentLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_BODY_CHARS) return;
            const clone = response.clone();
            return captureText(scope, identity, () => clone.text(), {
              url: capturedRequestUrl,
              credentials,
            });
          })
          .catch(() => undefined);
      }
      return result;
    },
  });
  try {
    scope.fetch = wrapped;
    return scope.fetch === wrapped ? { source, wrapped } : undefined;
  } catch {
    return undefined;
  }
}

function installXhrCapture(
  scope: CaptureScope,
  previous?: XhrCaptureBinding,
  reuseHealthyBinding = true,
): XhrCaptureBinding | undefined {
  const Xhr = scope.XMLHttpRequest;
  const prototype = Xhr?.prototype;
  if (!prototype || typeof prototype.open !== 'function' || typeof prototype.send !== 'function') {
    return undefined;
  }
  if (previous && previous.prototype === prototype) {
    if (
      reuseHealthyBinding &&
      prototype.open === previous.open &&
      prototype.send === previous.send
    ) {
      return previous;
    }
  }
  const requests = new WeakMap<object, XhrRequestMetadata>();
  const sourceOpen =
    previous?.prototype === prototype && prototype.open === previous.open
      ? previous.sourceOpen
      : prototype.open;
  const sourceSend =
    previous?.prototype === prototype && prototype.send === previous.send
      ? previous.sourceSend
      : prototype.send;
  const open = new Proxy(sourceOpen, {
    apply(target, thisArgument, argumentsList) {
      const result = Reflect.apply(target, thisArgument, argumentsList);
      const method = typeof argumentsList[0] === 'string' ? argumentsList[0].toUpperCase() : '';
      const rawUrl = argumentsList[1];
      let url: string | undefined;
      try {
        url = new URL(String(rawUrl), scope.location.href).href;
      } catch {
        // Invalid XHR URLs are handled by the native method.
      }
      if (
        thisArgument != null &&
        (typeof thisArgument === 'object' || typeof thisArgument === 'function')
      ) {
        const identity = method === 'GET' && url ? requestIdentity(scope, url) : undefined;
        if (identity) {
          requests.set(thisArgument as object, { identity, requestUrl: url! });
        } else {
          requests.delete(thisArgument as object);
        }
      }
      return result;
    },
  });
  const send = new Proxy(sourceSend, {
    apply(target, thisArgument, argumentsList) {
      const metadata =
        thisArgument != null &&
        (typeof thisArgument === 'object' || typeof thisArgument === 'function')
          ? requests.get(thisArgument as object)
          : undefined;
      if (metadata && typeof Reflect.get(thisArgument, 'addEventListener') === 'function') {
        const onLoad = (): void => {
          try {
            const status = Number(Reflect.get(thisArgument, 'status'));
            if (status < 200 || status >= 300) return;
            const responseType = String(Reflect.get(thisArgument, 'responseType') ?? '');
            const response = Reflect.get(thisArgument, 'response');
            const credentials: RequestCredentials = Reflect.get(thisArgument, 'withCredentials')
              ? 'include'
              : 'same-origin';
            const request = {
              url: metadata.requestUrl,
              credentials,
            };
            if (responseType === 'json' && response != null) {
              cacheManifest(scope, metadata.identity, response, request);
              return;
            }
            const text = String(Reflect.get(thisArgument, 'responseText') ?? '');
            if (!text || text.length > MAX_CAPTURE_BODY_CHARS) return;
            cacheManifest(scope, metadata.identity, JSON.parse(text) as unknown, request);
          } catch {
            // Access to an XHR response can fail for unsupported response types.
          }
        };
        Reflect.apply(Reflect.get(thisArgument, 'addEventListener'), thisArgument, [
          'load',
          onLoad,
          { once: true },
        ]);
      }
      return Reflect.apply(target, thisArgument, argumentsList);
    },
  });
  try {
    prototype.open = open;
    prototype.send = send;
    return prototype.open === open && prototype.send === send
      ? { prototype, sourceOpen, sourceSend, open, send }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface BilibiliManifestCaptureInstallResult extends BilibiliManifestHookStatusDetail {
  alreadyInstalled: boolean;
}

/** Install passive, non-consuming playurl response capture in the page's MAIN world. */
export function installBilibiliManifestCaptureMainWorld(
  providedScope?: CaptureScope,
): BilibiliManifestCaptureInstallResult {
  const scope = providedScope ?? (window as unknown as CaptureScope);
  const previous = readCaptureInstallState(scope);
  const reuseHealthyBinding = previous?.version === INSTALL_STATE_VERSION;
  const fetchBinding = installFetchCapture(scope, previous?.fetch, reuseHealthyBinding);
  const xhrBinding = installXhrCapture(scope, previous?.xhr, reuseHealthyBinding);
  const routeBridge = installRouteBridge(scope, previous?.routeBridge, reuseHealthyBinding);
  const checkRevision =
    reuseHealthyBinding &&
    typeof previous.checkRevision === 'number' &&
    Number.isSafeInteger(previous.checkRevision) &&
    previous.checkRevision > 0 &&
    previous.checkRevision < Number.MAX_SAFE_INTEGER
      ? previous.checkRevision + 1
      : 1;
  const state: CaptureInstallState = {
    version: INSTALL_STATE_VERSION,
    ...(fetchBinding ? { fetch: fetchBinding } : {}),
    ...(xhrBinding ? { xhr: xhrBinding } : {}),
    ...(routeBridge ? { routeBridge } : {}),
    checkRevision,
    ...(previous?.replayAttempts ? { replayAttempts: previous.replayAttempts } : {}),
    ...(previous?.lastReplayKey ? { lastReplayKey: previous.lastReplayKey } : {}),
    ...(previous?.lastReplayAt == null ? {} : { lastReplayAt: previous.lastReplayAt }),
  };
  try {
    Object.defineProperty(scope, INSTALL_STATE_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: state,
    });
  } catch {
    Reflect.set(scope, INSTALL_STATE_KEY, state);
  }
  migrateLegacyCacheRevisions(scope);
  const cache = scope[BILIBILI_MANIFEST_CACHE_KEY];
  const captureRevision = Math.max(
    normalizeCaptureRevision(safeGet(cache, 'revision')) ?? 0,
    ...(Array.isArray(cache?.entries)
      ? cache.entries.map((entry) => normalizeCaptureRevision(safeGet(entry, 'revision')) ?? 0)
      : [0]),
  );
  const result: BilibiliManifestCaptureInstallResult = Object.freeze({
    version: BILIBILI_MANIFEST_HOOK_VERSION,
    checkRevision,
    captureRevision,
    fetch: fetchBinding != null,
    xhr: xhrBinding != null,
    routeBridgeBound: routeBridge?.popstateBound === true,
    alreadyInstalled: previous != null,
  });
  const replayEntry = cachedManifestForCurrentRoute(scope);
  const replayKey = replayEntry
    ? `${replayEntry.bvid}:${replayEntry.cid}:${replayEntry.revision}`
    : undefined;
  const now = Date.now();
  if (
    replayKey &&
    (state.lastReplayKey !== replayKey ||
      state.lastReplayAt == null ||
      now - state.lastReplayAt >= MANIFEST_REPLAY_DEBOUNCE_MS) &&
    replayCachedBilibiliManifestReadyForCurrentRoute(scope)
  ) {
    state.lastReplayKey = replayKey;
    state.lastReplayAt = now;
  }
  void recoverRecentCurrentRouteManifest(scope, state);
  return result;
}
