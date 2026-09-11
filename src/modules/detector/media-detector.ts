import { MAX_ASSETS_PER_TAB } from '../../shared/constants';
import type { DetectionSource, MediaAsset, MediaKind } from '../../shared/types';
import {
  classifyMedia,
  extensionFromMime,
  extensionFromUrl,
  filenameFromUrl,
  mergeMediaAssets,
  stableId,
} from '../../shared/utils';
import { collectInlineSiteMedia, siteMediaRouteKey } from './site-media';

type QueryRoot = Document | ShadowRoot;

interface MediaCandidate {
  url: string;
  source: DetectionSource;
  kind?: MediaKind;
  mime?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  poster?: string;
}

export interface ScanDocumentOptions {
  frameId?: number;
  now?: () => number;
  performanceEntries?: readonly PerformanceEntry[];
  performanceSince?: number;
}

export interface MediaDetectorOptions extends ScanDocumentOptions {
  debounceMs?: number;
  /** How long Resource Timing discoveries survive without being seen again. */
  performanceTtlMs?: number;
  /** URL polling is a fallback for page-world History API calls hidden by an isolated world. */
  navigationPollMs?: number;
  onChange?: (assets: MediaAsset[]) => void;
  onDiff?: (diff: MediaAssetDiff) => void;
}

export interface MediaAssetDiff {
  assets: MediaAsset[];
  added: MediaAsset[];
  updated: MediaAsset[];
  removed: MediaAsset[];
  routeChanged: boolean;
}

function nextPerformanceBoundary(value: number): number {
  return value + Number.EPSILON * Math.max(1, Math.abs(value));
}

const OBSERVED_ATTRIBUTES = [
  'src',
  'srcset',
  'poster',
  'href',
  'style',
  'type',
  'content',
] as const;
const DOCUMENT_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_PERFORMANCE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_NAVIGATION_POLL_MS = 500;
const RELEVANT_DESCENDANT_SELECTOR = [
  'video',
  'audio',
  'source',
  'img',
  'picture',
  'script:not([src])',
  'link[href]',
  'a[href]',
  'meta[content]',
  '[style]',
].join(',');
const SITE_NAVIGATION_EVENTS = [
  // YouTube Polymer navigation lifecycle.
  'yt-navigate-finish',
  'yt-page-data-updated',
  // Events used by current and older Bilibili player shells. URL polling remains
  // the authoritative fallback because these event names are not a public API.
  'bili-page-change',
  'bili-video-switched',
  'bilibili-player-ready',
] as const;

const BLOB_FALLBACK_NAMES: Readonly<Record<MediaKind, string>> = {
  image: '待解析图片',
  video: '待解析视频',
  audio: '待解析音频',
  playlist: '待解析媒体流',
};

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function optionalPositive(value: number): number | undefined {
  return isFinitePositive(value) ? value : undefined;
}

function dataMime(url: string): string | undefined {
  if (!url.startsWith('data:')) return undefined;
  const match = /^data:([^;,]+)/i.exec(url);
  return match?.[1]?.toLowerCase();
}

export function resolveMediaUrl(rawUrl: string, baseUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (!['http:', 'https:', 'file:', 'blob:', 'data:'].includes(resolved.protocol)) {
      return undefined;
    }
    return resolved.href;
  } catch {
    return undefined;
  }
}

/** Extract every URL from a CSS image value, including multiple backgrounds. */
export function extractCssUrls(value: string): string[] {
  const urls: string[] = [];
  const expression = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/giu;
  for (const match of value.matchAll(expression)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Parse common srcset syntax without splitting commas contained by data URLs.
 * Descriptors (1x, 640w) are intentionally discarded.
 */
export function extractSrcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let cursor = 0;

  while (cursor < srcset.length) {
    while (cursor < srcset.length && /[\s,]/u.test(srcset[cursor] ?? '')) cursor += 1;
    if (cursor >= srcset.length) break;

    const start = cursor;
    const isDataUrl = srcset.slice(cursor, cursor + 5).toLowerCase() === 'data:';
    if (isDataUrl) {
      while (cursor < srcset.length && !/\s/u.test(srcset[cursor] ?? '')) cursor += 1;
    } else {
      while (cursor < srcset.length && !/[\s,]/u.test(srcset[cursor] ?? '')) cursor += 1;
    }

    const url = srcset.slice(start, cursor).trim().replace(/,$/u, '');
    if (url) urls.push(url);

    // Skip descriptors until the candidate separator.
    while (cursor < srcset.length && srcset[cursor] !== ',') cursor += 1;
    if (srcset[cursor] === ',') cursor += 1;
  }

  return urls;
}

export function collectQueryableRoots(root: QueryRoot): QueryRoot[] {
  const roots: QueryRoot[] = [root];
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) roots.push(...collectQueryableRoots(element.shadowRoot));
  }
  return roots;
}

