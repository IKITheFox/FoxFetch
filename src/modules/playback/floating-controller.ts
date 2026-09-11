import { t as uiText } from '../../shared/i18n';
import { subscribeLanguage } from '../../shared/i18n';
import { messageText } from '../../shared/i18n/legacy-message';
import { updateLocalizedMarkup } from '../../shared/i18n/markup';
import { APP_NAME, APP_NAME_EN, DEFAULT_SETTINGS } from '../../shared/constants';
import { mountSettingsFrame } from '../settings-frame';
import { identifiedYouTubeVideo } from '../youtube/display-video';
import mediaTaskProgressStyles from '../../styles/media-task-progress.css?raw';
import scrollbarStyles from '../../styles/scrollbars.css?raw';
import mediaTaskLocationStyles from '../../styles/media-task-location.css?raw';
import mediaLocationDialogStyles from '../../styles/media-location-dialog.css?raw';
import { mediaTaskLocationMarkup } from '../../shared/media-task-location';
import { mediaTaskSummaryMarkup } from '../../shared/media-task-summary';
import {
  mediaLocationDialogMarkup,
  updateMediaLocationLayout,
  disposeMediaLocationLayout,
} from '../../shared/media-location-dialog';
import { mediaDownloadIcon as DOWNLOAD_ICON } from '../../shared/media-download-icon';
import { mediaTaskDetailsMarkup } from '../../shared/media-task-details';
import { createDockMediaCard } from '../../shared/dock-media-card';
import { createDockVariantControl } from '../../shared/dock-variant-control';
import { setYouTubeSelectionRefreshing } from '../youtube/selection-view';
import { mediaTaskProgressMarkup, updateMediaTaskProgress } from '../../shared/media-task-progress';
import {
  isYouTubePage,
  youTubeStatusText,
  validateYouTubeInspection,
  type YouTubeInspection,
} from '../youtube/inspection';
import { disposeYouTubeInspection, renderYouTubeInspection } from '../youtube/presentation';
import { closeYouTubeTaskPage } from '../youtube/task-page';
import { formatTaskBytes } from '../../shared/task-bytes';
import type {
  BoundMediaArtwork,
  DownloadActivityView,
  MediaElementInfo,
  MediaDockProductQualityView,
  MergeDockAction,
  MergeDockPathChoice,
  MergeDockView,
  PlaybackSettings,
  ThemeMode,
} from '../../shared/types';
import { formatDuration } from '../../shared/utils';
import { shouldAcceptMergeDockView } from '../../shared/merge-dock-state';
import { sanitizeMergeDiagnosticText } from '../../shared/merge-diagnostic-text';
import type {
  MediaProductCardDownloadMode,
  MediaProductCardModel,
  MediaProductDownloadOption,
} from '../media-products';
import {
  mediaArtworkTitleKey,
  mediaArtworkDisplayUrl,
  validateBoundMediaArtwork,
} from '../media-products';
import {
  formatMseCacheBytes,
  getMseCacheCaptureRuntime,
  type MseCacheCaptureRuntime,
  type MseCacheCaptureSnapshot,
} from '../resolver/mse-cache-capture';
import type { PlaybackManager } from './playback-manager';
import { navigateVideo } from './video-navigation';
import { NavigationPanelIntent } from './navigation-panel-intent';
import { DISCLOSURE_ICON, FloatingDisclosureAnimator } from './floating-disclosure';
import { installShadowStaticTextSelectionGuard } from '../ui/static-text-selection';
import { createAutoAdvanceGuard, type AutoAdvanceGuard } from './auto-advance-guard';
import {
  floatingMediaPlatform,
  groupFloatingDockQualities,
  type FloatingMediaPlatform,
} from './floating-product-ui';
import { siteMediaRouteKey } from '../detector/site-media';
import { mergeDiagnosticLines } from './merge-diagnostic-ui';

export const FLOATING_CONTROLLER_HOST_ID = 'foxfetch-floating-controller';
export const TRANSPORT_HOLD_DELAY_MS = 350;
export const TRANSPORT_TOOLTIP_DELAY_MS = 1_500;

function extensionAssetUrl(path: string): string {
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL(path)
    : `/${path}`;
}
export type FloatingMediaDockMode =
  'hidden' | 'launcher' | 'playback' | 'resources' | 'cache' | 'merge' | 'suppressed';

export type FloatingResourceStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Sanitized, URL-free state pushed into the page dock by the extension Agent. */
export interface FloatingResourceSnapshot {
  youtube?: YouTubeInspection;
  status: FloatingResourceStatus;
  products: readonly FloatingDockProductModel[];
  navigationEpoch?: number;
  mediaEpoch?: number;
  sequence?: number;
  /** @deprecated Accepted while a v0.7.0 service worker is still alive. */
  requestSequence?: number;
  pageIdentity?: string;
  revision?: string;
  message?: string;
  error?: string;
}

type DockDynamicRange = 'SDR' | 'HDR' | 'Dolby Vision' | 'unknown';
type DockFidelityState = 'checking' | 'ready' | 'blocked';

type FloatingDockProductQualityModel = MediaDockProductQualityView & {
  /** Optional v0.11.1 capability details; older service workers simply omit them. */
  dynamicRange?: DockDynamicRange;
  mergeBlockedReason?: string;
  fidelityState?: DockFidelityState;
  completeCheckRequired?: boolean;
  videoCodec?: string;
  audioCodec?: string;
};

type FloatingDockProductModel = MediaProductCardModel & {
  /** Stable metadata identity; never an authorization capability. */
  renderKey?: string;
  /** Latest one-shot product capability issued by the background. */
  grantToken?: string;
  /** URL-free, background-issued quality capabilities. */
  qualities?: readonly FloatingDockProductQualityModel[];
};

/** Selection intent is metadata only; never retain an expired authorization token. */
type DockQualityIntent = Pick<
  FloatingDockProductQualityModel,
  'id' | 'label' | 'detail' | 'dynamicRange' | 'videoCodec' | 'audioCodec'
>;

const UNAVAILABLE_DOCK_QUALITY = uiText('E1070');

type DockVariantKind = 'resolution' | 'quality';

interface DockVariantOption {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}

export interface FloatingResourceContext {
  navigationEpoch: number;
  mediaEpoch: number;
  pageIdentity: string;
}

const LAUNCHER_SIZE = 52;
const LAUNCHER_MARGIN = 10;
const DRAG_THRESHOLD_PX = 6;
const LAUNCHER_PREVIEW_DELAY_MS = 100;
const LAUNCHER_PREVIEW_CLOSE_DELAY_MS = 180;
const LAUNCHER_PREVIEW_WIDTH = 184;
const DOCK_VIEWPORT_MARGIN = 10;
const PRODUCT_MENU_GAP = 6;
const RESOURCE_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;

function isTransientResourceSnapshotError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:stale|页面.{0,8}(?:更新|变化|切换)|媒体.{0,8}(?:更新|变化|切换)|自动更新|正在扫描|稍后再试|已过期|已失效)/iu.test(
    message,
  );
}

interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface DockPosition {
  version?: 2;
  mode?: 'edge' | 'free';
  inset?: number;
  edge: 'left' | 'right';
  xRatio: number;
  yRatio: number;
  /** Legacy v1 fields are accepted during migration but are no longer written. */
  panelXRatio?: number;
  panelYRatio?: number;
}

interface ExplicitMediaSelection {
  elementId: string;
  lifecycleGeneration: number;
  routeKey: string;
}

interface DockPosterBinding {
  pageIdentity: string;
  mediaEpoch: number;
  titleKey: string;
  elementId?: string;
  lifecycleGeneration?: number;
  url: string;
}

export interface FloatingDockPositionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface FloatingControllerOptions {
  themeMode?: ThemeMode;
  playback?: Partial<PlaybackSettings>;
  cacheCapture?: MseCacheCaptureRuntime;
  initialMode?: FloatingMediaDockMode;
  positionStore?: FloatingDockPositionStore;
  onModeChange?: (mode: FloatingMediaDockMode) => void;
  onSelectedMediaChange?: (media: MediaElementInfo | undefined) => void;
  /** Called when the regular-download pane becomes visible or asks for a refresh. */
  onResourceViewRequest?: (force: boolean) => void | Promise<void>;
  /** The caller owns permission prompts, stale-media validation, and actual downloads. */
  onResourceProductDownload?: (
    productId: string,
    mode: MediaProductCardDownloadMode,
    qualityToken?: string,
  ) => void | Promise<void>;
  /** Execute a URL-free, tab-bound merge capability from the Dock. */
  onMergeDockAction?: (token: string, action: MergeDockAction) => void | Promise<void>;
  /** Choose the default hierarchy or request a top-level custom-directory picker. */
  onMergeDockPathModeChange?: (token: string, mode: MergeDockPathChoice) => void | Promise<void>;
}

const EMPTY_RESOURCE_SNAPSHOT: FloatingResourceSnapshot = {
  status: 'idle',
  products: [],
};

const PRODUCT_DOWNLOAD_META: Record<
  MediaProductCardDownloadMode,
  { label: string; detail: string; icon: string }
> = {
  complete: {
    get label() {
      return uiText('E0040');
    },
    get detail() {
      return uiText('E0041');
    },
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  video: {
    get label() {
      return uiText('E0042');
    },
    get detail() {
      return uiText('E0043');
    },
    icon: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="m17 10 4-2v8l-4-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m9 9 4 3-4 3V9Z" fill="currentColor"/></svg>',
  },
  audio: {
    get label() {
      return uiText('E0044');
    },
    get detail() {
      return uiText('E0045');
    },
    icon: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V6l10-2v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="16" cy="16" r="3" stroke="currentColor" stroke-width="1.8"/></svg>',
  },
};

const PRODUCT_DOWNLOAD_MODES = ['complete', 'video', 'audio'] as const;

const TRANSPORT_ICONS = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 5 8 12l11 7V5Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  forward:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M5 5l11 7-11 7V5Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 5 12 7-12 7V5Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  pip: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/><rect x="11" y="11" width="7" height="6" rx="1" stroke="currentColor" stroke-width="1.8"/></svg>',
};

function platformLogoSvg(platform: FloatingMediaPlatform): string {
  if (platform === 'bilibili') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="m8 5-2-2m10 2 2-2M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 12v2m8-2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
  if (platform === 'youtube') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M21 12c0 3.2-.4 5.1-.7 5.8-.2.6-.7 1.1-1.3 1.3-1.1.4-4.7.5-7 .5s-5.9-.1-7-.5a2.3 2.3 0 0 1-1.3-1.3C3.4 17.1 3 15.2 3 12s.4-5.1.7-5.8C3.9 5.6 4.4 5.1 5 5c1.1-.4 4.7-.5 7-.5s5.9.1 7 .5c.6.2 1.1.7 1.3 1.3.3.6.7 2.5.7 5.7Z" fill="currentColor"/><path d="m10 9 5 3-5 3V9Z" fill="var(--platform-mark, #fff)"/></svg>';
  }
  if (platform === 'douyin' || platform === 'tiktok') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M14 4c.3 2.3 1.7 3.7 4 4v3a8 8 0 0 1-4-1.2V16a5 5 0 1 1-5-5c.4 0 .7 0 1 .1v3.1a2 2 0 1 0 1 1.8V4h3Z" fill="currentColor"/></svg>';
  }
  if (platform === 'vimeo') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M4 8.5c2.6-3 5.4-3.2 6.1.2.4 1.8.8 4.7 1.6 6.3 1.1 2.3 4.4-2.4 5.6-4.7.5-1-.1-1.6-1.4-1.2l1-3c3.9-1.2 5.5.8 4.5 3.9-1.3 4-6.7 10.2-10.2 10.2-3.3 0-4.1-4.9-4.8-8.1-.4-1.8-.8-2.4-2.4-1.3V8.5Z" fill="currentColor"/></svg>';
  }
  if (platform === 'iqiyi') {
    return '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M8 9v6m4-6v6m4-6v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }
  if (platform === 'tencent') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M20 12 7 20c-1.4.8-3-.3-2.7-1.9L6 6.5c.3-1.8 2.3-2.6 3.6-1.4L20 12Z" fill="currentColor"/><path d="m8 7 7.5 5L7 17l1-10Z" fill="var(--platform-mark, #fff)"/></svg>';
  }
  if (platform === 'youku') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7.5 9 12l-5 4.5m16-9L15 12l5 4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="m10 9 5 3-5 3V9Z" fill="currentColor"/></svg>';
}

function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

function isProductDownloadMode(value: string | undefined): value is MediaProductCardDownloadMode {
  return value === 'complete' || value === 'video' || value === 'audio';
}

function dockQualityDynamicRange(
  quality: FloatingDockProductQualityModel | undefined,
): DockDynamicRange {
  if (quality?.dynamicRange) return quality.dynamicRange;
  const copy = `${quality?.label ?? ''} ${quality?.detail ?? ''}`;
  if (/dolby\s*vision|杜比视界|\bdovi\b/iu.test(copy)) return 'Dolby Vision';
  if (/\bhdr(?:10|10\+)?\b|hdr\s*真彩|高动态范围|\bhlg\b/iu.test(copy)) return 'HDR';
  return 'unknown';
}

function dockQualityVideoCodec(quality: FloatingDockProductQualityModel | undefined): string {
  const explicit = quality?.videoCodec?.trim();
  if (explicit) return explicit.toUpperCase();
  const match = `${quality?.label ?? ''} ${quality?.detail ?? ''}`.match(
    /\b(HEVC|AVC|AV1|VP9)\b/iu,
  );
  return match?.[1]?.toUpperCase() ?? uiText('E0021');
}

function isPathSelectionCancellation(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return name === 'AbortError' || /(?:cancel(?:led)?|aborted|用户取消|已取消)/iu.test(message);
}

