import type {
  MergeConfigurationDiagnostic,
  MergeNetworkDiagnostic,
  MergePacketTimelineDiagnostic,
  MergeSourceTimelineDiagnostic,
} from '../modules/merge/types';
import type { YouTubeSelection } from '../modules/youtube/selection';

export type ThemeMode = 'auto' | 'light' | 'dark';

export type MediaKind = 'image' | 'video' | 'audio' | 'playlist';

export type DetectionSource = 'dom' | 'performance' | 'network' | 'link' | 'manifest';

/**
 * Small allowlist of request metadata needed to replay a protected media GET.
 * Cookie is intentionally absent: chrome.downloads supplies current cookies for
 * the target host, so copying cookie values would only increase exposure.
 */
export interface MediaRequestHeaders {
  referer?: string;
  origin?: string;
  authorization?: string;
  accept?: string;
}

export type BilibiliDynamicRange = 'SDR' | 'HDR' | 'Dolby Vision' | 'unknown';
export type BilibiliAudioType = 'AAC' | 'Dolby' | 'FLAC' | 'unknown';

export type BilibiliDynamicRangeEvidenceSource =
  | 'explicit-field'
  | 'quality-number'
  | 'codec'
  | 'initialization-segment'
  | 'official-description'
  | 'default-sdr'
  | 'conflict';

export interface BilibiliDynamicRangeEvidence {
  source: BilibiliDynamicRangeEvidenceSource;
  range: BilibiliDynamicRange;
  /** Sanitized provider value or codec marker; never a media URL. */
  detail?: string;
}

export type BilibiliCapabilitySupport = 'supported' | 'unsupported' | 'unknown';

/**
 * Four independent capability layers. A player menu entry only proves
 * `advertised`; FoxFetch exposes a download only for an actual `delivered`
 * representation. Decode and packet-copy support remain explicit rather than
 * being inferred from account entitlements or a quality label.
 */
export interface BilibiliRepresentationCapabilities {
  advertised: boolean;
  delivered: boolean;
  decodable: BilibiliCapabilitySupport;
  remuxable: BilibiliCapabilitySupport;
}

/**
 * Sanitized identity and display metadata for one real Bilibili media
 * representation. It deliberately contains no page response or credentials.
 */
export interface BilibiliMediaRepresentation {
  provider: 'bilibili';
  bvid?: string;
  cid?: string;
  /** Stable within one BVID/CID even when signed CDN URLs rotate. */
  key: string;
  delivery: 'dash' | 'durl';
  /** Native DASH representation id (normally the same value as qn). */
  id?: number;
  /** Normalized Bilibili quality number. */
  qn?: number;
  /** Native quality alias when the response supplies it separately. */
  quality?: number;
  /** Native Bilibili codec id. */
  codecid?: number;
  /** Normalized RFC 6381 codec list. */
  codecs?: string;
  /** Full primary RFC 6381 codec parameter, preserved without family folding. */
  codecProfile?: string;
  /** Dolby Vision profile parsed from `dvh1.xx` / `dvhe.xx`, when present. */
  dolbyVisionProfile?: number;
  /** Original provider frame-rate expression, for example `60` or `16000/528`. */
  frameRate?: string;
  bandwidth?: number;
  /** Official format description (`new_description`, then `description`). */
  description?: string;
  newDescription?: string;
  displayDescription?: string;
  superscript?: string;
  dynamicRange?: BilibiliDynamicRange;
  dynamicRangeEvidence?: BilibiliDynamicRangeEvidence[];
  capabilities?: BilibiliRepresentationCapabilities;
  audioType?: BilibiliAudioType;
  /** Zero is the provider's preferred base URL; positive values are mirrors. */
  sourceIndex?: number;
}

export interface MediaAsset {
  /** Page-local capability; url is empty, not a fabricated network URL. */
  inlineImage?: { token: string; pageUrl: string; tabId?: number };
  /** Detector-only unresolved player source; never shown as a normal download. */
  presentationRole?: 'unresolved-video';
  id: string;
  url: string;
  pageUrl: string;
  pageTitle: string;
  frameId: number;
  kind: MediaKind;
  detectedBy: DetectionSource[];
  mime?: string;
  extension?: string;
  filename?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  poster?: string;
  requestHeaders?: MediaRequestHeaders;
  representation?: BilibiliMediaRepresentation;
  downloadable: boolean;
  discoveredAt: number;
  /** Last time the browser observed this resource on the network. */
  lastObservedAt?: number;
}