function mediaKindForElement(element: Element): MediaKind | undefined {
  if (element instanceof HTMLImageElement) return 'image';
  if (element instanceof HTMLVideoElement) return 'video';
  if (element instanceof HTMLAudioElement) return 'audio';
  if (element instanceof HTMLSourceElement) {
    const parent = element.parentElement;
    if (parent instanceof HTMLPictureElement) return 'image';
    if (parent instanceof HTMLVideoElement) return 'video';
    if (parent instanceof HTMLAudioElement) return 'audio';
  }
  return undefined;
}

function addElementCandidates(root: QueryRoot, candidates: MediaCandidate[]): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    const width = optionalPositive(image.naturalWidth || image.width);
    const height = optionalPositive(image.naturalHeight || image.height);
    const addImage = (url: string): void => {
      candidates.push({
        url,
        source: 'dom',
        kind: 'image',
        ...(width == null ? {} : { width }),
        ...(height == null ? {} : { height }),
      });
    };
    if (image.currentSrc) addImage(image.currentSrc);
    if (image.getAttribute('src')) addImage(image.getAttribute('src')!);
    for (const url of extractSrcsetUrls(image.getAttribute('srcset') ?? '')) addImage(url);
  }

  for (const media of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
    const kind: MediaKind = media instanceof HTMLVideoElement ? 'video' : 'audio';
    const duration = optionalPositive(media.duration);
    const poster = media instanceof HTMLVideoElement && media.poster ? media.poster : undefined;
    const width =
      media instanceof HTMLVideoElement
        ? optionalPositive(media.videoWidth || media.clientWidth)
        : undefined;
    const height =
      media instanceof HTMLVideoElement
        ? optionalPositive(media.videoHeight || media.clientHeight)
        : undefined;
    const addMedia = (url: string, mime?: string): void => {
      candidates.push({
        url,
        source: 'dom',
        kind,
        ...(mime ? { mime } : {}),
        ...(duration == null ? {} : { duration }),
        ...(poster ? { poster } : {}),
        ...(width == null ? {} : { width }),
        ...(height == null ? {} : { height }),
      });
    };
    const explicitSrc = media.getAttribute('src');
    if (explicitSrc) addMedia(explicitSrc);
    if (media.currentSrc) {
      const resolvedExplicit = explicitSrc
        ? resolveMediaUrl(explicitSrc, media.baseURI)
        : undefined;
      const resolvedCurrent = resolveMediaUrl(media.currentSrc, media.baseURI);
      // During a same-element SPA switch Chromium updates the `src` attribute
      // synchronously but can retain the previous route in `currentSrc` until
      // `emptied`/`loadedmetadata`. Publishing both briefly creates exactly the
      // mixed old-video/new-video state that makes Bilibili audio pairing fail.
      // When an explicit source exists, it is the route owner's current intent;
      // accept currentSrc only when it resolves to that same resource.
      if (!explicitSrc || !resolvedExplicit || resolvedCurrent === resolvedExplicit) {
        addMedia(media.currentSrc);
      }
    }
    if (poster) candidates.push({ url: poster, source: 'dom', kind: 'image' });
  }

  for (const source of root.querySelectorAll<HTMLSourceElement>('source')) {
    const kind = mediaKindForElement(source);
    const mime = source.type || undefined;
    const addSource = (url: string): void => {
      candidates.push({
        url,
        source: 'dom',
        ...(kind ? { kind } : {}),
        ...(mime ? { mime } : {}),
      });
    };
    if (source.getAttribute('src')) addSource(source.getAttribute('src')!);
    for (const url of extractSrcsetUrls(source.getAttribute('srcset') ?? '')) addSource(url);
  }
}

