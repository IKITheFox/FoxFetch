import { DEFAULT_SETTINGS } from '../shared/constants';
import { isYouTubePage } from '../modules/youtube/inspection';
import { shouldAcceptMergeDockView } from '../shared/merge-dock-state';
import type {
  ActiveMediaFingerprint,
  AgentEvent,
  AgentRequest,
  AgentSnapshot,
  ApiResponse,
  AppSettings,
  MediaDockProductDownloadMode,
  MediaDockResourceSnapshot,
  MediaElementInfo,
  MergeDockAction,
  MergeDockPathChoice,
  MergeDockView,
  MediaProductDownloadResult,
  PlaybackCommandResult,
} from '../shared/types';
import { mergeDeepSettings } from '../shared/utils';
import { readBoundMediaArtwork } from '../modules/media-products/media-artwork';
import { acceptMediaArtworkIdentity } from '../modules/media-products/media-artwork-identity';
import { isSupportedMediaVideoPage, MediaDetector, siteMediaRouteKey } from '../modules/detector';
import {
  activeMediaIdentityKey,
  BILIBILI_MANIFEST_HOOK_CHECK_EVENT,
  BILIBILI_MANIFEST_READY_EVENT,
  BILIBILI_ROUTE_CHANGED_EVENT,
  bilibiliRouteChangedIdentityForCurrentRoute,
  createActiveMediaFingerprint,
  FLOATING_CONTROLLER_HOST_ID,
  FloatingPlaybackController,
  manifestReadyIdentityForCurrentRoute,
  PlaybackManager,
  sameActiveMediaIdentity,
  type FloatingControllerOptions,
  type FloatingResourceContext,
} from '../modules/playback';
import { isMainMediaAtBeginning, pollRestartAtBeginning } from '../modules/playback/restart-target';
import {
  MseCacheCaptureRuntime,
  type MseCacheMediaIdentity,
} from '../modules/resolver/mse-cache-capture';

const AGENT_GLOBAL_KEY = '__foxfetchMediaAgentV6__';
const AGENT_BUILD_ID = 'foxfetch-media-agent-v0141-async-playback-geometry';
const MANIFEST_READY_DEBOUNCE_MS = 80;
const VISIBLE_MEDIA_INTEGRITY_INTERVAL_MS = 7_500;

interface ExposedMediaAgent {
  readonly version: 6;
  readonly buildId: typeof AGENT_BUILD_ID;
  reactivate(): AgentSnapshot;
  destroy(): void;
}

type AgentGlobal = typeof globalThis & {
  [AGENT_GLOBAL_KEY]?: ExposedMediaAgent;
};

function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function failure(error: unknown): ApiResponse<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    playback: { ...DEFAULT_SETTINGS.playback },
    download: { ...DEFAULT_SETTINGS.download },
  };
}

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function isAgentRequest(message: unknown): message is AgentRequest {
  if (message == null || typeof message !== 'object' || !('type' in message)) return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === 'AGENT_READ_INLINE_IMAGE' ||
    type === 'AGENT_SCAN' ||
    type === 'AGENT_NAVIGATION' ||
    type === 'AGENT_PLAYBACK_COMMAND' ||
    type === 'AGENT_OPEN_VIDEO_VIEW' ||
    type === 'AGENT_START_MSE_CACHE_CAPTURE' ||
    type === 'AGENT_SET_MEDIA_DOCK' ||
    type === 'AGENT_OPEN_SETTINGS' ||
    type === 'AGENT_SET_MEDIA_PRODUCTS' ||
    type === 'AGENT_BIND_ARTWORK_IDENTITY' ||
    type === 'AGENT_OPEN_MERGE_DOCK' ||
    type === 'AGENT_UPDATE_MERGE_DOCK' ||
    type === 'AGENT_UPDATE_DOWNLOAD_ACTIVITY' ||
    type === 'AGENT_APPLY_SETTINGS'
  );
}

function isTransientDockSnapshot(snapshot: MediaDockResourceSnapshot): boolean {
  if (snapshot.status !== 'error') return false;
  const message = snapshot.error ?? snapshot.message ?? '';
  return /(?:stale|页面.{0,8}(?:更新|变化|切换)|媒体.{0,8}(?:更新|变化|切换)|自动更新|正在扫描|稍后再试|已过期|已失效)/iu.test(
    message,
  );
}

function resourceSnapshotSemanticKey(snapshot: MediaDockResourceSnapshot): string {
  if (snapshot.revision) return `revision:${snapshot.revision}`;
  return JSON.stringify([
    snapshot.status,
    snapshot.message ?? '',
    snapshot.error ?? '',
    snapshot.products.map((product) => [
      product.renderKey ?? '',
      product.title,
      product.domain,
      product.duration ?? null,
      product.selectedQuality ?? '',
      (product.qualities ?? []).map((quality) => [
        quality.id ?? quality.label,
        quality.label,
        quality.detail ?? '',
        quality.completeAvailable,
        quality.videoOnlyAvailable,
      ]),
      product.options.map((option) => [
        option.mode,
        option.available ?? true,
        option.label ?? '',
        option.detail ?? '',
      ]),
    ]),
  ]);
}

