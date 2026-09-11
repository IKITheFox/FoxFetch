import { DEFAULT_SETTINGS } from '../../shared/constants';
import type {
  ActiveMediaFingerprint,
  MediaElementInfo,
  PlaybackCommand,
  PlaybackCommandResult,
  PlaybackSettings,
} from '../../shared/types';
import { clampRate, stableId } from '../../shared/utils';
import { collectQueryableRoots } from '../detector';
import { siteMediaRouteKey } from '../detector/site-media';
import { isYouTubePage } from '../youtube/inspection';
import {
  TemporaryTransport,
  type TemporaryTransportDirection,
  type TemporaryTransportResult,
} from './temporary-transport';

interface TrackedMedia {
  elementId: string;
  lifecycleGeneration: number;
  sourceIdentity: string;
  /** Route on which this DOM/source lifecycle was admitted. */
  ownerRouteKey: string;
  /** Route session on which this DOM/source lifecycle was admitted. */
  ownerRouteGeneration: number;
  awaitingMetadata: boolean;
  /** A fresh post-route MediaSource object URL is safe to bind before it contains metadata. */
  preMetadataRouteAdmission: boolean;
  /** Last fully settled lifecycle that may have raced just before a route edge. */
  lastSettledLifecycleAt: number;
  lastSettledLifecycleGeneration: number;
  lastSettledLifecycleRouteGeneration: number;
  lastActiveAt: number;
  lastTimeUpdateAt: number;
  lockWindowStartedAt: number;
  lockCorrections: number;
  correctionTimer: number | undefined;
  listeners: Array<{ type: string; listener: EventListener }>;
}

const PRE_ROUTE_LIFECYCLE_CONFIRM_WINDOW_MS = 2_500;

export function createActiveMediaFingerprint(
  pageUrl: string,
  mediaEpoch: number,
  media: MediaElementInfo,
): ActiveMediaFingerprint {
  return {
    routeKey: siteMediaRouteKey(pageUrl),
    mediaEpoch,
    elementId: media.elementId,
    lifecycleGeneration: media.lifecycleGeneration,
    frameId: media.frameId,
    kind: media.kind,
    title: media.title,
    ...(media.sourceUrl ? { sourceUrl: media.sourceUrl } : {}),
    ...(media.duration == null ? {} : { duration: media.duration }),
    ...(media.width == null ? {} : { width: media.width }),
    ...(media.height == null ? {} : { height: media.height }),
  };
}

export function activeMediaIdentityKey(media: ActiveMediaFingerprint): string {
  return [
    media.routeKey,
    media.frameId,
    media.kind,
    media.elementId,
    media.lifecycleGeneration,
    media.sourceUrl ?? '',
  ].join('\u0000');
}

export function sameActiveMediaIdentity(
  left: ActiveMediaFingerprint | undefined,
  right: ActiveMediaFingerprint | undefined,
  includeEpoch = true,
): boolean {
  if (!left || !right) return left === right;
  return (
    (!includeEpoch || left.mediaEpoch === right.mediaEpoch) &&
    activeMediaIdentityKey(left) === activeMediaIdentityKey(right)
  );
}

export interface PlaybackManagerOptions {
  settings?: Partial<PlaybackSettings>;
  frameId?: number;
  now?: () => number;
  onChange?: (elements: MediaElementInfo[]) => void;
  onShowController?: () => void;
  onToggleController?: () => void;
}