function addBackgroundCandidates(
  root: QueryRoot,
  doc: Document,
  candidates: MediaCandidate[],
): void {
  const view = doc.defaultView;
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    const values = new Set<string>();
    const inlineValue = element.style.backgroundImage;
    if (inlineValue) values.add(inlineValue);
    if (view) {
      try {
        const computedValue = view.getComputedStyle(element).backgroundImage;
        if (computedValue && computedValue !== 'none') values.add(computedValue);
      } catch {
        // Detached or browser-owned elements may not expose computed styles.
      }
    }
    for (const value of values) {
      for (const url of extractCssUrls(value)) {
        candidates.push({ url, source: 'dom', kind: 'image' });
      }
    }
  }
}

function addLinkCandidates(root: QueryRoot, candidates: MediaCandidate[]): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement | HTMLLinkElement>(
    'a[href], link[href]',
  )) {
    const rawUrl = link.getAttribute('href');
    if (!rawUrl) continue;
    const mime = link.getAttribute('type') || undefined;
    let kind = classifyMedia(link.href || rawUrl, mime ?? '');
    if (!kind && link instanceof HTMLLinkElement) {
      const as = link.as.toLowerCase();
      if (as === 'image' || as === 'video' || as === 'audio') kind = as;
    }
    if (!kind) continue;
    candidates.push({
      url: rawUrl,
      source: 'link',
      kind,
      ...(mime ? { mime } : {}),
    });
  }

  const mediaMetaSelectors = [
    'meta[property="og:image"]',
    'meta[property="og:video"]',
    'meta[property="og:audio"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:player:stream"]',
  ].join(',');
  for (const meta of root.querySelectorAll<HTMLMetaElement>(mediaMetaSelectors)) {
    const url = meta.content;
    if (!url) continue;
    const label = `${meta.getAttribute('property') ?? ''} ${meta.name}`.toLowerCase();
    const kind: MediaKind =
      label.includes('video') || label.includes('player')
        ? 'video'
        : label.includes('audio')
          ? 'audio'
          : 'image';
    candidates.push({ url, source: 'link', kind });
  }
}

function kindFromInitiator(entry: PerformanceEntry): MediaKind | undefined {
  const initiator =
    'initiatorType' in entry && typeof entry.initiatorType === 'string'
      ? entry.initiatorType.toLowerCase()
      : '';
  if (initiator === 'img' || initiator === 'image') return 'image';
  if (initiator === 'video') return 'video';
  if (initiator === 'audio') return 'audio';
  return undefined;
}

function sizeFromPerformanceEntry(entry: PerformanceEntry): number | undefined {
  if (!('encodedBodySize' in entry) || typeof entry.encodedBodySize !== 'number') return undefined;
  return optionalPositive(entry.encodedBodySize);
}

function addPerformanceCandidates(
  entries: readonly PerformanceEntry[],
  candidates: MediaCandidate[],
  minimumStartTime = 0,
): void {
  for (const entry of entries) {
    if (entry.startTime < minimumStartTime) continue;
    if (!entry.name) continue;
    const kind = classifyMedia(entry.name) ?? kindFromInitiator(entry);
    if (!kind) continue;
    const size = sizeFromPerformanceEntry(entry);
    candidates.push({
      url: entry.name,
      source: 'performance',
      kind,
      ...(size == null ? {} : { size }),
    });
  }
}

function candidateToAsset(
  candidate: MediaCandidate,
  doc: Document,
  frameId: number,
  discoveredAt: number,
): MediaAsset | undefined {
  const url = resolveMediaUrl(candidate.url, doc.baseURI || doc.URL);
  if (!url) return undefined;
  const mime = candidate.mime ?? dataMime(url);
  const classifiedKind = classifyMedia(url, mime ?? '');
  if (
    (candidate.kind === 'video' || candidate.kind === 'audio') &&
    !classifiedKind &&
    DOCUMENT_EXTENSIONS.has(extensionFromUrl(url) ?? '')
  ) {
    return undefined;
  }
  const kind = classifiedKind === 'playlist' ? classifiedKind : (candidate.kind ?? classifiedKind);
  if (!kind) return undefined;
  const extension = extensionFromMime(mime) ?? extensionFromUrl(url);
  const fallbackName = `foxfetch-${kind}-${stableId(url)}`;
  const filename = url.startsWith('blob:')
    ? BLOB_FALLBACK_NAMES[kind]
    : filenameFromUrl(url, fallbackName);

  return {
    id: stableId(`${kind}:${url}`),
    url,
    pageUrl: doc.URL,
    pageTitle: doc.title || '当前页面',
    frameId,
    kind,
    detectedBy: [candidate.source],
    ...(mime ? { mime } : {}),
    ...(extension ? { extension } : {}),
    filename,
    ...(candidate.width == null ? {} : { width: candidate.width }),
    ...(candidate.height == null ? {} : { height: candidate.height }),
    ...(candidate.duration == null ? {} : { duration: candidate.duration }),
    ...(candidate.size == null ? {} : { size: candidate.size }),
    ...(candidate.poster
      ? {
          poster: resolveMediaUrl(candidate.poster, doc.baseURI || doc.URL) ?? candidate.poster,
        }
      : {}),
    downloadable: !url.startsWith('blob:'),
    ...(kind === 'video' && candidate.source === 'dom' && url.startsWith('blob:')
      ? { presentationRole: 'unresolved-video' as const }
      : {}),
    discoveredAt,
  };
}