class MediaAgentRuntime implements ExposedMediaAgent {
  readonly version = 6 as const;
  readonly buildId = AGENT_BUILD_ID;
  private readonly artworkDocumentKey = crypto.randomUUID();
  private settings = cloneDefaultSettings();
  private controller?: FloatingPlaybackController;
  private stateTimer: number | undefined;
  private readonly detector: MediaDetector;
  private readonly playback: PlaybackManager;
  private readonly cacheCapture: MseCacheCaptureRuntime;
  private restartSeekTimer: number | undefined;
  private restartSeekGeneration = 0;
  private navigationSync: Promise<void> = Promise.resolve();
  private selectedElementId: string | undefined;
  private activeMedia: ActiveMediaFingerprint | undefined;
  private activeMediaIdentity = '';
  private awaitingPlayerRouteKey: string | undefined;
  private mediaEpoch = 0;
  private navigationEpoch = 0;
  private resourcePageIdentity: string;
  private resourceSnapshotSequence = 0;
  private resourceSnapshotKey: string | undefined;
  private lastResourcePushKey: string | undefined;
  private manifestReadyTimer: number | undefined;
  private integrityTimer: number | undefined;
  private lastResetMediaEpoch = 0;
  private routeKey: string;
  private mergeDockView?: MergeDockView;
  private artworkProviderIdentity: string | undefined;

  constructor(private readonly doc: Document = document) {
    this.routeKey = siteMediaRouteKey(doc.URL);
    this.resourcePageIdentity = this.routeKey;
    this.detector = new MediaDetector(doc, {
      onDiff: ({ routeChanged }) => {
        if (routeChanged) this.handleDetectedNavigation();
        this.scheduleState();
      },
    });
    this.playback = new PlaybackManager(doc, {
      settings: this.settings.playback,
      onChange: (elements) => {
        this.controller?.update(elements);
        // Let the controller resolve automatic-vs-explicit selection first.
        // Otherwise a retained but inactive SPA player can briefly advance the
        // epoch before the controller switches to the actually playing video.
        this.reconcileActiveMedia(elements);
        this.scheduleState();
      },
      onShowController: () => {
        this.controller?.show();
      },
      onToggleController: () => {
        this.controller?.toggle();
      },
    });
    this.cacheCapture = new MseCacheCaptureRuntime(doc, {
      themeMode: this.settings.themeMode,
      downloadSaveAs: this.settings.download.saveAs,
      onRequestStart: async () => {
        this.playback.refresh();
        const expectedMedia = this.activeMedia;
        const response = (await chrome.runtime.sendMessage({
          type: 'START_MSE_CACHE_CAPTURE',
          expectedPageUrl: this.doc.URL,
          ...(expectedMedia ? { expectedMedia } : {}),
        })) as ApiResponse<{ sessionId: string }> | undefined;
        if (!response?.ok) throw new Error(response?.error || '无法启动缓存捕获');
      },
      onRequestResetAndReload: async () => {
        const response = (await chrome.runtime.sendMessage({
          type: 'RESET_MSE_CACHE_AND_RELOAD',
        })) as ApiResponse<null> | undefined;
        if (!response?.ok) throw new Error(response?.error || '无法刷新页面并重新捕获');
      },
      shouldAutoDownload: () => this.playback.isNearEnd(this.controller?.getSelectedElementId()),
    });
  }

  start(): AgentSnapshot {
    if (isTopFrame()) {
      this.doc.defaultView?.addEventListener(
        BILIBILI_MANIFEST_READY_EVENT,
        this.handleManifestReady,
      );
      this.doc.defaultView?.addEventListener(
        BILIBILI_ROUTE_CHANGED_EVENT,
        this.handleBilibiliRouteChanged,
      );
      this.requestManifestHookCheck();
      this.scheduleIntegrityCheck();
    }
    this.playback.start();
    this.detector.start();
    if (isTopFrame()) {
      const controllerOptions: FloatingControllerOptions & {
        onMergeDockAction: (token: string, action: MergeDockAction) => Promise<void>;
        onMergeDockPathModeChange: (token: string, mode: MergeDockPathChoice) => Promise<void>;
      } = {
        themeMode: this.settings.themeMode,
        playback: this.settings.playback,
        cacheCapture: this.cacheCapture,
        onSelectedMediaChange: (media) => this.handleSelectedMediaChange(media),
        onResourceViewRequest: (force) => this.refreshDockResources(force),
        onResourceProductDownload: (token, mode, qualityToken) =>
          this.downloadDockProduct(token, mode, qualityToken),
        onMergeDockAction: (token, action) => this.runMergeDockAction(token, action),
        onMergeDockPathModeChange: (token, mode) => this.changeMergeDockPathMode(token, mode),
      };
      this.controller = new FloatingPlaybackController(this.doc, this.playback, controllerOptions);
      this.controller.resetForNavigation(this.resourceContext());
    }
    chrome.runtime.onMessage.addListener(this.handleMessage);
    void this.loadSettings();
    void this.sendEvent({ type: 'AGENT_READY', pageUrl: this.doc.URL });
    void this.sendState();
    return this.getSnapshot();
  }

  reactivate(): AgentSnapshot {
    this.detector.scanNow();
    this.playback.refresh();
    this.controller?.update(this.playback.getMediaElements());
    void this.sendEvent({ type: 'AGENT_READY', pageUrl: this.doc.URL });
    void this.sendState();
    return this.getSnapshot();
  }

