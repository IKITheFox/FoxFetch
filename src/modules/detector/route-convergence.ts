import { siteMediaRouteKey } from './site-media';
import type { TabMediaState } from '../../shared/types';

const GENERATION_COUNTER_HEADROOM = 1_000_000;

/** Reserve sub-millisecond counter space while staying below MAX_SAFE_INTEGER. */
export function safeWorkerGenerationBase(nowMs = Date.now()): number {
  const boundedNow = Math.max(
    0,
    Math.min(
      Math.floor(nowMs),
      Math.floor((Number.MAX_SAFE_INTEGER - GENERATION_COUNTER_HEADROOM) / 1_000),
    ),
  );
  return boundedNow * 1_000;
}

export function nextWorkerGeneration(base: number, current: number, offset: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(current + 1, base + offset));
}

export function rebaseSameMediaRouteState(
  state: TabMediaState,
  pageUrl: string,
  pageTitle: string,
): TabMediaState {
  const previousRouteKey = siteMediaRouteKey(state.pageUrl);
  const assets = state.assets.map((asset) =>
    siteMediaRouteKey(asset.pageUrl) === previousRouteKey
      ? { ...asset, pageUrl, pageTitle }
      : asset,
  );
  return {
    ...state,
    pageUrl,
    pageTitle,
    assets,
    ...(state.activeMedia
      ? {
          activeMedia: {
            ...state.activeMedia,
            routeKey: siteMediaRouteKey(pageUrl),
          },
        }
      : {}),
  };
}

export type RouteGenerationSource = 'tabs' | 'agent' | 'read';

export interface RouteGenerationMarker {
  routeKey: string;
  pageUrl: string;
  epoch: number;
  awaitingAgent: boolean;
  /** Bound the tabs -> Agent half-pair so a missing Agent cannot poison a later reload. */
  awaitingAgentUntil?: number;
  /** Brief one-shot window for the inverse Agent -> tabs event ordering. */
  awaitingTabsUntil?: number;
  /**
   * A tabs URL edge can be followed by Agent confirmation and then a separate
   * status=loading notification for that same History transition. Keep one
   * document-bound slot for that trailing notification only.
   */
  awaitingTrailingTabsUntil?: number;
  /**
   * A URL-led cross-route transition is provisional until the live Agent
   * proves that the old document performed an SPA switch or Chrome exposes a
   * new current document. The latter finalizes this already-allocated epoch;
   * it must not allocate a second generation for the same navigation.
   */
  provisionalDocumentId?: string;
  documentId?: string;
}

export interface RouteGenerationObservation {
  pageUrl: string;
  source: RouteGenerationSource;
  documentNavigation?: boolean;
  urlChanged?: boolean;
  documentId?: string;
  now?: number;
}

export interface RouteGenerationClaim {
  marker: RouteGenerationMarker;
  advanced: boolean;
  sameMediaRoute: boolean;
  pairedSpaTransition: boolean;
}

export function seedRouteGeneration(
  pageUrl: string,
  epoch: number,
  documentId?: string,
): RouteGenerationMarker {
  return {
    routeKey: siteMediaRouteKey(pageUrl),
    pageUrl,
    epoch,
    awaitingAgent: false,
    ...(documentId ? { documentId } : {}),
  };
}

/** Seed a generation that was first proven by a new current document. Chrome
 * may publish the matching tabs URL/loading half afterwards. */
export function seedDocumentReplacementRouteGeneration(
  pageUrl: string,
  epoch: number,
  documentId: string,
  now = Date.now(),
): RouteGenerationMarker {
  return {
    ...seedRouteGeneration(pageUrl, epoch, documentId),
    awaitingTabsUntil: now + 750,
  };
}

/**
 * Bind a committed state/snapshot to the current route generation without
 * erasing the pending Agent↔tabs pairing flags. Returns undefined when the
 * commit belongs to a route or epoch that has already been superseded.
 */
export function bindRouteGenerationCommit(
  previous: RouteGenerationMarker | undefined,
  pageUrl: string,
  epoch: number,
  documentId?: string,
): RouteGenerationMarker | undefined {
  if (!previous) return seedRouteGeneration(pageUrl, epoch, documentId);
  if (previous.routeKey !== siteMediaRouteKey(pageUrl) || previous.epoch !== epoch) {
    return undefined;
  }
  if (documentId && previous.documentId && previous.documentId !== documentId) {
    return undefined;
  }
  return {
    ...previous,
    pageUrl,
    ...(documentId && !previous.documentId ? { documentId } : {}),
  };
}

/**
 * Finalize a URL-led route generation when Chrome later proves that the
 * transition replaced the top document. The generation was already allocated
 * by tabs.onUpdated, so only its document binding changes.
 */