export function scanDocument(
  doc: Document = document,
  options: ScanDocumentOptions = {},
): MediaAsset[] {
  const candidates: MediaCandidate[] = [];
  const roots = collectQueryableRoots(doc);
  for (const root of roots) {
    addElementCandidates(root, candidates);
    addBackgroundCandidates(root, doc, candidates);
    addLinkCandidates(root, candidates);
  }
  candidates.push(...collectInlineSiteMedia(doc));

  const entries =
    options.performanceEntries ?? doc.defaultView?.performance.getEntriesByType('resource') ?? [];
  addPerformanceCandidates(entries, candidates, options.performanceSince);

  const now = options.now ?? Date.now;
  const assets = new Map<string, MediaAsset>();
  for (const candidate of candidates) {
    const asset = candidateToAsset(candidate, doc, options.frameId ?? 0, now());
    if (!asset) continue;
    const previous = assets.get(asset.id);
    assets.set(asset.id, previous ? mergeMediaAssets(previous, asset) : asset);
    if (assets.size >= MAX_ASSETS_PER_TAB) break;
  }
  return [...assets.values()].sort((left, right) => right.discoveredAt - left.discoveredAt);
}

export const scanMedia = scanDocument;

interface TrackedPerformanceAsset {
  asset: MediaAsset;
  expiresAt: number;
  routeKey: string;
}

function assetSignature(asset: MediaAsset): string {
  return JSON.stringify({
    ...asset,
    detectedBy: [...asset.detectedBy].sort(),
  });
}

function nodeContainsRelevantMedia(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(RELEVANT_DESCENDANT_SELECTOR) ||
    Boolean(node.querySelector(RELEVANT_DESCENDANT_SELECTOR))
  );
}

function mutationMayChangeMedia(record: MutationRecord): boolean {
  if (record.type === 'attributes') return true;
  // SPA players commonly update <title> after the URL and player source have
  // already changed. The page title is part of every AgentSnapshot, so treating
  // it as snapshot data keeps the popup, side panel and cache filename aligned
  // with the video that is actually playing.
  if (record.target instanceof Element && record.target.matches('title')) return true;
  if (record.target instanceof Element && record.target.matches(RELEVANT_DESCENDANT_SELECTOR)) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) =>
      nodeContainsRelevantMedia(node) ||
      (node instanceof Element && (node.matches('title') || Boolean(node.querySelector('title')))),
  );
}

function performanceEntryKey(entry: PerformanceEntry): string {
  const initiator =
    'initiatorType' in entry && typeof entry.initiatorType === 'string' ? entry.initiatorType : '';
  return [entry.entryType, entry.name, entry.startTime, entry.duration, initiator].join('\u0000');
}

function firstEntryStartTime(entries: readonly PerformanceEntry[]): number | undefined {
  return entries
    .map((entry) => entry.startTime)
    .filter(Number.isFinite)
    .reduce<number | undefined>(
      (minimum, startTime) => (minimum == null ? startTime : Math.min(minimum, startTime)),
      undefined,
    );
}