function defaultCacheSnapshot(): MseCacheCaptureSnapshot {
  return {
    status: 'idle',
    capturedBytes: 0,
    progressRatio: null,
    storageKind: 'memory',
    trackCount: 0,
    sourceCount: 0,
    autoDownload: false,
    clearAfterDownload: false,
    downloading: false,
    minimized: true,
    filename: APP_NAME_EN,
    canMerge: false,
    isComplete: false,
    startedAtBeginning: false,
    completeGroupIds: [],
    groups: [],
    tracks: [],
    get message() {
      return uiText('E1071');
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isDockPosition(value: unknown): value is DockPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<DockPosition>;
  return (
    (position.edge === 'left' || position.edge === 'right') &&
    typeof position.xRatio === 'number' &&
    Number.isFinite(position.xRatio) &&
    typeof position.yRatio === 'number' &&
    Number.isFinite(position.yRatio) &&
    (position.panelXRatio == null ||
      (typeof position.panelXRatio === 'number' && Number.isFinite(position.panelXRatio))) &&
    (position.panelYRatio == null ||
      (typeof position.panelYRatio === 'number' && Number.isFinite(position.panelYRatio)))
  );
}

function browserPositionStore(): FloatingDockPositionStore | undefined {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  return {
    get: async (key) => (await chrome.storage.local.get(key)) as Record<string, unknown>,
    set: async (items) => chrome.storage.local.set(items),
  };
}

const DOCK_STYLES = `
  :host {
    all: initial;
    --surface: rgba(255, 255, 255, .98);
    --surface-elevated: #fff;
    --surface-subtle: #f4f4f8;
    --surface-hover: #eceafd;
    --text: #20212a;
    --brand-ink: #141414;
    --muted: #737784;
    --tertiary: #979aa6;
    --border: rgba(38, 37, 49, .12);
    --primary: #6d59f7;
    --primary-hover: #5b48e8;
    --primary-soft: #ece8ff;
    --success: #29b584;
    --warning: #e5a72f;
    --danger: #e45666;
    --shadow: 0 22px 70px rgba(19, 16, 38, .28), 0 2px 10px rgba(19, 16, 38, .12);
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    color-scheme: light;
    font-family: Inter, "SF Pro Display", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.45;
  }
  :host([hidden]),
  :host([data-mode="hidden"]),
  :host([data-mode="suppressed"]) { display: none !important; }
  :host([data-theme="dark"]) {
    color-scheme: dark;
    --surface: rgba(8, 9, 13, .985);
    --surface-elevated: #0d0f15;
    --surface-subtle: #15171f;
    --surface-hover: #1e2030;
    --text: #f5f5fa;
    --brand-ink: #fff;
    --muted: #a2a5b3;
    --tertiary: #747887;
    --border: rgba(255, 255, 255, .1);
    --primary: #8776ff;
    --primary-hover: #988aff;
    --primary-soft: #292440;
    --success: #47d1a1;
    --warning: #f0bc4e;
    --danger: #ff7484;
    --shadow: 0 24px 80px rgba(0, 0, 0, .7), 0 0 0 1px rgba(0, 0, 0, .5);
  }
  * { box-sizing: border-box; caret-color: transparent; }
  .panel { cursor: default; user-select: text; }
  button, summary { user-select: text; }
  input, textarea, [contenteditable="true"] { caret-color: auto; }
  input[type="text"], textarea, [contenteditable="true"] { cursor: text; user-select: text; }
  .head .identity { cursor: grab; user-select: none; }
  .resource-heading, .rate-heading { cursor: default; user-select: text; }
  .transport { cursor: default; user-select: none; }
  button, input { color: inherit; font: inherit; }
  button { cursor: pointer; }
  button:focus-visible, input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--primary) 75%, white);
    outline-offset: 2px;
  }
  .launcher {
    position: fixed;
    display: none;
    place-items: center;
    width: 52px;
    height: 52px;
    padding: 0;
    touch-action: none;
    user-select: none;
    pointer-events: auto;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 14px;
    animation: launcher-in 220ms cubic-bezier(.2, .9, .25, 1.2) both;
    will-change: transform, left, top;
  }
  :host([data-mode="launcher"]) .launcher { display: grid; }
  .launcher:focus-visible { outline: 0; }
  .launcher-tile {
    position: absolute;
    top: 0;
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr);
    align-items: center;
    width: 52px;
    height: 52px;
    overflow: hidden;
    color: var(--text);
    background: color-mix(in srgb, var(--surface-elevated) 92%, transparent);
    border-radius: 14px;
    box-shadow: 0 13px 34px rgba(24, 18, 61, .24), 0 3px 10px rgba(24, 18, 61, .12);
    backdrop-filter: blur(18px) saturate(1.15);
    transform-origin: right center;
    transition:
      width 330ms cubic-bezier(.2, 1.34, .36, 1),
      border-radius 260ms cubic-bezier(.2, 1, .36, 1),
      box-shadow 260ms ease,
      background-color 220ms ease;
    will-change: width;
  }
  :host([data-launcher-edge="left"]) .launcher-tile { left: 0; right: auto; transform-origin: left center; }
  :host([data-launcher-edge="right"]) .launcher-tile { left: auto; right: 0; transform-origin: right center; }
  :host([data-launcher-preview="true"]) .launcher-tile {
    width: var(--launcher-preview-width, 184px);
    border-radius: 15px;
    box-shadow: 0 18px 46px rgba(24, 18, 61, .3), 0 4px 13px rgba(24, 18, 61, .13);
  }
  .launcher:focus-visible .launcher-tile {
    box-shadow: 0 18px 46px rgba(24, 18, 61, .3), 0 0 0 3px color-mix(in srgb, var(--primary) 32%, transparent);
  }
  .launcher-mark {
    position: relative;
    display: grid;
    width: 52px;
    height: 52px;
    flex: 0 0 52px;
    place-items: center;
  }
  .launcher-logo { width: 40px; height: 40px; object-fit: contain; filter: drop-shadow(0 3px 5px rgba(49, 25, 12, .16)); }
  .launcher-mark, .launcher img, .mark img { pointer-events: none; user-select: none; -webkit-user-drag: none; }
  .launcher-logo-dark { display: none; }
  :host([data-theme="dark"]) .launcher-logo-light { display: none; }
  :host([data-theme="dark"]) .launcher-logo-dark { display: block; }
  .launcher-copy {
    display: grid;
    min-width: 118px;
    gap: 2px;
    padding: 0 14px 1px 2px;
    text-align: left;
    opacity: 0;
    transform: translateX(9px) scale(.97);
    transition:
      opacity 145ms ease,
      transform 300ms cubic-bezier(.2, 1.34, .36, 1);
  }
  :host([data-launcher-preview="true"]) .launcher-copy {
    opacity: 1;
    transform: translateX(0) scale(1);
    transition-delay: 65ms;
  }
  .launcher-brand { overflow: hidden; font-size: 14px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
  .launcher-brand-fox { color: #ff5a1f; }
  .launcher-brand-fetch { color: var(--brand-ink); }
  .launcher-state { display: flex; min-width: 0; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; line-height: 1.25; }
  .launcher-state-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .launcher-status {
    display: block;
    width: 7px;
    height: 7px;
    flex: 0 0 7px;
    background: var(--tertiary);
    border-radius: 2px;
  }
  .launcher-compact-status {
    position: absolute;
    right: 5px;
    bottom: 5px;
    display: grid;
    width: 11px;
    height: 11px;
    place-items: center;
    background: var(--surface-elevated);
    border-radius: 4px;
    box-shadow: 0 2px 6px rgba(18, 16, 31, .2);
    transition: opacity 120ms ease, transform 220ms cubic-bezier(.2, 1.34, .36, 1);
  }
  .launcher-compact-status .launcher-status { width: 6px; height: 6px; flex-basis: 6px; }
  :host([data-launcher-preview="true"]) .launcher-compact-status { opacity: 0; transform: scale(.55); }
  :host([data-launcher-status="ready"]) .launcher-status,
  :host([data-launcher-status="capturing"]) .launcher-status { background: var(--success); }
  :host([data-launcher-status="loading"]) .launcher-status,
  :host([data-launcher-status="paused"]) .launcher-status { background: var(--warning); }
  :host([data-launcher-status="error"]) .launcher-status { background: var(--danger); }
  :host([data-launcher-status="capturing"]) .launcher-status,
  :host([data-launcher-status="loading"]) .launcher-status { animation: launcher-status-breathe 1.35s ease-in-out infinite; }
  .launcher-progress {
    position: absolute;
    z-index: 2;
    right: 4px;
    bottom: 2px;
    left: 4px;
    height: 3px;
    overflow: hidden;
    pointer-events: none;
    background: color-mix(in srgb, var(--tertiary) 18%, transparent);
    border-radius: 2px;
    opacity: 0;
    transition: opacity 180ms ease;
  }
  .launcher-progress > i {
    display: block;
    width: var(--cache-progress, 0%);
    height: 100%;
    background: linear-gradient(90deg, #ff5a1f, #ff934d);
    border-radius: inherit;
    transition: width 480ms cubic-bezier(.22, 1, .36, 1);
  }
  :host([data-cache-status="starting"]) .launcher-progress,
  :host([data-cache-status="capturing"]) .launcher-progress,
  :host([data-cache-status="paused"]) .launcher-progress,
  :host([data-cache-status="ready"]) .launcher-progress,
  :host([data-cache-status="downloading"]) .launcher-progress { opacity: 1; }
  :host([data-dragging="true"]) .launcher { cursor: grabbing; transform: scale(1.04); animation: none; }
  :host([data-dragging="true"]) .launcher-tile { width: 52px; transition: none; }
  :host([data-dragging="true"]) .launcher-copy { opacity: 0; transition: none; }
  .panel {
    position: fixed;
    display: none;
    width: min(410px, calc(100vw - 20px));
    max-height: calc(100vh - 20px);
    max-height: calc(100dvh - 20px);
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(20px);
    transform-origin: var(--origin-x, 90%) var(--origin-y, 90%);
    animation: panel-open 270ms cubic-bezier(.16, 1, .3, 1) both;
    container: foxfetch-dock / inline-size;
  }
  :host([data-mode="playback"]) .panel,
  :host([data-mode="resources"]) .panel,
  :host([data-mode="cache"]) .panel,
  :host([data-mode="merge"]) .panel { display: flex; }
  .head { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; padding: 13px 14px 11px; border-bottom: 1px solid var(--border); cursor: grab; touch-action: none; }
  :host([data-panel-dragging="true"]) .head { cursor: grabbing; }
  .mark { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; }
  .mark img { width: 34px; height: 34px; object-fit: contain; }
  .identity { min-width: 0; flex: 1; }
  .brand { display: block; overflow: hidden; font-size: 13px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: block; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .head-actions { display: flex; gap: 5px; }
  .icon-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 9px; }
  .icon-button:hover { color: var(--text); background: var(--surface-subtle); border-color: var(--border); }
  .merge-back { display: none; }
  :host([data-mode="merge"]) .merge-back { display: grid; }
  .merge-back svg { width: 15px; height: 15px; }
  .panel:has([data-youtube-task-open="true"]) > .view-tabs,
  .panel:has([data-youtube-task-open="true"]) .head .status,
  .resources-view:has([data-youtube-task-open="true"]) > .resource-tabs,
  .regular-download-pane:has([data-youtube-task-open="true"]) > .resource-heading { display: none; }
  .view-tabs { position: relative; isolation: isolate; display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr; gap: 5px; margin: 10px 14px 0; padding: 4px; background: var(--surface-subtle); border-radius: 11px; }
  .view-tabs::before { position: absolute; z-index: 0; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 13px) / 2); background: var(--surface-elevated); border-radius: 8px; box-shadow: 0 2px 7px rgba(20, 18, 40, .1); content: ""; transform: translateX(0) scaleX(1); transform-origin: center; transition: transform 420ms cubic-bezier(.2, 1.55, .35, 1); will-change: transform; }
  :host([data-mode="resources"]) .view-tabs::before,
  :host([data-mode="cache"]) .view-tabs::before { transform: translateX(calc(100% + 5px)) scaleX(1); }
  :host([data-mode="merge"]) .view-tabs { display: none; }
  .view-tab { position: relative; z-index: 1; min-height: 31px; color: var(--muted); background: transparent; border: 0; border-radius: 8px; font-weight: 750; transition: color 180ms ease; }
  :host([data-mode="playback"]) .view-tab[data-action="open-playback"],
  :host([data-mode="resources"]) .view-tab[data-action="open-resources"],
  :host([data-mode="cache"]) .view-tab[data-action="open-resources"] { color: var(--text); }
  .view { display: none; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: auto; scrollbar-width: none; padding: 12px 14px 14px; }
  .view::-webkit-scrollbar { width: 0; height: 0; }
  :host([data-mode="playback"]) .playback-view,
  :host([data-mode="resources"]) .resources-view,
  :host([data-mode="cache"]) .resources-view,
  :host([data-mode="merge"]) .merge-view { display: block; flex: 1 1 auto; animation: view-in 180ms ease both; }
  .resource-tabs { position: relative; isolation: isolate; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 5px; margin-bottom: 11px; padding: 4px; background: var(--surface-subtle); border: 0; border-radius: 10px; }
  .resource-tabs::before { position: absolute; z-index: 0; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 13px) / 2); background: var(--surface-elevated); border-radius: 7px; box-shadow: 0 2px 6px rgba(20, 18, 40, .1); content: ""; transform: translateX(0) scaleX(1); transform-origin: center; transition: transform 420ms cubic-bezier(.2, 1.55, .35, 1); will-change: transform; }
  :host([data-mode="cache"]) .resource-tabs::before { transform: translateX(calc(100% + 5px)) scaleX(1); }
  .resource-tab { position: relative; z-index: 1; min-height: 30px; padding: 0 8px; color: var(--muted); background: transparent; border: 0; border-radius: 7px; font-size: 11px; font-weight: 750; transition: color 180ms ease; }
  :host([data-mode="resources"]) .resource-tab[data-action="open-regular-download"],
  :host([data-mode="cache"]) .resource-tab[data-action="open-cache"] { color: var(--text); }
  .resource-tab-status { display: inline-block; width: 6px; height: 6px; margin-left: 5px; background: var(--tertiary); border-radius: 50%; vertical-align: 1px; }
  :host([data-cache-status="capturing"]) .resource-tab-status { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 15%, transparent); }
  :host([data-cache-status="blocked_drm"]) .resource-tab-status,
  :host([data-cache-status="reload_required"]) .resource-tab-status,
  :host([data-cache-status="error"]) .resource-tab-status { background: var(--danger); }
  .resource-pane { display: none; }
  :host([data-mode="resources"]) .regular-download-pane,
  :host([data-mode="cache"]) .cache-download-pane { display: block; animation: subview-in 160ms ease both; }
  .resource-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
  .resource-heading strong { font-size: 12px; }
  .resource-live { display: inline-flex; align-items: center; gap: 5px; min-width: 7px; color: var(--warning); font-size: 10px; font-weight: 700; }
  .resource-live::before { width: 7px; height: 7px; flex: 0 0 7px; background: currentColor; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 13%, transparent); content: ""; }
  .resource-live[data-state="success"] { color: var(--success); }
  .resource-live[data-state="error"] { color: var(--danger); }
  .resource-refresh { min-height: 27px; padding: 0 8px; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 8px; font-size: 10px; }
  .resource-refresh:hover { color: var(--text); background: var(--surface-hover); }
  .resource-notice { margin: 0 0 9px; padding: 8px 9px; color: var(--muted); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; font-size: 10px; }
  .resource-notice[data-tone="error"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 32%, var(--border)); }
  .resource-state { display: grid; min-height: 154px; place-items: center; padding: 20px 14px; color: var(--muted); text-align: center; background: var(--surface-subtle); border: 1px dashed var(--border); border-radius: 13px; }
  .resource-state strong { display: block; margin-bottom: 5px; color: var(--text); font-size: 12px; }
  .resource-state span { display: block; max-width: 270px; font-size: 10px; }
  .resource-state[data-loading="true"]::before { width: 20px; height: 20px; margin: 0 auto 9px; border: 2px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: resource-spin .8s linear infinite; content: ""; }
  .product-list { display: grid; gap: 8px; }
  .dock-product { position: relative; display: grid; grid-template-columns: 88px minmax(0, 1fr) 42px; align-items: start; gap: 10px; padding: 9px; background: var(--surface-subtle); border: 1px solid transparent; border-radius: 12px; }
  .dock-product[data-menu-open="true"] { border-color: color-mix(in srgb, var(--primary) 48%, var(--border)); }
  .dock-product-preview { --platform-mark: #fff; position: relative; display: grid; width: 88px; min-height: 0; align-self: stretch; contain: size; place-items: center; overflow: hidden; color: #fff; background: linear-gradient(145deg, #6e5af2, #4936c6); border-radius: 10px; }
  .dock-product-preview[data-platform="bilibili"] { background: linear-gradient(145deg, #32c5f4, #00a1d6); }
  .dock-product-preview[data-platform="youtube"] { background: #ff0033; }
  .dock-product-preview[data-platform="douyin"], .dock-product-preview[data-platform="tiktok"] { background: linear-gradient(145deg, #222, #070707); }
  .dock-product-preview[data-platform="vimeo"] { background: #1ab7ea; }
  .dock-product-preview[data-platform="youku"] { background: linear-gradient(145deg, #ff325f, #1c9cff); }
  .dock-product-preview[data-platform="iqiyi"] { background: #00be06; }
  .dock-product-preview[data-platform="tencent"] { background: linear-gradient(145deg, #16cb7f, #178eff); }
  .dock-product-logo { display: grid; place-items: center; }
  .dock-product-logo > svg { width: 27px; height: 27px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .16)); }
  .dock-product-poster { position: absolute; z-index: 1; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .dock-product-platform, .dock-product-duration { position: absolute; z-index: 2; bottom: 3px; max-width: calc(100% - 36px); overflow: hidden; padding: 1px 4px; color: #fff; background: rgba(8, 9, 13, .76); border-radius: 5px; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; font-weight: 760; }
  .dock-product-platform { left: 4px; }
  .dock-product-duration { right: 4px; font-variant-numeric: tabular-nums; }
  .dock-product-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .dock-product-copy strong, .dock-product-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dock-product-copy strong { font-size: 12px; line-height: 1.35; }
  .dock-product-copy span { color: var(--tertiary); font-size: 10px; }
  .dock-product-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .dock-product-title-row > strong { min-width: 0; flex: 1; }
  .dock-product-fidelity-dot { display: block; width: 7px; height: 7px; flex: 0 0 7px; color: var(--warning); background: currentColor; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 13%, transparent); }
  .dock-product-fidelity-dot[data-state="ready"] { color: var(--success); }
  .dock-product-fidelity-dot[data-state="blocked"] { color: var(--danger); }
  .dock-product-fidelity-dot[data-state="checking"]:not([data-verification="pending"]) { animation: merge-status-pulse 1.25s ease-out infinite; }
  .dock-product-fidelity-error { display: block; grid-column: 1 / -1; margin-top: 2px; color: var(--danger) !important; font-size: 9px !important; line-height: 1.35; white-space: normal !important; }
  .dock-product-fidelity-error[hidden] { display: none; }
  .dock-product-variants { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, .85fr); gap: 5px; margin-top: 4px; }
  .dock-product-variant { display: block; min-width: 0; }
  .dock-product-variant[hidden] { display: none; }
  .dock-variant-select { position: relative; min-width: 0; }
  .dock-variant-trigger { display: grid; width: 100%; min-width: 0; height: 25px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px; padding: 0 6px; overflow: hidden; color: var(--text); text-align: left; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 7px; font-size: 9px; font-weight: 680; }
  .dock-variant-trigger:not(:disabled):hover, .dock-variant-trigger:not(:disabled):focus-visible, .dock-variant-trigger[aria-expanded="true"] { border-color: color-mix(in srgb, var(--primary) 66%, var(--border)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 16%, transparent); }
  .dock-variant-trigger:disabled { cursor: default; opacity: .82; }
  .dock-variant-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dock-variant-chevron { width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; opacity: .72; transform: translateY(-1px) rotate(45deg); transition: transform 170ms ease; }
  .dock-variant-trigger[aria-expanded="true"] .dock-variant-chevron { transform: translateY(2px) rotate(225deg); }
  .dock-variant-list { position: absolute; z-index: 8; top: calc(100% + 4px); left: 0; display: grid; width: max(100%, max-content); min-width: 100%; max-width: min(190px, calc(100vw - 40px)); max-height: 148px; gap: 2px; padding: 4px; overflow-y: auto; color: var(--text); background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 9px; box-shadow: 0 14px 34px rgba(0, 0, 0, .3); }
  .dock-variant-select[data-placement="top"] .dock-variant-list { top: auto; bottom: calc(100% + 4px); }
  .dock-variant-list[hidden] { display: none; }
  .dock-variant-option { display: flex; min-width: 100%; min-height: 28px; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 7px; color: var(--muted); text-align: left; background: transparent; border: 0; border-radius: 6px; font-size: 9px; white-space: nowrap; }
  .dock-variant-option:hover, .dock-variant-option:focus-visible, .dock-variant-option[aria-selected="true"] { color: var(--text); background: var(--primary-soft); }
  .dock-variant-option[aria-selected="true"]::after { color: var(--primary); font-weight: 800; content: "✓"; }
  .dock-product-copy .dock-product-meta { color: var(--muted); }
  .dock-product-actions { position: relative; align-self: stretch; contain: size; }
  .dock-product-trigger { position: absolute; top: 50%; right: 0; transform: translateY(-50%); display: grid; width: 40px; height: 34px; place-items: center; padding: 0; color: var(--muted); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; }
  .dock-product-trigger:hover, .dock-product-trigger[aria-expanded="true"] { color: var(--primary); background: var(--primary-soft); }
  .dock-product-trigger svg { width: 18px; height: 18px; }
  .dock-product-menu { position: fixed; z-index: 2147483647; inset: auto; display: grid; width: min(300px, calc(100vw - 20px)); max-height: min(320px, calc(100dvh - 20px)); gap: 3px; margin: 0; overflow-x: hidden; overflow-y: auto; pointer-events: auto; color: var(--text); background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
  .dock-product-menu[hidden] { display: none; }
  .dock-product-menu-title { padding: 2px 6px 4px; color: var(--tertiary); font-size: 9px; font-weight: 720; letter-spacing: .06em; }
  .dock-product-option { display: grid; width: 100%; grid-template-columns: 31px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 43px; padding: 5px 7px; color: var(--text); text-align: left; background: transparent; border: 0; border-radius: 8px; }
  .dock-product-option:not(:disabled):hover, .dock-product-option:not(:disabled):focus-visible { background: var(--surface-hover); }
  .dock-product-option[hidden] { display: none; }
  .dock-product-option:disabled { cursor: default; opacity: .56; }
  .dock-product-option[data-fidelity-state="checking"] { opacity: .7; }
  .dock-product-option-icon { display: grid; width: 31px; height: 31px; place-items: center; color: var(--muted); background: var(--surface-elevated); border-radius: 8px; }
  .dock-product-option-icon svg { width: 17px; height: 17px; }
  .dock-product-option-copy { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
  .dock-product-option-copy strong { font-size: 10px; }
  .dock-product-option-copy small { overflow: hidden; color: var(--tertiary); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .dock-product-recommended { padding: 2px 5px; color: var(--primary); background: var(--primary-soft); border-radius: 6px; font-size: 8px; font-weight: 760; }
  .dock-product-busy { opacity: .62; pointer-events: none; }
  .target-trigger, .control, .cache-button {
    min-height: 36px;
    background: var(--surface-subtle);
    border: 1px solid transparent;
    border-radius: 10px;
  }
  .target-picker { position: relative; margin-bottom: 10px; }
  .target-trigger { display: flex; align-items: center; width: 100%; padding: 0 10px; text-align: left; }
  .target-trigger-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .target-chevron { display: grid; place-items: center; margin-left: 8px; color: var(--muted); flex: 0 0 18px; }
  .disclosure-icon { display: block; width: 18px; height: 18px; flex: 0 0 18px; pointer-events: none; }
  .disclosure-icon path { d: path("M5 12 L12 18 L19 12"); transition: d 280ms cubic-bezier(.22, 1.18, .36, 1); }
  .target-trigger[aria-expanded="true"] .disclosure-icon path,
  details[open]:not([data-expanded="false"]) > summary .disclosure-icon path { d: path("M5 12 L12 6 L19 12"); }
  .target-list { position: absolute; z-index: 3; top: calc(100% + 5px); left: 0; width: 100%; max-height: 176px; overflow: auto; padding: 5px; background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 11px; box-shadow: 0 14px 36px rgba(0, 0, 0, .28); }
  .target-picker[data-placement="top"] .target-list { top: auto; bottom: calc(100% + 5px); }
  .target-list[hidden] { display: none; }
  .target-option { display: flex; align-items: center; width: 100%; min-height: 34px; padding: 6px 8px; overflow: hidden; color: var(--muted); text-align: left; background: transparent; border: 0; border-radius: 8px; }
  .target-option:hover, .target-option[aria-selected="true"] { color: var(--text); background: var(--primary-soft); }
  .target-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .transport { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: center; gap: 7px; padding: 7px; background: var(--surface-subtle); border-radius: 13px; }
  .transport .control { display: grid; place-items: center; height: 42px; background: transparent; touch-action: none; transform-origin: center; transition: transform 220ms cubic-bezier(.2, 1.7, .4, 1), background 160ms ease; }
  .transport .control:active:not(:disabled) { transform: scale(.92); transition-duration: 85ms; }
  .transport-icon { display: grid; place-items: center; width: 24px; height: 24px; position: relative; }
  .transport-icon > svg { display: block; grid-area: 1 / 1; transition: opacity 240ms ease, transform 260ms cubic-bezier(.22, 1.35, .36, 1); transform-origin: center; }
  [data-role="play-icon"] > .pause-shape { opacity: 0; transform: scale(.7); }
  [data-role="play-icon"][data-state="playing"] > .pause-shape { opacity: 1; transform: scale(1); }
  [data-role="play-icon"][data-state="playing"] > .play-shape { opacity: 0; transform: scale(.7); }
  .transport .control.primary { background: var(--primary); border-color: transparent; }
  .transport svg { width: 22px; height: 22px; pointer-events: none; }
  .transport .control[data-holding="true"] { color: var(--primary); background: var(--primary-soft); }
  .transport-tooltip { position: fixed; z-index: 2147483647; max-width: min(270px, calc(100vw - 20px)); margin: 0; padding: 9px 12px; pointer-events: none; color: var(--text); background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 11px; line-height: 1.7; white-space: pre-line; }
  .transport-tooltip[hidden] { display: none; }
  .playback-error { margin: 7px 0 0; color: var(--danger); font-size: 11px; }
  .playback-error[hidden] { display: none; }
  .control { min-width: 0; padding: 0 7px; font-weight: 720; }
  .control:hover, .cache-button:hover { background: var(--surface-hover); }
  .control.primary, .cache-button.primary { color: white; background: var(--primary); border-color: var(--primary); }
  .control.primary:hover, .cache-button.primary:hover { background: var(--primary-hover); }
  .rate-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 13px; }
  .rate-label { color: var(--muted); font-size: 11px; font-weight: 700; }
  .current-rate { color: var(--primary); font-size: 16px; font-variant-numeric: tabular-nums; }
  .rate-slider { display: block; width: 100%; min-width: 0; height: 30px; margin: 7px 0 0; padding: 0; appearance: none; background: transparent; cursor: pointer; touch-action: none; }
  .rate-slider::-webkit-slider-runnable-track { height: 5px; background: linear-gradient(90deg, color-mix(in srgb, var(--tertiary) 23%, var(--surface-subtle)), var(--primary)); border-radius: 99px; }
  .rate-slider::-webkit-slider-thumb { width: 15px; height: 15px; margin-top: -5px; appearance: none; background: var(--primary); border: 2px solid var(--surface-elevated); border-radius: 50%; box-shadow: 0 1px 5px rgba(0,0,0,.2); }
  .rate-slider:disabled { cursor: default; opacity: .45; }
  .playback-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; }
  .cache-message { min-height: 38px; margin: 0 0 11px; color: var(--muted); font-size: 12px; }
  :host([data-cache-status="blocked_drm"]) .cache-message,
  :host([data-cache-status="reload_required"]) .cache-message,
  :host([data-cache-status="error"]) .cache-message { color: var(--danger); }
  .metric-row { display: flex; align-items: end; justify-content: space-between; gap: 10px; }
  .metric-row strong { font-size: 20px; font-variant-numeric: tabular-nums; }
  .metric-row span { color: var(--tertiary); font-size: 11px; text-align: right; }
  .meter { height: 6px; margin: 8px 0 12px; overflow: hidden; background: var(--surface-subtle); border-radius: 99px; }
  .meter span { display: block; width: 0; height: 100%; background: linear-gradient(90deg, var(--primary), #a696ff); border-radius: inherit; transition: width 180ms ease; }
  .auto-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 11px; color: var(--muted); font-size: 12px; }
  .auto-row input[type="checkbox"] { position: relative; width: 34px; height: 20px; flex: 0 0 34px; appearance: none; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; transition: background 160ms ease, border-color 160ms ease; }
  .auto-row input[type="checkbox"]::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: var(--tertiary); border-radius: 50%; transition: transform 160ms ease, background 160ms ease; }
  .auto-row input[type="checkbox"]:checked { background: var(--primary); border-color: var(--primary); }
  .auto-row input[type="checkbox"]:checked::after { background: white; transform: translateX(14px); }
  .filename-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 9px; margin-bottom: 10px; color: var(--muted); font-size: 12px; }
  .filename-row input { width: 100%; min-width: 0; min-height: 34px; padding: 0 9px; color: var(--text); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 9px; }
  .cache-actions { display: grid; grid-template-columns: 1fr auto; gap: 7px; }
  .cache-actions .cache-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  .cache-actions .cache-button svg { width: 16px; height: 16px; }
  .cache-button { padding: 0 11px; font-weight: 720; }
  .cache-secondary { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
  .cache-options { margin-top: 9px; color: var(--muted); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 10px; }
  .cache-options > summary { display: flex; min-height: 36px; align-items: center; justify-content: space-between; padding: 8px 10px; cursor: pointer; font-size: 11px; font-weight: 720; list-style: none; }
  .cache-options > summary::-webkit-details-marker { display: none; }
  .cache-options-body { padding: 1px 10px 9px; border-top: 1px solid var(--border); }
  .disclosure-body { display: flow-root; min-height: 0; }
  .cache-options-body .auto-row:first-child { margin-top: 9px; }
  .cache-options-body .auto-row:last-of-type { margin-bottom: 0; }
  .cache-button:disabled, .control:disabled { cursor: default; opacity: .42; }
  :host([data-mode="merge"]) .head .status { display: none; }
  .merge-view { padding-top: 14px; }
  .resources-view:has([data-youtube-task-open="true"]) { padding-top: 14px; }
  ${mediaTaskProgressStyles}
  .merge-progress-heading .merge-state-dot[data-state="loading"] { animation: merge-status-pulse 1.25s ease-out infinite; }
  :host([data-merge-stage="complete"]) .merge-state-label { color: var(--success) !important; }
  :host([data-merge-stage="failed"]) .merge-state-label { color: var(--danger) !important; }
  .merge-status { margin: 9px 1px 0; color: var(--danger); font-size: 11px; overflow-wrap: anywhere; }
  .merge-status[hidden] { display: none; }
  :host([data-merge-stage="merge"]) .merge-meter span::after,
  :host([data-merge-stage="complete"]) .merge-meter span::after { opacity: 1; }
  :host([data-merge-stage="merge"]) .merge-progress-heading [data-role="merge-progress-label"],
  :host([data-merge-stage="complete"]) .merge-progress-heading [data-role="merge-progress-label"] { color: #f2a347; }
  ${mediaTaskLocationStyles}
  ${mediaLocationDialogStyles}
  .tracks { margin-top: 9px; color: var(--muted); background: color-mix(in srgb, var(--surface-elevated) 55%, transparent); border: 1px solid var(--border); border-radius: 9px; }
  .tracks summary { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; cursor: pointer; font-size: 11px; font-weight: 720; list-style: none; }
  .tracks summary::-webkit-details-marker { display: none; }
  .track-list { border-top: 1px solid var(--border); }
  .track { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 7px 10px; font-size: 10px; }
  .track + .track { border-top: 1px solid var(--border); }
  .track-main { min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
  .track-meta { color: var(--tertiary); font-variant-numeric: tabular-nums; }
  .completion-badge { display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; padding: 2px 7px; color: var(--muted); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 99px; font-size: 10px; font-weight: 720; }
  .completion-badge::before { content: ""; width: 7px; height: 7px; background: var(--tertiary); border-radius: 50%; }
  .completion-badge[data-complete="true"] { color: var(--success); background: color-mix(in srgb, var(--success) 11%, var(--surface-subtle)); border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
  .completion-badge[data-complete="true"]::before { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 16%, transparent); }
  .confirm-layer { position: absolute; z-index: 10; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, .54); backdrop-filter: blur(6px); border-radius: inherit; }
  .confirm-layer[hidden] { display: none; }
  .confirm-dialog { width: min(330px, 100%); padding: 17px; background: var(--surface-elevated); border: 1px solid var(--border); border-radius: 15px; box-shadow: var(--shadow); }
  .confirm-dialog strong { display: block; margin-bottom: 6px; font-size: 15px; }
  .confirm-dialog p { margin: 0; color: var(--muted); font-size: 12px; }
  .confirm-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 15px; }
  .privacy { display: block; margin-top: 10px; color: var(--tertiary); font-size: 10px; text-align: center; }
  .resource-tabs, .target-trigger, .dock-variant-trigger, .merge-summary, .merge-path, .cache-options { border-color: transparent; }
  .dock-product-trigger { align-self: center; }
  .merge-summary { background: var(--surface-subtle); }
  .view, .head, .resources-view, .playback-view, .merge-view, .resource-pane { min-width: 0; }
  @container foxfetch-dock (max-width: 380px) {
    .head { gap: 8px; padding-right: 10px; padding-left: 10px; }
    .view-tabs { margin-right: 10px; margin-left: 10px; }
    .view { padding-right: 10px; padding-left: 10px; scrollbar-gutter: auto; }
    .dock-product { grid-template-columns: 74px minmax(0, 1fr) 38px; gap: 7px; padding: 8px; }
    .dock-product-preview { width: 74px; }
    .dock-product-trigger { width: 36px; }
    .dock-product-variants { gap: 4px; }
    .transport { gap: 5px; }
    .control { padding-right: 5px; padding-left: 5px; font-size: 11px; }
    .merge-summary { grid-template-columns: minmax(0, 1fr) 78px; gap: 9px; }
    .merge-summary-preview { width: 78px; }
    .merge-actions { grid-template-columns: minmax(0, 1fr) minmax(96px, auto); }
  }
  @container foxfetch-dock (max-width: 340px) {
    .dock-product { grid-template-columns: 64px minmax(0, 1fr) 34px; gap: 6px; padding: 7px; }
    .dock-product-preview { width: 64px; border-radius: 8px; }
    .dock-product-trigger { width: 32px; height: 32px; }
    .dock-product-variants { grid-template-columns: minmax(0, 1fr); }
    .dock-product-variant[hidden] { display: none; }
    .metric-row { align-items: start; flex-direction: column; }
    .metric-row span { text-align: left; }
    .cache-actions, .cache-secondary { grid-template-columns: minmax(0, 1fr); }
    .merge-path-dialog { padding: 11px; }
  }
  @keyframes launcher-in { from { opacity: 0; transform: scale(.7) rotate(-8deg); } to { opacity: 1; transform: scale(1) rotate(0); } }
  @keyframes panel-open { from { opacity: 0; transform: scale(.78) translateY(8px); filter: blur(3px); } to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); } }
  @keyframes view-in { from { opacity: 0; transform: translateX(5px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes subview-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes resource-spin { to { transform: rotate(360deg); } }
  @keyframes merge-indeterminate { 0% { transform: translateX(-115%); } 55%, 100% { transform: translateX(300%); } }
  @keyframes merge-status-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 48%, transparent); } 70%, 100% { box-shadow: 0 0 0 7px transparent; } }
  @keyframes launcher-status-breathe { 0%, 100% { opacity: .62; transform: scale(.82); } 50% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) {
    .launcher, .launcher-tile, .launcher-copy, .launcher-compact-status, .launcher-status, .launcher-progress, .launcher-progress > i, .panel, .view, .merge-meter span, .merge-state-dot, .dock-product-fidelity-dot, .view-tabs::before, .resource-tabs::before, .view-tab, .resource-tab, .dock-variant-chevron, .disclosure-icon path, .transport .control, .transport-icon > svg { animation: none !important; transition: none !important; }
    .transport .control:active:not(:disabled) { transform: none; }
  }
`;

function setText(element: Element | null, value: string): void {
  if (element && element.textContent !== value) element.textContent = value;
}

export class FloatingPlaybackController {
  readonly host: HTMLElement;
  readonly shadowRoot: ShadowRoot;
  private settings: PlaybackSettings;
  private themeMode: ThemeMode;
  private selectedElementId: string | undefined;
  private explicitSelection: ExplicitMediaSelection | undefined;
  private elementSignature = '';
  private readonly colorScheme: MediaQueryList;
  private readonly view: Window;
  private readonly visualViewport: VisualViewport | null;
  private readonly positionStore: FloatingDockPositionStore | undefined;
  private readonly positionKey: string;
  private readonly onModeChange: ((mode: FloatingMediaDockMode) => void) | undefined;
  private readonly onSelectedMediaChange:
    ((media: MediaElementInfo | undefined) => void) | undefined;
  private readonly onResourceViewRequest: ((force: boolean) => void | Promise<void>) | undefined;
  private readonly onResourceProductDownload:
    | ((
        productId: string,
        mode: MediaProductCardDownloadMode,
        qualityToken?: string,
      ) => void | Promise<void>)
    | undefined;
  private readonly onMergeDockAction:
    ((token: string, action: MergeDockAction) => void | Promise<void>) | undefined;
  private readonly onMergeDockPathModeChange:
    ((token: string, mode: MergeDockPathChoice) => void | Promise<void>) | undefined;
  private mode: FloatingMediaDockMode = 'hidden';
  private settingsFrame: Awaited<ReturnType<typeof mountSettingsFrame>> | undefined;
  private settingsOpening: Promise<void> | undefined;
  private navigationPanelIntent: NavigationPanelIntent | undefined;
  private navigationPanelTimer: number | undefined;
  private navigationPanelSettledEpoch: number | undefined;
  private modeBeforeSuppression: FloatingMediaDockMode = 'launcher';
  private minimizedView: { mode: FloatingMediaDockMode; route: string; scroll: number } | undefined;
  private readonly disclosureAnimator: FloatingDisclosureAnimator;
  private readonly disposeStaticSelection: () => void;
  private readonly transportFeedback = new Map<HTMLButtonElement, Animation>();
  private mergeReturnPending = false;
  private mergeReturnSequence = 0;
  private mergeReturnConfirmationOpen = false;
  private userDismissed = false;
  private mediaElements: readonly MediaElementInfo[] = [];
  private launcherX = 0;
  private launcherY = 0;
  private launcherEdge: 'left' | 'right' = 'right';
  private positionAnchor: DockPosition = {
    version: 2,
    mode: 'edge',
    edge: 'right',
    inset: 18,
    xRatio: 1,
    yRatio: 1,
  };
  private positionMutation = 0;
  private dragPointerId: number | undefined;
  private dragTarget: 'launcher' | 'panel' | undefined;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;
  private panelDragOrigin: { left: number; top: number } | undefined;
  private panelDragPosition: { left: number; top: number } | undefined;
  private didDrag = false;
  private launcherPreviewTimer: number | undefined;
  private bufferTailEnabled = false;
  private bufferTailBinding = '';
  private bufferTailTimer: number | undefined;
  private preventAutoAdvanceEnabled = true;
  private autoAdvanceGuard: AutoAdvanceGuard | undefined;
  private autoAdvanceBindingRetired = false;
  private suspendedTransportGuard:
    | { guard: AutoAdvanceGuard; identity: string; reason?: 'cache-complete' | 'ended' | undefined }
    | undefined;
  private navigationPending = false;
  private rateDraft: number | undefined;
  private ratePointerId: number | undefined;
  private rateRequestSequence = 0;
  private rateTimer: number | undefined;
  private ratePending = false;
  private transportPointer:
    | {
        id: number;
        button: HTMLButtonElement;
        direction: 'forward' | 'backward';
        identity: string;
        holding: boolean;
      }
    | undefined;
  private transportTimer: number | undefined;
  private suppressTransportClick: HTMLElement | undefined;
  private transportIdentity = '';
  private tooltipTimer: number | undefined;
  private tooltipButton: HTMLButtonElement | undefined;
  private selectedMediaSignature = '';
  private cacheCapture: MseCacheCaptureRuntime | undefined;
  private cacheSnapshot = defaultCacheSnapshot();
  private cacheFilenameDraft:
    | {
        value: string;
        route: string;
        hookGeneration: number | undefined;
        groupId: string | undefined;
      }
    | undefined;
  private unsubscribeCache: (() => void) | undefined;
  private resourceSnapshot: FloatingResourceSnapshot = EMPTY_RESOURCE_SNAPSHOT;
  private resourceRequestPending = false;
  private resourceRequestSequence = 0;
  private activeResourceRequestSequence: number | undefined;
  private resourceSnapshotMutationSequence = 0;
  private resourceRetryTimer: number | undefined;
  private resourcePageIdentity: string;
  private resourceNavigationEpoch = 0;
  private resourceMediaEpoch = 0;
  private resourceAcceptedSequence = -1;
  private resourceForceRefreshQueued = false;
  private resourceDownloadingProductId: string | undefined;
  private resourceActionError: string | undefined;
  private resourceProductsStale = false;
  private resourceMenuSequence = 0;
  private readonly resourceQualitySelections = new Map<string, DockQualityIntent>();
  private renderedResourceGeneration = '';
  private resourceProductRenderPending = false;
  private readonly resourceProductRenderSignatures = new WeakMap<HTMLElement, string>();
  private pendingResourceRenderTimer: number | undefined;
  private posterBinding: DockPosterBinding | undefined;
  private metadataArtwork: BoundMediaArtwork | undefined;
  private readonly failedPosterUrls = new Set<string>();
  private readonly previewRenderKeys = new WeakMap<HTMLElement, string>();
  private mergeDockView: MergeDockView | undefined;
  private downloadActivity: DownloadActivityView | undefined;
  private launcherTaskTimer: number | undefined;
  private mergeTerminalKey: string | undefined;
  private mergeTerminalAt = 0;
  private mergeDiagnosticsIdentity: string | undefined;
  private mergeActionPending = false;
  private mergePendingAction: 'merge' | 'separate' | 'path' | undefined;
  private mergeOperationSequence = 0;
  private mergeActionError: string | undefined;
  private mergePathPickerOpen = false;
  private mergePathPickerError: string | undefined;
  private panelResizeObserver: ResizeObserver | undefined;
  private layoutTimer: number | undefined;
  private unsubscribeLanguage: (() => void) | undefined;
  private playbackErrorMessage: string | undefined;

  constructor(
    private readonly doc: Document,
    private readonly manager: PlaybackManager,
    options: FloatingControllerOptions = {},
  ) {
    doc.getElementById(FLOATING_CONTROLLER_HOST_ID)?.remove();
    this.view = doc.defaultView ?? window;
    this.disclosureAnimator = new FloatingDisclosureAnimator(this.view, () =>
      this.scheduleDockLayout(),
    );
    this.resourcePageIdentity = siteMediaRouteKey(doc.URL);
    this.visualViewport = this.view.visualViewport;
    this.host = doc.createElement('div');
    this.host.id = FLOATING_CONTROLLER_HOST_ID;
    this.host.setAttribute('role', 'region');
    this.host.setAttribute('aria-label', uiText('E1074', { p1: APP_NAME_EN }));
    this.host.setAttribute('contenteditable', 'false');
    this.shadowRoot = this.host.attachShadow({ mode: 'open' });
    this.disposeStaticSelection = installShadowStaticTextSelectionGuard(this.shadowRoot);
    this.settings = { ...DEFAULT_SETTINGS.playback, ...options.playback };
    this.themeMode = options.themeMode ?? 'auto';
    this.positionStore = options.positionStore ?? browserPositionStore();
    this.positionKey = `foxfetch:media-dock-position:${doc.location.origin || 'local'}`;
    this.onModeChange = options.onModeChange;
    this.onSelectedMediaChange = options.onSelectedMediaChange;
    this.onResourceViewRequest = options.onResourceViewRequest;
    this.onResourceProductDownload = options.onResourceProductDownload;
    this.onMergeDockAction = options.onMergeDockAction;
    this.onMergeDockPathModeChange = options.onMergeDockPathModeChange;
    this.colorScheme = this.view.matchMedia('(prefers-color-scheme: dark)');
    this.launcherX = Math.max(LAUNCHER_MARGIN, this.view.innerWidth - LAUNCHER_SIZE - 18);
    this.launcherY = Math.max(LAUNCHER_MARGIN, this.view.innerHeight - LAUNCHER_SIZE - 18);
    this.positionAnchor.yRatio =
      this.launcherY / Math.max(1, this.view.innerHeight - LAUNCHER_SIZE);

    this.render();
    updateLocalizedMarkup(this.shadowRoot);
    this.unsubscribeLanguage = subscribeLanguage(() => {
      updateLocalizedMarkup(this.shadowRoot);
      this.elementSignature = '';
      this.update(this.manager.getMediaElements());
      this.renderResourceSnapshot();
      this.renderMergeSnapshot();
      this.renderCacheSnapshot();
      this.scheduleDockLayout();
    });
    this.applyTheme();
    this.doc.documentElement.append(this.host);
    this.shadowRoot.addEventListener('click', this.handleClick);
    this.shadowRoot.addEventListener('change', this.handleChange);
    this.shadowRoot.addEventListener('input', this.handleRateInput);
    this.shadowRoot.addEventListener('pointerdown', this.handlePointerDown);
    this.shadowRoot.addEventListener('pointermove', this.handlePointerMove);
    this.shadowRoot.addEventListener('pointerup', this.handlePointerUp);
    this.shadowRoot.addEventListener('pointercancel', this.handlePointerCancel);
    this.shadowRoot.addEventListener('lostpointercapture', this.handlePointerCancel);
    this.shadowRoot.addEventListener('dragstart', this.handleNativeDragStart);
    this.shadowRoot.addEventListener('contextmenu', this.handleTransportContextMenu);
    this.shadowRoot.addEventListener('pointerover', this.handleTooltipOver);
    this.shadowRoot.addEventListener('pointerout', this.handleTooltipOut);
    this.shadowRoot.addEventListener('focusin', this.handleTooltipFocus);
    this.shadowRoot.addEventListener('focusout', this.handleTooltipOut);
    this.shadowRoot.addEventListener('pointerover', this.handleLauncherPointerOver);
    this.shadowRoot.addEventListener('pointerout', this.handleLauncherPointerOut);
    this.shadowRoot.addEventListener('focusin', this.handleLauncherFocusIn);
    this.shadowRoot.addEventListener('focusout', this.handleLauncherFocusOut);
    this.shadowRoot.addEventListener('keydown', this.handleKeyDown);
    this.shadowRoot.addEventListener('scroll', this.handleDockScroll, true);
    this.doc.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
    this.view.addEventListener('resize', this.handleResize);
    this.view.addEventListener('blur', this.handleInteractionBlur);
    this.view.addEventListener('pointerup', this.handlePointerUp);
    this.doc.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.visualViewport?.addEventListener('resize', this.handleResize);
    this.visualViewport?.addEventListener('scroll', this.handleResize);
    this.colorScheme.addEventListener('change', this.handleColorSchemeChange);
    const panel = this.shadowRoot.querySelector<HTMLElement>('.panel');
    if (panel && typeof ResizeObserver !== 'undefined') {
      this.panelResizeObserver = new ResizeObserver(() => this.scheduleDockLayout());
      this.panelResizeObserver.observe(panel);
    }
    this.applyTheme();
    this.applyLauncherPosition();
    void this.restorePosition();

    this.attachCacheCapture(options.cacheCapture ?? getMseCacheCaptureRuntime(doc));
    this.update(this.manager.getMediaElements());
    if (options.initialMode) this.setMode(options.initialMode);
    this.navigationPanelIntent = new NavigationPanelIntent(doc);
    const restoreNavigationPanel = this.navigationPanelIntent.restore();
    if (restoreNavigationPanel && this.settings.showController) {
      this.setMode('playback');
      this.scheduleNavigationPanelExpiry();
    }
    if (!this.settings.showController) this.setMode('hidden');
  }

  getMode(): FloatingMediaDockMode {
    return this.mode;
  }

  async openSettings(token: string, section?: 'permissions'): Promise<void> {
    if (this.settingsFrame) {
      if (section) this.settingsFrame.section();
      return this.settingsFrame.ready;
    }
    if (this.settingsOpening) return this.settingsOpening;
    this.settingsOpening = (async () => {
      const panel = this.shadowRoot.querySelector<HTMLElement>('.panel')!;
      const container = this.doc.createElement('div');
      container.className = 'settings-frame-container';
      const style = this.doc.createElement('style');
      style.textContent =
        ':host([data-settings-open]){display:block!important}:host([data-settings-open]) .launcher{display:none!important}:host([data-settings-open]) .panel{display:flex!important;height:85dvh;max-height:85dvh}:host([data-settings-open]) .panel > :not(.settings-frame-container){display:none!important}.settings-frame-container{display:block;flex:1;min-height:0;width:100%;height:100%}';
      this.shadowRoot.append(style);
      const children = Array.from(panel.children) as HTMLElement[];
      const previousInert = children.map((child) => child.inert);
      children.forEach((child) => {
        child.inert = true;
      });
      panel.append(container);
      this.host.dataset.settingsOpen = 'true';
      this.host.hidden = false;
      this.applyPanelPosition();
      const close = () => {
        this.settingsFrame?.dispose();
        this.settingsFrame = undefined;
        this.settingsOpening = undefined;
        delete this.host.dataset.settingsOpen;
        style.remove();
        children.forEach((child, index) => {
          child.inert = previousInert[index]!;
        });
        this.mode = this.settings.showController ? this.resolveAvailableMode(this.mode) : 'hidden';
        this.syncMode();
      };
      this.settingsFrame = await mountSettingsFrame(container, {
        token,
        ...(section ? { section } : {}),
        onClose: close,
        onDrag: (dx, dy) => {
          const rect = panel.getBoundingClientRect();
          this.panelDragPosition = { left: rect.left + dx, top: rect.top + dy };
          this.applyPanelPosition();
          this.capturePositionAnchor('free');
          void this.persistPosition();
        },
      });
      try {
        await this.settingsFrame.ready;
      } catch (error) {
        close();
        throw error;
      }
    })().finally(() => {
      this.settingsOpening = undefined;
    });
    return this.settingsOpening;
  }

  setMode(mode: FloatingMediaDockMode): void {
    if (this.settingsFrame || this.settingsOpening) return;
    if (mode === 'launcher' || mode === 'hidden') this.navigationPanelIntent?.dismiss(mode);
    else if (mode !== 'playback' && mode !== 'suppressed') this.navigationPanelIntent?.clear();
    if (mode === 'suppressed') {
      this.suppress(true);
      return;
    }
    if (this.mode === 'suppressed') {
      this.modeBeforeSuppression = this.resolveAvailableMode(mode);
      return;
    }
    const next = this.resolveAvailableMode(mode);
    if (next !== 'merge') this.setMergeReturnConfirmationVisible(false);
    if (next !== 'resources') this.closeProductMenus();
    if (next !== 'merge') this.setMergePathPickerVisible(false);
    if (this.mode === next) {
      this.syncMode();
      return;
    }
    this.cancelDrag();
    this.mode = next;
    this.syncMode();
    this.onModeChange?.(next);
  }

  suppress(suppressed = true): void {
    if (suppressed) {
      if (this.mode !== 'suppressed') {
        this.cancelDrag();
        this.modeBeforeSuppression = this.mode;
        this.mode = 'suppressed';
        this.syncMode();
        this.onModeChange?.('suppressed');
      }
      return;
    }
    if (this.mode !== 'suppressed') return;
    this.mode = this.userDismissed
      ? 'hidden'
      : this.resolveAvailableMode(this.modeBeforeSuppression);
    this.syncMode();
    this.onModeChange?.(this.mode);
  }

  openCache(): void {
    if (isYouTubePage(this.doc.URL)) {
      this.openResources();
      return;
    }
    this.userDismissed = false;
    this.setMode('cache');
  }

  openPlayback(): void {
    this.userDismissed = false;
    this.setMode('playback');
  }

  openResources(view: 'regular' | 'cache' = 'regular', returnToList = false): void {
    if (returnToList)
      this.shadowRoot
        .querySelectorAll<HTMLElement>('[data-youtube-task-open]')
        .forEach(closeYouTubeTaskPage);
    this.userDismissed = false;
    if (view === 'cache') {
      this.setMode('cache');
      return;
    }
    this.setMode('resources');
    void this.requestResourceSnapshot();
  }

  /** Open the in-page merge task without exposing media URLs or durable job ids. */
  openMerge(view: MergeDockView): void {
    this.userDismissed = false;
    if (!shouldAcceptMergeDockView(this.mergeDockView, view, { allowTaskChange: true })) return;
    if (this.mode !== 'merge') this.mergeDiagnosticsIdentity = undefined;
    if (this.mergeViewIdentity(this.mergeDockView) !== this.mergeViewIdentity(view)) {
      this.mergeReturnSequence += 1;
      this.mergeReturnPending = false;
      this.setMergeReturnConfirmationVisible(false);
      this.mergeDockView = undefined;
      this.mergeActionPending = false;
      this.mergePendingAction = undefined;
      this.mergeOperationSequence += 1;
    }
    this.setMergeSnapshot(view);
    this.setMode('merge');
  }

  /** Apply a background-owned sanitized view update for the current merge task. */
  setMergeSnapshot(view: MergeDockView): void {
    if (!shouldAcceptMergeDockView(this.mergeDockView, view)) return;
    if (
      (view.state === 'completed' || view.state === 'failed' || view.state === 'cancelled') &&
      (view.state !== this.mergeDockView?.state ||
        view.snapshot?.revision !== this.mergeDockView?.snapshot?.revision)
    ) {
      // A background terminal snapshot is authoritative. Late transport or
      // directory callbacks must not turn a verified success into a UI error.
      this.mergeOperationSequence += 1;
      this.mergeActionPending = false;
      this.mergePendingAction = undefined;
      this.mergePathPickerError = undefined;
      this.setMergePathPickerVisible(false);
    }
    this.mergeDockView = { ...view };
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    if (this.mode === 'merge') this.syncMode();
  }

  /** Metadata was tied to the Agent's admitted player; revalidate again when painting. */
  setArtwork(artwork: BoundMediaArtwork | undefined): void {
    if (JSON.stringify(this.metadataArtwork) === JSON.stringify(artwork)) return;
    this.metadataArtwork = artwork;
    this.refreshPosterSurfaces();
  }

  /** Passive URL-free status; cannot open or switch the user's current view. */
  setDownloadActivity(activity: DownloadActivityView): void {
    if (
      activity.pageIdentity !== this.resourcePageIdentity ||
      activity.pageIdentity !== siteMediaRouteKey(this.doc.URL) ||
      activity.mediaEpoch !== this.resourceMediaEpoch ||
      !Number.isSafeInteger(activity.revision) ||
      activity.revision < 0 ||
      !Number.isFinite(activity.updatedAt) ||
      !Number.isSafeInteger(activity.activeCount) ||
      activity.activeCount < 0 ||
      (this.downloadActivity && activity.revision <= this.downloadActivity.revision)
    )
      return;
    this.downloadActivity = { ...activity, updatedAt: Math.min(Date.now(), activity.updatedAt) };
    this.renderLauncherStatus();
  }

  /** Replace the sanitized regular-download view without exposing raw media URLs to the page. */
  setResourceSnapshot(snapshot: FloatingResourceSnapshot): void {
    const currentPageIdentity = siteMediaRouteKey(this.doc.URL);
    const pageIdentity = snapshot.pageIdentity ?? currentPageIdentity;
    if (pageIdentity !== currentPageIdentity || pageIdentity !== this.resourcePageIdentity) return;

    const navigationEpoch = snapshot.navigationEpoch ?? this.resourceNavigationEpoch;
    const mediaEpoch = snapshot.mediaEpoch ?? this.resourceMediaEpoch;
    if (navigationEpoch < this.resourceNavigationEpoch) return;
    if (navigationEpoch === this.resourceNavigationEpoch && mediaEpoch < this.resourceMediaEpoch) {
      return;
    }
    const generationAdvanced =
      navigationEpoch > this.resourceNavigationEpoch || mediaEpoch > this.resourceMediaEpoch;
    const sequence = snapshot.sequence ?? snapshot.requestSequence;
    if (!generationAdvanced && sequence != null && sequence < this.resourceAcceptedSequence) {
      return;
    }

    if (generationAdvanced) {
      this.resourceAcceptedSequence = -1;
      this.posterBinding = undefined;
      this.metadataArtwork = undefined;
      this.downloadActivity = undefined;
      this.failedPosterUrls.clear();
      this.resourceQualitySelections.clear();
    }
    this.resourcePageIdentity = pageIdentity;
    this.resourceNavigationEpoch = navigationEpoch;
    this.resourceMediaEpoch = mediaEpoch;
    if (sequence != null) this.resourceAcceptedSequence = sequence;
    // Scans intentionally publish a short loading window before manifest and
    // network observations converge. Keep the last committed products for the
    // same generation so live controls are stale-while-revalidate rather than
    // being destroyed and recreated on every poll.
    const preserveCommittedProducts =
      !generationAdvanced &&
      snapshot.status === 'loading' &&
      snapshot.products.length === 0 &&
      this.resourceSnapshot.products.length > 0;
    const sourceProducts = preserveCommittedProducts
      ? this.resourceSnapshot.products
      : snapshot.products;
    this.resourceProductsStale = preserveCommittedProducts;
    const next: FloatingResourceSnapshot = {
      status: snapshot.status,
      products: sourceProducts.map((product) => ({
        ...product,
        options: product.options.map((option) => ({ ...option })),
        ...(product.qualities
          ? { qualities: product.qualities.map((quality) => ({ ...quality })) }
          : {}),
      })),
      ...(snapshot.navigationEpoch == null ? {} : { navigationEpoch: snapshot.navigationEpoch }),
      ...(snapshot.mediaEpoch == null ? {} : { mediaEpoch: snapshot.mediaEpoch }),
      ...(sequence == null ? {} : { sequence }),
      ...(snapshot.pageIdentity ? { pageIdentity: snapshot.pageIdentity } : {}),
      ...(snapshot.revision ? { revision: snapshot.revision } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      ...(snapshot.youtube
        ? { youtube: snapshot.youtube }
        : !generationAdvanced && snapshot.status === 'loading' && this.resourceSnapshot.youtube
          ? { youtube: this.resourceSnapshot.youtube }
          : {}),
    };
    this.resourceSnapshot = next;
    this.resourceSnapshotMutationSequence += 1;
    if (next.status === 'ready' || next.products.length > 0) this.cancelResourceRetry();
    this.resourceActionError = undefined;
    this.renderResourceSnapshot(generationAdvanced);
    if (
      next.products.length > 0 &&
      this.settings.showController &&
      !this.userDismissed &&
      this.mode === 'hidden'
    ) {
      this.setMode('launcher');
    }
  }

  /** Immediately removes a stale SPA generation before the next background snapshot arrives. */
  clearResourceSnapshotForNavigation(context?: FloatingResourceContext): void {
    this.cacheFilenameDraft = undefined;
    this.cancelTransport();
    this.cancelRateDraft();
    this.hideTooltip();
    this.resourcePageIdentity = context?.pageIdentity ?? siteMediaRouteKey(this.doc.URL);
    if (context) {
      this.resourceNavigationEpoch = context.navigationEpoch;
      this.resourceMediaEpoch = context.mediaEpoch;
    }
    this.resourceAcceptedSequence = -1;
    this.resourceSnapshotMutationSequence += 1;
    this.activeResourceRequestSequence = undefined;
    this.resourceForceRefreshQueued = false;
    this.cancelResourceRetry();
    this.resourceSnapshot = {
      status: 'idle',
      products: [],
      navigationEpoch: this.resourceNavigationEpoch,
      mediaEpoch: this.resourceMediaEpoch,
      pageIdentity: this.resourcePageIdentity,
    };
    this.resourceRequestPending = false;
    this.resourceDownloadingProductId = undefined;
    this.resourceProductsStale = false;
    this.resourceQualitySelections.clear();
    this.resourceActionError = undefined;
    this.posterBinding = undefined;
    this.failedPosterUrls.clear();
    this.metadataArtwork = undefined;
    this.downloadActivity = undefined;
    this.closeProductMenus();
    this.closeDockVariantSelects();
    this.renderResourceSnapshot(true);
  }

  refreshResources(): void {
    void this.requestResourceSnapshot(true);
  }

  collapse(): void {
    this.navigationPanelIntent?.dismiss('launcher');
    this.userDismissed = false;
    if (['playback', 'resources', 'cache', 'merge'].includes(this.mode)) {
      const selector = this.mode === 'cache' ? '.resources-view' : `.${this.mode}-view`;
      this.minimizedView = {
        mode: this.mode,
        route: siteMediaRouteKey(this.doc.URL),
        scroll: this.shadowRoot.querySelector<HTMLElement>(selector)?.scrollTop ?? 0,
      };
    }
    this.disclosureAnimator.finish();
    this.setMergeReturnConfirmationVisible(false);
    this.setCloseConfirmationVisible(false);
    this.cacheCapture?.hide();
    this.closeProductMenus();
    this.setMode('launcher');
  }

  private restoreMinimizedView(): void {
    const previous = this.minimizedView;
    this.userDismissed = false;
    if (!previous || previous.route !== siteMediaRouteKey(this.doc.URL)) {
      this.minimizedView = undefined;
      this.openPlayback();
      return;
    }
    // Restore the retained view only. Opening cache must not start another capture.
    this.setMode(previous.mode);
    if (this.mode === 'cache') this.cacheCapture?.show();
    const selector = this.mode === 'cache' ? '.resources-view' : `.${this.mode}-view`;
    const pane = this.shadowRoot.querySelector<HTMLElement>(selector);
    if (pane) pane.scrollTop = previous.scroll;
  }

  getSelectedElementId(): string | undefined {
    return this.selectedElementId;
  }

  isUserDismissed(): boolean {
    return this.userDismissed;
  }

  applyExternalMode(mode: FloatingMediaDockMode): void {
    if (mode === 'suppressed') {
      this.suppress(true);
      return;
    }
    this.suppress(false);
    if (mode !== 'launcher' || !this.userDismissed) this.setMode(mode);
  }

  resetForNavigation(context?: FloatingResourceContext): void {
    if (
      context &&
      this.navigationPanelSettledEpoch != null &&
      context.mediaEpoch !== this.navigationPanelSettledEpoch
    ) {
      this.navigationPanelIntent?.clear();
      this.navigationPanelSettledEpoch = undefined;
    }
    const keepPlayback = this.navigationPanelIntent?.active() && this.mode === 'playback';
    const manualMode = this.navigationPanelIntent?.manualMode();
    this.mergeReturnSequence += 1;
    this.minimizedView = undefined;
    this.mergeReturnPending = false;
    this.setMergeReturnConfirmationVisible(false);
    this.clearResourceSnapshotForNavigation(context);
    this.setMergePathPickerVisible(false);
    this.mergeDockView = undefined;
    this.mergeActionPending = false;
    this.mergePendingAction = undefined;
    this.mergeOperationSequence += 1;
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    if (manualMode) {
      this.setMode(manualMode);
      return;
    }
    this.userDismissed = false;
    if (!this.settings.showController) return;
    if (keepPlayback) {
      this.setMode('playback');
      return;
    }
    if (this.cacheSnapshot.status !== 'idle') {
      this.setMode(this.cacheSnapshot.minimized ? 'launcher' : 'cache');
      return;
    }
    if (this.mediaElements.length > 0) this.setMode('launcher');
  }

  attachCacheCapture(runtime: MseCacheCaptureRuntime | undefined): void {
    this.cacheFilenameDraft = undefined;
    this.unsubscribeCache?.();
    if (this.cacheCapture) this.cacheCapture.setUiRequestHandler(undefined);
    this.cacheCapture = runtime;
    this.unsubscribeCache = undefined;
    if (!runtime) {
      this.cacheSnapshot = defaultCacheSnapshot();
      this.renderCacheSnapshot();
      return;
    }
    runtime.setUiRequestHandler((request) => {
      // Retiring the old capture emits a launcher request before the Agent's
      // navigation reset. It must not collapse an explicitly retained panel.
      if (
        request === 'launcher' &&
        this.navigationPanelIntent?.active() &&
        this.mode === 'playback'
      )
        return;
      if (request === 'cache' && !this.userDismissed) this.setMode('cache');
      if (request === 'launcher' && !this.userDismissed) this.setMode('launcher');
      if (request === 'hidden') this.setMode('hidden');
    });
    this.unsubscribeCache = runtime.subscribe((snapshot) => {
      this.cacheSnapshot = snapshot;
      this.renderCacheSnapshot();
      this.syncAutoAdvanceGuard();
      this.syncBufferTailLoop();
      if (
        !this.userDismissed &&
        this.mode === 'hidden' &&
        snapshot.status !== 'idle' &&
        this.settings.showController
      ) {
        this.setMode(snapshot.minimized ? 'launcher' : 'cache');
      }
    });
  }

  update(elements: readonly MediaElementInfo[]): void {
    this.ensureMounted();
    this.mediaElements = elements;
    const routeKey = siteMediaRouteKey(this.doc.URL);
    const explicitTarget = this.explicitSelection
      ? elements.find(
          (element) =>
            this.explicitSelection?.routeKey === routeKey &&
            element.elementId === this.explicitSelection.elementId &&
            element.lifecycleGeneration === this.explicitSelection.lifecycleGeneration,
        )
      : undefined;
    if (this.explicitSelection && !explicitTarget) this.explicitSelection = undefined;

    // The manager keeps the best current target first (playing, then visible).
    // Only a deliberate listbox choice pins a target; an automatic choice must
    // be free to follow a newly active player while an old SPA node remains.
    const active = explicitTarget ?? elements[0];
    this.selectedElementId = active?.elementId;
    const transportIdentity = active
      ? [
          routeKey,
          active.frameId,
          active.elementId,
          active.lifecycleGeneration,
          active.sourceUrl ?? '',
        ].join('\u0000')
      : '';
    if (transportIdentity !== this.transportIdentity) {
      this.transportIdentity = transportIdentity;
      this.cancelTransport();
      this.cancelRateDraft();
      this.hideTooltip();
      this.setPlaybackError();
    }
    const targetList = this.shadowRoot.querySelector<HTMLElement>('[data-role="target-list"]');
    const signature = elements.map((element) => `${element.elementId}:${element.title}`).join('|');
    if (targetList && signature !== this.elementSignature) {
      this.elementSignature = signature;
      targetList.replaceChildren();
      if (elements.length === 0) {
        const option = this.doc.createElement('button');
        option.type = 'button';
        option.className = 'target-option';
        option.disabled = true;
        option.textContent = uiText('E1075');
        targetList.append(option);
      } else {
        for (const [index, element] of elements.entries()) {
          const option = this.doc.createElement('button');
          option.type = 'button';
          option.className = 'target-option';
          option.dataset.action = 'select-target';
          option.dataset.elementId = element.elementId;
          option.setAttribute('role', 'option');
          const label = this.doc.createElement('span');
          label.textContent = `${index + 1}. ${element.kind === 'video' ? uiText('E0021') : uiText('E0022')} · ${element.title}`;
          option.append(label);
          targetList.append(option);
        }
      }
    }

    for (const option of this.shadowRoot.querySelectorAll<HTMLElement>(
      '[data-action="select-target"]',
    )) {
      option.setAttribute(
        'aria-selected',
        String(option.dataset.elementId === this.selectedElementId),
      );
    }
    const selectedSignature = active
      ? [
          routeKey,
          active.elementId,
          active.lifecycleGeneration,
          active.frameId,
          active.kind,
          active.sourceUrl ?? '',
          active.duration ?? '',
          active.width ?? '',
          active.height ?? '',
          active.title,
        ].join('\u0000')
      : '';
    if (selectedSignature !== this.selectedMediaSignature) {
      this.selectedMediaSignature = selectedSignature;
      this.onSelectedMediaChange?.(active);
    }
    setText(
      this.shadowRoot.querySelector('[data-role="target-label"]'),
      active?.title || (this.navigationPanelIntent?.active() ? uiText('E1077') : uiText('E1075')),
    );
    const trigger = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="toggle-target-list"]',
    );
    if (trigger) {
      trigger.disabled = elements.length === 0;
      trigger.title = active?.title || uiText('E1075');
      trigger.setAttribute('aria-label', active?.title || uiText('E1075'));
    }
    const disabled = !active;
    for (const button of this.shadowRoot.querySelectorAll<HTMLButtonElement>(
      'button[data-media-action]',
    )) {
      button.disabled = disabled;
    }
    const currentRate = active?.playbackRate ?? this.settings.defaultRate;
    const shownRate = this.rateDraft ?? currentRate;
    setText(this.shadowRoot.querySelector('[data-role="current-rate"]'), formatRate(shownRate));
    const slider = this.shadowRoot.querySelector<HTMLInputElement>('[data-role="rate-slider"]');
    if (slider) {
      if (this.ratePointerId == null && !this.ratePending)
        slider.value = String(Math.max(0.1, shownRate));
      slider.disabled = disabled;
      slider.setAttribute('aria-valuetext', formatRate(shownRate));
    }
    const playing = active?.paused === false && !active.ended;
    const playButton = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-media-action="toggle-play"]',
    );
    const playIcon = playButton?.querySelector<HTMLElement>('[data-role="play-icon"]');
    if (playIcon && playIcon.dataset.state !== (playing ? 'playing' : 'paused')) {
      playIcon.dataset.state = playing ? 'playing' : 'paused';
    }
    playButton?.setAttribute('aria-label', playing ? uiText('E1078') : uiText('E1079'));
    this.shadowRoot
      .querySelector('[data-media-action="pip"]')
      ?.setAttribute(
        'aria-label',
        this.doc.pictureInPictureElement ? uiText('E1080') : uiText('E1081'),
      );
    if (
      this.tooltipButton &&
      !this.shadowRoot.querySelector<HTMLElement>('.transport-tooltip')?.hidden
    )
      this.renderTooltip();
    setText(
      this.shadowRoot.querySelector('[data-role="mute-label"]'),
      active?.muted ? uiText('E1082') : uiText('E1083'),
    );
    this.shadowRoot
      .querySelector('[data-media-action="mute"]')
      ?.setAttribute('aria-pressed', String(active?.muted === true));
    if (this.mode === 'playback')
      setText(
        this.shadowRoot.querySelector('[data-role="panel-status"]'),
        this.playbackStatusLabel(),
      );
    this.setPlaybackError(this.playbackErrorMessage);
    const activePoster =
      active?.kind === 'video' ? mediaArtworkDisplayUrl(active.poster, this.doc.URL) : undefined;
    const activeTitleKey = active ? mediaArtworkTitleKey(active.title, this.doc.URL) : '';
    if (active && activePoster && activeTitleKey && !this.failedPosterUrls.has(activePoster)) {
      // `update` is the point at which the media Agent confirms a player for
      // this route generation. A render after an SPA reset cannot adopt a
      // retained old <video> merely because it is still present in the DOM.
      this.posterBinding = {
        pageIdentity: routeKey,
        mediaEpoch: this.resourceMediaEpoch,
        titleKey: activeTitleKey,
        elementId: active.elementId,
        lifecycleGeneration: active.lifecycleGeneration,
        url: activePoster,
      };
    } else if (this.posterBinding?.elementId != null) {
      this.posterBinding = undefined;
    }
    this.refreshPosterSurfaces();
    if (
      elements.length === 0 &&
      this.cacheSnapshot.status === 'idle' &&
      this.resourceSnapshot.products.length === 0 &&
      !this.mergeDockView
    ) {
      if (
        !this.navigationPanelIntent?.active() &&
        (this.mode === 'launcher' || this.mode === 'playback')
      )
        this.setMode('hidden');
    } else if (
      elements.length > 0 &&
      this.settings.showController &&
      !this.userDismissed &&
      this.mode === 'hidden'
    ) {
      this.setMode('launcher');
    }
    this.syncAutoAdvanceGuard();
    this.renderLauncherStatus();
    if (active && !this.navigationPending && this.navigationPanelIntent?.arrived()) {
      this.navigationPanelSettledEpoch = this.resourceMediaEpoch;
    }
  }

  applySettings(themeMode: ThemeMode, playback: PlaybackSettings): void {
    this.themeMode = themeMode;
    this.settings = { ...playback };
    this.applyTheme();
    if (playback.showController) {
      if (
        !this.userDismissed &&
        this.mode === 'hidden' &&
        (this.mediaElements.length > 0 || this.resourceSnapshot.products.length > 0)
      ) {
        this.setMode('launcher');
      }
    } else {
      this.setMode('hidden');
    }
    this.update(this.manager.getMediaElements());
  }

  /** Legacy show now expands playback; launcher is available through collapse/setMode. */
  show(): void {
    this.openPlayback();
  }

  hide(): void {
    this.setMergeReturnConfirmationVisible(false);
    this.setCloseConfirmationVisible(false);
    this.setMergePathPickerVisible(false);
    this.closeTargetList();
    this.closeProductMenus();
    this.userDismissed = true;
    this.setMode('hidden');
  }

  toggle(): boolean {
    if (
      this.mode === 'playback' ||
      this.mode === 'resources' ||
      this.mode === 'cache' ||
      this.mode === 'merge'
    ) {
      this.collapse();
    } else this.restoreMinimizedView();
    return ['playback', 'resources', 'cache', 'merge'].includes(this.mode);
  }

  destroy(): void {
    this.unsubscribeLanguage?.();
    this.settingsFrame?.dispose();
    this.settingsFrame = undefined;
    const locationLayer = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-path-picker"]',
    );
    if (locationLayer) disposeMediaLocationLayout(locationLayer);
    const youtubeContent = this.shadowRoot.querySelector<HTMLElement>('[data-youtube-status]');
    if (youtubeContent) disposeYouTubeInspection(youtubeContent);
    if (this.navigationPanelTimer != null) this.view.clearTimeout(this.navigationPanelTimer);
    this.mergeReturnSequence += 1;
    this.disposeStaticSelection();
    for (const animation of this.transportFeedback.values()) animation.cancel();
    this.transportFeedback.clear();
    this.disclosureAnimator.finish();
    this.mergeOperationSequence += 1;
    this.mergeActionPending = false;
    this.mergePendingAction = undefined;
    this.cancelTransport();
    this.cancelRateDraft();
    this.hideTooltip();
    this.clearLauncherPreviewTimer();
    if (this.launcherTaskTimer != null) this.view.clearTimeout(this.launcherTaskTimer);
    this.clearBufferTailTimer();
    this.cancelResourceRetry();
    this.resourceProductRenderPending = false;
    if (this.pendingResourceRenderTimer != null) {
      this.view.clearTimeout(this.pendingResourceRenderTimer);
      this.pendingResourceRenderTimer = undefined;
    }
    this.activeResourceRequestSequence = undefined;
    this.resourceRequestPending = false;
    this.resourceForceRefreshQueued = false;
    this.releaseAutoAdvanceGuard();
    this.setMergePathPickerVisible(false);
    this.closeProductMenus();
    this.clearLayoutTimer();
    this.panelResizeObserver?.disconnect();
    this.unsubscribeCache?.();
    this.cacheCapture?.setUiRequestHandler(undefined);
    this.colorScheme.removeEventListener('change', this.handleColorSchemeChange);
    this.view.removeEventListener('resize', this.handleResize);
    this.shadowRoot.removeEventListener('click', this.handleClick);
    this.shadowRoot.removeEventListener('change', this.handleChange);
    this.shadowRoot.removeEventListener('input', this.handleRateInput);
    this.shadowRoot.removeEventListener('pointerdown', this.handlePointerDown);
    this.shadowRoot.removeEventListener('pointermove', this.handlePointerMove);
    this.shadowRoot.removeEventListener('pointerup', this.handlePointerUp);
    this.shadowRoot.removeEventListener('pointercancel', this.handlePointerCancel);
    this.shadowRoot.removeEventListener('lostpointercapture', this.handlePointerCancel);
    this.shadowRoot.removeEventListener('dragstart', this.handleNativeDragStart);
    this.shadowRoot.removeEventListener('contextmenu', this.handleTransportContextMenu);
    this.shadowRoot.removeEventListener('pointerover', this.handleTooltipOver);
    this.shadowRoot.removeEventListener('pointerout', this.handleTooltipOut);
    this.shadowRoot.removeEventListener('focusin', this.handleTooltipFocus);
    this.shadowRoot.removeEventListener('focusout', this.handleTooltipOut);
    this.view.removeEventListener('blur', this.handleInteractionBlur);
    this.view.removeEventListener('pointerup', this.handlePointerUp);
    this.doc.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.shadowRoot.removeEventListener('pointerover', this.handleLauncherPointerOver);
    this.shadowRoot.removeEventListener('pointerout', this.handleLauncherPointerOut);
    this.shadowRoot.removeEventListener('focusin', this.handleLauncherFocusIn);
    this.shadowRoot.removeEventListener('focusout', this.handleLauncherFocusOut);
    this.shadowRoot.removeEventListener('keydown', this.handleKeyDown);
    this.shadowRoot.removeEventListener('scroll', this.handleDockScroll, true);
    this.doc.removeEventListener('pointerdown', this.handleDocumentPointerDown, true);
    this.host.remove();
    this.visualViewport?.removeEventListener('resize', this.handleResize);
    this.visualViewport?.removeEventListener('scroll', this.handleResize);
  }

  private render(): void {
    const launcherLightLogoUrl = extensionAssetUrl('icons/foxfetch.svg');
    const launcherDarkLogoUrl = extensionAssetUrl('icons/foxfetch-dark.svg');
    const style = this.doc.createElement('style');
    style.textContent =
      DOCK_STYLES +
      scrollbarStyles +
      `
      .playback-foot .control { transition: transform 220ms ease, background 160ms ease; }
      .playback-foot .control:active:not(:disabled) { transform: scale(.92); }
      .playback-foot [data-media-action="mute"] { min-width: 7em; }
      .view { scrollbar-width: thin; }
      .view::-webkit-scrollbar { width: 6px; }
      @media (prefers-reduced-motion: reduce) { .playback-foot .control { transition: none; } }
    `;
    const launcher = this.doc.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.dataset.action = 'launcher';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-label', uiText('E1084', { p1: APP_NAME }));
    launcher.innerHTML = `
      <span class="launcher-tile" aria-hidden="true">
        <span class="launcher-mark">
          <img class="launcher-logo launcher-logo-light" src="${launcherLightLogoUrl}" alt="" draggable="false">
          <img class="launcher-logo launcher-logo-dark" src="${launcherDarkLogoUrl}" alt="" draggable="false">
          <span class="launcher-compact-status"><i class="launcher-status"></i></span>
        </span>
        <span class="launcher-copy">
          <strong class="launcher-brand"><span class="launcher-brand-fox">Fox</span><span class="launcher-brand-fetch">Fetch</span></strong>
          <span class="launcher-state"><i class="launcher-status"></i><span class="launcher-state-text" data-role="launcher-status"><span data-i18n="E1085">等待媒体</span></span></span>
        </span>
        <span class="launcher-progress"><i></i></span>
      </span>`;

    const panel = this.doc.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `
      <header class="head">
        <span class="mark" aria-hidden="true"><img class="launcher-logo-light" src="${launcherLightLogoUrl}" alt="" draggable="false"><img class="launcher-logo-dark" src="${launcherDarkLogoUrl}" alt="" draggable="false"></span>
        <span class="identity">
          <strong class="brand" aria-label="FoxFetch"><span class="launcher-brand-fox">Fox</span><span class="launcher-brand-fetch">Fetch</span></strong>
          <span class="status" data-role="panel-status"><span data-i18n="E1086">统一媒体控制</span></span>
        </span>
        <span class="head-actions">
          <button class="icon-button merge-back" type="button" data-action="back-from-merge" aria-label="返回视频资源" data-i18n-aria-label="E1087" title="返回视频资源" data-i18n-title="E1087"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="icon-button" type="button" data-action="collapse" aria-label="收起为方形启动器" data-i18n-aria-label="E1088">−</button>
          <button class="icon-button" type="button" data-action="request-hide" aria-label="关闭控制器" data-i18n-aria-label="E1089">×</button>
        </span>
      </header>
      <nav class="view-tabs" role="tablist" aria-label="媒体工具" data-i18n-aria-label="E1090">
        <button class="view-tab" id="foxfetch-playback-tab" type="button" role="tab" data-action="open-playback" aria-controls="foxfetch-playback-panel"><span data-i18n="E1091">播放控制</span></button>
        <button class="view-tab" id="foxfetch-resources-tab" type="button" role="tab" data-action="open-resources" aria-controls="foxfetch-resources-panel"><span data-i18n="E1092">资源下载</span></button>
      </nav>
      <div class="view playback-view" id="foxfetch-playback-panel" role="tabpanel" aria-labelledby="foxfetch-playback-tab">
        <div class="target-picker">
          <button class="target-trigger" type="button" data-action="toggle-target-list" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="foxfetch-target-list">
            <span class="target-trigger-label" data-role="target-label"><span data-i18n="E1075">未发现可控制的媒体</span></span>
            <span class="target-chevron" aria-hidden="true">${DISCLOSURE_ICON}</span>
          </button>
          <div class="target-list" id="foxfetch-target-list" data-role="target-list" role="listbox" aria-label="选择网页媒体" data-i18n-aria-label="E1093" hidden></div>
        </div>
        <div class="transport">
          <button class="control" type="button" data-media-action="seek-back" aria-label="后退15秒；长按3倍速快退；右键上一个视频" data-i18n-aria-label="E1094"><span class="transport-icon">${TRANSPORT_ICONS.back}</span></button>
          <button class="control primary" type="button" data-media-action="toggle-play" aria-label="播放视频" data-i18n-aria-label="E1079"><span class="transport-icon" data-role="play-icon" data-state="paused">${TRANSPORT_ICONS.play.replace('<svg ', '<svg class="play-shape" ')}${TRANSPORT_ICONS.pause.replace('<svg ', '<svg class="pause-shape" ')}</span></button>
          <button class="control" type="button" data-media-action="seek-forward" aria-label="前进15秒；长按3倍速快进；右键下一个视频" data-i18n-aria-label="E1095"><span class="transport-icon">${TRANSPORT_ICONS.forward}</span></button>
          <button class="control" type="button" data-media-action="pip" aria-label="进入画中画" data-i18n-aria-label="E1081"><span class="transport-icon">${TRANSPORT_ICONS.pip}</span></button>
        </div>
        <div class="rate-heading"><label class="rate-label" for="foxfetch-rate-slider"><span data-i18n="E1096">播放速度</span></label><strong class="current-rate" data-role="current-rate">1×</strong></div>
        <input id="foxfetch-rate-slider" class="rate-slider" type="range" min="0.1" max="16" step="0.05" value="1" data-role="rate-slider" aria-label="播放速度" data-i18n-aria-label="E1096">
        <div class="playback-foot"><button class="control" type="button" data-media-action="restore-rate" aria-label="恢复默认速度为1倍" data-i18n-aria-label="E1097"><span data-i18n="E1098">恢复默认速度</span></button><button class="control" type="button" data-media-action="mute"><span data-role="mute-label"><span data-i18n="E1083">静音</span></span></button></div>
        <p class="playback-error" data-role="playback-error" role="status" hidden></p>
      </div>
      <div class="view resources-view" id="foxfetch-resources-panel" role="tabpanel" aria-labelledby="foxfetch-resources-tab">
        <nav class="resource-tabs" role="tablist" aria-label="资源下载方式" data-i18n-aria-label="E1099">
          <button class="resource-tab" id="foxfetch-regular-tab" type="button" role="tab" data-action="open-regular-download" aria-controls="foxfetch-regular-panel"><span data-i18n="E1100">常规下载</span></button>
          <button class="resource-tab" id="foxfetch-cache-tab" type="button" role="tab" data-action="open-cache" aria-controls="foxfetch-cache-panel"><span data-i18n="E1101">缓存下载</span><span class="resource-tab-status" aria-hidden="true"></span></button>
        </nav>
        <section class="resource-pane regular-download-pane" id="foxfetch-regular-panel" role="tabpanel" aria-labelledby="foxfetch-regular-tab">
          <div class="resource-heading">
            <span><strong><span data-i18n="E1102">视频资源</span></strong> <span class="resource-live" data-role="resource-status" data-state="recognizing" aria-label="正在识别" data-i18n-aria-label="E1103" title="正在识别" data-i18n-title="E1103"></span></span>
            <button class="resource-refresh" type="button" data-action="refresh-resources"><span data-i18n="E1104">刷新</span></button>
          </div>
          <p class="resource-notice" data-role="resource-notice" aria-live="polite" hidden></p>
          <div data-role="regular-download-content" aria-live="polite" aria-busy="false"></div>
        </section>
        <section class="resource-pane cache-download-pane cache-view" id="foxfetch-cache-panel" role="tabpanel" aria-labelledby="foxfetch-cache-tab">
          <p class="cache-message" data-role="cache-message" aria-live="polite"></p>
          <div class="metric-row"><strong data-role="cache-time">0:00 / --:--</strong><span><b data-role="cache-bytes">0 B</b> · <b data-role="cache-sources">0</b><span data-i18n="E1106"> 个媒体源 · </span><b data-role="cache-tracks">0</b><span data-i18n="E1107"> 条轨道</span><br><b class="completion-badge" data-role="cache-complete" data-complete="false"><span data-i18n="E1108">等待从头捕获</span></b></span></div>
          <div class="meter" role="progressbar" aria-label="缓存时间进度" data-i18n-aria-label="E1109"><span data-role="cache-meter"></span></div>
          <label class="filename-row"><span><span data-i18n="E1110">文件名</span></span><input type="text" maxlength="180" data-role="cache-filename" aria-label="缓存文件名" data-i18n-aria-label="E1111"></label>
          <div class="cache-actions">
            <button class="cache-button primary" type="button" data-cache-action="download" title="同一媒体源的兼容音视频会在本地无损合并" data-i18n-title="E1112">${DOWNLOAD_ICON}<span data-role="cache-download-label"><span data-i18n="E1113">下载已捕获数据</span></span></button>
          </div>
          <div class="cache-secondary">
            <button class="cache-button" type="button" data-cache-action="reset-reload" title="清除本次缓存、刷新当前页面并从 0 秒重新捕获" data-i18n-title="E1116"><span data-i18n="E1117">删除并从头捕获</span></button>
            <button class="cache-button" type="button" data-cache-action="toggle-capture" title="暂停或继续接收播放器实际追加的媒体数据" data-i18n-title="E1118"><span data-i18n="E1119">停止捕获</span></button>
          </div>
          <details class="cache-options" data-animated-disclosure>
            <summary aria-expanded="false"><span><span data-i18n="E1120">更多选项</span></span>${DISCLOSURE_ICON}</summary>
            <div class="disclosure-body"><div class="cache-options-body">
              <label class="auto-row"><span><span data-i18n="E1121">播放结束后自动保存</span></span><input type="checkbox" data-role="cache-auto-download"></label>
              <label class="auto-row"><span><span data-i18n="E1122">自动跳转到已缓冲内容的末尾</span></span><input type="checkbox" data-role="cache-buffer-tail"></label>
              <label class="auto-row"><span><span data-i18n="E1123">缓存期间阻止自动连播</span></span><input type="checkbox" data-role="cache-prevent-auto-advance" checked></label>
              <label class="auto-row"><span><span data-i18n="E1124">下载成功后清理缓存</span></span><input type="checkbox" data-role="cache-clear-after-download"></label>
              <details class="tracks" data-animated-disclosure><summary aria-expanded="false"><span><span data-i18n="E1125">媒体轨道（</span><span data-role="cache-track-summary">0</span>）</span>${DISCLOSURE_ICON}</summary><div class="disclosure-body"><div class="track-list" data-role="cache-track-list"></div></div></details>
            </div></div>
          </details>
        </section>
      </div>
      <div class="view merge-view" id="foxfetch-merge-panel" role="region" aria-label="合并下载任务" data-i18n-aria-label="E1126" aria-hidden="true">
        ${mediaTaskSummaryMarkup}
        ${mediaTaskProgressMarkup}
        <p class="merge-status" data-role="merge-status" aria-live="assertive" hidden></p>
        ${mediaTaskDetailsMarkup}
        ${mediaTaskLocationMarkup}
        <div class="merge-actions">
          <button class="cache-button primary" type="button" data-merge-action="merge">${DOWNLOAD_ICON}<span data-role="merge-action-label"><span data-i18n="E0033">下载</span></span></button>
          <button class="cache-button" type="button" data-merge-action="cancel"><span><span data-i18n="E0101">取消</span></span></button>
        </div>
        ${mediaLocationDialogMarkup}
      </div>
      <div class="confirm-layer" data-role="merge-return-confirm" role="dialog" aria-modal="true" aria-labelledby="foxfetch-return-title" hidden>
        <div class="confirm-dialog"><strong id="foxfetch-return-title"><span data-i18n="E1127">返回并终止任务？</span></strong><p><span data-i18n="E1128">将停止当前常规下载和初始化。缩小窗口不会停止任务。</span></p><p data-role="merge-return-error" aria-live="assertive" hidden></p><div class="confirm-actions"><button class="cache-button" type="button" data-action="continue-merge"><span data-i18n="E1129">继续任务</span></button><button class="cache-button primary" type="button" data-action="confirm-merge-return"><span data-i18n="E1130">终止并返回</span></button></div></div>
      </div>
      <div class="confirm-layer" data-role="close-confirm" role="dialog" aria-modal="true" aria-labelledby="foxfetch-close-title" hidden>
        <div class="confirm-dialog">
          <strong id="foxfetch-close-title"><span data-i18n="E1131">关闭 FoxFetch 媒体控制器？</span></strong>
          <p><span data-i18n="E1132">关闭后，可按 Alt+Shift+M；也可点击浏览器工具栏的 FoxFetch，再点“倍速”重新打开。进入新视频路由时也会恢复。</span></p>
          <div class="confirm-actions">
            <button class="cache-button" type="button" data-action="cancel-hide"><span data-i18n="E0101">取消</span></button>
            <button class="cache-button primary" type="button" data-action="confirm-hide"><span data-i18n="E1133">确认关闭</span></button>
          </div>
        </div>
      </div>`;
    const tooltip = this.doc.createElement('div');
    tooltip.id = 'foxfetch-transport-tooltip';
    tooltip.className = 'transport-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    tooltip.setAttribute('popover', 'manual');
    this.shadowRoot.append(style, launcher, panel, tooltip);
    const diagnostics = panel.querySelector<HTMLDetailsElement>('[data-role="merge-diagnostics"]');
    diagnostics?.addEventListener('toggle', () => {
      setText(
        diagnostics.querySelector('summary'),
        diagnostics.open ? uiText('E1134') : uiText('E1135'),
      );
      this.scheduleDockLayout();
    });
    this.renderResourceSnapshot();
    this.renderMergeSnapshot();
    this.renderLauncherStatus();
  }

  private resolveAvailableMode(mode: FloatingMediaDockMode): FloatingMediaDockMode {
    if (isYouTubePage(this.doc.URL) && mode === 'cache') return 'resources';
    if (mode === 'suppressed') return mode;
    const cacheAvailable = this.cacheSnapshot.status !== 'idle';
    if (mode === 'merge') {
      if (this.mergeDockView) return 'merge';
      if (this.resourceSnapshot.products.length > 0) return 'resources';
      return this.mediaElements.length > 0 ? 'playback' : cacheAvailable ? 'cache' : 'hidden';
    }
    if (mode === 'cache')
      return this.cacheCapture ? 'cache' : this.mediaElements.length ? 'playback' : 'hidden';
    if (
      mode === 'playback' &&
      this.mediaElements.length === 0 &&
      !this.navigationPanelIntent?.active()
    )
      return cacheAvailable ? 'cache' : 'hidden';
    if (
      mode === 'launcher' &&
      this.mediaElements.length === 0 &&
      !cacheAvailable &&
      this.resourceSnapshot.products.length === 0 &&
      !this.mergeDockView
    ) {
      return 'hidden';
    }
    return mode;
  }

  private syncMode(): void {
    if (this.settingsFrame || this.settingsOpening) {
      this.host.hidden = false;
      this.applyPanelPosition();
      return;
    }
    this.host.dataset.mode = this.mode;
    this.host.hidden = this.mode === 'hidden' || this.mode === 'suppressed';
    if (this.mode !== 'playback') {
      this.cancelTransport();
      this.cancelRateDraft();
      this.hideTooltip();
    }
    if (this.dragPointerId == null) {
      this.resolvePositionAnchor();
      this.applyLauncherPosition();
    }
    if (this.mode !== 'launcher') this.setLauncherPreview(false);
    if (
      this.mode === 'playback' ||
      this.mode === 'resources' ||
      this.mode === 'cache' ||
      this.mode === 'merge'
    ) {
      this.applyPanelPosition();
    }
    this.positionOpenProductMenu();
    setText(
      this.shadowRoot.querySelector('[data-role="panel-status"]'),
      this.mode === 'cache'
        ? this.cacheSnapshot.message
        : this.mode === 'merge'
          ? ''
          : this.mode === 'resources'
            ? (this.resourceActionError ??
              (this.resourceSnapshot.status === 'loading'
                ? uiText('E1136')
                : this.resourceSnapshot.status === 'error'
                  ? uiText('E1137')
                  : uiText('E1102')))
            : this.playbackStatusLabel(),
    );
    this.syncViewTabs();
  }

  private playbackStatusLabel(): string {
    const active = this.mediaElements.find(
      (element) => element.elementId === this.selectedElementId,
    );
    return active
      ? `${formatRate(active.playbackRate)} · ${active.ended ? uiText('playback.ended') : active.paused ? uiText('E1138') : uiText('E1139')}`
      : uiText('E1140');
  }

  private renderLauncherStatus(): void {
    let state: 'idle' | 'loading' | 'ready' | 'capturing' | 'paused' | 'error' = 'idle';
    let label = uiText('E1085');
    const cacheStatus = this.cacheSnapshot.status;
    const cacheRatio = this.cacheSnapshot.progressRatio;
    const now = Date.now();
    const merge = this.mergeDockView;
    const mergeTerminal = merge && ['completed', 'failed', 'cancelled'].includes(merge.state);
    const terminalKey = mergeTerminal
      ? `${this.mergeViewIdentity(merge)}:${merge.state}`
      : undefined;
    if (terminalKey !== this.mergeTerminalKey) {
      this.mergeTerminalKey = terminalKey;
      this.mergeTerminalAt = now;
    }
    const mergeRecent = !mergeTerminal || now < this.mergeTerminalAt + 12_000;
    const taskStatus =
      merge && merge.state !== 'ready' && mergeRecent
        ? {
            get preparing() {
              return uiText('E1141');
            },
            get permission_required() {
              return uiText('E1142');
            },
            running:
              (
                {
                  get fetching() {
                    return uiText('E0502');
                  },
                  get muxing() {
                    return uiText('E1143');
                  },
                  get verifying() {
                    return uiText('E1144');
                  },
                  get saving() {
                    return uiText('E1145');
                  },
                  get paused() {
                    return uiText('E1138');
                  },
                } as Record<string, string>
              )[merge.phase ?? ''] ?? uiText('E1146'),
            get cancelling() {
              return uiText('E1147');
            },
            get cancelled() {
              return uiText('E1148');
            },
            get completed() {
              return uiText('E0176');
            },
            get failed() {
              return uiText('E1149');
            },
          }[merge.state]
        : undefined;
    const direct = this.downloadActivity;
    const directActive = direct?.state === 'preparing' || direct?.state === 'downloading';
    const directTerminal = direct && ['completed', 'failed', 'cancelled'].includes(direct.state);
    const directRecent = directTerminal && now < direct.updatedAt + 12_000;
    const showDirect =
      direct &&
      (directActive || directRecent) &&
      (!taskStatus ||
        (mergeTerminal && (directActive || direct.updatedAt >= this.mergeTerminalAt)));
    if (this.launcherTaskTimer != null) this.view.clearTimeout(this.launcherTaskTimer);
    this.launcherTaskTimer = undefined;
    const expiries = [
      mergeTerminal ? this.mergeTerminalAt + 12_000 : 0,
      directTerminal ? direct.updatedAt + 12_000 : 0,
    ].filter((expires) => expires > now);
    if (expiries.length)
      this.launcherTaskTimer = this.view.setTimeout(
        () => {
          this.launcherTaskTimer = undefined;
          this.renderLauncherStatus();
        },
        Math.min(...expiries) - now + 1,
      );

    const regularDownloadFailed =
      this.resourceSnapshot.status === 'error' && this.resourceSnapshot.products.length === 0;
    // Background cache failures are not regular-download failures. Cache fallback
    // notifications belong here only after the regular resolver explicitly fails.
    if (showDirect) {
      state =
        direct.state === 'failed'
          ? 'error'
          : direct.state === 'completed'
            ? 'ready'
            : direct.state === 'cancelled'
              ? 'paused'
              : 'loading';
      label = {
        get idle() {
          return uiText('E1085');
        },
        get preparing() {
          return uiText('E0103');
        },
        get downloading() {
          return uiText('E0502');
        },
        get completed() {
          return uiText('E1150');
        },
        get failed() {
          return uiText('E1149');
        },
        get cancelled() {
          return uiText('E1148');
        },
      }[direct.state];
      if (direct.state === 'downloading' && direct.activeCount > 1)
        label += uiText('E1151', { p1: direct.activeCount });
    } else if (merge && taskStatus) {
      state =
        merge.state === 'failed'
          ? 'error'
          : merge.state === 'completed'
            ? 'ready'
            : merge.state === 'cancelled' ||
                merge.state === 'permission_required' ||
                merge.phase === 'paused'
              ? 'paused'
              : 'loading';
      label = taskStatus;
      if (merge.state === 'running' && merge.progress != null && Number.isFinite(merge.progress)) {
        label += ` ${Math.round(clamp(merge.progress, 0, 1) * 100)}%`;
      }
    } else if (regularDownloadFailed && cacheStatus !== 'idle') {
      if (cacheStatus === 'starting') {
        state = 'loading';
        label = uiText('E1152');
      } else if (cacheStatus === 'capturing') {
        state = 'capturing';
        label =
          cacheRatio == null
            ? uiText('E1153')
            : uiText('E1154', { p1: Math.round(clamp(cacheRatio, 0, 1) * 100) });
      } else if (cacheStatus === 'paused') {
        state = 'paused';
        label = uiText('E1155');
      } else if (cacheStatus === 'ready') {
        state = 'ready';
        label = uiText('E1156');
      } else if (cacheStatus === 'downloading') {
        state = 'loading';
        label = uiText('E1157');
      } else {
        state = 'error';
        label = cacheStatus === 'blocked_drm' ? uiText('E1158') : uiText('E1159');
      }
    } else if (regularDownloadFailed) {
      state = 'error';
      label = uiText('E1160');
    } else if (this.resourceActionError) {
      state = 'error';
      label = uiText('E1161');
    } else if (this.resourceRequestPending || this.resourceSnapshot.status === 'loading') {
      state = 'loading';
      label = uiText('E1162');
    } else if (
      this.resourceSnapshot.products.length > 0 ||
      this.mediaElements.some((element) => element.kind === 'video')
    ) {
      state = 'ready';
      label = uiText('E1163');
    } else if (this.mediaElements.length > 0) {
      state = 'ready';
      label = uiText('E1164');
    }

    this.host.dataset.launcherStatus = state;
    setText(this.shadowRoot.querySelector('[data-role="launcher-status"]'), label);
    const launcher = this.shadowRoot.querySelector<HTMLElement>('.launcher');
    if (!launcher) return;
    const cacheDetail =
      regularDownloadFailed && cacheStatus === 'capturing' && this.cacheSnapshot.capturedBytes > 0
        ? uiText('E1165', { p1: formatMseCacheBytes(this.cacheSnapshot.capturedBytes) })
        : '';
    const accessibleLabel = uiText('E1166', { p1: APP_NAME, p2: label, p3: cacheDetail });
    launcher.setAttribute('aria-label', accessibleLabel);
    launcher.title = label;
  }

  private clearLauncherPreviewTimer(): void {
    if (this.launcherPreviewTimer == null) return;
    this.view.clearTimeout(this.launcherPreviewTimer);
    this.launcherPreviewTimer = undefined;
  }

  private setLauncherPreview(visible: boolean): void {
    this.clearLauncherPreviewTimer();
    if (visible && this.mode === 'launcher' && !(this.dragPointerId != null && this.didDrag)) {
      this.host.dataset.launcherPreview = 'true';
    } else {
      delete this.host.dataset.launcherPreview;
    }
  }

  private scheduleLauncherPreview(visible: boolean, delay: number): void {
    this.clearLauncherPreviewTimer();
    if (visible && (this.mode !== 'launcher' || (this.dragPointerId != null && this.didDrag)))
      return;
    this.launcherPreviewTimer = this.view.setTimeout(() => {
      this.launcherPreviewTimer = undefined;
      this.setLauncherPreview(visible);
    }, delay);
  }

  private syncViewTabs(): void {
    const playbackSelected = this.mode === 'playback';
    const resourcesPanelVisible = this.mode === 'resources' || this.mode === 'cache';
    const resourcesSelected = resourcesPanelVisible || this.mode === 'merge';
    this.syncTab('[data-action="open-playback"]', playbackSelected);
    this.syncTab('[data-action="open-resources"]', resourcesSelected);
    this.syncTab(
      '[data-action="open-regular-download"]',
      this.mode === 'resources',
      !resourcesPanelVisible,
    );
    this.syncTab('[data-action="open-cache"]', this.mode === 'cache');

    const playbackPanel = this.shadowRoot.querySelector<HTMLElement>('#foxfetch-playback-panel');
    const resourcesPanel = this.shadowRoot.querySelector<HTMLElement>('#foxfetch-resources-panel');
    const regularPanel = this.shadowRoot.querySelector<HTMLElement>('#foxfetch-regular-panel');
    const cachePanel = this.shadowRoot.querySelector<HTMLElement>('#foxfetch-cache-panel');
    const mergePanel = this.shadowRoot.querySelector<HTMLElement>('#foxfetch-merge-panel');
    playbackPanel?.setAttribute('aria-hidden', String(!playbackSelected));
    resourcesPanel?.setAttribute('aria-hidden', String(!resourcesPanelVisible));
    regularPanel?.setAttribute('aria-hidden', String(this.mode !== 'resources'));
    cachePanel?.setAttribute('aria-hidden', String(this.mode !== 'cache'));
    mergePanel?.setAttribute('aria-hidden', String(this.mode !== 'merge'));
  }

  private syncTab(selector: string, selected: boolean, fallbackFocusable = false): void {
    const tab = this.shadowRoot.querySelector<HTMLButtonElement>(selector);
    if (!tab) return;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected || fallbackFocusable ? 0 : -1;
  }

  private cancelResourceRetry(): void {
    if (this.resourceRetryTimer != null) this.view.clearTimeout(this.resourceRetryTimer);
    this.resourceRetryTimer = undefined;
  }

  private scheduleResourceRetry(attempt: number): void {
    this.cancelResourceRetry();
    const delay = RESOURCE_RETRY_DELAYS_MS[attempt];
    if (delay == null) return;
    const pageIdentity = this.resourcePageIdentity;
    const navigationEpoch = this.resourceNavigationEpoch;
    const mediaEpoch = this.resourceMediaEpoch;
    this.resourceRetryTimer = this.view.setTimeout(() => {
      this.resourceRetryTimer = undefined;
      if (
        pageIdentity !== this.resourcePageIdentity ||
        navigationEpoch !== this.resourceNavigationEpoch ||
        mediaEpoch !== this.resourceMediaEpoch
      ) {
        return;
      }
      void this.requestResourceSnapshot(true, attempt + 1);
    }, delay);
  }

  private async requestResourceSnapshot(force = false, retryAttempt = 0): Promise<void> {
    if (this.resourceRequestPending) {
      if (force) this.resourceForceRefreshQueued = true;
      return;
    }
    if (!this.onResourceViewRequest) {
      this.resourceSnapshot = {
        status: 'error',
        products: this.resourceSnapshot.products,
        get error() {
          return uiText('E1167');
        },
      };
      this.renderResourceSnapshot();
      return;
    }

    if (retryAttempt === 0) this.cancelResourceRetry();
    const requestSequence = ++this.resourceRequestSequence;
    const requestMutationSequence = this.resourceSnapshotMutationSequence;
    const requestPageIdentity = this.resourcePageIdentity;
    const requestNavigationEpoch = this.resourceNavigationEpoch;
    const requestMediaEpoch = this.resourceMediaEpoch;
    this.activeResourceRequestSequence = requestSequence;
    this.resourceRequestPending = true;
    this.resourceActionError = undefined;
    this.resourceSnapshot = {
      status: 'loading',
      products: this.resourceSnapshot.products,
      navigationEpoch: requestNavigationEpoch,
      mediaEpoch: requestMediaEpoch,
      sequence: requestSequence,
      pageIdentity: requestPageIdentity,
      ...(this.resourceSnapshot.revision ? { revision: this.resourceSnapshot.revision } : {}),
      message: force ? uiText('E1168') : uiText('E1169'),
      ...(this.resourceSnapshot.youtube ? { youtube: this.resourceSnapshot.youtube } : {}),
    };
    this.renderResourceSnapshot();
    try {
      await this.onResourceViewRequest(force);
    } catch (error) {
      if (
        this.activeResourceRequestSequence !== requestSequence ||
        this.resourceSnapshotMutationSequence !== requestMutationSequence ||
        this.resourcePageIdentity !== requestPageIdentity ||
        this.resourceNavigationEpoch !== requestNavigationEpoch ||
        this.resourceMediaEpoch !== requestMediaEpoch
      ) {
        return;
      }
      if (isTransientResourceSnapshotError(error)) {
        const hasAnotherRetry = retryAttempt < RESOURCE_RETRY_DELAYS_MS.length;
        this.resourceSnapshot = {
          ...this.resourceSnapshot,
          status: 'loading',
          message: hasAnotherRetry ? uiText('E1170') : uiText('E1171'),
        };
        delete this.resourceSnapshot.error;
        this.renderResourceSnapshot();
        if (hasAnotherRetry) this.scheduleResourceRetry(retryAttempt);
        return;
      }
      this.resourceSnapshot = {
        ...this.resourceSnapshot,
        status: 'error',
        error: error instanceof Error ? error.message : uiText('E1172'),
      };
    } finally {
      if (this.activeResourceRequestSequence === requestSequence) {
        this.activeResourceRequestSequence = undefined;
        this.resourceRequestPending = false;
        const refreshQueued = this.resourceForceRefreshQueued;
        this.resourceForceRefreshQueued = false;
        this.renderResourceSnapshot();
        if (refreshQueued) void this.requestResourceSnapshot(true);
      }
    }
  }

  private resourceRenderGeneration(): string {
    return `${this.resourcePageIdentity}\n${this.resourceNavigationEpoch}\n${this.resourceMediaEpoch}`;
  }

  /** Stable UI identity kept separate from the one-shot download grant. */
  private dockProductKey(product: FloatingDockProductModel): string {
    return product.renderKey?.trim() || product.id;
  }

  private dockProductGrantToken(product: FloatingDockProductModel): string {
    return product.grantToken?.trim() || product.id;
  }

  private dockQualityKey(quality: MediaDockProductQualityView): string {
    return quality.id?.trim() || quality.token;
  }

  private dockProductRenderSignature(product: FloatingDockProductModel): string {
    // Capability tokens rotate on every sanitized snapshot. They authorize an
    // action but do not describe presentation, so including them here remounts
    // the card and collapses an open listbox. Strip only those capabilities;
    // meaningful presentation/capability changes still produce a revision.
    return JSON.stringify({
      product: {
        ...product,
        id: this.dockProductKey(product),
        renderKey: this.dockProductKey(product),
        grantToken: undefined,
        qualities: product.qualities?.map((quality) => ({
          ...quality,
          id: this.dockQualityKey(quality),
          token: undefined,
        })),
      },
      busy: this.resourceDownloadingProductId === this.dockProductKey(product),
    });
  }

  private dockProductHasOpenInteraction(card: HTMLElement): boolean {
    return Boolean(
      card.dataset.menuOpen === 'true' ||
      card.querySelector<HTMLElement>('.dock-variant-trigger[aria-expanded="true"]'),
    );
  }

  /**
   * Reconcile product cards by id instead of rebuilding the whole resource
   * pane for every scan pulse. When a changed card is being used, keep its
   * exact live nodes until the interaction closes so focus, expansion and the
   * listbox scroll position survive the refresh.
   */
  private reconcileResourceProducts(
    content: HTMLElement,
    products: readonly FloatingDockProductModel[],
    forceReset: boolean,
  ): void {
    if (products.length === 0) {
      this.resourceProductRenderPending = false;
      content.replaceChildren();
      return;
    }

    let list = [...content.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('product-list'),
    );
    if (!list || forceReset) {
      list = this.doc.createElement('div');
      list.className = 'product-list';
      content.replaceChildren(list);
    }
    list.setAttribute('aria-label', uiText('E1173', { p1: products.length }));

    const existingById = new Map(
      [...list.children].flatMap((child) => {
        if (
          !(child instanceof HTMLElement) ||
          !child.classList.contains('dock-product') ||
          !child.dataset.productId
        ) {
          return [];
        }
        return [[child.dataset.productId, child] as const];
      }),
    );
    const desiredCards: HTMLElement[] = [];
    let deferred = false;

    for (const product of products) {
      const productKey = this.dockProductKey(product);
      const signature = this.dockProductRenderSignature(product);
      const existing = existingById.get(productKey);
      let card: HTMLElement;
      if (existing && this.resourceProductRenderSignatures.get(existing) === signature) {
        card = existing;
      } else if (existing && !forceReset && this.dockProductHasOpenInteraction(existing)) {
        card = existing;
        deferred = true;
      } else {
        card = this.createDockProduct(product);
        this.resourceProductRenderSignatures.set(card, signature);
      }
      // Even when the DOM is preserved, always refresh the live one-shot
      // capabilities and option availability in place.
      this.syncDockProductCapabilities(card, product);
      desiredCards.push(card);
      existingById.delete(productKey);
    }

    const desired = new Set(desiredCards);
    for (const obsolete of existingById.values()) obsolete.remove();
    desiredCards.forEach((card, index) => {
      const current = list!.children.item(index);
      if (current !== card) list!.insertBefore(card, current ?? null);
    });
    for (const child of [...list.children]) {
      if (child instanceof HTMLElement && !desired.has(child)) child.remove();
    }
    this.resourceProductRenderPending = deferred;
  }

  private schedulePendingResourceProductRender(): void {
    if (!this.resourceProductRenderPending || this.pendingResourceRenderTimer != null) return;
    this.pendingResourceRenderTimer = this.view.setTimeout(() => {
      this.pendingResourceRenderTimer = undefined;
      if (
        this.shadowRoot.querySelector(
          '.dock-product[data-menu-open="true"], .dock-variant-trigger[aria-expanded="true"]',
        )
      ) {
        return;
      }
      this.resourceProductRenderPending = false;
      this.renderResourceSnapshot();
    }, 0);
  }

  private renderResourceSnapshot(forceProductReset = false): void {
    const snapshot = this.resourceSnapshot;
    this.renderLauncherStatus();
    const content = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="regular-download-content"]',
    );
    if (!content) return;
    if (isYouTubePage(this.doc.URL) && snapshot.youtube) {
      const youtube =
        snapshot.youtube.status === 'disabled'
          ? snapshot.youtube
          : validateYouTubeInspection(snapshot.youtube, this.doc.URL);
      if (youtube) {
        setYouTubeSelectionRefreshing(content, snapshot.status === 'loading');
        this.closeProductMenus();
        const cache = this.shadowRoot.querySelector<HTMLButtonElement>(
          '[data-action="open-cache"]',
        );
        if (cache) {
          cache.disabled = true;
          cache.title = uiText('E0116');
        }
        const notice = this.shadowRoot.querySelector<HTMLElement>('[data-role="resource-notice"]');
        if (notice) notice.hidden = true;
        const refresh = this.shadowRoot.querySelector<HTMLButtonElement>(
          '[data-action="refresh-resources"]',
        );
        if (refresh) {
          refresh.disabled = this.resourceRequestPending;
          refresh.textContent = this.resourceRequestPending ? uiText('E1174') : uiText('E1104');
        }
        const indicator = this.shadowRoot.querySelector<HTMLElement>(
          '[data-role="resource-status"]',
        );
        if (indicator) {
          indicator.dataset.state = 'recognizing';
          indicator.textContent = '';
          indicator.setAttribute('aria-label', youTubeStatusText(youtube));
          indicator.title = youTubeStatusText(youtube);
        }
        renderYouTubeInspection(
          content,
          youtube,
          { downloads: true },
          {
            sharedControls: 'dock',
            taskBackButton: this.shadowRoot.querySelector<HTMLButtonElement>(
              '[data-action="back-from-merge"]',
            )!,
            dockPreview: (preview) =>
              this.renderVideoPreview(
                preview,
                youtube.title ?? uiText('E0112'),
                'youtube.com',
                youtube.duration,
                preview.classList.contains('merge-summary-preview'),
                identifiedYouTubeVideo(youtube, this.doc.URL)?.poster,
              ),
          },
        );
        content.setAttribute('aria-busy', String(snapshot.status === 'loading'));
        if (this.mode === 'resources') this.applyPanelPosition();
        return;
      }
    }
    if (content.hasAttribute('data-youtube-status')) {
      disposeYouTubeInspection(content);
      delete content.dataset.youtubeStatus;
    }
    const renderGeneration = this.resourceRenderGeneration();
    const generationChanged = renderGeneration !== this.renderedResourceGeneration;
    const resetProducts = forceProductReset || generationChanged;
    if (resetProducts) {
      if (this.pendingResourceRenderTimer != null) {
        this.view.clearTimeout(this.pendingResourceRenderTimer);
        this.pendingResourceRenderTimer = undefined;
      }
      this.resourceProductRenderPending = false;
      this.closeProductMenus();
      this.closeDockVariantSelects();
      this.renderedResourceGeneration = renderGeneration;
    }

    content.setAttribute('aria-busy', String(snapshot.status === 'loading'));
    const resourceFailure =
      this.resourceActionError ??
      (snapshot.status === 'error' ? (snapshot.error ?? uiText('E1175')) : undefined);
    const resourceIndicator = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="resource-status"]',
    );
    if (resourceIndicator) {
      const state = resourceFailure
        ? 'error'
        : snapshot.status === 'ready'
          ? 'success'
          : 'recognizing';
      const label =
        state === 'error'
          ? uiText('E1177')
          : state === 'success'
            ? uiText('E0138')
            : uiText('E1136');
      resourceIndicator.dataset.state = state;
      resourceIndicator.textContent = state === 'error' ? uiText('E1179') : '';
      resourceIndicator.setAttribute('aria-label', label);
      resourceIndicator.title = label;
    }
    const refresh = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="refresh-resources"]',
    );
    if (refresh) {
      refresh.disabled = this.resourceRequestPending;
      refresh.textContent = snapshot.status === 'loading' ? uiText('E1174') : uiText('E1104');
    }

    const notice = this.shadowRoot.querySelector<HTMLElement>('[data-role="resource-notice"]');
    const noticeText = resourceFailure;
    if (notice) {
      notice.hidden = !noticeText;
      notice.dataset.tone = 'error';
      notice.textContent = messageText(noticeText ?? '');
    }

    if (snapshot.products.length > 0) {
      this.reconcileResourceProducts(content, snapshot.products, resetProducts);
      if (this.mode === 'resources') this.applyPanelPosition();
      return;
    }

    if (!resetProducts && snapshot.status === 'loading' && content.querySelector('.product-list')) {
      // A transient empty pulse must not tear down a live menu. It is presentation only:
      // downloads resolve against the current (empty) capability snapshot and stay disabled.
      for (const button of content.querySelectorAll<HTMLButtonElement>(
        '[data-action="download-product"]',
      ))
        button.disabled = true;
      return;
    }

    this.reconcileResourceProducts(content, [], resetProducts);

    const state = this.doc.createElement('div');
    state.className = 'resource-state';
    const copy = this.doc.createElement('div');
    const title = this.doc.createElement('strong');
    const detail = this.doc.createElement('span');
    if (snapshot.status === 'loading') {
      state.dataset.loading = 'true';
      title.textContent = uiText('E1181');
      detail.textContent = messageText(snapshot.message ?? uiText('E1182'));
    } else if (snapshot.status === 'error') {
      title.textContent = uiText('E1183');
      detail.textContent = messageText(snapshot.error ?? uiText('E1184'));
    } else if (snapshot.status === 'ready') {
      title.textContent = uiText('E1185');
      detail.textContent = uiText('E1186');
    } else {
      title.textContent = uiText('E1187');
      detail.textContent = uiText('E1188');
    }
    copy.append(title, detail);
    state.append(copy);
    if (snapshot.status !== 'loading') {
      const cacheButton = this.doc.createElement('button');
      cacheButton.type = 'button';
      cacheButton.className = 'cache-button';
      cacheButton.dataset.action = 'open-cache';
      cacheButton.textContent = uiText('E1189');
      state.append(cacheButton);
    }
    content.append(state);
    if (this.mode === 'resources') this.applyPanelPosition();
  }

  private productQualityPreferenceKey(product: FloatingDockProductModel): string {
    return `${this.resourceRenderGeneration()}\n${this.dockProductKey(product)}`;
  }

  private rememberDockQualitySelection(
    product: FloatingDockProductModel,
    quality: FloatingDockProductQualityModel,
  ): void {
    this.resourceQualitySelections.set(this.productQualityPreferenceKey(product), {
      label: quality.label,
      ...(quality.id ? { id: quality.id } : {}),
      ...(quality.detail ? { detail: quality.detail } : {}),
      ...(quality.dynamicRange ? { dynamicRange: quality.dynamicRange } : {}),
      ...(quality.videoCodec ? { videoCodec: quality.videoCodec } : {}),
      ...(quality.audioCodec ? { audioCodec: quality.audioCodec } : {}),
    });
  }

  private unavailableDockQuality(intent: DockQualityIntent): FloatingDockProductQualityModel {
    return {
      ...intent,
      id: intent.id ?? `unavailable:${intent.label}`,
      token: '',
      detail: UNAVAILABLE_DOCK_QUALITY,
      completeAvailable: false,
      videoOnlyAvailable: false,
      fidelityState: 'blocked',
      mergeBlockedReason: UNAVAILABLE_DOCK_QUALITY,
    };
  }

  private selectedDockQuality(
    product: FloatingDockProductModel,
  ): FloatingDockProductQualityModel | undefined {
    const intent = this.resourceQualitySelections.get(this.productQualityPreferenceKey(product));
    if (intent) {
      const matches = (product.qualities ?? []).filter((quality) =>
        intent.id
          ? quality.id === intent.id
          : quality.label === intent.label &&
            quality.dynamicRange === intent.dynamicRange &&
            quality.videoCodec === intent.videoCodec,
      );
      // Legacy snapshots omit metadata ids. Retain only an unambiguous exact
      // label/codec match there, never use a token or title as media identity.
      const selected = matches.length === 1 ? matches[0] : undefined;
      if (selected && !this.resourceProductsStale) {
        this.rememberDockQualitySelection(product, selected);
        if (
          selected.completeAvailable ||
          selected.videoOnlyAvailable ||
          (selected.fidelityState === 'blocked' && selected.mergeBlockedReason?.trim())
        )
          return selected;
      }
      return this.unavailableDockQuality(selected ?? intent);
    }
    const qualities = groupFloatingDockQualities(product.qualities ?? []).flatMap((group) =>
      group.choices.map((choice) => choice.quality),
    );
    const selected =
      qualities.find((quality) => quality.token === this.dockProductGrantToken(product)) ??
      qualities[0];
    return selected && this.resourceProductsStale
      ? this.unavailableDockQuality(selected)
      : selected;
  }

  private dockProductQualityGroups(
    product: FloatingDockProductModel,
    selected = this.selectedDockQuality(product),
  ) {
    return groupFloatingDockQualities(
      this.resourceProductsStale ? [] : (product.qualities ?? []),
      selected && !selected.completeAvailable && !selected.videoOnlyAvailable
        ? selected
        : undefined,
    );
  }

  /**
   * Refresh expiring grants and capability flags without replacing the card,
   * trigger, listbox, or option that currently owns focus.
   */
  private syncDockProductCapabilities(card: HTMLElement, product: FloatingDockProductModel): void {
    const productKey = this.dockProductKey(product);
    card.dataset.productId = productKey;
    card.dataset.grantToken = this.dockProductGrantToken(product);
    const selected = this.selectedDockQuality(product);
    if (selected) this.applyDockProductQuality(card, product, selected);
    else this.syncDockProductDownloadOptions(card, product);
  }

  /** Keep the menu shape stable even while a scan temporarily omits a capability row. */
  private dockProductOptions(product: FloatingDockProductModel): MediaProductDownloadOption[] {
    return PRODUCT_DOWNLOAD_MODES.map(
      (mode) =>
        product.options.find((option) => option.mode === mode) ?? {
          mode,
          available: false,
        },
    );
  }

  private dockProductOptionAvailable(
    option: MediaProductDownloadOption,
    quality?: FloatingDockProductQualityModel,
  ): boolean {
    if (this.resourceProductsStale) return false;
    if (!quality || option.mode === 'audio') return option.available !== false;
    return option.mode === 'complete' ? quality.completeAvailable : quality.videoOnlyAvailable;
  }

  private dockProductOptionDetail(
    product: FloatingDockProductModel,
    option: MediaProductDownloadOption,
    quality: FloatingDockProductQualityModel | undefined,
    available: boolean,
  ): string {
    const dynamicRange = dockQualityDynamicRange(quality);
    const fidelityState = this.dockProductFidelityState(product, quality);
    const videoCodec = dockQualityVideoCodec(quality);
    const audioCodec = quality?.audioCodec?.trim().toUpperCase() || 'AAC';

    if (option.mode === 'audio') {
      return available ? uiText('E0786', { p1: audioCodec }) : (option.detail ?? uiText('E1190'));
    }
    if (!quality) {
      return available
        ? (option.detail ?? PRODUCT_DOWNLOAD_META[option.mode].detail)
        : (option.detail ?? uiText('E0056'));
    }
    if (!available) {
      if (quality.token === '') return UNAVAILABLE_DOCK_QUALITY;
      if (fidelityState === 'blocked' && quality.mergeBlockedReason?.trim()) {
        return quality.mergeBlockedReason.trim();
      }
      if (option.mode === 'video') return uiText('E1191');
      if (fidelityState === 'checking') {
        return dynamicRange === 'Dolby Vision' ? uiText('E1192') : uiText('E1193');
      }
      return this.dockProductFidelityError(product, quality) || uiText('E1194');
    }
    if (option.mode === 'complete') {
      return dynamicRange === 'unknown' || dynamicRange === 'SDR'
        ? uiText('E1195', { p1: quality.label })
        : `MP4 · ${dynamicRange} · ${videoCodec} + ${audioCodec}`;
    }
    return dynamicRange === 'unknown' || dynamicRange === 'SDR'
      ? uiText('E1196', { p1: quality.label })
      : uiText('E1197', { p1: dynamicRange, p2: videoCodec });
  }

  private dockProductFidelityState(
    product: FloatingDockProductModel,
    quality: FloatingDockProductQualityModel | undefined,
  ): DockFidelityState {
    if (quality?.completeCheckRequired || quality?.fidelityState === 'checking') return 'checking';
    if (quality?.completeAvailable) return 'ready';
    if (quality?.fidelityState) return quality.fidelityState;
    if (this.resourceSnapshot.status === 'loading') return 'checking';
    if (this.resourceSnapshot.status === 'error') return 'blocked';
    const complete = this.dockProductOptions(product).find((option) => option.mode === 'complete');
    return complete && this.dockProductOptionAvailable(complete, quality) ? 'ready' : 'blocked';
  }

  private dockProductFidelityError(
    product: FloatingDockProductModel,
    quality: FloatingDockProductQualityModel | undefined,
  ): string {
    // The capability-free placeholder already explains temporary absence in
    // the quality detail row; it is not evidence of a fidelity validation failure.
    if (quality?.token === '') return '';
    if (this.dockProductFidelityState(product, quality) !== 'blocked') return '';
    const explicit = quality?.mergeBlockedReason?.trim();
    if (explicit) return explicit;
    const audioAvailable = this.dockProductOptions(product).some(
      (option) => option.mode === 'audio' && this.dockProductOptionAvailable(option, quality),
    );
    if (dockQualityDynamicRange(quality) === 'Dolby Vision' && audioAvailable) {
      return uiText('E1198');
    }
    return audioAvailable ? uiText('E1199') : uiText('E1200');
  }

  private applyDockProductQuality(
    card: HTMLElement,
    product: FloatingDockProductModel,
    quality: MediaDockProductQualityView,
  ): void {
    const productKey = this.dockProductKey(product);
    const qualityKey = this.dockQualityKey(quality);
    card.dataset.productId = productKey;
    card.dataset.grantToken = this.dockProductGrantToken(product);
    card.dataset.qualityId = qualityKey;
    if (quality.token) card.dataset.qualityToken = quality.token;
    else delete card.dataset.qualityToken;
    this.syncDockProductVariantControls(card, product, quality);
    this.syncDockProductDownloadOptions(card, product, quality);
  }

  private syncDockProductDownloadOptions(
    card: HTMLElement,
    product: FloatingDockProductModel,
    quality?: FloatingDockProductQualityModel,
  ): void {
    const productKey = this.dockProductKey(product);
    for (const button of card.querySelectorAll<HTMLButtonElement>('.dock-product-option')) {
      const mode = button.dataset.downloadMode;
      const option = this.dockProductOptions(product).find((candidate) => candidate.mode === mode);
      if (!option) continue;
      const available = this.dockProductOptionAvailable(option, quality);
      button.dataset.productId = productKey;
      if (quality) {
        button.dataset.qualityId = this.dockQualityKey(quality);
        if (quality.token) button.dataset.qualityToken = quality.token;
        else delete button.dataset.qualityToken;
      } else {
        delete button.dataset.qualityId;
        delete button.dataset.qualityToken;
      }
      button.hidden = false;
      button.disabled = !available || this.resourceDownloadingProductId === productKey;
      button.dataset.fidelityState =
        option.mode === 'complete' ? this.dockProductFidelityState(product, quality) : 'ready';
      const label = button.querySelector<HTMLElement>('.dock-product-option-copy strong');
      if (label) {
        label.textContent =
          option.mode === 'video' && !['unknown', 'SDR'].includes(dockQualityDynamicRange(quality))
            ? uiText('E1201')
            : (option.label ?? PRODUCT_DOWNLOAD_META[option.mode].label);
      }
      const detail = button.querySelector<HTMLElement>('.dock-product-option-copy small');
      if (detail) {
        detail.textContent = this.dockProductOptionDetail(product, option, quality, available);
      }
      const recommended = button.querySelector<HTMLElement>('.dock-product-recommended');
      if (recommended) recommended.hidden = !available;
    }
    const fidelityState = this.dockProductFidelityState(product, quality);
    card.dataset.fidelityState = fidelityState;
    const fidelityDot = card.querySelector<HTMLElement>('[data-role="product-fidelity"]');
    if (fidelityDot) {
      const pendingProof = fidelityState === 'checking' && quality?.completeAvailable;
      const label =
        quality?.token === ''
          ? uiText('E1202')
          : fidelityState === 'ready'
            ? uiText('E1204')
            : fidelityState === 'checking'
              ? pendingProof
                ? uiText('E0047')
                : uiText('E1206')
              : uiText('E1207');
      fidelityDot.dataset.state = fidelityState;
      fidelityDot.dataset.verification = pendingProof ? 'pending' : fidelityState;
      fidelityDot.setAttribute('aria-label', label);
      fidelityDot.title = label;
    }
    const fidelityError = card.querySelector<HTMLElement>('[data-role="product-fidelity-error"]');
    if (fidelityError) {
      const error = this.dockProductFidelityError(product, quality);
      fidelityError.textContent = error;
      fidelityError.hidden = !error;
    }
    const trigger = card.querySelector<HTMLButtonElement>('.dock-product-trigger');
    if (trigger) {
      trigger.dataset.productId = productKey;
      trigger.disabled =
        this.resourceDownloadingProductId === productKey ||
        !this.dockProductOptions(product).some((option) =>
          this.dockProductOptionAvailable(option, quality),
        );
    }
  }

  private syncDockProductVariantControls(
    card: HTMLElement,
    product: FloatingDockProductModel,
    quality: MediaDockProductQualityView,
  ): void {
    const groups = this.dockProductQualityGroups(product, quality);
    const selectedGroup = groups.find((group) =>
      group.choices.some(
        (choice) => this.dockQualityKey(choice.quality) === this.dockQualityKey(quality),
      ),
    );
    if (!selectedGroup) return;

    const resolution = card.querySelector<HTMLElement>('[data-role="product-resolution"]');
    this.syncDockVariantSelect(
      resolution,
      groups.map((group) => ({
        value: group.key,
        label: group.label,
        disabled: group.choices.every(
          (choice) => !choice.quality.completeAvailable && !choice.quality.videoOnlyAvailable,
        ),
      })),
      selectedGroup.key,
      groups.length < 2,
    );

    const codec = card.querySelector<HTMLElement>('[data-role="product-quality"]');
    const codecField = codec?.closest<HTMLElement>('.dock-product-variant');
    if (codec) {
      this.syncDockVariantSelect(
        codec,
        selectedGroup.choices.map((choice) => ({
          value: this.dockQualityKey(choice.quality),
          label: choice.codecLabel,
          title: choice.quality.label,
          disabled: !choice.quality.completeAvailable && !choice.quality.videoOnlyAvailable,
        })),
        this.dockQualityKey(quality),
        selectedGroup.choices.length < 2,
      );
      if (codecField) {
        codecField.hidden = !selectedGroup.choices.some((choice) => choice.hasExplicitCodec);
      }
    }

    const detail = card.querySelector<HTMLElement>('[data-role="product-quality-detail"]');
    if (detail) {
      detail.textContent = quality.detail?.trim() || uiText('E1208');
      detail.title = quality.detail?.trim() || quality.label;
    }
  }

  private syncDockVariantSelect(
    root: HTMLElement | null,
    options: readonly DockVariantOption[],
    selectedValue: string,
    disabled: boolean,
  ): void {
    if (!root) return;
    root.dataset.value = selectedValue;
    const selected = options.find((option) => option.value === selectedValue) ?? options[0];
    const trigger = root.querySelector<HTMLButtonElement>('.dock-variant-trigger');
    const value = root.querySelector<HTMLElement>('.dock-variant-value');
    const list = root.querySelector<HTMLElement>('.dock-variant-list');
    if (value) {
      value.textContent = selected?.label ?? uiText('E0017');
      value.title = selected?.title ?? selected?.label ?? '';
    }
    if (trigger) trigger.disabled = disabled || options.length === 0;
    if (!list) return;
    const wasOpen = !list.hidden;
    const previousScrollTop = list.scrollTop;
    const rootNode = list.getRootNode();
    const activeElement =
      rootNode instanceof ShadowRoot ? rootNode.activeElement : this.doc.activeElement;
    const activeValue =
      activeElement instanceof HTMLElement && list.contains(activeElement)
        ? activeElement.dataset.value
        : undefined;
    const existingByValue = new Map(
      [...list.querySelectorAll<HTMLButtonElement>('.dock-variant-option')].flatMap((item) =>
        item.dataset.value ? [[item.dataset.value, item] as const] : [],
      ),
    );
    const desired: HTMLButtonElement[] = [];
    for (const option of options) {
      const item = existingByValue.get(option.value) ?? this.doc.createElement('button');
      item.type = 'button';
      item.className = 'dock-variant-option';
      item.dataset.action = 'select-variant-option';
      item.dataset.variantKind = root.dataset.variantKind;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === selectedValue));
      item.title = option.title ?? option.label;
      item.textContent = option.label;
      item.tabIndex = option.value === selectedValue ? 0 : -1;
      item.disabled = option.disabled === true;
      desired.push(item);
      existingByValue.delete(option.value);
    }
    for (const obsolete of existingByValue.values()) obsolete.remove();
    desired.forEach((item, index) => {
      const current = list.children.item(index);
      if (current !== item) list.insertBefore(item, current ?? null);
    });
    list.scrollTop = previousScrollTop;
    if (wasOpen && activeValue) {
      const retained = desired.find((item) => item.dataset.value === activeValue);
      if (retained && activeElement !== retained) retained.focus({ preventScroll: true });
    }
    if (wasOpen) this.positionDockVariantList(root);
    if (disabled) this.closeDockVariantSelect(root);
  }

  private createDockVariantSelect(
    kind: DockVariantKind,
    role: string,
    label: string,
    listId: string,
  ): HTMLElement {
    const { root, trigger } = createDockVariantControl(this.doc, label, listId);
    root.dataset.role = role;
    root.dataset.variantKind = kind;
    trigger.dataset.action = 'toggle-variant-select';
    trigger.dataset.variantKind = kind;
    return root;
  }

  private selectedMediaInfo(): MediaElementInfo | undefined {
    return (
      this.mediaElements.find((element) => element.elementId === this.selectedElementId) ??
      this.mediaElements[0]
    );
  }

  /**
   * Bind page-owned artwork to the current route and media generation. No
   * provider media URL or background-issued capability is copied into the open
   * Shadow DOM. The metadata fallback is accepted only when its title matches.
   */
  private currentVideoPoster(title: string): string | undefined {
    const pageUrl = this.doc.URL;
    const pageIdentity = siteMediaRouteKey(pageUrl);
    if (pageIdentity !== this.resourcePageIdentity) return undefined;
    const titleKey = mediaArtworkTitleKey(title, pageUrl);
    if (!titleKey) return undefined;
    const binding = this.posterBinding;
    if (
      binding &&
      binding.pageIdentity === pageIdentity &&
      binding.mediaEpoch === this.resourceMediaEpoch &&
      binding.titleKey === titleKey &&
      !this.failedPosterUrls.has(binding.url)
    ) {
      if (binding.elementId == null) return binding.url;
      const active = this.selectedMediaInfo();
      if (
        active?.elementId === binding.elementId &&
        active.lifecycleGeneration === binding.lifecycleGeneration
      ) {
        return binding.url;
      }
    }

    const active = this.selectedMediaInfo();
    const metadata = active
      ? validateBoundMediaArtwork(this.metadataArtwork, {
          pageUrl,
          mediaEpoch: this.resourceMediaEpoch,
          activeMedia: { ...active, routeKey: pageIdentity, mediaEpoch: this.resourceMediaEpoch },
          ...(this.metadataArtwork?.providerIdentity
            ? { providerIdentity: this.metadataArtwork.providerIdentity }
            : {}),
        })
      : undefined;
    if (metadata?.titleKey !== titleKey) return undefined;
    const metadataPoster = mediaArtworkDisplayUrl(metadata?.url, pageUrl);
    if (!metadataPoster || this.failedPosterUrls.has(metadataPoster)) return undefined;
    return metadataPoster;
  }

  private renderVideoPreview(
    preview: HTMLElement,
    title: string,
    domain: string,
    duration?: number,
    compact = false,
    identifiedPoster?: string,
  ): void {
    const platform = floatingMediaPlatform(domain);
    const poster = identifiedPoster ?? this.currentVideoPoster(title);
    const renderKey = [
      platform.kind,
      title,
      duration ?? '',
      poster ?? '',
      compact ? 'compact' : 'card',
    ].join('\u0000');
    if (this.previewRenderKeys.get(preview) === renderKey) return;
    this.previewRenderKeys.set(preview, renderKey);
    preview.dataset.platform = platform.kind;
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', uiText('E1209', { p1: title, p2: platform.label }));
    preview.title = platform.label;
    preview.dataset.artworkStatus = poster ? 'loading' : 'missing-or-unbound';
    preview.replaceChildren();

    const fallback = this.doc.createElement('span');
    fallback.className = 'dock-product-logo';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.innerHTML = platformLogoSvg(platform.kind);
    preview.append(fallback);

    if (poster) {
      const image = this.doc.createElement('img');
      image.className = compact ? 'merge-summary-poster' : 'dock-product-poster';
      image.alt = '';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.src = poster;
      image.addEventListener(
        'load',
        () => {
          if (this.previewRenderKeys.get(preview) === renderKey)
            preview.dataset.artworkStatus = 'ready';
        },
        { once: true },
      );
      image.addEventListener(
        'error',
        () => {
          if (this.previewRenderKeys.get(preview) !== renderKey) return;
          this.failedPosterUrls.add(poster);
          if (this.posterBinding?.url === poster) this.posterBinding = undefined;
          image.remove();
          preview.dataset.artworkStatus = 'failed';
          if (!identifiedPoster) this.previewRenderKeys.delete(preview);
        },
        { once: true },
      );
      preview.append(image);
    }

    if (compact) return;
    const platformLabel = this.doc.createElement('span');
    platformLabel.className = 'dock-product-platform';
    platformLabel.textContent = platform.label;
    preview.append(platformLabel);
    if (duration != null && Number.isFinite(duration)) {
      const durationLabel = this.doc.createElement('span');
      durationLabel.className = 'dock-product-duration';
      durationLabel.textContent = formatDuration(duration);
      durationLabel.setAttribute('aria-hidden', 'true');
      preview.append(durationLabel);
    }
  }

  private refreshPosterSurfaces(): void {
    for (const card of this.shadowRoot.querySelectorAll<HTMLElement>('.dock-product')) {
      const product = this.resourceSnapshot.products.find(
        (candidate) => this.dockProductKey(candidate) === card.dataset.productId,
      );
      const preview = card.querySelector<HTMLElement>('.dock-product-preview');
      if (product && preview) {
        this.renderVideoPreview(preview, product.title, product.domain, product.duration);
      }
    }
    const mergePreview = this.shadowRoot.querySelector<HTMLElement>('[data-role="merge-preview"]');
    const mergeTitle = this.mergeDockView?.title;
    if (mergePreview && mergeTitle) {
      this.renderVideoPreview(
        mergePreview,
        mergeTitle,
        this.doc.location.hostname,
        undefined,
        true,
      );
    } else if (mergePreview) {
      this.renderVideoPreview(
        mergePreview,
        uiText('E1210'),
        this.doc.location.hostname,
        undefined,
        true,
      );
    }
  }

  private createDockProduct(product: FloatingDockProductModel): HTMLElement {
    const productKey = this.dockProductKey(product);
    const titleId = `foxfetch-product-title-${++this.resourceMenuSequence}`;
    const { card, preview, body, titleRow, actions } = createDockMediaCard(
      this.doc,
      product.title,
      titleId,
    );
    card.dataset.productId = productKey;
    card.dataset.grantToken = this.dockProductGrantToken(product);
    const triggerId = `${titleId}-trigger`;
    const menuId = `${titleId}-menu`;
    card.setAttribute('aria-labelledby', titleId);
    if (this.resourceDownloadingProductId === productKey) {
      card.classList.add('dock-product-busy');
      card.setAttribute('aria-busy', 'true');
    }

    this.renderVideoPreview(preview, product.title, product.domain, product.duration);
    const selectedQuality = this.selectedDockQuality(product);
    const qualityGroups = this.dockProductQualityGroups(product, selectedQuality);
    let variantPicker: HTMLElement | undefined;
    if (selectedQuality && qualityGroups.length > 0) {
      const variants = this.doc.createElement('div');
      variants.className = 'dock-product-variants';

      const resolutionField = this.doc.createElement('div');
      resolutionField.className = 'dock-product-variant';
      const resolution = this.createDockVariantSelect(
        'resolution',
        'product-resolution',
        uiText('E0053', { p1: product.title }),
        `${titleId}-resolution-list`,
      );
      resolutionField.append(resolution);

      const codecField = this.doc.createElement('div');
      codecField.className = 'dock-product-variant';
      const codec = this.createDockVariantSelect(
        'quality',
        'product-quality',
        uiText('E0054', { p1: product.title }),
        `${titleId}-quality-list`,
      );
      codecField.append(codec);

      variants.append(resolutionField, codecField);
      variantPicker = variants;
      card.dataset.qualityId = this.dockQualityKey(selectedQuality);
      if (selectedQuality.token) card.dataset.qualityToken = selectedQuality.token;
    }
    const meta = this.doc.createElement('span');
    meta.className = 'dock-product-meta';
    meta.dataset.role = 'product-quality-detail';
    meta.textContent =
      selectedQuality?.detail?.trim() || product.selectedQuality?.trim() || uiText('E1208');
    const fidelityError = this.doc.createElement('span');
    fidelityError.className = 'dock-product-fidelity-error';
    fidelityError.dataset.role = 'product-fidelity-error';
    fidelityError.setAttribute('aria-live', 'polite');
    fidelityError.hidden = true;
    body.append(titleRow);
    if (variantPicker) body.append(variantPicker);
    body.append(meta);

    const trigger = this.doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dock-product-trigger';
    trigger.id = triggerId;
    trigger.dataset.action = 'toggle-product-menu';
    trigger.dataset.productId = productKey;
    trigger.setAttribute('aria-label', uiText('E1211', { p1: product.title }));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', menuId);
    trigger.disabled =
      this.resourceDownloadingProductId === productKey ||
      !this.dockProductOptions(product).some((option) =>
        this.dockProductOptionAvailable(option, selectedQuality),
      );
    trigger.innerHTML = DOWNLOAD_ICON;
    actions.append(trigger);

    const menu = this.doc.createElement('div');
    menu.className = 'dock-product-menu';
    menu.id = menuId;
    menu.setAttribute('popover', 'manual');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', triggerId);
    menu.hidden = true;
    const menuTitle = this.doc.createElement('span');
    menuTitle.className = 'dock-product-menu-title';
    menuTitle.textContent = uiText('E0055');
    menu.append(menuTitle);
    for (const option of this.dockProductOptions(product)) {
      menu.append(this.createProductOption(product, option, selectedQuality));
    }

    card.append(preview, body, actions, fidelityError, menu);
    if (selectedQuality) this.applyDockProductQuality(card, product, selectedQuality);
    else this.syncDockProductDownloadOptions(card, product);
    return card;
  }

  private createProductOption(
    product: FloatingDockProductModel,
    option: MediaProductDownloadOption,
    quality?: FloatingDockProductQualityModel,
  ): HTMLButtonElement {
    const productKey = this.dockProductKey(product);
    const meta = PRODUCT_DOWNLOAD_META[option.mode];
    const available = this.dockProductOptionAvailable(option, quality);
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = `dock-product-option dock-product-option-${option.mode}`;
    button.dataset.action = 'download-product';
    button.dataset.productId = productKey;
    button.dataset.downloadMode = option.mode;
    if (quality) {
      button.dataset.qualityId = this.dockQualityKey(quality);
      button.dataset.qualityToken = quality.token;
    }
    button.setAttribute('role', 'menuitem');
    button.hidden = false;
    button.disabled = !available;
    button.dataset.fidelityState =
      option.mode === 'complete' ? this.dockProductFidelityState(product, quality) : 'ready';

    const icon = this.doc.createElement('span');
    icon.className = 'dock-product-option-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = meta.icon;
    const copy = this.doc.createElement('span');
    copy.className = 'dock-product-option-copy';
    const label = this.doc.createElement('strong');
    label.textContent =
      option.mode === 'video' && !['unknown', 'SDR'].includes(dockQualityDynamicRange(quality))
        ? uiText('E1201')
        : (option.label ?? meta.label);
    const detail = this.doc.createElement('small');
    detail.textContent = this.dockProductOptionDetail(product, option, quality, available);
    copy.append(label, detail);
    button.append(icon, copy);
    if (option.mode === 'complete') {
      const recommended = this.doc.createElement('span');
      recommended.className = 'dock-product-recommended';
      recommended.textContent = uiText('E0057');
      recommended.hidden = !available;
      button.append(recommended);
    }
    return button;
  }

  private toggleProductMenu(trigger: HTMLElement, focusLast = false): void {
    const card = trigger.closest<HTMLElement>('.dock-product');
    const menu = card?.querySelector<HTMLElement>('.dock-product-menu');
    if (!card || !menu) return;
    const opening = menu.dataset.open !== 'true';
    this.closeProductMenus(opening ? card.dataset.productId : undefined);
    card.dataset.menuOpen = String(opening);
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
      menu.hidden = false;
      menu.dataset.open = 'true';
      menu.style.visibility = 'hidden';
      try {
        menu.showPopover?.();
      } catch {
        // The fixed-position fallback remains usable when the Popover API is unavailable.
      }
      this.positionProductMenu(trigger, menu);
      menu.style.removeProperty('visibility');
      const items = [
        ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
      ];
      this.view.setTimeout(() => (focusLast ? items.at(-1) : items[0])?.focus(), 0);
    } else {
      this.hideProductMenu(card, menu, trigger);
    }
    this.scheduleDockLayout();
  }

  private closeProductMenus(exceptProductId?: string): void {
    let closed = false;
    for (const card of this.shadowRoot.querySelectorAll<HTMLElement>('.dock-product')) {
      if (exceptProductId && card.dataset.productId === exceptProductId) continue;
      delete card.dataset.menuOpen;
      const menu = card.querySelector<HTMLElement>('.dock-product-menu');
      const trigger = card.querySelector<HTMLElement>('[data-action="toggle-product-menu"]');
      if (menu && trigger) {
        closed = closed || menu.dataset.open === 'true';
        this.hideProductMenu(card, menu, trigger);
      }
    }
    if (closed) this.scheduleDockLayout();
  }

  private toggleDockVariantSelect(trigger: HTMLElement, focusLast = false): void {
    const root = trigger.closest<HTMLElement>('.dock-variant-select');
    const list = root?.querySelector<HTMLElement>('.dock-variant-list');
    if (!root || !list || trigger instanceof HTMLButtonElement === false || trigger.disabled)
      return;
    const opening = list.hidden;
    this.closeDockVariantSelects(opening ? root : undefined);
    this.closeProductMenus();
    list.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
      list.dataset.open = 'true';
      list.style.visibility = 'hidden';
      try {
        list.showPopover?.();
      } catch {
        // Fixed-position fallback remains usable without the Popover API.
      }
      this.positionDockVariantList(root);
      list.style.removeProperty('visibility');
      const items = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')];
      const selected = items.find((item) => item.getAttribute('aria-selected') === 'true');
      this.view.setTimeout(() => (focusLast ? items.at(-1) : (selected ?? items[0]))?.focus(), 0);
    }
  }

  private closeDockVariantSelect(root: HTMLElement, restoreFocus = false): void {
    const list = root.querySelector<HTMLElement>('.dock-variant-list');
    const trigger = root.querySelector<HTMLButtonElement>('.dock-variant-trigger');
    if (list) {
      try {
        list.hidePopover?.();
      } catch {
        // A detached or fallback list may already be closed.
      }
      list.hidden = true;
      delete list.dataset.open;
      list.style.removeProperty('position');
      list.style.removeProperty('left');
      list.style.removeProperty('right');
      list.style.removeProperty('top');
      list.style.removeProperty('bottom');
      list.style.removeProperty('width');
      list.style.removeProperty('max-height');
      list.style.removeProperty('visibility');
    }
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
    this.schedulePendingResourceProductRender();
  }

  private closeDockVariantSelects(except?: HTMLElement): void {
    for (const root of this.shadowRoot.querySelectorAll<HTMLElement>('.dock-variant-select')) {
      if (root === except) continue;
      this.closeDockVariantSelect(root);
    }
  }

  private selectDockVariantOption(option: HTMLElement): void {
    if (this.resourceProductsStale || (option instanceof HTMLButtonElement && option.disabled))
      return;
    const root = option.closest<HTMLElement>('.dock-variant-select');
    const card = option.closest<HTMLElement>('.dock-product');
    const product = this.resourceSnapshot.products.find(
      (candidate) => this.dockProductKey(candidate) === card?.dataset.productId,
    );
    const kind = option.dataset.variantKind;
    const selectedValue = option.dataset.value;
    if (!root || !card || !product || !selectedValue) return;
    const groups = this.dockProductQualityGroups(product);
    let quality: MediaDockProductQualityView | undefined;
    if (kind === 'resolution') {
      const group = groups.find((candidate) => candidate.key === selectedValue);
      const currentChoice = groups
        .flatMap((candidate) => candidate.choices)
        .find((choice) => this.dockQualityKey(choice.quality) === card.dataset.qualityId);
      quality =
        group?.choices.find((choice) => choice.codecLabel === currentChoice?.codecLabel)?.quality ??
        group?.choices[0]?.quality;
    } else if (kind === 'quality') {
      quality = product.qualities?.find(
        (candidate) => this.dockQualityKey(candidate) === selectedValue,
      );
    }
    if (quality && quality.token && (quality.completeAvailable || quality.videoOnlyAvailable)) {
      this.rememberDockQualitySelection(product, quality);
      this.applyDockProductQuality(card, product, quality);
    }
    this.closeDockVariantSelect(root, true);
  }

  private hideProductMenu(card: HTMLElement, menu: HTMLElement, trigger: HTMLElement): void {
    try {
      menu.hidePopover?.();
    } catch {
      // It is safe to continue when a detached or fallback menu is already closed.
    }
    menu.hidden = true;
    delete menu.dataset.open;
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.style.removeProperty('max-height');
    menu.style.removeProperty('max-width');
    menu.style.removeProperty('visibility');
    delete card.dataset.menuOpen;
    trigger.setAttribute('aria-expanded', 'false');
    this.schedulePendingResourceProductRender();
  }

  private async downloadResourceProduct(
    productKey: string,
    mode: MediaProductCardDownloadMode,
    qualityKey?: string,
  ): Promise<void> {
    if (this.resourceDownloadingProductId) return;
    if (!this.onResourceProductDownload) {
      this.resourceActionError = uiText('E1212');
      this.renderResourceSnapshot();
      return;
    }
    const product = this.resourceSnapshot.products.find(
      (candidate) => this.dockProductKey(candidate) === productKey,
    );
    if (!product) {
      this.resourceActionError = uiText('E1213');
      this.renderResourceSnapshot();
      return;
    }
    const quality = qualityKey
      ? product.qualities?.find((candidate) => this.dockQualityKey(candidate) === qualityKey)
      : undefined;
    const intended = this.resourceQualitySelections.has(this.productQualityPreferenceKey(product))
      ? this.selectedDockQuality(product)
      : undefined;
    const unavailableVideo =
      mode !== 'audio' &&
      ((qualityKey != null && !quality) ||
        (intended != null &&
          (!intended.token ||
            !quality ||
            this.dockQualityKey(intended) !== this.dockQualityKey(quality))));
    const option = this.dockProductOptions(product).find((candidate) => candidate.mode === mode);
    if (
      this.resourceProductsStale ||
      unavailableVideo ||
      !option ||
      !this.dockProductOptionAvailable(option, quality)
    ) {
      this.resourceActionError = UNAVAILABLE_DOCK_QUALITY;
      this.renderResourceSnapshot();
      return;
    }
    const grantToken = this.dockProductGrantToken(product);
    this.resourceDownloadingProductId = productKey;
    this.resourceActionError = undefined;
    this.closeProductMenus();
    this.renderResourceSnapshot();
    try {
      if (quality && mode !== 'audio')
        await this.onResourceProductDownload(grantToken, mode, quality.token);
      else await this.onResourceProductDownload(grantToken, mode);
    } catch (error) {
      this.resourceActionError = error instanceof Error ? error.message : uiText('E1214');
    } finally {
      this.resourceDownloadingProductId = undefined;
      this.renderResourceSnapshot();
    }
  }

  private ensureMounted(): void {
    if (!this.host.isConnected) this.doc.documentElement.append(this.host);
  }

  private readonly handleColorSchemeChange = (): void => {
    if (this.themeMode === 'auto') this.applyTheme();
  };

  private readonly handleDocumentPointerDown = (event: Event): void => {
    if (event.composedPath().includes(this.host)) return;
    this.closeProductMenus();
    this.closeDockVariantSelects();
  };

  private readonly handleDockScroll = (): void => {
    this.scheduleDockLayout();
  };

  private readonly handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (this.mergeReturnConfirmationOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!this.mergeReturnPending) this.setMergeReturnConfirmationVisible(false, true);
      } else if (event.key === 'Tab') {
        const buttons = [
          ...this.shadowRoot.querySelectorAll<HTMLButtonElement>(
            '[data-role="merge-return-confirm"] button:not(:disabled)',
          ),
        ];
        const index = buttons.indexOf(this.shadowRoot.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
      return;
    }
    if (event.key === 'Escape' && this.tooltipButton) {
      this.hideTooltip();
      event.preventDefault();
      return;
    }
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    if (launcher) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.setLauncherPreview(false);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.setLauncherPreview(false);
        this.restoreMinimizedView();
        return;
      }
    }
    if (
      this.handleTabKeyDown(event) ||
      this.handleDockVariantKeyDown(event) ||
      this.handleProductMenuKeyDown(event)
    ) {
      return;
    }
    if (event.key !== 'Escape') return;
    if (this.mergePathPickerOpen) {
      event.preventDefault();
      this.setMergePathPickerVisible(false, true);
      return;
    }
    const confirmation = this.shadowRoot.querySelector<HTMLElement>('[data-role="close-confirm"]');
    if (confirmation && !confirmation.hidden) {
      this.setCloseConfirmationVisible(false);
    } else {
      this.closeTargetList();
    }
  };

  private handleTabKeyDown(event: KeyboardEvent): boolean {
    const tab =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[role="tab"]')
        : null;
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const tablist = tab.parentElement;
    if (!tablist?.matches('[role="tablist"]')) return false;
    const tabs = [...tablist.children].filter(
      (child): child is HTMLButtonElement =>
        child instanceof HTMLButtonElement && child.matches('[role="tab"]:not(:disabled)'),
    );
    if (tabs.length === 0) return false;
    event.preventDefault();
    const index = Math.max(0, tabs.indexOf(tab));
    const next =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs.at(-1)
          : event.key === 'ArrowLeft'
            ? tabs[(index - 1 + tabs.length) % tabs.length]
            : tabs[(index + 1) % tabs.length];
    next?.click();
    next?.focus();
    return true;
  }

  private handleProductMenuKeyDown(event: KeyboardEvent): boolean {
    const element = event.target instanceof Element ? event.target : null;
    const trigger = element?.closest<HTMLElement>('[data-action="toggle-product-menu"]');
    if (trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        this.toggleProductMenu(trigger, event.key === 'ArrowUp');
      } else {
        const items = [
          ...(trigger
            .closest('.dock-product')
            ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
        ].filter((item) => !item.hidden);
        (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
      }
      return true;
    }

    const menuItem = element?.closest<HTMLButtonElement>('.dock-product-option');
    if (menuItem) {
      const card = menuItem.closest<HTMLElement>('.dock-product');
      const items = [
        ...(card?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
      ].filter((item) => !item.hidden);
      if (event.key === 'Tab') {
        this.closeProductMenus();
        return false;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeProductMenus();
        card?.querySelector<HTMLElement>('[data-action="toggle-product-menu"]')?.focus();
        return true;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length > 0) {
        event.preventDefault();
        const index = Math.max(0, items.indexOf(menuItem));
        const next =
          event.key === 'Home'
            ? items[0]
            : event.key === 'End'
              ? items.at(-1)
              : event.key === 'ArrowUp'
                ? items[(index - 1 + items.length) % items.length]
                : items[(index + 1) % items.length];
        next?.focus();
        return true;
      }
    }

    if (event.key === 'Escape') {
      const openCard = this.shadowRoot.querySelector<HTMLElement>(
        '.dock-product[data-menu-open="true"]',
      );
      if (openCard) {
        event.preventDefault();
        this.closeProductMenus();
        openCard.querySelector<HTMLElement>('[data-action="toggle-product-menu"]')?.focus();
        return true;
      }
    }
    return false;
  }

  private handleDockVariantKeyDown(event: KeyboardEvent): boolean {
    const element = event.target instanceof Element ? event.target : null;
    const trigger = element?.closest<HTMLButtonElement>('[data-action="toggle-variant-select"]');
    if (trigger && (event.key === 'Escape' || event.key === 'Tab')) {
      const root = trigger.closest<HTMLElement>('.dock-variant-select');
      if (root) this.closeDockVariantSelect(root, event.key === 'Escape');
      if (event.key === 'Escape') event.preventDefault();
      return event.key === 'Escape';
    }
    if (trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        this.toggleDockVariantSelect(trigger, event.key === 'ArrowUp');
      } else {
        const items = [
          ...(trigger
            .closest('.dock-variant-select')
            ?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []),
        ];
        (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
      }
      return true;
    }

    const option = element?.closest<HTMLButtonElement>('.dock-variant-option');
    if (!option) return false;
    const root = option.closest<HTMLElement>('.dock-variant-select');
    const items = [
      ...(root?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []),
    ];
    if (event.key === 'Tab') {
      if (root) this.closeDockVariantSelect(root);
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (root) this.closeDockVariantSelect(root, true);
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      option.click();
      return true;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length > 0) {
      event.preventDefault();
      const index = Math.max(0, items.indexOf(option));
      const next =
        event.key === 'Home'
          ? items[0]
          : event.key === 'End'
            ? items.at(-1)
            : event.key === 'ArrowUp'
              ? items[(index - 1 + items.length) % items.length]
              : items[(index + 1) % items.length];
      next?.focus();
      return true;
    }
    return false;
  }

  private applyTheme(): void {
    const dark =
      this.themeMode === 'dark' || (this.themeMode === 'auto' && this.colorScheme.matches);
    this.host.dataset.theme = dark ? 'dark' : 'light';
  }

  private toggleTargetList(): void {
    const list = this.shadowRoot.querySelector<HTMLElement>('[data-role="target-list"]');
    const trigger = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-action="toggle-target-list"]',
    );
    if (!list || !trigger) return;
    const opening = list.hidden;
    list.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const picker = trigger.closest<HTMLElement>('.target-picker');
      const viewport = this.getViewportBounds();
      const triggerRect = trigger.getBoundingClientRect();
      const listHeight = Math.min(
        176,
        Math.max(list.scrollHeight, list.getBoundingClientRect().height),
      );
      const below = Math.max(0, viewport.bottom - DOCK_VIEWPORT_MARGIN - triggerRect.bottom - 5);
      const above = Math.max(0, triggerRect.top - viewport.top - DOCK_VIEWPORT_MARGIN - 5);
      if (picker) picker.dataset.placement = below < listHeight && above > below ? 'top' : 'bottom';
      list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }

  private closeTargetList(): void {
    const list = this.shadowRoot.querySelector<HTMLElement>('[data-role="target-list"]');
    const trigger = this.shadowRoot.querySelector<HTMLElement>(
      '[data-action="toggle-target-list"]',
    );
    if (list) list.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  }

  private setCloseConfirmationVisible(visible: boolean): void {
    const layer = this.shadowRoot.querySelector<HTMLElement>('[data-role="close-confirm"]');
    if (!layer) return;
    layer.hidden = !visible;
    if (visible) {
      this.cancelTransport();
      this.hideTooltip();
      this.view.setTimeout(() => {
        layer.querySelector<HTMLButtonElement>('[data-action="cancel-hide"]')?.focus();
      }, 0);
    }
  }

  private setMergeReturnConfirmationVisible(visible: boolean, restoreFocus = false): void {
    this.mergeReturnConfirmationOpen = visible;
    const layer = this.shadowRoot.querySelector<HTMLElement>('[data-role="merge-return-confirm"]');
    if (!layer) return;
    layer.hidden = !visible;
    const panel = this.shadowRoot.querySelector('.panel');
    for (const child of panel?.children ?? []) {
      if (child instanceof HTMLElement && child !== layer) child.inert = visible;
    }
    if (visible) {
      this.cancelTransport();
      this.hideTooltip();
      this.setMergePathPickerVisible(false);
      layer.querySelector<HTMLButtonElement>('[data-action="continue-merge"]')?.focus();
    } else if (restoreFocus) {
      this.shadowRoot.querySelector<HTMLButtonElement>('[data-action="back-from-merge"]')?.focus();
    }
  }

  private async returnFromMerge(confirmed = false): Promise<void> {
    const view = this.mergeDockView;
    if (this.mergeReturnPending) return;
    if (!view || view.state === 'completed' || view.state === 'cancelled') {
      this.finishMergeReturn();
      return;
    }
    const needsConfirmation =
      view.returnRequiresConfirmation ??
      (view.busy ||
        this.mergeActionPending ||
        ['preparing', 'running', 'permission_required', 'cancelling'].includes(view.state));
    if (needsConfirmation && !confirmed) {
      this.setMergeReturnConfirmationVisible(true);
      return;
    }
    if (view.cancelEnabled === false && !needsConfirmation) {
      this.finishMergeReturn();
      return;
    }
    const route = siteMediaRouteKey(this.doc.URL);
    const token = view.actionToken;
    const identity = this.mergeViewIdentity(view);
    const sequence = ++this.mergeReturnSequence;
    const isCurrent = () =>
      sequence === this.mergeReturnSequence &&
      route === siteMediaRouteKey(this.doc.URL) &&
      this.mergeViewIdentity(this.mergeDockView) === identity;
    this.mergeReturnPending = true;
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    try {
      if (!this.onMergeDockAction) throw new Error(uiText('E1215'));
      // This promise is a settled backend cancellation, not a message ACK.
      await this.onMergeDockAction(token, 'cancel');
      if (!isCurrent()) return;
      this.finishMergeReturn();
    } catch (error) {
      if (
        isCurrent() &&
        (this.mergeDockView?.state === 'completed' || this.mergeDockView?.state === 'cancelled')
      ) {
        this.finishMergeReturn();
      } else if (isCurrent()) {
        this.mergeActionError = error instanceof Error ? error.message : uiText('E1216');
      }
    } finally {
      if (isCurrent()) {
        this.mergeReturnPending = false;
        this.renderMergeSnapshot();
      }
    }
  }

  private finishMergeReturn(): void {
    this.mergeReturnSequence += 1;
    this.mergeReturnPending = false;
    this.setMergeReturnConfirmationVisible(false);
    this.mergeDockView = undefined;
    this.mergeOperationSequence += 1;
    this.mergeActionPending = false;
    this.mergePendingAction = undefined;
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    if (this.minimizedView?.mode === 'merge')
      this.minimizedView = { ...this.minimizedView, mode: 'resources', scroll: 0 };
    if (this.mode === 'merge') this.openResources('regular');
  }

  private mergeViewIdentity(view: MergeDockView | undefined): string | undefined {
    return view?.snapshot
      ? `${view.snapshot.taskKey}:${view.snapshot.mediaEpoch}`
      : view?.actionToken;
  }

  private defaultMergeDockPath(view = this.mergeDockView): string {
    if (view?.pathMode === 'automatic' && view.savePath.trim()) return view.savePath;
    const platform = floatingMediaPlatform(this.doc.location.hostname).kind;
    return `Downloads/FoxFetch/${platform === 'generic' ? 'web' : platform === 'bilibili' ? 'Bilibili' : platform === 'youtube' ? 'YouTube' : platform}`;
  }

  private setMergePathPickerVisible(visible: boolean, restoreFocus = false): void {
    this.mergePathPickerOpen = visible;
    if (!visible) this.mergePathPickerError = undefined;
    this.renderMergePathPicker();
    if (visible) {
      this.view.setTimeout(() => {
        const selected = this.shadowRoot.querySelector<HTMLButtonElement>(
          '.merge-path-choice[aria-pressed="true"]:not([data-step-hidden])',
        );
        (
          selected ??
          this.shadowRoot.querySelector<HTMLButtonElement>(
            '.merge-path-choice:not(:disabled):not([data-step-hidden])',
          )
        )?.focus();
      }, 0);
    } else if (restoreFocus) {
      this.view.setTimeout(
        () =>
          this.shadowRoot
            .querySelector<HTMLButtonElement>('[data-merge-action="change-path"]')
            ?.focus(),
        0,
      );
    }
  }

  private renderMergePathPicker(): void {
    const layer = this.shadowRoot.querySelector<HTMLElement>('[data-role="merge-path-picker"]');
    if (!layer) return;
    layer.hidden = !this.mergePathPickerOpen;
    updateMediaLocationLayout(layer);
    layer.setAttribute('aria-busy', String(this.mergeActionPending));
    const view = this.mergeDockView;
    const selectedMode = view?.savePreferenceMode ?? view?.pathMode ?? 'automatic';
    const remembered = layer.querySelector<HTMLButtonElement>('[data-path-mode="remembered"]');
    if (remembered) {
      remembered.hidden = !view?.rememberedDirectory;
      setText(
        remembered.querySelector('[data-role="merge-remembered-path"]'),
        view?.rememberedDirectory?.name ?? '',
      );
      remembered.title = view?.rememberedDirectory?.available ? uiText('E1217') : uiText('E1218');
    }
    const defaultPath = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-default-path"]',
    );
    const customPath = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-custom-path"]',
    );
    setText(defaultPath, this.defaultMergeDockPath(view));
    setText(
      customPath,
      view?.pathMode === 'custom' || view?.pathMode === 'ask'
        ? view.savePath || uiText('E1219')
        : uiText('E1220'),
    );
    for (const choice of layer.querySelectorAll<HTMLButtonElement>('.merge-path-choice')) {
      const active = choice.dataset.pathMode === selectedMode;
      choice.setAttribute('aria-pressed', String(active));
      choice.disabled =
        !view ||
        this.mergeActionPending ||
        view.busy ||
        !this.onMergeDockPathModeChange ||
        (choice.dataset.pathMode === 'remembered' && !view.rememberedDirectory?.available);
    }
    const error = layer.querySelector<HTMLElement>('[data-role="merge-path-picker-error"]');
    setText(error, sanitizeMergeDiagnosticText(this.mergePathPickerError) ?? '');
    if (error) error.hidden = !this.mergePathPickerError;
  }

  private setPlaybackError(message?: string): void {
    this.playbackErrorMessage = message;
    const error = this.shadowRoot.querySelector<HTMLElement>('[data-role="playback-error"]');
    setText(error, messageText(message ?? ''));
    if (error) error.hidden = !message;
  }

  private cancelRateDraft(): void {
    if (this.rateTimer != null) this.view.clearTimeout(this.rateTimer);
    this.rateTimer = undefined;
    this.rateDraft = undefined;
    this.ratePointerId = undefined;
    this.ratePending = false;
    this.rateRequestSequence += 1;
  }

  private readonly handleRateInput = (event: Event): void => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.dataset.role === 'cache-filename') {
      this.cacheFilenameDraft = {
        value: input.value,
        route: siteMediaRouteKey(this.doc.URL),
        hookGeneration: this.cacheSnapshot.hookGeneration,
        groupId: this.cacheSnapshot.boundGroupId,
      };
      this.cacheCapture?.setFilename(input.value);
      return;
    }
    if (!(input instanceof HTMLInputElement) || input.dataset.role !== 'rate-slider') return;
    this.cancelTransport();
    this.hideTooltip();
    const rate = Number(input.value);
    if (!Number.isFinite(rate)) return;
    this.rateDraft = clamp(rate, 0.1, 16);
    this.ratePending = true;
    this.rateRequestSequence += 1;
    setText(
      this.shadowRoot.querySelector('[data-role="current-rate"]'),
      formatRate(this.rateDraft),
    );
    input.setAttribute('aria-valuetext', formatRate(this.rateDraft));
    if (this.rateTimer != null) this.view.clearTimeout(this.rateTimer);
    this.rateTimer = this.view.setTimeout(() => {
      this.rateTimer = undefined;
      void this.commitRate();
    }, 80);
  };

  private async commitRate(): Promise<void> {
    if (this.rateTimer != null) this.view.clearTimeout(this.rateTimer);
    this.rateTimer = undefined;
    const rate = this.rateDraft;
    if (rate == null) return;
    const sequence = ++this.rateRequestSequence;
    const identity = this.transportIdentity;
    const elementId = this.selectedElementId;
    this.ratePending = true;
    try {
      // The engine revokes temporary leases synchronously before applying an explicit rate.
      const result = await this.manager.execute(
        {
          action: 'setRate',
          rate,
          lockRate: this.settings.lockRate,
          preservesPitch: this.settings.preservesPitch,
        },
        elementId,
      );
      if (sequence !== this.rateRequestSequence || identity !== this.transportIdentity) return;
      this.setPlaybackError(result.applied ? undefined : uiText('E1223'));
    } catch (error) {
      if (sequence === this.rateRequestSequence && identity === this.transportIdentity)
        this.setPlaybackError(error instanceof Error ? error.message : uiText('E1224'));
    } finally {
      if (sequence === this.rateRequestSequence && identity === this.transportIdentity) {
        this.ratePending = false;
        if (this.ratePointerId == null) this.rateDraft = undefined;
        this.update(this.manager.getMediaElements());
      }
    }
  }

  private tooltipTarget(event: Event): HTMLButtonElement | undefined {
    return event.target instanceof Element
      ? (event.target.closest<HTMLButtonElement>('.transport button') ?? undefined)
      : undefined;
  }

  private hideTooltip(): void {
    if (this.tooltipTimer != null) this.view.clearTimeout(this.tooltipTimer);
    this.tooltipTimer = undefined;
    this.tooltipButton?.removeAttribute('aria-describedby');
    this.tooltipButton = undefined;
    const tooltip = this.shadowRoot.querySelector<HTMLElement>('.transport-tooltip');
    if (tooltip) {
      try {
        tooltip.hidePopover?.();
      } catch {
        /* An unopened popover has no top-layer state. */
      }
      tooltip.hidden = true;
    }
  }

  private renderTooltip(): void {
    const button = this.tooltipButton;
    const tooltip = this.shadowRoot.querySelector<HTMLElement>('.transport-tooltip');
    if (!button || !tooltip || button.disabled || this.transportPointer || this.mode !== 'playback')
      return;
    const action = button.dataset.mediaAction;
    tooltip.textContent =
      action === 'seek-back'
        ? uiText('E1225')
        : action === 'seek-forward'
          ? uiText('E1226')
          : button.getAttribute('aria-label');
    tooltip.hidden = false;
    try {
      tooltip.showPopover?.();
    } catch {
      /* Fixed positioning is the legacy fallback. */
    }
    button.setAttribute('aria-describedby', tooltip.id);
    const anchor = button.getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const viewport = this.getViewportBounds();
    tooltip.style.left = `${Math.round(clamp(anchor.left + (anchor.width - rect.width) / 2, viewport.left + 10, viewport.right - rect.width - 10))}px`;
    const top = anchor.top - rect.height - 8;
    tooltip.style.top = `${Math.round(clamp(top >= viewport.top + 10 ? top : anchor.bottom + 8, viewport.top + 10, viewport.bottom - rect.height - 10))}px`;
  }

  private readonly handleTooltipOver = (event: Event): void => {
    const button = this.tooltipTarget(event);
    if (
      !button ||
      button === this.tooltipButton ||
      (event instanceof PointerEvent && event.pointerType === 'touch')
    )
      return;
    this.hideTooltip();
    if (button.disabled || this.transportPointer || this.dragPointerId != null) return;
    this.tooltipButton = button;
    this.tooltipTimer = this.view.setTimeout(() => {
      this.tooltipTimer = undefined;
      this.renderTooltip();
    }, TRANSPORT_TOOLTIP_DELAY_MS);
  };

  private readonly handleTooltipFocus = (event: Event): void => {
    const button = this.tooltipTarget(event);
    if (!button || !button.matches(':focus-visible')) return;
    this.hideTooltip();
    this.tooltipButton = button;
    this.renderTooltip();
  };

  private readonly handleTooltipOut = (event: Event): void => {
    const button = this.tooltipTarget(event);
    const related = (event as FocusEvent).relatedTarget;
    if (button && related instanceof Node && button.contains(related)) return;
    if (button === this.tooltipButton) this.hideTooltip();
  };

  private cancelTransport(): void {
    if (this.transportTimer != null) this.view.clearTimeout(this.transportTimer);
    this.transportTimer = undefined;
    const pointer = this.transportPointer;
    this.transportPointer = undefined;
    pointer?.button.removeAttribute('data-holding');
    if (pointer) this.suppressTransportClick = pointer.button;
    if (this.manager.hasTemporaryTransport())
      void this.manager.endTemporaryTransport().catch(() => undefined);
    const suspended = this.suspendedTransportGuard;
    this.suspendedTransportGuard = undefined;
    if (
      suspended &&
      suspended.guard === this.autoAdvanceGuard &&
      suspended.identity === this.transportIdentity
    ) {
      suspended.guard.setEnabled(this.preventAutoAdvanceEnabled);
      suspended.guard.arm();
      suspended.guard.observe({ cacheComplete: this.cacheSnapshot.isComplete });
      if (suspended.reason && this.preventAutoAdvanceEnabled)
        suspended.guard.lockTerminal(suspended.reason);
    }
    this.syncBufferTailLoop();
  }

  private readonly handleTransportContextMenu = (event: Event): void => {
    const button = this.tooltipTarget(event);
    if (!button || !['seek-back', 'seek-forward'].includes(button.dataset.mediaAction ?? ''))
      return;
    event.preventDefault();
    event.stopPropagation();
    this.hideTooltip();
    this.cancelTransport();
    if (button.disabled || this.navigationPending) return;
    this.animateTransportFeedback(button);
    this.navigationPending = true;
    const identity = this.transportIdentity;
    // Only an explicit navigation gesture retires the old capture guard. Cached bytes remain intact.
    this.releaseAutoAdvanceGuard();
    this.autoAdvanceBindingRetired = true;
    void navigateVideo(
      this.doc,
      button.dataset.mediaAction === 'seek-back' ? 'previous' : 'next',
      (target) => {
        if (this.mode !== 'playback') return;
        this.navigationPanelSettledEpoch = undefined;
        this.navigationPanelIntent?.begin(target);
        this.scheduleNavigationPanelExpiry();
      },
    )
      .then((result) => {
        if (!result.applied) this.navigationPanelIntent?.clear();
        if (identity !== this.transportIdentity) return;
        this.setPlaybackError(result.applied ? undefined : result.reason || uiText('E1227'));
        if (!result.applied) {
          this.autoAdvanceBindingRetired = false;
          this.syncAutoAdvanceGuard();
        }
      })
      .catch(() => {
        this.navigationPanelIntent?.clear();
        if (identity !== this.transportIdentity) return;
        this.setPlaybackError(uiText('E1228'));
        this.autoAdvanceBindingRetired = false;
        this.syncAutoAdvanceGuard();
      })
      .finally(() => {
        this.navigationPending = false;
        // Keep the Agent-admitted snapshot during route transitions.
        this.update(this.mediaElements);
      });
  };

  private scheduleNavigationPanelExpiry(): void {
    if (this.navigationPanelTimer != null) this.view.clearTimeout(this.navigationPanelTimer);
    this.navigationPanelTimer = this.view.setTimeout(() => {
      this.navigationPanelTimer = undefined;
      this.navigationPanelIntent?.clear();
      this.update(this.mediaElements);
    }, 12_000);
  }

  private animateTransportFeedback(button: HTMLButtonElement): void {
    if (!button.animate || this.view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const current = this.view.getComputedStyle(button).transform;
    this.transportFeedback.get(button)?.cancel();
    const animation = button.animate(
      [
        { transform: current === 'none' ? 'scale(1)' : current },
        { transform: 'scale(.94)', offset: 0.22 },
        { transform: 'scale(1.035)', offset: 0.7 },
        { transform: 'scale(1)' },
      ],
      { duration: 250, easing: 'ease-out' },
    );
    this.transportFeedback.set(button, animation);
    void animation.finished.then(
      () => {
        if (this.transportFeedback.get(button) === animation) this.transportFeedback.delete(button);
      },
      () => undefined,
    );
  }

  private readonly handleNativeDragStart = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('.launcher, .head'))
      event.preventDefault();
  };

  private readonly handleInteractionBlur = (): void => {
    this.hideTooltip();
    this.cancelTransport();
    if (this.rateDraft != null) {
      this.ratePointerId = undefined;
      void this.commitRate();
    }
    this.cancelDrag();
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.doc.visibilityState === 'hidden') this.handleInteractionBlur();
  };

  private syncBufferTailLoop(): void {
    if (
      !this.bufferTailEnabled ||
      this.bufferTailBinding !== this.cacheControlIdentity() ||
      this.transportPointer != null ||
      this.manager.hasTemporaryTransport() ||
      this.cacheSnapshot.status !== 'capturing' ||
      this.cacheSnapshot.isComplete ||
      this.autoAdvanceGuard?.getSnapshot().state === 'terminal-lock'
    ) {
      this.clearBufferTailTimer();
      return;
    }
    if (this.bufferTailTimer != null) return;
    this.bufferTailTimer = this.view.setTimeout(() => {
      this.bufferTailTimer = undefined;
      void this.manager
        .execute({ action: 'seekToBufferedEnd', safetyMargin: 1.25 }, this.selectedElementId)
        .finally(() => this.syncBufferTailLoop());
    }, 350);
  }

  private clearBufferTailTimer(): void {
    if (this.bufferTailTimer == null) return;
    this.view.clearTimeout(this.bufferTailTimer);
    this.bufferTailTimer = undefined;
  }

  private syncAutoAdvanceGuard(): void {
    const captureSessionActive = [
      'starting',
      'capturing',
      'paused',
      'ready',
      'downloading',
    ].includes(this.cacheSnapshot.status);
    if (!captureSessionActive) {
      this.releaseAutoAdvanceGuard();
      this.autoAdvanceBindingRetired = false;
      return;
    }
    if (this.transportPointer && this.suspendedTransportGuard?.guard === this.autoAdvanceGuard)
      return;

    const guardSnapshot = this.autoAdvanceGuard?.getSnapshot();
    const target = guardSnapshot
      ? this.mediaElements.find(
          (element) =>
            element.elementId === guardSnapshot.elementId &&
            element.lifecycleGeneration === guardSnapshot.lifecycleGeneration,
        )
      : (this.mediaElements.find((element) => element.elementId === this.selectedElementId) ??
        this.mediaElements[0]);
    if (!target) {
      if (this.autoAdvanceGuard) {
        this.releaseAutoAdvanceGuard();
        this.autoAdvanceBindingRetired = true;
      }
      return;
    }

    if (!this.autoAdvanceGuard && !this.autoAdvanceBindingRetired) {
      const element = this.manager.getControlledMediaElement(
        target.elementId,
        target.lifecycleGeneration,
      );
      if (!element) return;
      this.autoAdvanceGuard = createAutoAdvanceGuard(
        {
          element,
          elementId: target.elementId,
          lifecycleGeneration: target.lifecycleGeneration,
        },
        { enabled: this.preventAutoAdvanceEnabled },
      );
      this.autoAdvanceGuard.arm();
    }

    this.autoAdvanceGuard?.setEnabled(this.preventAutoAdvanceEnabled);
    this.autoAdvanceGuard?.arm();
    this.autoAdvanceGuard?.observe({
      cacheComplete: this.cacheSnapshot.isComplete,
    });
  }

  private releaseAutoAdvanceGuard(): void {
    this.suspendedTransportGuard = undefined;
    this.autoAdvanceGuard?.release();
    this.autoAdvanceGuard = undefined;
  }

  private cacheControlIdentity(): string {
    return [
      this.transportIdentity,
      this.cacheSnapshot.routeKey,
      this.cacheSnapshot.hookGeneration,
      this.cacheSnapshot.boundGroupId,
    ].join('\u0000');
  }

  private readonly handleChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.role === 'cache-auto-download') {
      this.cacheCapture?.setAutoDownload(target.checked);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.role === 'cache-buffer-tail') {
      this.bufferTailEnabled = target.checked;
      this.bufferTailBinding = this.cacheControlIdentity();
      this.syncBufferTailLoop();
      return;
    }
    if (
      target instanceof HTMLInputElement &&
      target.dataset.role === 'cache-prevent-auto-advance'
    ) {
      this.preventAutoAdvanceEnabled = target.checked;
      this.autoAdvanceGuard?.setEnabled(target.checked);
      this.syncAutoAdvanceGuard();
      this.syncBufferTailLoop();
      return;
    }
    if (
      target instanceof HTMLInputElement &&
      target.dataset.role === 'cache-clear-after-download'
    ) {
      this.cacheCapture?.setClearAfterDownload(target.checked);
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.role === 'cache-filename') {
      this.cacheCapture?.setFilename(target.value);
      this.cacheFilenameDraft = undefined;
      return;
    }
    if (target instanceof HTMLInputElement && target.dataset.role === 'rate-slider') {
      if (this.rateDraft == null) this.handleRateInput(event);
      void this.commitRate();
    }
  };

  private readonly handleClick = (event: Event): void => {
    const summary =
      event.target instanceof Element
        ? event.target.closest('details[data-animated-disclosure] > summary')
        : null;
    if (summary?.parentElement instanceof HTMLDetailsElement) {
      event.preventDefault();
      this.disclosureAnimator.toggle(summary.parentElement);
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(
            '[data-action], [data-media-action], [data-cache-action], [data-merge-action]',
          )
        : null;
    if (!target) {
      this.closeProductMenus();
      this.closeDockVariantSelects();
      return;
    }
    const action = target.dataset.action;
    if (action !== 'toggle-product-menu' && action !== 'download-product') {
      this.closeProductMenus();
    }
    if (action !== 'toggle-variant-select' && action !== 'select-variant-option') {
      this.closeDockVariantSelects();
    }
    if (action === 'launcher') {
      if (this.didDrag) {
        this.didDrag = false;
        return;
      }
      this.setLauncherPreview(false);
      this.restoreMinimizedView();
      return;
    }
    if (action === 'collapse') {
      this.closeTargetList();
      this.collapse();
      return;
    }
    if (action === 'request-hide') {
      this.closeTargetList();
      this.setCloseConfirmationVisible(true);
      return;
    }
    if (action === 'cancel-hide') {
      this.setCloseConfirmationVisible(false);
      return;
    }
    if (action === 'confirm-hide') {
      this.setCloseConfirmationVisible(false);
      this.hide();
      return;
    }
    if (action === 'cancel-merge-path') {
      this.setMergePathPickerVisible(false, true);
      return;
    }
    if (action === 'select-merge-path') {
      const mode = target.dataset.pathMode;
      if (mode === 'automatic' || mode === 'ask') {
        void this.selectMergeDockPathMode(mode);
      }
      return;
    }
    if (action === 'toggle-target-list') {
      this.toggleTargetList();
      return;
    }
    if (action === 'select-target') {
      this.cancelTransport();
      this.cancelRateDraft();
      const elementId = target.dataset.elementId || undefined;
      const selected = this.mediaElements.find((element) => element.elementId === elementId);
      this.explicitSelection = selected
        ? {
            elementId: selected.elementId,
            lifecycleGeneration: selected.lifecycleGeneration,
            routeKey: siteMediaRouteKey(this.doc.URL),
          }
        : undefined;
      this.selectedElementId = selected?.elementId;
      this.closeTargetList();
      this.update(this.manager.getMediaElements());
      return;
    }
    if (action === 'open-playback') {
      this.openPlayback();
      return;
    }
    if (action === 'back-from-merge') {
      void this.returnFromMerge();
      return;
    }
    if (action === 'continue-merge') {
      if (!this.mergeReturnPending) this.setMergeReturnConfirmationVisible(false, true);
      return;
    }
    if (action === 'confirm-merge-return') {
      void this.returnFromMerge(true);
      return;
    }
    if (action === 'copy-merge-diagnostics') {
      const text =
        sanitizeMergeDiagnosticText(
          this.shadowRoot.querySelector('[data-role="merge-diagnostic-text"]')?.textContent ?? '',
        ) ?? '';
      void this.view.navigator.clipboard?.writeText(text).catch(() => {
        target.textContent = uiText('E1229');
      });
      return;
    }
    if (action === 'open-resources' || action === 'open-regular-download') {
      this.openResources('regular');
      return;
    }
    if (action === 'refresh-resources') {
      this.refreshResources();
      return;
    }
    if (action === 'toggle-variant-select') {
      this.toggleDockVariantSelect(target);
      return;
    }
    if (action === 'select-variant-option') {
      this.selectDockVariantOption(target);
      return;
    }
    if (action === 'toggle-product-menu') {
      this.toggleProductMenu(target);
      return;
    }
    if (action === 'download-product') {
      const productId = target.dataset.productId;
      const downloadMode = target.dataset.downloadMode;
      if (productId && isProductDownloadMode(downloadMode)) {
        void this.downloadResourceProduct(productId, downloadMode, target.dataset.qualityId);
      }
      return;
    }
    if (action === 'open-cache') {
      this.openCache();
      const snapshot = this.cacheCapture?.getSnapshot();
      if (
        snapshot &&
        (snapshot.status === 'idle' ||
          (snapshot.status === 'error' && snapshot.capturedBytes === 0))
      ) {
        void this.cacheCapture?.requestStart().catch(() => undefined);
      }
      return;
    }

    const mergeAction = target.dataset.mergeAction;
    if (mergeAction === 'change-path') {
      this.setMergePathPickerVisible(true);
      return;
    }
    if (mergeAction === 'cancel') {
      void this.cancelMergeDockTask();
      return;
    }
    if (mergeAction === 'merge' || mergeAction === 'separate') {
      void this.executeMergeDockAction(mergeAction);
      return;
    }

    const cacheAction = target.dataset.cacheAction;
    if (cacheAction) {
      if (!this.cacheCapture) return;
      if (cacheAction === 'download') {
        void this.cacheCapture.downloadCaptured(true).catch(() => undefined);
      }
      if (cacheAction === 'reset-reload') {
        void this.cacheCapture.requestResetAndReload().catch(() => undefined);
      }
      if (cacheAction === 'toggle-capture') {
        if (this.cacheSnapshot.status === 'paused') this.cacheCapture.resume();
        else if (this.cacheSnapshot.status === 'capturing') this.cacheCapture.pause();
      }
      return;
    }

    const mediaAction = target.dataset.mediaAction;
    if (!mediaAction) return;
    this.hideTooltip();
    if (this.suppressTransportClick === target && event instanceof MouseEvent && event.detail > 0) {
      this.suppressTransportClick = undefined;
      event.preventDefault();
      return;
    }
    this.cancelTransport();
    if (target instanceof HTMLButtonElement && target.closest('.playback-foot'))
      this.animateTransportFeedback(target);
    if (mediaAction === 'restore-rate') {
      this.cancelRateDraft();
      this.rateDraft = 1;
      void this.commitRate();
      return;
    }
    if (target instanceof HTMLButtonElement && target.closest('.transport'))
      this.animateTransportFeedback(target);
    const command =
      mediaAction === 'toggle-play'
        ? ({ action: 'togglePlay' } as const)
        : mediaAction === 'seek-back'
          ? ({ action: 'seekBy', seconds: -15 } as const)
          : mediaAction === 'seek-forward'
            ? ({ action: 'seekBy', seconds: 15 } as const)
            : mediaAction === 'mute'
              ? ({ action: 'toggleMute' } as const)
              : mediaAction === 'pip'
                ? ({ action: 'togglePictureInPicture' } as const)
                : undefined;
    if (command) void this.execute(command);
  };

  private readonly handleLauncherPointerOver = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.pointerType === 'touch') return;
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    if (!launcher) return;
    const related = event.relatedTarget;
    if (related && launcher.contains(related as Node)) return;
    this.scheduleLauncherPreview(true, LAUNCHER_PREVIEW_DELAY_MS);
  };

  private readonly handleLauncherPointerOut = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.pointerType === 'touch') return;
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    if (!launcher) return;
    const related = event.relatedTarget;
    if (related && launcher.contains(related as Node)) return;
    this.scheduleLauncherPreview(false, LAUNCHER_PREVIEW_CLOSE_DELAY_MS);
  };

  private readonly handleLauncherFocusIn = (event: Event): void => {
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    if (launcher) this.setLauncherPreview(true);
  };

  private readonly handleLauncherFocusOut = (event: Event): void => {
    if (!(event instanceof FocusEvent)) return;
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    if (!launcher) return;
    const related = event.relatedTarget;
    if (related && launcher.contains(related as Node)) return;
    this.setLauncherPreview(false);
  };

  private readonly handlePointerDown = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return;
    this.hideTooltip();
    const transport = this.tooltipTarget(event);
    const mediaAction = transport?.dataset.mediaAction;
    if (transport && (mediaAction === 'seek-back' || mediaAction === 'seek-forward')) {
      if (event.button !== 0 || transport.disabled) return;
      this.cancelTransport();
      this.suppressTransportClick = undefined;
      const pointer = {
        id: event.pointerId,
        button: transport,
        direction: mediaAction === 'seek-back' ? ('backward' as const) : ('forward' as const),
        identity: this.transportIdentity,
        holding: false,
      };
      this.transportPointer = pointer;
      this.clearBufferTailTimer();
      transport.setPointerCapture?.(event.pointerId);
      this.transportTimer = this.view.setTimeout(() => {
        this.transportTimer = undefined;
        if (this.transportPointer !== pointer || pointer.identity !== this.transportIdentity)
          return;
        pointer.holding = true;
        transport.dataset.holding = 'true';
        const guard = this.autoAdvanceGuard;
        const guardSnapshot = guard?.getSnapshot();
        if (guard && guardSnapshot) {
          this.suspendedTransportGuard = {
            guard,
            identity: this.transportIdentity,
            reason: guardSnapshot.terminalReason,
          };
          guard.setEnabled(false);
        }
        void this.manager
          .beginTemporaryTransport(pointer.direction, this.selectedElementId)
          .then((result) => {
            if (this.transportPointer !== pointer || pointer.identity !== this.transportIdentity)
              return;
            this.setPlaybackError(result.applied ? undefined : result.reason || uiText('E1230'));
            this.update(this.manager.getMediaElements());
          })
          .catch(() => {
            if (this.transportPointer === pointer) {
              this.cancelTransport();
              this.setPlaybackError(uiText('E1231'));
            }
          });
      }, TRANSPORT_HOLD_DELAY_MS);
      return;
    }
    if (
      event.target instanceof HTMLInputElement &&
      event.target.dataset.role === 'rate-slider' &&
      event.button === 0
    ) {
      this.cancelTransport();
      this.ratePointerId = event.pointerId;
      event.target.setPointerCapture?.(event.pointerId);
      return;
    }
    const launcher =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.launcher') : null;
    const header =
      event.target instanceof Element ? event.target.closest<HTMLElement>('.head') : null;
    const interactive =
      event.target instanceof Element
        ? event.target.closest(
            'button, input, a, select, textarea, [contenteditable="true"], .head-actions',
          )
        : null;
    if (event.button !== 0 || (!launcher && (!header || interactive))) return;
    this.cancelTransport();
    this.positionMutation += 1;
    this.dragPointerId = event.pointerId;
    this.dragTarget = launcher ? 'launcher' : 'panel';
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    // The launcher and expanded panel are two representations of one dock.
    // Dragging either representation therefore translates the same anchor.
    this.dragOriginX = this.launcherX;
    this.dragOriginY = this.launcherY;
    if (header && !launcher) {
      const panel = this.shadowRoot.querySelector<HTMLElement>('.panel');
      if (panel) {
        // Complete an in-flight OPEN animation once. Do not toggle animation:
        // none while dragging: restoring that rule restarts the scale-in on release.
        for (const animation of panel.getAnimations?.() ?? []) {
          if ((animation as CSSAnimation).animationName === 'panel-open') animation.finish();
        }
        this.panelDragOrigin = {
          left: Number.parseFloat(panel.style.left) || 0,
          top: Number.parseFloat(panel.style.top) || 0,
        };
      }
    }
    this.didDrag = false;
    this.clearLauncherPreviewTimer();
    if (event.pointerType === 'touch') this.setLauncherPreview(false);
    (launcher ?? header)?.setPointerCapture?.(event.pointerId);
  };

  private readonly handlePointerMove = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.pointerId !== this.dragPointerId) return;
    const deltaX = event.clientX - this.dragStartX;
    const deltaY = event.clientY - this.dragStartY;
    if (!this.didDrag && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) return;
    this.didDrag = true;
    this.setLauncherPreview(false);
    if (this.dragTarget === 'launcher') {
      this.launcherX = this.dragOriginX + deltaX;
      this.launcherY = this.dragOriginY + deltaY;
      this.clampLauncherPosition();
      this.applyLauncherPosition();
      this.host.dataset.dragging = 'true';
    } else if (this.panelDragOrigin) {
      this.host.dataset.panelDragging = 'true';
      // Translate the visible panel, not a hidden launcher whose expansion
      // direction would flip and jump when crossing the viewport midpoint.
      this.panelDragPosition = {
        left: this.panelDragOrigin.left + deltaX,
        top: this.panelDragOrigin.top + deltaY,
      };
      this.applyPanelPosition();
      this.positionOpenProductMenu();
      this.positionOpenDockVariantList();
    }
    event.preventDefault();
  };

  private readonly handlePointerUp = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return;
    if (event.pointerId === this.ratePointerId) {
      this.ratePointerId = undefined;
      void this.commitRate();
      return;
    }
    const transport = this.transportPointer;
    if (transport && event.pointerId === transport.id) {
      const shortPress = !transport.holding && transport.identity === this.transportIdentity;
      this.cancelTransport();
      if (shortPress)
        void this.execute({
          action: 'seekBy',
          seconds: transport.direction === 'forward' ? 15 : -15,
        });
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = undefined;
    delete this.host.dataset.dragging;
    delete this.host.dataset.panelDragging;
    const dragTarget = this.dragTarget;
    this.dragTarget = undefined;
    this.panelDragOrigin = undefined;
    const panelPosition = this.panelDragPosition;
    this.panelDragPosition = undefined;
    if (!this.didDrag) return;
    const viewport = this.getViewportBounds();
    if (dragTarget === 'panel') {
      const panel = this.shadowRoot.querySelector<HTMLElement>('.panel');
      const width =
        panel?.offsetWidth ||
        panel?.getBoundingClientRect().width ||
        Math.min(410, viewport.width - DOCK_VIEWPORT_MARGIN * 2);
      this.launcherEdge =
        (panelPosition?.left ?? this.launcherX) + width / 2 < viewport.left + viewport.width / 2
          ? 'left'
          : 'right';
      this.didDrag = false;
    } else {
      this.launcherEdge =
        this.launcherX + LAUNCHER_SIZE / 2 < viewport.left + viewport.width / 2 ? 'left' : 'right';
    }
    this.launcherX =
      this.launcherEdge === 'left'
        ? viewport.left + LAUNCHER_MARGIN
        : Math.max(
            viewport.left + LAUNCHER_MARGIN,
            viewport.right - LAUNCHER_SIZE - LAUNCHER_MARGIN,
          );
    this.clampLauncherPosition();
    this.applyLauncherPosition();
    if (dragTarget === 'panel') {
      this.applyPanelPosition();
      this.positionOpenProductMenu();
      this.positionOpenDockVariantList();
    }
    this.capturePositionAnchor('edge');
    void this.persistPosition();
  };

  private cancelDrag(): void {
    if (this.dragPointerId == null) return;
    const cancelledLauncher = this.dragTarget === 'launcher';
    this.dragPointerId = undefined;
    this.dragTarget = undefined;
    this.panelDragOrigin = undefined;
    this.panelDragPosition = undefined;
    delete this.host.dataset.dragging;
    delete this.host.dataset.panelDragging;
    this.didDrag = cancelledLauncher;
    // A cancelled drag has no committed user position.
    this.resolvePositionAnchor();
    this.applyLauncherPosition();
    this.applyPanelPosition();
    this.positionOpenProductMenu();
    this.positionOpenDockVariantList();
  }

  private readonly handlePointerCancel = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return;
    if (event.pointerId === this.transportPointer?.id) this.cancelTransport();
    if (event.pointerId === this.ratePointerId) {
      this.ratePointerId = undefined;
      void this.commitRate();
    }
    if (event.pointerId === this.dragPointerId) this.cancelDrag();
    this.hideTooltip();
  };

  private readonly handleResize = (): void => {
    if (this.settingsFrame) {
      this.applyPanelPosition();
      return;
    }
    this.hideTooltip();
    if (this.dragPointerId == null) this.resolvePositionAnchor();
    else this.clampLauncherPosition();
    this.applyLauncherPosition();
    if (
      this.mode === 'playback' ||
      this.mode === 'resources' ||
      this.mode === 'cache' ||
      this.mode === 'merge'
    ) {
      this.applyPanelPosition();
    }
    this.positionOpenProductMenu();
    this.positionOpenDockVariantList();
  };

  private applyLauncherPosition(): void {
    const launcher = this.shadowRoot.querySelector<HTMLElement>('.launcher');
    if (!launcher) return;
    launcher.style.left = `${Math.round(this.launcherX)}px`;
    launcher.style.top = `${Math.round(this.launcherY)}px`;
    this.host.dataset.launcherEdge = this.launcherEdge;
    const viewport = this.getViewportBounds();
    const availableInward =
      this.launcherEdge === 'left'
        ? viewport.right - this.launcherX - LAUNCHER_MARGIN
        : this.launcherX + LAUNCHER_SIZE - viewport.left - LAUNCHER_MARGIN;
    launcher.style.setProperty(
      '--launcher-preview-width',
      `${Math.max(LAUNCHER_SIZE, Math.min(LAUNCHER_PREVIEW_WIDTH, availableInward))}px`,
    );
  }

  private clampLauncherPosition(): void {
    const viewport = this.getViewportBounds();
    this.launcherX = clamp(
      this.launcherX,
      viewport.left + LAUNCHER_MARGIN,
      viewport.right - LAUNCHER_SIZE - LAUNCHER_MARGIN,
    );
    this.launcherY = clamp(
      this.launcherY,
      viewport.top + LAUNCHER_MARGIN,
      viewport.bottom - LAUNCHER_SIZE - LAUNCHER_MARGIN,
    );
  }

  /** The saved anchor expresses user intent; viewport clamps never rewrite it. */
  private resolvePositionAnchor(): void {
    const viewport = this.getViewportBounds();
    const anchor = this.positionAnchor;
    this.launcherEdge = anchor.edge;
    const xRange = Math.max(1, viewport.width - LAUNCHER_SIZE);
    const yRange = Math.max(1, viewport.height - LAUNCHER_SIZE);
    this.launcherX =
      anchor.mode === 'free'
        ? viewport.left + clamp(anchor.xRatio, 0, 1) * xRange
        : anchor.edge === 'left'
          ? viewport.left + (anchor.inset ?? LAUNCHER_MARGIN)
          : viewport.right - LAUNCHER_SIZE - (anchor.inset ?? LAUNCHER_MARGIN);
    this.launcherY = viewport.top + clamp(anchor.yRatio, 0, 1) * yRange;
    this.clampLauncherPosition();
  }

  private capturePositionAnchor(mode: 'edge' | 'free'): void {
    const viewport = this.getViewportBounds();
    this.positionAnchor = {
      version: 2,
      mode,
      edge: this.launcherEdge,
      inset:
        this.launcherEdge === 'left'
          ? this.launcherX - viewport.left
          : viewport.right - LAUNCHER_SIZE - this.launcherX,
      xRatio: clamp(
        (this.launcherX - viewport.left) / Math.max(1, viewport.width - LAUNCHER_SIZE),
        0,
        1,
      ),
      yRatio: clamp(
        (this.launcherY - viewport.top) / Math.max(1, viewport.height - LAUNCHER_SIZE),
        0,
        1,
      ),
    };
    this.positionMutation += 1;
  }

  private applyPanelPosition(): void {
    const panel = this.shadowRoot.querySelector<HTMLElement>('.panel');
    if (!panel) return;
    const viewport = this.getViewportBounds();
    const availableWidth = Math.max(1, viewport.width - DOCK_VIEWPORT_MARGIN * 2);
    const availableHeight = Math.max(1, viewport.height - DOCK_VIEWPORT_MARGIN * 2);
    const panelRect = panel.getBoundingClientRect();
    const panelWidth = Math.min(
      panel.offsetWidth || panelRect.width || Math.min(410, availableWidth),
      availableWidth,
    );
    const panelHeight = Math.min(
      panel.offsetHeight ||
        panelRect.height ||
        panel.scrollHeight ||
        Math.min(410, availableHeight),
      availableHeight,
    );
    const preferLeft = this.launcherX + LAUNCHER_SIZE / 2 > viewport.left + viewport.width / 2;
    const left =
      this.panelDragPosition?.left ??
      (preferLeft ? this.launcherX + LAUNCHER_SIZE - panelWidth : this.launcherX);
    const top = this.panelDragPosition?.top ?? this.launcherY + LAUNCHER_SIZE - panelHeight;
    const clampedLeft = clamp(
      left,
      viewport.left + DOCK_VIEWPORT_MARGIN,
      viewport.right - panelWidth - DOCK_VIEWPORT_MARGIN,
    );
    const clampedTop = clamp(
      top,
      viewport.top + DOCK_VIEWPORT_MARGIN,
      viewport.bottom - panelHeight - DOCK_VIEWPORT_MARGIN,
    );
    panel.style.left = `${Math.round(clampedLeft)}px`;
    panel.style.top = `${Math.round(clampedTop)}px`;
    if (this.panelDragPosition) {
      this.panelDragPosition = { left: clampedLeft, top: clampedTop };
      this.launcherX =
        this.launcherEdge === 'left' ? clampedLeft : clampedLeft + panelWidth - LAUNCHER_SIZE;
      this.launcherY = clampedTop + panelHeight - LAUNCHER_SIZE;
      this.clampLauncherPosition();
      this.applyLauncherPosition();
    }
    panel.style.setProperty('--origin-x', `${this.launcherX + LAUNCHER_SIZE / 2 - clampedLeft}px`);
    panel.style.setProperty('--origin-y', `${this.launcherY + LAUNCHER_SIZE / 2 - clampedTop}px`);
  }

  private getViewportBounds(): ViewportBounds {
    const left = this.visualViewport?.offsetLeft ?? 0;
    const top = this.visualViewport?.offsetTop ?? 0;
    const width = Math.max(1, this.visualViewport?.width ?? this.view.innerWidth);
    const height = Math.max(1, this.visualViewport?.height ?? this.view.innerHeight);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  private positionOpenProductMenu(): void {
    const menu = this.shadowRoot.querySelector<HTMLElement>('.dock-product-menu[data-open="true"]');
    const trigger = menu
      ?.closest<HTMLElement>('.dock-product')
      ?.querySelector<HTMLElement>('[data-action="toggle-product-menu"]');
    if (menu && trigger) this.positionProductMenu(trigger, menu);
  }

  private positionOpenDockVariantList(): void {
    const list = this.shadowRoot.querySelector<HTMLElement>('.dock-variant-list[data-open="true"]');
    const root = list?.closest<HTMLElement>('.dock-variant-select');
    if (root) this.positionDockVariantList(root);
  }

  /** Anchor a top-layer quality list to its trigger without any clipping ancestor. */
  private positionDockVariantList(root: HTMLElement): void {
    const trigger = root.querySelector<HTMLButtonElement>('.dock-variant-trigger');
    const list = root.querySelector<HTMLElement>('.dock-variant-list');
    if (!trigger || !list || list.hidden || list.dataset.open !== 'true') return;
    const viewport = this.getViewportBounds();
    const triggerRect = trigger.getBoundingClientRect();
    const gap = 4;
    const viewportTop = viewport.top + DOCK_VIEWPORT_MARGIN;
    const viewportBottom = viewport.bottom - DOCK_VIEWPORT_MARGIN;
    const maxWidth = Math.max(1, viewport.width - DOCK_VIEWPORT_MARGIN * 2);
    const width = Math.min(Math.max(1, triggerRect.width), maxWidth);
    list.style.position = 'fixed';
    list.style.right = 'auto';
    list.style.bottom = 'auto';
    list.style.width = `${Math.floor(width)}px`;
    list.style.removeProperty('max-height');
    const naturalHeight = list.scrollHeight || list.getBoundingClientRect().height || 1;
    const below = Math.max(0, viewportBottom - triggerRect.bottom - gap);
    const above = Math.max(0, triggerRect.top - gap - viewportTop);
    const minimumUsefulHeight = Math.min(naturalHeight, 148);
    const placeBelow = below >= minimumUsefulHeight || below >= above;
    const maxHeight = Math.max(1, placeBelow ? below : above);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const left = clamp(
      triggerRect.left,
      viewport.left + DOCK_VIEWPORT_MARGIN,
      viewport.right - DOCK_VIEWPORT_MARGIN - width,
    );
    const top = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - renderedHeight;
    root.dataset.placement = placeBelow ? 'bottom' : 'top';
    list.style.left = `${Math.round(left)}px`;
    list.style.top = `${Math.round(clamp(top, viewportTop, viewportBottom - renderedHeight))}px`;
    list.style.maxHeight = `${Math.floor(maxHeight)}px`;
  }

  private positionProductMenu(trigger: HTMLElement, menu: HTMLElement): void {
    if (menu.hidden || menu.dataset.open !== 'true') return;
    const viewport = this.getViewportBounds();
    const triggerRect = trigger.getBoundingClientRect();
    menu.style.removeProperty('max-height');
    const maxWidth = Math.max(1, viewport.width - DOCK_VIEWPORT_MARGIN * 2);
    menu.style.maxWidth = `${Math.floor(maxWidth)}px`;
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = Math.min(menuRect.width || menu.offsetWidth || 300, maxWidth);
    const naturalHeight = menu.scrollHeight || menuRect.height || menu.offsetHeight || 1;
    const viewportTop = viewport.top + DOCK_VIEWPORT_MARGIN;
    const viewportRight = viewport.right - DOCK_VIEWPORT_MARGIN;
    const viewportBottom = viewport.bottom - DOCK_VIEWPORT_MARGIN;
    const availableBelow = Math.max(0, viewportBottom - triggerRect.bottom - PRODUCT_MENU_GAP);
    const availableAbove = Math.max(0, triggerRect.top - PRODUCT_MENU_GAP - viewportTop);
    const minimumUsefulHeight = Math.min(naturalHeight, 180);
    const placeBelow = availableBelow >= minimumUsefulHeight || availableBelow >= availableAbove;
    const maxHeight = Math.max(1, placeBelow ? availableBelow : availableAbove);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const preferredLeft = triggerRect.right - menuWidth;
    const left = clamp(
      preferredLeft,
      viewport.left + DOCK_VIEWPORT_MARGIN,
      viewportRight - menuWidth,
    );
    const top = placeBelow
      ? triggerRect.bottom + PRODUCT_MENU_GAP
      : triggerRect.top - PRODUCT_MENU_GAP - renderedHeight;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(clamp(top, viewportTop, viewportBottom - renderedHeight))}px`;
    menu.style.maxHeight = `${Math.floor(maxHeight)}px`;
  }

  private scheduleDockLayout(): void {
    if (this.layoutTimer != null) return;
    this.layoutTimer = this.view.setTimeout(() => {
      this.layoutTimer = undefined;
      if (
        this.mode === 'playback' ||
        this.mode === 'resources' ||
        this.mode === 'cache' ||
        this.mode === 'merge'
      ) {
        this.applyPanelPosition();
      }
      this.positionOpenProductMenu();
      this.positionOpenDockVariantList();
    }, 0);
  }

  private clearLayoutTimer(): void {
    if (this.layoutTimer == null) return;
    this.view.clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
  }

  private async restorePosition(): Promise<void> {
    if (!this.positionStore) return;
    const mutation = this.positionMutation;
    try {
      const stored = await this.positionStore.get(this.positionKey);
      const value = stored[this.positionKey];
      if (!isDockPosition(value) || mutation !== this.positionMutation) return;
      this.positionAnchor = {
        version: 2,
        mode:
          value.version === 2 && value.mode === 'free'
            ? 'free'
            : value.version !== 2 && value.xRatio > 0.05 && value.xRatio < 0.95
              ? 'free'
              : 'edge',
        edge: value.edge,
        inset: Number.isFinite(value.inset)
          ? Math.max(LAUNCHER_MARGIN, value.inset!)
          : LAUNCHER_MARGIN,
        xRatio: value.xRatio,
        yRatio: value.yRatio,
      };
      this.resolvePositionAnchor();
      this.applyLauncherPosition();
      if (
        this.mode === 'playback' ||
        this.mode === 'resources' ||
        this.mode === 'cache' ||
        this.mode === 'merge'
      ) {
        this.applyPanelPosition();
      }
    } catch {
      // Position persistence is optional; a blocked extension context keeps defaults.
    }
  }

  private async persistPosition(): Promise<void> {
    if (!this.positionStore) return;
    const position = { ...this.positionAnchor };
    try {
      await this.positionStore.set({ [this.positionKey]: position });
    } catch {
      // Keep the current in-memory position when storage is unavailable.
    }
  }

  private async executeMergeDockAction(action: MergeDockAction): Promise<void> {
    const view = this.mergeDockView;
    if (!view || this.mergeActionPending || view.busy || !this.onMergeDockAction) return;
    if (action === 'merge' && !view.mergeEnabled) return;
    if (action === 'separate' && !view.separateEnabled) return;
    if (view.saveLocationConfirmationRequired ?? view.pathMode === 'custom') {
      this.setMergePathPickerVisible(true);
      return;
    }
    this.mergeActionPending = true;
    this.mergePendingAction = action === 'separate' ? 'separate' : 'merge';
    const sequence = ++this.mergeOperationSequence;
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    try {
      await this.onMergeDockAction(view.actionToken, action);
    } catch (error) {
      if (sequence === this.mergeOperationSequence)
        this.mergeActionError = error instanceof Error ? error.message : uiText('E1232');
    } finally {
      if (sequence === this.mergeOperationSequence) {
        this.mergeActionPending = false;
        this.mergePendingAction = undefined;
        this.renderMergeSnapshot();
        this.syncMode();
      }
    }
  }

  private async cancelMergeDockTask(): Promise<void> {
    const view = this.mergeDockView;
    if (
      !view?.cancelEnabled ||
      this.mergeActionPending ||
      this.mergeReturnPending ||
      !this.onMergeDockAction
    )
      return;
    const sequence = ++this.mergeOperationSequence;
    this.mergeActionPending = true;
    this.mergeActionError = undefined;
    this.renderMergeSnapshot();
    try {
      await this.onMergeDockAction(view.actionToken, 'cancel');
    } catch (error) {
      if (sequence === this.mergeOperationSequence)
        this.mergeActionError = error instanceof Error ? error.message : uiText('E1233');
    } finally {
      if (sequence === this.mergeOperationSequence) {
        this.mergeActionPending = false;
        this.renderMergeSnapshot();
      }
    }
  }

  private async selectMergeDockPathMode(mode: MergeDockPathChoice): Promise<void> {
    const view = this.mergeDockView;
    if (!view || this.mergeActionPending || view.busy || !this.onMergeDockPathModeChange) return;
    this.mergeActionPending = true;
    this.mergePendingAction = 'path';
    const sequence = ++this.mergeOperationSequence;
    this.mergePathPickerError = undefined;
    this.renderMergeSnapshot();
    try {
      await this.onMergeDockPathModeChange(view.pathToken, mode);
      if (sequence !== this.mergeOperationSequence) return;
      this.setMergePathPickerVisible(false, true);
    } catch (error) {
      if (sequence !== this.mergeOperationSequence) return;
      if (isPathSelectionCancellation(error)) {
        this.setMergePathPickerVisible(false, true);
      } else {
        this.mergePathPickerError = error instanceof Error ? error.message : uiText('E0357');
        this.mergeActionError = this.mergePathPickerError;
        this.setMergePathPickerVisible(false, true);
      }
    } finally {
      if (sequence === this.mergeOperationSequence) {
        this.mergeActionPending = false;
        this.mergePendingAction = undefined;
        this.renderMergeSnapshot();
        this.syncMode();
      }
    }
  }

  private renderMergeSnapshot(): void {
    const view = this.mergeDockView;
    const failure = sanitizeMergeDiagnosticText(
      this.mergeActionError ??
        (view?.state === 'failed' ? (view.error ?? view.status ?? uiText('E1234')) : view?.error),
    );
    const status =
      failure ?? (view?.state === 'completed' ? uiText('E0176') : view?.status) ?? uiText('E1235');
    setText(
      this.shadowRoot.querySelector('[data-role="merge-title"]'),
      view?.title || uiText('E1210'),
    );
    const statusElement = this.shadowRoot.querySelector<HTMLElement>('[data-role="merge-status"]');
    const attention =
      failure ?? (view?.state === 'permission_required' ? view.status || uiText('E1236') : '');
    const failureCode = view?.diagnostics?.reasonCode ?? view?.diagnostics?.errorCode ?? '';
    const shortFailure = /DOLBY|HDR/.test(failureCode)
      ? uiText('E1238')
      : /TIMEOUT/.test(failureCode)
        ? uiText('E1240')
        : failure;
    setText(statusElement, messageText(shortFailure ?? attention));
    if (statusElement) {
      statusElement.hidden = !attention;
    }
    const diagnostics = view?.diagnostics;
    const diagnosticLines = mergeDiagnosticLines(diagnostics, failure, formatTaskBytes);
    setText(
      this.shadowRoot.querySelector('[data-role="merge-diagnostic-text"]'),
      [...new Set(diagnosticLines)].join('\n'),
    );
    const details = this.shadowRoot.querySelector<HTMLDetailsElement>(
      '[data-role="merge-diagnostics"]',
    );
    if (details) {
      if (statusElement) details.querySelector('summary')!.after(statusElement);
      const identity = this.mergeViewIdentity(view) ?? '';
      if (this.mergeDiagnosticsIdentity !== identity) {
        details.open = false;
        this.mergeDiagnosticsIdentity = identity;
      }
      details.hidden = diagnosticLines.length === 0 && !attention;
      details.dataset.attention = attention;
      setText(details.querySelector('summary'), details.open ? uiText('E1134') : uiText('E1135'));
    }
    const returnError = this.shadowRoot.querySelector<HTMLElement>(
      '[data-role="merge-return-error"]',
    );
    setText(returnError, sanitizeMergeDiagnosticText(this.mergeActionError) ?? '');
    if (returnError) returnError.hidden = !this.mergeActionError;
    for (const button of this.shadowRoot.querySelectorAll<HTMLButtonElement>(
      '[data-role="merge-return-confirm"] button',
    ))
      button.disabled = this.mergeReturnPending;
    setText(
      this.shadowRoot.querySelector('[data-action="confirm-merge-return"]'),
      this.mergeReturnPending ? uiText('E1241') : uiText('E1130'),
    );
    const stateElement = this.shadowRoot.querySelector<HTMLElement>(
      '#foxfetch-merge-panel [data-role="merge-state"]',
    );
    const stateLabel = this.shadowRoot.querySelector<HTMLElement>(
      '#foxfetch-merge-panel [data-role="merge-state-label"]',
    );
    const phaseLabel =
      this.mergeReturnPending || view?.state === 'cancelling'
        ? uiText('E1147')
        : view?.state === 'cancelled'
          ? uiText('E1148')
          : failure
            ? uiText('E1242')
            : view?.state === 'completed'
              ? uiText('E0176')
              : view?.state === 'preparing' || !view
                ? view?.diagnostics?.stage || uiText('E1141')
                : view.state === 'permission_required'
                  ? uiText('E1142')
                  : this.mergePendingAction === 'path'
                    ? uiText('E1243')
                    : view.state === 'running'
                      ? ((
                          {
                            get fetching() {
                              return uiText('E0502');
                            },
                            get muxing() {
                              return uiText('E1143');
                            },
                            get saving() {
                              return uiText('E1145');
                            },
                            get verifying() {
                              return uiText('E1144');
                            },
                            get paused() {
                              return uiText('E1138');
                            },
                          } as Record<string, string>
                        )[view.phase ?? ''] ?? uiText('E1146'))
                      : this.mergeActionPending
                        ? uiText('E1244')
                        : '';
    if (stateElement) {
      const state = failure
        ? 'error'
        : !this.mergeActionPending && (view?.state === 'ready' || view?.state === 'completed')
          ? 'ready'
          : view?.phase === 'paused' ||
              view?.state === 'permission_required' ||
              view?.state === 'cancelled'
            ? 'waiting'
            : 'loading';
      const label = messageText(phaseLabel || uiText('E1245'));
      stateElement.dataset.state = state;
      stateElement.setAttribute('aria-label', label);
      stateElement.title = view?.status ? `${label} · ${messageText(view.status)}` : label;
    }
    setText(stateLabel, messageText(phaseLabel));
    if (stateLabel) stateLabel.hidden = !phaseLabel;

    const ratio =
      view?.state === 'preparing' || view?.state === 'permission_required'
        ? null
        : view?.state === 'completed'
          ? 1
          : view?.state === 'ready'
            ? 0
            : view?.progress == null
              ? null
              : clamp(view.progress, 0, 1);
    this.host.dataset.mergeStage = failure
      ? 'failed'
      : view?.state === 'completed'
        ? 'complete'
        : view?.state === 'running' && ['muxing', 'saving', 'verifying'].includes(view.phase ?? '')
          ? 'merge'
          : view?.phase === 'paused'
            ? 'paused'
            : view?.state === 'preparing'
              ? 'preparing'
              : 'download';
    updateMediaTaskProgress(
      this.shadowRoot.querySelector('#foxfetch-merge-panel')!,
      ratio,
      status,
      !failure &&
        view?.phase !== 'paused' &&
        view?.state !== 'permission_required' &&
        view?.state !== 'cancelled',
    );

    setText(
      this.shadowRoot.querySelector('[data-role="merge-path"]'),
      view?.saveLocationConfirmationRequired && !view.busy
        ? uiText('E1246')
        : view?.savePath || 'Downloads/FoxFetch/web',
    );
    setText(
      this.shadowRoot.querySelector('[data-role="merge-path-action"]'),
      view?.pathMode === 'custom' || view?.pathMode === 'ask' ? uiText('E1247') : uiText('E1248'),
    );
    const busy = this.mergeActionPending || this.mergeReturnPending || view?.busy === true;
    const path = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-merge-action="change-path"]',
    );
    if (path) {
      path.disabled = !view || busy || !this.onMergeDockPathModeChange;
      path.setAttribute('aria-label', uiText('E1249'));
    }
    const merge = this.shadowRoot.querySelector<HTMLButtonElement>('[data-merge-action="merge"]');
    if (merge) {
      merge.disabled = !view || busy || !view.mergeEnabled || !this.onMergeDockAction;
      setText(
        merge.querySelector('[data-role="merge-action-label"]'),
        view?.state === 'cancelled' ? uiText('E1250') : uiText('E0033'),
      );
    }
    const separate = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-merge-action="cancel"]',
    );
    if (separate) {
      separate.disabled =
        !view ||
        this.mergeReturnPending ||
        this.mergeActionPending ||
        !view.cancelEnabled ||
        !this.onMergeDockAction ||
        view.state === 'cancelling';
      setText(
        separate.querySelector('span'),
        view?.state === 'cancelling' ? uiText('E1251') : uiText('E0101'),
      );
    }
    this.renderMergePathPicker();
    this.refreshPosterSurfaces();
    this.renderLauncherStatus();
  }

  private renderCacheSnapshot(): void {
    const snapshot = this.cacheSnapshot;
    const draft = this.cacheFilenameDraft;
    if (
      draft &&
      (draft.route !== siteMediaRouteKey(this.doc.URL) ||
        (draft.hookGeneration != null &&
          snapshot.hookGeneration != null &&
          draft.hookGeneration !== snapshot.hookGeneration) ||
        (draft.groupId != null &&
          snapshot.boundGroupId != null &&
          draft.groupId !== snapshot.boundGroupId))
    )
      this.cacheFilenameDraft = undefined;
    this.host.dataset.cacheStatus = snapshot.status;
    const progress = Math.min(100, Math.max(0, (snapshot.progressRatio ?? 0) * 100));
    this.host.style.setProperty('--cache-progress', `${progress}%`);
    this.renderLauncherStatus();
    setText(
      this.shadowRoot.querySelector('[data-role="cache-message"]'),
      messageText(snapshot.message),
    );
    const cachedSeconds = Math.max(0, snapshot.cachedSeconds ?? 0);
    const totalSeconds =
      snapshot.totalSeconds != null && snapshot.totalSeconds > 0
        ? snapshot.totalSeconds
        : undefined;
    setText(
      this.shadowRoot.querySelector('[data-role="cache-time"]'),
      `${formatDuration(cachedSeconds)} / ${totalSeconds == null ? '--:--' : formatDuration(totalSeconds)}`,
    );
    setText(
      this.shadowRoot.querySelector('[data-role="cache-bytes"]'),
      formatMseCacheBytes(snapshot.capturedBytes),
    );
    setText(
      this.shadowRoot.querySelector('[data-role="cache-tracks"]'),
      String(snapshot.trackCount),
    );
    setText(
      this.shadowRoot.querySelector('[data-role="cache-sources"]'),
      String(snapshot.sourceCount),
    );
    const completion = this.shadowRoot.querySelector<HTMLElement>('[data-role="cache-complete"]');
    if (completion) {
      completion.dataset.complete = String(snapshot.isComplete);
      completion.textContent = snapshot.isComplete
        ? uiText('E1252')
        : snapshot.startedAtBeginning
          ? uiText('E1253')
          : uiText('E1108');
    }
    const meter = this.shadowRoot.querySelector<HTMLElement>('[data-role="cache-meter"]');
    if (meter) meter.style.width = `${progress}%`;
    const progressbar = this.shadowRoot.querySelector<HTMLElement>('[role="progressbar"]');
    progressbar?.setAttribute(
      'aria-valuetext',
      uiText('E1254', {
        p1: formatDuration(cachedSeconds),
        p2:
          totalSeconds == null
            ? uiText('E1255')
            : uiText('E1256', { p1: formatDuration(totalSeconds) }),
      }),
    );
    if (totalSeconds != null) {
      progressbar?.setAttribute('aria-valuenow', String(Math.min(cachedSeconds, totalSeconds)));
      progressbar?.setAttribute('aria-valuemax', String(totalSeconds));
    } else {
      progressbar?.removeAttribute('aria-valuenow');
      progressbar?.removeAttribute('aria-valuemax');
    }
    const auto = this.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-auto-download"]',
    );
    if (auto) auto.checked = snapshot.autoDownload;
    const bufferTail = this.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-buffer-tail"]',
    );
    if (bufferTail) {
      bufferTail.checked = this.bufferTailEnabled;
      bufferTail.disabled =
        snapshot.status === 'idle' || snapshot.status === 'blocked_drm' || snapshot.isComplete;
    }
    const preventAutoAdvance = this.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-prevent-auto-advance"]',
    );
    if (preventAutoAdvance) {
      preventAutoAdvance.checked = this.preventAutoAdvanceEnabled;
      preventAutoAdvance.disabled =
        snapshot.status === 'idle' ||
        snapshot.status === 'blocked_drm' ||
        snapshot.status === 'reload_required' ||
        snapshot.status === 'error';
    }
    const clearAfter = this.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-clear-after-download"]',
    );
    if (clearAfter) clearAfter.checked = snapshot.clearAfterDownload;
    const filename = this.shadowRoot.querySelector<HTMLInputElement>(
      '[data-role="cache-filename"]',
    );
    if (
      filename &&
      this.shadowRoot.activeElement !== filename &&
      filename.value !== (this.cacheFilenameDraft?.value ?? snapshot.filename)
    ) {
      filename.value = this.cacheFilenameDraft?.value ?? snapshot.filename;
    }
    setText(
      this.shadowRoot.querySelector('[data-role="cache-track-summary"]'),
      String(snapshot.tracks.length),
    );
    const trackList = this.shadowRoot.querySelector<HTMLElement>('[data-role="cache-track-list"]');
    if (trackList) {
      trackList.replaceChildren();
      if (snapshot.tracks.length === 0) {
        const empty = this.doc.createElement('div');
        empty.className = 'track';
        empty.textContent = uiText('E1257');
        trackList.append(empty);
      } else {
        for (const track of snapshot.tracks) {
          const row = this.doc.createElement('div');
          row.className = 'track';
          const main = this.doc.createElement('span');
          main.className = 'track-main';
          main.title = `${track.groupId} · ${track.id}`;
          main.textContent = `${track.complete ? uiText('E1258') : ''}${track.mime} · ${track.id}`;
          const meta = this.doc.createElement('span');
          meta.className = 'track-meta';
          meta.textContent = formatMseCacheBytes(track.bytes);
          row.append(main, meta);
          trackList.append(row);
        }
      }
    }
    const download = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-cache-action="download"]',
    );
    const canDownload =
      snapshot.capturedBytes > 0 && snapshot.status !== 'blocked_drm' && !snapshot.downloading;
    const mergeLikely = snapshot.canMerge;
    if (download) {
      setText(
        download.querySelector('[data-role="cache-download-label"]'),
        mergeLikely ? uiText('E0084') : uiText('E1113'),
      );
      download.disabled = !canDownload;
    }
    const reset = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-cache-action="reset-reload"]',
    );
    if (reset) reset.disabled = snapshot.downloading;
    const captureToggle = this.shadowRoot.querySelector<HTMLButtonElement>(
      '[data-cache-action="toggle-capture"]',
    );
    if (captureToggle) {
      captureToggle.textContent = snapshot.status === 'paused' ? uiText('E1259') : uiText('E1119');
      captureToggle.disabled =
        snapshot.downloading || (snapshot.status !== 'capturing' && snapshot.status !== 'paused');
    }
    if (this.mode === 'cache') this.syncMode();
  }

  private async execute(command: Parameters<PlaybackManager['execute']>[0]): Promise<void> {
    const identity = this.transportIdentity;
    try {
      const result = await this.manager.execute(command, this.selectedElementId);
      if (identity !== this.transportIdentity) return;
      this.setPlaybackError(result.applied ? undefined : uiText('E1260'));
    } catch (error) {
      if (identity === this.transportIdentity)
        this.setPlaybackError(error instanceof Error ? error.message : uiText('E1261'));
    }
    if (identity === this.transportIdentity) this.update(this.manager.getMediaElements());
  }
}