export function finalizeProvisionalDocumentReplacement(
  previous: RouteGenerationMarker | undefined,
  pageUrl: string,
  previousDocumentId: string,
  nextDocumentId: string,
  now = Date.now(),
): RouteGenerationMarker | undefined {
  if (
    !previous ||
    previous.routeKey !== siteMediaRouteKey(pageUrl) ||
    previous.provisionalDocumentId !== previousDocumentId ||
    previous.documentId !== previousDocumentId ||
    nextDocumentId === previousDocumentId
  ) {
    return undefined;
  }
  const settled = { ...previous };
  delete settled.awaitingAgentUntil;
  delete settled.awaitingTabsUntil;
  delete settled.awaitingTrailingTabsUntil;
  delete settled.provisionalDocumentId;
  return {
    ...settled,
    pageUrl,
    awaitingAgent: false,
    // Chrome can split one tabs URL/loading update around document_start.
    // The new document finalizes the route, while this one-shot slot absorbs
    // a loading half that was queued before READY but delivered afterwards.
    awaitingTrailingTabsUntil: now + 750,
    documentId: nextDocumentId,
  };
}

/** Clear provisional replacement state when Chrome proves the same document
 * is currently executing on the target route (for example executeScript after
 * a read-led worker wake-up). */
export function confirmProvisionalSameDocument(
  previous: RouteGenerationMarker | undefined,
  pageUrl: string,
  documentId: string,
  now = Date.now(),
): RouteGenerationMarker | undefined {
  if (
    !previous ||
    previous.routeKey !== siteMediaRouteKey(pageUrl) ||
    previous.documentId !== documentId ||
    previous.provisionalDocumentId !== documentId
  ) {
    return undefined;
  }
  const settled = { ...previous };
  delete settled.awaitingAgentUntil;
  delete settled.provisionalDocumentId;
  return {
    ...settled,
    pageUrl,
    awaitingAgent: false,
    awaitingTrailingTabsUntil: now + 750,
  };
}

/**
 * Collapse the browser and in-page halves of one SPA transition into one
 * generation. Chrome may report a History API switch as `loading` before the
 * still-live Agent reports the same route. The Agent claim therefore consumes
 * the browser claim instead of advancing the generation a second time.
 */
export function claimRouteGeneration(
  previous: RouteGenerationMarker | undefined,
  observation: RouteGenerationObservation,
  currentEpoch: number,
): RouteGenerationClaim {
  const now = observation.now ?? Date.now();
  const routeKey = siteMediaRouteKey(observation.pageUrl);
  const sameMediaRoute = previous?.routeKey === routeKey;
  const sameDocumentUrlHalf = Boolean(
    previous &&
    sameMediaRoute &&
    observation.source === 'tabs' &&
    observation.urlChanged &&
    previous.pageUrl !== observation.pageUrl &&
    previous.documentId != null &&
    observation.documentId === previous.documentId,
  );
  const pendingAgentIsLive = Boolean(
    previous?.awaitingAgent &&
    previous.awaitingAgentUntil != null &&
    previous.awaitingAgentUntil >= now,
  );
  const duplicatePendingDocumentNavigation = Boolean(
    previous &&
    pendingAgentIsLive &&
    observation.source === 'tabs' &&
    observation.documentNavigation &&
    previous.pageUrl === observation.pageUrl,
  );
  const inversePendingNavigation = Boolean(
    previous &&
    sameMediaRoute &&
    observation.source === 'tabs' &&
    (observation.urlChanged || observation.documentNavigation) &&
    previous.awaitingTabsUntil != null &&
    previous.awaitingTabsUntil >= now &&
    previous.pageUrl === observation.pageUrl &&
    previous.documentId != null &&
    observation.documentId === previous.documentId,
  );
  const trailingPendingNavigation = Boolean(
    previous &&
    sameMediaRoute &&
    observation.source === 'tabs' &&
    (observation.urlChanged || observation.documentNavigation) &&
    previous.awaitingTrailingTabsUntil != null &&
    previous.awaitingTrailingTabsUntil >= now &&
    previous.pageUrl === observation.pageUrl &&
    previous.documentId != null &&
    observation.documentId === previous.documentId,
  );
  const agentConfirmedTabsSpa = Boolean(
    previous &&
    pendingAgentIsLive &&
    sameMediaRoute &&
    observation.source === 'agent' &&
    previous.documentId != null &&
    observation.documentId === previous.documentId,
  );

  const advanced =
    previous == null ||
    !sameMediaRoute ||
    (observation.source === 'tabs' &&
      observation.documentNavigation === true &&
      !duplicatePendingDocumentNavigation &&
      !inversePendingNavigation &&
      !trailingPendingNavigation &&
      !sameDocumentUrlHalf);
  const epoch = advanced ? currentEpoch + 1 : currentEpoch;
  const awaitingAgent =
    observation.source === 'agent'
      ? false
      : advanced || duplicatePendingDocumentNavigation
        ? true
        : pendingAgentIsLive;
  const awaitingAgentUntil =
    observation.source === 'agent'
      ? undefined
      : advanced
        ? now + 750
        : duplicatePendingDocumentNavigation
          ? previous?.awaitingAgentUntil
          : pendingAgentIsLive
            ? previous?.awaitingAgentUntil
            : undefined;
  const documentId =
    observation.documentId ??
    (advanced && observation.documentNavigation && !duplicatePendingDocumentNavigation
      ? undefined
      : previous?.documentId);
  const awaitingTabsUntil =
    observation.source === 'agent' && advanced
      ? now + 750
      : inversePendingNavigation
        ? undefined
        : previous?.awaitingTabsUntil != null && previous.awaitingTabsUntil >= now
          ? previous.awaitingTabsUntil
          : undefined;
  const awaitingTrailingTabsUntil =
    agentConfirmedTabsSpa || inversePendingNavigation || sameDocumentUrlHalf
      ? now + 750
      : trailingPendingNavigation
        ? undefined
        : previous?.awaitingTrailingTabsUntil != null && previous.awaitingTrailingTabsUntil >= now
          ? previous.awaitingTrailingTabsUntil
          : undefined;
  const provisionalDocumentId = advanced
    ? (observation.source === 'tabs' || observation.source === 'read') &&
      observation.documentNavigation !== true &&
      observation.documentId
      ? observation.documentId
      : undefined
    : agentConfirmedTabsSpa
      ? undefined
      : previous?.provisionalDocumentId;

  return {
    advanced,
    sameMediaRoute,
    pairedSpaTransition:
      duplicatePendingDocumentNavigation ||
      inversePendingNavigation ||
      trailingPendingNavigation ||
      sameDocumentUrlHalf,
    marker: {
      routeKey,
      pageUrl: observation.pageUrl,
      epoch,
      awaitingAgent,
      ...(awaitingAgentUntil == null ? {} : { awaitingAgentUntil }),
      ...(awaitingTabsUntil == null ? {} : { awaitingTabsUntil }),
      ...(awaitingTrailingTabsUntil == null ? {} : { awaitingTrailingTabsUntil }),
      ...(provisionalDocumentId ? { provisionalDocumentId } : {}),
      ...(documentId ? { documentId } : {}),
    },
  };
}