export class MediaDetector {
  private readonly registry = new Map<string, MediaAsset>();
  private readonly pageSnapshot = new Map<string, MediaAsset>();
  private readonly performanceAssets = new Map<string, TrackedPerformanceAsset>();
  // Only keys at the current Resource Timing watermark are retained. This avoids
  // an unbounded Set on long segmented streams while still accepting two entries
  // that share the same startTime.
  private readonly seenPerformanceEntries = new Map<string, number>();
  private readonly emittedSnapshot = new Map<string, MediaAsset>();
  private readonly observers = new Map<QueryRoot, MutationObserver>();
  private performanceObserver: PerformanceObserver | undefined;
  private timer: number | undefined;
  private performanceExpiryTimer: number | undefined;
  private navigationPollTimer: number | undefined;
  private started = false;
  private lastDocumentUrl: string;
  private routeKey: string;
  private pendingRouteChange = false;
  private hasEmitted = false;
  private emittedPageUrl = '';
  private emittedPageTitle = '';
  private performanceSince = 0;
  private performanceWatermark = 0;
  private historyTarget: History | undefined;
  private originalPushState: History['pushState'] | undefined;
  private originalReplaceState: History['replaceState'] | undefined;
  private pushStateWrapper: History['pushState'] | undefined;
  private replaceStateWrapper: History['replaceState'] | undefined;

  constructor(
    private readonly doc: Document = document,
    private readonly options: MediaDetectorOptions = {},
  ) {
    this.lastDocumentUrl = doc.URL;
    this.routeKey = siteMediaRouteKey(doc.URL);
    this.performanceSince = options.performanceSince ?? 0;
  }

  start(): MediaAsset[] {
    if (!this.started) {
      this.started = true;
      this.observeRoots();
      this.observePerformance();
      this.observeNavigation();
    }
    return this.scanNow();
  }

  scanNow(): MediaAsset[] {
    this.synchronizeNavigation();
    this.observeRoots();
    // DOM/link/manifest discoveries are a replaceable snapshot. Performance
    // discoveries live in a separate TTL registry so removing a DOM element does
    // not accidentally make a just-observed network request disappear.
    const pageAssets = scanDocument(this.doc, {
      ...(this.options.frameId == null ? {} : { frameId: this.options.frameId }),
      ...(this.options.now ? { now: this.options.now } : {}),
      performanceEntries: [],
    });
    this.pageSnapshot.clear();
    for (const asset of pageAssets) this.pageSnapshot.set(asset.id, asset);

    const performanceEntries =
      this.options.performanceEntries ??
      this.doc.defaultView?.performance.getEntriesByType('resource') ??
      [];
    this.ingestPerformanceEntries(performanceEntries);
    this.trackPerformanceEntries(performanceEntries);
    this.prunePerformanceAssets();
    this.rebuildRegistry();
    const assets = this.getAssets();
    this.emitIfChanged();
    this.schedulePerformanceExpiry();
    return assets;
  }

  rescan(): MediaAsset[] {
    return this.scanNow();
  }

  /** Reset route-scoped discoveries while preserving the current document's timing origin. */
  markNavigation(): void {
    this.synchronizeNavigation();
    this.scheduleScan();
  }

  /**
   * Start a fresh discovery generation when the active player changes without a
   * URL/route change. Resource Timing is document-scoped, so its buffer still
   * contains the previous video's requests unless we advance an explicit
   * boundary here. DOM and inline-manifest assets are rebuilt immediately from
   * the current page; only ambiguous pre-boundary performance entries are
   * discarded.
   */
  resetForMediaChange(): MediaAsset[] {
    const view = this.doc.defaultView;
    if (this.timer != null) {
      view?.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.performanceExpiryTimer != null) {
      view?.clearTimeout(this.performanceExpiryTimer);
      this.performanceExpiryTimer = undefined;
    }

    this.registry.clear();
    this.pageSnapshot.clear();
    this.performanceAssets.clear();
    this.seenPerformanceEntries.clear();

    const currentTiming = view?.performance.now();
    const boundary = Math.max(
      this.performanceWatermark,
      typeof currentTiming === 'number' && Number.isFinite(currentTiming) ? currentTiming : 0,
    );
    this.performanceWatermark = boundary;
    this.performanceSince = nextPerformanceBoundary(boundary);
    return this.scanNow();
  }

  getAssets(): MediaAsset[] {
    return [...this.registry.values()]
      .sort((left, right) => right.discoveredAt - left.discoveredAt)
      .slice(0, MAX_ASSETS_PER_TAB);
  }

