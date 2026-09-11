import { canRepeatMergeDownload, selectRepeatTracks } from '../modules/jobs/repeat-download';
import { YouTubeSelectionPreferences } from '../modules/youtube/selection-preferences';
import { YOUTUBE_SOURCE_PERMISSIONS } from '../modules/youtube/source-permissions';
import { YouTubePermissionContinuation } from '../modules/youtube/permission-continuation';
import { YouTubeDockPermissionCapabilities } from '../modules/youtube/dock-permission-capability';
import { resolveYouTubeDirectSession } from '../modules/youtube/sources/direct-session';
import {
  AGENT_SCRIPT_PATH,
  CACHE_RESTART_PREFIX,
  DEFAULT_SETTINGS,
  MAX_ASSETS_PER_TAB,
} from '../shared/constants';
import type {
  ActiveMediaFingerprint,
  ActiveTabInfo,
  AgentEvent,
  AgentRequest,
  AgentSnapshot,
  ApiResponse,
  AppSettings,
  DownloadRecord,
  DownloadActivityOwner,
  ExtensionEvent,
  MediaAsset,
  MediaAccessIntentAction,
  MediaAccessIntentResult,
  MediaAccessIntentStaged,
  MediaDockProductDownloadMode,
  MediaDockResourceSnapshot,
  MergeDockDirectorySelection,
  MergeDirectoryPickerContext,
  MergeDirectoryPickerOpened,
  MergeDockPathChoice,
  MergeDockView,
  MediaProductDownloadResult,
  MergeJobCreated,
  MergeJobSeed,
  MergeJobSourceLocation,
  PlaybackCommand,
  PlaybackCommandResult,
  PermissionGatedMediaAction,
  PermissionGatedMediaIntent,
  PermissionGatedMediaIntentResult,
  PermissionGatedMediaIntentStaged,
  ResolvedSourceDownload,
  SourceCaptureStarted,
  SourceCaptureView,
  TabMediaState,
  UiRequest,
} from '../shared/types';
import { sameActiveMediaIdentity } from '../modules/playback/playback-manager';
import { validateBoundMediaArtwork } from '../modules/media-products/media-artwork';
import {
  createMediaArtworkIdentity,
  selectDocumentBoundMainWorldManifest,
  validateMediaArtworkIdentityReply,
  type DocumentBoundMainWorldManifest,
} from '../modules/media-products/media-artwork-identity';
import {
  assessMediaScanSettlement,
  BILIBILI_PAGE_RANGE_CHUNK_BYTES,
  BILIBILI_PAGE_RANGE_MAX_TRACK_BYTES,
  extractMainWorldMediaManifest,
  fetchCapturedBilibiliPageRangeMainWorld,
  cancelCapturedBilibiliPageRangeMainWorld,
  isSupportedMediaVideoPage,
  MEDIA_SETTLEMENT_RETRY_DELAYS_MS,
  mergeValidatedMainWorldAssets,
  validateMainWorldMediaManifest,
  type MainWorldMediaManifestSnapshot,
  type ValidatedMainWorldMediaManifest,
  type BilibiliPageRangeRequest,
  type BilibiliPageRangeResult,
} from '../modules/detector';
import { isAllowedBilibiliMediaUrl } from '../modules/detector/bilibili-media';
import {
  extractYouTubeInspection,
  isYouTubePage,
  validateYouTubeInspection,
  youTubeStatusText,
  type YouTubeInspection,
} from '../modules/youtube/inspection';
import { YouTubeBackgroundTasks, type YouTubeTaskOwner } from '../modules/youtube/background-task';
import { YouTubeDirectoryGrants } from '../modules/youtube/directory-grant';
import { YouTubeDirectoryPickers } from '../modules/youtube/directory-picker';
import { YouTubeTaskJournal } from '../modules/youtube/task-journal';
import { createYouTubeSelectionPlan } from '../modules/youtube/selection';
import { automaticYouTubePlans, resolutionKey } from '../modules/youtube/automatic-selection';
import { resolveYouTubePageSession } from '../modules/youtube/sources/resolve-session';
import { YouTubeContextObservationPool } from '../modules/youtube/sources/context-observation-pool';
import {
  observeYouTubeSetupRequests,
  waitForYouTubeRequestContext,
} from '../modules/youtube/sources/request-context';
import type { YouTubeExecutionStatus } from '../modules/youtube/offscreen-executor';
import {
  bindRouteGenerationCommit,
  claimRouteGeneration,
  confirmProvisionalSameDocument,
  finalizeProvisionalDocumentReplacement,
  GenerationAwareTaskQueue,
  GenerationTaskTimeoutError,
  nextWorkerGeneration,
  rebaseSameMediaRouteState,
  safeWorkerGenerationBase,
  seedDocumentReplacementRouteGeneration,
  seedRouteGeneration,
  type RouteGenerationMarker,
  type RouteGenerationSource,
} from '../modules/detector/route-convergence';
import {
  decideAgentDocumentAdmission,
  type AgentDocumentLifecycle,
} from '../modules/detector/agent-document-admission';
import { siteMediaRouteKey } from '../modules/detector/site-media';
import { BILIBILI_MANIFEST_HOOK_VERSION } from '../modules/detector/bilibili-manifest-capture-main';
import {
  bilibiliMediaResourceFamily,
  buildMediaProducts,
  enrichBilibiliNetworkAsset,
  claimMediaDockPermissionFromMessage,
  mediaDockPermissionModesForProduct,
  MediaDockProductGrantBroker,
  currentVideoPlaybackAnchor,
  providerIdentityMatchesPage,
  presentMediaProduct,
  productDownloadOptions,
  selectProductDownload,
  validateMediaProductDownload,
  type MediaProduct,
  type MediaProductTrack,
  type MediaProductPlaybackAnchor,
} from '../modules/media-products';
import { basenameFromPath, mergeMediaAssets, sanitizeFilename, stableId } from '../shared/utils';
import { normalizeMediaTitle } from '../shared/media-title';
import { startBatchDownloads } from '../modules/downloads/manager';
import {
  notifyDownloadActivity,
  presentDownloadActivity,
  sameDownloadActivityOwner,
} from '../modules/downloads/activity';
import {
  ChromeMergeJobStore,
  MergeDirectoryPolicyQueue,
  MergeDirectoryPickerSessionBroker,
  MergeDockGrantBroker,
  MergeJobRequestContextLease,
  MergeJobCancelledError,
  MERGE_OFFSCREEN_DOCUMENT_PATH,
  canTransitionMergeJob,
  claimMergeDockPermissionFromMessage,
  commitMergeDirectoryPolicy,
  getMergeDownloadPathPolicy,
  assertNewVideoSavePolicy,
  publicationSavePolicy,
  hasRetainedMergeJobSources,
  mergeJobAcceptsWork,
  cancelMergeJobWithLifecycle,
  requireSettledMergeCancellation,
  isMergeOffscreenEvent,
  openMergeWorkspace,
  openBoundMergeDirectoryPicker,
  restoreMergeDockForOwner,
  presentMergeDockJob,
  presentMergeDownloadPath,
  presentRememberedMergeDirectory,
  resolveRememberedMergeDirectory,
  saveMergeDownloadPathPolicy,
  saveMergeJobSeed,
  touchMergeJob,
  transitionMergeJob,
  updateMergeJobProgress,
  updateMergeWorkspace,
  type MergeJob,
  type MergeDownloadPathPolicy,
  type MergeJobState,
  type CustomDirectoryOutputKind,
  type MergeOffscreenCommand,
  type MergeOffscreenEvent,
  type MergeOffscreenStatusResponse,
} from '../modules/jobs';
import type {
  MergeFailureDetail,
  RemuxProgress,
  SeparateTrackMergeRequest,
} from '../modules/merge';
import type {
  CompletedStandardSeparateExport,
  StandardSeparateOutputKind,
  StandardSeparateOutputOutcome,
} from '../modules/exports';
import {
  MediaAccessIntentBroker,
  PendingMediaAccessIntentStore,
  PendingPermissionIntentStore,
  PermissionDownloadAttemptStore,
  PermissionIntentBroker,
  FULL_MEDIA_ACCESS_PERMISSIONS,
  assertDirectMediaAssetPermissions,
  assertDirectMediaDownloadContext,
  assertMediaAccessIntentContext,
  assertPermissionIntentBundle,
  assertPermissionMediaContext,
  createPermissionIntent,
  hasFullMediaAccess,
  hasPermissionIntentAccess,
  narrowMediaPermissions,
  requestFullMediaAccess,
  requiredPermissionBundle,
  runIdempotentPermissionDownloads,
  validatePermissionActionAssets,
} from '../modules/permissions';
import {
  releaseMediaRequestContext,
  releaseMediaRequestContexts,
} from '../modules/downloads/request-context';
import {
  buildDownloadDirectory,
  displayDownloadDirectory,
  downloadPlatformDirectory,
} from '../modules/downloads/download-path';
import {
  ExtensionDirectoryHandleStore,
  verifyDirectoryPermission,
} from '../modules/downloads/directory-handle-store';
import {
  authoritativeNetworkAssetKeys,
  canAdoptQuarantinedNetworkAsset,
  startNetworkObserver,
  stopNetworkObserver,
  type NetworkRequestContext,
} from '../modules/network/observer';
import {
  resolveNetworkMediaCandidates,
  type NetworkMediaObservation,
} from '../modules/network/media-observation';
import {
  getDownloadHistory,
  saveDownloadHistory,
  upsertDownloadRecord,
  updateDownloadByChromeId,
} from '../modules/downloads/history';
import { openSettingsPage } from '../modules/settings-entry';
import {
  issueSettingsFrame,
  verifySettingsFrame,
  releaseSettingsFrame,
} from '../modules/settings-frame-session';
import { getSettings, saveSettings } from '../modules/storage/settings';
import {
  acknowledgePendingNetworkAssets,
  appendPendingNetworkAsset,
  clearTabState,
  createRouteTransitionState,
  getMainWorldAssetSnapshot,
  getTabState,
  mergeAgentSnapshots,
  peekPendingNetworkAssets,
  saveMainWorldAssetSnapshot,
  setTabState,
  type PersistedPendingNetworkAsset,
} from '../modules/storage/tab-state';
import {
  captureProtectedAssetIds,
  isExpiredNetworkAsset,
} from '../modules/storage/network-retention';
import type { BlobCaptureSession } from '../modules/resolver/capture-session';
import { resolveCaptureSessionMedia } from '../modules/resolver/capture-resolution';
import { resolveCacheCapturePageUrl } from '../modules/resolver/cache-capture-context';
import { selectCachedNetworkTrackPair } from '../modules/resolver/cached-track-policy';
import {
  clearMseDownloadFallbacksForTab,
  rememberMseDownloadFallbacks,
  shouldStartMseCacheFallback,
  takeMseDownloadFallback,
  type MseDownloadFallbackContext,
} from '../modules/resolver/download-fallback';
import {
  installMseCaptureMainWorld,
  type MseCaptureHookInstallResult,
} from '../modules/resolver/mse-capture-main';
import {
  mutateCaptureSessions,
  readCaptureSessionForTab,
  removeCaptureSessionsForTab,
} from '../modules/resolver/store';

function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function failure(error: unknown, code?: string): ApiResponse<never> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('找不到当前标签页');
  return tab;
}

async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId != null) return chrome.tabs.get(tabId);
  return getActiveTab();
}

function canInject(url?: string): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

function isAutomaticMediaSite(url?: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname === 'bilibili.com' ||
      hostname.endsWith('.bilibili.com') ||
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com')
    );
  } catch {
    return false;
  }
}

function isBilibiliVideoPage(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'bilibili.com' || parsed.hostname.endsWith('.bilibili.com')) &&
      /\/video\/BV[0-9A-Za-z]+/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

async function ensureMediaAgent(tabId: number, frameId = 0): Promise<void> {
  if (
    (await getSettings()).youtubeEnabled === false &&
    isYouTubePage((await chrome.tabs.get(tabId)).url ?? '')
  )
    return;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: [AGENT_SCRIPT_PATH],
  });
}

async function sendAgentRequest(
  tabId: number,
  frameId: number,
  request: AgentRequest,
): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, request, { frameId });
  } catch {
    await ensureMediaAgent(tabId, frameId);
    return chrome.tabs.sendMessage(tabId, request, { frameId });
  }
}

async function reinjectOpenAutomaticMediaAgents(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id != null && isAutomaticMediaSite(tab.url) && canInject(tab.url)
        ? [
            (async () => {
              // A newly installed/reloaded extension has no document_start
              // lifecycle in tabs that were already open. Restore the MAIN
              // Bilibili manifest observer before the isolated Agent so the
              // next SPA playurl request cannot pass through an unobserved gap.
              if (isBilibiliVideoPage(tab.url)) {
                await ensureBilibiliManifestHook(tab.id!);
              }
              await ensureMediaAgent(tab.id!);
            })(),
          ]
        : [],
    ),
  );
}

async function installMseCaptureHook(
  tabId: number,
  frameId?: number,
): Promise<MseCaptureHookInstallResult['health']> {
  const target: chrome.scripting.InjectionTarget =
    frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const results = await chrome.scripting
    .executeScript<[], MseCaptureHookInstallResult>({
      target,
      world: 'MAIN',
      func: installMseCaptureMainWorld,
    })
    .catch(() => []);
  const targetResult =
    frameId == null
      ? (results.find((result) => result.result?.health === 'ready') ??
        results.find((result) => result.result?.health === 'reload-required') ??
        results[0])
      : results.find((result) => result.frameId === frameId);
  return targetResult?.result?.health ?? 'unsupported';
}

const BILIBILI_MANIFEST_MAIN_SCRIPT_PATH = 'content-scripts/bilibili-manifest-main.js';
const BILIBILI_MANIFEST_INSTALL_STATE_KEY = '__foxfetchBilibiliManifestCaptureStateV2__';
const BILIBILI_MANIFEST_INSTALL_STATE_VERSION = BILIBILI_MANIFEST_HOOK_VERSION;
const BILIBILI_MANIFEST_HOOK_CHECK_EVENT = 'foxfetch:bilibili-manifest-hook-check';

interface BilibiliManifestHookProbe {
  installed: boolean;
  healthy: boolean;
}

async function probeBilibiliManifestHook(tabId: number): Promise<BilibiliManifestHookProbe> {
  const results = await chrome.scripting
    .executeScript<[string, number], BilibiliManifestHookProbe>({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (stateKey, expectedVersion) => {
        try {
          const state = Reflect.get(window, stateKey) as
            | {
                version?: number;
                fetch?: { wrapped?: typeof window.fetch };
                xhr?: {
                  prototype?: XMLHttpRequest;
                  open?: XMLHttpRequest['open'];
                  send?: XMLHttpRequest['send'];
                };
                routeBridge?: {
                  history?: Pick<History, 'pushState' | 'replaceState'>;
                  pushState?: History['pushState'];
                  replaceState?: History['replaceState'];
                  popstateBound?: boolean;
                };
              }
            | undefined;
          const installed = state?.version === expectedVersion;
          const fetchHealthy = Boolean(
            state?.fetch?.wrapped && window.fetch === state.fetch.wrapped,
          );
          const prototype = window.XMLHttpRequest?.prototype;
          const xhrHealthy = Boolean(
            prototype &&
            state?.xhr?.prototype === prototype &&
            state.xhr.open === prototype.open &&
            state.xhr.send === prototype.send,
          );
          const routeBridgeHealthy = Boolean(
            state?.routeBridge?.popstateBound &&
            state.routeBridge.history === window.history &&
            state.routeBridge.pushState === window.history.pushState &&
            state.routeBridge.replaceState === window.history.replaceState,
          );
          return {
            installed,
            healthy: installed && fetchHealthy && xhrHealthy && routeBridgeHealthy,
          };
        } catch {
          return { installed: false, healthy: false };
        }
      },
      args: [BILIBILI_MANIFEST_INSTALL_STATE_KEY, BILIBILI_MANIFEST_INSTALL_STATE_VERSION],
    })
    .catch(() => []);
  return results[0]?.result ?? { installed: false, healthy: false };
}

/** Recover MAIN capture for already-open pages after extension reload. */
async function ensureBilibiliManifestHook(tabId: number): Promise<boolean> {
  let probe = await probeBilibiliManifestHook(tabId);
  if (probe.healthy) return true;
  if (probe.installed) {
    await chrome.scripting
      .executeScript<[string], void>({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: (eventName) => window.dispatchEvent(new Event(eventName)),
        args: [BILIBILI_MANIFEST_HOOK_CHECK_EVENT],
      })
      .catch(() => undefined);
    probe = await probeBilibiliManifestHook(tabId);
    if (probe.healthy) return true;
  }
  await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      files: [BILIBILI_MANIFEST_MAIN_SCRIPT_PATH],
    })
    .catch(() => undefined);
  return (await probeBilibiliManifestHook(tabId)).healthy;
}

async function startMseCacheCaptureForFrame(
  tabId: number,
  frameId: number,
  pageTitle: string,
  reason?: string,
  restartAtBeginning = false,
  expectedPageUrl?: string,
  expectedMedia?: ActiveMediaFingerprint,
): Promise<string> {
  if (frameId !== 0) {
    throw new Error('媒体位于嵌套播放器，请在视频原始页面打开后使用缓存下载');
  }
  const expectedEpoch = navigationEpoch(tabId);
  const initialTab = await chrome.tabs.get(tabId);
  const capturePageUrl = expectedPageUrl ?? initialTab.url;
  if (isYouTubePage(capturePageUrl ?? '')) throw new Error('YouTube 缓存下载暂未开放。');
  if (!capturePageUrl || initialTab.url !== capturePageUrl) {
    throw new StaleTabOperationError('页面已切换，已取消过期的缓存捕获请求');
  }
  const hookHealth = await installMseCaptureHook(tabId, frameId);
  if (hookHealth === 'reload-required') {
    await resetCacheAndReload(tabId, frameId);
    return 'reload-pending';
  }
  if (hookHealth === 'unsupported') {
    throw new Error('当前页面未提供可捕获的 Media Source Extensions 数据');
  }
  const hookSupported = true;
  await assertTabOperationCurrent(tabId, expectedEpoch, capturePageUrl);
  const sessionId = crypto.randomUUID();
  const request: AgentRequest = {
    type: 'AGENT_START_MSE_CACHE_CAPTURE',
    sessionId,
    title: pageTitle,
    ...(reason ? { reason } : {}),
    hookSupported,
    ...(restartAtBeginning ? { restartAtBeginning: true } : {}),
    expectedPageUrl: capturePageUrl,
    ...(expectedMedia ? { expectedMedia } : {}),
  };
  const response = (await sendAgentRequest(tabId, frameId, request)) as
    ApiResponse<AgentSnapshot> | undefined;
  if (!response?.ok) throw new Error(response?.error || '缓存捕获 Agent 未响应');
  await assertTabOperationCurrent(tabId, expectedEpoch, capturePageUrl);
  if (response.data.pageUrl !== capturePageUrl) {
    throw new StaleTabOperationError('页面已切换，缓存捕获响应已过期');
  }
  if (expectedMedia && !sameActiveMediaIdentity(expectedMedia, response.data.activeMedia, true)) {
    throw new StaleTabOperationError('播放器已切换，缓存捕获响应已过期');
  }
  if (resourceCenterPorts.has(tabId)) await setMediaDockSuppressed(tabId, true);
  return sessionId;
}

async function startMseCacheCaptureFallback(
  tabId: number,
  asset: MediaAsset,
  pageTitle: string,
  reason?: string,
): Promise<void> {
  if (asset.kind !== 'video' && asset.kind !== 'audio') return;
  await startMseCacheCaptureForFrame(tabId, asset.frameId, pageTitle, reason);
}

async function triggerMseCacheFallback(
  context: Pick<MseDownloadFallbackContext, 'tabId' | 'assetId'>,
  reason?: string,
): Promise<boolean> {
  if (!shouldStartMseCacheFallback(reason)) return false;
  const state = await getTabState(context.tabId);
  const asset = state?.assets.find((candidate) => candidate.id === context.assetId);
  if (!state || !asset) return false;
  await startMseCacheCaptureFallback(context.tabId, asset, state.pageTitle, reason);
  return true;
}

async function armMseCacheFallbacks(
  tabId: number,
  records: readonly DownloadRecord[],
): Promise<Set<string>> {
  const startedAssetIds = new Set<string>();
  await rememberMseDownloadFallbacks(tabId, records);

  for (const record of records) {
    if (record.state !== 'interrupted') continue;
    if (record.chromeDownloadId != null) {
      const context = await takeMseDownloadFallback(record.chromeDownloadId);
      if (!context) continue;
      const started = await triggerMseCacheFallback(context, record.error).catch(() => false);
      if (started) startedAssetIds.add(record.assetId);
    } else {
      const started = await triggerMseCacheFallback(
        { tabId, assetId: record.assetId },
        record.error,
      ).catch(() => false);
      if (started) startedAssetIds.add(record.assetId);
    }
  }

  // onChanged can win the race before the fallback context is persisted. Re-read
  // history once after arming so that an already-interrupted download is not lost.
  const latestById = new Map(
    (await getDownloadHistory()).flatMap((record) =>
      record.chromeDownloadId == null ? [] : [[record.chromeDownloadId, record] as const],
    ),
  );
  for (const record of records) {
    if (record.chromeDownloadId == null || record.state === 'interrupted') continue;
    const latest = latestById.get(record.chromeDownloadId);
    if (latest?.state !== 'interrupted') continue;
    const context = await takeMseDownloadFallback(record.chromeDownloadId);
    if (context) {
      const started = await triggerMseCacheFallback(context, latest.error).catch(() => false);
      if (started) startedAssetIds.add(record.assetId);
    }
  }
  return startedAssetIds;
}

const downloadActivityRevisions = new Map<number, number>();
const pendingDownloadStarts = new Map<string, number>();

function downloadActivityOwner(state: TabMediaState): DownloadActivityOwner {
  const documentId = tabFrameDocuments.get(state.tabId)?.get(0);
  return {
    tabId: state.tabId,
    pageIdentity: siteMediaRouteKey(state.pageUrl),
    mediaEpoch: state.mediaEpoch ?? 0,
    ...(documentId ? { documentId } : {}),
  };
}

function downloadActivityKey(owner: DownloadActivityOwner): string {
  return JSON.stringify([owner.tabId, owner.pageIdentity, owner.mediaEpoch, owner.documentId]);
}

async function pushDownloadActivity(tabId: number): Promise<void> {
  const revision = Math.max(Date.now(), (downloadActivityRevisions.get(tabId) ?? 0) + 1);
  downloadActivityRevisions.set(tabId, revision);
  const state = await getTabState(tabId);
  if (!state) return;
  const owner = downloadActivityOwner(state);
  if (!owner.documentId) return;
  const records = await getDownloadHistory();
  const latest = await getTabState(tabId);
  if (
    !latest ||
    downloadActivityRevisions.get(tabId) !== revision ||
    !sameDownloadActivityOwner(downloadActivityOwner(latest), owner)
  )
    return;
  const activity = presentDownloadActivity(
    records,
    owner,
    revision,
    Date.now(),
    pendingDownloadStarts.get(downloadActivityKey(owner)) ?? 0,
  );
  const request: AgentRequest = { type: 'AGENT_UPDATE_DOWNLOAD_ACTIVITY', activity };
  await chrome.tabs
    .sendMessage(tabId, request, { documentId: owner.documentId })
    .catch(() => undefined);
}

async function startAssetDownloads(
  tabId: number,
  state: TabMediaState,
  selected: readonly MediaAsset[],
): Promise<DownloadRecord[]> {
  if (isYouTubePage(state.pageUrl) && selected.some((asset) => asset.kind !== 'image'))
    throw new Error('YouTube 完整下载尚未验证，本版仅提供来源识别。');
  const owner = downloadActivityOwner(state);
  const pendingKey = downloadActivityKey(owner);
  pendingDownloadStarts.set(pendingKey, (pendingDownloadStarts.get(pendingKey) ?? 0) + 1);
  let records: DownloadRecord[];
  try {
    notifyDownloadActivity(() => pushDownloadActivity(tabId));
    records = await startBatchDownloads([...selected], state.pageTitle, await getSettings(), owner);
  } finally {
    const remaining = (pendingDownloadStarts.get(pendingKey) ?? 1) - 1;
    if (remaining > 0) pendingDownloadStarts.set(pendingKey, remaining);
    else pendingDownloadStarts.delete(pendingKey);
    notifyDownloadActivity(() => pushDownloadActivity(tabId));
  }
  const cacheStartedAssetIds = await armMseCacheFallbacks(tabId, records);
  await broadcast({ type: 'DOWNLOADS_UPDATED', downloads: await getDownloadHistory() });
  const selectedById = new Map(selected.map((asset) => [asset.id, asset] as const));

  return records.map((record) => {
    if (record.state !== 'interrupted') return record;
    if (cacheStartedAssetIds.has(record.assetId)) {
      return {
        ...record,
        error: `常规下载失败，已切换到网页缓存捕获；回到视频页从头播放${record.error ? `（${record.error}）` : ''}`,
      };
    }
    const asset = selectedById.get(record.assetId);
    if ((asset?.kind === 'video' || asset?.kind === 'audio') && asset.frameId !== 0) {
      return {
        ...record,
        error: `常规下载失败；媒体位于嵌套播放器，请在视频原始页面打开后使用缓存下载${record.error ? `（${record.error}）` : ''}`,
      };
    }
    return record;
  });
}

function originPermissionPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return undefined;
  }
}

class StaleTabOperationError extends Error {
  constructor(message = '页面正在自动更新，请稍后再试') {
    super(message);
    this.name = 'StaleTabOperationError';
  }
}

const WORKER_GENERATION_BASE = safeWorkerGenerationBase();
let workerGenerationOffset = 0;

function allocateWorkerGeneration(current: number): number {
  workerGenerationOffset += 1;
  return nextWorkerGeneration(WORKER_GENERATION_BASE, current, workerGenerationOffset);
}

const tabNavigationEpochs = new Map<number, number>();
const tabMediaEpochs = new Map<number, number>();
const tabRouteGenerations = new Map<number, RouteGenerationMarker>();
const tabsNavigating = new Set<number>();
const tabNavigationGateTimers = new Map<number, ReturnType<typeof setTimeout>>();
const tabFrameDocuments = new Map<number, Map<number, string>>();
const retiredTabDocuments = new Map<number, Set<string>>();
const CACHE_RESTART_TTL_MS = 60_000;
const cacheRestartInFlight = new Set<number>();
const UNKNOWN_MEDIA_EPOCH = -1;
const PENDING_NETWORK_ASSET_TTL_MS = 15_000;
const MAX_PENDING_NETWORK_ASSETS_PER_TAB = 64;
const PENDING_AGENT_PAGE_CHANGE_TTL_MS = 3_000;
const NAVIGATION_GATE_RECHECK_MS = 500;
const NAVIGATION_GATE_MAX_AGE_MS = 8_000;

interface PendingAgentPageChange {
  event: Extract<AgentEvent, { type: 'AGENT_PAGE_CHANGED' }>;
  documentId?: string;
  documentLifecycle?: AgentDocumentLifecycle;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const pendingAgentPageChanges = new Map<number, PendingAgentPageChange>();

interface CacheRestartIntent {
  tabId: number;
  frameId: number;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  maxAttempts: 1;
}

function cacheRestartKey(tabId: number): string {
  return `${CACHE_RESTART_PREFIX}${tabId}`;
}

async function readCacheRestartIntent(tabId: number): Promise<CacheRestartIntent | undefined> {
  const key = cacheRestartKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const storedIntent = stored[key] as Partial<CacheRestartIntent> | undefined;
  if (
    !storedIntent ||
    typeof storedIntent.tabId !== 'number' ||
    typeof storedIntent.frameId !== 'number' ||
    typeof storedIntent.pageUrl !== 'string' ||
    typeof storedIntent.pageTitle !== 'string' ||
    typeof storedIntent.createdAt !== 'number' ||
    typeof storedIntent.expiresAt !== 'number'
  ) {
    return undefined;
  }
  if (storedIntent.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(key);
    return undefined;
  }
  return {
    tabId: storedIntent.tabId,
    frameId: storedIntent.frameId,
    pageUrl: storedIntent.pageUrl,
    pageTitle: storedIntent.pageTitle,
    createdAt: storedIntent.createdAt,
    expiresAt: storedIntent.expiresAt,
    attempts:
      typeof storedIntent.attempts === 'number' && Number.isFinite(storedIntent.attempts)
        ? Math.max(0, storedIntent.attempts)
        : 0,
    maxAttempts: 1,
  };
}

async function resetCacheAndReload(tabId: number, frameId = 0): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !canInject(tab.url)) throw new Error('当前页面无法刷新并重新捕获');
  const existing = await readCacheRestartIntent(tabId);
  if (existing?.pageUrl === tab.url && existing.attempts >= existing.maxAttempts) {
    await chrome.storage.session.remove(cacheRestartKey(tabId));
    throw new Error('刷新后仍无法启动缓存功能，请重新打开视频页面后重试。');
  }
  const now = Date.now();
  const intent: CacheRestartIntent = {
    tabId,
    frameId,
    pageUrl: tab.url,
    pageTitle: tab.title || '当前页面',
    createdAt: now,
    expiresAt: now + CACHE_RESTART_TTL_MS,
    attempts: (existing?.pageUrl === tab.url ? existing.attempts : 0) + 1,
    maxAttempts: 1,
  };
  await chrome.storage.session.set({ [cacheRestartKey(tabId)]: intent });
  await chrome.tabs.reload(tabId);
}

async function resumeCacheRestart(tabId: number, currentUrl?: string): Promise<boolean> {
  const intent = await readCacheRestartIntent(tabId);
  if (!intent) return false;
  if (cacheRestartInFlight.has(tabId)) return true;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const pageUrl = currentUrl ?? tab?.url;
  if (!pageUrl || pageUrl !== intent.pageUrl || !canInject(pageUrl)) {
    await chrome.storage.session.remove(cacheRestartKey(tabId));
    return false;
  }
  cacheRestartInFlight.add(tabId);
  try {
    await startMseCacheCaptureForFrame(tabId, intent.frameId, intent.pageTitle, undefined, true);
    await chrome.storage.session.remove(cacheRestartKey(tabId));
    return true;
  } catch {
    // Keep the short-lived intent so a later completed/update event can retry.
    return false;
  } finally {
    cacheRestartInFlight.delete(tabId);
  }
}

function navigationEpoch(tabId: number): number {
  return tabNavigationEpochs.get(tabId) ?? WORKER_GENERATION_BASE;
}

function currentMediaEpoch(tabId: number): number {
  // -1 means the freshly awakened MV3 worker has not hydrated this tab yet.
  // The completed observation is quarantined until persisted/Agent state gives
  // it a generation instead of being incorrectly stamped as epoch zero.
  return tabMediaEpochs.get(tabId) ?? UNKNOWN_MEDIA_EPOCH;
}

function sameHttpOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      (leftUrl.protocol === 'http:' || leftUrl.protocol === 'https:') &&
      leftUrl.origin === rightUrl.origin
    );
  } catch {
    return false;
  }
}

