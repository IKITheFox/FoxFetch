import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_SETTINGS } from '../shared/constants';
import { setLanguage } from '../shared/i18n';
import { useLanguage } from './useLanguage';
import { initialUiThemeMode } from '../shared/ui-theme';
import { siteMediaRouteKey } from '../modules/detector/site-media';
import { selectCachedNetworkTrackPair } from '../modules/resolver/cached-track-policy';
import type {
  ActiveTabInfo,
  ApiResponse,
  AppSettings,
  DownloadRecord,
  MediaAccessIntent,
  MediaAccessIntentAction,
  MediaAccessIntentResult,
  MediaAccessIntentStaged,
  MediaProductDownloadMode,
  MediaProductDownloadResult,
  PermissionGatedMediaAction,
  PermissionGatedMediaIntent,
  PermissionGatedMediaIntentResult,
  PermissionGatedMediaIntentStaged,
  PlaybackCommand,
  PlaybackCommandResult,
  ResolvedSourceDownload,
  SourceCaptureStarted,
  TabMediaState,
  UiRequest,
} from '../shared/types';
import {
  FULL_MEDIA_ACCESS_PERMISSIONS,
  createPermissionIntent,
  runMediaAccessIntent,
  runPermissionIntent,
} from '../modules/permissions';

interface TabStateUpdatedEvent {
  type: 'TAB_STATE_UPDATED';
  state: TabMediaState;
}

interface DownloadsUpdatedEvent {
  type: 'DOWNLOADS_UPDATED';
  downloads: DownloadRecord[];
}

interface SettingsUpdatedEvent {
  type: 'SETTINGS_UPDATED';
  settings: AppSettings;
}

type UiEvent = TabStateUpdatedEvent | DownloadsUpdatedEvent | SettingsUpdatedEvent;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '操作未完成，请稍后重试';
}

export function isTransientPageSyncError(error: unknown): boolean {
  return /(?:页面|媒体)(?:已变化|正在变化)|重新扫描后再解析/u.test(errorMessage(error));
}

export async function sendUiRequest<T>(request: UiRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as ApiResponse<T> | undefined;
  if (!response) throw new Error('扩展后台暂时没有响应');
  if (!response.ok) throw new Error(response.error || '操作失败');
  return response.data;
}

/**
 * Opens the resource center through the background so the user-activation-gated
 * side-panel call and Dock suppression happen as one ordered operation.
 */
export async function openResourceCenterForTab(tabId: number): Promise<void> {
  await sendUiRequest<null>({ type: 'OPEN_SIDE_PANEL', tabId });
}

/**
 * Durable permission gateway for merge actions. The background can finish the
 * staged action through permissions.onAdded even if an action popup closes.
 */
export function startMediaAccessIntent(
  action: MediaAccessIntentAction,
): Promise<MediaAccessIntentResult> {
  return runMediaAccessIntent(action, {
    stage: (intent: MediaAccessIntent) =>
      sendUiRequest<MediaAccessIntentStaged>({ type: 'STAGE_MEDIA_ACCESS_INTENT', intent }),
    commit: (intentId: string) =>
      sendUiRequest<MediaAccessIntentResult>({
        type: 'COMMIT_MEDIA_ACCESS_INTENT',
        intentId,
      }),
    cancel: (intentId: string) =>
      sendUiRequest<null>({ type: 'CANCEL_MEDIA_ACCESS_INTENT', intentId }).then(() => undefined),
  });
}