interface GenerationTaskFlight<T> {
  generation: number | string;
  current: Promise<T>;
  hasQueuedRefresh: boolean;
}

export interface GenerationAwareTaskQueueOptions {
  /** Bound work that can hang in an unresponsive subframe. */
  timeoutMs?: number;
  /** Explicit refreshes supersede, rather than queue behind, an active pass. */
  forceStartsFresh?: boolean;
}

export class GenerationTaskTimeoutError extends Error {
  constructor() {
    super('媒体扫描超时，已废弃本次结果');
    this.name = 'GenerationTaskTimeoutError';
  }
}

/**
 * Same-generation automatic work is coalesced and one explicit refresh may be
 * queued. A new generation always starts independently instead of joining the
 * promise that belongs to the previous page.
 */
export class GenerationAwareTaskQueue<T> {
  private flight: GenerationTaskFlight<T> | undefined;

  constructor(private readonly options: GenerationAwareTaskQueueOptions = {}) {}

  run(generation: number | string, force: boolean, operation: () => Promise<T>): Promise<T> {
    const existing = this.flight;
    if (existing?.generation === generation) {
      if (force && this.options.forceStartsFresh) {
        return this.start(generation, operation);
      }
      if (!force || existing.hasQueuedRefresh) return existing.current;
      existing.hasQueuedRefresh = true;
      const queued = existing.current
        .catch(() => undefined)
        .then(() => this.withTimeout(operation));
      existing.current = queued;
      this.cleanAfter(queued, existing);
      return queued;
    }

    return this.start(generation, operation);
  }

  private start(generation: number | string, operation: () => Promise<T>): Promise<T> {
    const current = Promise.resolve().then(() => this.withTimeout(operation));
    const flight: GenerationTaskFlight<T> = {
      generation,
      current,
      hasQueuedRefresh: false,
    };
    this.flight = flight;
    this.cleanAfter(current, flight);
    return current;
  }

  clear(): void {
    this.flight = undefined;
  }

  private cleanAfter(promise: Promise<T>, flight: GenerationTaskFlight<T>): void {
    void promise.then(
      () => {
        if (this.flight === flight && flight.current === promise) this.flight = undefined;
      },
      () => {
        if (this.flight === flight && flight.current === promise) this.flight = undefined;
      },
    );
  }

  private withTimeout(operation: () => Promise<T>): Promise<T> {
    const timeoutMs = this.options.timeoutMs;
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GenerationTaskTimeoutError()), timeoutMs);
      void operation().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