export interface MediaElementInfo {
  elementId: string;
  /** Increments when the same DOM media element begins a new source lifecycle. */
  lifecycleGeneration: number;
  frameId: number;
  kind: 'video' | 'audio';
  title: string;
  sourceUrl?: string;
  poster?: string;
  duration?: number;
  currentTime: number;
  playbackRate: number;
  volume: number;
  paused: boolean;
  /** Optional for snapshots from an older content script. */
  muted?: boolean;
  ended?: boolean;
  width?: number;
  height?: number;
  visibleArea: number;
  lastActiveAt: number;
}

/**
 * Route- and player-scoped identity used to prevent a cache session from
 * surviving a same-document media switch.
 */
export interface ActiveMediaFingerprint {
  routeKey: string;
  mediaEpoch: number;
  elementId: string;
  lifecycleGeneration: number;
  frameId: number;
  kind: 'video' | 'audio';
  title: string;
  sourceUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** Page-owned artwork bound to one admitted player, never a generic scanned image. */
export interface BoundMediaArtwork {
  url: string;
  source: 'page-metadata';
  pageIdentity: string;
  mediaEpoch: number;
  elementId: string;
  lifecycleGeneration: number;
  frameId: number;
  titleKey: string;
  providerIdentity?: string;
}

export interface TabMediaState {
  youtube?: import('../modules/youtube/inspection').YouTubeInspection;
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  scannedAt: number;
  status: 'idle' | 'scanning' | 'ready' | 'error';
  assets: MediaAsset[];
  mediaElements: MediaElementInfo[];
  /** Latest top-frame player generation accepted for this document. */
  mediaEpoch?: number;
  activeMedia?: ActiveMediaFingerprint;
  /** Validated provider-owned identity, e.g. bilibili:BVID:CID. */
  providerIdentity?: string;
  artwork?: BoundMediaArtwork;
  sourceCapture?: SourceCaptureView;
  error?: string;
}

export type SourceCaptureStatus =
  | 'permission_required'
  | 'reload_required'
  | 'waiting_for_playback'
  | 'capturing'
  | 'analyzing'
  | 'resolved'
  | 'failed'
  | 'cancelled';

export interface SourceCaptureView {
  id: string;
  tabId: number;
  blobAssetId: string;
  status: SourceCaptureStatus;
  startedAt: number;
  updatedAt: number;
  observationCount: number;
  candidateCount: number;
  directAssetId?: string;
  videoAssetId?: string;
  audioAssetId?: string;
  message?: string;
  error?: string;
}

export interface PlaybackSettings {
  defaultRate: number;
  lockRate: boolean;
  preservesPitch: boolean;
  seekStep: number;
  showController: boolean;
}

export interface DownloadSettings {
  preference?: 'compatibility' | 'quality' | 'size' | undefined;
  saveAs: boolean;
  concurrentDownloads: number;
  /** @deprecated Fixed to {title}; custom templates are disabled since v0.14.22. */
  filenameTemplate: string;
}

export interface AppSettings {
  uiLanguage?: 'zh-CN' | 'en' | undefined;
  /** Optional for stored settings from before v0.14.0; missing means enabled. */
  youtubeEnabled?: boolean | undefined;
  themeMode: ThemeMode;
  playback: PlaybackSettings;
  download: DownloadSettings;
  autoScanGrantedSites: boolean;
  showAdvancedMedia: boolean;
}

export interface DownloadRecord {
  id: string;
  assetId: string;
  filename: string;
  url: string;
  kind: MediaKind;
  state: 'queued' | 'downloading' | 'complete' | 'interrupted';
  chromeDownloadId?: number;
  requestRuleId?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Background-only ownership; never expose download URLs to the page Dock. */
  owner?: DownloadActivityOwner;
}

export interface DownloadActivityOwner {
  tabId: number;
  pageIdentity: string;
  mediaEpoch: number;
  /** Background-only Chrome document identity, never sent into the page. */
  documentId?: string;
}

export interface DownloadActivityView {
  pageIdentity: string;
  mediaEpoch: number;
  revision: number;
  state: 'idle' | 'preparing' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  activeCount: number;
  updatedAt: number;
}

export interface ActiveTabInfo {
  tabId: number;
  title: string;
  url: string;
}

export interface PlaybackCommandResult {
  applied: boolean;
  actualRate?: number;
}

export type MediaDockMode =
  'hidden' | 'launcher' | 'playback' | 'resources' | 'cache' | 'merge' | 'suppressed';

/** Download choices exposed by the URL-free media card inside the page Dock. */
export type MediaDockProductDownloadMode = 'audio' | 'video' | 'complete';

export interface MediaDockProductOptionView {
  mode: MediaDockProductDownloadMode;
  available?: boolean;
  label?: string;
  detail?: string;
}

/** A URL-free quality choice. `id` is stable; `token` is a one-shot capability. */
export interface MediaDockProductQualityView {
  /** Stable metadata identity used only for UI reconciliation. */
  id?: string;
  token: string;
  label: string;
  detail?: string;
  completeAvailable: boolean;
  videoOnlyAvailable: boolean;
}

/**
 * Sanitized product data sent to a content script. `id`/`renderKey` are stable
 * UI identities. `grantToken` is the short-lived tab-bound capability and is
 * never used as a DOM key.
 */
export interface MediaDockProductView {
  id: string;
  /** Explicit alias for consumers that still receive legacy token-shaped ids. */
  renderKey?: string;
  /** One-shot product capability. Quality-specific actions use quality.token. */
  grantToken?: string;
  title: string;
  domain: string;
  duration?: number;
  selectedQuality?: string;
  /** Reserved until background-issued per-quality capabilities are connected. */
  qualities?: MediaDockProductQualityView[];
  options: MediaDockProductOptionView[];
}

export interface MediaDockResourceSnapshot {
  youtube?: import('../modules/youtube/inspection').YouTubeInspection;
  status: 'idle' | 'loading' | 'ready' | 'error';
  products: MediaDockProductView[];
  /** Page-Agent navigation generation. Optional for v0.7.0 compatibility. */
  navigationEpoch?: number;
  /** Active player generation within the current page route. */
  mediaEpoch?: number;
  /** Monotonic bound-response sequence within one Agent lifetime. */
  sequence?: number;
  /** @deprecated v0.7.0 wire alias; normalized to `sequence` by the page Agent. */
  requestSequence?: number;
  /** URL-free route identity, for example `bilibili:BV...:p=1:cid=...`. */
  pageIdentity?: string;
  revision?: string;
  message?: string;
  error?: string;
}

export interface MergeJobSourceContext {
  pageUrl: string;
  requestHeaders?: MediaRequestHeaders;
}

/** One equivalent CDN location for the exact representation selected by the user. */
export interface MergeJobSourceLocation {
  url: string;
  declaredMimeType?: string;
}

export interface MergeJobSeed {
  /** Logical track ids only; safe to retain after signed source URLs are removed. */
  repeatSelection?: { videoTrackId: string; audioTrackId: string };
  id: string;
  videoUrl: string;
  audioUrl: string;
  /** Same-representation mirrors only; other qualities/codecs must never be mixed in. */
  videoSources?: MergeJobSourceLocation[];
  audioSources?: MergeJobSourceLocation[];
  videoStreamIdentity?: string;
  audioStreamIdentity?: string;
  videoMimeType?: string;
  audioMimeType?: string;
  /** Provider-declared video range carried to the merge preflight fail-closed gate. */
  videoDynamicRange?: BilibiliDynamicRange;
  /** Never upgraded to supported until an output verifier proves metadata preservation. */
  videoDynamicRangeRemuxable?: BilibiliCapabilitySupport;
  /** Current-player poster bound to this job's page/media epoch; kept in session storage only. */
  coverUrl?: string;
  videoContext?: MergeJobSourceContext;
  audioContext?: MergeJobSourceContext;
  title?: string;
  /** Tab and media generation that authorized this job. Never derived from Dock input. */
  ownerTabId?: number;
  ownerPageUrl?: string;
  ownerMediaEpoch?: number;
  createdAt: number;
}

export interface MergeJobCreated {
  jobId: string;
}

export type MergeDockAction = 'merge' | 'separate' | 'cancel';
export type MergeDockPathMode = 'automatic' | 'ask' | 'custom';
/** A UI choice; remembered is resolved to a verified custom policy in the background. */
export type MergeDockPathChoice = MergeDockPathMode | 'remembered';

/**
 * Non-sensitive directory metadata that may cross the content-script boundary.
 * The actual FileSystemDirectoryHandle always remains under the extension origin.
 */
export interface MergeDockDirectorySelection {
  handleId: string;
  name: string;
  selectedAt: number;
}

export interface MergeDirectoryPickerContext {
  platform: string;
  defaultPath: string;
  current?: MergeDockDirectorySelection;
}

export interface MergeDirectoryPickerOpened {
  reused: boolean;
}

/** Public, URL-free phase; lifecycle states take precedence over probe I/O. */
export type MergeDockPhase =
  | 'queued'
  | 'resolving'
  | 'permission_required'
  | 'ready'
  | 'fetching'
  | 'muxing'
  | 'saving'
  | 'verifying'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked_drm';

export interface MergeDockSnapshotIdentity {
  /** Random presentation identity, never a private job/asset id or source URL. */
  taskKey: string;
  mediaEpoch: number;
  revision: number;
}

/**
 * URL-free merge state rendered inside the page Dock. Both tokens are opaque,
 * tab-bound capabilities; neither token is a job id or media asset id.
 */
export interface MergeDockView {
  actionToken: string;
  pathToken: string;
  title: string;
  state:
    | 'preparing'
    | 'permission_required'
    | 'ready'
    | 'running'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
    | 'failed';
  /** Optional only for compatibility with an already-open v0.11.1 Dock. */
  phase?: MergeDockPhase;
  snapshot?: MergeDockSnapshotIdentity;
  status: string;
  progress: number | null;
  savePath: string;
  pathMode: MergeDockPathMode;
  saveLocationConfirmationRequired?: boolean;
  savePreferenceMode?: MergeDockPathMode;
  rememberedDirectory?: { name: string; available: boolean };
  mergeEnabled: boolean;
  separateEnabled: boolean;
  busy: boolean;
  /** Cancellation does not require media permission and resolves only after work has stopped. */
  cancelEnabled?: boolean;
  returnRequiresConfirmation?: boolean;
  /** Public diagnostic values: never raw worker messages, URLs, or private job ids. */
  diagnostics?: {
    stage: string;
    readBytes: number;
    totalBytes: number | null;
    startedAt: number;
    lastProgressAt: number;
    errorCode?: string;
    reasonCode?: string;
    reason?: string;
    taskReference?: string;
    timeline?: MergePacketTimelineDiagnostic;
    sourceTimeline?: MergeSourceTimelineDiagnostic;
    network?: MergeNetworkDiagnostic;
    configuration?: MergeConfigurationDiagnostic;
  };
  error?: string;
}

/**
 * A merge action staged before Chrome displays the optional all-sites access
 * prompt. The background owns the intent so an action-popup closing while the
 * native permission dialog is visible cannot lose the requested operation.
 */
export type MediaAccessIntentAction =
  | {
      kind: 'media-product-merge';
      tabId: number;
      productId: string;
      videoAssetId: string;
      audioAssetId: string;
      videoTrackId?: string;
      qualityId?: string;
      expectedPageUrl: string;
      expectedMediaEpoch: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | {
      kind: 'merge-assets';
      tabId: number;
      videoAssetId: string;
      audioAssetId: string;
      expectedPageUrl: string;
      expectedMediaEpoch: number;
    };

export interface MediaAccessIntent {
  id: string;
  action: MediaAccessIntentAction;
  createdAt: number;
}

export interface MediaAccessIntentStaged {
  intentId: string;
}

export interface MediaAccessIntentResult {
  mode: 'merge';
  jobId: string;
}

/** The three user-facing outputs exposed by an aggregated video card. */
export type MediaProductDownloadMode = 'audio-only' | 'video-only' | 'complete';

export type MediaProductDownloadResult =
  { mode: 'download'; downloads: DownloadRecord[] } | { mode: 'merge'; jobId: string };

export interface SourceCaptureStarted {
  capture: SourceCaptureView;
}

/**
 * A user action persisted before Chrome opens an optional-permission prompt.
 * Every action is bound to the exact tab, route and media generation visible
 * when the user clicked, so a late permission grant cannot act on a new page.
 */
export type PermissionGatedMediaAction =
  | {
      kind: 'download-assets';
      tabId: number;
      assetIds: string[];
      expectedPageUrl: string;
      expectedMediaEpoch: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | {
      kind: 'download-media-product';
      tabId: number;
      productId: string;
      mode: MediaProductDownloadMode;
      videoAssetId: string;
      audioAssetId?: string;
      videoTrackId?: string;
      qualityId?: string;
      expectedPageUrl: string;
      expectedMediaEpoch: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | {
      kind: 'capture-source';
      tabId: number;
      blobAssetId: string;
      expectedPageUrl: string;
      expectedMediaEpoch: number;
      expectedMedia?: ActiveMediaFingerprint;
    };

export interface PermissionGatedMediaIntent {
  id: string;
  action: PermissionGatedMediaAction;
  createdAt: number;
  /** Exact optional permission bundle requested for this operation. */
  permissions?: chrome.permissions.Permissions;
}

export interface PermissionGatedMediaIntentStaged {
  intentId: string;
}

export type PermissionGatedMediaIntentResult =
  | { kind: 'download-assets'; downloads: DownloadRecord[] }
  | { kind: 'download-media-product'; result: MediaProductDownloadResult }
  | { kind: 'capture-source'; result: SourceCaptureStarted };

export type ResolvedSourceDownload =
  { mode: 'download'; downloadCount: number } | { mode: 'merge'; jobId: string };

export type PlaybackCommand =
  | { action: 'setRate'; rate: number; lockRate?: boolean; preservesPitch?: boolean }
  | { action: 'adjustRate'; delta: number }
  | { action: 'resetRate' }
  | { action: 'togglePlay' }
  | { action: 'pause' }
  | { action: 'seekBy'; seconds: number }
  | { action: 'seekTo'; seconds: number; pause?: boolean }
  | { action: 'seekToBufferedEnd'; safetyMargin?: number }
  | { action: 'setVolume'; volume: number }
  | { action: 'toggleMute' }
  | { action: 'togglePictureInPicture' }
  | { action: 'showController' }
  | { action: 'toggleController' };

export type UiRequest =
  | { type: 'GET_INLINE_IMAGE_PREVIEW'; tabId: number; assetId: string; token: string }
  | {
      type: 'OPEN_VIDEO_VIEW';
      tabId: number;
      pageUrl: string;
      mediaEpoch: number;
      target: 'resources' | 'playback';
    }
  | { type: 'OPEN_YOUTUBE_DIRECTORY_PICKER'; tabId?: number; jobId: string; videoId: string }
  | {
      type: 'GET_YOUTUBE_DIRECTORY_TARGET';
      tabId?: number;
      jobId: string;
      videoId: string;
      nonce?: string;
    }
  | {
      type:
        | 'VERIFY_YOUTUBE_DIRECTORY_PICKER'
        | 'CONFIRM_YOUTUBE_DIRECTORY_PICKER'
        | 'CANCEL_YOUTUBE_DIRECTORY_PICKER';
      nonce: string;
    }
  | { type: 'GET_YOUTUBE_SELECTION'; tabId?: number; videoId: string }
  | {
      type: 'SET_YOUTUBE_SELECTION';
      tabId?: number;
      videoId: string;
      draft: import('../modules/youtube/selection-preferences').YouTubeSelectionDraft;
    }
  | { type: 'GET_CURRENT_YOUTUBE_DOWNLOAD'; tabId?: number }
  | { type: 'GET_YOUTUBE_PERMISSION_CAPABILITY'; tabId?: number }
  | {
      type: 'START_YOUTUBE_DOWNLOAD' | 'STAGE_YOUTUBE_DOWNLOAD_PERMISSION';
      permissionToken?: string;
      jobId: string;
      selection: YouTubeSelection;
      tabId?: number;
      saveLocation?: 'browser-default' | 'ask' | 'custom';
      directorySessionId?: string;
    }
  | { type: 'GET_YOUTUBE_DOWNLOAD'; jobId: string; tabId?: number }
  | { type: 'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION'; jobId: string; tabId?: number }
  | { type: 'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION'; jobId: string; tabId?: number }
  | { type: 'RECHECK_YOUTUBE_DOWNLOAD'; jobId: string; tabId?: number }
  | { type: 'RETRY_YOUTUBE_SAVE'; jobId: string; tabId?: number }
  | { type: 'DISCARD_YOUTUBE_SAVE'; jobId: string; tabId?: number }
  | { type: 'CANCEL_YOUTUBE_DOWNLOAD'; jobId: string; tabId?: number }
  | { type: 'OPEN_YOUTUBE_PERMISSIONS'; tabId?: number }
  | { type: 'SCAN_TAB'; tabId?: number; showController?: boolean }
  | { type: 'GET_TAB_STATE'; tabId?: number }
  | { type: 'GET_ACTIVE_TAB' }
  | {
      type: 'DOWNLOAD_ASSETS';
      assetIds: string[];
      tabId?: number;
      expectedPageUrl?: string;
      expectedMediaEpoch?: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | {
      type: 'DOWNLOAD_MEDIA_PRODUCT';
      tabId?: number;
      productId: string;
      mode: MediaProductDownloadMode;
      videoAssetId: string;
      audioAssetId?: string;
      videoTrackId?: string;
      qualityId?: string;
      expectedPageUrl?: string;
      expectedMediaEpoch?: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | { type: 'STAGE_MEDIA_ACCESS_INTENT'; intent: MediaAccessIntent }
  | { type: 'COMMIT_MEDIA_ACCESS_INTENT'; intentId: string }
  | { type: 'CANCEL_MEDIA_ACCESS_INTENT'; intentId: string }
  | { type: 'STAGE_PERMISSION_MEDIA_INTENT'; intent: PermissionGatedMediaIntent }
  | { type: 'COMMIT_PERMISSION_MEDIA_INTENT'; intentId: string }
  | { type: 'CANCEL_PERMISSION_MEDIA_INTENT'; intentId: string }
  | { type: 'GET_MEDIA_DOCK_RESOURCES'; force?: boolean }
  | {
      type: 'DOWNLOAD_MEDIA_DOCK_PRODUCT';
      token: string;
      mode: MediaDockProductDownloadMode;
      /** Opaque, tab-bound quality capability; never a track or asset id. */
      qualityToken?: string;
    }
  | { type: 'RUN_MERGE_DOCK_ACTION'; token: string; action: MergeDockAction }
  | {
      type: 'SET_MERGE_DOCK_PATH_MODE';
      token: string;
      mode: Exclude<MergeDockPathChoice, 'custom'>;
    }
  | { type: 'OPEN_MERGE_DIRECTORY_PICKER'; token: string }
  | { type: 'VERIFY_MERGE_DIRECTORY_PICKER'; sessionId: string }
  | {
      type: 'SET_MERGE_DIRECTORY_TARGET';
      sessionId: string;
      mode: 'automatic' | 'custom';
      directory?: MergeDockDirectorySelection;
    }
  | { type: 'CANCEL_MERGE_DIRECTORY_PICKER'; sessionId: string }
  | { type: 'GET_MERGE_DOCK_VIEW'; token: string }
  | {
      type: 'START_SOURCE_CAPTURE';
      tabId?: number;
      blobAssetId: string;
      expectedPageUrl?: string;
      expectedMediaEpoch?: number;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | { type: 'RELOAD_SOURCE_CAPTURE'; tabId?: number; captureId: string }
  | { type: 'DOWNLOAD_RESOLVED_SOURCE'; tabId?: number; captureId: string }
  | { type: 'CANCEL_SOURCE_CAPTURE'; tabId?: number; captureId: string }
  | {
      type: 'PLAYBACK_COMMAND';
      tabId?: number;
      frameId?: number;
      elementId?: string;
      command: PlaybackCommand;
    }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; patch: Partial<AppSettings>; base?: AppSettings }
  | { type: 'OPEN_SIDE_PANEL'; tabId?: number }
  | {
      type: 'START_MSE_CACHE_CAPTURE';
      tabId?: number;
      frameId?: number;
      expectedPageUrl?: string;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | { type: 'RESET_MSE_CACHE_AND_RELOAD'; tabId?: number; frameId?: number }
  | { type: 'OPEN_OPTIONS'; tabId?: number }
  | { type: 'ISSUE_SETTINGS_FRAME' }
  | { type: 'VERIFY_SETTINGS_FRAME' }
  | { type: 'RELEASE_SETTINGS_FRAME' }
  | { type: 'GET_DOWNLOADS' }
  | { type: 'CLEAR_DOWNLOADS' };

/** Public ownership metadata only; this is not a download capability. */
export interface MediaArtworkIdentityBinding {
  artworkDocumentKey: string;
  pageIdentity: string;
  mediaEpoch: number;
  elementId: string;
  lifecycleGeneration: number;
  providerIdentity: string;
}

export type AgentRequest =
  | { type: 'AGENT_READ_INLINE_IMAGE'; token: string; pageUrl: string; preview: boolean }
  | { type: 'AGENT_SCAN' }
  | { type: 'AGENT_NAVIGATION'; pageUrl: string }
  | {
      type: 'AGENT_OPEN_VIDEO_VIEW';
      pageUrl: string;
      mediaEpoch: number;
      target: 'resources' | 'playback';
    }
  | { type: 'AGENT_PLAYBACK_COMMAND'; elementId?: string; command: PlaybackCommand }
  | {
      type: 'AGENT_START_MSE_CACHE_CAPTURE';
      sessionId: string;
      title: string;
      reason?: string;
      hookSupported?: boolean;
      restartAtBeginning?: boolean;
      expectedPageUrl?: string;
      expectedMedia?: ActiveMediaFingerprint;
    }
  | { type: 'AGENT_SET_MEDIA_DOCK'; mode: MediaDockMode }
  | { type: 'AGENT_OPEN_SETTINGS'; token: string; section?: 'permissions' }
  | { type: 'AGENT_SET_MEDIA_PRODUCTS'; snapshot: MediaDockResourceSnapshot }
  | { type: 'AGENT_BIND_ARTWORK_IDENTITY'; binding: MediaArtworkIdentityBinding }
  | { type: 'AGENT_OPEN_MERGE_DOCK'; view: MergeDockView }
  | { type: 'AGENT_UPDATE_MERGE_DOCK'; view: MergeDockView }
  | { type: 'AGENT_UPDATE_DOWNLOAD_ACTIVITY'; activity: DownloadActivityView }
  | { type: 'AGENT_APPLY_SETTINGS'; settings: AppSettings };

export type AgentEvent =
  | {
      type: 'AGENT_STATE';
      pageUrl: string;
      pageTitle: string;
      assets: MediaAsset[];
      mediaElements: MediaElementInfo[];
      mediaEpoch: number;
      activeMedia?: ActiveMediaFingerprint;
      artwork?: BoundMediaArtwork;
    }
  | {
      /** The top-frame SPA changed media identity; discard route-scoped state first. */
      type: 'AGENT_PAGE_CHANGED';
      pageUrl: string;
      pageTitle: string;
      mediaEpoch: number;
      activeMedia?: ActiveMediaFingerprint;
    }
  | { type: 'AGENT_READY'; pageUrl: string };

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface AgentSnapshot {
  pageUrl: string;
  pageTitle: string;
  assets: MediaAsset[];
  mediaElements: MediaElementInfo[];
  mediaEpoch: number;
  activeMedia?: ActiveMediaFingerprint;
  artwork?: BoundMediaArtwork;
  /** Ephemeral per-Agent owner, never a durable identifier or permission grant. */
  artworkDocumentKey?: string;
}

export type ExtensionEvent =
  | { type: 'TAB_STATE_UPDATED'; state: TabMediaState }
  | { type: 'DOWNLOADS_UPDATED'; downloads: DownloadRecord[] }
  | { type: 'SETTINGS_UPDATED'; settings: AppSettings };