  destroy(): void {
    this.cancelRestartAtBeginning();
    const view = this.doc.defaultView;
    if (this.stateTimer != null) view?.clearTimeout(this.stateTimer);
    this.stateTimer = undefined;
    if (this.manifestReadyTimer != null) view?.clearTimeout(this.manifestReadyTimer);
    this.manifestReadyTimer = undefined;
    if (this.integrityTimer != null) view?.clearTimeout(this.integrityTimer);
    this.integrityTimer = undefined;
    view?.removeEventListener(BILIBILI_MANIFEST_READY_EVENT, this.handleManifestReady);
    view?.removeEventListener(BILIBILI_ROUTE_CHANGED_EVENT, this.handleBilibiliRouteChanged);
    this.detector.stop();
    this.playback.stop();
    this.controller?.destroy();
    delete this.controller;
    this.cacheCapture.destroy();
    try {
      chrome.runtime.onMessage.removeListener(this.handleMessage);
    } catch {
      // An invalidated extension context cannot remove its listener, but the
      // browser discards that isolated world when the document reloads.
    }
  }

  private getSnapshot(): AgentSnapshot {
    const artwork = readBoundMediaArtwork(this.doc, {
      pageUrl: this.doc.URL,
      mediaEpoch: this.mediaEpoch,
      ...(this.activeMedia ? { activeMedia: this.activeMedia } : {}),
      ...(this.artworkProviderIdentity ? { providerIdentity: this.artworkProviderIdentity } : {}),
    });
    this.controller?.setArtwork(artwork);
    return {
      pageUrl: this.doc.URL,
      pageTitle: this.doc.title || '当前页面',
      assets: this.detector.getAssets(),
      mediaElements: this.playback.getMediaElements(),
      mediaEpoch: this.mediaEpoch,
      artworkDocumentKey: this.artworkDocumentKey,
      ...(this.activeMedia ? { activeMedia: this.activeMedia } : {}),
      ...(artwork ? { artwork } : {}),
    };
  }