function clearPendingAgentPageChange(tabId: number): void {
  const pending = pendingAgentPageChanges.get(tabId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingAgentPageChanges.delete(tabId);
}

function schedulePendingAgentPageChangeCheck(tabId: number, delayMs = 80): void {
  const pending = pendingAgentPageChanges.get(tabId);
  if (!pending || pending.timer) return;
  pending.timer = setTimeout(() => {
    const latest = pendingAgentPageChanges.get(tabId);
    if (latest !== pending) return;
    delete pending.timer;
    void consumePendingAgentPageChange(tabId).catch(() => undefined);
  }, delayMs);
}

function queuePendingAgentPageChange(
  tabId: number,
  event: Extract<AgentEvent, { type: 'AGENT_PAGE_CHANGED' }>,
  documentId?: string,
  documentLifecycle?: AgentDocumentLifecycle,
): void {
  clearPendingAgentPageChange(tabId);
  pendingAgentPageChanges.set(tabId, {
    event: { ...event },
    ...(documentId ? { documentId } : {}),
    ...(documentLifecycle ? { documentLifecycle } : {}),
    expiresAt: Date.now() + PENDING_AGENT_PAGE_CHANGE_TTL_MS,
  });
  schedulePendingAgentPageChangeCheck(tabId);
}

async function consumePendingAgentPageChange(tabId: number): Promise<boolean> {
  const pending = pendingAgentPageChanges.get(tabId);
  if (!pending) return false;
  if (pending.expiresAt <= Date.now()) {
    clearPendingAgentPageChange(tabId);
    return false;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (
    !tab?.url ||
    !sameHttpOrigin(tab.url, pending.event.pageUrl) ||
    siteMediaRouteKey(tab.url) !== siteMediaRouteKey(pending.event.pageUrl)
  ) {
    schedulePendingAgentPageChangeCheck(tabId, 120);
    return false;
  }
  clearPendingAgentPageChange(tabId);
  await handleAgentPageChanged(
    tabId,
    0,
    pending.event,
    pending.documentId,
    pending.documentLifecycle,
  );
  return true;
}

function clearTabNavigationGate(tabId: number): void {
  tabsNavigating.delete(tabId);
  const timer = tabNavigationGateTimers.get(tabId);
  if (timer) clearTimeout(timer);
  tabNavigationGateTimers.delete(tabId);
}

function scheduleNavigationGateRecovery(tabId: number, openedAt: number): void {
  const previousTimer = tabNavigationGateTimers.get(tabId);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(() => {
    if (tabNavigationGateTimers.get(tabId) !== timer) return;
    tabNavigationGateTimers.delete(tabId);
    void (async () => {
      if (!tabsNavigating.has(tabId)) return;
      if (await consumePendingAgentPageChange(tabId)) return;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab?.url) {
        clearTabNavigationGate(tabId);
        return;
      }
      const hasLiveTopDocument = Boolean(tabFrameDocuments.get(tabId)?.get(0));
      if (
        tab.status === 'complete' ||
        hasLiveTopDocument ||
        Date.now() - openedAt >= NAVIGATION_GATE_MAX_AGE_MS
      ) {
        // Chrome does not guarantee a matching `complete` event for a
        // same-document History transition. Release the gate once a live Agent
        // document or the current completed tab proves scanning can resume.
        clearTabNavigationGate(tabId);
        if (canInject(tab.url)) {
          await ensureMediaAgent(tabId, 0).catch(() => undefined);
          await scanTab(tabId).catch(() => undefined);
        }
        return;
      }
      scheduleNavigationGateRecovery(tabId, openedAt);
    })();
  }, NAVIGATION_GATE_RECHECK_MS);
  tabNavigationGateTimers.set(tabId, timer);
}

function markTabNavigating(tabId: number): void {
  tabsNavigating.add(tabId);
  scheduleNavigationGateRecovery(tabId, Date.now());
}

function quarantineNetworkAsset(
  tabId: number,
  asset: MediaAsset,
  context: NetworkRequestContext,
): void {
  const now = Date.now();
  void appendPendingNetworkAsset(
    tabId,
    {
      asset: { ...asset },
      context: { ...context },
      expiresAt: now + PENDING_NETWORK_ASSET_TTL_MS,
    },
    MAX_PENDING_NETWORK_ASSETS_PER_TAB,
    now,
  ).catch(() => undefined);
}

async function drainPendingNetworkAssets(tabId: number, state: TabMediaState): Promise<void> {
  const now = Date.now();
  const pending = await peekPendingNetworkAssets(tabId, now);
  const handled: PersistedPendingNetworkAsset[] = [];
  const authoritativeAssetIds = new Set(
    state.assets
      .filter((asset) => asset.detectedBy.some((source) => source !== 'network'))
      .flatMap(authoritativeNetworkAssetKeys),
  );
  for (const candidate of pending) {
    if (candidate.expiresAt <= now) continue;
    const currentDocumentId = tabFrameDocuments.get(tabId)?.get(candidate.context.frameId);
    if (
      candidate.context.documentId &&
      currentDocumentId &&
      candidate.context.documentId !== currentDocumentId
    ) {
      handled.push(candidate);
      continue;
    }
    const enriched =
      candidate.asset.kind === 'video' || candidate.asset.kind === 'audio'
        ? enrichBilibiliNetworkAsset(
            candidate.asset as MediaAsset & { kind: 'video' | 'audio' },
            state.assets,
            state.pageUrl,
            state.providerIdentity,
          )
        : undefined;
    // mediaEpoch/old Referer identify when the request happened, not what it
    // belongs to. After document/TTL eviction, ownership must be independently
    // proven by the current route, exact authoritative asset, or exact BVID/CID
    // plus DASH resource family.
    if (
      !enriched &&
      !canAdoptQuarantinedNetworkAsset(candidate.asset, state.pageUrl, authoritativeAssetIds)
    ) {
      continue;
    }
    const reboundContext: NetworkRequestContext = {
      frameId: candidate.context.frameId,
      mediaEpoch: state.mediaEpoch ?? 0,
      routeKey: siteMediaRouteKey(state.pageUrl),
      ...(currentDocumentId ? { documentId: currentDocumentId } : {}),
    };
    try {
      await mergeNetworkAsset(tabId, enriched ?? candidate.asset, reboundContext);
      handled.push(candidate);
    } catch {
      // Keep the original entry and expiry so a service-worker restart or a
      // transient state race retries it without extending its lifetime.
    }
  }
  await acknowledgePendingNetworkAssets(tabId, handled, Date.now());
}

function bumpNavigationEpoch(tabId: number, retireDocuments = true): number {
  clearMediaSettlementRetry(tabId);
  clearMainWorldAssets(tabId);
  // Persisted quarantine intentionally survives same-document route edges and
  // worker restarts. TTL/document evidence and ownership proof gate adoption.
  const next = allocateWorkerGeneration(navigationEpoch(tabId));
  tabNavigationEpochs.set(tabId, next);
  if (retireDocuments) {
    tabMediaEpochs.delete(tabId);
    const documents = tabFrameDocuments.get(tabId);
    if (documents) {
      for (const documentId of documents.values()) retireTabDocument(tabId, documentId);
    }
    tabFrameDocuments.delete(tabId);
  }
  return next;
}

function ensureRouteGeneration(
  tabId: number,
  pageUrl: string,
  documentId?: string,
): RouteGenerationMarker {
  const current = tabRouteGenerations.get(tabId);
  if (current) return current;
  const seeded = seedRouteGeneration(pageUrl, navigationEpoch(tabId), documentId);
  tabRouteGenerations.set(tabId, seeded);
  return seeded;
}

function bindCurrentRouteGenerationCommit(
  tabId: number,
  pageUrl: string,
  epoch: number,
  documentId?: string,
): boolean {
  const marker = bindRouteGenerationCommit(
    tabRouteGenerations.get(tabId),
    pageUrl,
    epoch,
    documentId,
  );
  if (!marker) return false;
  tabRouteGenerations.set(tabId, marker);
  return true;
}

function beginRouteGeneration(
  tabId: number,
  pageUrl: string,
  source: RouteGenerationSource,
  options: { documentNavigation?: boolean; urlChanged?: boolean; documentId?: string } = {},
): {
  epoch: number;
  advanced: boolean;
  sameMediaRoute: boolean;
  pairedSpaTransition: boolean;
} {
  const claim = claimRouteGeneration(
    tabRouteGenerations.get(tabId),
    {
      pageUrl,
      source,
      ...(options.documentNavigation ? { documentNavigation: true } : {}),
      ...(options.urlChanged ? { urlChanged: true } : {}),
      ...(options.documentId ? { documentId: options.documentId } : {}),
    },
    navigationEpoch(tabId),
  );
  const epoch = claim.advanced
    ? bumpNavigationEpoch(tabId, options.documentNavigation === true)
    : navigationEpoch(tabId);
  tabRouteGenerations.set(tabId, { ...claim.marker, epoch });
  return {
    epoch,
    advanced: claim.advanced,
    sameMediaRoute: claim.sameMediaRoute,
    pairedSpaTransition: claim.pairedSpaTransition,
  };
}

async function assertTabOperationCurrent(
  tabId: number,
  expectedEpoch: number,
  expectedUrl: string,
  expectedMediaEpoch = UNKNOWN_MEDIA_EPOCH,
): Promise<chrome.tabs.Tab> {
  if (
    navigationEpoch(tabId) !== expectedEpoch ||
    tabsNavigating.has(tabId) ||
    (expectedMediaEpoch !== UNKNOWN_MEDIA_EPOCH && currentMediaEpoch(tabId) !== expectedMediaEpoch)
  ) {
    throw new StaleTabOperationError();
  }
  const currentTab = await chrome.tabs.get(tabId);
  if (
    navigationEpoch(tabId) !== expectedEpoch ||
    tabsNavigating.has(tabId) ||
    (expectedMediaEpoch !== UNKNOWN_MEDIA_EPOCH &&
      currentMediaEpoch(tabId) !== expectedMediaEpoch) ||
    currentTab.url !== expectedUrl
  ) {
    throw new StaleTabOperationError();
  }
  return currentTab;
}

async function isTabRouteCommitCurrent(
  tabId: number,
  expectedEpoch: number,
  expectedPageUrl: string,
  documentId?: string,
): Promise<boolean> {
  if (navigationEpoch(tabId) !== expectedEpoch || tabsNavigating.has(tabId)) return false;
  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (
    !currentTab?.url ||
    navigationEpoch(tabId) !== expectedEpoch ||
    tabsNavigating.has(tabId) ||
    siteMediaRouteKey(currentTab.url) !== siteMediaRouteKey(expectedPageUrl)
  ) {
    return false;
  }
  if (!documentId) return true;
  if (retiredTabDocuments.get(tabId)?.has(documentId)) return false;
  const currentDocumentId = tabFrameDocuments.get(tabId)?.get(0);
  return !currentDocumentId || currentDocumentId === documentId;
}

async function isNetworkAssetCommitCurrent(
  tabId: number,
  expectedEpoch: number,
  expectedPageUrl: string,
  context: NetworkRequestContext,
): Promise<boolean> {
  if (
    navigationEpoch(tabId) !== expectedEpoch ||
    tabsNavigating.has(tabId) ||
    currentMediaEpoch(tabId) !== context.mediaEpoch
  ) {
    return false;
  }
  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (
    !currentTab?.url ||
    navigationEpoch(tabId) !== expectedEpoch ||
    tabsNavigating.has(tabId) ||
    currentMediaEpoch(tabId) !== context.mediaEpoch ||
    siteMediaRouteKey(currentTab.url) !== siteMediaRouteKey(expectedPageUrl) ||
    context.routeKey !== siteMediaRouteKey(currentTab.url)
  ) {
    return false;
  }
  if (context.documentId) {
    if (retiredTabDocuments.get(tabId)?.has(context.documentId)) return false;
    const currentDocumentId = tabFrameDocuments.get(tabId)?.get(context.frameId);
    if (currentDocumentId && currentDocumentId !== context.documentId) return false;
  }
  const current = await getTabState(tabId);
  return Boolean(
    current &&
    navigationEpoch(tabId) === expectedEpoch &&
    !tabsNavigating.has(tabId) &&
    siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(expectedPageUrl) &&
    (current.mediaEpoch ?? 0) === context.mediaEpoch,
  );
}

function retireTabDocument(tabId: number, documentId: string): void {
  const retired = retiredTabDocuments.get(tabId) ?? new Set<string>();
  retired.add(documentId);
  while (retired.size > 256) {
    const oldest = retired.values().next().value as string | undefined;
    if (!oldest) break;
    retired.delete(oldest);
  }
  retiredTabDocuments.set(tabId, retired);
}

function admitFrameDocument(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  documentLifecycle: AgentDocumentLifecycle | undefined,
  replacementProof?: 'active_ready' | 'current_injection',
  pageUrl?: string,
): boolean {
  const documents = tabFrameDocuments.get(tabId) ?? new Map<number, string>();
  const currentDocumentId = documents.get(frameId);
  const decision = decideAgentDocumentAdmission({
    ...(documentId ? { incomingDocumentId: documentId } : {}),
    ...(currentDocumentId ? { currentDocumentId } : {}),
    ...(retiredTabDocuments.get(tabId)
      ? { retiredDocumentIds: retiredTabDocuments.get(tabId)! }
      : {}),
    ...(documentLifecycle ? { lifecycle: documentLifecycle } : {}),
    ...(replacementProof ? { replacementProof } : {}),
  });
  if (!decision.accepted) return false;
  if (!documentId) return replacementProof === 'current_injection';
  if (decision.replaceCurrent && currentDocumentId) {
    if (frameId === 0 && pageUrl) {
      const finalizedProvisionalRoute = finalizeProvisionalDocumentReplacement(
        tabRouteGenerations.get(tabId),
        pageUrl,
        currentDocumentId,
        documentId,
      );
      for (const existingDocumentId of documents.values()) {
        retireTabDocument(tabId, existingDocumentId);
      }
      documents.clear();
      const epoch = finalizedProvisionalRoute
        ? navigationEpoch(tabId)
        : bumpNavigationEpoch(tabId, false);
      if (finalizedProvisionalRoute) {
        clearMediaSettlementRetry(tabId);
        clearMainWorldAssets(tabId);
        // The route epoch was already allocated by tabs/read, but an
        // executeScript pass may still be returning from the provisional old
        // document. A new active READY retires that result without counting a
        // second navigation generation; the scan started below will receive a
        // fresh scan id. A current_injection proof is itself that fresh scan
        // and must be allowed to finish (not invalidate its own id).
        if (replacementProof === 'active_ready') {
          tabScanIds.set(tabId, (tabScanIds.get(tabId) ?? 0) + 1);
          tabScanFlights.get(tabId)?.clear();
        }
      }
      tabMediaEpochs.delete(tabId);
      tabRouteGenerations.set(
        tabId,
        finalizedProvisionalRoute ??
          seedDocumentReplacementRouteGeneration(pageUrl, epoch, documentId),
      );
      clearPendingAgentPageChange(tabId);
      clearCaptureAnalysisTimer(tabId);
      clearCaptureTimeout(tabId);
      bumpCaptureObservationGeneration(tabId);
      captureReloadTabs.delete(tabId);
      void mediaDockGrantBroker.clearTab(tabId).catch(() => undefined);
      void clearMergeDirectoryPickersForSourceTab(tabId).catch(() => undefined);
      mediaDockLastPushedRevision.delete(tabId);
      void removeCaptureSessionsForTab(tabId).catch(() => undefined);
      void clearMseDownloadFallbacksForTab(tabId).catch(() => undefined);
    } else {
      retireTabDocument(tabId, currentDocumentId);
    }
  }
  documents.set(frameId, documentId);
  tabFrameDocuments.set(tabId, documents);
  if (decision.restoreRetired) {
    const retired = retiredTabDocuments.get(tabId);
    retired?.delete(documentId);
    if (retired?.size === 0) retiredTabDocuments.delete(tabId);
  }
  if (replacementProof && frameId === 0 && pageUrl) {
    const marker = tabRouteGenerations.get(tabId);
    if (marker && marker.routeKey === siteMediaRouteKey(pageUrl)) {
      tabRouteGenerations.set(
        tabId,
        confirmProvisionalSameDocument(marker, pageUrl, documentId) ?? {
          ...marker,
          documentId,
        },
      );
    }
  }
  return true;
}

function rememberFrameDocument(
  tabId: number,
  frameId: number,
  documentId?: string,
  documentLifecycle?: AgentDocumentLifecycle,
): boolean {
  return admitFrameDocument(tabId, frameId, documentId, documentLifecycle);
}

function registerReadyFrameDocument(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  documentLifecycle: AgentDocumentLifecycle | undefined,
  pageUrl: string,
): boolean {
  return admitFrameDocument(tabId, frameId, documentId, documentLifecycle, 'active_ready', pageUrl);
}

function registerInjectedFrameDocument(
  tabId: number,
  frameId: number,
  documentId: string | undefined,
  pageUrl: string,
): boolean {
  return admitFrameDocument(tabId, frameId, documentId, undefined, 'current_injection', pageUrl);
}

function currentNetworkDocumentId(
  tabId: number,
  frameId: number,
  explicitDocumentId?: string,
): string {
  return (
    explicitDocumentId ??
    tabFrameDocuments.get(tabId)?.get(frameId) ??
    `tab-${tabId}:epoch-${navigationEpoch(tabId)}:frame-${frameId}`
  );
}

const tabStateMutationTails = new Map<number, Promise<void>>();

function serializeTabStateMutation<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = tabStateMutationTails.get(tabId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  tabStateMutationTails.set(tabId, settled);
  void settled.then(() => {
    if (tabStateMutationTails.get(tabId) === settled) tabStateMutationTails.delete(tabId);
  });
  return result;
}

async function broadcast(event: ExtensionEvent): Promise<void> {
  try {
    await chrome.runtime.sendMessage(event);
  } catch {
    // No extension page is listening. State remains persisted.
  }
}

const mediaDockGrantBroker = new MediaDockProductGrantBroker();
const mediaDockPushTimers = new Map<number, ReturnType<typeof setTimeout>>();
const mediaDockLastPushedRevision = new Map<number, string>();
const mediaDockRequestSequences = new Map<number, number>();

function nextMediaDockRequestSequence(tabId: number): number {
  const next = allocateWorkerGeneration(
    mediaDockRequestSequences.get(tabId) ?? WORKER_GENERATION_BASE,
  );
  mediaDockRequestSequences.set(tabId, next);
  return next;
}

function mediaDockPlaybackAnchor(state: TabMediaState): MediaProductPlaybackAnchor | undefined {
  return currentVideoPlaybackAnchor(state);
}

function mediaDockIdentity(state: TabMediaState): string {
  const active = state.activeMedia;
  if (active) {
    return stableId(
      [
        active.routeKey,
        active.mediaEpoch,
        active.elementId,
        active.lifecycleGeneration,
        active.frameId,
        active.kind,
        active.sourceUrl ?? '',
      ].join('\u0000'),
    );
  }
  const anchor = state.mediaElements[0];
  if (!anchor) return 'no-active-media';
  return stableId(
    [
      anchor.elementId,
      anchor.lifecycleGeneration,
      anchor.frameId,
      anchor.kind,
      anchor.sourceUrl ?? '',
    ].join('\u0000'),
  );
}

function activeMediaForRoute(
  pageUrl: string,
  mediaEpoch: number,
  active: ActiveMediaFingerprint | undefined,
): ActiveMediaFingerprint | undefined {
  return active?.routeKey === siteMediaRouteKey(pageUrl) && active.mediaEpoch === mediaEpoch
    ? active
    : undefined;
}

function mediaDockProducts(state: TabMediaState): MediaProduct[] {
  if (isYouTubePage(state.pageUrl)) return [];
  const anchor = mediaDockPlaybackAnchor(state);
  const assets = state.assets.filter(
    (asset) =>
      !asset.detectedBy.includes('manifest') ||
      state.providerIdentity == null ||
      providerIdentityMatchesPage(state.pageUrl, state.providerIdentity),
  );
  return buildMediaProducts(assets, {
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
    ...(anchor ? { anchor } : {}),
    ...(state.providerIdentity ? { providerIdentity: state.providerIdentity } : {}),
  }).filter(
    (product) =>
      product.videoTracks.length > 0 &&
      (product.capabilities.complete || product.capabilities.videoOnly),
  );
}

/**
 * Recover the exact logical product tracks for legacy/source-capture asset pairs.
 * A raw asset id alone is not proof that two signed URLs belong together; only
 * return metadata when the current product graph binds both assets to one strong
 * stream identity. This lets those older entry points reuse CDN mirrors and the
 * provider identity without relaxing cross-video safety.
 */
function exactMergeTracksForAssets(
  state: TabMediaState,
  video: MediaAsset,
  audio: MediaAsset,
): { videoTrack: MediaProductTrack; audioTrack: MediaProductTrack } | undefined {
  for (const product of mediaDockProducts(state)) {
    const videoTrack = product.videoTracks.find((track) =>
      track.sources.some((source) => source.id === video.id),
    );
    const audioTrack = product.audioTracks.find((track) =>
      track.sources.some((source) => source.id === audio.id),
    );
    if (
      videoTrack?.streamIdentity &&
      audioTrack?.streamIdentity &&
      videoTrack.streamIdentity === audioTrack.streamIdentity
    ) {
      return { videoTrack, audioTrack };
    }
  }
  return undefined;
}

interface MediaSettlementRetry {
  key: string;
  nextDelayIndex: number;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const mediaSettlementRetries = new Map<number, MediaSettlementRetry>();

function settlementRetryExhausted(tabId: number, key: string): boolean {
  const retry = mediaSettlementRetries.get(tabId);
  return Boolean(
    retry?.key === key &&
    !retry.running &&
    !retry.timer &&
    retry.nextDelayIndex >= MEDIA_SETTLEMENT_RETRY_DELAYS_MS.length,
  );
}

function assessStateSettlement(tabId: number, state: TabMediaState) {
  const input = {
    pageUrl: state.pageUrl,
    mediaEpoch: state.mediaEpoch ?? 0,
    mediaElements: state.mediaElements,
    products: mediaDockProducts(state),
  };
  const key = JSON.stringify([siteMediaRouteKey(state.pageUrl), state.mediaEpoch ?? 0]);
  return assessMediaScanSettlement({
    ...input,
    retryExhausted: settlementRetryExhausted(tabId, key),
  });
}

async function rememberMainWorldAssets(
  tabId: number,
  state: TabMediaState,
  assets: readonly MediaAsset[],
  documentId?: string,
  providerIdentity?: string,
): Promise<readonly MediaAsset[]> {
  return saveMainWorldAssetSnapshot(
    tabId,
    state.pageUrl,
    state.mediaEpoch ?? 0,
    assets,
    documentId,
    providerIdentity,
  );
}

async function mainWorldAssetsFor(
  tabId: number,
  pageUrl: string,
  mediaEpoch: number,
  documentId?: string,
  providerIdentity?: string,
): Promise<readonly MediaAsset[]> {
  return getMainWorldAssetSnapshot(tabId, pageUrl, mediaEpoch, documentId, providerIdentity);
}

function clearMainWorldAssets(tabId: number): void {
  // Persisted snapshots are generation-scoped by URL, media epoch and document
  // id. Leave the previous record in session storage until the next validated
  // snapshot atomically replaces it; an asynchronous remove could otherwise
  // race that replacement during a rapid SPA transition.
  void tabId;
}

function clearMediaSettlementRetry(tabId: number): void {
  const retry = mediaSettlementRetries.get(tabId);
  if (retry?.timer) clearTimeout(retry.timer);
  mediaSettlementRetries.delete(tabId);
}

function reconcileMediaSettlementRetry(tabId: number, state: TabMediaState): void {
  if (state.status !== 'ready') return;
  const settlement = assessStateSettlement(tabId, state);
  if (settlement.status === 'complete') {
    clearMediaSettlementRetry(tabId);
    return;
  }
  if (!settlement.shouldRetry) return;

  let retry = mediaSettlementRetries.get(tabId);
  if (retry?.key !== settlement.key) {
    clearMediaSettlementRetry(tabId);
    retry = { key: settlement.key, nextDelayIndex: 0, running: false };
    mediaSettlementRetries.set(tabId, retry);
  }
  if (
    retry.running ||
    retry.timer ||
    retry.nextDelayIndex >= MEDIA_SETTLEMENT_RETRY_DELAYS_MS.length
  ) {
    return;
  }

  const delay = MEDIA_SETTLEMENT_RETRY_DELAYS_MS[retry.nextDelayIndex];
  retry.timer = setTimeout(() => {
    const activeRetry = mediaSettlementRetries.get(tabId);
    if (activeRetry !== retry) return;
    delete retry.timer;
    retry.nextDelayIndex += 1;
    retry.running = true;
    void (async () => {
      try {
        const current = await getTabState(tabId);
        if (!current || current.status !== 'ready') return;
        const currentSettlement = assessMediaScanSettlement({
          pageUrl: current.pageUrl,
          mediaEpoch: current.mediaEpoch ?? 0,
          mediaElements: current.mediaElements,
          products: mediaDockProducts(current),
        });
        if (!currentSettlement.shouldRetry || currentSettlement.key !== retry.key) {
          clearMediaSettlementRetry(tabId);
          return;
        }
        await scanTab(tabId).catch(() => undefined);
      } finally {
        const latestRetry = mediaSettlementRetries.get(tabId);
        if (latestRetry === retry) {
          retry.running = false;
          const latest = await getTabState(tabId);
          if (latest) {
            reconcileMediaSettlementRetry(tabId, latest);
            if (assessStateSettlement(tabId, latest).status === 'degraded') {
              scheduleMediaDockSnapshot(tabId);
            }
          }
        }
      }
    })();
  }, delay);
}

function needsMediaConvergence(state: TabMediaState | undefined): boolean {
  if (!state) return true;
  if (!isSupportedMediaVideoPage(state.pageUrl)) return false;
  if (state.status !== 'ready') return true;
  return assessStateSettlement(state.tabId, state).shouldRetry;
}

const MEDIA_DOCK_STALE_RETRY_DELAYS_MS = [0, 80, 200] as const;

function waitForRouteSettlement(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function convergedMediaDockSnapshot(
  tabId: number,
  force: boolean,
): Promise<MediaDockResourceSnapshot> {
  let sawStaleTransition = false;
  for (const delayMs of MEDIA_DOCK_STALE_RETRY_DELAYS_MS) {
    await waitForRouteSettlement(delayMs);
    try {
      const currentTab = await chrome.tabs.get(tabId);
      let state = await synchronizeStateForRead(currentTab);
      if (currentTab.url && canInject(currentTab.url)) {
        if (force) state = await scanTab(tabId, true);
        else if (needsMediaConvergence(state)) state = await scanTab(tabId);
      }
      return createMediaDockSnapshot(state, tabId);
    } catch (error) {
      if (!(error instanceof StaleTabOperationError)) throw error;
      sawStaleTransition = true;
    }
  }

  // Route cancellation is an internal control-flow signal, not a user-facing
  // failure. Return a current-generation loading snapshot; PAGE_CHANGED and the
  // generation-aware scan queue will continue convergence automatically.
  const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
  const latest = await getTabState(tabId);
  if (!sawStaleTransition) return createMediaDockSnapshot(latest, tabId);
  let loading: TabMediaState | undefined;
  if (currentTab?.url && latest?.pageUrl === currentTab.url) {
    loading = { ...latest, status: 'scanning' };
    delete loading.error;
  } else if (currentTab?.url) {
    loading = createRouteTransitionState(
      tabId,
      currentTab.url,
      currentTab.title || '当前页面',
      latest,
    );
  } else {
    loading = latest;
  }
  return createMediaDockSnapshot(loading, tabId);
}

function mediaDockRevision(state: TabMediaState, products: readonly MediaProduct[]): string {
  const cards = products.map((product) => presentMediaProduct(product, undefined, undefined, true));
  return stableId(
    JSON.stringify({
      pageUrl: state.pageUrl,
      mediaEpoch: state.mediaEpoch ?? 0,
      mediaIdentity: mediaDockIdentity(state),
      status: state.status,
      error: state.error ?? '',
      cards,
    }),
  );
}

async function createMediaDockSnapshot(
  state: TabMediaState | undefined,
  tabId = state?.tabId,
  expectedNavigationEpoch = tabId == null ? undefined : navigationEpoch(tabId),
): Promise<MediaDockResourceSnapshot> {
  const requestSequence = tabId == null ? undefined : nextMediaDockRequestSequence(tabId);
  const snapshotGeneration =
    tabId == null
      ? {}
      : {
          navigationEpoch: expectedNavigationEpoch ?? navigationEpoch(tabId),
          ...(requestSequence == null ? {} : { sequence: requestSequence, requestSequence }),
          ...(state?.mediaEpoch == null ? {} : { mediaEpoch: state.mediaEpoch }),
          ...(state?.pageUrl
            ? { pageIdentity: siteMediaRouteKey(state.pageUrl) }
            : tabRouteGenerations.get(tabId)?.routeKey
              ? { pageIdentity: tabRouteGenerations.get(tabId)!.routeKey }
              : {}),
        };
  if (!state) {
    return {
      status: 'idle',
      products: [],
      message: '等待识别当前视频',
      ...snapshotGeneration,
    };
  }
  if (isYouTubePage(state.pageUrl)) {
    const inspected = await readYouTubeInspection(state.tabId, state.pageUrl);
    const youtube = inspected?.view;
    const currentTab = await chrome.tabs.get(state.tabId);
    if (
      siteMediaRouteKey(currentTab.url ?? '') !== siteMediaRouteKey(state.pageUrl) ||
      (expectedNavigationEpoch != null &&
        navigationEpoch(state.tabId) !== expectedNavigationEpoch) ||
      (inspected?.documentId && inspected.documentId !== tabFrameDocuments.get(state.tabId)?.get(0))
    )
      throw new StaleTabOperationError();
    if (youtube)
      await serializeTabStateMutation(state.tabId, async () => {
        const current = await getTabState(state.tabId);
        if (
          current &&
          current.pageUrl === state.pageUrl &&
          current.mediaEpoch === state.mediaEpoch &&
          (!inspected.documentId ||
            inspected.documentId === tabFrameDocuments.get(state.tabId)?.get(0))
        )
          await setTabState({ ...current, youtube });
      });
    return {
      status: 'ready',
      products: [],
      ...snapshotGeneration,
      ...(youtube ? { youtube } : {}),
      revision: stableId(JSON.stringify(youtube ?? state.pageUrl)),
      message: youtube ? youTubeStatusText(youtube) : '正在读取当前视频信息。',
    };
  }
  const products = mediaDockProducts(state);
  const settlement = assessStateSettlement(state.tabId, state);
  const revision = mediaDockRevision(state, products);
  const mediaEpoch = state.mediaEpoch ?? 0;
  const mediaIdentity = mediaDockIdentity(state);
  mediaDockGrantBroker.activateContext({
    tabId: state.tabId,
    pageUrl: state.pageUrl,
    mediaEpoch,
    mediaIdentity,
    snapshotRevision: revision,
  });
  const cards = await Promise.all(
    products.map(async (product) => {
      const card = presentMediaProduct(
        product,
        state.activeMedia?.duration,
        product.defaultQualityId,
        true,
      );
      const qualityGrants = await Promise.all(
        (card.qualityOptions ?? []).map(async (quality) => {
          const options = productDownloadOptions(product, quality.id);
          const allowedModes = options
            .filter((option) => option.available !== false)
            .map((option) => option.mode);
          const token = await mediaDockGrantBroker.issue({
            tabId: state.tabId,
            pageUrl: state.pageUrl,
            mediaEpoch,
            mediaIdentity,
            snapshotRevision: revision,
            productId: product.id,
            qualityId: quality.id,
            allowedModes,
            permissionModes: allowedModes,
          });
          return {
            token,
            id: quality.id,
            label: quality.label,
            ...(quality.detail ? { detail: quality.detail } : {}),
            completeAvailable: quality.completeAvailable,
            ...(quality.dynamicRange ? { dynamicRange: quality.dynamicRange } : {}),
            fidelityState: quality.completeCheckRequired
              ? ('checking' as const)
              : quality.completeAvailable
                ? ('ready' as const)
                : ('blocked' as const),
            ...(quality.completeUnavailableReason
              ? {
                  completeUnavailableReason: quality.completeUnavailableReason,
                  mergeBlockedReason: quality.completeUnavailableReason,
                }
              : {}),
            ...(quality.completeCheckRequired ? { completeCheckRequired: true } : {}),
            videoOnlyAvailable: quality.videoOnlyAvailable,
          };
        }),
      );
      const defaultQualityIndex = (card.qualityOptions ?? []).findIndex(
        (quality) => quality.id === card.selectedQualityId,
      );
      const defaultQualityGrant =
        qualityGrants[Math.max(0, defaultQualityIndex)] ?? qualityGrants[0];
      const view = presentMediaProduct(
        product,
        state.activeMedia?.duration,
        product.defaultQualityId,
      );
      if (defaultQualityGrant) {
        return {
          ...view,
          id: product.id,
          renderKey: product.id,
          grantToken: defaultQualityGrant.token,
          qualities: qualityGrants,
        };
      }

      const allowedModes = card.options
        .filter((option) => option.available !== false)
        .map((option) => option.mode);
      const token = await mediaDockGrantBroker.issue({
        tabId: state.tabId,
        pageUrl: state.pageUrl,
        mediaEpoch,
        mediaIdentity,
        snapshotRevision: revision,
        productId: product.id,
        allowedModes,
        permissionModes: mediaDockPermissionModesForProduct(product),
      });
      return {
        ...view,
        id: product.id,
        renderKey: product.id,
        grantToken: token,
      };
    }),
  );
  if (state.status === 'scanning' || settlement.status === 'settling') {
    return {
      status: 'loading',
      products: cards,
      revision,
      message:
        settlement.reason === 'incomplete'
          ? '画面轨道已发现，正在继续匹配当前视频的音轨'
          : '正在识别当前视频的可下载轨道',
      ...snapshotGeneration,
    };
  }
  if (state.status === 'error') {
    return {
      status: 'error',
      products: cards,
      revision,
      error: state.error || '媒体识别暂时失败',
      ...snapshotGeneration,
    };
  }
  if (settlement.status === 'degraded') {
    return {
      status: 'ready',
      products: cards,
      revision,
      message:
        cards.length > 0
          ? '已显示找到的媒体轨道，视频和音频信息尚未匹配完整。'
          : '本轮识别已结束，暂未发现可安全下载的成品视频',
      ...snapshotGeneration,
    };
  }
  return {
    status: 'ready',
    products: cards,
    revision,
    message: cards.length > 0 ? '视频资源已识别' : '尚未识别到可安全下载的视频资源',
    ...snapshotGeneration,
  };
}

async function pushMediaDockSnapshot(
  tabId: number,
  providedState?: TabMediaState,
  force = false,
): Promise<void> {
  const expectedNavigationEpoch = navigationEpoch(tabId);
  const state = providedState ?? (await getTabState(tabId));
  const products = state ? mediaDockProducts(state) : [];
  const revision = state ? mediaDockRevision(state, products) : 'idle';
  if (!force && mediaDockLastPushedRevision.get(tabId) === revision) return;
  const snapshot = await createMediaDockSnapshot(state, tabId, expectedNavigationEpoch);
  if (
    navigationEpoch(tabId) !== expectedNavigationEpoch ||
    mediaDockRequestSequences.get(tabId) !== snapshot.requestSequence
  ) {
    return;
  }
  const latest = await getTabState(tabId);
  if (
    navigationEpoch(tabId) !== expectedNavigationEpoch ||
    (latest &&
      (snapshot.pageIdentity !== siteMediaRouteKey(latest.pageUrl) ||
        snapshot.mediaEpoch !== latest.mediaEpoch ||
        revision !== mediaDockRevision(latest, mediaDockProducts(latest))))
  ) {
    return;
  }
  const request: AgentRequest = { type: 'AGENT_SET_MEDIA_PRODUCTS', snapshot };
  const response = (await chrome.tabs
    .sendMessage(tabId, request, { frameId: 0 })
    .catch(() => undefined)) as ApiResponse<unknown> | undefined;
  if (
    response?.ok &&
    navigationEpoch(tabId) === expectedNavigationEpoch &&
    mediaDockRequestSequences.get(tabId) === snapshot.requestSequence
  ) {
    mediaDockLastPushedRevision.set(tabId, revision);
    void pushDownloadActivity(tabId).catch(() => undefined);
  }
}

function scheduleMediaDockSnapshot(tabId: number): void {
  const previous = mediaDockPushTimers.get(tabId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    mediaDockPushTimers.delete(tabId);
    void pushMediaDockSnapshot(tabId).catch(() => undefined);
  }, 80);
  mediaDockPushTimers.set(tabId, timer);
}

const resourceCenterPorts = new Map<number, Set<chrome.runtime.Port>>();
const resourceCenterBindings = new Map<chrome.runtime.Port, number>();
const resourceCenterPendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function setMediaDockSuppressed(tabId: number, suppressed: boolean): Promise<void> {
  const request: AgentRequest = {
    type: 'AGENT_SET_MEDIA_DOCK',
    mode: suppressed ? 'suppressed' : 'launcher',
  };
  await chrome.tabs.sendMessage(tabId, request, { frameId: 0 }).catch(() => undefined);
}

function clearResourceCenterPendingTimer(tabId: number): void {
  const timer = resourceCenterPendingTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  resourceCenterPendingTimers.delete(tabId);
}

function bindResourceCenterPort(port: chrome.runtime.Port, tabId: number): void {
  const previousTabId = resourceCenterBindings.get(port);
  if (previousTabId === tabId) return;
  if (previousTabId != null) unbindResourceCenterPort(port, previousTabId);
  resourceCenterBindings.set(port, tabId);
  const ports = resourceCenterPorts.get(tabId) ?? new Set<chrome.runtime.Port>();
  ports.add(port);
  resourceCenterPorts.set(tabId, ports);
  clearResourceCenterPendingTimer(tabId);
  void setMediaDockSuppressed(tabId, true);
}

function unbindResourceCenterPort(port: chrome.runtime.Port, explicitTabId?: number): void {
  const tabId = explicitTabId ?? resourceCenterBindings.get(port);
  resourceCenterBindings.delete(port);
  if (tabId == null) return;
  const ports = resourceCenterPorts.get(tabId);
  ports?.delete(port);
  if (ports && ports.size > 0) return;
  resourceCenterPorts.delete(tabId);
  clearResourceCenterPendingTimer(tabId);
  const timer = setTimeout(() => {
    resourceCenterPendingTimers.delete(tabId);
    if (!resourceCenterPorts.has(tabId)) void setMediaDockSuppressed(tabId, false);
  }, 1_200);
  resourceCenterPendingTimers.set(tabId, timer);
}

function markResourceCenterOpening(tabId: number): void {
  clearResourceCenterPendingTimer(tabId);
  void setMediaDockSuppressed(tabId, true);
  const timer = setTimeout(() => {
    resourceCenterPendingTimers.delete(tabId);
    if (!resourceCenterPorts.has(tabId)) void setMediaDockSuppressed(tabId, false);
  }, 5_000);
  resourceCenterPendingTimers.set(tabId, timer);
}

async function updateBadge(tabId: number, state?: TabMediaState): Promise<void> {
  const count = state?.assets.length ?? 0;
  await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 999)) : '' });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6857F5' });
  }
}

const CAPTURE_QUIET_WINDOW_MS = 900;
const CAPTURE_TIMEOUT_MS = 2 * 60_000;
interface CaptureAnalysisTimer {
  captureId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

const captureAnalysisTimers = new Map<number, CaptureAnalysisTimer>();
const captureTimeoutTimers = new Map<
  number,
  { captureId: string; timer: ReturnType<typeof setTimeout> }
>();
const captureObservationGenerations = new Map<number, number>();
const captureReloadTabs = new Map<number, string>();

function clearCaptureAnalysisTimer(tabId: number, captureId?: string): void {
  const scheduled = captureAnalysisTimers.get(tabId);
  if (!scheduled || (captureId != null && scheduled.captureId !== captureId)) return;
  clearTimeout(scheduled.timer);
  captureAnalysisTimers.delete(tabId);
}

function clearCaptureTimeout(tabId: number, captureId?: string): void {
  const scheduled = captureTimeoutTimers.get(tabId);
  if (!scheduled || (captureId != null && scheduled.captureId !== captureId)) return;
  clearTimeout(scheduled.timer);
  captureTimeoutTimers.delete(tabId);
}

async function failCaptureOnTimeout(tabId: number, captureId: string): Promise<void> {
  clearCaptureAnalysisTimer(tabId, captureId);
  clearCaptureTimeout(tabId, captureId);
  const failed = await mutateCaptureSessions((registry) => {
    const current = registry.get(captureId);
    if (!current || current.binding.tabId !== tabId) return undefined;
    if (
      current.state === 'resolved' ||
      current.state === 'failed' ||
      current.state === 'cancelled'
    ) {
      return current;
    }
    return registry.transition(captureId, 'failed', {
      failure: {
        code: 'CAPTURE_TIMEOUT',
        message: '查找媒体地址超时，请重新开始并从头播放视频。',
        retryable: true,
      },
    });
  });
  if (failed) await publishCaptureSession(failed);
}

function scheduleCaptureTimeout(
  tabId: number,
  captureId: string,
  delay = CAPTURE_TIMEOUT_MS,
): void {
  clearCaptureTimeout(tabId);
  const timer = setTimeout(
    () => {
      const scheduled = captureTimeoutTimers.get(tabId);
      if (!scheduled || scheduled.captureId !== captureId || scheduled.timer !== timer) return;
      captureTimeoutTimers.delete(tabId);
      void failCaptureOnTimeout(tabId, captureId).catch(() => undefined);
    },
    Math.max(1, delay),
  );
  captureTimeoutTimers.set(tabId, { captureId, timer });
}

function bumpCaptureObservationGeneration(tabId: number): number {
  const next = (captureObservationGenerations.get(tabId) ?? 0) + 1;
  captureObservationGenerations.set(tabId, next);
  return next;
}

function captureMessage(
  session: BlobCaptureSession,
  candidateCount: number,
  hasPlaylist: boolean,
  hasPair: boolean,
): string | undefined {
  switch (session.state) {
    case 'permission_required':
      return '需要完整检测权限，才能观察播放器从其他 CDN 域名加载的媒体请求。';
    case 'reload_required':
      return '已获得权限。刷新页面后，FoxFetch 将从播放开始时收集媒体地址。';
    case 'waiting_for_playback':
      return '实时监听已经开启，请播放或拖动一下视频；若仍无结果，再使用刷新重试。';
    case 'capturing':
      if (hasPlaylist) return '已发现分片媒体清单，正在继续寻找可直接读取的音视频轨。';
      if (candidateCount > 0) return `已找到 ${candidateCount} 个媒体来源，正在匹配视频和音频。`;
      return '请播放视频几秒，FoxFetch 会自动识别播放器发起的媒体请求。';
    case 'analyzing':
      return '正在去重 Range 请求并确认最可靠的下载组合。';
    case 'resolved':
      if (session.observations.length === 0 && hasPair) {
        return '已直接复用当前标签页刚捕获的视频轨和音频轨，无需重新刷新页面。';
      }
      return hasPair
        ? '已找到分离的视频轨和音频轨，将在合并工作台中自动封装。'
        : '已找到一个高置信度的直接媒体源。';
    case 'failed':
      return session.failure?.message;
    case 'cancelled':
      return '已停止查找媒体地址，正在清除临时请求信息。';
  }
}

function sourceCaptureView(session: BlobCaptureSession, state: TabMediaState): SourceCaptureView {
  const boundKind = state.assets.find((asset) => asset.id === session.binding.blobAssetId)?.kind;
  const resolution = resolveCaptureSessionMedia(
    session,
    {
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
      ...(boundKind === 'video' || boundKind === 'audio' ? { expectedKind: boundKind } : {}),
    },
    session.state === 'resolved',
  );
  const resolvedAssets = session.resolvedAssetIds
    .map((id) => state.assets.find((asset) => asset.id === id))
    .filter((asset): asset is MediaAsset => Boolean(asset));
  const video = resolvedAssets.find((asset) => asset.kind === 'video');
  const audio = resolvedAssets.find((asset) => asset.kind === 'audio');
  const hasPair = Boolean(video && audio);
  const direct = hasPair ? undefined : resolvedAssets[0];
  const message = captureMessage(
    session,
    resolution.candidateCount,
    resolution.hasPlaylist,
    hasPair,
  );
  return {
    id: session.id,
    tabId: session.binding.tabId,
    blobAssetId: session.binding.blobAssetId,
    status: session.state,
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    observationCount: session.observations.length,
    candidateCount: Math.max(resolution.candidateCount, resolvedAssets.length),
    ...(direct ? { directAssetId: direct.id } : {}),
    ...(video && audio ? { videoAssetId: video.id, audioAssetId: audio.id } : {}),
    ...(message ? { message } : {}),
    ...(session.failure ? { error: session.failure.message } : {}),
  };
}

async function publishCaptureSession(
  session: BlobCaptureSession,
  assets: readonly MediaAsset[] = [],
): Promise<SourceCaptureView> {
  const tabId = session.binding.tabId;
  const state = await serializeTabStateMutation(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    const current = await getTabState(tabId);
    const assetMap = new Map((current?.assets ?? []).map((asset) => [asset.id, asset]));
    for (const asset of assets) {
      const previous = assetMap.get(asset.id);
      assetMap.set(asset.id, previous ? mergeMediaAssets(previous, asset) : asset);
    }
    const base: TabMediaState = {
      tabId,
      pageUrl: current?.pageUrl || tab.url || '',
      pageTitle: current?.pageTitle || tab.title || '当前页面',
      scannedAt: Date.now(),
      status: current?.status === 'error' ? 'ready' : (current?.status ?? 'idle'),
      assets: [...assetMap.values()]
        .sort((left, right) => right.discoveredAt - left.discoveredAt)
        .slice(0, MAX_ASSETS_PER_TAB),
      mediaElements: current?.mediaElements ?? [],
      ...(current?.mediaEpoch == null ? {} : { mediaEpoch: current.mediaEpoch }),
      ...(current?.activeMedia ? { activeMedia: current.activeMedia } : {}),
    };
    const next: TabMediaState = { ...base, sourceCapture: sourceCaptureView(session, base) };
    await setTabState(next);
    return next;
  });
  await updateBadge(tabId, state);
  await broadcast({ type: 'TAB_STATE_UPDATED', state });
  return state.sourceCapture!;
}

async function clearCaptureView(tabId: number): Promise<void> {
  const state = await serializeTabStateMutation(tabId, async () => {
    const current = await getTabState(tabId);
    if (!current?.sourceCapture) return current;
    const next: TabMediaState = { ...current };
    delete next.sourceCapture;
    await setTabState(next);
    return next;
  });
  if (state) await broadcast({ type: 'TAB_STATE_UPDATED', state });
}