  stop(): void {
    this.started = false;
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    this.performanceObserver?.disconnect();
    this.performanceObserver = undefined;
    if (this.timer != null) {
      this.doc.defaultView?.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.performanceExpiryTimer != null) {
      this.doc.defaultView?.clearTimeout(this.performanceExpiryTimer);
      this.performanceExpiryTimer = undefined;
    }
    if (this.navigationPollTimer != null) {
      this.doc.defaultView?.clearInterval(this.navigationPollTimer);
      this.navigationPollTimer = undefined;
    }
    this.stopObservingNavigation();
  }

  private getNow(): number {
    return (this.options.now ?? Date.now)();
  }

  private rebuildRegistry(): void {
    const fresh = new Map<string, MediaAsset>();
    const combine = (asset: MediaAsset): void => {
      const current = fresh.get(asset.id);
      fresh.set(asset.id, current ? mergeMediaAssets(current, asset) : asset);
    };
    for (const asset of this.pageSnapshot.values()) combine(asset);
    for (const tracked of this.performanceAssets.values()) combine(tracked.asset);

    const retained = [...fresh.values()]
      .map((asset) => {
        const previous = this.registry.get(asset.id);
        if (!previous) return asset;
        const merged = mergeMediaAssets(previous, asset);
        // mergeMediaAssets deliberately retains provenance. A replaceable detector
        // snapshot instead reports only the sources that are currently alive.
        return {
          ...merged,
          pageUrl: asset.pageUrl,
          pageTitle: asset.pageTitle,
          detectedBy: asset.detectedBy,
          discoveredAt: previous.discoveredAt,
        };
      })
      .sort(
        (left, right) => right.discoveredAt - left.discoveredAt || left.id.localeCompare(right.id),
      )
      .slice(0, MAX_ASSETS_PER_TAB);

    this.registry.clear();
    for (const asset of retained) this.registry.set(asset.id, asset);
  }

  private emitIfChanged(): void {
    const assets = this.getAssets();
    const added: MediaAsset[] = [];
    const updated: MediaAsset[] = [];
    const removed: MediaAsset[] = [];

    for (const asset of assets) {
      const previous = this.emittedSnapshot.get(asset.id);
      if (!previous) added.push(asset);
      else if (assetSignature(previous) !== assetSignature(asset)) updated.push(asset);
    }
    for (const previous of this.emittedSnapshot.values()) {
      if (!this.registry.has(previous.id)) removed.push(previous);
    }

    const changed =
      !this.hasEmitted ||
      this.pendingRouteChange ||
      this.emittedPageUrl !== this.doc.URL ||
      this.emittedPageTitle !== this.doc.title ||
      added.length > 0 ||
      updated.length > 0 ||
      removed.length > 0;
    if (!changed) return;

    const routeChanged = this.pendingRouteChange;
    this.pendingRouteChange = false;
    this.hasEmitted = true;
    this.emittedPageUrl = this.doc.URL;
    this.emittedPageTitle = this.doc.title;
    this.emittedSnapshot.clear();
    for (const asset of assets) this.emittedSnapshot.set(asset.id, asset);
    this.options.onChange?.(assets);
    this.options.onDiff?.({ assets, added, updated, removed, routeChanged });
  }