function isManagerOptions(
  value: PlaybackManagerOptions | Partial<PlaybackSettings>,
): value is PlaybackManagerOptions {
  return (
    'settings' in value ||
    'frameId' in value ||
    'now' in value ||
    'onChange' in value ||
    'onShowController' in value ||
    'onToggleController' in value
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function resolvedUrl(rawUrl: string, doc: Document): string | undefined {
  if (!rawUrl) return undefined;
  try {
    return new URL(rawUrl, doc.baseURI || doc.URL).href;
  } catch {
    return rawUrl;
  }
}

export function visibleArea(element: Element, view: Window): number {
  const rect = element.getBoundingClientRect();
  const viewportWidth = Math.max(0, view.innerWidth || view.document.documentElement.clientWidth);
  const viewportHeight = Math.max(
    0,
    view.innerHeight || view.document.documentElement.clientHeight,
  );
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return Math.round(width * height);
}

function setPreservesPitch(media: HTMLMediaElement, enabled: boolean): void {
  const compatible = media as HTMLMediaElement & {
    webkitPreservesPitch?: boolean;
    mozPreservesPitch?: boolean;
  };
  try {
    compatible.preservesPitch = enabled;
  } catch {
    // Older engines may expose a read-only standard property.
  }
  try {
    if ('webkitPreservesPitch' in compatible) compatible.webkitPreservesPitch = enabled;
    if ('mozPreservesPitch' in compatible) compatible.mozPreservesPitch = enabled;
  } catch {
    // Vendor aliases are best-effort fallbacks.
  }
}

export class PlaybackManager {
  // Synchronous layout reads can load unrelated page CSS images and attribute
  // their mixed-content warnings to this extension. Browser observations avoid
  // forcing layout from the frequently polled playback snapshot.
  private geometryObserver: IntersectionObserver | undefined;
  private sizeObserver: ResizeObserver | undefined;
  private readonly geometry = new WeakMap<
    Element,
    { width: number; height: number; area: number }
  >();
  private readonly tracked = new Map<HTMLMediaElement, TrackedMedia>();
  private readonly desiredRates = new WeakMap<HTMLMediaElement, number>();
  private readonly observers = new Map<Document | ShadowRoot, MutationObserver>();
  private settings: PlaybackSettings;
  private started = false;
  private refreshTimer: number | undefined;
  private emitTimer: number | undefined;
  private sequence = 0;
  private readonly options: PlaybackManagerOptions;
  private routeKey: string;
  private routeGeneration = 0;
  private awaitingRouteGeneration: number | undefined;
  private temporaryTransport: TemporaryTransport | undefined;

  constructor(
    private readonly doc: Document = document,
    options: PlaybackManagerOptions | Partial<PlaybackSettings> = {},
  ) {
    this.options = isManagerOptions(options) ? options : { settings: options };
    this.routeKey = siteMediaRouteKey(this.doc.URL);
    this.settings = {
      ...DEFAULT_SETTINGS.playback,
      ...this.options.settings,
      defaultRate: clampRate(
        this.options.settings?.defaultRate ?? DEFAULT_SETTINGS.playback.defaultRate,
      ),
    };
  }

  start(): MediaElementInfo[] {
    if (!this.started) {
      this.started = true;
      this.observeRoots();
      this.doc.defaultView?.addEventListener('resize', this.handleViewportChange, {
        passive: true,
      });
      this.doc.defaultView?.addEventListener('scroll', this.handleViewportChange, {
        capture: true,
        passive: true,
      });
    }
    return this.refresh();
  }

  stop(): void {
    void this.endTemporaryTransport();
    this.started = false;
    this.geometryObserver?.disconnect();
    this.sizeObserver?.disconnect();
    this.geometryObserver = undefined;
    this.sizeObserver = undefined;
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    for (const media of [...this.tracked.keys()]) this.detach(media);
    const view = this.doc.defaultView;
    view?.removeEventListener('resize', this.handleViewportChange);
    view?.removeEventListener('scroll', this.handleViewportChange, true);
    if (this.refreshTimer != null) view?.clearTimeout(this.refreshTimer);
    if (this.emitTimer != null) view?.clearTimeout(this.emitTimer);
    this.refreshTimer = undefined;
    this.emitTimer = undefined;
  }

  refresh(): MediaElementInfo[] {
    this.synchronizeRouteBoundary();
    this.observeRoots();
    const present = new Set<HTMLMediaElement>();
    for (const root of collectQueryableRoots(this.doc)) {
      for (const media of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
        present.add(media);
        if (!this.tracked.has(media)) this.attach(media);
        else this.synchronizeMediaIdentity(media, this.tracked.get(media)!);
      }
    }
    for (const media of this.tracked.keys()) {
      if (!present.has(media)) this.detach(media);
    }
    const elements = this.getMediaElements();
    this.options.onChange?.(elements);
    return elements;
  }

  getMediaElements(): MediaElementInfo[] {
    const youtubePlayer = isYouTubePage(this.doc.URL)
      ? this.doc.getElementById('movie_player')
      : null;
    if (
      youtubePlayer?.classList.contains('ad-showing') ||
      youtubePlayer?.classList.contains('ad-interrupting')
    )
      return [];
    const view = this.doc.defaultView;
    if (!view) return [];
    this.synchronizeRouteBoundary();
    const currentEntries = [...this.tracked.entries()].filter(([, tracked]) =>
      this.isOwnedByCurrentRoute(tracked),
    );
    const awaitingCurrentRoute = this.awaitingRouteGeneration === this.routeGeneration;
    const admittedEntries = awaitingCurrentRoute
      ? currentEntries.filter(
          ([, tracked]) => !tracked.awaitingMetadata || tracked.preMetadataRouteAdmission,
        )
      : currentEntries;

    // During an SPA switch, an old player can remain visible for several
    // seconds. Visibility is not evidence that it belongs to the new route.
    // Leave the route empty until a new node is attached or the reused node
    // completes a real post-route lifecycle/source/metadata transition.
    if (awaitingCurrentRoute) {
      if (admittedEntries.length === 0) return [];
      this.awaitingRouteGeneration = undefined;
    }

    return admittedEntries
      .filter(([media]) => !youtubePlayer || youtubePlayer.contains(media))
      .map(([media, tracked]) => this.toInfo(media, tracked, view))
      .sort((left, right) => {
        return (
          right.visibleArea - left.visibleArea ||
          (left.paused !== right.paused ? (left.paused ? 1 : -1) : 0) ||
          right.lastActiveAt - left.lastActiveAt
        );
      });
  }

  /**
   * Start a same-document route handoff without assigning retained media to the
   * destination route. Duplicate observations for the same route are harmless.
   */
  beginRouteTransition(pageUrl = this.doc.URL): boolean {
    return this.synchronizeRouteBoundary(pageUrl);
  }

  isAwaitingRoutePlayer(): boolean {
    this.synchronizeRouteBoundary();
    return this.awaitingRouteGeneration === this.routeGeneration;
  }

  /**
   * Bilibili can settle a reused player's new source immediately before its
   * History route changes. A current-route BVID/CID manifest is the extra proof
   * required to admit that recent lifecycle; visibility alone never calls this.
   */
  confirmCurrentRoutePlayerFromManifest(maxAgeMs = PRE_ROUTE_LIFECYCLE_CONFIRM_WINDOW_MS): boolean {
    this.synchronizeRouteBoundary();
    if (this.awaitingRouteGeneration !== this.routeGeneration) return false;
    const now = this.now();
    const view = this.doc.defaultView;
    const candidate = [...this.tracked.entries()]
      .filter(([, tracked]) => {
        return (
          !tracked.awaitingMetadata &&
          tracked.lastSettledLifecycleGeneration === tracked.lifecycleGeneration &&
          tracked.lastSettledLifecycleRouteGeneration === this.routeGeneration - 1 &&
          tracked.lastSettledLifecycleAt > 0 &&
          now - tracked.lastSettledLifecycleAt >= 0 &&
          now - tracked.lastSettledLifecycleAt <= Math.max(0, maxAgeMs)
        );
      })
      .sort(([leftMedia, left], [rightMedia, right]) => {
        const areaDifference = view
          ? this.mediaGeometry(rightMedia, view).area - this.mediaGeometry(leftMedia, view).area
          : 0;
        return areaDifference || right.lastSettledLifecycleAt - left.lastSettledLifecycleAt;
      })[0];
    if (!candidate) return false;
    this.admitToCurrentRoute(candidate[1]);
    candidate[1].lastActiveAt = now;
    return true;
  }

  getState(): MediaElementInfo[] {
    return this.getMediaElements();
  }

  getSettings(): PlaybackSettings {
    return { ...this.settings };
  }

  isNearEnd(elementId?: string, toleranceSeconds = 2): boolean {
    const media = this.selectTarget(elementId);
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return false;
    const tolerance = Math.max(0.25, toleranceSeconds);
    return media.ended || media.currentTime >= Math.max(0, media.duration - tolerance);
  }

  /**
   * Resolve the exact tracked DOM node behind a sanitized controller entry.
   *
   * Cache auto-advance protection binds to both the opaque element id and its
   * lifecycle generation so a long-lived SPA cannot accidentally carry a
   * terminal playback lock into the next video that reuses the same element.
   */
  getControlledMediaElement(
    elementId?: string,
    lifecycleGeneration?: number,
  ): HTMLMediaElement | undefined {
    const media = this.selectTarget(elementId);
    if (!media) return undefined;
    const tracked = this.tracked.get(media);
    if (
      !tracked ||
      (lifecycleGeneration != null && tracked.lifecycleGeneration !== lifecycleGeneration)
    ) {
      return undefined;
    }
    return media;
  }

  applySettings(settings: PlaybackSettings | Partial<PlaybackSettings>): MediaElementInfo[] {
    void this.endTemporaryTransport();
    this.settings = {
      ...this.settings,
      ...settings,
      defaultRate: clampRate(settings.defaultRate ?? this.settings.defaultRate),
    };
    for (const media of this.tracked.keys()) {
      setPreservesPitch(media, this.settings.preservesPitch);
      // A global preference applies to future media, not the current user's rate.
      if (this.settings.lockRate)
        this.applyRate(media, this.desiredRates.get(media) ?? media.playbackRate);
    }
    return this.emitNow();
  }

  async execute(command: PlaybackCommand, elementId?: string): Promise<PlaybackCommandResult> {
    if (command.action === 'showController') {
      this.options.onShowController?.();
      return { applied: this.options.onShowController != null };
    }
    if (command.action === 'toggleController') {
      this.options.onToggleController?.();
      return { applied: true };
    }

    // Restoration is synchronous; no late play() completion may overwrite
    // this explicit command. A slider choice always wins over a hold lease.
    void this.endTemporaryTransport();

    const media = this.selectTarget(elementId);
    if (!media) return { applied: false };
    const tracked = this.tracked.get(media);
    if (tracked) tracked.lastActiveAt = this.now();

    switch (command.action) {
      case 'setRate': {
        if (command.lockRate != null) this.settings.lockRate = command.lockRate;
        if (command.preservesPitch != null) {
          this.settings.preservesPitch = command.preservesPitch;
        }
        const rate = clampRate(command.rate);
        this.desiredRates.set(media, rate);
        setPreservesPitch(media, this.settings.preservesPitch);
        const applied = this.applyRate(media, rate);
        this.emitNow();
        return { applied, actualRate: media.playbackRate };
      }
      case 'adjustRate': {
        const current = this.desiredRates.get(media) ?? finiteOr(media.playbackRate, 1);
        const rate = clampRate(current + command.delta);
        this.desiredRates.set(media, rate);
        setPreservesPitch(media, this.settings.preservesPitch);
        const applied = this.applyRate(media, rate);
        this.emitNow();
        return { applied, actualRate: media.playbackRate };
      }
      case 'resetRate': {
        this.desiredRates.set(media, 1);
        const applied = this.applyRate(media, 1);
        this.emitNow();
        return { applied, actualRate: media.playbackRate };
      }
      case 'togglePlay': {
        try {
          if (media.paused) {
            const playResult = media.play();
            if (playResult) await playResult;
          } else {
            media.pause();
          }
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'pause': {
        try {
          // Idempotent by design. Cache completion can race a delayed media
          // snapshot, so this must never turn an already-paused player back on.
          if (!media.paused) media.pause();
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'seekBy': {
        try {
          const maximum = Number.isFinite(media.duration) ? Math.max(0, media.duration) : Infinity;
          media.currentTime = Math.min(maximum, Math.max(0, media.currentTime + command.seconds));
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'seekTo': {
        try {
          const maximum = Number.isFinite(media.duration) ? Math.max(0, media.duration) : Infinity;
          if (command.pause && !media.paused) media.pause();
          media.currentTime = Math.min(maximum, Math.max(0, command.seconds));
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'seekToBufferedEnd': {
        try {
          if (media.buffered.length === 0)
            return { applied: false, actualRate: media.playbackRate };
          let bufferedEnd = 0;
          for (let index = 0; index < media.buffered.length; index += 1) {
            bufferedEnd = Math.max(bufferedEnd, media.buffered.end(index));
          }
          const duration = Number.isFinite(media.duration)
            ? Math.max(0, media.duration)
            : bufferedEnd;
          const safetyMargin = Math.max(0, command.safetyMargin ?? 0.2);
          const target = Math.max(0, Math.min(duration, bufferedEnd) - safetyMargin);
          if (!Number.isFinite(target) || target <= media.currentTime + 0.05) {
            return { applied: false, actualRate: media.playbackRate };
          }
          media.currentTime = target;
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'setVolume': {
        try {
          media.volume = Math.min(1, Math.max(0, command.volume));
          this.emitNow();
          return { applied: true, actualRate: media.playbackRate };
        } catch {
          return { applied: false, actualRate: media.playbackRate };
        }
      }
      case 'toggleMute': {
        media.muted = !media.muted;
        this.emitNow();
        return { applied: true, actualRate: media.playbackRate };
      }
      case 'togglePictureInPicture': {
        const applied = await this.togglePictureInPicture(media);
        this.emitNow();
        return { applied, actualRate: media.playbackRate };
      }
    }
  }

  async executeCommand(
    command: PlaybackCommand,
    elementId?: string,
  ): Promise<PlaybackCommandResult> {
    return this.execute(command, elementId);
  }

  async beginTemporaryTransport(
    direction: TemporaryTransportDirection,
    elementId?: string,
  ): Promise<TemporaryTransportResult> {
    void this.endTemporaryTransport();
    const media = this.selectTarget(elementId);
    const tracked = media ? this.tracked.get(media) : undefined;
    if (!media || !tracked || !media.isConnected) {
      return { applied: false, reason: '尚未找到当前可控制的视频。' };
    }
    const lifecycleGeneration = tracked.lifecycleGeneration;
    const routeGeneration = this.routeGeneration;
    const routeKey = this.routeKey;
    const sourceIdentity = this.mediaSourceIdentity(media);
    if (tracked.correctionTimer != null) {
      this.doc.defaultView?.clearTimeout(tracked.correctionTimer);
      tracked.correctionTimer = undefined;
    }
    const transport = new TemporaryTransport(media, direction, {
      isCurrent: () =>
        media.isConnected &&
        this.tracked.get(media) === tracked &&
        tracked.lifecycleGeneration === lifecycleGeneration &&
        this.routeGeneration === routeGeneration &&
        this.routeKey === routeKey &&
        siteMediaRouteKey(this.doc.URL) === routeKey &&
        this.mediaSourceIdentity(media) === sourceIdentity,
      ...(this.options.now ? { now: this.options.now } : {}),
      onChange: () => this.scheduleEmit(),
      onInvalidated: () => {
        if (this.temporaryTransport === transport) this.temporaryTransport = undefined;
        this.scheduleEmit();
      },
    });
    // Claim the slot before play() can yield, including before ratechange.
    this.temporaryTransport = transport;
    const result = await transport.start();
    if (!result.applied && this.temporaryTransport === transport) {
      this.temporaryTransport = undefined;
    }
    return result;
  }

  async endTemporaryTransport(options: { restore?: boolean } = {}): Promise<void> {
    const transport = this.temporaryTransport;
    if (!transport) return;
    // Keep ownership during synchronous rate restoration so lockRate cannot
    // enqueue a competing correction for the original actual rate.
    transport.end(options);
    if (this.temporaryTransport === transport) this.temporaryTransport = undefined;
  }

  hasTemporaryTransport(): boolean {
    return this.temporaryTransport?.isActive() ?? false;
  }

  private readonly handleViewportChange = (): void => {
    this.scheduleEmit();
  };

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private attach(media: HTMLMediaElement): void {
    const tracked: TrackedMedia = {
      elementId: `foxfetch-media-${stableId(`${this.doc.URL}:${media.tagName}:${this.sequence++}`)}`,
      lifecycleGeneration: 1,
      sourceIdentity: this.mediaSourceIdentity(media),
      ownerRouteKey: this.routeKey,
      ownerRouteGeneration: this.routeGeneration,
      awaitingMetadata: false,
      preMetadataRouteAdmission: false,
      lastSettledLifecycleAt: 0,
      lastSettledLifecycleGeneration: 0,
      lastSettledLifecycleRouteGeneration: -1,
      lastActiveAt: this.now(),
      lastTimeUpdateAt: 0,
      lockWindowStartedAt: 0,
      lockCorrections: 0,
      correctionTimer: undefined,
      listeners: [],
    };
    this.tracked.set(media, tracked);
    this.desiredRates.set(media, this.settings.defaultRate);
    setPreservesPitch(media, this.settings.preservesPitch);
    if (this.settings.defaultRate !== 1 || this.settings.lockRate) {
      this.applyRate(media, this.settings.defaultRate);
    }

    const activeEvents = [
      'play',
      'playing',
      'pause',
      'ended',
      'error',
      'seeking',
      'seeked',
      'volumechange',
    ];
    for (const type of activeEvents) {
      this.listen(media, tracked, type, () => {
        tracked.lastActiveAt = this.now();
        this.scheduleEmit();
      });
    }
    const beginMediaLifecycle = (): void => {
      this.synchronizeRouteBoundary();
      if (!tracked.awaitingMetadata) tracked.lifecycleGeneration += 1;
      const sourceIdentity = this.mediaSourceIdentity(media);
      const sourceChanged = Boolean(sourceIdentity && sourceIdentity !== tracked.sourceIdentity);
      // Browsers commonly clear currentSrc between `emptied` and
      // `loadedmetadata`. Keep the last non-empty identity so the refresh that
      // runs in between does not count the same lifecycle twice.
      if (sourceIdentity) tracked.sourceIdentity = sourceIdentity;
      this.admitToCurrentRoute(tracked);
      tracked.awaitingMetadata = true;
      tracked.preMetadataRouteAdmission =
        this.awaitingRouteGeneration === this.routeGeneration &&
        sourceChanged &&
        sourceIdentity.startsWith('blob:');
      this.scheduleEmit();
    };
    this.listen(media, tracked, 'emptied', beginMediaLifecycle);
    this.listen(media, tracked, 'loadstart', beginMediaLifecycle);
    this.listen(media, tracked, 'loadedmetadata', () => {
      this.synchronizeRouteBoundary();
      const sourceIdentity = this.mediaSourceIdentity(media);
      let lifecycleSettled = tracked.awaitingMetadata;
      if (tracked.awaitingMetadata) {
        if (sourceIdentity) tracked.sourceIdentity = sourceIdentity;
      } else {
        const sourceChanged = sourceIdentity !== tracked.sourceIdentity;
        if (!this.isOwnedByCurrentRoute(tracked) || sourceChanged) {
          tracked.lifecycleGeneration += 1;
          lifecycleSettled = true;
        }
        tracked.sourceIdentity = sourceIdentity;
      }
      this.admitToCurrentRoute(tracked);
      tracked.awaitingMetadata = false;
      tracked.preMetadataRouteAdmission = false;
      if (lifecycleSettled) {
        tracked.lastSettledLifecycleAt = this.now();
        tracked.lastSettledLifecycleGeneration = tracked.lifecycleGeneration;
        tracked.lastSettledLifecycleRouteGeneration = this.routeGeneration;
      }
      this.scheduleEmit();
    });
    for (const type of ['durationchange', 'enterpictureinpicture', 'leavepictureinpicture']) {
      this.listen(media, tracked, type, () => this.scheduleEmit());
    }
    this.listen(media, tracked, 'timeupdate', () => {
      const current = this.now();
      if (current - tracked.lastTimeUpdateAt < 250) return;
      tracked.lastTimeUpdateAt = current;
      this.scheduleEmit();
    });
    this.listen(media, tracked, 'ratechange', () => {
      tracked.lastActiveAt = this.now();
      this.correctLockedRate(media, tracked);
      this.scheduleEmit();
    });
    this.listen(media, tracked, 'pointerdown', () => {
      tracked.lastActiveAt = this.now();
      this.scheduleEmit();
    });
  }

  private detach(media: HTMLMediaElement): void {
    this.geometryObserver?.unobserve(media);
    this.sizeObserver?.unobserve(media);
    this.geometry.delete(media);
    if (this.temporaryTransport?.media === media) {
      void this.endTemporaryTransport({ restore: false });
    }
    const tracked = this.tracked.get(media);
    if (!tracked) return;
    for (const { type, listener } of tracked.listeners) {
      media.removeEventListener(type, listener);
    }
    if (tracked.correctionTimer != null) {
      this.doc.defaultView?.clearTimeout(tracked.correctionTimer);
    }
    this.tracked.delete(media);
  }

  private mediaSourceIdentity(media: HTMLMediaElement): string {
    return resolvedUrl(media.currentSrc || media.getAttribute('src') || '', this.doc) ?? '';
  }

  private synchronizeMediaIdentity(media: HTMLMediaElement, tracked: TrackedMedia): void {
    this.synchronizeRouteBoundary();
    const sourceIdentity = this.mediaSourceIdentity(media);
    if (tracked.awaitingMetadata) {
      // `emptied` already advanced the lifecycle. Only remember a resolved
      // non-empty source here; loadedmetadata will commit the final identity.
      const sourceChanged = Boolean(sourceIdentity && sourceIdentity !== tracked.sourceIdentity);
      if (sourceIdentity) tracked.sourceIdentity = sourceIdentity;
      if (
        this.awaitingRouteGeneration === this.routeGeneration &&
        sourceChanged &&
        sourceIdentity.startsWith('blob:')
      ) {
        tracked.preMetadataRouteAdmission = true;
        this.admitToCurrentRoute(tracked);
      }
      return;
    }
    if (sourceIdentity === tracked.sourceIdentity) return;
    const previousSourceIdentity = tracked.sourceIdentity;
    tracked.sourceIdentity = sourceIdentity;
    tracked.lifecycleGeneration += 1;
    this.admitToCurrentRoute(tracked);
    tracked.awaitingMetadata = true;
    tracked.preMetadataRouteAdmission =
      this.awaitingRouteGeneration === this.routeGeneration &&
      Boolean(sourceIdentity) &&
      sourceIdentity !== previousSourceIdentity &&
      sourceIdentity.startsWith('blob:');
  }

  private synchronizeRouteBoundary(pageUrl = this.doc.URL): boolean {
    const nextRouteKey = siteMediaRouteKey(pageUrl);
    if (nextRouteKey === this.routeKey) return false;
    void this.endTemporaryTransport({ restore: false });
    this.routeKey = nextRouteKey;
    this.routeGeneration += 1;
    this.awaitingRouteGeneration = this.routeGeneration;
    for (const tracked of this.tracked.values()) tracked.preMetadataRouteAdmission = false;
    return true;
  }

  private admitToCurrentRoute(tracked: TrackedMedia): void {
    tracked.ownerRouteKey = this.routeKey;
    tracked.ownerRouteGeneration = this.routeGeneration;
  }

  private isOwnedByCurrentRoute(tracked: TrackedMedia): boolean {
    return (
      tracked.ownerRouteKey === this.routeKey &&
      tracked.ownerRouteGeneration === this.routeGeneration
    );
  }

  private listen(
    media: HTMLMediaElement,
    tracked: TrackedMedia,
    type: string,
    callback: () => void,
  ): void {
    const listener: EventListener = () => callback();
    media.addEventListener(type, listener);
    tracked.listeners.push({ type, listener });
  }

  private observeRoots(): void {
    if (!this.started) return;
    for (const root of collectQueryableRoots(this.doc)) {
      if (this.observers.has(root)) continue;
      const Observer = this.doc.defaultView?.MutationObserver ?? MutationObserver;
      const observer = new Observer(() => this.scheduleRefresh());
      observer.observe(root, {
        attributes: true,
        attributeFilter: ['src', 'poster'],
        childList: true,
        subtree: true,
      });
      this.observers.set(root, observer);
    }
  }

  private scheduleRefresh(): void {
    const view = this.doc.defaultView;
    if (!view || this.refreshTimer != null) return;
    this.refreshTimer = view.setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.started) this.refresh();
    }, 30);
  }

  private scheduleEmit(): void {
    const view = this.doc.defaultView;
    if (!view || this.emitTimer != null) return;
    this.emitTimer = view.setTimeout(() => {
      this.emitTimer = undefined;
      if (this.started) this.emitNow();
    }, 30);
  }

  private emitNow(): MediaElementInfo[] {
    const elements = this.getMediaElements();
    this.options.onChange?.(elements);
    return elements;
  }

  private applyRate(media: HTMLMediaElement, rate: number): boolean {
    const clamped = clampRate(rate);
    this.desiredRates.set(media, clamped);
    try {
      media.defaultPlaybackRate = clamped;
    } catch {
      // Some media implementations reject extreme default rates but accept playbackRate.
    }
    try {
      media.playbackRate = clamped;
    } catch {
      return false;
    }
    return Math.abs(media.playbackRate - clamped) < 0.001;
  }

  private correctLockedRate(media: HTMLMediaElement, tracked: TrackedMedia): void {
    if (!this.settings.lockRate) return;
    if (this.temporaryTransport?.media === media) return;
    const desired = this.desiredRates.get(media) ?? this.settings.defaultRate;
    if (Math.abs(media.playbackRate - desired) < 0.001 || tracked.correctionTimer != null) return;

    const current = this.now();
    if (current - tracked.lockWindowStartedAt >= 1_000) {
      tracked.lockWindowStartedAt = current;
      tracked.lockCorrections = 0;
    }
    // Prevent hostile pages from creating an unbounded synchronous ratechange loop.
    if (tracked.lockCorrections >= 12) return;
    tracked.lockCorrections += 1;
    const view = this.doc.defaultView;
    if (!view) return;
    tracked.correctionTimer = view.setTimeout(() => {
      tracked.correctionTimer = undefined;
      if (
        this.tracked.has(media) &&
        this.settings.lockRate &&
        this.temporaryTransport?.media !== media
      )
        this.applyRate(media, desired);
    }, 0);
  }

  private selectTarget(elementId?: string): HTMLMediaElement | undefined {
    this.synchronizeRouteBoundary();
    if (elementId) {
      for (const [media, tracked] of this.tracked) {
        if (tracked.elementId === elementId && this.isOwnedByCurrentRoute(tracked)) return media;
      }
      return undefined;
    }

    const pipElement = (this.doc as Document & { pictureInPictureElement?: Element | null })
      .pictureInPictureElement;
    if (
      pipElement instanceof HTMLMediaElement &&
      this.tracked.get(pipElement) != null &&
      this.isOwnedByCurrentRoute(this.tracked.get(pipElement)!)
    ) {
      return pipElement;
    }

    const view = this.doc.defaultView;
    return [...this.tracked.entries()]
      .filter(([, tracked]) => this.isOwnedByCurrentRoute(tracked))
      .sort(([leftMedia, left], [rightMedia, right]) => {
        if (view) {
          const visibleDifference =
            this.mediaGeometry(rightMedia, view).area - this.mediaGeometry(leftMedia, view).area;
          if (visibleDifference !== 0) return visibleDifference;
        }
        if (leftMedia.paused !== rightMedia.paused) return leftMedia.paused ? 1 : -1;
        return right.lastActiveAt - left.lastActiveAt;
      })[0]?.[0];
  }

  private toInfo(media: HTMLMediaElement, tracked: TrackedMedia, view: Window): MediaElementInfo {
    const isVideo = media instanceof HTMLVideoElement;
    const sourceUrl = resolvedUrl(media.currentSrc || media.getAttribute('src') || '', this.doc);
    const duration =
      Number.isFinite(media.duration) && media.duration >= 0 ? media.duration : undefined;
    const rect = this.mediaGeometry(media, view);
    const width = isVideo
      ? finiteOr(media.videoWidth, 0) || finiteOr(rect.width, 0) || undefined
      : finiteOr(rect.width, 0) || undefined;
    const height = isVideo
      ? finiteOr(media.videoHeight, 0) || finiteOr(rect.height, 0) || undefined
      : finiteOr(rect.height, 0) || undefined;
    const poster = isVideo ? resolvedUrl(media.getAttribute('poster') ?? '', this.doc) : undefined;

    return {
      elementId: tracked.elementId,
      lifecycleGeneration: tracked.lifecycleGeneration,
      frameId: this.options.frameId ?? 0,
      kind: isVideo ? 'video' : 'audio',
      title:
        media.getAttribute('aria-label') ||
        media.getAttribute('title') ||
        this.doc.title ||
        (isVideo ? '视频' : '音频'),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(poster ? { poster } : {}),
      ...(duration == null ? {} : { duration }),
      currentTime: Math.max(0, finiteOr(media.currentTime, 0)),
      playbackRate: finiteOr(media.playbackRate, 1),
      volume: Math.min(1, Math.max(0, finiteOr(media.volume, 1))),
      muted: media.muted,
      ended: media.ended,
      paused: media.paused,
      ...(width == null ? {} : { width }),
      ...(height == null ? {} : { height }),
      visibleArea: rect.area,
      lastActiveAt: tracked.lastActiveAt,
    };
  }

  private mediaGeometry(media: HTMLMediaElement, view: Window) {
    const Observer = this.doc.defaultView?.IntersectionObserver;
    // Legacy engines/test DOMs without observation retain their existing path.
    if (!Observer) {
      const rect = media.getBoundingClientRect();
      return { width: rect.width, height: rect.height, area: visibleArea(media, view) };
    }
    const previous = this.geometry.get(media);
    if (previous) return previous;
    if (!this.geometryObserver) {
      this.geometryObserver = new Observer(
        (entries) => {
          for (const entry of entries) {
            if (!this.tracked.has(entry.target as HTMLMediaElement)) continue;
            this.geometry.set(entry.target, {
              width: entry.boundingClientRect.width,
              height: entry.boundingClientRect.height,
              area: entry.isIntersecting
                ? Math.round(entry.intersectionRect.width * entry.intersectionRect.height)
                : 0,
            });
          }
          this.scheduleEmit();
        },
        { threshold: Array.from({ length: 101 }, (_, index) => index / 100) },
      );
      const SizeObserver = this.doc.defaultView?.ResizeObserver;
      if (SizeObserver)
        this.sizeObserver = new SizeObserver((entries) => {
          for (const entry of entries) {
            // Reobserve resized media to obtain an updated viewport intersection,
            // even when its intersection ratio remains exactly one.
            if (!this.tracked.has(entry.target as HTMLMediaElement)) continue;
            this.geometryObserver?.unobserve(entry.target);
            this.geometryObserver?.observe(entry.target);
          }
        });
    }
    const initial = { width: 0, height: 0, area: 0 };
    this.geometry.set(media, initial);
    this.geometryObserver.observe(media);
    this.sizeObserver?.observe(media);
    return initial;
  }

  private async togglePictureInPicture(media: HTMLMediaElement): Promise<boolean> {
    if (!(media instanceof HTMLVideoElement)) return false;
    const pipDocument = this.doc as Document & {
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    const pipVideo = media as HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
    };
    try {
      if (pipDocument.pictureInPictureElement === media) {
        if (!pipDocument.exitPictureInPicture) return false;
        await pipDocument.exitPictureInPicture();
        return true;
      }
      if (media.disablePictureInPicture || !pipVideo.requestPictureInPicture) return false;
      if (pipDocument.pictureInPictureElement && pipDocument.exitPictureInPicture) {
        await pipDocument.exitPictureInPicture();
      }
      await pipVideo.requestPictureInPicture();
      return true;
    } catch {
      return false;
    }
  }
}