/** Durable permission gateway shared by direct downloads and source capture. */
export function startPermissionMediaIntent(
  action: PermissionGatedMediaAction,
  permissions: chrome.permissions.Permissions,
): Promise<PermissionGatedMediaIntentResult> {
  const intent = createPermissionIntent(action) as PermissionGatedMediaIntent;
  return runPermissionIntent(intent, permissions, {
    stage: (stagedIntent: PermissionGatedMediaIntent) =>
      sendUiRequest<PermissionGatedMediaIntentStaged>({
        type: 'STAGE_PERMISSION_MEDIA_INTENT',
        intent: stagedIntent,
      }),
    commit: (intentId: string) =>
      sendUiRequest<PermissionGatedMediaIntentResult>({
        type: 'COMMIT_PERMISSION_MEDIA_INTENT',
        intentId,
      }),
    cancel: (intentId: string) =>
      sendUiRequest<null>({ type: 'CANCEL_PERMISSION_MEDIA_INTENT', intentId }).then(
        () => undefined,
      ),
  });
}

export function useAppSettings() {
  useLanguage();
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    themeMode: initialUiThemeMode(),
  }));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void sendUiRequest<AppSettings>({ type: 'GET_SETTINGS' })
      .then((value) => {
        if (!cancelled) {
          setLanguage(value.uiLanguage);
          setSettings(value);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const listener = (message: unknown) => {
      const event = message as Partial<UiEvent>;
      if (event.type === 'SETTINGS_UPDATED' && 'settings' in event && event.settings) {
        setLanguage(event.settings.uiLanguage);
        setSettings(event.settings);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>, base?: AppSettings) => {
    setSaving(true);
    setError(undefined);
    try {
      const value = await sendUiRequest<AppSettings>({
        type: 'SAVE_SETTINGS',
        patch,
        ...(base ? { base } : {}),
      });
      setLanguage(value.uiLanguage);
      setSettings(value);
      return value;
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      throw reason;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, setSettings, loading, saving, error, setError, saveSettings };
}

export interface UseTabMediaOptions {
  scanOnMount?: boolean;
  requestHostPermissionOnManualScan?: boolean;
}

/** Ignore cosmetic/tracking-query URL churn while retaining real media routes. */
export function sameTabMediaViewContext(
  left: ActiveTabInfo | undefined,
  right: ActiveTabInfo | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.tabId === right.tabId &&
    siteMediaRouteKey(left.url) === siteMediaRouteKey(right.url),
  );
}

function hostPermissionPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return undefined;
  }
}

export function downloadPermissionOrigins(
  state: Pick<TabMediaState, 'assets'> | undefined,
  assetIds: readonly string[],
): string[] {
  const selectedIds = new Set(assetIds);
  return [
    ...new Set(
      (state?.assets ?? [])
        .filter((asset) => selectedIds.has(asset.id))
        .map((asset) => hostPermissionPattern(asset.url))
        .filter((origin): origin is string => origin != null),
    ),
  ];
}

/**
 * Start the optional CDN host-permission prompt while the download click still
 * owns a user activation. An async function runs synchronously until its first
 * await, so chrome.permissions.request is invoked before this function returns.
 */
export async function requireDownloadHostPermissions(
  state: Pick<TabMediaState, 'assets'> | undefined,
  assetIds: readonly string[],
): Promise<void> {
  const origins = downloadPermissionOrigins(state, assetIds);
  if (origins.length === 0) return;

  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    throw new Error('未获得所选媒体 CDN 的网站访问权限，无法开始下载');
  }
}

export function mediaProductAssetIds(
  mode: MediaProductDownloadMode,
  videoAssetId: string,
  audioAssetId?: string,
): string[] {
  if (mode === 'video-only') return [videoAssetId];
  if (mode === 'complete') {
    return audioAssetId ? [videoAssetId, audioAssetId] : [videoAssetId];
  }
  if (!audioAssetId) throw new Error('尚未识别到可下载的独立音轨');
  return [audioAssetId];
}