const mergeJobStore = new ChromeMergeJobStore();
const mergeDockGrantBroker = new MergeDockGrantBroker();
const mergeDirectoryPickerSessionBroker = new MergeDirectoryPickerSessionBroker();
const mergeDirectoryPolicyQueue = new MergeDirectoryPolicyQueue();
const mergeDirectoryHandleStore = new ExtensionDirectoryHandleStore({
  origin: chrome.runtime.getURL(''),
});
const mergeJobRequestLeases = new Map<string, MergeJobRequestContextLease>();
const mergeProgressPublishedAt = new Map<string, number>();
const mergeDockRestoredDocuments = new Map<number, string>();
const mergeCancellationFences = new Set<string>();
const mergeCancellationTasks = new Map<string, Promise<MergeDockView>>();
const mergePublicationTasks = new Map<string, Promise<void>>();
const MERGE_EXPORT_STORAGE_PREFIX = 'foxfetch:merge-export:';
const SEPARATE_EXPORT_STORAGE_PREFIX = 'foxfetch:separate-export:';
const SEPARATE_EXPORT_GROUP_STORAGE_PREFIX = 'foxfetch:separate-export-group:';
const CUSTOM_EXPORT_STORAGE_PREFIX = 'foxfetch:custom-export:';
let creatingMergeOffscreen: Promise<void> | null = null;

interface PendingMergeExport {
  jobId: string;
  blobUrl: string;
  outputSizeBytes: number;
  recordId: string;
}

interface PendingSeparateExport {
  jobId: string;
  outputKind: StandardSeparateOutputKind;
  outputSizeBytes: number;
  recordId: string;
}

interface PendingSeparateGroupOutput {
  kind: StandardSeparateOutputKind;
  state: 'failed' | 'starting' | 'downloading' | 'complete' | 'interrupted';
  outputSizeBytes?: number;
  recordId?: string;
  downloadId?: number;
  error?: string;
  failure?: MergeFailureDetail;
}

interface PendingSeparateExportGroup {
  jobId: string;
  outputs: Record<StandardSeparateOutputKind, PendingSeparateGroupOutput>;
}

interface PendingCustomExportOutput {
  kind: CustomDirectoryOutputKind;
  fileName: string;
  expectedSizeBytes: number;
  record: DownloadRecord;
}

interface PendingCustomExport {
  jobId: string;
  handleId: string;
  mode: 'merge' | 'separate';
  outputs: Partial<Record<CustomDirectoryOutputKind, PendingCustomExportOutput>>;
}

const mergeExportStarts = new Set<string>();
const separateExportStarts = new Set<string>();
const separateExportFinalizers = new Map<string, Promise<void>>();

function pendingMergeExportKey(downloadId: number): string {
  return `${MERGE_EXPORT_STORAGE_PREFIX}${downloadId}`;
}

function pendingSeparateExportKey(downloadId: number): string {
  return `${SEPARATE_EXPORT_STORAGE_PREFIX}${downloadId}`;
}

function pendingSeparateExportGroupKey(jobId: string): string {
  return `${SEPARATE_EXPORT_GROUP_STORAGE_PREFIX}${jobId}`;
}

function pendingCustomExportKey(jobId: string): string {
  return `${CUSTOM_EXPORT_STORAGE_PREFIX}${jobId}`;
}

function mergeOwnerPageUrl(job: MergeJob): string {
  return job.ownerPageUrl ?? job.videoContext?.pageUrl ?? job.audioContext?.pageUrl ?? '';
}

function mergeRequestFromJob(job: MergeJob): SeparateTrackMergeRequest {
  return {
    video: {
      url: job.videoUrl,
      credentials: 'include',
      ...(job.videoMimeType ? { declaredMimeType: job.videoMimeType } : {}),
      ...(job.videoStreamIdentity ? { streamIdentity: job.videoStreamIdentity } : {}),
      ...(job.videoDynamicRange
        ? {
            dynamicRange: {
              provider: 'bilibili' as const,
              range: job.videoDynamicRange,
              remuxable: job.videoDynamicRangeRemuxable ?? 'unknown',
            },
          }
        : {}),
      ...(job.videoSources?.length
        ? {
            sources: job.videoSources.map((source) => ({
              ...source,
              credentials: 'include' as const,
            })),
          }
        : {}),
    },
    audio: {
      url: job.audioUrl,
      credentials: 'include',
      ...(job.audioMimeType ? { declaredMimeType: job.audioMimeType } : {}),
      ...(job.audioStreamIdentity ? { streamIdentity: job.audioStreamIdentity } : {}),
      ...(job.audioSources?.length
        ? {
            sources: job.audioSources.map((source) => ({
              ...source,
              credentials: 'include' as const,
            })),
          }
        : {}),
    },
    preferredContainer: 'auto',
    fileName: job.fileName,
    ...((job.title || job.coverUrl) && {
      metadata: {
        ...(job.title ? { title: job.title } : {}),
        ...(job.coverUrl ? { coverUrl: job.coverUrl } : {}),
      },
    }),
  };
}

function currentMergeCoverUrl(state: TabMediaState, video: MediaAsset): string | undefined {
  const active = state.activeMedia;
  const exactActivePoster = active
    ? state.mediaElements.find(
        (element) =>
          element.kind === 'video' &&
          element.elementId === active.elementId &&
          element.lifecycleGeneration === active.lifecycleGeneration &&
          element.frameId === active.frameId,
      )?.poster
    : undefined;
  const sameTrackPoster =
    video.poster ??
    state.mediaElements.find(
      (element) =>
        element.kind === 'video' &&
        element.frameId === video.frameId &&
        (video.duration == null ||
          element.duration == null ||
          Math.abs(video.duration - element.duration) <= 1),
    )?.poster;
  for (const candidate of [exactActivePoster, sameTrackPoster]) {
    if (!candidate || candidate.length > 16_384) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    } catch {
      // A merge job never retains unresolved or non-network poster values.
    }
  }
  return undefined;
}

function withoutMergeRequestRules(job: MergeJob): MergeJob {
  const next = { ...job };
  delete next.requestRuleIds;
  return next;
}

async function mergeDockView(job: MergeJob): Promise<MergeDockView> {
  // An action response can finish after a newer worker notification. Re-read
  // the stored lifecycle rather than publishing the action's stale argument.
  job = (await mergeJobStore.get(job.id)) ?? job;
  const pageUrl = mergeOwnerPageUrl(job);
  const currentPolicy = await getMergeDownloadPathPolicy(pageUrl);
  const [tokens, policy, remembered] = await Promise.all([
    mergeDockGrantBroker.getOrIssue(job),
    job.savePathPolicy ? job.savePathPolicy : currentPolicy,
    presentRememberedMergeDirectory(pageUrl, mergeDirectoryHandleStore),
  ]);
  return {
    ...presentMergeDockJob(job, tokens, presentMergeDownloadPath(pageUrl, policy)),
    saveLocationConfirmationRequired: currentPolicy.mode === 'custom',
    savePreferenceMode: currentPolicy.mode,
    ...(remembered ? { rememberedDirectory: remembered } : {}),
  };
}

async function publishMergeDock(job: MergeJob, open = false): Promise<MergeDockView> {
  const view = await mergeDockView(job);
  if (job.ownerTabId == null) return view;
  try {
    const ownerTab = await chrome.tabs.get(job.ownerTabId);
    if (ownerTab.url !== mergeOwnerPageUrl(job)) return view;
    const ownerState = await getTabState(job.ownerTabId);
    if (
      !ownerState ||
      ownerState.pageUrl !== mergeOwnerPageUrl(job) ||
      (ownerState.mediaEpoch ?? 0) !== (job.ownerMediaEpoch ?? 0)
    )
      return view;
    if (open) {
      await ensureMediaAgent(job.ownerTabId, 0);
      await openMergeWorkspace(job.ownerTabId, view);
    } else {
      await updateMergeWorkspace(job.ownerTabId, view);
    }
  } catch {
    // A closed or navigating source tab must not turn a valid background job
    // into a failure. Reopening the same task will publish its stored state.
  }
  return view;
}

async function restoreMergeDockForTab(state: TabMediaState): Promise<void> {
  await restoreMergeDockForOwner(await mergeJobStore.list(), state, publishMergeDock);
}

function mergeHostPatterns(job: MergeJob): string[] {
  const patterns = new Set<string>();
  for (const raw of [
    job.videoUrl,
    ...(job.videoSources ?? []).map((source) => source.url),
    job.audioUrl,
    ...(job.audioSources ?? []).map((source) => source.url),
  ]) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只支持 http/https 媒体来源');
    }
    patterns.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...patterns];
}

async function hasMergeHostPermissions(job: MergeJob): Promise<boolean> {
  return chrome.permissions.contains({ origins: mergeHostPatterns(job) }).catch(() => false);
}

async function ensureMergeOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [documentUrl],
  });
  if (contexts.length > 0) return;
  if (!creatingMergeOffscreen) {
    creatingMergeOffscreen = chrome.offscreen
      .createDocument({
        url: MERGE_OFFSCREEN_DOCUMENT_PATH,
        reasons: ['WORKERS', 'BLOBS'],
        justification: '在不打开新窗口的情况下流式合并、验证并导出用户选择的媒体。',
      })
      .finally(() => {
        creatingMergeOffscreen = null;
      });
  }
  await creatingMergeOffscreen;
}

async function mergeOffscreenDocumentExists(): Promise<boolean> {
  const documentUrl = chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime
    .getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    })
    .catch(() => []);
  return contexts.length > 0;
}

async function getMergeOffscreenStatus(jobId: string): Promise<MergeOffscreenStatusResponse> {
  if (!(await mergeOffscreenDocumentExists())) return { ok: true, state: 'idle' };
  const response = (await chrome.runtime.sendMessage({
    channel: 'foxfetch-merge-offscreen-v1',
    target: 'offscreen',
    type: 'STATUS',
    jobId,
  } satisfies MergeOffscreenCommand)) as MergeOffscreenStatusResponse | undefined;
  return response?.ok ? response : { ok: true, state: 'idle' };
}

async function sendMergeOffscreenCommand(command: MergeOffscreenCommand): Promise<void> {
  await ensureMergeOffscreenDocument();
  if (['PREFLIGHT', 'START', 'START_SEPARATE', 'SAVE_CUSTOM'].includes(command.type)) {
    await assertMergeTaskAcceptsWork(command.jobId);
    if (mergeCancellationFences.has(command.jobId)) throw new MergeJobCancelledError();
  }
  const response = (await chrome.runtime.sendMessage(command)) as
    { ok?: boolean; queued?: boolean } | undefined;
  if (!response?.ok) throw new Error('后台合并程序未响应。');
}

async function sendPageStageOffscreenCommand(
  command: Extract<
    MergeOffscreenCommand,
    {
      type: 'PAGE_STAGE_BEGIN' | 'PAGE_STAGE_CHUNK' | 'PAGE_STAGE_COMMIT' | 'PAGE_STAGE_ABORT';
    }
  >,
): Promise<{ persistedBytes?: number; trackBytes?: number; readBytes?: number }> {
  await ensureMergeOffscreenDocument();
  if (command.type !== 'PAGE_STAGE_ABORT') await assertMergeTaskAcceptsWork(command.jobId);
  if (command.type !== 'PAGE_STAGE_ABORT' && mergeCancellationFences.has(command.jobId))
    throw new MergeJobCancelledError();
  const response = (await chrome.runtime.sendMessage(command)) as
    | {
        ok?: boolean;
        persistedBytes?: number;
        trackBytes?: number;
        readBytes?: number;
        error?: string;
      }
    | undefined;
  if (!response?.ok) throw new Error(response?.error || '后台合并程序无法接收页面缓存。');
  return response;
}

async function ensureMergeRequestContext(job: MergeJob): Promise<MergeJob> {
  await assertMergeTaskAcceptsWork(job.id);
  if (job.requestRuleIds?.length) {
    await releaseMediaRequestContexts(job.requestRuleIds).catch(() => undefined);
  }
  const lease = new MergeJobRequestContextLease();
  mergeJobRequestLeases.set(job.id, lease);
  const requestRuleIds = await lease.ensure(job);
  try {
    await assertMergeTaskAcceptsWork(job.id);
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  const protectedJob: MergeJob = touchMergeJob({
    ...withoutMergeRequestRules(job),
    ...(requestRuleIds.length > 0 ? { requestRuleIds } : {}),
  });
  await mergeJobStore.save(protectedJob);
  return protectedJob;
}

async function releaseMergeRequestContext(job: MergeJob): Promise<MergeJob> {
  const lease = mergeJobRequestLeases.get(job.id);
  mergeJobRequestLeases.delete(job.id);
  if (lease) await lease.release().catch(() => undefined);
  else if (job.requestRuleIds?.length) {
    await releaseMediaRequestContexts(job.requestRuleIds).catch(() => undefined);
  }
  const clean = withoutMergeRequestRules(job);
  if (job.requestRuleIds?.length) await mergeJobStore.save(clean);
  return clean;
}

function advanceMergeJob(
  job: MergeJob,
  target: 'fetching' | 'muxing' | 'saving' | 'verifying',
): MergeJob {
  const order: Array<'fetching' | 'muxing' | 'saving' | 'verifying'> = [
    'fetching',
    'muxing',
    'saving',
    'verifying',
  ];
  let next = job;
  const targetIndex = order.indexOf(target);
  for (const state of order.slice(0, targetIndex + 1)) {
    if (next.state === state) continue;
    const currentIndex = order.indexOf(next.state as (typeof order)[number]);
    if (currentIndex > order.indexOf(state)) continue;
    if (next.state === 'ready' || order.includes(next.state as (typeof order)[number])) {
      next = transitionMergeJob(next, state);
    }
  }
  return next;
}

function mergeProgressState(
  phase: RemuxProgress['phase'],
): 'fetching' | 'muxing' | 'saving' | 'verifying' | null {
  if (phase === 'fetching') return 'fetching';
  if (phase === 'muxing') return 'muxing';
  if (phase === 'saving') return 'saving';
  if (phase === 'verifying') return 'verifying';
  return null;
}

async function failMergeJob(job: MergeJob, failure: MergeFailureDetail): Promise<MergeJob> {
  const current = (await mergeJobStore.get(job.id)) ?? job;
  if (mergeCancellationFences.has(job.id) || !mergeJobAcceptsWork(current)) return current;
  job = current;
  let failed: MergeJob;
  const target: MergeJobState =
    failure.code === 'DRM_PROTECTED' && canTransitionMergeJob(job.state, 'blocked_drm')
      ? 'blocked_drm'
      : 'failed';
  if (canTransitionMergeJob(job.state, target)) {
    failed = transitionMergeJob(job, target, {
      failure,
      progress: { ...job.progress, ratio: null, message: failure.message },
    });
  } else {
    failed = touchMergeJob({
      ...job,
      state: target,
      failure,
      progress: { ...job.progress, ratio: null, message: failure.message },
    });
  }
  failed = await releaseMergeRequestContext(failed);
  await mergeJobStore.save(failed);
  await publishMergeDock(failed);
  return failed;
}

const mergePreflightTasks = new Map<string, Promise<void>>();

function startMergePreflight(jobId: string): Promise<void> {
  const existing = mergePreflightTasks.get(jobId);
  if (existing) return existing;
  const task = startMergePreflightInternal(jobId)
    .catch((error: unknown) => {
      if (error instanceof MergeJobCancelledError || mergeCancellationFences.has(jobId)) return;
      throw error;
    })
    .finally(() => {
      if (mergePreflightTasks.get(jobId) === task) mergePreflightTasks.delete(jobId);
    });
  mergePreflightTasks.set(jobId, task);
  return task;
}

async function startMergePreflightInternal(jobId: string): Promise<void> {
  let job = await mergeJobStore.get(jobId);
  if (
    !job ||
    !mergeJobAcceptsWork(job) ||
    mergeCancellationFences.has(jobId) ||
    ['ready', 'fetching', 'muxing', 'saving', 'verifying', 'completed'].includes(job.state)
  ) {
    return;
  }
  if (!canTransitionMergeJob(job.state, 'resolving')) return;
  job = transitionMergeJob(job, 'resolving', {
    progress: {
      phase: 'idle',
      ratio: null,
      readBytes: 0,
      totalBytes: null,
      message: '正在后台自动检查媒体兼容性…',
    },
  });
  await mergeJobStore.save(job);
  await publishMergeDock(job);

  try {
    const hasPermission = await hasMergeHostPermissions(job);
    await assertMergeTaskAcceptsWork(job.id);
    if (!hasPermission) {
      const denied = transitionMergeJob(job, 'permission_required', {
        failure: {
          code: 'HOST_PERMISSION_REQUIRED',
          message: '需要媒体来源网站权限；授权后会自动继续。',
          retryable: true,
          canDownloadSeparately: true,
        },
        progress: { ...job.progress, message: '等待媒体来源网站权限' },
      });
      await mergeJobStore.save(denied);
      await publishMergeDock(denied);
      return;
    }
    job = await ensureMergeRequestContext(job);
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PREFLIGHT',
      jobId: job.id,
      request: mergeRequestFromJob(job),
    });
  } catch (error) {
    await failMergeJob(job, {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      canDownloadSeparately: true,
    });
  }
}

async function createMergeJob(
  state: TabMediaState,
  video: MediaAsset,
  audio: MediaAsset,
  requestedJobId?: string,
  tracks?: { videoTrack: MediaProductTrack; audioTrack: MediaProductTrack },
  deferPreflight = false,
): Promise<MergeJobCreated> {
  if (isYouTubePage(state.pageUrl))
    throw new Error('YouTube 完整下载尚未验证，本版仅提供来源识别。');
  if (!video.downloadable || !audio.downloadable) {
    throw new Error('Blob 或受限媒体不能直接进入合并任务');
  }
  const jobId = requestedJobId ?? crypto.randomUUID();
  if (!tracks) {
    for (const product of mediaDockProducts(state)) {
      const videoTrack = product.videoTracks.find((track) =>
        track.sources.some((source) => source.id === video.id),
      );
      const audioTrack = product.audioTracks.find((track) =>
        track.sources.some((source) => source.id === audio.id),
      );
      if (videoTrack && audioTrack) {
        tracks = { videoTrack, audioTrack };
        break;
      }
    }
  }
  const existing = requestedJobId ? await mergeJobStore.get(jobId) : undefined;
  if (existing?.cancellationRequestedAt != null || existing?.state === 'cancelled') {
    return createMergeJob(state, video, audio, undefined, tracks, deferPreflight);
  }
  if (
    existing &&
    existing.state !== 'failed' &&
    existing.state !== 'completed' &&
    existing.state !== 'blocked_drm'
  ) {
    await publishMergeDock(existing, true);
    if (!deferPreflight) void startMergePreflight(existing.id);
    return { jobId };
  }
  if (existing) {
    // A new user action must be rebuilt from the currently validated product;
    // never revive signed URLs or track choices from a terminal attempt.
    await mergeDockGrantBroker.clearJob(existing.id).catch(() => undefined);
    await mergeJobStore.remove(existing.id).catch(() => undefined);
  }
  const equivalentSources = (
    primary: MediaAsset,
    track: MediaProductTrack | undefined,
  ): MergeJobSourceLocation[] => {
    const seen = new Set([primary.url]);
    const locations: MergeJobSourceLocation[] = [];
    for (const source of track?.sources ?? []) {
      if (!source.downloadable || seen.has(source.url)) continue;
      try {
        const url = new URL(source.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      } catch {
        continue;
      }
      seen.add(source.url);
      locations.push({
        url: source.url,
        ...(source.mime ? { declaredMimeType: source.mime } : {}),
      });
      if (locations.length >= 15) break;
    }
    return locations;
  };
  const videoSources = equivalentSources(video, tracks?.videoTrack);
  const audioSources = equivalentSources(audio, tracks?.audioTrack);
  const coverUrl = currentMergeCoverUrl(state, video);
  const videoRepresentation = tracks?.videoTrack.representation ?? video.representation;
  const seed: MergeJobSeed = {
    id: jobId,
    ...(tracks
      ? {
          repeatSelection: {
            videoTrackId: tracks.videoTrack.id,
            audioTrackId: tracks.audioTrack.id,
          },
        }
      : {}),
    videoUrl: video.url,
    audioUrl: audio.url,
    ...(videoSources.length > 0 ? { videoSources } : {}),
    ...(audioSources.length > 0 ? { audioSources } : {}),
    ...(tracks?.videoTrack.streamIdentity
      ? { videoStreamIdentity: tracks.videoTrack.streamIdentity }
      : {}),
    ...(tracks?.audioTrack.streamIdentity
      ? { audioStreamIdentity: tracks.audioTrack.streamIdentity }
      : {}),
    ...(video.mime ? { videoMimeType: video.mime } : {}),
    ...(audio.mime ? { audioMimeType: audio.mime } : {}),
    ...(videoRepresentation?.provider === 'bilibili' && videoRepresentation.dynamicRange
      ? {
          videoDynamicRange: videoRepresentation.dynamicRange,
          videoDynamicRangeRemuxable:
            videoRepresentation.capabilities?.remuxable ??
            (videoRepresentation.dynamicRange === 'Dolby Vision' ? 'unsupported' : 'unknown'),
        }
      : {}),
    ...(coverUrl ? { coverUrl } : {}),
    videoContext: {
      pageUrl: video.pageUrl || state.pageUrl,
      ...(video.requestHeaders ? { requestHeaders: { ...video.requestHeaders } } : {}),
    },
    audioContext: {
      pageUrl: audio.pageUrl || state.pageUrl,
      ...(audio.requestHeaders ? { requestHeaders: { ...audio.requestHeaders } } : {}),
    },
    title: state.pageTitle,
    ownerTabId: state.tabId,
    ownerPageUrl: state.pageUrl,
    ownerMediaEpoch: state.mediaEpoch ?? 0,
    createdAt: Date.now(),
  };
  const job = await saveMergeJobSeed(seed);
  await publishMergeDock(job, true);
  if (!deferPreflight) void startMergePreflight(job.id);
  return { jobId };
}

function mergeFailure(message: string, code: MergeFailureDetail['code'] = 'INTERNAL_ERROR') {
  return {
    code,
    message,
    retryable: true,
    canDownloadSeparately: true,
  } satisfies MergeFailureDetail;
}

interface BilibiliMergeIdentity {
  bvid: string;
  cid: string;
  value: string;
}

interface PageFallbackCandidate {
  url: string;
  kind: 'video' | 'audio';
  representationKey: string;
  declaredSize?: number;
}

interface PageFallbackLease {
  jobId: string;
  tabId: number;
  pageUrl: string;
  navigationEpoch: number;
  mediaEpoch: number;
  documentId: string;
  identity: BilibiliMergeIdentity;
  cancellationId: string;
}

interface PageFallbackChunk {
  candidate: PageFallbackCandidate;
  result: Extract<BilibiliPageRangeResult, { ok: true }>;
}

const mergePageFallbackTasks = new Map<string, Promise<void>>();
const mergePageFallbackLeases = new Map<string, PageFallbackLease>();

function parseBilibiliMergeIdentity(value: string | undefined): BilibiliMergeIdentity | undefined {
  if (!value) return undefined;
  const [provider, rawBvid, rawCid, extra] = value.split(':');
  const bvid = rawBvid?.trim().toUpperCase();
  const cid = rawCid?.trim().replace(/^0+(?=\d)/u, '');
  if (
    provider !== 'bilibili' ||
    extra != null ||
    !bvid ||
    !/^BV[0-9A-Z]+$/u.test(bvid) ||
    !cid ||
    !/^\d+$/u.test(cid) ||
    cid === '0'
  ) {
    return undefined;
  }
  return { bvid, cid, value: `bilibili:${bvid}:${cid}` };
}

function pageFallbackCandidates(
  job: MergeJob,
  state: TabMediaState,
  identity: BilibiliMergeIdentity,
  kind: 'video' | 'audio',
): PageFallbackCandidate[] {
  const primaryUrl = kind === 'video' ? job.videoUrl : job.audioUrl;
  const sourceUrls = [
    primaryUrl,
    ...((kind === 'video' ? job.videoSources : job.audioSources) ?? []).map((source) => source.url),
  ];
  const matchingAssets = state.assets.filter(
    (asset) =>
      asset.kind === kind &&
      sourceUrls.includes(asset.url) &&
      isAllowedBilibiliMediaUrl(asset.url) &&
      asset.representation?.provider === 'bilibili' &&
      asset.representation.bvid?.toUpperCase() === identity.bvid &&
      asset.representation.cid === identity.cid &&
      typeof asset.representation.key === 'string' &&
      asset.representation.key.length > 0 &&
      asset.representation.key.length <= 256,
  );
  const primaryKeys = new Set(
    matchingAssets
      .filter((asset) => asset.url === primaryUrl)
      .map((asset) => asset.representation!.key),
  );
  if (primaryKeys.size !== 1) return [];
  const representationKey = [...primaryKeys][0]!;
  const candidates: PageFallbackCandidate[] = [];
  const seen = new Set<string>();
  for (const url of sourceUrls) {
    if (seen.has(url)) continue;
    const assets = matchingAssets.filter(
      (asset) => asset.url === url && asset.representation?.key === representationKey,
    );
    if (assets.length === 0) continue;
    const declaredSizes = new Set(
      assets
        .map((asset) => asset.size)
        .filter((size): size is number => Number.isSafeInteger(size) && Number(size) > 0),
    );
    if (declaredSizes.size > 1) continue;
    seen.add(url);
    candidates.push({
      url,
      kind,
      representationKey,
      ...(declaredSizes.size === 1 ? { declaredSize: [...declaredSizes][0] } : {}),
    });
  }
  return candidates;
}

async function assertPageFallbackCurrent(
  lease: PageFallbackLease,
  candidate?: PageFallbackCandidate,
): Promise<{ job: MergeJob; state: TabMediaState }> {
  await assertTabOperationCurrent(
    lease.tabId,
    lease.navigationEpoch,
    lease.pageUrl,
    lease.mediaEpoch,
  );
  const currentDocumentId = tabFrameDocuments.get(lease.tabId)?.get(0);
  if (
    currentDocumentId !== lease.documentId ||
    retiredTabDocuments.get(lease.tabId)?.has(lease.documentId)
  ) {
    throw new StaleTabOperationError();
  }
  const [job, state] = await Promise.all([
    mergeJobStore.get(lease.jobId),
    getTabState(lease.tabId),
  ]);
  if (
    !job ||
    job.state !== 'resolving' ||
    !mergeJobAcceptsWork(job) ||
    mergeCancellationFences.has(job.id) ||
    job.pageAssistedAttempted !== true ||
    job.ownerTabId !== lease.tabId ||
    mergeOwnerPageUrl(job) !== lease.pageUrl ||
    (job.ownerMediaEpoch ?? 0) !== lease.mediaEpoch ||
    !hasRetainedMergeJobSources(job) ||
    !state ||
    state.pageUrl !== lease.pageUrl ||
    (state.mediaEpoch ?? 0) !== lease.mediaEpoch ||
    state.providerIdentity !== lease.identity.value
  ) {
    throw new StaleTabOperationError();
  }
  if (candidate) {
    const stillOwned = state.assets.some(
      (asset) =>
        asset.url === candidate.url &&
        asset.kind === candidate.kind &&
        asset.representation?.provider === 'bilibili' &&
        asset.representation.bvid?.toUpperCase() === lease.identity.bvid &&
        asset.representation.cid === lease.identity.cid &&
        asset.representation.key === candidate.representationKey,
    );
    if (!stillOwned) throw new StaleTabOperationError();
  }
  return { job, state };
}

async function fetchPageFallbackChunk(
  lease: PageFallbackLease,
  candidate: PageFallbackCandidate,
  start: number,
  end: number,
  revision?: number,
): Promise<Extract<BilibiliPageRangeResult, { ok: true }>> {
  await assertPageFallbackCurrent(lease, candidate);
  const request: BilibiliPageRangeRequest = {
    cancellationId: lease.cancellationId,
    bvid: lease.identity.bvid,
    cid: lease.identity.cid,
    ...(revision == null ? {} : { revision }),
    url: candidate.url,
    kind: candidate.kind,
    representationKey: candidate.representationKey,
    start,
    end,
  };
  const executions = await chrome.scripting.executeScript<
    [BilibiliPageRangeRequest],
    Promise<BilibiliPageRangeResult>
  >({
    target: { tabId: lease.tabId, documentIds: [lease.documentId] },
    world: 'MAIN',
    func: fetchCapturedBilibiliPageRangeMainWorld,
    args: [request],
  });
  const execution = executions.length === 1 ? executions[0] : undefined;
  const result = execution?.result;
  await assertPageFallbackCurrent(lease, candidate);
  if (execution?.documentId !== lease.documentId || !result?.ok) {
    const status = result && !result.ok && result.status != null ? ` HTTP ${result.status}` : '';
    const code = result && !result.ok ? result.code : 'NO_RESULT';
    throw new Error(`页面辅助分片校验失败（${code}${status}）。`);
  }
  const expectedBase64Length = Math.ceil(result.contentLength / 3) * 4;
  if (
    result.status !== 206 ||
    result.bvid !== lease.identity.bvid ||
    result.cid !== lease.identity.cid ||
    result.url !== candidate.url ||
    result.kind !== candidate.kind ||
    result.representationKey !== candidate.representationKey ||
    result.start !== start ||
    result.end > end ||
    result.contentLength !== result.end - result.start + 1 ||
    result.total <= result.end ||
    result.total > BILIBILI_PAGE_RANGE_MAX_TRACK_BYTES ||
    (candidate.declaredSize != null && result.total !== candidate.declaredSize) ||
    (revision != null && result.revision !== revision) ||
    typeof result.bytesBase64 !== 'string' ||
    result.bytesBase64.length !== expectedBase64Length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result.bytesBase64)
  ) {
    throw new Error('页面辅助分片的身份、范围或长度复核失败。');
  }
  return result;
}

async function findInitialPageFallbackChunk(
  lease: PageFallbackLease,
  candidates: PageFallbackCandidate[],
  revision?: number,
): Promise<PageFallbackChunk> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const result = await fetchPageFallbackChunk(
        lease,
        candidate,
        0,
        BILIBILI_PAGE_RANGE_CHUNK_BYTES - 1,
        revision,
      );
      return { candidate, result };
    } catch (error) {
      if (error instanceof StaleTabOperationError) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('当前页面没有找到与所选轨道对应的缓存。');
}

async function publishPageFallbackProgress(
  lease: PageFallbackLease,
  readBytes: number,
  totalBytes: number,
): Promise<void> {
  const { job } = await assertPageFallbackCurrent(lease);
  const next: MergeJob = touchMergeJob({
    ...job,
    progress: {
      phase: 'fetching',
      ratio: totalBytes > 0 ? Math.min(1, readBytes / totalBytes) : null,
      readBytes,
      totalBytes,
      message: '后台直链受限，正在由当前页面安全分段读取媒体…',
    },
  });
  await mergeJobStore.save(next);
  await publishMergeDock(next);
}