  private scheduleScan(): void {
    const view = this.doc.defaultView;
    if (!view || this.timer != null) return;
    this.timer = view.setTimeout(() => {
      this.timer = undefined;
      if (this.started) this.scanNow();
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private observeRoots(): void {
    if (!this.started) return;
    const roots = new Set(collectQueryableRoots(this.doc));
    for (const [root, observer] of this.observers) {
      if (roots.has(root)) continue;
      observer.disconnect();
      this.observers.delete(root);
    }
    for (const root of roots) {
      if (this.observers.has(root)) continue;
      const Observer = this.doc.defaultView?.MutationObserver ?? MutationObserver;
      const observer = new Observer((records) => {
        if (records.some(mutationMayChangeMedia)) this.scheduleScan();
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: [...OBSERVED_ATTRIBUTES],
        childList: true,
        subtree: true,
      });
      this.observers.set(root, observer);
    }
  }

  private ingestPerformanceEntries(entries: readonly PerformanceEntry[]): boolean {
    const now = this.getNow();
    const ttl = Math.max(1, this.options.performanceTtlMs ?? DEFAULT_PERFORMANCE_TTL_MS);
    const timingBoundary = Math.max(this.performanceSince, this.performanceWatermark);
    let changed = false;
    for (const entry of entries) {
      if (entry.startTime < timingBoundary || !entry.name) continue;
      const entryKey = performanceEntryKey(entry);
      if (this.seenPerformanceEntries.has(entryKey)) continue;
      this.seenPerformanceEntries.set(entryKey, entry.startTime);

      const candidates: MediaCandidate[] = [];
      addPerformanceCandidates([entry], candidates, this.performanceSince);
      for (const candidate of candidates) {
        const asset = candidateToAsset(candidate, this.doc, this.options.frameId ?? 0, now);
        if (!asset) continue;
        const previous = this.performanceAssets.get(asset.id);
        this.performanceAssets.set(asset.id, {
          asset: previous ? mergeMediaAssets(previous.asset, asset) : asset,
          expiresAt: now + ttl,
          routeKey: this.routeKey,
        });
        changed = true;
      }
    }

    if (this.performanceAssets.size > MAX_ASSETS_PER_TAB) {
      const retained = [...this.performanceAssets.values()]
        .sort(
          (left, right) =>
            right.asset.discoveredAt - left.asset.discoveredAt || right.expiresAt - left.expiresAt,
        )
        .slice(0, MAX_ASSETS_PER_TAB);
      this.performanceAssets.clear();
      for (const tracked of retained) this.performanceAssets.set(tracked.asset.id, tracked);
    }
    return changed;
  }

  private prunePerformanceAssets(): void {
    const now = this.getNow();
    for (const [id, tracked] of this.performanceAssets) {
      if (tracked.routeKey !== this.routeKey || tracked.expiresAt <= now) {
        this.performanceAssets.delete(id);
      }
    }
  }

  private schedulePerformanceExpiry(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    if (this.performanceExpiryTimer != null) {
      view.clearTimeout(this.performanceExpiryTimer);
      this.performanceExpiryTimer = undefined;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const tracked of this.performanceAssets.values()) {
      nearest = Math.min(nearest, tracked.expiresAt);
    }
    if (!Number.isFinite(nearest)) return;
    const delay = Math.max(1, Math.min(2_147_483_647, nearest - this.getNow()));
    this.performanceExpiryTimer = view.setTimeout(() => {
      this.performanceExpiryTimer = undefined;
      if (!this.started) return;
      this.prunePerformanceAssets();
      this.rebuildRegistry();
      this.emitIfChanged();
      this.schedulePerformanceExpiry();
    }, delay);
  }

  private observePerformance(): void {
    const Observer = this.doc.defaultView?.PerformanceObserver;
    if (!Observer) return;
    try {
      this.performanceObserver = new Observer((list) => {
        const entries = list.getEntries();
        const routeChanged = this.synchronizeNavigation(entries);
        const performanceChanged = this.ingestPerformanceEntries(entries);
        this.trackPerformanceEntries(entries);
        this.prunePerformanceAssets();
        this.rebuildRegistry();
        // PerformanceObserver callbacks can be extremely bursty on segmented
        // streams. Coalesce them with DOM mutations into one snapshot scan.
        if (routeChanged || performanceChanged) this.scheduleScan();
      });
      try {
        this.performanceObserver.observe({ type: 'resource', buffered: true });
      } catch {
        this.performanceObserver.observe({ entryTypes: ['resource'] });
      }
    } catch {
      this.performanceObserver?.disconnect();
      this.performanceObserver = undefined;
    }
  }

  private trackPerformanceEntries(entries: readonly PerformanceEntry[]): void {
    for (const entry of entries) {
      if (Number.isFinite(entry.startTime)) {
        this.performanceWatermark = Math.max(this.performanceWatermark, entry.startTime);
      }
    }
    for (const [key, startTime] of this.seenPerformanceEntries) {
      if (startTime < this.performanceWatermark) this.seenPerformanceEntries.delete(key);
    }
  }

  private synchronizeNavigation(entries?: readonly PerformanceEntry[]): boolean {
    const nextUrl = this.doc.URL;
    const nextRouteKey = siteMediaRouteKey(nextUrl);
    const routeChanged = nextRouteKey !== this.routeKey;
    if (!routeChanged && nextUrl === this.lastDocumentUrl) return false;

    this.lastDocumentUrl = nextUrl;
    if (!routeChanged) return false;

    this.registry.clear();
    this.pageSnapshot.clear();
    this.performanceAssets.clear();
    this.seenPerformanceEntries.clear();
    this.routeKey = nextRouteKey;
    this.pendingRouteChange = true;
    const firstCurrentEntry = entries ? firstEntryStartTime(entries) : undefined;
    // When the observer is the first code to notice an SPA URL change, its entries are
    // already older than performance.now(). Use the first entry as the inclusive cutoff.
    this.performanceSince = firstCurrentEntry ?? nextPerformanceBoundary(this.performanceWatermark);
    return true;
  }

  private readonly handleNavigationSignal = (): void => {
    this.synchronizeNavigation();
    this.scheduleScan();
  };

  private readonly pollNavigation = (): void => {
    // Page-world History API calls may be invisible to an isolated extension
    // world. Poll only the cheap URL string and never rescan an unchanged page.
    if (this.doc.URL === this.lastDocumentUrl) return;
    this.synchronizeNavigation();
    this.scheduleScan();
  };

  private readonly handleMediaLifecycle = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.matches('video, audio, source')) this.scheduleScan();
  };

  private observeNavigation(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    view.addEventListener('popstate', this.handleNavigationSignal);
    view.addEventListener('hashchange', this.handleNavigationSignal);
    for (const eventName of SITE_NAVIGATION_EVENTS) {
      this.doc.addEventListener(eventName, this.handleNavigationSignal);
    }
    this.doc.addEventListener('loadedmetadata', this.handleMediaLifecycle, true);
    this.doc.addEventListener('durationchange', this.handleMediaLifecycle, true);
    this.doc.addEventListener('emptied', this.handleMediaLifecycle, true);

    this.historyTarget = view.history;
    try {
      const original = this.historyTarget.pushState;
      const wrapper: History['pushState'] = (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void => {
        original.call(this.historyTarget, data, unused, url);
        this.handleNavigationSignal();
      };
      this.originalPushState = original;
      this.pushStateWrapper = wrapper;
      this.historyTarget.pushState = wrapper;
    } catch {
      this.originalPushState = undefined;
      this.pushStateWrapper = undefined;
    }
    try {
      const original = this.historyTarget.replaceState;
      const wrapper: History['replaceState'] = (
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void => {
        original.call(this.historyTarget, data, unused, url);
        this.handleNavigationSignal();
      };
      this.originalReplaceState = original;
      this.replaceStateWrapper = wrapper;
      this.historyTarget.replaceState = wrapper;
    } catch {
      this.originalReplaceState = undefined;
      this.replaceStateWrapper = undefined;
    }

    this.navigationPollTimer = view.setInterval(
      this.pollNavigation,
      Math.max(100, this.options.navigationPollMs ?? DEFAULT_NAVIGATION_POLL_MS),
    );
  }

  private stopObservingNavigation(): void {
    const view = this.doc.defaultView;
    if (view) {
      view.removeEventListener('popstate', this.handleNavigationSignal);
      view.removeEventListener('hashchange', this.handleNavigationSignal);
    }
    for (const eventName of SITE_NAVIGATION_EVENTS) {
      this.doc.removeEventListener(eventName, this.handleNavigationSignal);
    }
    this.doc.removeEventListener('loadedmetadata', this.handleMediaLifecycle, true);
    this.doc.removeEventListener('durationchange', this.handleMediaLifecycle, true);
    this.doc.removeEventListener('emptied', this.handleMediaLifecycle, true);

    if (this.historyTarget) {
      try {
        if (
          this.pushStateWrapper &&
          this.originalPushState &&
          this.historyTarget.pushState === this.pushStateWrapper
        ) {
          this.historyTarget.pushState = this.originalPushState;
        }
      } catch {
        // Another isolated-world script may own the current wrapper.
      }
      try {
        if (
          this.replaceStateWrapper &&
          this.originalReplaceState &&
          this.historyTarget.replaceState === this.replaceStateWrapper
        ) {
          this.historyTarget.replaceState = this.originalReplaceState;
        }
      } catch {
        // Another isolated-world script may own the current wrapper.
      }
    }
    this.historyTarget = undefined;
    this.originalPushState = undefined;
    this.originalReplaceState = undefined;
    this.pushStateWrapper = undefined;
    this.replaceStateWrapper = undefined;
  }
}