  private readonly handleMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ApiResponse<unknown>) => void,
  ): boolean | undefined => {
    if (!isAgentRequest(message)) return undefined;
    if (
      (message.type === 'AGENT_READ_INLINE_IMAGE' || message.type === 'AGENT_BIND_ARTWORK_IDENTITY' || message.type === 'AGENT_OPEN_SETTINGS') &&
      (sender.id !== chrome.runtime.id ||
        sender.tab != null ||
        (sender.url != null && sender.url !== chrome.runtime.getURL('background.js')))
    )
      return undefined;
    void this.handleRequest(message)
      .then((data) => sendResponse(success(data)))
      .catch((error: unknown) => sendResponse(failure(error)));
    return true;
  };

  private async handleRequest(
    request: AgentRequest,
  ): Promise<AgentSnapshot | PlaybackCommandResult | string> {
    switch (request.type) {
      case 'AGENT_READ_INLINE_IMAGE':
        return readInlineImage(this.doc, request.token, request.pageUrl, request.preview,
          () => scanDocument(this.doc, { inlineImageBodies: true }));
      case 'AGENT_SCAN':
        this.detector.scanNow();
        this.playback.refresh();
        await this.sendState();
        return this.getSnapshot();
      case 'AGENT_NAVIGATION':
        if (!isTopFrame()) return this.getSnapshot();
        if (request.pageUrl !== this.doc.URL) return this.getSnapshot();
        this.synchronizeResourceNavigationGeneration();
        this.invalidateActiveMediaForRouteChange();
        this.requestManifestHookCheck();
        this.detector.markNavigation();
        this.detector.scanNow();
        this.playback.refresh();
        this.controller?.update(this.playback.getMediaElements());
        this.resourceSnapshotKey = undefined;
        this.lastResourcePushKey = undefined;
        this.controller?.resetForNavigation(this.resourceContext());
        await this.sendState();
        return this.getSnapshot();
      case 'AGENT_OPEN_VIDEO_VIEW': {
        if (
          !isTopFrame() ||
          request.pageUrl !== this.doc.URL ||
          request.mediaEpoch !== this.mediaEpoch ||
          !this.controller
        )
          throw new Error('页面已变化，请重新打开视频入口。');
        if (request.target !== 'resources' && request.target !== 'playback')
          throw new Error('无效的界面目标');
        this.controller.suppress(false);
        if (request.target === 'resources') this.controller.openResources('regular', true);
        else this.controller.openPlayback();
        return { applied: true };
      }
      case 'AGENT_PLAYBACK_COMMAND': {
        const result = await this.playback.execute(request.command, request.elementId);
        this.controller?.update(this.playback.getMediaElements());
        await this.sendState();
        return result;
      }
      case 'AGENT_START_MSE_CACHE_CAPTURE':
        return this.startCacheCapture(request);
      case 'AGENT_SET_MEDIA_DOCK':
        this.controller?.applyExternalMode(request.mode);
        return this.getSnapshot();
      case 'AGENT_OPEN_SETTINGS':
        if (!isTopFrame() || !this.controller) throw new Error('此页面无法显示设置浮窗。');
        await this.controller.openSettings(request.token, request.section);
        return this.getSnapshot();
      case 'AGENT_SET_MEDIA_PRODUCTS':
        this.applyPushedResourceSnapshot(request.snapshot);
        return this.getSnapshot();
      case 'AGENT_BIND_ARTWORK_IDENTITY': {
        if (!isTopFrame()) return this.getSnapshot();
        const identity = acceptMediaArtworkIdentity(
          request.binding,
          {
            pageUrl: this.doc.URL,
            mediaEpoch: this.mediaEpoch,
            ...(this.activeMedia ? { activeMedia: this.activeMedia } : {}),
            ...(this.artworkProviderIdentity
              ? { providerIdentity: this.artworkProviderIdentity }
              : {}),
          },
          this.artworkDocumentKey,
        );
        if (identity) this.artworkProviderIdentity = identity;
        // Return the fresh binding without recursively publishing AGENT_STATE;
        // the background revalidates and commits this reply itself.
        return this.getSnapshot();
      }
      case 'AGENT_OPEN_MERGE_DOCK':
        this.applyMergeDockView(request.view, true);
        return this.getSnapshot();
      case 'AGENT_UPDATE_MERGE_DOCK':
        this.applyMergeDockView(request.view, false);
        return this.getSnapshot();
      case 'AGENT_UPDATE_DOWNLOAD_ACTIVITY':
        if (
          request.activity.pageIdentity === this.resourcePageIdentity &&
          request.activity.mediaEpoch === this.mediaEpoch
        )
          this.controller?.setDownloadActivity(request.activity);
        return this.getSnapshot();
      case 'AGENT_APPLY_SETTINGS':
        this.applySettings(request.settings);
        await this.sendState();
        return this.getSnapshot();
    }
  }

  private handleSelectedMediaChange(media: MediaElementInfo | undefined): void {
    this.selectedElementId = media?.elementId;
    this.reconcileActiveMedia(this.playback.getMediaElements());
    this.scheduleState();
  }

  private reconcileActiveMedia(elements: readonly MediaElementInfo[]): void {
    const nextRouteKey = siteMediaRouteKey(this.doc.URL);
    const routeChanged = nextRouteKey !== this.routeKey;
    if (routeChanged) this.invalidateActiveMediaForRouteChange();
    const visibleVideoExists = elements.some(
      (element) => element.kind === 'video' && element.visibleArea > 0,
    );
    let selected = this.selectedElementId
      ? elements.find((element) => element.elementId === this.selectedElementId)
      : undefined;
    if (selected?.kind === 'video' && selected.visibleArea <= 0 && visibleVideoExists) {
      selected = undefined;
    }
    // PlaybackManager exposes only media admitted to the current route session.
    // In particular, a retained visible player from the previous Bilibili route
    // is absent until it has completed a real lifecycle/source handoff.
    if (!selected) selected = elements[0];
    if (selected?.elementId !== this.selectedElementId)
      this.selectedElementId = selected?.elementId;

    if (!selected) {
      if (this.awaitingPlayerRouteKey === nextRouteKey) return;
      if (!routeChanged && !this.activeMedia && !this.activeMediaIdentity) return;
      const hadPreviousMedia = this.activeMedia != null || this.activeMediaIdentity !== '';
      this.mediaEpoch += 1;
      this.artworkProviderIdentity = undefined;
      this.activeMedia = undefined;
      this.activeMediaIdentity = '';
      // Some SPAs remove the old player and insert its replacement in separate
      // tasks. Reset while the old identity is still known; otherwise the later
      // insertion looks like an initial player and could inherit its performance
      // discoveries on the unchanged URL.
      if (hadPreviousMedia && !routeChanged) this.detector.resetForMediaChange();
      this.resetCacheForMediaEpoch();
      return;
    }

    if (this.awaitingPlayerRouteKey === nextRouteKey) {
      // The route edge already advanced mediaEpoch. Bind the first stable player
      // to that epoch instead of creating a provisional second generation.
      this.awaitingPlayerRouteKey = undefined;
      this.activeMedia = createActiveMediaFingerprint(this.doc.URL, this.mediaEpoch, selected);
      this.activeMediaIdentity = activeMediaIdentityKey(this.activeMedia);
      return;
    }

    const candidate = createActiveMediaFingerprint(this.doc.URL, this.mediaEpoch, selected);
    const identity = activeMediaIdentityKey(candidate);
    if (identity === this.activeMediaIdentity) {
      this.activeMedia = createActiveMediaFingerprint(this.doc.URL, this.mediaEpoch, selected);
      return;
    }

    const hadPreviousMedia =
      routeChanged || this.activeMedia != null || this.activeMediaIdentity !== '';
    this.mediaEpoch += 1;
    this.artworkProviderIdentity = undefined;
    this.activeMedia = createActiveMediaFingerprint(this.doc.URL, this.mediaEpoch, selected);
    this.activeMediaIdentity = activeMediaIdentityKey(this.activeMedia);
    if (hadPreviousMedia) {
      // A same-URL player swap does not trigger MediaDetector's route reset.
      // Reset its document-scoped Resource Timing generation before publishing
      // this media epoch so stale performance/network provenance cannot be
      // reintroduced into the new snapshot.
      if (!routeChanged) this.detector.resetForMediaChange();
      this.resetCacheForMediaEpoch();
    } else {
      this.lastResetMediaEpoch = this.mediaEpoch;
    }
  }

  private invalidateActiveMediaForRouteChange(): boolean {
    const nextRouteKey = siteMediaRouteKey(this.doc.URL);
    if (nextRouteKey === this.routeKey) return false;
    this.routeKey = nextRouteKey;
    this.artworkProviderIdentity = undefined;
    this.playback.beginRouteTransition(this.doc.URL);
    this.awaitingPlayerRouteKey = nextRouteKey;
    this.selectedElementId = undefined;
    this.activeMedia = undefined;
    this.activeMediaIdentity = '';
    this.mediaEpoch += 1;
    this.detector.resetForMediaChange();
    this.resetCacheForMediaEpoch();
    return true;
  }

  private resetCacheForMediaEpoch(): void {
    if (this.lastResetMediaEpoch === this.mediaEpoch) return;
    this.lastResetMediaEpoch = this.mediaEpoch;
    this.resourceSnapshotKey = undefined;
    this.lastResourcePushKey = undefined;
    this.cancelRestartAtBeginning();
    const runtime = this.cacheCapture as MseCacheCaptureRuntime & {
      resetForMediaChange?: (media?: string | MseCacheMediaIdentity) => void;
    };
    if (typeof runtime.resetForMediaChange === 'function') {
      runtime.resetForMediaChange(this.cacheMediaIdentity(this.activeMedia));
    } else {
      runtime.resetForNavigation();
    }
    this.controller?.resetForNavigation(this.resourceContext());
  }

  private async startCacheCapture(
    request: Extract<AgentRequest, { type: 'AGENT_START_MSE_CACHE_CAPTURE' }>,
  ): Promise<AgentSnapshot> {
    if (isYouTubePage(this.doc.URL)) throw new Error('YouTube 缓存下载暂未开放。');
    await this.waitForNavigationSync();
    this.playback.refresh();
    await this.waitForNavigationSync();

    if (request.expectedPageUrl && request.expectedPageUrl !== this.doc.URL) {
      throw new Error('页面已切换，已取消过期的缓存捕获请求');
    }
    const activeMedia = this.activeMedia;
    if (
      request.expectedMedia &&
      !sameActiveMediaIdentity(request.expectedMedia, activeMedia, true)
    ) {
      throw new Error('播放器已切换，已取消过期的缓存捕获请求');
    }

    this.resetCacheForMediaEpoch();
    const mediaIdentity = this.cacheMediaIdentity(activeMedia);
    const startOptions: Parameters<MseCacheCaptureRuntime['start']>[0] = {
      sessionId: request.sessionId,
      title: request.title,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.hookSupported == null ? {} : { hookSupported: request.hookSupported }),
      pageUrl: this.doc.URL,
      ...(activeMedia?.sourceUrl ? { targetSourceUrl: activeMedia.sourceUrl } : {}),
      ...(mediaIdentity ? { mediaIdentity } : {}),
    };
    this.cacheCapture.start(startOptions);
    this.controller?.openCache();
    if (request.restartAtBeginning) {
      this.restartAtBeginning();
    } else if (isMainMediaAtBeginning(this.playback.getMediaElements())) {
      this.cacheCapture.markStartedAtBeginning();
    }
    return this.getSnapshot();
  }

  private cacheMediaIdentity(
    media: ActiveMediaFingerprint | undefined,
  ): MseCacheMediaIdentity | undefined {
    if (!media) return undefined;
    return {
      pageUrl: this.doc.URL,
      routeKey: media.routeKey,
      mediaEpoch: media.mediaEpoch,
      elementId: media.elementId,
      frameId: media.frameId,
      ...(media.sourceUrl ? { sourceUrl: media.sourceUrl } : {}),
      ...(media.duration == null ? {} : { duration: media.duration }),
      ...(media.width == null ? {} : { width: media.width }),
      ...(media.height == null ? {} : { height: media.height }),
    };
  }

  private applySettings(settings: AppSettings): void {
    const wasDisabled = isYouTubePage(this.doc.URL) && this.settings.youtubeEnabled === false;
    this.settings = mergeDeepSettings(cloneDefaultSettings(), settings);
    this.playback.applySettings(this.settings.playback);
    this.controller?.applySettings(
      this.settings.themeMode,
      isYouTubePage(this.doc.URL) && settings.youtubeEnabled === false
        ? { ...this.settings.playback, showController: false }
        : this.settings.playback,
    );
    if (isYouTubePage(this.doc.URL) && settings.youtubeEnabled === false) {
      this.detector.stop();
      this.playback.stop();
    } else if (wasDisabled) {
      this.playback.start();
      this.detector.start();
    }
    this.cacheCapture.applyTheme(this.settings.themeMode);
    this.cacheCapture.applyDownloadSaveAs(this.settings.download.saveAs);
  }

  private resourceContext(): FloatingResourceContext {
    return {
      navigationEpoch: this.navigationEpoch,
      mediaEpoch: this.mediaEpoch,
      pageIdentity: this.resourcePageIdentity,
    };
  }

  private isCurrentResourceContext(context: FloatingResourceContext): boolean {
    return (
      context.navigationEpoch === this.navigationEpoch &&
      context.mediaEpoch === this.mediaEpoch &&
      context.pageIdentity === this.resourcePageIdentity &&
      context.pageIdentity === siteMediaRouteKey(this.doc.URL)
    );
  }

  private isCurrentRouteSession(
    context: Pick<FloatingResourceContext, 'navigationEpoch' | 'pageIdentity'>,
  ): boolean {
    return (
      context.navigationEpoch === this.navigationEpoch &&
      context.pageIdentity === this.resourcePageIdentity &&
      context.pageIdentity === siteMediaRouteKey(this.doc.URL)
    );
  }

  private synchronizeResourceNavigationGeneration(): boolean {
    const pageIdentity = siteMediaRouteKey(this.doc.URL);
    if (pageIdentity === this.resourcePageIdentity) return false;
    this.resourcePageIdentity = pageIdentity;
    this.navigationEpoch += 1;
    this.resourceSnapshotKey = undefined;
    this.lastResourcePushKey = undefined;
    this.controller?.resetForNavigation(this.resourceContext());
    return true;
  }

  private normalizeResourceSnapshot(
    snapshot: MediaDockResourceSnapshot,
    context: FloatingResourceContext,
    sequence: number,
  ): MediaDockResourceSnapshot {
    return {
      status: snapshot.status,
      products: snapshot.products,
      navigationEpoch: context.navigationEpoch,
      mediaEpoch: context.mediaEpoch,
      sequence,
      pageIdentity: context.pageIdentity,
      ...(snapshot.revision ? { revision: snapshot.revision } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      ...(snapshot.youtube ? { youtube: snapshot.youtube } : {}),
    };
  }

  private snapshotMatchesResourceContext(
    snapshot: MediaDockResourceSnapshot,
    context: FloatingResourceContext,
  ): boolean {
    if (snapshot.pageIdentity && snapshot.pageIdentity !== context.pageIdentity) return false;
    if (snapshot.mediaEpoch != null && snapshot.mediaEpoch !== context.mediaEpoch) return false;
    return true;
  }

  private applyPushedResourceSnapshot(snapshot: MediaDockResourceSnapshot): void {
    // A background push may have been queued before a newer GET completed, and
    // MV3 worker restarts reset producer-local counters. Treat every push as a
    // URL-free invalidation signal and re-read the current tab through the
    // request/response channel instead of ever applying an unbound payload.
    const context = this.resourceContext();
    if (!this.snapshotMatchesResourceContext(snapshot, context)) return;
    const key = resourceSnapshotSemanticKey(snapshot);
    if (key === this.resourceSnapshotKey || key === this.lastResourcePushKey) return;
    this.lastResourcePushKey = key;
    this.controller?.refreshResources();
  }

  private async refreshDockResources(force = false): Promise<void> {
    const context = this.resourceContext();
    const sequence = ++this.resourceSnapshotSequence;
    const response = (await chrome.runtime.sendMessage({
      type: 'GET_MEDIA_DOCK_RESOURCES',
      ...(force ? { force: true } : {}),
    })) as ApiResponse<MediaDockResourceSnapshot> | undefined;
    if (!response?.ok) throw new Error(response?.error || '无法刷新常规下载资源');
    if (!this.isCurrentResourceContext(context)) return;
    if (!this.snapshotMatchesResourceContext(response.data, context)) {
      throw new Error('页面媒体已更新，请刷新资源列表。');
    }
    if (isTransientDockSnapshot(response.data)) {
      throw new Error(response.data.error || response.data.message || '页面媒体正在更新');
    }
    this.resourceSnapshotKey = resourceSnapshotSemanticKey(response.data);
    this.controller?.setResourceSnapshot(
      this.normalizeResourceSnapshot(response.data, context, sequence),
    );
  }

  private async downloadDockProduct(
    token: string,
    mode: MediaDockProductDownloadMode,
    qualityToken?: string,
  ): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT',
      token,
      mode,
      ...(qualityToken ? { qualityToken } : {}),
    })) as ApiResponse<MediaProductDownloadResult> | undefined;
    if (!response?.ok) throw new Error(response?.error || '无法下载所选视频资源');
    if (response.data.mode !== 'download') return;
    const failed = response.data.downloads.find((record) => record.state === 'interrupted');
    if (failed) {
      throw new Error(
        failed.error
          ? `常规下载未能启动：${failed.error}`
          : '常规下载未能启动；可切换到缓存下载重试',
      );
    }
  }

  private applyMergeDockView(view: MergeDockView, open: boolean): void {
    if (!shouldAcceptMergeDockView(this.mergeDockView, view, { allowTaskChange: open })) return;
    this.mergeDockView = { ...view };
    const controller = this.controller as
      | (FloatingPlaybackController & {
          openMerge?: (snapshot: MergeDockView) => void;
          setMergeSnapshot?: (snapshot: MergeDockView) => void;
        })
      | undefined;
    if (!controller) return;
    if (open && controller.openMerge) controller.openMerge(this.mergeDockView);
    else controller.setMergeSnapshot?.(this.mergeDockView);
  }

  private async runMergeDockAction(token: string, action: MergeDockAction): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: 'RUN_MERGE_DOCK_ACTION',
      token,
      action,
    })) as ApiResponse<MergeDockView> | undefined;
    if (!response?.ok) throw new Error(response?.error || '无法执行合并下载操作');
    this.applyMergeDockView(response.data, false);
  }

  /**
   * Apply choices that do not need a File System Access prompt in place. A
   * A new directory grant belongs to the extension origin, so its picker uses
   * a top-level extension surface with a fresh user gesture. Shadow DOM itself
   * is not the browser security boundary; cross-origin context and handle
   * ownership prevent embedding this authorization in a third-party frame.
   */
  private async changeMergeDockPathMode(token: string, mode: MergeDockPathChoice): Promise<void> {
    if (mode === 'custom') {
      await this.openMergeDirectoryPicker(token);
      return;
    }
    const response = (await chrome.runtime.sendMessage({
      type: 'SET_MERGE_DOCK_PATH_MODE',
      token,
      mode,
    })) as ApiResponse<MergeDockView> | undefined;
    if (!response?.ok) throw new Error(response?.error || '无法更改保存位置');
    this.applyMergeDockView(response.data, false);
  }

  /** Ask the Service Worker to open the trusted top-level directory picker. */
  private async openMergeDirectoryPicker(token: string): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: 'OPEN_MERGE_DIRECTORY_PICKER',
      token,
    })) as ApiResponse<unknown> | undefined;
    if (!response?.ok) throw new Error(response?.error || '无法打开保存位置窗口');
  }

  private async loadSettings(): Promise<void> {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as
        ApiResponse<AppSettings> | undefined;
      if (response?.ok) this.applySettings(response.data);
    } catch {
      // The agent remains useful with defaults if the extension is reloading.
    }
  }

  private scheduleState(): void {
    const view = this.doc.defaultView;
    if (!view || this.stateTimer != null) return;
    this.stateTimer = view.setTimeout(() => {
      this.stateTimer = undefined;
      void this.sendState();
    }, 50);
  }

  private readonly handleManifestReady = (event: Event): void => {
    const identity = manifestReadyIdentityForCurrentRoute(
      this.doc.URL,
      (event as CustomEvent<unknown>).detail,
    );
    const view = this.doc.defaultView;
    if (!identity || !view) return;

    if (this.manifestReadyTimer != null) view.clearTimeout(this.manifestReadyTimer);
    // A captured BVID/CID belongs to the same route session even if the player
    // lifecycle settles and mediaEpoch changes while this debounce is pending.
    // Fence only by navigation identity here; sendState publishes the current,
    // stable media epoch when the callback runs.
    const resourceContext = this.resourceContext();
    const context = {
      navigationEpoch: resourceContext.navigationEpoch,
      pageIdentity: resourceContext.pageIdentity,
    };
    this.manifestReadyTimer = view.setTimeout(() => {
      this.manifestReadyTimer = undefined;
      if (!this.isCurrentRouteSession(context)) return;
      if (!manifestReadyIdentityForCurrentRoute(this.doc.URL, identity)) return;

      // The event deliberately contains identity only. Read the captured
      // manifest through the detector, publish current Agent state, then ask
      // the background for a newly capability-bound Dock snapshot.
      this.detector.scanNow();
      this.playback.confirmCurrentRoutePlayerFromManifest();
      this.playback.refresh();
      this.controller?.update(this.playback.getMediaElements());
      // Player confirmation may advance mediaEpoch and clear the old binding.
      // Apply this route-checked manifest identity only after that handoff.
      this.artworkProviderIdentity = `bilibili:${identity.bvid}:${identity.cid}`;
      void this.sendState().then(() => {
        if (!this.isCurrentRouteSession(context)) return;
        if (!manifestReadyIdentityForCurrentRoute(this.doc.URL, identity)) return;
        this.controller?.refreshResources();
      });
    }, MANIFEST_READY_DEBOUNCE_MS);
  };

  private readonly handleBilibiliRouteChanged = (event: Event): void => {
    if (
      !bilibiliRouteChangedIdentityForCurrentRoute(
        this.doc.URL,
        (event as CustomEvent<unknown>).detail,
      )
    ) {
      return;
    }
    // The MAIN-world History bridge observes Bilibili's pushState/replaceState
    // synchronously. Feed that edge through MediaDetector so its route-scoped
    // registries are reset before the 500 ms isolated-world polling fallback.
    this.detector.scanNow();
  };

  private requestManifestHookCheck(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    view.dispatchEvent(new view.Event(BILIBILI_MANIFEST_HOOK_CHECK_EVENT));
  }

  private scheduleIntegrityCheck(): void {
    const view = this.doc.defaultView;
    if (!view || this.integrityTimer != null || !isTopFrame()) return;
    this.integrityTimer = view.setTimeout(() => {
      this.integrityTimer = undefined;
      if (this.doc.visibilityState === 'visible' && isSupportedMediaVideoPage(this.doc.URL)) {
        // Bilibili can replace fetch/XHR references and reuse the same player
        // several times during a recommendation-chain SPA transition. A cheap
        // visible-page heartbeat repairs the hook and republishes current state
        // after the event-driven fast path, without continuously rescanning
        // background tabs.
        this.requestManifestHookCheck();
        this.detector.scanNow();
        this.playback.refresh();
        this.reconcileActiveMedia(this.playback.getMediaElements());
        void this.sendState().then(() => this.controller?.refreshResources());
      }
      this.scheduleIntegrityCheck();
    }, VISIBLE_MEDIA_INTEGRITY_INTERVAL_MS);
  }

  private handleDetectedNavigation(): void {
    this.synchronizeResourceNavigationGeneration();
    // Invalidate synchronously, before refreshing the DOM. Bilibili can retain
    // its old hidden player while mounting the next one, and that player must
    // never cross the route boundary as the selected/active identity.
    this.invalidateActiveMediaForRouteChange();
    this.requestManifestHookCheck();
    this.cancelRestartAtBeginning();
    this.playback.refresh();
    this.reconcileActiveMedia(this.playback.getMediaElements());
    this.controller?.update(this.playback.getMediaElements());
    this.controller?.resetForNavigation(this.resourceContext());
    const event: AgentEvent = {
      type: 'AGENT_PAGE_CHANGED',
      pageUrl: this.doc.URL,
      pageTitle: this.doc.title || '当前页面',
      mediaEpoch: this.mediaEpoch,
      ...(this.activeMedia ? { activeMedia: this.activeMedia } : {}),
    };
    // Serialize rapid playlist/SPA transitions. A later route must never let an
    // earlier PAGE_CHANGED finish after it and clear the latest snapshot.
    this.navigationSync = this.navigationSync.then(() => this.sendEvent(event));
  }

  private restartAtBeginning(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    this.cancelRestartAtBeginning();
    const generation = this.restartSeekGeneration;
    const expectedMediaEpoch = this.mediaEpoch;

    // The optional buffer-tail follower must not fight the bounded rewind
    // guard. Pausing the runtime stops that UI loop, while the MAIN hook still
    // maintains its bounded beginning archive for the eventual replay.
    this.cacheCapture.pause();

    pollRestartAtBeginning({
      getElements: () => this.playback.getMediaElements(),
      refresh: () => {
        this.playback.refresh();
      },
      seek: async (elementId) => {
        const result = await this.playback.execute(
          { action: 'seekTo', seconds: 0, pause: true },
          elementId,
        );
        return result.applied;
      },
      onUpdate: (elements) => {
        this.controller?.update([...elements]);
      },
      onStableReset: () => {
        // The site may have emitted watch-history segments while the rewind was
        // stabilizing. Clear them before declaring a from-zero capture; clear()
        // keeps the same session and asks MAIN to replay only its bounded,
        // continuous beginning archive.
        this.cacheCapture.clear();
        this.cacheCapture.markStartedAtBeginning();
        this.cacheCapture.resume();
        this.doc.dispatchEvent(
          new CustomEvent('foxfetch:restart-at-beginning-ready', {
            detail: { generation },
          }),
        );
        void this.sendState();
      },
      onTimeout: () => {
        // Do not leave capture paused forever if a site never exposes a
        // seekable player. Rebuild from the safely archived beginning, but do
        // not mark it complete because a stable zero position was not proven.
        this.cacheCapture.clear();
        this.cacheCapture.resume();
        void this.sendState();
      },
      isCurrent: () =>
        generation === this.restartSeekGeneration && expectedMediaEpoch === this.mediaEpoch,
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        this.restartSeekTimer = view.setTimeout(() => {
          this.restartSeekTimer = undefined;
          callback();
        }, delayMs);
      },
    });
  }

  private cancelRestartAtBeginning(): void {
    const view = this.doc.defaultView;
    if (this.restartSeekTimer != null) view?.clearTimeout(this.restartSeekTimer);
    this.restartSeekTimer = undefined;
    this.restartSeekGeneration += 1;
  }

  private async sendState(): Promise<void> {
    // Preserve event order across the MV3 boundary: the background must remove
    // the previous route before it accepts assets from this route. Re-check the
    // queue because another navigation may be appended while this await yields.
    await this.waitForNavigationSync();
    const snapshot = this.getSnapshot();
    await this.sendEvent({ type: 'AGENT_STATE', ...snapshot });
  }

  private async waitForNavigationSync(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.navigationSync;
      await pending;
    } while (pending !== this.navigationSync);
  }

  private async sendEvent(event: AgentEvent): Promise<void> {
    try {
      await chrome.runtime.sendMessage(event);
    } catch {
      // No listener during extension shutdown/reload; the next scan resynchronizes state.
    }
  }
}

export default defineUnlistedScript({
  // Preserve main()'s return value for chrome.scripting.executeScript InjectionResult.result.
  globalName: true,
  main() {
    const scope = globalThis as AgentGlobal;
    const existing = scope[AGENT_GLOBAL_KEY];
    if (existing?.version === 6 && existing.buildId === AGENT_BUILD_ID) {
      return existing.reactivate();
    }
    const staleHost = document.getElementById(FLOATING_CONTROLLER_HOST_ID);
    if (staleHost) {
      // A pre-update isolated world can keep DOM observers alive even though
      // its extension APIs are invalid. If it later re-appends its old Dock,
      // this permanent inline guard prevents users from invoking stale code.
      staleHost.style.setProperty('display', 'none', 'important');
      staleHost.setAttribute('aria-hidden', 'true');
      staleHost.dataset.agentBuild = 'superseded';
    }
    existing?.destroy();

    const agent = new MediaAgentRuntime(document);
    scope[AGENT_GLOBAL_KEY] = agent;
    return agent.start();
  },
});
import { readInlineImage } from '../modules/detector/inline-images';
import { scanDocument } from '../modules/detector/media-detector';