async function runBilibiliPageFallback(
  initialJob: MergeJob,
  originalFailure: MergeFailureDetail,
): Promise<void> {
  const tabId = initialJob.ownerTabId;
  const pageUrl = mergeOwnerPageUrl(initialJob);
  const videoIdentity = parseBilibiliMergeIdentity(initialJob.videoStreamIdentity);
  const audioIdentity = parseBilibiliMergeIdentity(initialJob.audioStreamIdentity);
  const documentId = tabId == null ? undefined : tabFrameDocuments.get(tabId)?.get(0);
  const mediaEpoch = initialJob.ownerMediaEpoch;
  if (
    tabId == null ||
    !pageUrl ||
    !videoIdentity ||
    !audioIdentity ||
    videoIdentity.value !== audioIdentity.value ||
    !documentId ||
    mediaEpoch == null ||
    originalFailure.httpStatus !== 403
  ) {
    await failMergeJob(initialJob, originalFailure);
    return;
  }
  const lease: PageFallbackLease = {
    jobId: initialJob.id,
    tabId,
    pageUrl,
    navigationEpoch: navigationEpoch(tabId),
    mediaEpoch,
    documentId,
    identity: videoIdentity,
    cancellationId: crypto.randomUUID(),
  };
  mergePageFallbackLeases.set(initialJob.id, lease);
  const stageId = crypto.randomUUID();
  let stageBegun = false;
  let stageCommitted = false;
  try {
    const { job, state } = await assertPageFallbackCurrent(lease);
    const request = mergeRequestFromJob(job);
    if (request.drmSignals?.length) throw new Error('DRM 媒体不能进入页面辅助下载。');
    const videoCandidates = pageFallbackCandidates(job, state, videoIdentity, 'video');
    const audioCandidates = pageFallbackCandidates(job, state, videoIdentity, 'audio');
    if (videoCandidates.length === 0 || audioCandidates.length === 0) {
      throw new Error('当前页面没有找到与本次任务所选视频和音频一致的 Bilibili 媒体来源。');
    }

    const firstVideo = await findInitialPageFallbackChunk(lease, videoCandidates);
    const firstAudio = await findInitialPageFallbackChunk(
      lease,
      audioCandidates,
      firstVideo.result.revision,
    );
    if (firstAudio.result.revision !== firstVideo.result.revision) {
      throw new Error('页面缓存中的视频和音频来自不同版本的媒体信息。');
    }
    const totalBytes = firstVideo.result.total + firstAudio.result.total;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new Error('页面辅助媒体总大小无效。');
    }

    await sendPageStageOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PAGE_STAGE_BEGIN',
      jobId: job.id,
      stageId,
      request,
    });
    stageBegun = true;
    let readBytes = 0;
    let lastProgressAt = 0;
    const append = async (chunk: PageFallbackChunk): Promise<void> => {
      const response = await sendPageStageOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'PAGE_STAGE_CHUNK',
        jobId: job.id,
        stageId,
        track: chunk.candidate.kind,
        offset: chunk.result.start,
        totalBytes: chunk.result.total,
        byteLength: chunk.result.contentLength,
        bytesBase64: chunk.result.bytesBase64,
      });
      if (
        response.persistedBytes !== chunk.result.contentLength ||
        response.trackBytes !== chunk.result.end + 1
      ) {
        throw new Error('后台合并程序未能确认所有页面缓存片段已接收完成。');
      }
      readBytes += chunk.result.contentLength;
      const now = Date.now();
      if (now - lastProgressAt >= 500 || readBytes === totalBytes) {
        lastProgressAt = now;
        await publishPageFallbackProgress(lease, readBytes, totalBytes);
      }
    };
    await append(firstVideo);
    await append(firstAudio);

    const downloadRemainder = async (first: PageFallbackChunk): Promise<void> => {
      let offset = first.result.end + 1;
      const validator = first.result.resourceValidator;
      while (offset < first.result.total) {
        const result = await fetchPageFallbackChunk(
          lease,
          first.candidate,
          offset,
          Math.min(first.result.total - 1, offset + BILIBILI_PAGE_RANGE_CHUNK_BYTES - 1),
          first.result.revision,
        );
        if (
          result.total !== first.result.total ||
          (result.resourceValidator ?? null) !== (validator ?? null)
        ) {
          throw new Error('页面辅助媒体资源在分段读取期间发生变化。');
        }
        await append({ candidate: first.candidate, result });
        offset = result.end + 1;
      }
    };
    // Sequential transfer keeps at most one JSON/base64 chunk in the service worker.
    await downloadRemainder(firstVideo);
    await downloadRemainder(firstAudio);
    await assertPageFallbackCurrent(lease);
    const committed = await sendPageStageOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PAGE_STAGE_COMMIT',
      jobId: job.id,
      stageId,
    });
    if (committed.readBytes !== totalBytes) {
      throw new Error('页面辅助缓存提交大小不匹配。');
    }
    stageCommitted = true;
    await assertPageFallbackCurrent(lease);
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PREFLIGHT',
      jobId: job.id,
      request,
    });
  } catch (error) {
    if (stageBegun && !stageCommitted) {
      await sendPageStageOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'PAGE_STAGE_ABORT',
        jobId: initialJob.id,
        stageId,
      }).catch(() => undefined);
    } else if (stageCommitted) {
      await sendMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'CLEANUP',
        jobId: initialJob.id,
      }).catch(() => undefined);
    }
    const current = await mergeJobStore.get(initialJob.id);
    if (
      current?.state === 'resolving' &&
      mergeJobAcceptsWork(current) &&
      !mergeCancellationFences.has(current.id)
    ) {
      await failMergeJob(current, {
        code: 'NETWORK_FAILED',
        message:
          error instanceof StaleTabOperationError
            ? '页面或播放器已切换，页面辅助下载已安全停止并清理。'
            : `页面辅助下载失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        canDownloadSeparately: true,
      });
    }
  } finally {
    if (mergePageFallbackLeases.get(initialJob.id) === lease)
      mergePageFallbackLeases.delete(initialJob.id);
  }
}

async function handleMergeCapability(
  event: Extract<MergeOffscreenEvent, { type: 'CAPABILITY' }>,
): Promise<void> {
  let job = await mergeJobStore.get(event.jobId);
  if (
    !job ||
    job.state !== 'resolving' ||
    !mergeJobAcceptsWork(job) ||
    mergeCancellationFences.has(job.id)
  )
    return;
  if (event.capability.canMerge) {
    job = transitionMergeJob(job, 'ready', {
      plan: event.capability.plan,
      progress: {
        phase: 'idle',
        ratio: 0,
        readBytes: 0,
        totalBytes: event.capability.plan.estimatedInputBytes,
        message: '检查完成，可以合并下载。',
      },
    });
    job = await releaseMergeRequestContext(job);
    await mergeJobStore.save(job);
    await publishMergeDock(job);
    // Only a completed task's explicit repeat click may continue automatically.
    // Initial panel opening and its existing eager preflight are unchanged.
    if (job.repeatAction === 'merge') {
      await startMergeExecution(job);
    } else if (job.repeatAction === 'separate') {
      await startSeparateExportExecution(job);
    }
    return;
  }
  const failure = event.capability.failure;
  if (
    !job.pageAssistedAttempted &&
    failure.httpStatus === 403 &&
    (failure.code === 'NETWORK_FAILED' || failure.code === 'SOURCE_UNREADABLE') &&
    !mergePageFallbackTasks.has(job.id)
  ) {
    // The page fetch uses only browser-managed ambient credentials. Remove the
    // merge DNR lease first so captured Authorization/Origin headers cannot be
    // injected into this fallback request.
    job = await releaseMergeRequestContext(job);
    job = touchMergeJob({
      ...job,
      pageAssistedAttempted: true,
      progress: {
        ...job.progress,
        phase: 'fetching',
        ratio: null,
        message: '媒体服务器拒绝了下载请求（403），正在检查能否通过当前页面分段读取。',
      },
    });
    await mergeJobStore.save(job);
    await publishMergeDock(job);
    const fallbackJob = job;
    const task = runBilibiliPageFallback(fallbackJob, failure).finally(() => {
      if (mergePageFallbackTasks.get(fallbackJob.id) === task) {
        mergePageFallbackTasks.delete(fallbackJob.id);
      }
    });
    mergePageFallbackTasks.set(fallbackJob.id, task);
    void task;
    return;
  }
  await failMergeJob(job, event.capability.failure);
}

async function handleMergeProgress(
  event: Extract<MergeOffscreenEvent, { type: 'PROGRESS' }>,
): Promise<void> {
  const current = await mergeJobStore.get(event.jobId);
  if (
    !current ||
    !mergeJobAcceptsWork(current) ||
    mergeCancellationFences.has(current.id) ||
    !['resolving', 'fetching', 'muxing', 'saving', 'verifying'].includes(current.state)
  )
    return;
  let job = current;
  const target = mergeProgressState(event.progress.phase);
  if (target && current.state !== 'resolving') job = advanceMergeJob(job, target);
  job = updateMergeJobProgress(job, {
    phase: event.progress.phase,
    ratio: event.progress.ratio,
    readBytes: event.progress.readBytes ?? job.progress.readBytes,
    totalBytes: event.progress.totalBytes ?? job.progress.totalBytes,
    message: event.progress.message,
    ...(event.progress.stage ? { stage: event.progress.stage } : {}),
    ...((event.progress.network ?? job.progress.network)
      ? { network: event.progress.network ?? job.progress.network! }
      : {}),
    lastProgressAt: Date.now(),
  });
  const now = Date.now();
  const last = mergeProgressPublishedAt.get(job.id) ?? 0;
  const stateChanged = current.state !== job.state;
  if (!stateChanged && now - last < 300 && event.progress.ratio !== 1) return;
  mergeProgressPublishedAt.set(job.id, now);
  await mergeJobStore.save(job);
  await publishMergeDock(job);
}

function mergeOutputName(job: MergeJob, extension: string): string {
  const title = sanitizeFilename(
    normalizeMediaTitle(job.title ?? job.fileName, mergeOwnerPageUrl(job)),
    'FoxFetch-media',
  );
  return title.toLowerCase().endsWith(extension.toLowerCase()) ? title : `${title}${extension}`;
}

async function hasPendingMergeExportForJob(jobId: string): Promise<boolean> {
  const stored = await chrome.storage.session.get(null);
  return (
    isPendingCustomExport(stored[pendingCustomExportKey(jobId)]) ||
    Object.entries(stored).some(
      ([storageKey, value]) =>
        storageKey.startsWith(MERGE_EXPORT_STORAGE_PREFIX) &&
        isPendingMergeExport(value) &&
        value.jobId === jobId,
    )
  );
}

async function startVerifiedMergeDownload(
  event: Extract<MergeOffscreenEvent, { type: 'COMPLETED' }>,
): Promise<void> {
  if (mergeExportStarts.has(event.jobId)) return;
  mergeExportStarts.add(event.jobId);
  const task = (async () => {
    if (await hasPendingMergeExportForJob(event.jobId)) return;
    await startVerifiedMergeDownloadUnlocked(event);
  })();
  mergePublicationTasks.set(event.jobId, task);
  try {
    await task;
  } finally {
    mergeExportStarts.delete(event.jobId);
    if (mergePublicationTasks.get(event.jobId) === task) mergePublicationTasks.delete(event.jobId);
  }
}

async function startVerifiedMergeDownloadUnlocked(
  event: Extract<MergeOffscreenEvent, { type: 'COMPLETED' }>,
): Promise<void> {
  let job = await mergeJobStore.get(event.jobId);
  if (
    !job ||
    !mergeJobAcceptsWork(job) ||
    mergeCancellationFences.has(job.id) ||
    !['fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state)
  ) {
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'CLEANUP',
      jobId: event.jobId,
    }).catch(() => undefined);
    return;
  }
  if (job.state === 'paused') {
    job = transitionMergeJob(job, job.resumeState ?? 'fetching');
  }
  job = advanceMergeJob(job, 'verifying');
  job = updateMergeJobProgress(job, {
    phase: 'verifying',
    ratio: 1,
    readBytes: job.progress.readBytes,
    totalBytes: job.progress.totalBytes,
    message: '文件检查已完成，正在请求浏览器保存。',
  });
  job.publicationPending = true;
  await mergeJobStore.save(job);
  await publishMergeDock(job);

  const pageUrl = mergeOwnerPageUrl(job);
  const policy = await publicationSavePolicy(pageUrl, job.savePathPolicy);
  const fileName = mergeOutputName(job, event.result.plan.extension);
  const relativeName = `${buildDownloadDirectory(pageUrl, 'video')}/${fileName}`;
  const recordFilename =
    policy.mode === 'custom' ? `${policy.directory.name}/${fileName}` : relativeName;
  const now = Date.now();
  const record: DownloadRecord = {
    id: crypto.randomUUID(),
    assetId: `local-merge-${crypto.randomUUID()}`,
    filename: recordFilename,
    url: chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH),
    kind: 'video',
    state: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  await upsertDownloadRecord(record);

  try {
    await assertMergeTaskAcceptsWork(job.id);
    if (policy.mode === 'custom') {
      const pending: PendingCustomExport = {
        jobId: job.id,
        handleId: policy.directory.handleId,
        mode: 'merge',
        outputs: {
          merge: {
            kind: 'merge',
            fileName,
            expectedSizeBytes: event.result.verification.sizeBytes,
            record,
          },
        },
      };
      await chrome.storage.session.set({ [pendingCustomExportKey(job.id)]: pending });
      await sendMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'SAVE_CUSTOM',
        jobId: job.id,
        handleId: policy.directory.handleId,
        fileNames: { merge: fileName },
      });
      return;
    }
    const chromeDownloadId = await chrome.downloads.download({
      url: event.blobUrl,
      filename: relativeName,
      saveAs: policy.mode === 'ask',
      conflictAction: 'uniquify',
    });
    const pending: PendingMergeExport = {
      jobId: job.id,
      blobUrl: event.blobUrl,
      outputSizeBytes: event.result.verification.sizeBytes,
      recordId: record.id,
    };
    await Promise.all([
      chrome.storage.session.set({ [pendingMergeExportKey(chromeDownloadId)]: pending }),
      upsertDownloadRecord({
        ...record,
        chromeDownloadId,
        state: 'downloading',
        updatedAt: Date.now(),
      }),
    ]);
    if (
      mergeCancellationFences.has(job.id) ||
      !mergeJobAcceptsWork((await mergeJobStore.get(job.id)) ?? job)
    ) {
      await stopPublishedBrowserDownloads(job.id);
      return;
    }
    try {
      const item = (await chrome.downloads.search({ id: chromeDownloadId }))[0];
      if (item?.state === 'complete' || item?.state === 'interrupted') {
        await finalizeMergeExport(chromeDownloadId, item.state, item.error);
      }
    } catch {
      // downloads.onChanged remains authoritative where search is unavailable.
    }
  } catch (error) {
    await chrome.storage.session.remove(pendingCustomExportKey(job.id));
    await upsertDownloadRecord({
      ...record,
      state: 'interrupted',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    });
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'CLEANUP',
      jobId: job.id,
    }).catch(() => undefined);
    await failMergeJob(
      job,
      mergeFailure(error instanceof Error ? error.message : String(error), 'OUTPUT_WRITE_FAILED'),
    );
  }
}

async function finalizeMergeExport(
  downloadId: number,
  state: 'complete' | 'interrupted',
  error?: string,
): Promise<void> {
  const storageKey = pendingMergeExportKey(downloadId);
  const stored = (await chrome.storage.session.get(storageKey))[storageKey] as
    PendingMergeExport | undefined;
  if (!stored) return;
  await chrome.storage.session.remove(storageKey);
  let job = await mergeJobStore.get(stored.jobId);
  if (job) {
    if (state === 'complete' && job.state !== 'completed') {
      job = transitionMergeJob(
        { ...job, state: 'verifying', publicationCommitted: true },
        'completed',
        {
          outputSizeBytes: stored.outputSizeBytes,
          progress: {
            ...job.progress,
            ratio: 1,
            message: '保存成功',
          },
        },
      );
      job = await releaseMergeRequestContext(job);
      await mergeJobStore.save(job);
      await publishMergeDock(job);
    } else if (state === 'interrupted') {
      await failMergeJob(
        job,
        mergeFailure(
          error ? `浏览器保存失败：${error}` : '浏览器未能保存合并文件',
          'OUTPUT_WRITE_FAILED',
        ),
      );
    }
  }
  await sendMergeOffscreenCommand({
    channel: 'foxfetch-merge-offscreen-v1',
    target: 'offscreen',
    type: 'CLEANUP',
    jobId: stored.jobId,
  }).catch(() => undefined);
}

function standardSeparateOutputLabel(kind: StandardSeparateOutputKind): string {
  return kind === 'video' ? '视频 MP4' : '原音轨';
}

function groupOutputFromOutcome(
  outcome: StandardSeparateOutputOutcome,
): PendingSeparateGroupOutput {
  return outcome.status === 'completed'
    ? {
        kind: outcome.kind,
        state: 'starting',
        outputSizeBytes: outcome.verification.sizeBytes,
      }
    : {
        kind: outcome.kind,
        state: 'failed',
        error: outcome.failure.message,
        failure: outcome.failure,
      };
}

function separateOutcomeByKind(
  result: CompletedStandardSeparateExport,
  kind: StandardSeparateOutputKind,
): StandardSeparateOutputOutcome {
  const outcome = result.outcomes.find((candidate) => candidate.kind === kind);
  return (
    outcome ?? {
      status: 'failed',
      kind,
      failure: mergeFailure(
        `${standardSeparateOutputLabel(kind)} 的转换结果缺失`,
        'OUTPUT_WRITE_FAILED',
      ),
    }
  );
}

async function settlePendingSeparateGroup(group: PendingSeparateExportGroup): Promise<void> {
  const outputs = Object.values(group.outputs);
  if (outputs.some((output) => output.state === 'starting' || output.state === 'downloading')) {
    await chrome.storage.session.set({ [pendingSeparateExportGroupKey(group.jobId)]: group });
    return;
  }

  await chrome.storage.session.remove(pendingSeparateExportGroupKey(group.jobId));
  let job = await mergeJobStore.get(group.jobId);
  if (job) {
    const completed = outputs.filter((output) => output.state === 'complete');
    const failed = outputs.filter((output) => output.state !== 'complete');
    if (failed.length === 0 && completed.length === 2) {
      const outputSizeBytes = completed.reduce(
        (sum, output) => sum + (output.outputSizeBytes ?? 0),
        0,
      );
      if (outputSizeBytes <= 0) {
        await failMergeJob(
          job,
          mergeFailure('标准分轨验证结果为空，未将任务标记为完成。', 'OUTPUT_SIZE_MISMATCH'),
        );
      } else if (job.state !== 'completed') {
        job = transitionMergeJob(
          { ...job, state: 'verifying', publicationCommitted: true },
          'completed',
          {
            outputSizeBytes,
            progress: {
              ...job.progress,
              ratio: 1,
              message: '保存成功',
            },
          },
        );
        job = await releaseMergeRequestContext(job);
        await mergeJobStore.save(job);
        await publishMergeDock(job);
      }
    } else {
      const completedLabels = completed.map((output) => standardSeparateOutputLabel(output.kind));
      const failedDetails = failed.map(
        (output) =>
          `${standardSeparateOutputLabel(output.kind)}：${output.error ?? '浏览器未能保存文件'}`,
      );
      const prefix =
        completedLabels.length > 0
          ? `分别下载部分完成（已保存 ${completedLabels.join('、')}）`
          : '分别下载失败';
      const representative = failed.find((output) => output.failure)?.failure;
      await failMergeJob(job, {
        // Preserve the failed original track's bounded structural evidence;
        // aggregating a partial export must not erase its actual stage/reason.
        ...representative,
        code: representative?.code ?? 'OUTPUT_WRITE_FAILED',
        message: `${prefix}；${failedDetails.join('；')}。`,
        retryable: failed.some((output) => output.failure?.retryable ?? true),
        canDownloadSeparately: true,
      });
    }
  }
  await sendMergeOffscreenCommand({
    channel: 'foxfetch-merge-offscreen-v1',
    target: 'offscreen',
    type: 'CLEANUP',
    jobId: group.jobId,
  }).catch(() => undefined);
}

async function finalizeSeparateExportUnlocked(
  downloadId: number,
  pending: PendingSeparateExport,
  state: 'complete' | 'interrupted',
  error?: string,
): Promise<void> {
  const groupKey = pendingSeparateExportGroupKey(pending.jobId);
  const group = (await chrome.storage.session.get(groupKey))[groupKey] as
    PendingSeparateExportGroup | undefined;
  if (!group) {
    await chrome.storage.session.remove(pendingSeparateExportKey(downloadId));
    return;
  }
  const output = group.outputs[pending.outputKind];
  if (output.downloadId !== downloadId || output.state !== 'downloading') {
    await chrome.storage.session.remove(pendingSeparateExportKey(downloadId));
    return;
  }
  group.outputs[pending.outputKind] = {
    ...output,
    state,
    ...(state === 'interrupted'
      ? { error: error ? `浏览器保存失败：${error}` : '浏览器未能保存文件' }
      : {}),
  };
  await Promise.all([
    chrome.storage.session.remove(pendingSeparateExportKey(downloadId)),
    chrome.storage.session.set({ [groupKey]: group }),
  ]);
  await settlePendingSeparateGroup(group);
}

async function finalizeSeparateExport(
  downloadId: number,
  state: 'complete' | 'interrupted',
  error?: string,
): Promise<void> {
  const storageKey = pendingSeparateExportKey(downloadId);
  const pending = (await chrome.storage.session.get(storageKey))[storageKey] as
    PendingSeparateExport | undefined;
  if (!pending || !isPendingSeparateExport(pending)) return;
  const previous = separateExportFinalizers.get(pending.jobId) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() => finalizeSeparateExportUnlocked(downloadId, pending, state, error))
    .finally(() => {
      if (separateExportFinalizers.get(pending.jobId) === task) {
        separateExportFinalizers.delete(pending.jobId);
      }
    });
  separateExportFinalizers.set(pending.jobId, task);
  await task;
}

async function hasPendingSeparateExportForJob(jobId: string): Promise<boolean> {
  const keys = [pendingSeparateExportGroupKey(jobId), pendingCustomExportKey(jobId)];
  const stored = await chrome.storage.session.get(keys);
  return isPendingSeparateExportGroup(stored[keys[0]!]) || isPendingCustomExport(stored[keys[1]!]);
}

async function startVerifiedSeparateDownloads(
  event: Extract<MergeOffscreenEvent, { type: 'SEPARATE_COMPLETED' }>,
): Promise<void> {
  if (mergePublicationTasks.has(event.jobId)) return;
  const task = startVerifiedSeparateDownloadsInternal(event);
  mergePublicationTasks.set(event.jobId, task);
  try {
    await task;
  } finally {
    if (mergePublicationTasks.get(event.jobId) === task) mergePublicationTasks.delete(event.jobId);
  }
}

async function startVerifiedSeparateDownloadsInternal(
  event: Extract<MergeOffscreenEvent, { type: 'SEPARATE_COMPLETED' }>,
): Promise<void> {
  if (separateExportStarts.has(event.jobId)) return;
  separateExportStarts.add(event.jobId);
  try {
    if (await hasPendingSeparateExportForJob(event.jobId)) return;
    let job = await mergeJobStore.get(event.jobId);
    if (
      !job ||
      !mergeJobAcceptsWork(job) ||
      mergeCancellationFences.has(job.id) ||
      !['fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state)
    ) {
      await sendMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'CLEANUP',
        jobId: event.jobId,
      }).catch(() => undefined);
      return;
    }
    if (job.state === 'paused') job = transitionMergeJob(job, job.resumeState ?? 'fetching');
    job = advanceMergeJob(job, 'verifying');
    job = updateMergeJobProgress(job, {
      phase: 'verifying',
      ratio: 1,
      readBytes: job.progress.readBytes,
      totalBytes: job.progress.totalBytes,
      message: '视频与原音轨已验证，正在交给浏览器保存…',
    });
    job.publicationPending = true;
    await mergeJobStore.save(job);
    await publishMergeDock(job);

    const group: PendingSeparateExportGroup = {
      jobId: job.id,
      outputs: {
        video: groupOutputFromOutcome(separateOutcomeByKind(event.result, 'video')),
        audio: groupOutputFromOutcome(separateOutcomeByKind(event.result, 'audio')),
      },
    };
    await chrome.storage.session.set({ [pendingSeparateExportGroupKey(job.id)]: group });
    const pageUrl = mergeOwnerPageUrl(job);
    const policy = await publicationSavePolicy(pageUrl, job.savePathPolicy);
    const customPending: PendingCustomExport | undefined =
      policy.mode === 'custom'
        ? {
            jobId: job.id,
            handleId: policy.directory.handleId,
            mode: 'separate',
            outputs: {},
          }
        : undefined;

    for (const outcome of event.result.outcomes) {
      await assertMergeTaskAcceptsWork(job.id);
      if (outcome.status === 'failed') continue;
      const blobUrl = event.blobUrls[outcome.kind];
      const output = group.outputs[outcome.kind];
      if (!blobUrl) {
        group.outputs[outcome.kind] = {
          ...output,
          state: 'failed',
          error: `${standardSeparateOutputLabel(outcome.kind)} 的已验证临时文件不可用`,
          failure: mergeFailure('已验证临时文件不可用', 'OUTPUT_WRITE_FAILED'),
        };
        continue;
      }
      const fileName = mergeOutputName(job, outcome.extension);
      const relativeName = `${buildDownloadDirectory(pageUrl, outcome.kind)}/${fileName}`;
      const now = Date.now();
      const record: DownloadRecord = {
        id: crypto.randomUUID(),
        assetId: `local-separate-${outcome.kind}-${crypto.randomUUID()}`,
        filename: policy.mode === 'custom' ? `${policy.directory.name}/${fileName}` : relativeName,
        url: chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH),
        kind: outcome.kind,
        state: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      await upsertDownloadRecord(record);
      await assertMergeTaskAcceptsWork(job.id);
      if (customPending) {
        customPending.outputs[outcome.kind] = {
          kind: outcome.kind,
          fileName,
          expectedSizeBytes: outcome.verification.sizeBytes,
          record,
        };
        group.outputs[outcome.kind] = {
          ...output,
          state: 'starting',
          recordId: record.id,
        };
        await chrome.storage.session.set({ [pendingSeparateExportGroupKey(job.id)]: group });
        continue;
      }
      try {
        const chromeDownloadId = await chrome.downloads.download({
          url: blobUrl,
          filename: relativeName,
          saveAs: policy.mode === 'ask',
          conflictAction: 'uniquify',
        });
        const pending: PendingSeparateExport = {
          jobId: job.id,
          outputKind: outcome.kind,
          outputSizeBytes: outcome.verification.sizeBytes,
          recordId: record.id,
        };
        group.outputs[outcome.kind] = {
          ...output,
          state: 'downloading',
          recordId: record.id,
          downloadId: chromeDownloadId,
        };
        await Promise.all([
          chrome.storage.session.set({
            [pendingSeparateExportGroupKey(job.id)]: group,
            [pendingSeparateExportKey(chromeDownloadId)]: pending,
          }),
          upsertDownloadRecord({
            ...record,
            chromeDownloadId,
            state: 'downloading',
            updatedAt: Date.now(),
          }),
        ]);
        if (
          mergeCancellationFences.has(job.id) ||
          !mergeJobAcceptsWork((await mergeJobStore.get(job.id)) ?? job)
        ) {
          await stopPublishedBrowserDownloads(job.id);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        group.outputs[outcome.kind] = {
          ...output,
          state: 'interrupted',
          recordId: record.id,
          error: `浏览器保存启动失败：${message}`,
        };
        await upsertDownloadRecord({
          ...record,
          state: 'interrupted',
          error: message,
          updatedAt: Date.now(),
        });
      }
      await chrome.storage.session.set({ [pendingSeparateExportGroupKey(job.id)]: group });
    }

    if (customPending && Object.keys(customPending.outputs).length > 0) {
      await chrome.storage.session.set({ [pendingCustomExportKey(job.id)]: customPending });
      try {
        await sendMergeOffscreenCommand({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'offscreen',
          type: 'SAVE_CUSTOM',
          jobId: job.id,
          handleId: customPending.handleId,
          fileNames: Object.fromEntries(
            Object.values(customPending.outputs).map((output) => [output.kind, output.fileName]),
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const output of Object.values(customPending.outputs)) {
          if (output.kind === 'merge') continue;
          group.outputs[output.kind] = {
            ...group.outputs[output.kind],
            state: 'interrupted',
            error: `自定义目录保存启动失败：${message}`,
          };
          await upsertDownloadRecord({
            ...output.record,
            state: 'interrupted',
            error: message,
            updatedAt: Date.now(),
          });
        }
        await chrome.storage.session.remove(pendingCustomExportKey(job.id));
      }
    }

    await settlePendingSeparateGroup(group);
    for (const output of Object.values(group.outputs)) {
      if (output.state !== 'downloading' || output.downloadId == null) continue;
      try {
        const item = (await chrome.downloads.search({ id: output.downloadId }))[0];
        if (item?.state === 'complete' || item?.state === 'interrupted') {
          await finalizeSeparateExport(output.downloadId, item.state, item.error);
        }
      } catch {
        // downloads.onChanged remains authoritative where search is unavailable.
      }
    }
  } finally {
    separateExportStarts.delete(event.jobId);
  }
}

function filenameWithCommittedBasename(record: DownloadRecord, fileName: string): string {
  const separator = record.filename.lastIndexOf('/');
  return separator < 0 ? fileName : `${record.filename.slice(0, separator)}/${fileName}`;
}

async function handleCustomDirectorySaved(
  event: Extract<MergeOffscreenEvent, { type: 'CUSTOM_SAVED' }>,
): Promise<void> {
  const storageKey = pendingCustomExportKey(event.jobId);
  const value = (await chrome.storage.session.get(storageKey))[storageKey];
  if (!isPendingCustomExport(value)) return;
  const pending = value;
  await chrome.storage.session.remove(storageKey);

  if (pending.mode === 'merge') {
    const output = pending.outputs.merge;
    const outcome = event.outcomes.find((candidate) => candidate.kind === 'merge');
    const valid =
      output &&
      outcome?.status === 'completed' &&
      outcome.sizeBytes === output.expectedSizeBytes &&
      outcome.sizeBytes > 0;
    if (output) {
      await upsertDownloadRecord({
        ...output.record,
        filename:
          outcome?.status === 'completed'
            ? filenameWithCommittedBasename(output.record, outcome.fileName)
            : output.record.filename,
        state: valid ? 'complete' : 'interrupted',
        ...(!valid
          ? {
              error:
                outcome?.status === 'failed'
                  ? outcome.failure.message
                  : '自定义目录写入结果校验失败',
            }
          : {}),
        updatedAt: Date.now(),
      });
    }
    let job = await mergeJobStore.get(event.jobId);
    if (job && valid && job.state !== 'completed') {
      job = transitionMergeJob(
        { ...job, state: 'verifying', publicationCommitted: true },
        'completed',
        {
          outputSizeBytes: output.expectedSizeBytes,
          progress: { ...job.progress, ratio: 1, message: '保存成功' },
        },
      );
      job = await releaseMergeRequestContext(job);
      await mergeJobStore.save(job);
      await publishMergeDock(job);
    } else if (job && !valid) {
      const failure =
        outcome?.status === 'failed'
          ? outcome.failure
          : mergeFailure('自定义目录写入结果校验失败', 'OUTPUT_WRITE_FAILED');
      await failMergeJob(job, failure);
    }
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'CLEANUP',
      jobId: event.jobId,
    }).catch(() => undefined);
    return;
  }

  const groupKey = pendingSeparateExportGroupKey(event.jobId);
  const groupValue = (await chrome.storage.session.get(groupKey))[groupKey];
  if (!isPendingSeparateExportGroup(groupValue)) {
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'CLEANUP',
      jobId: event.jobId,
    }).catch(() => undefined);
    return;
  }
  const group = groupValue;
  for (const kind of ['video', 'audio'] as const) {
    const output = pending.outputs[kind];
    if (!output) continue;
    const outcome = event.outcomes.find((candidate) => candidate.kind === kind);
    const valid =
      outcome?.status === 'completed' &&
      outcome.sizeBytes === output.expectedSizeBytes &&
      outcome.sizeBytes > 0;
    const failure =
      outcome?.status === 'failed'
        ? outcome.failure
        : mergeFailure('自定义目录写入结果校验失败', 'OUTPUT_WRITE_FAILED');
    group.outputs[kind] = valid
      ? {
          ...group.outputs[kind],
          state: 'complete',
          outputSizeBytes: output.expectedSizeBytes,
        }
      : {
          ...group.outputs[kind],
          state: 'interrupted',
          error: failure.message,
          failure,
        };
    await upsertDownloadRecord({
      ...output.record,
      filename:
        outcome?.status === 'completed'
          ? filenameWithCommittedBasename(output.record, outcome.fileName)
          : output.record.filename,
      state: valid ? 'complete' : 'interrupted',
      ...(!valid ? { error: failure.message } : {}),
      updatedAt: Date.now(),
    });
  }
  await chrome.storage.session.set({ [groupKey]: group });
  await settlePendingSeparateGroup(group);
}

async function handleMergeOffscreenEvent(event: MergeOffscreenEvent): Promise<void> {
  if (event.type === 'CAPABILITY') return handleMergeCapability(event);
  if (event.type === 'PROGRESS') return handleMergeProgress(event);
  if (event.type === 'COMPLETED') return startVerifiedMergeDownload(event);
  if (event.type === 'SEPARATE_COMPLETED') return startVerifiedSeparateDownloads(event);
  if (event.type === 'CUSTOM_SAVED') return handleCustomDirectorySaved(event);
  const job = await mergeJobStore.get(event.jobId);
  if (
    job &&
    ['resolving', 'fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state)
  ) {
    await failMergeJob(job, event.failure);
  }
}

function requireTopFrameMergeSender(sender: chrome.runtime.MessageSender): chrome.tabs.Tab {
  if (!sender.tab?.id || (sender.frameId ?? 0) !== 0 || !sender.tab.url) {
    throw new Error('合并操作必须来自当前视频页');
  }
  return sender.tab;
}

async function authorizedMergeDockJob(
  token: string,
  scope: 'action' | 'path',
  sender: chrome.runtime.MessageSender,
): Promise<MergeJob> {
  const tab = requireTopFrameMergeSender(sender);
  const grant = await mergeDockGrantBroker.authorize({
    token,
    scope,
    tabId: tab.id!,
    pageUrl: tab.url!,
  });
  const job = await mergeJobStore.get(grant.jobId);
  if (
    !job ||
    job.ownerTabId !== tab.id ||
    mergeOwnerPageUrl(job) !== tab.url ||
    (job.ownerMediaEpoch ?? 0) !== grant.mediaEpoch
  ) {
    throw new Error('当前视频已变化，请重新打开下载面板');
  }
  const state = await getTabState(tab.id!);
  if (!state || state.pageUrl !== tab.url || (state.mediaEpoch ?? 0) !== grant.mediaEpoch) {
    throw new Error('播放器已切换，请重新选择完整视频');
  }
  return job;
}

async function assertMergeTaskAcceptsWork(jobId: string): Promise<MergeJob> {
  const job = await mergeJobStore.get(jobId);
  if (!job || mergeCancellationFences.has(jobId) || !mergeJobAcceptsWork(job)) {
    throw new MergeJobCancelledError();
  }
  return job;
}

async function waitForMergeOperation(
  task: Promise<unknown> | undefined,
  timeoutMs = 4_000,
): Promise<void> {
  if (!task) return;
  await withMergeStopDeadline(
    task.catch(() => undefined),
    timeoutMs,
  );
}

async function withMergeStopDeadline<T>(task: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('STOP_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Stop only this job's browser publications; complete files are never removed. */
async function stopPublishedBrowserDownloads(jobId: string): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(stored)) {
    const merged =
      key.startsWith(MERGE_EXPORT_STORAGE_PREFIX) &&
      isPendingMergeExport(value) &&
      value.jobId === jobId;
    const separate =
      key.startsWith(SEPARATE_EXPORT_STORAGE_PREFIX) &&
      isPendingSeparateExport(value) &&
      value.jobId === jobId;
    if (!merged && !separate) continue;
    const id = Number(
      key.slice((merged ? MERGE_EXPORT_STORAGE_PREFIX : SEPARATE_EXPORT_STORAGE_PREFIX).length),
    );
    if (!Number.isSafeInteger(id) || id < 0) continue;
    let item = (await chrome.downloads.search({ id }))[0];
    if (item?.state === 'in_progress') {
      await chrome.downloads.cancel(id).catch(() => undefined);
      item = (await chrome.downloads.search({ id }))[0];
      if (item?.state === 'in_progress') throw new Error('STOP_TIMEOUT');
    }
    const state = item?.state === 'complete' ? 'complete' : 'interrupted';
    if (merged)
      await finalizeMergeExport(id, state, state === 'interrupted' ? 'USER_CANCELED' : undefined);
    else
      await finalizeSeparateExport(
        id,
        state,
        state === 'interrupted' ? 'USER_CANCELED' : undefined,
      );
  }
}

function cancelMergeDockJob(initial: MergeJob): Promise<MergeDockView> {
  const previous = mergeCancellationTasks.get(initial.id);
  if (previous) return previous;
  // This synchronous fence precedes every awaited storage/permission callback.
  mergeCancellationFences.add(initial.id);
  const task = cancelMergeDockJobInternal(initial).finally(() => {
    if (mergeCancellationTasks.get(initial.id) === task) mergeCancellationTasks.delete(initial.id);
  });
  mergeCancellationTasks.set(initial.id, task);
  return task;
}

/** Called only after publication/worker settlement. Never touches files or cache jobs. */
async function clearCancelledPublicationMetadata(jobId: string): Promise<void> {
  await waitForMergeOperation(separateExportFinalizers.get(jobId));
  if ((await mergeJobStore.get(jobId))?.state === 'completed') return;
  const customKey = pendingCustomExportKey(jobId);
  const groupKey = pendingSeparateExportGroupKey(jobId);
  const stored = await chrome.storage.session.get([customKey, groupKey]);
  const custom = stored[customKey];
  const group = stored[groupKey];
  const records = await getDownloadHistory();
  const interrupted = new Map<string, DownloadRecord>();
  if (isPendingCustomExport(custom) && custom.jobId === jobId) {
    for (const output of Object.values(custom.outputs)) {
      const latest = records.find((record) => record.id === output.record.id) ?? output.record;
      if (latest.state !== 'complete') interrupted.set(latest.id, latest);
    }
  }
  if (isPendingSeparateExportGroup(group) && group.jobId === jobId) {
    for (const output of Object.values(group.outputs)) {
      if (output.state === 'complete' || !output.recordId) continue;
      const latest = records.find((record) => record.id === output.recordId);
      if (latest && latest.state !== 'complete') interrupted.set(latest.id, latest);
    }
  }
  for (const record of interrupted.values()) {
    await upsertDownloadRecord({
      ...record,
      state: 'interrupted',
      error: 'USER_CANCELED',
      updatedAt: Date.now(),
    });
  }
  await chrome.storage.session.remove([customKey, groupKey]);
}

async function cancelMergeDockJobInternal(initial: MergeJob): Promise<MergeDockView> {
  const cancelled = await cancelMergeJobWithLifecycle(initial, {
    store: mergeJobStore,
    publish: publishMergeDock,
    release: releaseMergeRequestContext,
    stop: async (current) =>
      withMergeStopDeadline(
        (async () => {
          const pickerSessions = await mergeDirectoryPickerSessionBroker.clearJob(current.id);
          await waitForMergeOperation(mergeDirectoryPickerOpenTasks.get(current.id));
          await Promise.all(
            pickerSessions.map(async (session) => {
              await mergeDirectoryHandleStore
                .remove(`pending-${session.id}`)
                .catch(() => undefined);
              if (session.popupWindowId != null)
                await chrome.windows.remove(session.popupWindowId).catch(() => undefined);
            }),
          );
          const pageLease = mergePageFallbackLeases.get(current.id);
          if (pageLease) {
            await chrome.scripting
              .executeScript({
                target: { tabId: pageLease.tabId, documentIds: [pageLease.documentId] },
                world: 'MAIN',
                func: cancelCapturedBilibiliPageRangeMainWorld,
                args: [pageLease.cancellationId],
              })
              .catch(() => undefined);
          }
          await stopPublishedBrowserDownloads(current.id);
          await waitForMergeOperation(mergePublicationTasks.get(current.id));
          await stopPublishedBrowserDownloads(current.id);
          const hosts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH)],
          });
          if (hosts.length > 0) {
            const stopped: unknown = await chrome.runtime.sendMessage({
              channel: 'foxfetch-merge-offscreen-v1',
              target: 'offscreen',
              type: 'CANCEL',
              jobId: current.id,
            } satisfies MergeOffscreenCommand);
            requireSettledMergeCancellation(stopped);
          }
          await waitForMergeOperation(mergePageFallbackTasks.get(current.id));
          await clearCancelledPublicationMetadata(current.id);
          mergeProgressPublishedAt.delete(current.id);
        })(),
      ),
  });
  return mergeDockView(cancelled);
}

async function captureMergeSavePath(job: MergeJob): Promise<MergeDownloadPathPolicy> {
  const policy = structuredClone(await getMergeDownloadPathPolicy(mergeOwnerPageUrl(job)));
  assertNewVideoSavePolicy(mergeOwnerPageUrl(job), policy);
  if (policy.mode !== 'custom') return policy;
  // Copy the handle reference, not any files. Replacing the remembered directory
  // must never redirect a writer already bound to this job.
  const record = await mergeDirectoryHandleStore.get(policy.directory.handleId);
  if (!record || (await verifyDirectoryPermission(record.handle)) !== 'granted')
    throw new Error('保存目录需要重新授权，请选择位置后重试；未更改保存目标。');
  const fixed = await mergeDirectoryHandleStore.save(`merge-job-${job.id}`, record.handle);
  return { mode: 'custom', directory: fixed.metadata };
}

async function startMergeExecution(job: MergeJob): Promise<MergeJob> {
  await assertMergeTaskAcceptsWork(job.id);
  if (job.state !== 'ready' || !job.plan) return job;
  let running = await ensureMergeRequestContext(job);
  running.savePathPolicy = await captureMergeSavePath(running);
  running = transitionMergeJob(running, 'fetching', {
    progress: {
      phase: 'fetching',
      ratio: 0,
      readBytes: 0,
      totalBytes: running.plan?.estimatedInputBytes ?? null,
      message: '正在启动后台合并任务…',
    },
  });
  await mergeJobStore.save(running);
  await publishMergeDock(running);
  try {
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'START',
      jobId: running.id,
      request: mergeRequestFromJob(running),
    });
    return running;
  } catch (error) {
    return failMergeJob(
      running,
      mergeFailure(error instanceof Error ? error.message : String(error)),
    );
  }
}

function prepareSeparateExportJob(job: MergeJob): MergeJob {
  let ready = job;
  if (ready.state === 'failed') {
    ready = transitionMergeJob(ready, 'queued', {
      progress: {
        phase: 'idle',
        ratio: 0,
        readBytes: 0,
        totalBytes: ready.plan?.estimatedInputBytes ?? null,
        message: '正在准备标准分轨导出…',
      },
    });
  }
  if (ready.state === 'queued' || ready.state === 'permission_required') {
    ready = transitionMergeJob(ready, 'resolving');
  }
  if (ready.state === 'resolving') {
    ready = transitionMergeJob(ready, 'ready', {
      progress: {
        phase: 'idle',
        ratio: 0,
        readBytes: 0,
        totalBytes: ready.plan?.estimatedInputBytes ?? null,
        message: '准备分别保存视频与原音轨。',
      },
    });
  }
  return ready;
}

async function startSeparateExportExecution(job: MergeJob): Promise<MergeJob> {
  await assertMergeTaskAcceptsWork(job.id);
  let running = prepareSeparateExportJob(job);
  if (running.state !== 'ready') throw new Error('当前任务尚不能分别导出标准文件');
  running = await ensureMergeRequestContext(running);
  running.savePathPolicy = await captureMergeSavePath(running);
  running = transitionMergeJob(running, 'fetching', {
    progress: {
      phase: 'fetching',
      ratio: 0,
      readBytes: 0,
      totalBytes: running.plan?.estimatedInputBytes ?? null,
      message: '正在下载完整音视频轨，完成后将分别保存视频与原音轨…',
    },
  });
  await mergeJobStore.save(running);
  await publishMergeDock(running);
  try {
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'START_SEPARATE',
      jobId: running.id,
      request: mergeRequestFromJob(running),
    });
    return running;
  } catch (error) {
    return failMergeJob(
      running,
      mergeFailure(error instanceof Error ? error.message : String(error)),
    );
  }
}

const mergeDockActionTasks = new Map<string, Promise<MergeDockView>>();

async function runMergeDockAction(
  token: string,
  action: 'merge' | 'separate' | 'cancel',
  sender: chrome.runtime.MessageSender,
  permissionRequest?: Promise<boolean>,
): Promise<MergeDockView> {
  const job = await authorizedMergeDockJob(token, 'action', sender);
  if (action === 'cancel') {
    void permissionRequest?.catch(() => undefined);
    return cancelMergeDockJob(job);
  }
  const existing = mergeDockActionTasks.get(job.id);
  if (existing) {
    void permissionRequest?.catch(() => undefined);
    return existing;
  }
  if (!['fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state))
    assertNewVideoSavePolicy(
      mergeOwnerPageUrl(job),
      await getMergeDownloadPathPolicy(mergeOwnerPageUrl(job)),
    );
  if (job.repeatedByJobId) {
    const replacement = await mergeJobStore.get(job.repeatedByJobId);
    if (replacement) return mergeDockView(replacement);
    throw new Error('重新下载的任务创建状态尚未确认，请重新查询，未创建重复任务。');
  }
  if (!canRepeatMergeDownload(job)) await assertMergeTaskAcceptsWork(job.id);
  const task = (
    canRepeatMergeDownload(job)
      ? repeatCompletedDownload(job, action, permissionRequest)
      : runMergeDockActionUnlocked(job, action, permissionRequest)
  ).finally(() => {
    if (mergeDockActionTasks.get(job.id) === task) mergeDockActionTasks.delete(job.id);
  });
  mergeDockActionTasks.set(job.id, task);
  return task;
}

async function repeatCompletedDownload(
  completed: MergeJob,
  action: 'merge' | 'separate',
  permissionRequest?: Promise<boolean>,
): Promise<MergeDockView> {
  // Await the gesture-owned permission result before replacing any capability.
  await permissionRequest;
  const tab = await chrome.tabs.get(completed.ownerTabId!);
  let state = await synchronizeStateForRead(tab);
  if (needsMediaConvergence(state)) state = await scanTab(completed.ownerTabId!, true);
  if (
    !state ||
    state.pageUrl !== completed.ownerPageUrl ||
    (state.mediaEpoch ?? 0) !== completed.ownerMediaEpoch
  ) {
    throw new Error('当前视频已变化，请重新选择下载内容');
  }
  const { product, videoTrack, audioTrack } = selectRepeatTracks(
    completed,
    mediaDockProducts(state),
  );
  const selected = validateMediaProductDownload(state, {
    productId: product.id,
    mode: 'complete',
    videoAssetId: videoTrack.asset.id,
    audioAssetId: audioTrack.asset.id,
    videoTrackId: videoTrack.id,
    ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
  });
  if (!selected.audio || !selected.audioTrack) throw new Error('原来的音轨暂不可用，请重新选择');
  const replacementId = crypto.randomUUID();
  await mergeJobStore.save(touchMergeJob({ ...completed, repeatedByJobId: replacementId }));
  const created = await createMergeJob(
    state,
    selected.video,
    selected.audio,
    replacementId,
    { videoTrack: selected.videoTrack, audioTrack: selected.audioTrack },
    true,
  );
  let fresh = (await mergeJobStore.get(created.jobId))!;
  fresh = touchMergeJob({
    ...fresh,
    repeatAction: action,
    fileName: completed.fileName,
    preferredContainer: completed.preferredContainer,
  });
  await mergeJobStore.save(fresh);
  // Keep the old completion record, but make its action capability single-use.
  await mergeJobStore.save(touchMergeJob({ ...completed, repeatedByJobId: fresh.id }));
  await mergeDockGrantBroker.clearJob(completed.id);
  if (action === 'separate' && (await hasMergeHostPermissions(fresh))) {
    fresh = await startSeparateExportExecution(fresh);
  } else {
    await startMergePreflight(fresh.id);
    fresh = (await mergeJobStore.get(fresh.id)) ?? fresh;
  }
  return mergeDockView(fresh);
}

async function runMergeDockActionUnlocked(
  initialJob: MergeJob,
  action: 'merge' | 'separate',
  permissionRequest?: Promise<boolean>,
): Promise<MergeDockView> {
  let job = initialJob;
  const rebuildingExpiredFailure =
    action === 'merge' && job.state === 'failed' && !hasRetainedMergeJobSources(job);
  // An absent synchronous request means the capability was not live in this
  // Service Worker (for example after an unusual worker restart). Never treat
  // that as implicit permission; exact existing host grants may still proceed.
  const permissionGranted = rebuildingExpiredFailure
    ? true
    : permissionRequest
      ? await permissionRequest
      : await hasMergeHostPermissions(job);
  await assertMergeTaskAcceptsWork(job.id);
  if (!permissionGranted && !(await hasMergeHostPermissions(job))) {
    if (action === 'merge') {
      await startMergePreflight(job.id);
      job = (await mergeJobStore.get(job.id)) ?? job;
      return mergeDockView(job);
    }
    throw new Error('未获得媒体来源网站权限，无法下载');
  }
  if (action === 'merge') {
    if (job.state === 'failed') {
      const ownerTabId = job.ownerTabId;
      if (ownerTabId == null) throw new Error('旧任务已失效，请从当前资源重新发起下载');
      const tab = await chrome.tabs.get(ownerTabId);
      let state = await synchronizeStateForRead(tab);
      if (needsMediaConvergence(state)) state = await scanTab(ownerTabId, true);
      if (
        !state ||
        state.pageUrl !== mergeOwnerPageUrl(job) ||
        (state.mediaEpoch ?? 0) !== (job.ownerMediaEpoch ?? 0)
      ) {
        throw new Error('播放器已变化，请从当前资源重新选择完整视频');
      }
      const product = mediaDockProducts(state).find(
        (candidate) => candidate.capabilities.complete && candidate.audioTracks.length > 0,
      );
      if (!product) throw new Error('视频和音频信息尚未获取完整，请稍后重新选择视频。');
      const selection = selectProductDownload(product, 'complete');
      const { video, audio, videoTrack, audioTrack } = validateMediaProductDownload(state, {
        productId: product.id,
        mode: selection.mode,
        videoAssetId: selection.videoAssetId,
        ...(selection.audioAssetId ? { audioAssetId: selection.audioAssetId } : {}),
        ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
      });
      if (!audio || !audioTrack) throw new Error('当前完整视频不再需要合并，请刷新下载列表');
      const replacement = await createMergeJob(state, video, audio, undefined, {
        videoTrack,
        audioTrack,
      });
      job = (await mergeJobStore.get(replacement.jobId)) ?? job;
    } else if (job.state === 'permission_required') {
      await startMergePreflight(job.id);
      job = (await mergeJobStore.get(job.id)) ?? job;
    } else if (job.state === 'ready') {
      job = await startMergeExecution(job);
    } else {
      throw new Error('当前合并任务尚不能开始');
    }
    return mergeDockView(job);
  }

  const canDownloadSeparately =
    !['queued', 'resolving', 'fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(
      job.state,
    ) &&
    job.state !== 'completed' &&
    job.state !== 'cancelled' &&
    job.state !== 'blocked_drm' &&
    (job.failure?.canDownloadSeparately ?? true);
  if (!canDownloadSeparately) throw new Error('当前任务尚不能分别下载');
  if (!hasRetainedMergeJobSources(job)) {
    throw new Error('临时媒体地址已过期，请从当前视频重新选择下载内容');
  }

  job = await startSeparateExportExecution(job);
  return mergeDockView(job);
}

async function updateMergeDockPathMode(
  token: string,
  mode: Exclude<MergeDockPathChoice, 'custom'>,
  sender: chrome.runtime.MessageSender,
): Promise<MergeDockView> {
  const job = await authorizedMergeDockJob(token, 'path', sender);
  assertMergePathMutable(job);
  const pageUrl = mergeOwnerPageUrl(job);
  const platform = downloadPlatformDirectory(pageUrl);
  return mergeDirectoryPolicyQueue.run(platform, async () => {
    const validate = async () => {
      assertMergePathMutable(await authorizedMergeDockJob(token, 'path', sender));
      if (mode === 'remembered') {
        await resolveRememberedMergeDirectory(pageUrl, mergeDirectoryHandleStore);
      }
    };
    await validate();
    const policy: MergeDownloadPathPolicy =
      mode === 'remembered'
        ? {
            mode: 'custom',
            directory: await resolveRememberedMergeDirectory(pageUrl, mergeDirectoryHandleStore),
          }
        : { mode };
    if (platform === 'youtube' || platform === 'bilibili') {
      // Two-option preferences are a single atomic storage write: no handle
      // promotion or compensating write can restore a stale custom preference.
      assertNewVideoSavePolicy(pageUrl, policy);
      await validate();
      await saveMergeDownloadPathPolicy(pageUrl, policy);
      return publishCommittedMergeDirectory(job);
    }
    await commitMergeDirectoryPolicy({
      store: mergeDirectoryHandleStore,
      handleId: `merge-${platform}`,
      policy,
      readPolicy: () => getMergeDownloadPathPolicy(pageUrl),
      writePolicy: (value) => saveMergeDownloadPathPolicy(pageUrl, value),
      validate,
    });
    return publishCommittedMergeDirectory(job);
  });
}

async function publishCommittedMergeDirectory(job: MergeJob): Promise<MergeDockView> {
  try {
    const updated = touchMergeJob((await mergeJobStore.get(job.id)) ?? job);
    await mergeJobStore.save(updated);
    return await publishMergeDock(updated);
  } catch (error) {
    // The policy transaction has completed. A view/storage notification error
    // must not imply that the old directory is still selected.
    throw new Error('保存位置已保存，但界面刷新失败；请重新打开下载面板确认，无需重复授权。', {
      cause: error,
    });
  }
}

function assertMergePathMutable(job: MergeJob): void {
  if (
    !mergeJobAcceptsWork(job) ||
    mergeCancellationFences.has(job.id) ||
    mergeDockActionTasks.has(job.id) ||
    ['queued', 'resolving', 'fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(
      job.state,
    )
  ) {
    throw new Error('任务正在处理，请等待当前操作结束后更改保存位置。');
  }
}

function mergeDirectoryPickerPopupIdentity(sender: chrome.runtime.MessageSender): {
  popupTabId: number;
  popupWindowId: number;
} {
  const pickerUrl = chrome.runtime.getURL('directory-picker.html');
  const senderIsPicker = sender.url === pickerUrl || sender.url?.startsWith(`${pickerUrl}?`);
  const popupTabId = sender.tab?.id;
  const popupWindowId = sender.tab?.windowId;
  if (
    sender.id !== chrome.runtime.id ||
    (sender.frameId ?? 0) !== 0 ||
    !senderIsPicker ||
    popupTabId == null ||
    popupWindowId == null
  ) {
    throw new Error('保存位置只能由 FoxFetch 目录选择窗口修改');
  }
  return { popupTabId, popupWindowId };
}

async function closeMergeDirectoryPickerWindows(windowIds: number[]): Promise<void> {
  await Promise.all(
    windowIds.map((windowId) => chrome.windows.remove(windowId).catch(() => undefined)),
  );
}

async function clearMergeDirectoryPickersForSourceTab(sourceTabId: number): Promise<void> {
  const windowIds = await mergeDirectoryPickerSessionBroker.clearSourceTab(sourceTabId);
  await closeMergeDirectoryPickerWindows(windowIds);
}

const mergeDirectoryPickerOpenTasks = new Map<string, Promise<MergeDirectoryPickerOpened>>();

async function openMergeDirectoryPicker(
  token: string,
  sender: chrome.runtime.MessageSender,
): Promise<MergeDirectoryPickerOpened> {
  const job = await authorizedMergeDockJob(token, 'path', sender);
  assertNewVideoSavePolicy(mergeOwnerPageUrl(job), { mode: 'custom' });
  assertMergePathMutable(job);
  const sourceTabId = job.ownerTabId;
  if (sourceTabId == null) throw new Error('保存位置请求缺少来源标签页');
  const existing = mergeDirectoryPickerOpenTasks.get(job.id);
  if (existing) {
    await existing;
    return { reused: true };
  }
  const owner = {
    jobId: job.id,
    sourceTabId,
    sourcePageUrl: mergeOwnerPageUrl(job),
    mediaEpoch: job.ownerMediaEpoch ?? 0,
  };
  const task = openBoundMergeDirectoryPicker(owner, {
    broker: mergeDirectoryPickerSessionBroker,
    assertCurrent: async () => {
      const current = await authorizedMergeDockJob(token, 'path', sender);
      if (current.id !== job.id) throw new MergeJobCancelledError();
      assertMergePathMutable(current);
    },
    closeWindows: closeMergeDirectoryPickerWindows,
    createPopup: async () => {
      // The only window opened before binding is a harmless blank placeholder.
      const popup = await chrome.windows.create({
        type: 'popup',
        url: 'about:blank',
        focused: true,
        width: 480,
        height: 440,
      });
      if (popup?.id == null) throw new Error('浏览器没有创建目录选择窗口');
      try {
        const popupTabId =
          popup.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: popup.id }))[0]?.id;
        if (popupTabId == null) throw new Error('浏览器没有返回目录选择标签页');
        return { popupWindowId: popup.id, popupTabId };
      } catch (error) {
        await closeMergeDirectoryPickerWindows([popup.id]);
        throw error;
      }
    },
    inspectPopup: async (popup) => {
      await chrome.windows.get(popup.popupWindowId);
      await chrome.tabs.get(popup.popupTabId);
    },
    focusPopup: async (popup) => {
      await chrome.windows.update(popup.popupWindowId, { focused: true });
    },
    navigatePopup: async (popup, session) => {
      const pickerUrl = new URL(chrome.runtime.getURL('directory-picker.html'));
      pickerUrl.searchParams.set('session', session.id);
      await chrome.tabs.update(popup.popupTabId, { url: pickerUrl.href, active: true });
    },
  }).finally(() => {
    if (mergeDirectoryPickerOpenTasks.get(job.id) === task)
      mergeDirectoryPickerOpenTasks.delete(job.id);
  });
  mergeDirectoryPickerOpenTasks.set(job.id, task);
  return task;
}

async function authorizedMergeDirectoryPickerJob(
  sessionId: string,
  sender: chrome.runtime.MessageSender,
  claim = false,
): Promise<{ job: MergeJob; popup: { popupTabId: number; popupWindowId: number } }> {
  const popup = mergeDirectoryPickerPopupIdentity(sender);
  const session = claim
    ? await mergeDirectoryPickerSessionBroker.claim(sessionId, popup)
    : await mergeDirectoryPickerSessionBroker.authorize(sessionId, popup);
  try {
    const [job, sourceTab, state] = await Promise.all([
      mergeJobStore.get(session.jobId),
      chrome.tabs.get(session.sourceTabId).catch(() => undefined),
      getTabState(session.sourceTabId),
    ]);
    if (
      !job ||
      sourceTab?.url !== session.sourcePageUrl ||
      job.ownerTabId !== session.sourceTabId ||
      mergeOwnerPageUrl(job) !== session.sourcePageUrl ||
      (job.ownerMediaEpoch ?? 0) !== session.mediaEpoch ||
      state?.pageUrl !== session.sourcePageUrl ||
      (state.mediaEpoch ?? 0) !== session.mediaEpoch
    ) {
      throw new Error('当前视频已变化，请重新打开保存位置');
    }
    return { job, popup };
  } catch (error) {
    if (claim) await mergeDirectoryPickerSessionBroker.releaseClaim(sessionId);
    throw error;
  }
}

async function mergeDirectoryPickerContext(
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): Promise<MergeDirectoryPickerContext> {
  const { job } = await authorizedMergeDirectoryPickerJob(sessionId, sender);
  const pageUrl = mergeOwnerPageUrl(job);
  const policy = await getMergeDownloadPathPolicy(pageUrl);
  return {
    platform: downloadPlatformDirectory(pageUrl),
    defaultPath: displayDownloadDirectory(pageUrl, 'video'),
    ...(policy.mode === 'custom' ? { current: policy.directory } : {}),
  };
}

async function setMergeDirectoryTarget(
  sessionId: string,
  mode: 'automatic' | 'custom',
  sender: chrome.runtime.MessageSender,
  directory?: MergeDockDirectorySelection,
): Promise<MergeDockView> {
  const { job, popup } = await authorizedMergeDirectoryPickerJob(sessionId, sender, true);
  try {
    const pageUrl = mergeOwnerPageUrl(job);
    assertNewVideoSavePolicy(pageUrl, { mode });
    const platform = downloadPlatformDirectory(pageUrl);
    return await mergeDirectoryPolicyQueue.run(platform, async () => {
      const validate = async () => {
        const latest = await authorizedMergeDirectoryPickerJob(sessionId, sender);
        assertMergePathMutable(latest.job);
      };
      await validate();
      const pendingHandleId = `pending-${sessionId}`;
      const incoming =
        mode === 'custom' ? await mergeDirectoryHandleStore.get(pendingHandleId) : undefined;
      if (mode === 'custom') {
        if (!directory || directory.handleId !== pendingHandleId) {
          throw new Error('自定义保存位置与当前平台不匹配');
        }
        if (
          !incoming ||
          incoming.metadata.name !== directory.name ||
          incoming.metadata.selectedAt !== directory.selectedAt
        ) {
          throw new Error('自定义保存位置未由当前目录选择窗口确认');
        }
      }
      await commitMergeDirectoryPolicy({
        store: mergeDirectoryHandleStore,
        handleId: `merge-${platform}`,
        ...(incoming ? { incoming } : {}),
        policy: incoming ? { mode: 'custom', directory: incoming.metadata } : { mode: 'automatic' },
        readPolicy: () => getMergeDownloadPathPolicy(pageUrl),
        writePolicy: (value) => saveMergeDownloadPathPolicy(pageUrl, value),
        validate: async () => {
          await validate();
          if (incoming && (await verifyDirectoryPermission(incoming.handle)) !== 'granted') {
            throw new Error('所选目录的写入权限已失效，原保存位置未更改。');
          }
        },
        finalize: () => mergeDirectoryPickerSessionBroker.commitClaim(sessionId, popup),
      });
      if (incoming) await mergeDirectoryHandleStore.remove(pendingHandleId).catch(() => undefined);
      return publishCommittedMergeDirectory(job);
    });
  } catch (error) {
    await mergeDirectoryPickerSessionBroker.releaseClaim(sessionId);
    throw error;
  }
}

async function cancelMergeDirectoryPicker(
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const popup = mergeDirectoryPickerPopupIdentity(sender);
  await mergeDirectoryPickerSessionBroker.authorize(sessionId, popup);
  await mergeDirectoryPickerSessionBroker.consume(sessionId);
}

function isPendingMergeExport(value: unknown): value is PendingMergeExport {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingMergeExport>;
  return (
    typeof pending.jobId === 'string' &&
    typeof pending.blobUrl === 'string' &&
    typeof pending.outputSizeBytes === 'number' &&
    typeof pending.recordId === 'string'
  );
}

function isPendingCustomExportOutput(
  value: unknown,
  kind: CustomDirectoryOutputKind,
): value is PendingCustomExportOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as Partial<PendingCustomExportOutput>;
  const record = output.record as Partial<DownloadRecord> | undefined;
  return (
    output.kind === kind &&
    typeof output.fileName === 'string' &&
    output.fileName.length > 0 &&
    typeof output.expectedSizeBytes === 'number' &&
    output.expectedSizeBytes > 0 &&
    typeof record?.id === 'string' &&
    typeof record.assetId === 'string' &&
    typeof record.filename === 'string' &&
    typeof record.url === 'string'
  );
}

function isPendingCustomExport(value: unknown): value is PendingCustomExport {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingCustomExport>;
  if (
    typeof pending.jobId !== 'string' ||
    typeof pending.handleId !== 'string' ||
    (pending.mode !== 'merge' && pending.mode !== 'separate') ||
    !pending.outputs ||
    typeof pending.outputs !== 'object'
  ) {
    return false;
  }
  if (pending.mode === 'merge') {
    return isPendingCustomExportOutput(pending.outputs.merge, 'merge');
  }
  return (
    isPendingCustomExportOutput(pending.outputs.video, 'video') ||
    isPendingCustomExportOutput(pending.outputs.audio, 'audio')
  );
}

function isPendingSeparateExport(value: unknown): value is PendingSeparateExport {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingSeparateExport>;
  return (
    typeof pending.jobId === 'string' &&
    (pending.outputKind === 'video' || pending.outputKind === 'audio') &&
    typeof pending.outputSizeBytes === 'number' &&
    pending.outputSizeBytes > 0 &&
    typeof pending.recordId === 'string'
  );
}

function isPendingSeparateExportGroup(value: unknown): value is PendingSeparateExportGroup {
  if (!value || typeof value !== 'object') return false;
  const group = value as Partial<PendingSeparateExportGroup>;
  if (typeof group.jobId !== 'string' || !group.outputs || typeof group.outputs !== 'object') {
    return false;
  }
  return (['video', 'audio'] as const).every((kind) => {
    const output = group.outputs?.[kind] as PendingSeparateGroupOutput | undefined;
    return (
      output?.kind === kind &&
      ['failed', 'starting', 'downloading', 'complete', 'interrupted'].includes(output.state)
    );
  });
}

async function recoverPendingCustomExports(): Promise<Set<string>> {
  const activeJobIds = new Set<string>();
  const stored = await chrome.storage.session.get(null);
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(CUSTOM_EXPORT_STORAGE_PREFIX)) continue;
    if (!isPendingCustomExport(value) || storageKey !== pendingCustomExportKey(value.jobId)) {
      await chrome.storage.session.remove(storageKey);
      continue;
    }
    const owner = await mergeJobStore.get(value.jobId);
    if (owner?.cancellationRequestedAt != null && owner.state !== 'completed') {
      // A cancellation retry owns settlement; never restart a pending write.
      activeJobIds.add(value.jobId);
      continue;
    }
    const status = await getMergeOffscreenStatus(value.jobId);
    const outputAvailable =
      (value.mode === 'merge' && status.state === 'completed') ||
      (value.mode === 'separate' && status.state === 'separate-completed');
    if (outputAvailable) {
      try {
        await sendMergeOffscreenCommand({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'offscreen',
          type: 'SAVE_CUSTOM',
          jobId: value.jobId,
          handleId: value.handleId,
          fileNames: Object.fromEntries(
            Object.values(value.outputs).map((output) => [output.kind, output.fileName]),
          ),
        });
        activeJobIds.add(value.jobId);
        continue;
      } catch {
        // Fall through to conservative failure; an unacknowledged write is
        // never reported as saved.
      }
    }

    await chrome.storage.session.remove([storageKey, pendingSeparateExportGroupKey(value.jobId)]);
    for (const output of Object.values(value.outputs)) {
      await upsertDownloadRecord({
        ...output.record,
        state: 'interrupted',
        error: '自定义目录保存被浏览器后台中断，请重试',
        updatedAt: Date.now(),
      });
    }
    const job = await mergeJobStore.get(value.jobId);
    if (job) {
      await failMergeJob(
        job,
        mergeFailure('自定义目录保存被浏览器后台中断，请重试', 'OUTPUT_WRITE_FAILED'),
      );
    }
    await sendMergeOffscreenCommand({
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'CLEANUP',
      jobId: value.jobId,
    }).catch(() => undefined);
  }
  return activeJobIds;
}

async function recoverPendingMergeExports(): Promise<Set<string>> {
  const activeJobIds = new Set<string>();
  const stored = await chrome.storage.session.get(null);
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(MERGE_EXPORT_STORAGE_PREFIX) || !isPendingMergeExport(value)) {
      continue;
    }
    const downloadId = Number(storageKey.slice(MERGE_EXPORT_STORAGE_PREFIX.length));
    if (!Number.isInteger(downloadId)) {
      await chrome.storage.session.remove(storageKey);
      continue;
    }
    const item = (await chrome.downloads.search({ id: downloadId }).catch(() => []))[0];
    if (item?.state === 'complete' || item?.state === 'interrupted') {
      await finalizeMergeExport(downloadId, item.state, item.error);
    } else if (item?.state === 'in_progress') {
      activeJobIds.add(value.jobId);
    } else {
      await finalizeMergeExport(downloadId, 'interrupted', '下载任务已不存在');
    }
  }
  return activeJobIds;
}

async function recoverPendingSeparateExports(): Promise<Set<string>> {
  const activeJobIds = new Set<string>();
  const stored = await chrome.storage.session.get(null);
  const validGroupIds = new Set<string>();

  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(SEPARATE_EXPORT_GROUP_STORAGE_PREFIX)) continue;
    if (!isPendingSeparateExportGroup(value)) {
      await chrome.storage.session.remove(storageKey);
      continue;
    }
    const group = value;
    const custom = stored[pendingCustomExportKey(group.jobId)];
    if (isPendingCustomExport(custom) && custom.mode === 'separate') {
      activeJobIds.add(group.jobId);
      continue;
    }
    validGroupIds.add(group.jobId);
    let active = false;
    for (const output of Object.values(group.outputs)) {
      if (output.state === 'starting') {
        group.outputs[output.kind] = {
          ...output,
          state: 'interrupted',
          error: '浏览器在开始保存前已重启，请重新保存该文件。',
        };
        continue;
      }
      if (output.state !== 'downloading' || output.downloadId == null) continue;
      const item = (await chrome.downloads.search({ id: output.downloadId }).catch(() => []))[0];
      if (item?.state === 'in_progress') {
        active = true;
        continue;
      }
      const terminalState = item?.state === 'complete' ? 'complete' : 'interrupted';
      group.outputs[output.kind] = {
        ...output,
        state: terminalState,
        ...(terminalState === 'interrupted'
          ? { error: item?.error ? `浏览器保存失败：${item.error}` : '下载任务已不存在' }
          : {}),
      };
      await chrome.storage.session.remove(pendingSeparateExportKey(output.downloadId));
      await updateDownloadByChromeId(output.downloadId, {
        state: terminalState,
        ...(item?.error ? { error: item.error } : {}),
      }).catch(() => undefined);
    }
    await chrome.storage.session.set({ [storageKey]: group });
    if (active) activeJobIds.add(group.jobId);
    else await settlePendingSeparateGroup(group);
  }

  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(SEPARATE_EXPORT_STORAGE_PREFIX)) continue;
    if (!isPendingSeparateExport(value) || !validGroupIds.has(value.jobId)) {
      await chrome.storage.session.remove(storageKey);
    }
  }
  return activeJobIds;
}

let mergeRecovery: Promise<void> | null = null;

async function recoverMergeJobs(): Promise<void> {
  if (mergeRecovery) return mergeRecovery;
  mergeRecovery = (async () => {
    for (const job of await mergeJobStore.list()) {
      if (
        job.cancellationRequestedAt != null &&
        job.state !== 'completed' &&
        job.state !== 'cancelled'
      ) {
        await cancelMergeDockJob(job).catch(() => undefined);
      }
    }
    const customExportingJobIds = await recoverPendingCustomExports();
    const [mergeExportingJobIds, separateExportingJobIds] = await Promise.all([
      recoverPendingMergeExports(),
      recoverPendingSeparateExports(),
    ]);
    const exportingJobIds = new Set([
      ...customExportingJobIds,
      ...mergeExportingJobIds,
      ...separateExportingJobIds,
    ]);
    const jobs = await mergeJobStore.list();
    for (let job of jobs) {
      if (job.cancellationRequestedAt != null) continue;
      if (exportingJobIds.has(job.id)) continue;

      if (
        !hasRetainedMergeJobSources(job) &&
        !['completed', 'failed', 'cancelled', 'blocked_drm'].includes(job.state)
      ) {
        if (job.requestRuleIds?.length) job = await releaseMergeRequestContext(job);
        await failMergeJob(
          job,
          mergeFailure('临时媒体地址已过期，请从当前视频重新点击合并下载。', 'SOURCE_UNREADABLE'),
        );
        continue;
      }

      if (job.state === 'resolving') {
        const status = await getMergeOffscreenStatus(job.id);
        if (status.state === 'preflighting' || status.state === 'queued') continue;
        if (job.requestRuleIds?.length) job = await releaseMergeRequestContext(job);
        await failMergeJob(job, mergeFailure('后台检查曾中断，请重试。'));
        continue;
      }

      if (['fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state)) {
        const status = await getMergeOffscreenStatus(job.id);
        if (status.state === 'running' || status.state === 'queued') continue;
        if (status.state === 'completed') {
          await startVerifiedMergeDownload({
            channel: 'foxfetch-merge-offscreen-v1',
            target: 'background',
            type: 'COMPLETED',
            jobId: job.id,
            result: status.result,
            blobUrl: status.blobUrl,
          });
          continue;
        }
        if (status.state === 'separate-completed') {
          await startVerifiedSeparateDownloads({
            channel: 'foxfetch-merge-offscreen-v1',
            target: 'background',
            type: 'SEPARATE_COMPLETED',
            jobId: job.id,
            result: status.result,
            blobUrls: status.blobUrls,
          });
          continue;
        }
        if (job.requestRuleIds?.length) job = await releaseMergeRequestContext(job);
        await sendMergeOffscreenCommand({
          channel: 'foxfetch-merge-offscreen-v1',
          target: 'offscreen',
          type: 'CLEANUP',
          jobId: job.id,
        }).catch(() => undefined);
        await failMergeJob(job, mergeFailure('浏览器后台曾中断该任务，请重新点击合并下载。'));
        continue;
      }

      if (job.requestRuleIds?.length) job = await releaseMergeRequestContext(job);
      if (job.state === 'queued' || job.state === 'permission_required') {
        void startMergePreflight(job.id);
      } else {
        await publishMergeDock(job);
      }
    }
  })().finally(() => {
    mergeRecovery = null;
  });
  return mergeRecovery;
}

const mediaAccessIntentStore = new PendingMediaAccessIntentStore();

async function executeMediaAccessIntent(
  intentId: string,
  action: MediaAccessIntentAction,
): Promise<MediaAccessIntentResult> {
  const tab = await chrome.tabs.get(action.tabId);
  if (!tab.id) throw new Error('合并来源标签页已关闭');
  const state = await synchronizeStateForRead(tab);
  assertMediaAccessIntentContext(state, tab.url ?? '', action);

  if (action.kind === 'media-product-merge') {
    const { video, audio, videoTrack, audioTrack } = validateMediaProductDownload(state, {
      productId: action.productId,
      mode: 'complete',
      videoAssetId: action.videoAssetId,
      audioAssetId: action.audioAssetId,
      ...(action.videoTrackId ? { videoTrackId: action.videoTrackId } : {}),
      ...(action.qualityId ? { qualityId: action.qualityId } : {}),
      ...(action.expectedMedia ? { expectedMedia: action.expectedMedia } : {}),
    });
    if (!audio || !audioTrack) {
      throw new Error('当前完整视频不再需要合并，资源列表正在自动更新');
    }
    const job = await createMergeJob(state, video, audio, intentId, { videoTrack, audioTrack });
    return { mode: 'merge', jobId: job.jobId };
  }

  const video = state.assets.find(
    (asset) => asset.id === action.videoAssetId && asset.kind === 'video',
  );
  const audio = state.assets.find(
    (asset) => asset.id === action.audioAssetId && asset.kind === 'audio',
  );
  if (!video || !audio) throw new Error('所选音视频轨已变化，请重新选择');
  const job = await createMergeJob(
    state,
    video,
    audio,
    intentId,
    exactMergeTracksForAssets(state, video, audio),
  );
  return { mode: 'merge', jobId: job.jobId };
}

const mediaAccessIntentBroker = new MediaAccessIntentBroker(
  mediaAccessIntentStore,
  hasFullMediaAccess,
  executeMediaAccessIntent,
);

function commitMediaAccessIntent(intentId: string): Promise<MediaAccessIntentResult> {
  return mediaAccessIntentBroker.commit(intentId);
}

async function resumePendingMediaAccessIntents(): Promise<void> {
  await mediaAccessIntentBroker.resumePending();
}

interface ValidatedPermissionMediaIntent {
  state: TabMediaState;
  assets: MediaAsset[];
  permissions: chrome.permissions.Permissions;
}

async function validatePermissionMediaIntent(
  intent: PermissionGatedMediaIntent,
): Promise<ValidatedPermissionMediaIntent> {
  const action = intent.action;
  if (
    !intent.id ||
    !action ||
    !['download-assets', 'download-media-product', 'capture-source'].includes(action.kind) ||
    !Number.isInteger(action.tabId) ||
    action.tabId < 0 ||
    !Number.isFinite(intent.createdAt)
  ) {
    throw new Error('无效的媒体权限待办');
  }
  const tab = await chrome.tabs.get(action.tabId);
  if (!tab.id) throw new Error('来源标签页已关闭');
  const state = await synchronizeStateForRead(tab);
  assertPermissionMediaContext(state, tab.url ?? '', action);

  let assets: MediaAsset[];
  if (action.kind === 'download-media-product') {
    const { video, audio } = validateMediaProductDownload(state, {
      productId: action.productId,
      mode: action.mode,
      videoAssetId: action.videoAssetId,
      ...(action.audioAssetId ? { audioAssetId: action.audioAssetId } : {}),
      ...(action.videoTrackId ? { videoTrackId: action.videoTrackId } : {}),
      ...(action.qualityId ? { qualityId: action.qualityId } : {}),
      ...(action.expectedMedia ? { expectedMedia: action.expectedMedia } : {}),
    });
    if (action.mode === 'complete' && audio) {
      throw new Error('当前完整视频需要合并，请重新选择完整视频下载');
    }
    const selected = action.mode === 'audio-only' ? audio : video;
    if (!selected) throw new Error('当前成品缺少所选轨道');
    assets = [selected];
  } else {
    assets = validatePermissionActionAssets(state, action);
  }
  if (
    assets.some(
      (asset) =>
        asset.pageUrl !== state.pageUrl ||
        (action.kind !== 'capture-source' && !asset.downloadable),
    )
  ) {
    throw new Error('所选媒体已变化，请刷新列表后重试');
  }

  const permissions = requiredPermissionBundle(action, assets);
  assertPermissionIntentBundle(intent, permissions);
  return { state, assets, permissions };
}

const permissionMediaIntentStore = new PendingPermissionIntentStore<
  PermissionGatedMediaIntent,
  PermissionGatedMediaIntentResult
>();
const permissionDownloadAttemptStore = new PermissionDownloadAttemptStore();

function startPermissionIntentDownloads(
  intentId: string,
  tabId: number,
  state: TabMediaState,
  assets: readonly MediaAsset[],
): Promise<DownloadRecord[]> {
  return runIdempotentPermissionDownloads(intentId, assets, {
    store: permissionDownloadAttemptStore,
    history: getDownloadHistory,
    verifyNativeDownload: async (record) => {
      if (!Number.isInteger(record.chromeDownloadId)) return false;
      const matches = await chrome.downloads.search({ id: record.chromeDownloadId });
      return matches.some((item) => item.id === record.chromeDownloadId);
    },
    execute: (missing) => startAssetDownloads(tabId, state, missing),
  });
}

async function executePermissionMediaIntent(
  intentId: string,
  action: PermissionGatedMediaAction,
  intent: PermissionGatedMediaIntent,
): Promise<PermissionGatedMediaIntentResult> {
  const { state, assets } = await validatePermissionMediaIntent(intent);
  if (action.kind === 'capture-source') {
    return {
      kind: 'capture-source',
      result: await startSourceCapture(action.tabId, action.blobAssetId, action, intentId),
    };
  }
  if (action.kind === 'download-media-product') {
    const downloads = await startPermissionIntentDownloads(intentId, action.tabId, state, assets);
    return { kind: 'download-media-product', result: { mode: 'download', downloads } };
  }
  const downloads = await startPermissionIntentDownloads(intentId, action.tabId, state, assets);
  return { kind: action.kind, downloads };
}

const permissionMediaIntentBroker = new PermissionIntentBroker<
  PermissionGatedMediaIntent,
  PermissionGatedMediaIntentResult
>(permissionMediaIntentStore, hasPermissionIntentAccess, executePermissionMediaIntent);

function commitPermissionMediaIntent(intentId: string): Promise<PermissionGatedMediaIntentResult> {
  return permissionMediaIntentBroker.commit(intentId);
}

async function resumePendingPermissionMediaIntents(): Promise<void> {
  await permissionMediaIntentBroker.resumePending();
}

const PERMISSION_VISIBILITY_DELAYS_MS = [0, 40, 120, 300] as const;

async function permissionBundleVisible(
  permissions: chrome.permissions.Permissions,
): Promise<boolean> {
  for (const delay of PERMISSION_VISIBILITY_DELAYS_MS) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (await chrome.permissions.contains(permissions).catch(() => false)) return true;
  }
  return false;
}

async function permissionRequestSettled(
  request: Promise<boolean> | undefined,
  required: chrome.permissions.Permissions,
): Promise<boolean> {
  const requested = request ? await request.catch(() => false) : false;
  if (!requested && !(await chrome.permissions.contains(required).catch(() => false))) return false;
  return permissionBundleVisible(required);
}

/** Resume jobs that were already created before Chrome finished adding host access. */
async function resumePermissionRequiredMergeJobs(): Promise<void> {
  const jobs = (await mergeJobStore.list()).filter((job) => job.state === 'permission_required');
  await Promise.allSettled(
    jobs.map(async (job) => {
      if (await hasMergeHostPermissions(job)) await startMergePreflight(job.id);
    }),
  );
}

async function resumePermissionContinuations(): Promise<void> {
  // Chrome may publish a compound permissions request in more than one event,
  // and contains() can briefly lag the first onAdded callback. Pending brokers
  // are idempotent, so bounded retries safely cover both cases.
  for (const delay of PERMISSION_VISIBILITY_DELAYS_MS) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    await Promise.allSettled([
      resumePendingMediaAccessIntents(),
      resumePendingPermissionMediaIntents(),
      resumePermissionRequiredMergeJobs(),
    ]);
  }
}

/** Rescan before pushing so newly granted host access is reflected immediately. */
async function refreshMediaDocksAfterPermissionAdded(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.map(async (tab) => {
      if (tab.id == null || !tab.url || !canInject(tab.url)) return;
      const tabId = tab.id;
      const previous = await getTabState(tabId);
      if (!previous || previous.pageUrl !== tab.url) return;
      const state = await scanTab(tabId).catch(() => getTabState(tabId));
      if (!state || state.pageUrl !== tab.url) return;
      mediaDockLastPushedRevision.delete(tabId);
      await pushMediaDockSnapshot(tabId, state, true);
    }),
  );
}

async function requireCaptureSession(
  tabId: number,
  captureId: string,
): Promise<BlobCaptureSession> {
  const session = await readCaptureSessionForTab(tabId);
  if (!session || session.id !== captureId)
    throw new Error('查找下载地址的任务已失效，请重新开始。');
  return session;
}

async function startSourceCapture(
  tabId: number,
  blobAssetId: string,
  expected?: Extract<PermissionGatedMediaAction, { kind: 'capture-source' }>,
  captureId: string = crypto.randomUUID(),
): Promise<SourceCaptureStarted> {
  const tab = await chrome.tabs.get(tabId);
  const state = await synchronizeStateForRead(tab);
  if (!state || state.pageUrl !== (tab.url ?? '')) {
    throw new Error('当前媒体已变化，列表正在自动更新，请稍后再试');
  }
  if (expected) assertPermissionMediaContext(state, tab.url ?? '', expected);
  const sourceAsset = state.assets.find((asset) => asset.id === blobAssetId);
  if (!state || !sourceAsset || (sourceAsset.kind !== 'video' && sourceAsset.kind !== 'audio')) {
    throw new Error('当前媒体已变化，列表正在自动更新，请稍后再试');
  }
  const mediaElement = state.mediaElements.find(
    (element) =>
      element.frameId === sourceAsset.frameId &&
      element.kind === sourceAsset.kind &&
      (!element.sourceUrl || element.sourceUrl === sourceAsset.url),
  );
  const currentDocumentId = currentNetworkDocumentId(tabId, sourceAsset.frameId);
  const failedHttpUrl = /^https?:\/\//iu.test(sourceAsset.url) ? sourceAsset.url : undefined;
  const cachedPair = selectCachedNetworkTrackPair(
    state,
    sourceAsset.frameId,
    failedHttpUrl ? new Set([failedHttpUrl]) : undefined,
  );
  if (!cachedPair) {
    const hasPermission = await chrome.permissions.contains({
      permissions: ['webRequest'],
      origins: ['http://*/*', 'https://*/*'],
    });
    if (!hasPermission) throw new Error('需要完整检测权限才能解析媒体的真实来源');
  }
  clearCaptureAnalysisTimer(tabId);
  captureObservationGenerations.set(tabId, 0);
  captureReloadTabs.delete(tabId);
  const session = await mutateCaptureSessions((registry) => {
    const existing = registry.get(captureId);
    if (existing) {
      if (
        existing.binding.tabId !== tabId ||
        existing.binding.blobAssetId !== sourceAsset.id ||
        existing.binding.frameId !== sourceAsset.frameId
      ) {
        throw new Error('真实源捕获待办与当前媒体不一致');
      }
      return existing;
    }
    for (const current of registry.list()) {
      if (current.binding.tabId === tabId) registry.remove(current.id);
    }
    let created = registry.create({
      id: captureId,
      tabId,
      blobAssetId: sourceAsset.id,
      frameId: sourceAsset.frameId,
      ...(mediaElement ? { elementId: mediaElement.elementId } : {}),
      initialState: 'waiting_for_playback',
      documentId: currentDocumentId,
      candidateOrigins: [state.pageUrl, sourceAsset.pageUrl, sourceAsset.url],
    });
    if (cachedPair) {
      created = registry.transition(created.id, 'capturing');
      created = registry.transition(created.id, 'analyzing');
      return registry.transition(created.id, 'resolved', {
        resolvedAssetIds: [cachedPair.video.id, cachedPair.audio.id],
      });
    }
    return registry.transition(created.id, 'capturing');
  });
  const capture = await publishCaptureSession(session);
  if (session.state === 'resolved') clearCaptureTimeout(tabId);
  else scheduleCaptureTimeout(tabId, session.id);
  return { capture };
}

async function reloadSourceCapture(
  tabId: number,
  captureId: string,
): Promise<SourceCaptureStarted> {
  await requireCaptureSession(tabId, captureId);
  const reloadTab = await chrome.tabs.get(tabId);
  clearCaptureAnalysisTimer(tabId, captureId);
  bumpCaptureObservationGeneration(tabId);
  captureReloadTabs.set(tabId, reloadTab.url ?? '');
  const session = await mutateCaptureSessions((registry) => {
    const current = registry.get(captureId);
    if (!current || current.binding.tabId !== tabId) {
      throw new Error('查找下载地址的任务已失效，请重新开始。');
    }
    if (
      current.state === 'resolved' ||
      current.state === 'failed' ||
      current.state === 'cancelled'
    ) {
      throw new Error('当前捕获任务已经结束，请重新解析');
    }
    return registry.transition(captureId, 'waiting_for_playback');
  });
  const capture = await publishCaptureSession(session);
  scheduleCaptureTimeout(tabId, captureId);
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } catch (error) {
    captureReloadTabs.delete(tabId);
    throw error;
  }
  return { capture };
}

async function cancelSourceCapture(tabId: number, captureId: string): Promise<void> {
  await requireCaptureSession(tabId, captureId);
  clearCaptureAnalysisTimer(tabId, captureId);
  clearCaptureTimeout(tabId, captureId);
  bumpCaptureObservationGeneration(tabId);
  captureReloadTabs.delete(tabId);
  await mutateCaptureSessions((registry) => {
    const current = registry.get(captureId);
    if (!current || current.binding.tabId !== tabId) return;
    if (
      current.state !== 'resolved' &&
      current.state !== 'failed' &&
      current.state !== 'cancelled'
    ) {
      registry.transition(captureId, 'cancelled');
    }
    registry.remove(captureId);
  });
  await clearCaptureView(tabId);
}

async function analyzeCaptureSession(
  tabId: number,
  captureId: string,
  allowSingleTrack: boolean,
  expectedGeneration?: number,
): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const state = await getTabState(tabId);
  const context = {
    pageUrl: state?.pageUrl || tab?.url || '',
    pageTitle: state?.pageTitle || tab?.title || '当前页面',
  };
  const outcome = await mutateCaptureSessions((registry) => {
    let current = registry.get(captureId);
    if (!current || current.binding.tabId !== tabId) return { type: 'terminal' as const };
    if (
      current.state === 'resolved' ||
      current.state === 'failed' ||
      current.state === 'cancelled'
    ) {
      return { type: 'terminal' as const };
    }
    if (current.state !== 'capturing' && current.state !== 'analyzing') {
      return { type: 'pending' as const, session: current };
    }
    if (
      expectedGeneration != null &&
      captureObservationGenerations.get(tabId) !== expectedGeneration
    ) {
      return { type: 'stale' as const };
    }
    if (allowSingleTrack && Date.now() - current.updatedAt < CAPTURE_QUIET_WINDOW_MS) {
      return { type: 'stale' as const };
    }
    const bindingAssetId = current.binding.blobAssetId;
    const boundKind = state?.assets.find((asset) => asset.id === bindingAssetId)?.kind;
    const resolution = resolveCaptureSessionMedia(
      current,
      {
        ...context,
        ...(boundKind === 'video' || boundKind === 'audio' ? { expectedKind: boundKind } : {}),
      },
      allowSingleTrack,
    );
    if (resolution.assets.length === 0) {
      return { type: 'pending' as const, session: current };
    }
    if (current.state === 'capturing') current = registry.transition(captureId, 'analyzing');
    if (current.state !== 'analyzing') return { type: 'pending' as const, session: current };
    const resolved = registry.transition(captureId, 'resolved', {
      resolvedAssetIds: resolution.assets.map((asset) => asset.id),
    });
    return { type: 'resolved' as const, session: resolved, resolution };
  });

  if (outcome.type === 'terminal') {
    clearCaptureTimeout(tabId, captureId);
    return true;
  }
  if (outcome.type === 'stale') return false;
  if (outcome.type === 'pending') {
    await publishCaptureSession(outcome.session);
    return false;
  }

  clearCaptureAnalysisTimer(tabId, captureId);
  clearCaptureTimeout(tabId, captureId);
  await publishCaptureSession(outcome.session, outcome.resolution.assets);
  return true;
}

function scheduleCaptureAnalysis(tabId: number, captureId: string, generation: number): void {
  clearCaptureAnalysisTimer(tabId);
  const timer = setTimeout(() => {
    const scheduled = captureAnalysisTimers.get(tabId);
    if (!scheduled || scheduled.timer !== timer || scheduled.captureId !== captureId) return;
    captureAnalysisTimers.delete(tabId);
    if (captureObservationGenerations.get(tabId) !== generation) return;
    void analyzeCaptureSession(tabId, captureId, true, generation).catch(() => undefined);
  }, CAPTURE_QUIET_WINDOW_MS);
  captureAnalysisTimers.set(tabId, { captureId, generation, timer });
}

function observationKind(
  observation: NetworkMediaObservation,
): NonNullable<BlobCaptureSession['observations'][number]['kind']> {
  const mime = observation.mime?.toLowerCase() ?? '';
  if (mime.includes('mpegurl') || mime.includes('dash+xml')) return 'manifest';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/\.m4s(?:$|[?#])/iu.test(observation.url)) return 'segment';
  return 'request';
}

async function captureNetworkObservation(
  tabId: number,
  observation: NetworkMediaObservation,
): Promise<void> {
  const plausible =
    observation.redirect != null || resolveNetworkMediaCandidates([observation]).length > 0;
  if (!plausible) return;
  if (captureReloadTabs.has(tabId) && !tabsNavigating.has(tabId)) return;
  const expectedNavigationEpoch = navigationEpoch(tabId);

  let session = await readCaptureSessionForTab(tabId);
  if (!session || session.state === 'reload_required' || session.state === 'permission_required') {
    return;
  }
  if (session.state === 'resolved' || session.state === 'failed' || session.state === 'cancelled') {
    return;
  }
  if (observation.frameId !== session.binding.frameId) return;
  const observedDocumentId = currentNetworkDocumentId(
    tabId,
    observation.frameId,
    observation.documentId,
  );
  const currentSyntheticDocumentId = `tab-${tabId}:epoch-${navigationEpoch(tabId)}:frame-${observation.frameId}`;
  const documentId =
    !tabsNavigating.has(tabId) && session.documentId === currentSyntheticDocumentId
      ? session.documentId
      : observedDocumentId;

  const result = await mutateCaptureSessions((registry) => {
    if (navigationEpoch(tabId) !== expectedNavigationEpoch) return undefined;
    let current = registry.get(session!.id);
    if (!current || current.binding.tabId !== tabId) return undefined;
    if (current.state === 'waiting_for_playback') {
      const adopted = registry.adoptDocument(current.id, documentId);
      if (!adopted.accepted) return undefined;
      current = registry.transition(current.id, 'capturing');
    } else if (current.documentId !== documentId) {
      if (!tabsNavigating.has(tabId)) return undefined;
      const adopted = registry.adoptDocument(current.id, documentId);
      if (!adopted.accepted) return undefined;
      current = registry.transition(current.id, 'capturing');
    }
    if (current.state !== 'capturing' && current.state !== 'analyzing') return undefined;

    const rangeKey = observation.range
      ? `${observation.range.start}-${observation.range.end}/${observation.range.total ?? '*'}`
      : '';
    const recorded = registry.recordObservation(current.id, {
      id: stableId(
        `${observation.requestId}:${observation.url}:${observation.status}:${rangeKey}:${observation.redirect?.toUrl ?? ''}`,
      ),
      tabId,
      frameId: observation.frameId,
      documentId,
      url: observation.url,
      observedAt: Date.now(),
      requestId: observation.requestId,
      origin: observation.initiator ?? observation.url,
      ...(observation.initiator ? { initiator: observation.initiator } : {}),
      ...(observation.mime ? { mime: observation.mime } : {}),
      kind: observationKind(observation),
      resourceType: observation.resourceType,
      status: observation.status,
      ...(observation.size == null ? {} : { size: observation.size }),
      ...(observation.range ? { range: observation.range } : {}),
      ...(observation.redirect ? { redirect: observation.redirect } : {}),
      ...(observation.requestHeaders ? { requestHeaders: { ...observation.requestHeaders } } : {}),
    });
    return recorded.accepted
      ? { session: recorded.session, generation: bumpCaptureObservationGeneration(tabId) }
      : undefined;
  });
  if (!result) return;
  if (navigationEpoch(tabId) !== expectedNavigationEpoch) return;
  session = result.session;
  if (await analyzeCaptureSession(tabId, session.id, false)) return;
  if (captureObservationGenerations.get(tabId) !== result.generation) return;
  scheduleCaptureAnalysis(tabId, session.id, result.generation);
}

async function activateCaptureAfterNavigation(tabId: number): Promise<void> {
  const session = await readCaptureSessionForTab(tabId);
  if (!session || session.state !== 'waiting_for_playback') return;
  const documentId = tabFrameDocuments.get(tabId)?.get(session.binding.frameId);
  if (!documentId) {
    await publishCaptureSession(session);
    return;
  }
  const capturing = await mutateCaptureSessions((registry) => {
    const current = registry.get(session.id);
    if (!current || current.state !== 'waiting_for_playback') return current;
    const adopted = registry.adoptDocument(current.id, documentId);
    if (!adopted.accepted) return current;
    return registry.transition(current.id, 'capturing');
  });
  if (capturing) await publishCaptureSession(capturing);
}

async function downloadResolvedSource(
  tabId: number,
  captureId: string,
): Promise<ResolvedSourceDownload> {
  const session = await requireCaptureSession(tabId, captureId);
  if (session.state !== 'resolved') throw new Error('真实媒体源尚未解析完成');
  const state = await getTabState(tabId);
  if (!state) throw new Error('媒体列表已失效，请重新解析');
  const resolvedAssets = session.resolvedAssetIds
    .map((id) => state.assets.find((asset) => asset.id === id))
    .filter((asset): asset is MediaAsset => Boolean(asset));
  const video = resolvedAssets.find((asset) => asset.kind === 'video');
  const audio = resolvedAssets.find((asset) => asset.kind === 'audio');
  if (video && audio) {
    const job = await createMergeJob(
      state,
      video,
      audio,
      undefined,
      exactMergeTracksForAssets(state, video, audio),
    );
    return { mode: 'merge', jobId: job.jobId };
  }
  const direct = resolvedAssets[0];
  if (!direct) throw new Error('解析结果已过期，请重新解析');
  const records = await startBatchDownloads([direct], state.pageTitle, await getSettings());
  const cacheStartedAssetIds = await armMseCacheFallbacks(tabId, records);
  await broadcast({ type: 'DOWNLOADS_UPDATED', downloads: await getDownloadHistory() });
  const interrupted = records.find((record) => record.state === 'interrupted');
  if (interrupted) {
    if (cacheStartedAssetIds.has(interrupted.assetId)) {
      throw new Error(
        `常规下载失败，已切换到网页缓存捕获；回到视频页从头播放${interrupted.error ? `（${interrupted.error}）` : ''}`,
      );
    }
    if (direct.frameId !== 0) {
      throw new Error(
        `常规下载失败；媒体位于嵌套播放器，请在视频原始页面打开后使用缓存下载${interrupted.error ? `（${interrupted.error}）` : ''}`,
      );
    }
    throw new Error(`常规下载失败${interrupted.error ? `（${interrupted.error}）` : ''}`);
  }
  return {
    mode: 'download',
    downloadCount: records.filter((record) => record.state !== 'interrupted').length,
  };
}

async function reconcileCaptureForTab(tabId: number): Promise<TabMediaState | undefined> {
  let state = await getTabState(tabId);
  let session = await readCaptureSessionForTab(tabId);
  if (!session) {
    if (state?.sourceCapture) {
      await clearCaptureView(tabId);
      state = await getTabState(tabId);
    }
    return pruneQuietNetworkAssetsForRead(state);
  }
  if (
    session.state !== 'resolved' &&
    session.state !== 'failed' &&
    session.state !== 'cancelled' &&
    Date.now() - session.createdAt >= CAPTURE_TIMEOUT_MS
  ) {
    await failCaptureOnTimeout(tabId, session.id);
    session = await readCaptureSessionForTab(tabId);
    if (!session) return pruneQuietNetworkAssetsForRead(await getTabState(tabId));
  }
  if (
    session.state === 'capturing' &&
    session.observations.length > 0 &&
    Date.now() - session.updatedAt >= CAPTURE_QUIET_WINDOW_MS
  ) {
    await analyzeCaptureSession(tabId, session.id, true);
    return pruneQuietNetworkAssetsForRead(await getTabState(tabId));
  }
  const expectedCapture = state ? sourceCaptureView(session, state) : undefined;
  const currentCapture = state?.sourceCapture;
  if (
    !currentCapture ||
    !expectedCapture ||
    currentCapture.id !== expectedCapture.id ||
    currentCapture.status !== expectedCapture.status ||
    currentCapture.updatedAt !== expectedCapture.updatedAt ||
    currentCapture.observationCount !== expectedCapture.observationCount ||
    currentCapture.candidateCount !== expectedCapture.candidateCount ||
    currentCapture.directAssetId !== expectedCapture.directAssetId ||
    currentCapture.videoAssetId !== expectedCapture.videoAssetId ||
    currentCapture.audioAssetId !== expectedCapture.audioAssetId ||
    currentCapture.message !== expectedCapture.message ||
    currentCapture.error !== expectedCapture.error
  ) {
    await publishCaptureSession(session);
    state = await getTabState(tabId);
  }
  return pruneQuietNetworkAssetsForRead(state);
}

async function pruneQuietNetworkAssetsForRead(
  state: TabMediaState | undefined,
): Promise<TabMediaState | undefined> {
  if (!state) return undefined;
  const protectedAssetIds = captureProtectedAssetIds(state.sourceCapture);
  const now = Date.now();
  // A read has no authoritative frame snapshot, so mixed-source assets remain
  // untouched. Network-only entries are safe to expire and this guarantees that
  // reopening the popup/resource center reconciles a quiet same-route page even
  // if the MV3 worker slept through the TTL boundary.
  const assets = state.assets.filter(
    (asset) =>
      !isExpiredNetworkAsset(asset, now) ||
      asset.detectedBy.some((source) => source !== 'network') ||
      protectedAssetIds.has(asset.id),
  );
  if (assets.length === state.assets.length) return state;
  const next = { ...state, assets };
  await setTabState(next);
  await updateBadge(state.tabId, next);
  await broadcast({ type: 'TAB_STATE_UPDATED', state: next });
  return next;
}

async function synchronizeStateForRead(tab: chrome.tabs.Tab): Promise<TabMediaState | undefined> {
  if (!tab.id) return undefined;
  const tabId = tab.id;
  const pageUrl = tab.url ?? '';
  await consumePendingAgentPageChange(tabId).catch(() => false);
  if (tabsNavigating.has(tabId) && tab.status === 'complete') clearTabNavigationGate(tabId);
  const current = await getTabState(tabId);
  if (current?.pageUrl === pageUrl) {
    ensureRouteGeneration(tabId, pageUrl, tabFrameDocuments.get(tabId)?.get(0));
    if (current.mediaEpoch != null) tabMediaEpochs.set(tabId, current.mediaEpoch);
    return reconcileCaptureForTab(tabId);
  }
  if (!canInject(pageUrl)) return current;

  if (current && siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(pageUrl)) {
    ensureRouteGeneration(tabId, current.pageUrl, tabFrameDocuments.get(tabId)?.get(0));
    const documentId = tabFrameDocuments.get(tabId)?.get(0);
    beginRouteGeneration(tabId, pageUrl, 'read', {
      ...(documentId ? { documentId } : {}),
    });
    const rebased = await serializeTabStateMutation(tabId, async () => {
      const latest = await getTabState(tabId);
      if (!latest || siteMediaRouteKey(latest.pageUrl) !== siteMediaRouteKey(pageUrl)) {
        return latest;
      }
      const next = rebaseSameMediaRouteState(
        latest,
        pageUrl,
        tab.title || latest.pageTitle || '当前页面',
      );
      await setTabState(next);
      return next;
    });
    if (rebased) {
      await rememberMainWorldAssets(
        tabId,
        rebased,
        rebased.assets.filter((asset) => asset.detectedBy.includes('manifest')),
        documentId,
      );
      await updateBadge(tabId, rebased);
      await broadcast({ type: 'TAB_STATE_UPDATED', state: rebased });
      scheduleMediaDockSnapshot(tabId);
    }
    return reconcileCaptureForTab(tabId);
  }

  if (current) {
    ensureRouteGeneration(tabId, current.pageUrl, tabFrameDocuments.get(tabId)?.get(0));
  }
  const documentId = tabFrameDocuments.get(tabId)?.get(0);
  const routeClaim = beginRouteGeneration(tabId, pageUrl, 'read', {
    ...(documentId ? { documentId } : {}),
  });
  const routeEpoch = routeClaim.epoch;

  if (routeClaim.advanced) {
    clearCaptureAnalysisTimer(tabId);
    clearCaptureTimeout(tabId);
    bumpCaptureObservationGeneration(tabId);
    await removeCaptureSessionsForTab(tabId).catch(() => undefined);
    await clearMseDownloadFallbacksForTab(tabId).catch(() => undefined);
  }
  if (routeEpoch !== navigationEpoch(tabId)) return getTabState(tabId);
  const transitioning = await serializeTabStateMutation(tabId, async () => {
    if (routeEpoch !== navigationEpoch(tabId)) return undefined;
    const latestTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!latestTab?.url || latestTab.url !== pageUrl) return undefined;
    const latest = await getTabState(tabId);
    const next = createRouteTransitionState(
      tabId,
      pageUrl,
      latestTab.title || tab.title || '当前页面',
      latest,
    );
    await setTabState(next);
    return next;
  });
  if (!transitioning || routeEpoch !== navigationEpoch(tabId)) return getTabState(tabId);
  await updateBadge(tabId, transitioning);
  await broadcast({ type: 'TAB_STATE_UPDATED', state: transitioning });

  // GET_TAB_STATE may be the first event seen after the MV3 worker wakes on an
  // already-completed SPA route. Never return the previous video's data and do
  // not require the popup user to press a retry button.
  if (!tabsNavigating.has(tabId)) {
    void scanTab(tabId).catch(() => undefined);
  }
  return transitioning;
}

async function extractValidatedMainWorldManifest(
  tabId: number,
  pageUrl: string,
  pageTitle: string,
): Promise<DocumentBoundMainWorldManifest | undefined> {
  // YouTube now uses its own bounded inspector, not the legacy URL-to-download path.
  if (isYouTubePage(pageUrl)) return undefined;
  try {
    const results = await chrome.scripting.executeScript<[], MainWorldMediaManifestSnapshot>({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: extractMainWorldMediaManifest,
    });
    const topResult = results.find((result) => result.frameId === 0);
    if (!topResult?.documentId) return undefined;
    const validated = validateMainWorldMediaManifest(topResult.result, {
      pageUrl,
      pageTitle,
      frameId: 0,
    });
    return validated ? { manifest: validated, documentId: topResult.documentId } : undefined;
  } catch {
    // MAIN-world APIs are optional and can disappear during SPA navigation.
    // The isolated Agent and network observer remain authoritative fallbacks.
    return undefined;
  }
}

const youtubeContextObservations = new YouTubeContextObservationPool();

async function readYouTubeInspection(
  tabId: number,
  pageUrl: string,
): Promise<{ view: YouTubeInspection; documentId?: string } | undefined> {
  const inspectionEpoch = navigationEpoch(tabId);
  if (!isYouTubePage(pageUrl)) return undefined;
  if ((await getSettings()).youtubeEnabled === false)
    return {
      view: {
        version: 1,
        pageType: 'other',
        status: 'disabled',
        transports: [],
        candidates: [],
        completeDownloadVerified: false,
      },
    };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript<[], YouTubeInspection>({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: extractYouTubeInspection,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('YouTube inspection timed out')), 3000);
      }),
    ]);
    const result = results.find((item) => item.frameId === 0);
    const view = validateYouTubeInspection(result?.result, pageUrl);
    if (
      view?.videoId &&
      result?.documentId &&
      (await chrome.permissions.contains(YOUTUBE_SOURCE_PERMISSIONS)) &&
      navigationEpoch(tabId) === inspectionEpoch
    ) {
      try {
        youtubeContextObservations.warm({ tabId, documentId: result.documentId, pageUrl });
      } catch {
        // Optional early observation must not break metadata inspection.
      }
    }
    return view && result?.documentId ? { view, documentId: result.documentId } : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertYouTubeTaskPage(owner: YouTubeTaskOwner): Promise<void> {
  if (
    currentMediaEpoch(owner.tabId) !== owner.mediaEpoch ||
    !(await isTabRouteCommitCurrent(
      owner.tabId,
      owner.navigationEpoch,
      owner.pageUrl,
      owner.documentId,
    )) ||
    (await getSettings()).youtubeEnabled === false
  )
    throw new Error('PAGE_IDENTITY_CHANGED');
}

// Independent YouTube task channel. Existing Bilibili actions and eager reads are untouched.
const youtubeSelectionPreferences = new YouTubeSelectionPreferences({
  read: async () =>
    (await chrome.storage.session.get('youtubeSelectionDraftsV1')).youtubeSelectionDraftsV1,
  write: async (value) => {
    await chrome.storage.session.set({ youtubeSelectionDraftsV1: value });
  },
});
const youtubeTaskJournal = new YouTubeTaskJournal({
  read: async () => (await chrome.storage.local.get('youtubeTaskJournalV1')).youtubeTaskJournalV1,
  write: async (value) => {
    await chrome.storage.local.set({ youtubeTaskJournalV1: value });
  },
});
const youtubeDirectoryGrants = new YouTubeDirectoryGrants();
const youtubeDirectoryPickers = new YouTubeDirectoryPickers({
  grants: youtubeDirectoryGrants,
  assertCurrent: assertYouTubeTaskPage,
  open: async (nonce) => {
    const popup = await chrome.windows.create({
      url: `${chrome.runtime.getURL('youtube-directory-picker.html')}?nonce=${encodeURIComponent(nonce)}`,
      type: 'popup',
      width: 540,
      height: 400,
    });
    const tabId = popup?.tabs?.[0]?.id;
    if (popup?.id === undefined || tabId === undefined) {
      if (popup?.id !== undefined) await chrome.windows.remove(popup.id).catch(() => undefined);
      throw new Error('DIRECTORY_PICKER_OPEN_FAILED');
    }
    return { tabId, windowId: popup.id };
  },
  close: async (windowId) => {
    await chrome.windows.remove(windowId);
  },
});
const youtubeBackgroundTasks = new YouTubeBackgroundTasks({
  authorizeDirectory: async (request, signal) => {
    if (request.saveLocation !== 'custom' || !request.directoryTarget)
      throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
    const { assertYouTubeDirectoryAccess } = await import('../modules/youtube/directory-output');
    await assertYouTubeDirectoryAccess(request.directoryTarget, {
      signal,
      assertCurrent: () => assertYouTubeTaskPage(request.owner),
    });
  },
  checkpoint: async (record) => {
    await youtubeTaskJournal.access(record);
  },
  extensionOrigin: chrome.runtime.getURL('').replace(/\/$/u, ''),
  alternatives: async (request, signal) => {
    await assertYouTubeTaskPage(request.owner);
    signal.throwIfAborted();
    const inspection = await readYouTubeInspection(request.owner.tabId, request.owner.pageUrl);
    await assertYouTubeTaskPage(request.owner);
    if (!inspection || inspection.documentId !== request.owner.documentId)
      throw new Error('PAGE_IDENTITY_CHANGED');
    const selected = createYouTubeSelectionPlan(inspection.view, request.selection);
    if (!selected.ok || !request.selection.preference) return [];
    const anchor = selected.plan;
    return automaticYouTubePlans(
      inspection.view,
      resolutionKey(anchor.video),
      request.selection.preference,
    ).filter(
      (p) =>
        p.video.dynamicRange === anchor.video.dynamicRange &&
        p.audio?.language === anchor.audio?.language &&
        p.audio?.audioTrackId === anchor.audio?.audioTrackId &&
        p.audio?.audioTrackName === anchor.audio?.audioTrackName,
    );
  },
  plan: async (request, signal) => {
    await assertYouTubeTaskPage(request.owner);
    signal.throwIfAborted();
    const inspection = await readYouTubeInspection(request.owner.tabId, request.owner.pageUrl);
    signal.throwIfAborted();
    await assertYouTubeTaskPage(request.owner);
    if (!inspection || inspection.documentId !== request.owner.documentId)
      throw new Error('PAGE_IDENTITY_CHANGED');
    const result = createYouTubeSelectionPlan(inspection.view, request.selection);
    if (!result.ok) throw new Error('SELECTION_INVALID');
    // Source access is an explicit permission; never request all sites implicitly.
    if (!(await chrome.permissions.contains(YOUTUBE_SOURCE_PERMISSIONS)))
      throw new Error('SOURCE_PERMISSION_REQUIRED');
    return result.plan;
  },
  session: async (plan, owner, signal) => {
    if (plan.video.composition === 'muxed')
      return resolveYouTubeDirectSession(plan, owner, {
        signal,
        assertCurrent: () => assertYouTubeTaskPage(owner),
      });
    signal.throwIfAborted();
    const observation =
      youtubeContextObservations.take(owner) ?? observeYouTubeSetupRequests(owner);
    signal.addEventListener('abort', observation.close, { once: true });
    try {
      const session = await resolveYouTubePageSession(plan, owner, {
        signal,
        assertCurrent: () => assertYouTubeTaskPage(owner),
      });
      return await waitForYouTubeRequestContext(session, owner, {
        signal,
        assertCurrent: () => assertYouTubeTaskPage(owner),
        listen: observation.listen,
      });
    } finally {
      signal.removeEventListener('abort', observation.close);
      observation.close();
    }
  },
  command: async (command) => {
    if (command.type === 'START') await ensureMergeOffscreenDocument();
    else if (!(await mergeOffscreenDocumentExists()))
      throw new Error('EXECUTION_STATUS_UNAVAILABLE');
    const response = (await chrome.runtime.sendMessage({
      channel: 'foxfetch-youtube-execution-v1',
      target: 'offscreen',
      ...command,
    })) as { ok?: boolean; status?: YouTubeExecutionStatus | null } | undefined;
    if (!response?.ok) throw new Error('EXECUTION_COMMAND_FAILED');
    return response.status ?? null;
  },
  download: (options) => chrome.downloads.download(options),
  search: async (id) => (await chrome.downloads.search({ id }))[0],
  findDownloads: async (url) =>
    (await chrome.downloads.search({ url, limit: 10 })).map((item) => ({
      id: item.id,
      url: item.url,
      ...(item.byExtensionId ? { byExtensionId: item.byExtensionId } : {}),
    })),
  cancelDownload: (id) => chrome.downloads.cancel(id),
});

let youtubeTasksRestored: Promise<void> | undefined;
async function ensureYouTubeTasksRestored(): Promise<void> {
  youtubeTasksRestored ??= youtubeTaskJournal.access().then((records) => {
    youtubeBackgroundTasks.restore(records);
  });
  await youtubeTasksRestored;
  await youtubeBackgroundTasks.refreshRecovered();
}

const youtubePermissionContinuation = new YouTubePermissionContinuation({
  storage: {
    get: (keys) => chrome.storage.session.get(keys ?? null),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  },
  assertCurrent: assertYouTubeTaskPage,
  hasAccess: () => chrome.permissions.contains(YOUTUBE_SOURCE_PERMISSIONS),
  start: async (request) => {
    await ensureYouTubeTasksRestored();
    return youtubeBackgroundTasks.start(request);
  },
});
const youtubeDockPermissionCapabilities = new YouTubeDockPermissionCapabilities();

function mainWorldProviderIdentity(
  manifest: ValidatedMainWorldMediaManifest | undefined,
): string | undefined {
  if (!manifest) return undefined;
  if (manifest.provider === 'bilibili' && manifest.identity.bvid) {
    return `bilibili:${manifest.identity.bvid}:${manifest.identity.cid ?? ''}`;
  }
  if (manifest.provider === 'youtube' && manifest.identity.videoId) {
    return `youtube:${manifest.identity.videoId}`;
  }
  return undefined;
}

function mergeMainWorldAssetsIntoSnapshots(
  snapshots: Array<AgentSnapshot & { frameId: number; documentId?: string }>,
  mainWorldAssets: readonly MediaAsset[],
): Array<AgentSnapshot & { frameId: number; documentId?: string }> {
  if (mainWorldAssets.length === 0) return snapshots;
  return snapshots.map((snapshot) => {
    if (snapshot.frameId !== 0) return snapshot;
    return {
      ...snapshot,
      assets: mergeValidatedMainWorldAssets(snapshot.assets, mainWorldAssets),
    };
  });
}

const tabScanFlights = new Map<number, GenerationAwareTaskQueue<TabMediaState>>();
const tabScanIds = new Map<number, number>();
const TAB_SCAN_TIMEOUT_MS = 4_000;

/**
 * Coalesce automatic convergence scans while allowing one explicit refresh to
 * queue behind the active pass. This keeps executeScript single-flight per tab
 * and gives every actually-started scan a monotonically increasing identity.
 */
async function scanTab(tabId?: number, force = false): Promise<TabMediaState> {
  const tab = await resolveTab(tabId);
  if (!tab.id) throw new Error('标签页缺少 ID');
  const resolvedTabId = tab.id;
  const expectedEpoch = navigationEpoch(resolvedTabId);
  const persisted = await getTabState(resolvedTabId);
  const expectedMediaEpoch =
    currentMediaEpoch(resolvedTabId) === UNKNOWN_MEDIA_EPOCH
      ? (persisted?.mediaEpoch ?? UNKNOWN_MEDIA_EPOCH)
      : currentMediaEpoch(resolvedTabId);
  if (expectedMediaEpoch !== UNKNOWN_MEDIA_EPOCH) {
    tabMediaEpochs.set(resolvedTabId, expectedMediaEpoch);
  }
  let queue = tabScanFlights.get(resolvedTabId);
  if (!queue) {
    queue = new GenerationAwareTaskQueue<TabMediaState>({
      timeoutMs: TAB_SCAN_TIMEOUT_MS,
      forceStartsFresh: true,
    });
    tabScanFlights.set(resolvedTabId, queue);
  }
  const expectedDocumentId = tabFrameDocuments.get(resolvedTabId)?.get(0) ?? 'unbound';
  const flightGeneration = `${expectedEpoch}:${expectedMediaEpoch}:${expectedDocumentId}`;
  return queue
    .run(flightGeneration, force, () =>
      performTabScan(resolvedTabId, expectedEpoch, expectedMediaEpoch),
    )
    .catch(async (error: unknown) => {
      if (!(error instanceof GenerationTaskTimeoutError)) throw error;
      const recovered = await serializeTabStateMutation(resolvedTabId, async () => {
        const current = await getTabState(resolvedTabId);
        if (
          !current ||
          current.status !== 'scanning' ||
          navigationEpoch(resolvedTabId) !== expectedEpoch ||
          (expectedMediaEpoch !== UNKNOWN_MEDIA_EPOCH &&
            (current.mediaEpoch ?? UNKNOWN_MEDIA_EPOCH) !== expectedMediaEpoch)
        ) {
          return current;
        }
        // Supersede the still-running executeScript result before making the
        // previous stable snapshot visible again.
        tabScanIds.set(resolvedTabId, (tabScanIds.get(resolvedTabId) ?? 0) + 1);
        const next: TabMediaState = { ...current, status: 'ready', scannedAt: Date.now() };
        delete next.error;
        await setTabState(next);
        return next;
      });
      if (!recovered) throw error;
      await updateBadge(resolvedTabId, recovered);
      await broadcast({ type: 'TAB_STATE_UPDATED', state: recovered });
      reconcileMediaSettlementRetry(resolvedTabId, recovered);
      scheduleMediaDockSnapshot(resolvedTabId);
      return recovered;
    });
}

async function performTabScan(
  tabId: number,
  expectedEpoch: number,
  expectedMediaEpoch: number,
): Promise<TabMediaState> {
  const tab = await resolveTab(tabId);
  if (!tab.id) throw new Error('标签页缺少 ID');
  if (!canInject(tab.url)) {
    throw new Error('当前页面受浏览器保护，扩展无法扫描');
  }
  const resolvedTabId = tab.id;
  const initialTopDocumentId = tabFrameDocuments.get(resolvedTabId)?.get(0);
  let commitExpectedMediaEpoch = expectedMediaEpoch;
  const expectedUrl = tab.url ?? '';
  await assertTabOperationCurrent(resolvedTabId, expectedEpoch, expectedUrl, expectedMediaEpoch);
  if (isYouTubePage(expectedUrl) && (await getSettings()).youtubeEnabled === false) {
    return serializeTabStateMutation(resolvedTabId, async () => {
      await assertTabOperationCurrent(
        resolvedTabId,
        expectedEpoch,
        expectedUrl,
        expectedMediaEpoch,
      );
      const disabled: TabMediaState = {
        tabId: resolvedTabId,
        pageUrl: expectedUrl,
        pageTitle: tab.title ?? 'YouTube',
        scannedAt: Date.now(),
        status: 'ready',
        assets: [],
        mediaElements: [],
        youtube: {
          version: 1,
          pageType: 'other',
          status: 'disabled',
          transports: [],
          candidates: [],
          completeDownloadVerified: false,
        },
      };
      return setTabState(disabled);
    });
  }
  const scanId = (tabScanIds.get(resolvedTabId) ?? 0) + 1;
  tabScanIds.set(resolvedTabId, scanId);

  const scanning = await serializeTabStateMutation(resolvedTabId, async () => {
    if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
    await assertTabOperationCurrent(resolvedTabId, expectedEpoch, expectedUrl, expectedMediaEpoch);
    const current = await getTabState(resolvedTabId);
    const currentRouteState =
      current && siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(expectedUrl)
        ? rebaseSameMediaRouteState(
            current,
            expectedUrl,
            tab.title ?? current.pageTitle ?? '当前页面',
          )
        : undefined;
    const next: TabMediaState = {
      tabId: resolvedTabId,
      pageUrl: expectedUrl,
      pageTitle: tab.title ?? '当前页面',
      scannedAt: Date.now(),
      status: 'scanning',
      assets: currentRouteState?.assets ?? [],
      mediaElements: currentRouteState?.mediaElements ?? [],
      ...(currentRouteState?.youtube && currentRouteState.mediaEpoch === expectedMediaEpoch
        ? { youtube: currentRouteState.youtube }
        : {}),
      ...(currentRouteState?.mediaEpoch != null
        ? { mediaEpoch: currentRouteState.mediaEpoch }
        : {}),
      ...(currentRouteState?.activeMedia ? { activeMedia: currentRouteState.activeMedia } : {}),
      ...(currentRouteState?.providerIdentity
        ? { providerIdentity: currentRouteState.providerIdentity }
        : {}),
      ...(current?.sourceCapture ? { sourceCapture: current.sourceCapture } : {}),
    };
    await setTabState(next);
    return next;
  });
  if (navigationEpoch(resolvedTabId) === expectedEpoch) {
    await broadcast({ type: 'TAB_STATE_UPDATED', state: scanning });
  }

  try {
    // Install the page-world MSE hook before reactivating the isolated agent.
    // Failure is non-fatal: ordinary scanning and downloads remain available.
    if (!isYouTubePage(expectedUrl)) await installMseCaptureHook(resolvedTabId);
    if (isBilibiliVideoPage(expectedUrl)) {
      await ensureBilibiliManifestHook(resolvedTabId);
    }
    const [results, initialMainWorldManifest, youtubeInspection] = await Promise.all([
      chrome.scripting.executeScript<[], AgentSnapshot>({
        target: { tabId: resolvedTabId, allFrames: true },
        files: [AGENT_SCRIPT_PATH],
      }),
      extractValidatedMainWorldManifest(resolvedTabId, expectedUrl, tab.title ?? '当前页面'),
      readYouTubeInspection(resolvedTabId, expectedUrl),
    ]);
    const agentSnapshots = results
      .filter(
        (
          result,
        ): result is chrome.scripting.InjectionResult<AgentSnapshot> & { result: AgentSnapshot } =>
          Boolean(result.result),
      )
      .map((result) => ({
        ...result.result,
        frameId: result.frameId,
        documentId: result.documentId,
      }));
    const topSnapshot = agentSnapshots.find((snapshot) => snapshot.frameId === 0);
    const mainWorldManifest = selectDocumentBoundMainWorldManifest(
      initialMainWorldManifest,
      topSnapshot?.documentId,
    );
    if (initialMainWorldManifest && !mainWorldManifest) throw new StaleTabOperationError();
    const mainWorldAssets = mainWorldManifest?.assets ?? [];
    const providerIdentity = mainWorldProviderIdentity(mainWorldManifest);
    const persistedMainWorldAssets = topSnapshot
      ? await mainWorldAssetsFor(
          resolvedTabId,
          expectedUrl,
          topSnapshot.mediaEpoch,
          topSnapshot.documentId,
          providerIdentity,
        )
      : [];
    const effectiveMainWorldAssets = mergeValidatedMainWorldAssets(
      persistedMainWorldAssets,
      mainWorldAssets,
    );
    const snapshots = mergeMainWorldAssetsIntoSnapshots(agentSnapshots, effectiveMainWorldAssets);

    if (snapshots.length === 0) throw new Error('网页脚本未返回媒体信息');
    let state = await serializeTabStateMutation(resolvedTabId, async () => {
      if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
      await assertTabOperationCurrent(
        resolvedTabId,
        expectedEpoch,
        expectedUrl,
        expectedMediaEpoch,
      );
      const topSnapshot = snapshots.find((snapshot) => snapshot.frameId === 0);
      if (
        topSnapshot &&
        siteMediaRouteKey(topSnapshot.pageUrl) !== siteMediaRouteKey(expectedUrl)
      ) {
        throw new StaleTabOperationError();
      }
      for (const snapshot of snapshots) {
        if (
          !registerInjectedFrameDocument(
            resolvedTabId,
            snapshot.frameId,
            snapshot.documentId,
            snapshot.pageUrl,
          )
        ) {
          throw new StaleTabOperationError();
        }
      }
      if (
        initialMainWorldManifest &&
        tabFrameDocuments.get(resolvedTabId)?.get(0) !== initialMainWorldManifest.documentId
      )
        throw new StaleTabOperationError();
      if (
        topSnapshot?.documentId &&
        initialTopDocumentId &&
        topSnapshot.documentId !== initialTopDocumentId
      ) {
        // executeScript has proved that the provisional route now belongs to a
        // different current document. admitFrameDocument intentionally keeps
        // the already allocated route generation but clears the old media
        // epoch; from this point the scan must bind to the new snapshot rather
        // than invalidating itself against the previous player's epoch.
        commitExpectedMediaEpoch = UNKNOWN_MEDIA_EPOCH;
      }
      const previousState = await getTabState(resolvedTabId);
      const previousProviderIdentity = previousState?.providerIdentity;
      const merged = await mergeAgentSnapshots(resolvedTabId, snapshots, {
        pageUrl: expectedUrl,
        pageTitle: tab.title ?? '当前页面',
      });
      if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
      await assertTabOperationCurrent(
        resolvedTabId,
        expectedEpoch,
        expectedUrl,
        commitExpectedMediaEpoch,
      );
      const effectiveProviderIdentity =
        providerIdentity ??
        (previousProviderIdentity &&
        topSnapshot?.documentId != null &&
        topSnapshot.documentId === initialTopDocumentId &&
        previousState?.mediaEpoch === topSnapshot.mediaEpoch &&
        sameActiveMediaIdentity(previousState.activeMedia, topSnapshot.activeMedia) &&
        providerIdentityMatchesPage(expectedUrl, previousProviderIdentity)
          ? previousProviderIdentity
          : undefined);
      const boundState: TabMediaState = {
        ...merged,
        ...(effectiveProviderIdentity ? { providerIdentity: effectiveProviderIdentity } : {}),
      };
      if (
        youtubeInspection &&
        (!youtubeInspection.documentId || youtubeInspection.documentId === topSnapshot?.documentId)
      )
        boundState.youtube = youtubeInspection.view;
      else delete boundState.youtube;
      if (!effectiveProviderIdentity) delete boundState.providerIdentity;
      delete boundState.artwork;
      const boundArtwork = validateBoundMediaArtwork(topSnapshot?.artwork, boundState);
      if (boundArtwork) boundState.artwork = boundArtwork;
      await setTabState(boundState);
      if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
      await assertTabOperationCurrent(
        resolvedTabId,
        expectedEpoch,
        expectedUrl,
        commitExpectedMediaEpoch,
      );
      await rememberMainWorldAssets(
        resolvedTabId,
        boundState,
        effectiveMainWorldAssets,
        topSnapshot?.documentId,
        effectiveProviderIdentity,
      );
      if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
      await assertTabOperationCurrent(
        resolvedTabId,
        expectedEpoch,
        expectedUrl,
        commitExpectedMediaEpoch,
      );
      return boundState;
    });
    if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
    await assertTabOperationCurrent(
      resolvedTabId,
      expectedEpoch,
      expectedUrl,
      commitExpectedMediaEpoch,
    );
    if (
      !bindCurrentRouteGenerationCommit(
        resolvedTabId,
        state.pageUrl,
        expectedEpoch,
        topSnapshot?.documentId,
      )
    ) {
      throw new StaleTabOperationError();
    }
    if (state.mediaEpoch != null) tabMediaEpochs.set(resolvedTabId, state.mediaEpoch);
    // Initial SSR __playinfo__ can be valid without any playurl-ready event.
    // Send only the independently admitted public identity to this exact Agent
    // document, then revalidate its metadata reply against the newest owner.
    const artworkIdentity =
      topSnapshot && !state.artwork
        ? createMediaArtworkIdentity(
            topSnapshot,
            state,
            topSnapshot.documentId,
            tabFrameDocuments.get(resolvedTabId)?.get(0),
          )
        : undefined;
    if (artworkIdentity) {
      let artworkDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          chrome.tabs.sendMessage(
            resolvedTabId,
            {
              type: 'AGENT_BIND_ARTWORK_IDENTITY',
              binding: artworkIdentity,
            } satisfies AgentRequest,
            { documentId: topSnapshot!.documentId! },
          ) as Promise<ApiResponse<AgentSnapshot> | undefined>,
          new Promise<undefined>((resolve) => {
            artworkDeadline = setTimeout(() => resolve(undefined), 1_500);
          }),
        ]);
        if (response?.ok && response.data) {
          state = await serializeTabStateMutation(resolvedTabId, async () => {
            if (
              tabScanIds.get(resolvedTabId) !== scanId ||
              tabFrameDocuments.get(resolvedTabId)?.get(0) !== topSnapshot!.documentId
            )
              throw new StaleTabOperationError();
            await assertTabOperationCurrent(
              resolvedTabId,
              expectedEpoch,
              expectedUrl,
              commitExpectedMediaEpoch,
            );
            const current = await getTabState(resolvedTabId);
            if (!current) throw new StaleTabOperationError();
            if (
              tabScanIds.get(resolvedTabId) !== scanId ||
              tabFrameDocuments.get(resolvedTabId)?.get(0) !== topSnapshot!.documentId
            )
              throw new StaleTabOperationError();
            const artwork = validateMediaArtworkIdentityReply(
              response.data,
              artworkIdentity,
              current,
            );
            if (!artwork) return current;
            const next: TabMediaState = { ...current, artwork };
            await setTabState(next);
            return next;
          });
        }
      } catch (error) {
        if (error instanceof StaleTabOperationError) throw error;
        // Optional artwork must not turn a successful media scan into failure.
      } finally {
        if (artworkDeadline) clearTimeout(artworkDeadline);
      }
    }
    await updateBadge(resolvedTabId, state);
    if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
    await assertTabOperationCurrent(
      resolvedTabId,
      expectedEpoch,
      expectedUrl,
      commitExpectedMediaEpoch,
    );
    await broadcast({ type: 'TAB_STATE_UPDATED', state });
    void drainPendingNetworkAssets(resolvedTabId, state);
    scheduleMediaDockSnapshot(resolvedTabId);
    reconcileMediaSettlementRetry(resolvedTabId, state);
    if (resourceCenterPorts.has(resolvedTabId)) {
      await setMediaDockSuppressed(resolvedTabId, true);
    }
    return state;
  } catch (error) {
    if (error instanceof StaleTabOperationError) throw error;
    let failed: TabMediaState;
    try {
      failed = await serializeTabStateMutation(resolvedTabId, async () => {
        if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
        await assertTabOperationCurrent(
          resolvedTabId,
          expectedEpoch,
          expectedUrl,
          commitExpectedMediaEpoch,
        );
        const current = await getTabState(resolvedTabId);
        const next: TabMediaState = {
          ...(current?.pageUrl === expectedUrl ? current : scanning),
          scannedAt: Date.now(),
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
        await setTabState(next);
        if (tabScanIds.get(resolvedTabId) !== scanId) throw new StaleTabOperationError();
        await assertTabOperationCurrent(
          resolvedTabId,
          expectedEpoch,
          expectedUrl,
          commitExpectedMediaEpoch,
        );
        return next;
      });
    } catch (commitError) {
      if (commitError instanceof StaleTabOperationError) throw commitError;
      throw error;
    }
    await assertTabOperationCurrent(
      resolvedTabId,
      expectedEpoch,
      expectedUrl,
      commitExpectedMediaEpoch,
    );
    await updateBadge(resolvedTabId, failed);
    await assertTabOperationCurrent(
      resolvedTabId,
      expectedEpoch,
      expectedUrl,
      commitExpectedMediaEpoch,
    );
    await broadcast({ type: 'TAB_STATE_UPDATED', state: failed });
    throw error;
  }
}

async function handleAgentPageChanged(
  tabId: number,
  frameId: number,
  event: Extract<AgentEvent, { type: 'AGENT_PAGE_CHANGED' }>,
  documentId?: string,
  documentLifecycle?: AgentDocumentLifecycle,
): Promise<void> {
  if (frameId !== 0) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return;
  const matchingRoute = siteMediaRouteKey(tab.url) === siteMediaRouteKey(event.pageUrl);
  if (!matchingRoute) {
    // The in-page Agent observes history.pushState synchronously, while
    // chrome.tabs can expose the corresponding URL a task (or several tasks)
    // later. Do not throw away this one-shot route edge; hold only a same-origin
    // identity-only event for a short period and commit it once tabs catches up.
    if (canInject(event.pageUrl) && sameHttpOrigin(tab.url, event.pageUrl)) {
      queuePendingAgentPageChange(tabId, event, documentId, documentLifecycle);
    }
    return;
  }
  if (!rememberFrameDocument(tabId, frameId, documentId, documentLifecycle)) return;
  clearPendingAgentPageChange(tabId);
  const committedPageUrl = tab.url;
  // Only an already registered active document can prove a same-document SPA
  // transition. Retired ids are terminal and can never re-admit themselves.
  clearTabNavigationGate(tabId);
  const currentBeforeClaim = await getTabState(tabId);
  if (!tabRouteGenerations.has(tabId) && currentBeforeClaim) {
    ensureRouteGeneration(tabId, currentBeforeClaim.pageUrl, documentId);
  }
  // A matching tabs.onUpdated claim already owns this route generation. The
  // Agent completes that claim instead of invalidating the same transition a
  // second time.
  const routeClaim = beginRouteGeneration(tabId, committedPageUrl, 'agent', {
    ...(documentId ? { documentId } : {}),
  });
  const pageChangeEpoch = routeClaim.epoch;

  if (routeClaim.advanced) {
    youtubeContextObservations.clear(tabId);
    clearMediaSettlementRetry(tabId);
    clearMainWorldAssets(tabId);
    clearCaptureAnalysisTimer(tabId);
    clearCaptureTimeout(tabId);
    bumpCaptureObservationGeneration(tabId);
    captureReloadTabs.delete(tabId);
    await mediaDockGrantBroker.clearTab(tabId).catch(() => undefined);
    await clearMergeDirectoryPickersForSourceTab(tabId).catch(() => undefined);
    mediaDockLastPushedRevision.delete(tabId);
    await removeCaptureSessionsForTab(tabId).catch(() => undefined);
    await clearMseDownloadFallbacksForTab(tabId).catch(() => undefined);
  }
  if (pageChangeEpoch !== navigationEpoch(tabId) || tabsNavigating.has(tabId)) return;
  const state = await serializeTabStateMutation(tabId, async () => {
    if (pageChangeEpoch !== navigationEpoch(tabId) || tabsNavigating.has(tabId)) return undefined;
    const latestTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (
      !latestTab?.url ||
      siteMediaRouteKey(latestTab.url) !== siteMediaRouteKey(committedPageUrl)
    ) {
      return undefined;
    }
    const current = await getTabState(tabId);
    const sameReadyGeneration =
      !routeClaim.advanced &&
      current?.status === 'ready' &&
      siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(committedPageUrl);
    const next = sameReadyGeneration
      ? rebaseSameMediaRouteState(
          current,
          latestTab.url,
          event.pageTitle || latestTab.title || '当前页面',
        )
      : createRouteTransitionState(
          tabId,
          latestTab.url,
          event.pageTitle || latestTab.title || '当前页面',
          current,
        );
    next.mediaEpoch = event.mediaEpoch;
    const activeMedia = activeMediaForRoute(latestTab.url, event.mediaEpoch, event.activeMedia);
    if (activeMedia) next.activeMedia = activeMedia;
    await setTabState(next);
    if (!(await isTabRouteCommitCurrent(tabId, pageChangeEpoch, committedPageUrl, documentId))) {
      return undefined;
    }
    if (!bindCurrentRouteGenerationCommit(tabId, next.pageUrl, pageChangeEpoch, documentId)) {
      return undefined;
    }
    tabMediaEpochs.set(tabId, event.mediaEpoch);
    return next;
  });
  if (
    !state ||
    !(await isTabRouteCommitCurrent(tabId, pageChangeEpoch, committedPageUrl, documentId))
  ) {
    return;
  }
  await updateBadge(tabId, state);
  if (!(await isTabRouteCommitCurrent(tabId, pageChangeEpoch, committedPageUrl, documentId))) {
    return;
  }
  await broadcast({ type: 'TAB_STATE_UPDATED', state });
  if (!(await isTabRouteCommitCurrent(tabId, pageChangeEpoch, committedPageUrl, documentId))) {
    return;
  }
  await pushMediaDockSnapshot(tabId, state, true).catch(() => undefined);
  // Do not wait for the user to open the resource panel. The new generation
  // begins converging as soon as the in-page Agent confirms the SPA route.
  void scanTab(tabId).catch(() => undefined);
}

async function mergeAgentEvent(
  tabId: number,
  frameId: number,
  event: Extract<AgentEvent, { type: 'AGENT_STATE' }>,
  documentId?: string,
  documentLifecycle?: AgentDocumentLifecycle,
): Promise<TabMediaState | undefined> {
  const eventEpoch = navigationEpoch(tabId);
  let committedMediaEpochAdvance = false;
  const committed = await serializeTabStateMutation(tabId, async () => {
    if (eventEpoch !== navigationEpoch(tabId)) return undefined;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (
      !tab?.url ||
      eventEpoch !== navigationEpoch(tabId) ||
      (frameId === 0 && siteMediaRouteKey(event.pageUrl) !== siteMediaRouteKey(tab.url)) ||
      !rememberFrameDocument(tabId, frameId, documentId, documentLifecycle)
    ) {
      return undefined;
    }
    if (frameId === 0) clearTabNavigationGate(tabId);
    if (tabsNavigating.has(tabId)) return undefined;
    const current = await getTabState(tabId);
    if (current?.pageUrl && siteMediaRouteKey(current.pageUrl) !== siteMediaRouteKey(tab.url)) {
      return undefined;
    }
    if (frameId === 0 && current?.mediaEpoch != null && event.mediaEpoch < current.mediaEpoch) {
      return undefined;
    }
    const eventActiveMedia = activeMediaForRoute(tab.url, event.mediaEpoch, event.activeMedia);
    if (
      frameId === 0 &&
      current?.mediaEpoch === event.mediaEpoch &&
      current.activeMedia &&
      eventActiveMedia &&
      !sameActiveMediaIdentity(current.activeMedia, eventActiveMedia, true)
    ) {
      return undefined;
    }
    const mediaEpochAdvanced =
      frameId === 0 && current?.mediaEpoch != null && event.mediaEpoch > current.mediaEpoch;
    // AGENT_STATE is a frame-local snapshot. Reconcile it instead of retaining
    // stale DOM/manifest/performance entries forever; WebRequest observations
    // remain independently owned and are therefore preserved.
    const currentSnapshotAssetIds = new Set(event.assets.map((asset) => asset.id));
    const protectedAssetIds = captureProtectedAssetIds(current?.sourceCapture);
    const now = Date.now();
    const retainedAssets = (current?.assets ?? []).filter((asset) => {
      if (asset.frameId !== frameId) return true;
      // A BVID/CID-validated MAIN manifest is owned by the route/document, not
      // by noisy player lifecycle epochs. Keep it while the same SPA route is
      // current; the route transition path clears it for the next video.
      if (
        asset.detectedBy.includes('manifest') &&
        (!mediaEpochAdvanced || isBilibiliVideoPage(tab.url))
      ) {
        return true;
      }
      if (mediaEpochAdvanced && !currentSnapshotAssetIds.has(asset.id)) return false;
      if (!asset.detectedBy.includes('network')) return false;
      return (
        currentSnapshotAssetIds.has(asset.id) ||
        protectedAssetIds.has(asset.id) ||
        !isExpiredNetworkAsset(asset, now)
      );
    });
    const assetMap = new Map(retainedAssets.map((asset) => [asset.id, asset]));
    for (const asset of event.assets) {
      const normalized = { ...asset, frameId };
      const previous = assetMap.get(normalized.id);
      assetMap.set(normalized.id, previous ? mergeMediaAssets(previous, normalized) : normalized);
    }
    if (frameId === 0) {
      for (const asset of await mainWorldAssetsFor(tabId, tab.url, event.mediaEpoch, documentId)) {
        const previous = assetMap.get(asset.id);
        assetMap.set(asset.id, previous ? mergeMediaAssets(previous, asset) : asset);
      }
      if (!(await isTabRouteCommitCurrent(tabId, eventEpoch, event.pageUrl, documentId))) {
        return undefined;
      }
    }
    const otherElements = (current?.mediaElements ?? []).filter(
      (element) => element.frameId !== frameId,
    );
    const state: TabMediaState = {
      tabId,
      pageUrl: tab.url,
      pageTitle:
        frameId === 0
          ? event.pageTitle || tab.title || current?.pageTitle || '当前页面'
          : current?.pageTitle || tab.title || '当前页面',
      scannedAt: now,
      status: 'ready',
      assets: [...assetMap.values()]
        .sort((a, b) => b.discoveredAt - a.discoveredAt)
        .slice(0, MAX_ASSETS_PER_TAB),
      mediaElements: [
        ...event.mediaElements.map((element) => ({ ...element, frameId })),
        ...otherElements,
      ].sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.visibleArea - a.visibleArea),
      ...(frameId === 0
        ? {
            mediaEpoch: event.mediaEpoch,
            ...(eventActiveMedia ? { activeMedia: eventActiveMedia } : {}),
          }
        : {
            ...(current?.mediaEpoch == null ? {} : { mediaEpoch: current.mediaEpoch }),
            ...(current?.activeMedia ? { activeMedia: current.activeMedia } : {}),
          }),
      ...(current?.sourceCapture ? { sourceCapture: current.sourceCapture } : {}),
      ...(current?.providerIdentity &&
      providerIdentityMatchesPage(tab.url, current.providerIdentity)
        ? { providerIdentity: current.providerIdentity }
        : {}),
    };
    if (current?.youtube && current.pageUrl === tab.url && current.mediaEpoch === state.mediaEpoch)
      state.youtube = current.youtube;
    const boundArtwork = validateBoundMediaArtwork(
      frameId === 0 ? event.artwork : current?.artwork,
      state,
    );
    if (boundArtwork) state.artwork = boundArtwork;
    await setTabState(state);
    if (frameId === 0) {
      if (!(await isTabRouteCommitCurrent(tabId, eventEpoch, event.pageUrl, documentId))) {
        return undefined;
      }
      if (!bindCurrentRouteGenerationCommit(tabId, state.pageUrl, eventEpoch, documentId)) {
        return undefined;
      }
      tabMediaEpochs.set(tabId, event.mediaEpoch);
      committedMediaEpochAdvance = mediaEpochAdvanced;
    }
    return state;
  });
  if (
    committed &&
    (frameId !== 0 || (await isTabRouteCommitCurrent(tabId, eventEpoch, event.pageUrl, documentId)))
  ) {
    await updateBadge(tabId, committed);
    if (
      frameId !== 0 ||
      (await isTabRouteCommitCurrent(tabId, eventEpoch, event.pageUrl, documentId))
    ) {
      await broadcast({ type: 'TAB_STATE_UPDATED', state: committed });
      if (frameId === 0) void drainPendingNetworkAssets(tabId, committed);
    }
  }
  if (committed && frameId === 0 && committedMediaEpochAdvance) {
    // A new player generation must never join or be satisfied by a scan flight
    // that started for the previous lifecycle generation.
    void scanTab(tabId).catch(() => undefined);
  }
  return committed;
}

async function mergeNetworkAsset(
  tabId: number,
  asset: import('../shared/types').MediaAsset,
  context: NetworkRequestContext,
): Promise<void> {
  if (context.mediaEpoch === UNKNOWN_MEDIA_EPOCH) {
    quarantineNetworkAsset(tabId, asset, context);
    return;
  }
  const eventEpoch = navigationEpoch(tabId);
  let shouldQuarantine = false;
  let committedPageUrl = '';
  const state = await serializeTabStateMutation(tabId, async () => {
    if (eventEpoch !== navigationEpoch(tabId) || tabsNavigating.has(tabId)) {
      shouldQuarantine = true;
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const current = await getTabState(tabId);
    if (
      !tab?.url ||
      eventEpoch !== navigationEpoch(tabId) ||
      tabsNavigating.has(tabId) ||
      (current?.pageUrl && siteMediaRouteKey(current.pageUrl) !== siteMediaRouteKey(tab.url)) ||
      !context.routeKey ||
      context.routeKey !== siteMediaRouteKey(tab.url) ||
      !rememberFrameDocument(tabId, context.frameId, context.documentId)
    ) {
      shouldQuarantine = true;
      return;
    }
    if ((context.mediaEpoch ?? 0) !== (current?.mediaEpoch ?? 0)) {
      shouldQuarantine = true;
      return;
    }
    let ownedAsset = asset;
    if (
      (asset.kind === 'video' || asset.kind === 'audio') &&
      bilibiliMediaResourceFamily(asset.url)
    ) {
      const enriched = enrichBilibiliNetworkAsset(
        asset as MediaAsset & { kind: 'video' | 'audio' },
        current?.assets ?? [],
        tab.url,
        current?.providerIdentity,
      );
      if (!enriched) {
        // A recommendation may prefetch DASH tracks while the old route is
        // still current. Referer/mediaEpoch cannot prove ownership in that
        // window, so wait for a current BVID/CID manifest with the same exact
        // resource family before admitting the track.
        shouldQuarantine = true;
        return;
      }
      ownedAsset = enriched;
    }
    const now = Date.now();
    const protectedAssetIds = captureProtectedAssetIds(current?.sourceCapture);
    // Without a simultaneous agent snapshot, mixed-source assets may still be
    // represented by the live DOM/performance/manifest. Prune only expired
    // network-only entries here; the next frame snapshot can reconcile mixed ones.
    const retainedAssets = (current?.assets ?? []).filter(
      (item) =>
        !isExpiredNetworkAsset(item, now) ||
        item.detectedBy.some((source) => source !== 'network') ||
        protectedAssetIds.has(item.id),
    );
    const assetMap = new Map(retainedAssets.map((item) => [item.id, item]));
    const previous = assetMap.get(ownedAsset.id);
    const contextualAsset = {
      ...ownedAsset,
      pageUrl: current?.pageUrl || tab?.url || ownedAsset.pageUrl,
      pageTitle: current?.pageTitle || tab?.title || ownedAsset.pageTitle,
      lastObservedAt: now,
    };
    assetMap.set(
      ownedAsset.id,
      previous ? mergeMediaAssets(previous, contextualAsset) : contextualAsset,
    );
    const state: TabMediaState = {
      tabId,
      pageUrl: current?.pageUrl || tab?.url || ownedAsset.pageUrl,
      pageTitle: current?.pageTitle || tab?.title || ownedAsset.pageTitle || '当前页面',
      scannedAt: now,
      status: 'ready',
      assets: [...assetMap.values()]
        .sort((a, b) => b.discoveredAt - a.discoveredAt)
        .slice(0, MAX_ASSETS_PER_TAB),
      mediaElements: current?.mediaElements ?? [],
      ...(current?.mediaEpoch == null ? {} : { mediaEpoch: current.mediaEpoch }),
      ...(current?.activeMedia ? { activeMedia: current.activeMedia } : {}),
      ...(current?.providerIdentity ? { providerIdentity: current.providerIdentity } : {}),
      ...(current?.sourceCapture ? { sourceCapture: current.sourceCapture } : {}),
    };
    committedPageUrl = state.pageUrl;
    if (!(await isNetworkAssetCommitCurrent(tabId, eventEpoch, committedPageUrl, context))) {
      shouldQuarantine = true;
      return;
    }
    await setTabState(state);
    if (!(await isNetworkAssetCommitCurrent(tabId, eventEpoch, committedPageUrl, context))) {
      shouldQuarantine = true;
      return;
    }
    return state;
  });
  if (!state && shouldQuarantine) quarantineNetworkAsset(tabId, asset, context);
  if (!state) return;
  if (!(await isNetworkAssetCommitCurrent(tabId, eventEpoch, committedPageUrl, context))) {
    quarantineNetworkAsset(tabId, asset, context);
    return;
  }
  await updateBadge(tabId, state);
  if (!(await isNetworkAssetCommitCurrent(tabId, eventEpoch, committedPageUrl, context))) return;
  await broadcast({ type: 'TAB_STATE_UPDATED', state });
  if (!(await isNetworkAssetCommitCurrent(tabId, eventEpoch, committedPageUrl, context))) return;
  scheduleMediaDockSnapshot(tabId);
  reconcileMediaSettlementRetry(tabId, state);
}

async function sendPlaybackCommand(
  tabId: number,
  command: PlaybackCommand,
  frameId?: number,
  elementId?: string,
): Promise<PlaybackCommandResult> {
  const state = await getTabState(tabId);
  const preferred = elementId
    ? state?.mediaElements.find(
        (element) =>
          element.elementId === elementId && (frameId == null || element.frameId === frameId),
      )
    : state?.mediaElements[0];
  const targetFrameId = frameId ?? preferred?.frameId ?? 0;

  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'AGENT_PLAYBACK_COMMAND', elementId: elementId ?? preferred?.elementId, command },
      { frameId: targetFrameId },
    )) as ApiResponse<PlaybackCommandResult> | undefined;
    if (response?.ok) return response.data;
  } catch {
    await scanTab(tabId);
    const refreshed = await getTabState(tabId);
    const target = refreshed?.mediaElements[0];
    if (!target) return { applied: false };
    const response = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'AGENT_PLAYBACK_COMMAND', elementId: target.elementId, command },
      { frameId: target.frameId },
    )) as ApiResponse<PlaybackCommandResult> | undefined;
    if (response?.ok) return response.data;
  }
  return { applied: false };
}

function requireTopFrameMediaDockSender(sender: chrome.runtime.MessageSender): chrome.tabs.Tab {
  if (!sender.tab?.id || (sender.frameId ?? 0) !== 0) {
    throw new Error('常规下载请求必须来自当前视频页');
  }
  return sender.tab;
}

async function downloadMediaDockProduct(
  token: string,
  mode: MediaDockProductDownloadMode,
  sender: chrome.runtime.MessageSender,
  permissionRequest?: Promise<boolean>,
  qualityToken?: string,
): Promise<MediaProductDownloadResult> {
  const tab = requireTopFrameMediaDockSender(sender);
  const tabId = tab.id!;
  const currentTab = await chrome.tabs.get(tabId);
  const state = await synchronizeStateForRead(currentTab);
  if (!state || !currentTab.url || state.pageUrl !== currentTab.url) {
    throw new Error('当前媒体正在自动更新，请刷新常规下载列表');
  }
  const products = mediaDockProducts(state);
  const grant = await mediaDockGrantBroker.consume(qualityToken ?? token, {
    tabId,
    pageUrl: state.pageUrl,
    mediaEpoch: state.mediaEpoch ?? 0,
    mediaIdentity: mediaDockIdentity(state),
    snapshotRevision: mediaDockRevision(state, products),
    mode,
  });
  const product = products.find((candidate) => candidate.id === grant.productId);
  if (!product) throw new Error('当前成品视频已变化，请刷新常规下载列表');
  const selection = selectProductDownload(product, mode, grant.qualityId);
  const { video, audio, videoTrack, audioTrack } = validateMediaProductDownload(state, {
    productId: product.id,
    mode: selection.mode,
    videoAssetId: selection.videoAssetId,
    ...(selection.audioAssetId ? { audioAssetId: selection.audioAssetId } : {}),
    ...(selection.videoTrackId ? { videoTrackId: selection.videoTrackId } : {}),
    ...(selection.qualityId ? { qualityId: selection.qualityId } : {}),
    ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
  });

  if (selection.mode === 'complete' && audio) {
    // Publish a cancellable identity before any permission/initialization wait.
    // The page never receives a private job id as an action capability.
    const created = await createMergeJob(
      state,
      video,
      audio,
      undefined,
      audioTrack ? { videoTrack, audioTrack } : undefined,
      true,
    );
    let pending = await assertMergeTaskAcceptsWork(created.jobId);
    pending = transitionMergeJob(transitionMergeJob(pending, 'resolving'), 'permission_required');
    await mergeJobStore.save(pending);
    await publishMergeDock(pending);
    const granted = await permissionRequestSettled(
      permissionRequest,
      FULL_MEDIA_ACCESS_PERMISSIONS,
    );
    await assertMergeTaskAcceptsWork(created.jobId);
    if (!granted) return { mode: 'merge', jobId: created.jobId };
    await refreshMediaDocksAfterPermissionAdded();
    const latest = await getTabState(tabId);
    if (
      !latest ||
      latest.pageUrl !== state.pageUrl ||
      (latest.mediaEpoch ?? 0) !== (state.mediaEpoch ?? 0)
    ) {
      await cancelMergeDockJob(pending);
      throw new Error('播放器已变化，请重新选择当前视频。');
    }
    await assertMergeTaskAcceptsWork(created.jobId);
    await startMergePreflight(created.jobId);
    return { mode: 'merge', jobId: created.jobId };
  }

  const selected = selection.mode === 'audio-only' ? audio : video;
  if (!selected) throw new Error('当前成品缺少所选轨道');
  const action: Extract<PermissionGatedMediaAction, { kind: 'download-media-product' }> = {
    kind: 'download-media-product',
    tabId,
    productId: product.id,
    mode: selection.mode,
    videoAssetId: video.id,
    ...(audio ? { audioAssetId: audio.id } : {}),
    ...(selection.videoTrackId ? { videoTrackId: selection.videoTrackId } : {}),
    ...(selection.qualityId ? { qualityId: selection.qualityId } : {}),
    expectedPageUrl: state.pageUrl,
    expectedMediaEpoch: state.mediaEpoch ?? 0,
    ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
  };
  const required = narrowMediaPermissions([selected]);
  const intent = createPermissionIntent(action, required) as PermissionGatedMediaIntent;
  await permissionMediaIntentStore.stage(intent);
  const granted = await permissionRequestSettled(permissionRequest, required);
  if (!granted) {
    await permissionMediaIntentStore.cancel(intent.id).catch(() => undefined);
    throw new Error('未获得所选媒体来源权限，无法开始下载');
  }
  await refreshMediaDocksAfterPermissionAdded();
  const result = await commitPermissionMediaIntent(intent.id);
  if (result.kind !== 'download-media-product') {
    throw new Error('下载任务类型不匹配，请重新点击下载');
  }
  return result.result;
}

async function handleUiRequest(
  message: UiRequest,
  sender?: chrome.runtime.MessageSender,
  mergePermissionRequest?: Promise<boolean>,
  mediaDownloadPermissionRequest?: Promise<boolean>,
  youtubeDockPermissionRequest?: { owner: YouTubeTaskOwner; permission: Promise<boolean> },
): Promise<ApiResponse<unknown>> {
  if (
    sender?.url?.startsWith(chrome.runtime.getURL('settings-float.html')) &&
    !(await verifySettingsFrame(sender))
  )
    throw new Error('设置会话已失效，请重新打开设置。');
  switch (message.type) {
    case 'VERIFY_SETTINGS_FRAME':
      return success(!!sender && (await verifySettingsFrame(sender)));
    case 'RELEASE_SETTINGS_FRAME':
      if (sender) await releaseSettingsFrame(sender);
      return success(null);
    case 'ISSUE_SETTINGS_FRAME': {
      const path = sender?.url?.split(/[?#]/)[0];
      if (
        sender?.id !== chrome.runtime.id ||
        !['popup.html', 'sidepanel.html', 'options.html'].some(
          (p) => path === chrome.runtime.getURL(p),
        )
      )
        throw new Error('设置入口无效。');
      return success(await issueSettingsFrame(sender.tab?.id));
    }
    case 'VERIFY_YOUTUBE_DIRECTORY_PICKER':
    case 'CONFIRM_YOUTUBE_DIRECTORY_PICKER':
    case 'CANCEL_YOUTUBE_DIRECTORY_PICKER': {
      if (
        !sender ||
        sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        !sender.documentId ||
        sender.tab?.id === undefined ||
        sender.tab.windowId === undefined ||
        typeof message.nonce !== 'string' ||
        sender.url !==
          `${chrome.runtime.getURL('youtube-directory-picker.html')}?nonce=${encodeURIComponent(message.nonce)}`
      )
        throw new Error('目录选择请求无效，请从当前视频重新打开。');
      const identity = {
        tabId: sender.tab.id,
        windowId: sender.tab.windowId,
        documentId: sender.documentId,
      };
      if (message.type === 'CONFIRM_YOUTUBE_DIRECTORY_PICKER') {
        assertNewVideoSavePolicy('https://www.youtube.com/', { mode: 'custom' });
        const target = await youtubeDirectoryPickers.confirm(message.nonce, identity);
        await mergeDirectoryPolicyQueue.run('youtube', () =>
          saveMergeDownloadPathPolicy('https://www.youtube.com/', {
            mode: 'custom',
            directory: target,
          }),
        );
        return success(target);
      }
      const context = await youtubeDirectoryPickers.ready(message.nonce, identity);
      if (message.type === 'CANCEL_YOUTUBE_DIRECTORY_PICKER') {
        await youtubeDirectoryPickers.close(message.nonce);
        return success(null);
      }
      return success(context);
    }
    case 'OPEN_YOUTUBE_DIRECTORY_PICKER':
    case 'GET_YOUTUBE_DIRECTORY_TARGET':
    case 'GET_YOUTUBE_SELECTION':
    case 'SET_YOUTUBE_SELECTION':
    case 'START_YOUTUBE_DOWNLOAD':
    case 'STAGE_YOUTUBE_DOWNLOAD_PERMISSION':
    case 'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION':
    case 'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION':
    case 'GET_YOUTUBE_DOWNLOAD':
    case 'RECHECK_YOUTUBE_DOWNLOAD':
    case 'GET_CURRENT_YOUTUBE_DOWNLOAD':
    case 'GET_YOUTUBE_PERMISSION_CAPABILITY':
    case 'RETRY_YOUTUBE_SAVE':
    case 'DISCARD_YOUTUBE_SAVE':
    case 'OPEN_YOUTUBE_PERMISSIONS':
    case 'CANCEL_YOUTUBE_DOWNLOAD': {
      if (!sender || sender.id !== chrome.runtime.id)
        throw new Error('下载请求必须来自当前视频页。');
      let tabId: number;
      let documentId: string;
      let pageUrl: string;
      const extensionUi = [
        chrome.runtime.getURL('popup.html'),
        chrome.runtime.getURL('sidepanel.html'),
      ].includes(sender.url ?? '');
      if (
        [
          'STAGE_YOUTUBE_DOWNLOAD_PERMISSION',
          'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION',
          'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION',
        ].includes(message.type) &&
        !extensionUi
      )
        throw new Error('请在扩展弹窗或侧边栏中确认本次授权。');
      if (!extensionUi && sender.tab) {
        if (
          sender.frameId !== 0 ||
          !sender.documentId ||
          !Number.isSafeInteger(sender.tab.id) ||
          (message.tabId !== undefined && message.tabId !== sender.tab.id)
        )
          throw new Error('下载请求必须来自当前视频页。');
        tabId = sender.tab.id!;
        // A content script can survive a YouTube history navigation. Resolve
        // the live URL, but never let a retired document act for the new one.
        const frames = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => location.href,
        });
        const frame = frames.find((result) => result.frameId === 0);
        if (frame?.documentId !== sender.documentId || typeof frame.result !== 'string')
          throw new Error('PAGE_IDENTITY_CHANGED');
        documentId = frame.documentId;
        pageUrl = frame.result;
      } else {
        if (!extensionUi || !Number.isSafeInteger(message.tabId) || message.tabId! < 0)
          throw new Error('下载请求必须来自当前视频页。');
        tabId = message.tabId!;
        // Bind extension UI requests to the document actually present in its
        // selected tab; never accept a document or page URL supplied by the UI.
        const frames = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => location.href,
        });
        const frame = frames.find((result) => result.frameId === 0);
        if (!frame?.documentId || typeof frame.result !== 'string')
          throw new Error('视频页面已切换，请重新打开下载面板。');
        documentId = frame.documentId;
        pageUrl = frame.result;
      }
      const route = URL.canParse(pageUrl) ? new URL(pageUrl) : undefined;
      if (
        !route ||
        route.protocol !== 'https:' ||
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(route.hostname) ||
        route.pathname !== '/watch'
      )
        throw new Error('下载请求必须来自 YouTube 视频页。');
      const owner: YouTubeTaskOwner = {
        tabId,
        documentId,
        pageUrl,
        navigationEpoch: navigationEpoch(tabId),
        mediaEpoch: currentMediaEpoch(tabId),
      };
      if (message.type === 'OPEN_YOUTUBE_PERMISSIONS') {
        await assertYouTubeTaskPage(owner);
        const result = await openSettingsPage('permissions', tabId, (target, token, section) =>
          sendAgentRequest(target, 0, {
            type: 'AGENT_OPEN_SETTINGS',
            token,
            ...(section ? { section } : {}),
          }),
        );
        if (!result.opened) throw new Error('无法打开网页设置，请从插件设置中管理授权。');
        return success(result);
      }
      if (message.type === 'GET_YOUTUBE_PERMISSION_CAPABILITY') {
        if (extensionUi) throw new Error('此授权入口仅供视频页面使用。');
        await assertYouTubeTaskPage(owner);
        return success(youtubeDockPermissionCapabilities.issue(owner));
      }
      if (message.type === 'GET_CURRENT_YOUTUBE_DOWNLOAD') {
        await ensureYouTubeTasksRestored();
        return success(youtubeBackgroundTasks.current(owner, route.searchParams.get('v') ?? ''));
      }
      if (
        message.type === 'OPEN_YOUTUBE_DIRECTORY_PICKER' ||
        message.type === 'GET_YOUTUBE_DIRECTORY_TARGET'
      ) {
        assertNewVideoSavePolicy('https://www.youtube.com/', { mode: 'custom' });
        if (
          message.videoId !== route.searchParams.get('v') ||
          !/^[\w-]{11}$/u.test(message.videoId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            message.jobId,
          )
        )
          throw new Error('目录选择请求无效。');
        await assertYouTubeTaskPage(owner);
        if (owner.mediaEpoch < 0 || owner.navigationEpoch < 0)
          throw new Error('视频信息尚未恢复，请重新加载视频页面后再选择保存目录。');
        if (message.type === 'GET_YOUTUBE_DIRECTORY_TARGET') {
          const directoryOwner = {
            ...owner,
            jobId: message.jobId,
            videoId: message.videoId,
          };
          const confirmed = youtubeDirectoryGrants.confirmed(directoryOwner);
          if (
            !confirmed &&
            message.nonce !== undefined &&
            (typeof message.nonce !== 'string' ||
              !youtubeDirectoryPickers.waiting(message.nonce, directoryOwner))
          )
            throw new Error('目录选择已结束，请重新选择。');
          return success(confirmed);
        }
        await ensureYouTubeTasksRestored();
        if (youtubeBackgroundTasks.status(message.jobId, owner))
          throw new Error('下载任务已开始，不能更改保存目录。');
        return success({
          nonce: await youtubeDirectoryPickers.open({
            ...owner,
            jobId: message.jobId,
            videoId: message.videoId,
          }),
        });
      }
      if (message.type === 'GET_YOUTUBE_SELECTION' || message.type === 'SET_YOUTUBE_SELECTION') {
        await assertYouTubeTaskPage(owner);
        if (message.videoId !== route.searchParams.get('v'))
          throw new Error('PAGE_IDENTITY_CHANGED');
        return success(
          await youtubeSelectionPreferences.access(
            tabId,
            message.videoId,
            message.type === 'SET_YOUTUBE_SELECTION' ? message.draft : undefined,
          ),
        );
      }
      if (
        typeof message.jobId !== 'string' ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(message.jobId)
      )
        throw new Error('下载任务编号无效。');
      await ensureYouTubeTasksRestored();
      if (message.type === 'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION')
        return success(await youtubePermissionContinuation.commit(message.jobId, owner));
      if (message.type === 'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION') {
        await youtubePermissionContinuation.cancel(message.jobId, owner);
        return success(null);
      }
      if (message.type === 'GET_YOUTUBE_DOWNLOAD')
        return success(youtubeBackgroundTasks.status(message.jobId, owner));
      if (message.type === 'RECHECK_YOUTUBE_DOWNLOAD')
        return success(await youtubeBackgroundTasks.recheck(message.jobId, owner));
      if (message.type === 'RETRY_YOUTUBE_SAVE')
        return success(youtubeBackgroundTasks.retry(message.jobId, owner));
      if (message.type === 'DISCARD_YOUTUBE_SAVE')
        return success(await youtubeBackgroundTasks.discard(message.jobId, owner));
      if (message.type === 'CANCEL_YOUTUBE_DOWNLOAD')
        return success(await youtubeBackgroundTasks.cancelAndRecord(message.jobId, owner));
      const selection = message.selection;
      if (
        message.saveLocation !== undefined &&
        !['browser-default', 'ask', 'custom'].includes(message.saveLocation)
      )
        throw new Error('保存位置选择无效。');
      if (
        !selection ||
        typeof selection !== 'object' ||
        typeof selection.videoId !== 'string' ||
        selection.videoId !== route.searchParams.get('v') ||
        !/^[\w-]{11}$/u.test(selection.videoId) ||
        typeof selection.videoTrackId !== 'string' ||
        (selection.preference !== undefined &&
          !['compatibility', 'quality', 'size'].includes(selection.preference)) ||
        selection.videoTrackId.length > 1024 ||
        (selection.audioTrackId !== undefined &&
          (typeof selection.audioTrackId !== 'string' || selection.audioTrackId.length > 1024)) ||
        !['auto', 'mp4', 'webm'].includes(selection.container) ||
        !['merge', 'separate'].includes(selection.mode ?? 'merge')
      )
        throw new Error('视频或音轨选择无效，请重新选择。');
      if (message.saveLocation !== 'custom' && message.directorySessionId !== undefined)
        throw new Error('保存位置选择无效。');
      let directoryTarget: { handleId: string } | undefined;
      if (message.saveLocation === 'custom') {
        assertNewVideoSavePolicy('https://www.youtube.com/', { mode: 'custom' });
        if (typeof message.directorySessionId !== 'string')
          throw new Error('请先选择本次下载的保存目录。');
        await assertYouTubeTaskPage(owner);
        const target = youtubeDirectoryGrants.target(message.directorySessionId, {
          ...owner,
          jobId: message.jobId,
          videoId: selection.videoId,
        });
        directoryTarget = { handleId: target.handleId };
      }
      const request = {
        jobId: message.jobId,
        owner,
        saveLocation: message.saveLocation ?? 'browser-default',
        ...(directoryTarget ? { directoryTarget } : {}),
        selection: {
          videoId: selection.videoId,
          ...(selection.preference ? { preference: selection.preference } : {}),
          videoTrackId: selection.videoTrackId,
          ...(selection.audioTrackId ? { audioTrackId: selection.audioTrackId } : {}),
          container: selection.container,
          mode: selection.mode ?? 'merge',
        },
      };
      if (message.type === 'START_YOUTUBE_DOWNLOAD' && message.permissionToken !== undefined) {
        if (
          !extensionUi &&
          !youtubeDockPermissionRequest &&
          (await chrome.permissions.contains(YOUTUBE_SOURCE_PERMISSIONS))
        ) {
          await assertYouTubeTaskPage(owner);
          return success(youtubeBackgroundTasks.start(request));
        }
        if (extensionUi || !youtubeDockPermissionRequest)
          throw new Error('本次授权入口已失效，请重新打开面板后重试。');
        if (
          Object.entries(youtubeDockPermissionRequest.owner).some(
            ([key, value]) => owner[key as keyof YouTubeTaskOwner] !== value,
          )
        )
          throw new Error('PAGE_IDENTITY_CHANGED');
        const id = await youtubePermissionContinuation.stage(request);
        if (!(await youtubeDockPermissionRequest.permission)) {
          await youtubePermissionContinuation.cancel(id, owner);
          throw new Error('未允许访问 YouTube 视频来源，下载未开始。');
        }
        return success(await youtubePermissionContinuation.commit(id, owner));
      }
      if (message.type === 'STAGE_YOUTUBE_DOWNLOAD_PERMISSION') {
        const id = await youtubePermissionContinuation.stage(request);
        // A permission event can precede durable staging if the popup closes.
        // Rechecking after staging covers that ordering without changing the job ID.
        await youtubePermissionContinuation.resumePending();
        return success(id);
      }
      return success(youtubeBackgroundTasks.start(request));
    }
    case 'GET_ACTIVE_TAB': {
      const tab = await getActiveTab();
      return success<ActiveTabInfo>({
        tabId: tab.id!,
        title: tab.title ?? '当前页面',
        url: tab.url ?? '',
      });
    }
    case 'SCAN_TAB': {
      const state = await scanTab(message.tabId, true);
      if (message.showController) {
        await sendPlaybackCommand(state.tabId, { action: 'showController' }, 0);
      }
      return success(state);
    }
    case 'GET_TAB_STATE': {
      const tab = await resolveTab(message.tabId);
      const state = await synchronizeStateForRead(tab);
      return success(
        state ?? {
          tabId: tab.id!,
          pageUrl: tab.url ?? '',
          pageTitle: tab.title ?? '当前页面',
          scannedAt: 0,
          status: 'idle',
          assets: [],
          mediaElements: [],
        },
      );
    }
    case 'DOWNLOAD_ASSETS': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      const state = await synchronizeStateForRead(tab);
      if (!state || state.pageUrl !== (tab.url ?? '')) {
        throw new Error('当前媒体正在自动更新，请稍后再试');
      }
      assertDirectMediaDownloadContext(state, tab.url ?? '', {
        kind: 'download-assets',
        tabId: tab.id,
        assetIds: message.assetIds,
        expectedPageUrl: message.expectedPageUrl ?? '',
        expectedMediaEpoch: message.expectedMediaEpoch as number,
        ...(message.expectedMedia ? { expectedMedia: message.expectedMedia } : {}),
      });
      const selectedIds = [...new Set(message.assetIds)];
      const selected = selectedIds.map((assetId) =>
        state.assets.find((asset) => asset.id === assetId && asset.downloadable),
      );
      if (
        selectedIds.length === 0 ||
        selectedIds.length !== message.assetIds.length ||
        selected.some((asset) => !asset || asset.pageUrl !== state.pageUrl)
      ) {
        throw new Error('当前媒体已变化或没有可下载资源，列表会自动更新');
      }
      await assertDirectMediaAssetPermissions(selected as MediaAsset[]);
      return success(await startAssetDownloads(tab.id, state, selected as MediaAsset[]));
    }
    case 'DOWNLOAD_MEDIA_PRODUCT': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      const state = await synchronizeStateForRead(tab);
      if (!state || state.pageUrl !== (tab.url ?? '')) {
        throw new Error('当前媒体正在自动更新，请稍后再试');
      }
      assertDirectMediaDownloadContext(state, tab.url ?? '', {
        kind: 'download-media-product',
        tabId: tab.id,
        productId: message.productId,
        mode: message.mode,
        videoAssetId: message.videoAssetId,
        ...(message.audioAssetId ? { audioAssetId: message.audioAssetId } : {}),
        ...(message.videoTrackId ? { videoTrackId: message.videoTrackId } : {}),
        ...(message.qualityId ? { qualityId: message.qualityId } : {}),
        expectedPageUrl: message.expectedPageUrl ?? '',
        expectedMediaEpoch: message.expectedMediaEpoch as number,
        ...(message.expectedMedia ? { expectedMedia: message.expectedMedia } : {}),
      });

      const { video, audio } = validateMediaProductDownload(state, {
        productId: message.productId,
        mode: message.mode,
        videoAssetId: message.videoAssetId,
        ...(message.audioAssetId ? { audioAssetId: message.audioAssetId } : {}),
        ...(message.videoTrackId ? { videoTrackId: message.videoTrackId } : {}),
        ...(message.qualityId ? { qualityId: message.qualityId } : {}),
        ...(message.expectedMedia ? { expectedMedia: message.expectedMedia } : {}),
      });

      let result: MediaProductDownloadResult;
      if (message.mode === 'complete') {
        if (audio) {
          throw new Error('完整视频合并必须通过权限确认后启动，请重新点击下载');
        } else {
          await assertDirectMediaAssetPermissions([video]);
          const downloads = await startAssetDownloads(tab.id, state, [video]);
          result = { mode: 'download', downloads };
        }
      } else {
        const selected = message.mode === 'audio-only' ? audio : video;
        if (!selected) throw new Error('尚未识别到可下载的独立音轨');
        await assertDirectMediaAssetPermissions([selected]);
        const downloads = await startAssetDownloads(tab.id, state, [selected]);
        result = { mode: 'download', downloads };
      }
      return success(result);
    }
    case 'STAGE_MEDIA_ACCESS_INTENT': {
      await mediaAccessIntentStore.stage(message.intent);
      if (await hasFullMediaAccess()) {
        void commitMediaAccessIntent(message.intent.id).catch(() => undefined);
      }
      return success<MediaAccessIntentStaged>({ intentId: message.intent.id });
    }
    case 'COMMIT_MEDIA_ACCESS_INTENT': {
      return success(await commitMediaAccessIntent(message.intentId));
    }
    case 'CANCEL_MEDIA_ACCESS_INTENT': {
      await mediaAccessIntentStore.cancel(message.intentId);
      return success(null);
    }
    case 'STAGE_PERMISSION_MEDIA_INTENT': {
      const { permissions } = await validatePermissionMediaIntent(message.intent);
      const canonicalIntent: PermissionGatedMediaIntent = {
        ...message.intent,
        permissions,
      };
      await permissionMediaIntentStore.stage(canonicalIntent);
      if (await hasPermissionIntentAccess(canonicalIntent)) {
        void commitPermissionMediaIntent(canonicalIntent.id).catch(() => undefined);
      }
      return success<PermissionGatedMediaIntentStaged>({ intentId: canonicalIntent.id });
    }
    case 'COMMIT_PERMISSION_MEDIA_INTENT': {
      return success(await commitPermissionMediaIntent(message.intentId));
    }
    case 'CANCEL_PERMISSION_MEDIA_INTENT': {
      await permissionMediaIntentStore.cancel(message.intentId);
      return success(null);
    }
    case 'GET_MEDIA_DOCK_RESOURCES': {
      if (!sender) throw new Error('常规下载请求缺少页面上下文');
      const tab = requireTopFrameMediaDockSender(sender);
      return success(await convergedMediaDockSnapshot(tab.id!, message.force === true));
    }
    case 'DOWNLOAD_MEDIA_DOCK_PRODUCT': {
      if (!sender) throw new Error('常规下载请求缺少页面上下文');
      return success(
        await downloadMediaDockProduct(
          message.token,
          message.mode,
          sender,
          mediaDownloadPermissionRequest,
          message.qualityToken,
        ),
      );
    }
    case 'RUN_MERGE_DOCK_ACTION': {
      if (!sender) throw new Error('合并下载请求缺少页面上下文');
      if (
        typeof message.token !== 'string' ||
        (message.action !== 'merge' && message.action !== 'separate' && message.action !== 'cancel')
      ) {
        throw new Error('无效的合并下载操作');
      }
      try {
        return success(
          await runMergeDockAction(message.token, message.action, sender, mergePermissionRequest),
        );
      } finally {
        mergeDockGrantBroker.releasePermissionClaim(message.token);
      }
    }
    case 'SET_MERGE_DOCK_PATH_MODE': {
      if (!sender) throw new Error('保存位置请求缺少页面上下文');
      if (
        typeof message.token !== 'string' ||
        (message.mode !== 'automatic' && message.mode !== 'ask' && message.mode !== 'remembered')
      ) {
        throw new Error('无效的保存位置策略');
      }
      return success(await updateMergeDockPathMode(message.token, message.mode, sender));
    }
    case 'OPEN_MERGE_DIRECTORY_PICKER': {
      if (!sender || typeof message.token !== 'string') {
        throw new Error('无效的保存位置窗口请求');
      }
      return success(await openMergeDirectoryPicker(message.token, sender));
    }
    case 'VERIFY_MERGE_DIRECTORY_PICKER': {
      if (!sender || typeof message.sessionId !== 'string') {
        throw new Error('无效的保存位置请求');
      }
      return success(await mergeDirectoryPickerContext(message.sessionId, sender));
    }
    case 'SET_MERGE_DIRECTORY_TARGET': {
      if (
        !sender ||
        typeof message.sessionId !== 'string' ||
        (message.mode !== 'automatic' && message.mode !== 'custom')
      ) {
        throw new Error('无效的自定义保存位置请求');
      }
      return success(
        await setMergeDirectoryTarget(message.sessionId, message.mode, sender, message.directory),
      );
    }
    case 'CANCEL_MERGE_DIRECTORY_PICKER': {
      if (!sender || typeof message.sessionId !== 'string') {
        throw new Error('无效的目录选择取消请求');
      }
      await cancelMergeDirectoryPicker(message.sessionId, sender);
      return success(null);
    }
    case 'GET_MERGE_DOCK_VIEW': {
      if (!sender) throw new Error('合并任务请求缺少页面上下文');
      if (typeof message.token !== 'string') throw new Error('无效的合并任务凭据');
      const job = await authorizedMergeDockJob(message.token, 'action', sender);
      return success(await mergeDockView(job));
    }
    case 'START_SOURCE_CAPTURE': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      const expected =
        message.expectedPageUrl != null && message.expectedMediaEpoch != null
          ? {
              kind: 'capture-source' as const,
              tabId: tab.id,
              blobAssetId: message.blobAssetId,
              expectedPageUrl: message.expectedPageUrl,
              expectedMediaEpoch: message.expectedMediaEpoch,
              ...(message.expectedMedia ? { expectedMedia: message.expectedMedia } : {}),
            }
          : undefined;
      return success(await startSourceCapture(tab.id, message.blobAssetId, expected));
    }
    case 'RELOAD_SOURCE_CAPTURE': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      return success(await reloadSourceCapture(tab.id, message.captureId));
    }
    case 'DOWNLOAD_RESOLVED_SOURCE': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      return success(await downloadResolvedSource(tab.id, message.captureId));
    }
    case 'CANCEL_SOURCE_CAPTURE': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      await cancelSourceCapture(tab.id, message.captureId);
      return success(null);
    }
    case 'OPEN_VIDEO_VIEW': {
      if (
        !sender ||
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        !['popup.html', 'sidepanel.html'].some((page) => sender.url === chrome.runtime.getURL(page))
      )
        throw new Error('视频入口请求无效。');
      if (!['resources', 'playback'].includes(message.target)) throw new Error('无效的界面目标');
      const tab = await chrome.tabs.get(message.tabId);
      const state = await getTabState(message.tabId);
      if (
        !state ||
        tab.url !== message.pageUrl ||
        state.pageUrl !== message.pageUrl ||
        (state.mediaEpoch ?? 0) !== message.mediaEpoch
      )
        throw new Error('当前视频已变化，请重新打开入口。');
      const reply = (await sendAgentRequest(message.tabId, 0, {
        ...message,
        type: 'AGENT_OPEN_VIDEO_VIEW',
      })) as ApiResponse<PlaybackCommandResult> | undefined;
      if (!reply?.ok || !reply.data.applied)
        throw new Error(reply && !reply.ok ? reply.error : '无法打开控制器，请重试。');
      clearResourceCenterPendingTimer(message.tabId);
      const ports = [...(resourceCenterPorts.get(message.tabId) ?? [])];
      resourceCenterPorts.delete(message.tabId);
      for (const port of ports) {
        resourceCenterBindings.delete(port);
        try {
          port.postMessage({ type: 'RESOURCE_CENTER_YIELD' });
        } catch {
          /* disconnected surface */
        }
      }
      return success(null);
    }
    case 'PLAYBACK_COMMAND': {
      const tab = await resolveTab(message.tabId);
      if (!tab.id) throw new Error('标签页缺少 ID');
      return success(
        await sendPlaybackCommand(tab.id, message.command, message.frameId, message.elementId),
      );
    }
    case 'GET_SETTINGS':
      return success(await getSettings());
    case 'SAVE_SETTINGS': {
      const settings = await saveSettings(message.patch, message.base);
      const tabs = await chrome.tabs.query({});
      await Promise.all(
        tabs.map(async (tab) => {
          if (!tab.id) return;
          const state = await getTabState(tab.id);
          const frameIds = new Set([
            0,
            ...(state?.assets.map((asset) => asset.frameId) ?? []),
            ...(state?.mediaElements.map((element) => element.frameId) ?? []),
          ]);
          await Promise.all(
            [...frameIds].map(async (frameId) => {
              try {
                await chrome.tabs.sendMessage(
                  tab.id!,
                  { type: 'AGENT_APPLY_SETTINGS', settings },
                  { frameId },
                );
              } catch {
                // No agent is injected in this frame.
              }
            }),
          );
        }),
      );
      await broadcast({ type: 'SETTINGS_UPDATED', settings });
      return success(settings);
    }
    case 'OPEN_SIDE_PANEL': {
      if (message.tabId == null) throw new Error('标签页缺少 ID');
      // This must be the first gated Chrome call in the message handler so user activation survives.
      await chrome.sidePanel.open({ tabId: message.tabId });
      markResourceCenterOpening(message.tabId);
      return success(null);
    }
    case 'START_MSE_CACHE_CAPTURE': {
      const agentTab = message.tabId == null ? sender?.tab : undefined;
      const tab = agentTab ?? (await resolveTab(message.tabId));
      const pageUrl = resolveCacheCapturePageUrl(tab.url, sender?.url, agentTab != null);
      if (!tab.id || !pageUrl || !canInject(pageUrl)) {
        throw new Error('当前页面无法启动缓存捕获');
      }
      if (isYouTubePage(pageUrl)) throw new Error('YouTube 缓存下载暂未开放。');
      if (agentTab) {
        const frameId = message.frameId ?? sender?.frameId ?? 0;
        const sessionId = await startMseCacheCaptureForFrame(
          tab.id,
          frameId,
          tab.title || '当前页面',
          undefined,
          false,
          message.expectedPageUrl ?? pageUrl,
          message.expectedMedia,
        );
        return success({ sessionId });
      }
      let state = await getTabState(tab.id);
      if (!state || state.pageUrl !== pageUrl) state = await scanTab(tab.id);
      const preferredElement = state.mediaElements[0];
      const preferredAsset = state.assets.find(
        (asset) => asset.kind === 'video' || asset.kind === 'audio',
      );
      const frameId = message.frameId ?? preferredElement?.frameId ?? preferredAsset?.frameId ?? 0;
      const expectedMedia = message.expectedMedia ?? state.activeMedia;
      const sessionId = await startMseCacheCaptureForFrame(
        tab.id,
        frameId,
        state.pageTitle || tab.title || '当前页面',
        undefined,
        false,
        pageUrl,
        expectedMedia,
      );
      return success({ sessionId });
    }
    case 'RESET_MSE_CACHE_AND_RELOAD': {
      const tabId = message.tabId ?? sender?.tab?.id;
      if (tabId == null) throw new Error('标签页缺少 ID');
      await resetCacheAndReload(tabId, message.frameId ?? sender?.frameId ?? 0);
      return success(null);
    }
    case 'OPEN_OPTIONS':
      if (sender?.id !== chrome.runtime.id) throw new Error('设置入口无效。');
      return success(
        await openSettingsPage(
          undefined,
          sender?.tab?.id ?? message.tabId,
          (target, token, section) =>
            sendAgentRequest(target, 0, {
              type: 'AGENT_OPEN_SETTINGS',
              token,
              ...(section ? { section } : {}),
            }),
        ),
      );
    case 'GET_DOWNLOADS':
      return success(await getDownloadHistory());
    case 'CLEAR_DOWNLOADS': {
      const downloads = await getDownloadHistory();
      const activeDownloads = downloads.filter(
        (record) => record.state === 'queued' || record.state === 'downloading',
      );
      await releaseMediaRequestContexts(
        downloads.flatMap((record) =>
          record.state === 'queued' || record.state === 'downloading'
            ? []
            : record.requestRuleId == null
              ? []
              : [record.requestRuleId],
        ),
      ).catch(() => undefined);
      const remainingDownloads =
        activeDownloads.length === 0
          ? await saveDownloadHistory([])
          : await saveDownloadHistory(activeDownloads);
      await broadcast({ type: 'DOWNLOADS_UPDATED', downloads: remainingDownloads });
      return success(null);
    }
  }
}

function isAgentEvent(message: unknown): boolean {
  if (message == null || typeof message !== 'object' || !('type' in message)) return false;
  return (
    (message as { type?: string }).type === 'AGENT_STATE' ||
    (message as { type?: string }).type === 'AGENT_PAGE_CHANGED' ||
    (message as { type?: string }).type === 'AGENT_READY'
  );
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void getSettings().catch(() =>
      chrome.storage.sync.set({ 'foxfetch:settings': DEFAULT_SETTINGS }),
    );
    void reinjectOpenAutomaticMediaAgents();
  });

  chrome.runtime.onStartup.addListener(() => {
    void reinjectOpenAutomaticMediaAgents();
    void resumePendingMediaAccessIntents();
    void resumePendingPermissionMediaIntents();
    void recoverMergeJobs();
  });

  startNetworkObserver(mergeNetworkAsset, captureNetworkObservation, currentMediaEpoch);
  void resumePendingMediaAccessIntents();
  void resumePendingPermissionMediaIntents();
  void recoverMergeJobs();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'foxfetch-resource-center') return;
    port.onMessage.addListener((message: unknown) => {
      if (
        message != null &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'BIND_RESOURCE_CENTER' &&
        Number.isInteger((message as { tabId?: unknown }).tabId)
      ) {
        bindResourceCenterPort(port, (message as { tabId: number }).tabId);
      }
    });
    port.onDisconnect.addListener(() => unbindResourceCenterPort(port));
  });

  chrome.permissions.onAdded.addListener((permissions) => {
    if (permissions.permissions?.includes('webRequest') || permissions.origins?.length) {
      startNetworkObserver(mergeNetworkAsset, captureNetworkObservation, currentMediaEpoch);
    }
    void (async () => {
      await resumePermissionContinuations();
      await youtubePermissionContinuation.resumePending();
      await refreshMediaDocksAfterPermissionAdded();
    })();
  });

  chrome.permissions.onRemoved.addListener((permissions) => {
    youtubeContextObservations.clearAll();
    if (permissions.permissions?.includes('webRequest') || permissions.origins?.length) {
      stopNetworkObserver();
      startNetworkObserver(mergeNetworkAsset, captureNetworkObservation, currentMediaEpoch);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // A content-script click preserves user activation only for this synchronous
    // message turn. Only a capability that this live Service Worker issued for
    // the active tab may open Chrome's durable optional-permission prompt.
    let mergePermissionRequest: Promise<boolean> | undefined;
    let mediaDownloadPermissionRequest: Promise<boolean> | undefined;
    let youtubeDockPermissionRequest:
      { owner: YouTubeTaskOwner; permission: Promise<boolean> } | undefined;
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'START_YOUTUBE_DOWNLOAD' &&
      sender.id === chrome.runtime.id &&
      sender.frameId === 0 &&
      sender.tab?.id !== undefined &&
      sender.documentId
    ) {
      const owner = youtubeDockPermissionCapabilities.claimDocument(
        (message as { permissionToken?: unknown }).permissionToken,
        {
          tabId: sender.tab.id,
          documentId: sender.documentId,
          navigationEpoch: navigationEpoch(sender.tab.id),
          mediaEpoch: currentMediaEpoch(sender.tab.id),
        },
      );
      if (owner)
        try {
          youtubeDockPermissionRequest = {
            owner,
            permission: chrome.permissions.request(YOUTUBE_SOURCE_PERMISSIONS).catch(() => false),
          };
        } catch {
          youtubeDockPermissionRequest = { owner, permission: Promise.resolve(false) };
        }
    }
    const mergePermissionToken = claimMergeDockPermissionFromMessage(
      message,
      sender,
      mergeDockGrantBroker,
    );
    if (mergePermissionToken) {
      try {
        mergePermissionRequest = requestFullMediaAccess().catch(() => false);
      } catch {
        mergePermissionRequest = Promise.resolve(false);
      }
    }
    if (claimMediaDockPermissionFromMessage(message, sender, mediaDockGrantBroker)) {
      try {
        mediaDownloadPermissionRequest = requestFullMediaAccess().catch(() => false);
      } catch {
        mediaDownloadPermissionRequest = Promise.resolve(false);
      }
    }
    void (async () => {
      try {
        if (isMergeOffscreenEvent(message)) {
          const expectedUrl = chrome.runtime.getURL(MERGE_OFFSCREEN_DOCUMENT_PATH);
          if (sender.tab || sender.url !== expectedUrl) {
            sendResponse(failure('拒绝非后台合并宿主的任务事件'));
            return;
          }
          await handleMergeOffscreenEvent(message);
          sendResponse(success(null));
          return;
        }
        if (
          message != null &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'AUTO_ACTIVATE_AGENT'
        ) {
          const tabId = sender.tab?.id;
          if (tabId == null || !isAutomaticMediaSite(sender.url ?? sender.tab?.url)) {
            sendResponse(failure('当前页面不在自动媒体识别范围内'));
            return;
          }
          if (
            isYouTubePage(sender.url ?? sender.tab?.url ?? '') &&
            (await getSettings()).youtubeEnabled === false
          ) {
            sendResponse(success(null));
            return;
          }
          if (await resumeCacheRestart(tabId, sender.url ?? sender.tab?.url)) {
            if (resourceCenterPorts.has(tabId)) await setMediaDockSuppressed(tabId, true);
            sendResponse(success(null));
            return;
          }
          if (!(await getSettings()).autoScanGrantedSites) {
            sendResponse(success(null));
            return;
          }
          await ensureMediaAgent(tabId, sender.frameId ?? 0);
          if (resourceCenterPorts.has(tabId)) await setMediaDockSuppressed(tabId, true);
          sendResponse(success(null));
          return;
        }
        if (isAgentEvent(message)) {
          const event = message as AgentEvent;
          if (sender.tab?.id != null) {
            if (sender.documentLifecycle != null && sender.documentLifecycle !== 'active') {
              sendResponse(success(null));
              return;
            }
            const documentLifecycle = sender.documentLifecycle as
              AgentDocumentLifecycle | undefined;
            if (event.type === 'AGENT_PAGE_CHANGED') {
              await handleAgentPageChanged(
                sender.tab.id,
                sender.frameId ?? 0,
                event,
                sender.documentId,
                documentLifecycle,
              );
            } else if (event.type === 'AGENT_STATE') {
              const state = await mergeAgentEvent(
                sender.tab.id,
                sender.frameId ?? 0,
                event,
                sender.documentId,
                documentLifecycle,
              );
              if (state && (sender.frameId ?? 0) === 0) {
                scheduleMediaDockSnapshot(sender.tab.id);
                reconcileMediaSettlementRetry(sender.tab.id, state);
                const documentKey =
                  sender.documentId ?? `${state.pageUrl}\n${state.mediaEpoch ?? 0}`;
                if (mergeDockRestoredDocuments.get(sender.tab.id) !== documentKey) {
                  mergeDockRestoredDocuments.set(sender.tab.id, documentKey);
                  await restoreMergeDockForTab(state);
                }
              }
            } else if (event.type === 'AGENT_READY') {
              const tabId = sender.tab.id;
              const frameId = sender.frameId ?? 0;
              const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
              const routeMatches = Boolean(
                currentTab?.url &&
                sameHttpOrigin(currentTab.url, event.pageUrl) &&
                siteMediaRouteKey(currentTab.url) === siteMediaRouteKey(event.pageUrl),
              );
              if (
                (frameId === 0 && !routeMatches) ||
                !registerReadyFrameDocument(
                  tabId,
                  frameId,
                  sender.documentId,
                  documentLifecycle,
                  event.pageUrl,
                )
              ) {
                sendResponse(success(null));
                return;
              }
              if (frameId === 0) clearTabNavigationGate(tabId);
              scheduleMediaDockSnapshot(tabId);
              if (frameId === 0 && routeMatches && isSupportedMediaVideoPage(event.pageUrl)) {
                void scanTab(tabId).catch(() => undefined);
              }
            }
          }
          sendResponse(success(null));
          return;
        }
        sendResponse(
          await handleUiRequest(
            message as UiRequest,
            sender,
            mergePermissionRequest,
            mediaDownloadPermissionRequest,
            youtubeDockPermissionRequest,
          ),
        );
      } catch (error) {
        sendResponse(failure(error));
      }
    })();
    return true;
  });

  chrome.commands.onCommand.addListener((command) => {
    void (async () => {
      const tab = await getActiveTab();
      if (!tab.id) return;
      const map: Record<string, PlaybackCommand> = {
        'increase-rate': { action: 'adjustRate', delta: 0.25 },
        'decrease-rate': { action: 'adjustRate', delta: -0.25 },
        'reset-rate': { action: 'resetRate' },
        'toggle-controller': { action: 'toggleController' },
      };
      const playbackCommand = map[command];
      if (playbackCommand) await sendPlaybackCommand(tab.id, playbackCommand);
    })().catch(() => undefined);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state && !delta.error && !delta.filename) return;
    const patch: Parameters<typeof updateDownloadByChromeId>[1] = {};
    if (delta.state?.current === 'complete') patch.state = 'complete';
    if (delta.state?.current === 'interrupted') patch.state = 'interrupted';
    if (delta.error?.current) patch.error = delta.error.current;
    if (delta.filename?.current) patch.filename = basenameFromPath(delta.filename.current);
    const mergeTerminalState =
      delta.state?.current === 'complete' || delta.state?.current === 'interrupted'
        ? delta.state.current
        : undefined;
    void updateDownloadByChromeId(delta.id, patch)
      .then(async (downloads) => {
        const record = downloads.find((item) => item.chromeDownloadId === delta.id);
        let publishedDownloads = downloads;
        if (
          record?.requestRuleId != null &&
          (record.state === 'complete' || record.state === 'interrupted')
        ) {
          await releaseMediaRequestContext(record.requestRuleId).catch(() => undefined);
          const cleanedRecord = { ...record };
          delete cleanedRecord.requestRuleId;
          publishedDownloads = await upsertDownloadRecord(cleanedRecord);
        }
        if (record?.state === 'complete' || record?.state === 'interrupted') {
          const fallback = await takeMseDownloadFallback(delta.id);
          if (fallback && record.state === 'interrupted') {
            await triggerMseCacheFallback(fallback, record.error).catch(() => undefined);
          }
        }
        if (mergeTerminalState) {
          await Promise.all([
            finalizeMergeExport(delta.id, mergeTerminalState, delta.error?.current),
            finalizeSeparateExport(delta.id, mergeTerminalState, delta.error?.current),
          ]);
        }
        await broadcast({ type: 'DOWNLOADS_UPDATED', downloads: publishedDownloads });
        if (record?.owner) notifyDownloadActivity(() => pushDownloadActivity(record.owner!.tabId));
      })
      .catch(() => undefined);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    youtubeContextObservations.clear(tabId);
    void youtubeDirectoryPickers.sourceRemoved(tabId).catch(() => undefined);
    downloadActivityRevisions.delete(tabId);
    clearMediaSettlementRetry(tabId);
    clearMainWorldAssets(tabId);
    const mediaDockTimer = mediaDockPushTimers.get(tabId);
    if (mediaDockTimer) clearTimeout(mediaDockTimer);
    mediaDockPushTimers.delete(tabId);
    mediaDockLastPushedRevision.delete(tabId);
    mediaDockRequestSequences.delete(tabId);
    mergeDockRestoredDocuments.delete(tabId);
    void mediaDockGrantBroker.clearTab(tabId).catch(() => undefined);
    void mergeDockGrantBroker.clearTab(tabId).catch(() => undefined);
    void clearMergeDirectoryPickersForSourceTab(tabId).catch(() => undefined);
    clearCaptureAnalysisTimer(tabId);
    clearCaptureTimeout(tabId);
    captureObservationGenerations.delete(tabId);
    captureReloadTabs.delete(tabId);
    tabNavigationEpochs.delete(tabId);
    tabMediaEpochs.delete(tabId);
    tabRouteGenerations.delete(tabId);
    tabScanFlights.delete(tabId);
    tabScanIds.delete(tabId);
    clearPendingAgentPageChange(tabId);
    clearTabNavigationGate(tabId);
    tabFrameDocuments.delete(tabId);
    retiredTabDocuments.delete(tabId);
    clearResourceCenterPendingTimer(tabId);
    resourceCenterPorts.delete(tabId);
    void chrome.storage.session.remove(cacheRestartKey(tabId));
    void removeCaptureSessionsForTab(tabId).catch(() => undefined);
    void clearMseDownloadFallbacksForTab(tabId).catch(() => undefined);
    void serializeTabStateMutation(tabId, () => clearTabState(tabId));
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void youtubeDirectoryPickers.windowRemoved(windowId).catch(() => undefined);
    void mergeDirectoryPickerSessionBroker.consumePopupWindow(windowId).catch(() => undefined);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, updatedTab) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      youtubeContextObservations.clear(tabId);
      // A directory selection is tied to one source document/navigation, not
      // merely the tab. Running downloads retain their own confirmed target.
      void youtubeDirectoryPickers.sourceRemoved(tabId).catch(() => undefined);
      mediaDockLastPushedRevision.delete(tabId);
      void mediaDockGrantBroker.clearTab(tabId).catch(() => undefined);
      const expectedReloadUrl = captureReloadTabs.get(tabId);
      const navigationUrl = changeInfo.url ?? updatedTab.url ?? '';
      const liveDocumentId = tabFrameDocuments.get(tabId)?.get(0);
      const previousRoute = tabRouteGenerations.get(tabId);
      // Bilibili sometimes emits status=loading during a History SPA edge. A
      // still-live document plus same-origin media-route change is stronger
      // evidence than status alone; a later Agent documentId change remains the
      // authority for a true document replacement.
      const sameDocumentSpaEvidence = Boolean(
        liveDocumentId &&
        previousRoute &&
        isBilibiliVideoPage(previousRoute.pageUrl) &&
        isBilibiliVideoPage(navigationUrl) &&
        sameHttpOrigin(previousRoute.pageUrl, navigationUrl) &&
        siteMediaRouteKey(previousRoute.pageUrl) !== siteMediaRouteKey(navigationUrl),
      );
      const documentNavigation = changeInfo.status === 'loading' && !sameDocumentSpaEvidence;
      const preserveCapture =
        documentNavigation && expectedReloadUrl != null && navigationUrl === expectedReloadUrl;
      const routeClaim = beginRouteGeneration(tabId, navigationUrl, 'tabs', {
        documentNavigation,
        urlChanged: changeInfo.url != null,
        ...(liveDocumentId ? { documentId: liveDocumentId } : {}),
      });
      const epoch = routeClaim.epoch;
      if (routeClaim.advanced) {
        clearMediaSettlementRetry(tabId);
        void clearMergeDirectoryPickersForSourceTab(tabId).catch(() => undefined);
        clearCaptureAnalysisTimer(tabId);
        if (!preserveCapture) clearCaptureTimeout(tabId);
        bumpCaptureObservationGeneration(tabId);
        if (!preserveCapture) void clearMseDownloadFallbacksForTab(tabId).catch(() => undefined);
        if (!preserveCapture) captureReloadTabs.delete(tabId);
      }
      if (documentNavigation && !routeClaim.pairedSpaTransition) markTabNavigating(tabId);
      const transition = serializeTabStateMutation(tabId, async () => {
        if (navigationEpoch(tabId) !== epoch) return;
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        if (!tab || navigationEpoch(tabId) !== epoch) return;
        const current = await getTabState(tabId);
        if (routeClaim.advanced && !preserveCapture) await removeCaptureSessionsForTab(tabId);
        const pageUrl = changeInfo.url ?? tab.url ?? navigationUrl;
        const sameMediaRoute =
          current != null && siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(pageUrl);
        const next =
          !routeClaim.advanced && sameMediaRoute
            ? rebaseSameMediaRouteState(current, pageUrl, tab.title ?? current.pageTitle)
            : createRouteTransitionState(tabId, pageUrl, tab.title ?? '当前页面', current, {
                preserveSourceCapture: preserveCapture,
              });
        await setTabState(next);
        return next;
      });
      void transition
        .then(async (state) => {
          if (!state || navigationEpoch(tabId) !== epoch) return;
          if (!routeClaim.advanced) {
            await rememberMainWorldAssets(
              tabId,
              state,
              state.assets.filter((asset) => asset.detectedBy.includes('manifest')),
              liveDocumentId,
            );
          }
          await updateBadge(tabId, state);
          await broadcast({ type: 'TAB_STATE_UPDATED', state });
          scheduleMediaDockSnapshot(tabId);
          void consumePendingAgentPageChange(tabId).catch(() => undefined);
          if (routeClaim.advanced && changeInfo.url && !documentNavigation) {
            await ensureMediaAgent(tabId, 0);
            await sendAgentRequest(tabId, 0, {
              type: 'AGENT_NAVIGATION',
              pageUrl: changeInfo.url,
            });
          }
        })
        .catch(() => undefined);
    }
    if (changeInfo.status === 'complete') {
      clearTabNavigationGate(tabId);
      captureReloadTabs.delete(tabId);
      void (async () => {
        if (await resumeCacheRestart(tabId)) return;
        const capture = await readCaptureSessionForTab(tabId);
        if (
          capture &&
          capture.state !== 'resolved' &&
          capture.state !== 'failed' &&
          capture.state !== 'cancelled'
        ) {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && canInject(tab.url)) await scanTab(tabId).catch(() => undefined);
          await activateCaptureAfterNavigation(tabId);
          return;
        }
        const tab = await chrome.tabs.get(tabId);
        if (isAutomaticMediaSite(tab.url)) {
          await ensureMediaAgent(tabId, 0);
          await scanTab(tabId).catch(() => undefined);
          if (resourceCenterPorts.has(tabId)) await setMediaDockSuppressed(tabId, true);
          return;
        }
        const settings: AppSettings = await getSettings();
        if (!settings.autoScanGrantedSites) return;
        if (!tab.url || !/^https?:\/\//.test(tab.url)) return;
        const origin = originPermissionPattern(tab.url);
        if (!origin) return;
        if (await chrome.permissions.contains({ origins: [origin] })) await scanTab(tabId);
      })().catch(() => undefined);
    }
  });
});