export function useTabMedia({
  scanOnMount = true,
  requestHostPermissionOnManualScan = false,
}: UseTabMediaOptions = {}) {
  const [activeTab, setActiveTab] = useState<ActiveTabInfo>();
  const [state, setState] = useState<TabMediaState>();
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  const activeTabRef = useRef<ActiveTabInfo | undefined>(undefined);
  const requestGenerationRef = useRef(0);

  const scanTab = useCallback(
    async (tabId: number, showController: boolean | undefined, generation: number) => {
      if (generation !== requestGenerationRef.current) return undefined;
      setScanning(true);
      setError(undefined);
      try {
        const next = await sendUiRequest<TabMediaState>({
          type: 'SCAN_TAB',
          tabId,
          ...(showController == null ? {} : { showController }),
        });
        if (generation === requestGenerationRef.current && activeTabRef.current?.tabId === tabId) {
          setState(next);
          return next;
        }
        return undefined;
      } catch (reason) {
        if (generation === requestGenerationRef.current) {
          setError(isTransientPageSyncError(reason) ? undefined : errorMessage(reason));
        }
        if (isTransientPageSyncError(reason)) return undefined;
        throw reason;
      } finally {
        if (generation === requestGenerationRef.current) setScanning(false);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setScanning(false);
    setError(undefined);
    try {
      const tab = await sendUiRequest<ActiveTabInfo>({ type: 'GET_ACTIVE_TAB' });
      if (generation !== requestGenerationRef.current) return;
      const previousTab = activeTabRef.current;
      const preserveCommittedState = sameTabMediaViewContext(previousTab, tab);
      activeTabRef.current = tab;
      setActiveTab(tab);
      if (!preserveCommittedState && previousTab) setState(undefined);
      let current: TabMediaState | undefined;
      try {
        current = await sendUiRequest<TabMediaState>({ type: 'GET_TAB_STATE', tabId: tab.tabId });
        if (generation !== requestGenerationRef.current) return;
        if (siteMediaRouteKey(current.pageUrl) === siteMediaRouteKey(tab.url)) setState(current);
        else current = undefined;
      } catch {
        current = undefined;
      }
      if (scanOnMount && (!current || current.status === 'idle')) {
        await scanTab(tab.tabId, undefined, generation);
      }
    } catch (reason) {
      if (generation === requestGenerationRef.current) setError(errorMessage(reason));
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [scanOnMount, scanTab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer != null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 0);
    };
    const handleTabActivated = () => {
      requestGenerationRef.current += 1;
      setScanning(false);
      scheduleRefresh();
    };
    const handleWindowFocus = (windowId: number) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) handleTabActivated();
    };
    const handleTabUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
      tabId,
      changeInfo,
      tab,
    ) => {
      if (tabId !== activeTabRef.current?.tabId) return;
      if (changeInfo.url) {
        requestGenerationRef.current += 1;
        const previousTab = activeTabRef.current;
        const nextTab: ActiveTabInfo = {
          tabId,
          title: tab.title ?? previousTab.title,
          url: changeInfo.url,
        };
        activeTabRef.current = nextTab;
        setActiveTab(nextTab);
        if (!sameTabMediaViewContext(previousTab, nextTab)) setState(undefined);
        setScanning(false);
        setError(undefined);
        scheduleRefresh();
      } else if (changeInfo.title) {
        const current = activeTabRef.current;
        const nextTab = { ...current, title: changeInfo.title };
        activeTabRef.current = nextTab;
        setActiveTab(nextTab);
      }
    };
    chrome.tabs.onActivated.addListener(handleTabActivated);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    chrome.windows.onFocusChanged.addListener(handleWindowFocus);
    return () => {
      if (refreshTimer != null) clearTimeout(refreshTimer);
      chrome.tabs.onActivated.removeListener(handleTabActivated);
      chrome.tabs.onUpdated.removeListener(handleTabUpdated);
      chrome.windows.onFocusChanged.removeListener(handleWindowFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const listener = (message: unknown) => {
      const event = message as Partial<UiEvent>;
      if (event.type !== 'TAB_STATE_UPDATED' || !('state' in event) || !event.state) return;
      const currentTab = activeTabRef.current;
      if (
        event.state.tabId === currentTab?.tabId &&
        siteMediaRouteKey(event.state.pageUrl) === siteMediaRouteKey(currentTab.url)
      ) {
        const nextTab: ActiveTabInfo = {
          tabId: event.state.tabId,
          url: event.state.pageUrl,
          title: event.state.pageTitle,
        };
        activeTabRef.current = nextTab;
        setActiveTab(nextTab);
        setState(event.state);
        if (event.state.status === 'scanning' || event.state.status === 'ready') {
          setError(undefined);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const download = useCallback(
    async (assetIds: string[]) => {
      if (assetIds.length === 0) return [];
      setError(undefined);
      try {
        const tabId = activeTabRef.current?.tabId;
        if (tabId == null || !state || state.tabId !== tabId) {
          throw new Error('正在读取当前标签页，请稍后再试');
        }
        const selectedIds = new Set(assetIds);
        const selectedAssets = state.assets.filter((asset) => selectedIds.has(asset.id));
        if (
          selectedIds.size !== assetIds.length ||
          selectedAssets.length !== selectedIds.size ||
          selectedAssets.some((asset) => !asset.downloadable)
        ) {
          throw new Error('当前媒体已变化或没有可下载资源，列表会自动更新');
        }
        const expectedMediaEpoch = state.mediaEpoch ?? 0;
        const action: PermissionGatedMediaAction = {
          kind: 'download-assets',
          tabId,
          assetIds,
          expectedPageUrl: state.pageUrl,
          expectedMediaEpoch,
          ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
        };
        const origins = downloadPermissionOrigins(state, assetIds);
        const records =
          origins.length > 0
            ? await startPermissionMediaIntent(action, { origins }).then((result) => {
                if (result.kind !== 'download-assets') throw new Error('下载待办响应类型不匹配');
                return result.downloads;
              })
            : await sendUiRequest<DownloadRecord[]>({
                type: 'DOWNLOAD_ASSETS',
                assetIds,
                tabId,
                expectedPageUrl: state.pageUrl,
                expectedMediaEpoch,
                ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
              });
        const failures = records.filter((record) => record.state === 'interrupted');
        if (failures.length > 0) {
          const detail = failures[0]?.error;
          const message = `${failures.length}/${records.length} 个下载未能启动${detail ? `：${detail}` : ''}`;
          setError(message);
          if (failures.length === records.length) throw new Error(message);
        }
        return records;
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [state],
  );

  const downloadMediaProduct = useCallback(
    async (
      productId: string,
      mode: MediaProductDownloadMode,
      videoAssetId: string,
      audioAssetId?: string,
      qualityId?: string,
      videoTrackId?: string,
    ): Promise<MediaProductDownloadResult> => {
      setError(undefined);
      try {
        const tabId = activeTabRef.current?.tabId;
        if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
        if (!state || state.tabId !== tabId) {
          throw new Error('当前媒体正在自动更新，请稍后再试');
        }
        const assetIds = mediaProductAssetIds(mode, videoAssetId, audioAssetId);
        const result: MediaProductDownloadResult =
          mode === 'complete' && audioAssetId
            ? await startMediaAccessIntent({
                kind: 'media-product-merge',
                tabId,
                productId,
                videoAssetId,
                audioAssetId,
                ...(videoTrackId ? { videoTrackId } : {}),
                ...(qualityId ? { qualityId } : {}),
                expectedPageUrl: state.pageUrl,
                expectedMediaEpoch: state.mediaEpoch ?? 0,
                ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
              })
            : await (async () => {
                const action: PermissionGatedMediaAction = {
                  kind: 'download-media-product',
                  tabId,
                  productId,
                  mode,
                  videoAssetId,
                  ...(audioAssetId ? { audioAssetId } : {}),
                  ...(videoTrackId ? { videoTrackId } : {}),
                  ...(qualityId ? { qualityId } : {}),
                  expectedPageUrl: state.pageUrl,
                  expectedMediaEpoch: state.mediaEpoch ?? 0,
                  ...(state?.activeMedia ? { expectedMedia: state.activeMedia } : {}),
                };
                const origins = downloadPermissionOrigins(state, assetIds);
                if (origins.length > 0) {
                  const permissionResult = await startPermissionMediaIntent(action, { origins });
                  if (permissionResult.kind !== 'download-media-product') {
                    throw new Error('成品下载待办响应类型不匹配');
                  }
                  return permissionResult.result;
                }
                return sendUiRequest<MediaProductDownloadResult>({
                  type: 'DOWNLOAD_MEDIA_PRODUCT',
                  tabId,
                  productId,
                  mode,
                  videoAssetId,
                  ...(audioAssetId ? { audioAssetId } : {}),
                  ...(videoTrackId ? { videoTrackId } : {}),
                  ...(qualityId ? { qualityId } : {}),
                  expectedPageUrl: state.pageUrl,
                  expectedMediaEpoch: state.mediaEpoch ?? 0,
                  ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
                });
              })();
        if (result.mode === 'download') {
          const failures = result.downloads.filter((record) => record.state === 'interrupted');
          if (failures.length > 0) {
            const detail = failures[0]?.error;
            const message = detail || '下载未能启动';
            setError(message);
            throw new Error(message);
          }
        }
        return result;
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [state],
  );

  const playback = useCallback(
    async (command: PlaybackCommand, frameId?: number, elementId?: string) => {
      setError(undefined);
      try {
        const currentTab = await sendUiRequest<ActiveTabInfo>({ type: 'GET_ACTIVE_TAB' });
        return await sendUiRequest<PlaybackCommandResult>({
          type: 'PLAYBACK_COMMAND',
          tabId: currentTab.tabId,
          ...(frameId == null ? {} : { frameId }),
          ...(elementId == null ? {} : { elementId }),
          command,
        });
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [],
  );

  const openSidePanel = useCallback(async () => {
    const tabId = activeTabRef.current?.tabId;
    if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
    // The background performs chrome.sidePanel.open as its first gated call,
    // then suppresses the in-page Dock while the resource center is present.
    await openResourceCenterForTab(tabId);
  }, []);

  const startSourceCapture = useCallback(
    async (blobAssetId: string) => {
      const tabId = activeTabRef.current?.tabId;
      if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
      const sourceAsset = state?.assets.find((asset) => asset.id === blobAssetId);
      if (!state || state.tabId !== tabId || !sourceAsset) {
        throw new Error('当前媒体已变化，列表正在自动更新，请稍后再试');
      }
      const failedHttpUrl =
        sourceAsset && /^https?:\/\//iu.test(sourceAsset.url) ? sourceAsset.url : undefined;
      const cachedPair =
        state && sourceAsset
          ? selectCachedNetworkTrackPair(
              state,
              sourceAsset.frameId,
              failedHttpUrl ? new Set([failedHttpUrl]) : undefined,
            )
          : undefined;
      setError(undefined);
      try {
        if (!cachedPair) {
          const result = await startPermissionMediaIntent(
            {
              kind: 'capture-source',
              tabId,
              blobAssetId,
              expectedPageUrl: state.pageUrl,
              expectedMediaEpoch: state.mediaEpoch ?? 0,
              ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
            },
            FULL_MEDIA_ACCESS_PERMISSIONS,
          );
          if (result.kind !== 'capture-source') {
            throw new Error('真实源捕获待办响应类型不匹配');
          }
          return result.result;
        }
        return await sendUiRequest<SourceCaptureStarted>({
          type: 'START_SOURCE_CAPTURE',
          tabId,
          blobAssetId,
          expectedPageUrl: state.pageUrl,
          expectedMediaEpoch: state.mediaEpoch ?? 0,
          ...(state.activeMedia ? { expectedMedia: state.activeMedia } : {}),
        });
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [state],
  );

  const reloadSourceCapture = useCallback(async (captureId: string) => {
    const tabId = activeTabRef.current?.tabId;
    if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
    setError(undefined);
    try {
      return await sendUiRequest<SourceCaptureStarted>({
        type: 'RELOAD_SOURCE_CAPTURE',
        tabId,
        captureId,
      });
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    }
  }, []);

  const downloadResolvedSource = useCallback(
    async (captureId: string) => {
      const tabId = activeTabRef.current?.tabId;
      if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
      setError(undefined);
      try {
        if (!state || state.tabId !== tabId) {
          throw new Error('当前媒体正在自动更新，请稍后再试');
        }
        const capture = state.sourceCapture;
        if (
          capture?.id === captureId &&
          capture.videoAssetId != null &&
          capture.audioAssetId != null
        ) {
          return await startMediaAccessIntent({
            kind: 'merge-assets',
            tabId,
            videoAssetId: capture.videoAssetId,
            audioAssetId: capture.audioAssetId,
            expectedPageUrl: state.pageUrl,
            expectedMediaEpoch: state.mediaEpoch ?? 0,
          });
        }
        return await sendUiRequest<ResolvedSourceDownload>({
          type: 'DOWNLOAD_RESOLVED_SOURCE',
          tabId,
          captureId,
        });
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [state],
  );

  const cancelSourceCapture = useCallback(async (captureId: string) => {
    const tabId = activeTabRef.current?.tabId;
    if (tabId == null) throw new Error('正在读取当前标签页，请稍后再试');
    setError(undefined);
    try {
      await sendUiRequest<null>({ type: 'CANCEL_SOURCE_CAPTURE', tabId, captureId });
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    }
  }, []);

  const scanCurrent = useCallback(
    async (showController?: boolean) => {
      const generation = ++requestGenerationRef.current;
      let currentTab = activeTabRef.current;
      try {
        if (!currentTab) {
          if (requestHostPermissionOnManualScan) {
            throw new Error('当前标签页仍在更新，请稍后再点一次扫描');
          }
          currentTab = await sendUiRequest<ActiveTabInfo>({ type: 'GET_ACTIVE_TAB' });
          if (generation !== requestGenerationRef.current) return undefined;
          activeTabRef.current = currentTab;
          setActiveTab(currentTab);
        }

        if (requestHostPermissionOnManualScan) {
          const origin = hostPermissionPattern(currentTab.url);
          if (!origin) throw new Error('此类浏览器页面不允许扩展扫描');
          // Invoke request synchronously from the click handler so Chrome preserves user activation.
          const permissionRequest = chrome.permissions.request({ origins: [origin] });
          if (!(await permissionRequest)) throw new Error('需要当前网站权限才能在侧栏中扫描');
          if (generation !== requestGenerationRef.current) return undefined;
        }

        return await scanTab(currentTab.tabId, showController, generation);
      } catch (reason) {
        if (generation === requestGenerationRef.current) setError(errorMessage(reason));
        return undefined;
      }
    },
    [requestHostPermissionOnManualScan, scanTab],
  );

  return {
    activeTab,
    state,
    loading,
    scanning,
    error,
    setError,
    scan: () => scanCurrent(),
    showController: () => scanCurrent(true),
    refresh,
    download,
    downloadMediaProduct,
    playback,
    openSidePanel,
    startSourceCapture,
    reloadSourceCapture,
    downloadResolvedSource,
    cancelSourceCapture,
  };
}

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void sendUiRequest<DownloadRecord[]>({ type: 'GET_DOWNLOADS' })
      .then((items) => {
        if (!cancelled) setDownloads(items);
      })
      .catch(() => undefined);
    const listener = (message: unknown) => {
      const event = message as Partial<UiEvent>;
      if (event.type === 'DOWNLOADS_UPDATED' && 'downloads' in event && event.downloads) {
        setDownloads(event.downloads);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  return downloads;
}
