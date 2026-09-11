import { t as uiText } from '../../shared/i18n';
import { updateLocalizedMarkup, subscribeViewLanguage } from '../../shared/i18n/markup';
import { segmentProgressRatio } from './sources/segment-progress';
import type { YouTubeTaskSnapshot } from './background-task';
import type { YouTubeSelection } from './selection';
import type { ApiResponse, UiRequest } from '../../shared/types';
import { formatYouTubeTaskDiagnostics } from './task-diagnostics';
import { youtubePreparationStages } from './preparation-stage';
import { formatTaskBytes, reliableTaskTotal } from '../../shared/task-bytes';
import { mediaTaskDetailsMarkup } from '../../shared/media-task-details';
import { mediaTaskProgressMarkup, updateMediaTaskProgress } from '../../shared/media-task-progress';
import { startYouTubeDownloadWithPermission } from './permission-download';
import { mediaTaskLocationMarkup } from '../../shared/media-task-location';
import { createMediaTaskSummary } from '../../shared/media-task-summary';
import {
  createMediaLocationDialog,
  updateMediaLocationLayout,
} from '../../shared/media-location-dialog';
import { mediaDownloadIcon, mediaSeparateDownloadIcon } from '../../shared/media-download-icon';
import {
  getMergeDownloadPathPolicy,
  getLastVideoDirectory,
  saveMergeDownloadPathPolicy,
} from '../jobs/path-policy';

interface Session {
  jobId?: string;
  snapshot?: YouTubeTaskSnapshot;
  busy: boolean;
  notice?: string;
}
const sessions = new Map<string, Session>();
const terminal = (snapshot?: YouTubeTaskSnapshot) =>
  !!snapshot &&
  ['complete', 'failed', 'canceled'].includes(snapshot.state) &&
  !snapshot.cleanupPending;
const errors: Record<string, string> = {
  get SABR_PART_TOO_LARGE() {
    return uiText('download.protocolPartLimit');
  },
  get SABR_RESPONSE_TOO_LARGE() {
    return uiText('download.protocolPartLimit');
  },
  get SABR_STORAGE_FULL() {
    return uiText('download.temporaryStorageFull');
  },
  get SABR_BUFFER_LIMIT() {
    return uiText('download.bufferLimit');
  },
  get SABR_WRITE_STALLED() {
    return uiText('download.writeStalled');
  },
  get SESSION_CONTEXT_UNAVAILABLE() {
    return uiText('E1683');
  },
  get SESSION_OBSERVATION_UNAVAILABLE() {
    return uiText('E1684');
  },
  get SESSION_REQUEST_BODY_UNAVAILABLE() {
    return uiText('E1685');
  },
  get SESSION_SOURCE_MISMATCH() {
    return uiText('E1686');
  },
  get SESSION_CONFIG_MISMATCH() {
    return uiText('E1687');
  },
  get SESSION_FORMAT_MISMATCH() {
    return uiText('E1688');
  },
  get SESSION_CLIENT_MISMATCH() {
    return uiText('E1689');
  },
  get SESSION_REQUEST_DECODE_FAILED() {
    return uiText('E1690');
  },
  get SOURCE_PERMISSION_REQUIRED() {
    return uiText('E1691');
  },
  get SESSION_ATTESTATION_REQUIRED() {
    return uiText('E1692');
  },
  get PAGE_IDENTITY_CHANGED() {
    return uiText('E1693');
  },
  get SELECTION_INVALID() {
    return uiText('E1694');
  },
  get SOURCE_UNAVAILABLE() {
    return uiText('E1695');
  },
  get TASK_RECOVERY_PENDING() {
    return uiText('E1696');
  },
  get TASK_INTERRUPTED() {
    return uiText('E1697');
  },
  get TASK_CHECKPOINT_FAILED() {
    return uiText('E1698');
  },
  get SOURCE_ADDRESS_EXPIRED() {
    return uiText('E1699');
  },
  get SOURCE_ADDRESS_REJECTED() {
    return uiText('E1700');
  },
  get SOURCE_HTTP_ERROR() {
    return uiText('E1701');
  },
  get SOURCE_READ_TIMEOUT() {
    return uiText('E1702');
  },
  get SOURCE_READ_FAILED() {
    return uiText('E1703');
  },
  get SABR_NETWORK_FAILED() {
    return uiText('E1704');
  },
  get SABR_INVOCATION_FAILED() {
    return uiText('sabr.invocation');
  },
  get SABR_PERMISSION_REQUIRED() {
    return uiText('E1705');
  },
  get SABR_TIMEOUT() {
    return uiText('E1706');
  },
  get SABR_BODY_INTERRUPTED() {
    return uiText('E1707');
  },
  get SABR_ABORTED() {
    return uiText('E1708');
  },
  get SOURCE_HTTP_429() {
    return uiText('E1709');
  },
  get SOURCE_HTTP_401() {
    return uiText('E1710');
  },
  get SOURCE_HTTP_403() {
    return uiText('E1710');
  },
  get SOURCE_HTTP_410() {
    return uiText('E1710');
  },
  get SOURCE_STORAGE_FULL() {
    return uiText('E1711');
  },
  get SOURCE_STORAGE_FAILED() {
    return uiText('E1712');
  },
  get SOURCE_SIZE_MISMATCH() {
    return uiText('E1713');
  },
  get SOURCE_PARTIAL_RESPONSE() {
    return uiText('E1714');
  },
  get SOURCE_TIMELINE_INCOMPLETE() {
    return uiText('E1715');
  },
  get SOURCE_PACKET_INCOMPLETE() {
    return uiText('E1716');
  },
  get TIMELINE_MISMATCH() {
    return uiText('E1717');
  },
  get OUTPUT_SELECTION_MISMATCH() {
    return uiText('E1718');
  },
  get SELECTION_CHANGED() {
    return uiText('E1719');
  },
  get SAVE_STATUS_UNAVAILABLE() {
    return uiText('E1720');
  },
  get TEMPORARY_CLEANUP_FAILED() {
    return uiText('E1721');
  },
  get SAVE_INCOMPLETE() {
    return uiText('E1722');
  },
  get SAVE_START_FAILED() {
    return uiText('E1723');
  },
  get DOWNLOAD_CANCELED() {
    return uiText('E1724');
  },
};

/** Per-surface task view. Page closure only stops observation, never the task.
 * A missing/ambiguous response keeps the same ID and does not start another save.
 */
export function renderYouTubeTaskControls(
  host: HTMLElement,
  videoId: string,
  options: {
    tabId?: number;
    send?: (message: UiRequest) => Promise<ApiResponse<YouTubeTaskSnapshot | null>>;
    copy?: (text: string) => Promise<void>;
    /** Tests of isolated controls may bypass discovery; production always discovers. */
    restore?: boolean;
    isSourceRefreshing?: () => boolean;
    /** Shared two-button layout, matching the Bilibili task actions. */
    sharedActions?: boolean;
    summaryTitle?: string;
    describeSelection?: (selection: YouTubeSelection) => string;
    onSnapshot?: (snapshot: YouTubeTaskSnapshot | undefined) => void;
    renderSummaryPreview?: (preview: HTMLElement) => void;
    directorySend?: (
      message: UiRequest,
    ) => Promise<ApiResponse<{ sessionId: string; name: string } | { nonce: string } | null>>;
  },
): {
  select: (selection: YouTubeSelection | null, supported: boolean, completeFile?: boolean) => void;
  refresh: () => void;
  selectSeparate: (selection: YouTubeSelection | null, supported: boolean) => void;
} {
  const key = `${options.tabId ?? 'page'}:${videoId}`;
  if (!sessions.has(key) && sessions.size >= 32) {
    for (const [oldKey, old] of sessions)
      if (!old.busy) {
        sessions.delete(oldKey);
        break;
      }
  }
  const full = !sessions.has(key) && sessions.size >= 32;
  const session: Session =
    sessions.get(key) ?? (full ? { busy: true, notice: uiText('E1725') } : { busy: false });
  if (!full) sessions.set(key, session);
  const doc = host.ownerDocument;
  const block = doc.createElement('div');
  block.dataset.youtubeTask = '';
  if (options.sharedActions) {
    const summary = createMediaTaskSummary(doc, options.summaryTitle ?? uiText('E0796'));
    summary.preview.dataset.platform = 'youtube';
    options.renderSummaryPreview?.(summary.preview);
    block.append(summary.root);
  }
  const taskProgress = doc.createElement('div');
  taskProgress.innerHTML = mediaTaskProgressMarkup;
  // The task already has one live status paragraph; do not announce the same state twice.
  const progressDot = taskProgress.querySelector('[data-role="merge-state"]')!;
  progressDot.removeAttribute('role');
  progressDot.setAttribute('aria-hidden', 'true');
  block.append(taskProgress);
  const start = doc.createElement('button');
  start.type = 'button';
  start.dataset.youtubeDownloadStart = '';
  const separate = doc.createElement('button');
  separate.type = 'button';
  separate.dataset.youtubeDownloadSeparate = '';
  separate.innerHTML = `${mediaSeparateDownloadIcon}<span><span data-i18n="E1726">分别下载</span></span>`;
  separate.className = 'cache-button';
  separate.hidden = true;
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = uiText('E0101');
  cancel.dataset.youtubeDownloadCancel = '';
  const settings = doc.createElement('button');
  const recheck = doc.createElement('button');
  recheck.type = 'button';
  recheck.textContent = uiText('E1727');
  let checking = false;
  let saveActionPending = false;
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.textContent = uiText('E1728');
  const discard = doc.createElement('button');
  discard.type = 'button';
  discard.textContent = uiText('E1729');
  settings.type = 'button';
  settings.textContent = uiText('E1730');
  const status = doc.createElement('p');
  status.dataset.youtubeTaskStatus = '';
  const saveProgress = doc.createElement('progress');
  saveProgress.setAttribute('aria-label', uiText('E1731'));
  const saveProgressText = doc.createElement('p');
  const detailsTemplate = doc.createElement('template');
  detailsTemplate.innerHTML = mediaTaskDetailsMarkup;
  const details = detailsTemplate.content.firstElementChild as HTMLDetailsElement;
  details.dataset.youtubeTaskDetails = '';
  const copy = details.querySelector<HTMLButtonElement>('button')!;
  // The YouTube controller owns this action, not the floating Bilibili event delegate.
  copy.removeAttribute('data-action');
  details.removeAttribute('data-role');
  const copyStatus = doc.createElement('span');
  copyStatus.setAttribute('aria-live', 'polite');
  const locationLabel = doc.createElement('label');
  locationLabel.textContent = uiText('E1732');
  const saveLocation = doc.createElement('select');
  for (const [value, label] of [
    ['browser-default', uiText('E1733')],
    ['ask', uiText('E0417')],
    ['custom', uiText('E1734')],
  ]) {
    const option = doc.createElement('option');
    option.value = value!;
    option.textContent = label!;
    saveLocation.append(option);
  }
  locationLabel.append(saveLocation);
  const chooseDirectory = doc.createElement('button');
  chooseDirectory.type = 'button';
  chooseDirectory.textContent = uiText('E1735');
  const directoryStatus = doc.createElement('p');
  directoryStatus.setAttribute('aria-live', 'polite');
  let directoryDraft: { jobId: string; sessionId?: string; name?: string } | undefined;
  let directoryOpening = false;
  let rememberedDirectoryName: string | undefined;
  let locationTouched = false;
  let locationRestoring = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  const locationTemplate = doc.createElement('template');
  locationTemplate.innerHTML = mediaTaskLocationMarkup;
  const locationTrigger = locationTemplate.content.firstElementChild as HTMLButtonElement;
  locationTrigger.removeAttribute('data-merge-action');
  const locationValue = locationTrigger.querySelector('strong')!;
  locationTrigger.querySelector('em')!.textContent = uiText('E1248');
  for (const element of locationTrigger.querySelectorAll('[data-role]'))
    element.removeAttribute('data-role');
  const locationDialog = createMediaLocationDialog(doc);
  const locationEditor = locationDialog.root;
  locationEditor.classList.add('youtube-location-dialog');
  locationEditor.id = `youtube-location-${crypto.randomUUID()}`;
  locationEditor.hidden = true;
  locationTrigger.setAttribute('aria-controls', locationEditor.id);
  locationTrigger.setAttribute('aria-expanded', 'false');
  const legacyControls = doc.createElement('div');
  legacyControls.hidden = true;
  legacyControls.append(locationLabel, chooseDirectory);
  locationDialog.body.append(legacyControls);
  const automaticChoice = locationDialog.root.querySelector<HTMLButtonElement>(
    '[data-path-mode="automatic"]',
  )!;
  const askChoice = locationDialog.root.querySelector<HTMLButtonElement>('[data-path-mode="ask"]')!;
  automaticChoice.querySelector('small')!.textContent = 'Downloads/FoxFetch/YouTube';
  askChoice.hidden = false;
  askChoice.querySelector('strong')!.textContent = uiText('E0417');
  askChoice.querySelector('small')!.textContent = uiText('E1736');
  const closeLocation = () => {
    locationEditor.hidden = true;
    updateMediaLocationLayout(locationEditor);
    locationTrigger.setAttribute('aria-expanded', 'false');
    locationTrigger.focus();
  };
  locationDialog.close.forEach((button) => button.addEventListener('click', closeLocation));
  locationDialog.close[0]!.tabIndex = -1;
  for (const [button, value] of [
    [automaticChoice, 'browser-default'],
    [askChoice, 'ask'],
  ] as const) {
    button.addEventListener('click', () => {
      if (session.busy || directoryOpening) return;
      saveLocation.value = value;
      saveLocation.dispatchEvent(new Event('change'));
      closeLocation();
    });
  }
  locationTrigger.addEventListener('click', () => {
    locationEditor.hidden = !locationEditor.hidden;
    locationTrigger.setAttribute('aria-expanded', String(!locationEditor.hidden));
    updateMediaLocationLayout(locationEditor);
    if (!locationEditor.hidden)
      locationDialog.choices.find((c) => !c.hasAttribute('data-step-hidden'))?.focus();
  });
  locationEditor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeLocation();
    } else if (event.key === 'Tab') {
      const buttons = [
        locationDialog.close[1]!,
        ...locationDialog.choices,
        ...locationEditor.querySelectorAll<HTMLButtonElement>('[data-location-step]'),
      ].filter(
        (button) =>
          !button.disabled &&
          !button.hidden &&
          !button.hasAttribute('data-step-hidden') &&
          !button.parentElement?.hidden,
      );
      const focused =
        locationEditor.getRootNode() instanceof ShadowRoot
          ? (locationEditor.getRootNode() as ShadowRoot).activeElement
          : doc.activeElement;
      const index = buttons.indexOf(focused as HTMLButtonElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  });
  status.setAttribute('role', 'status');
  const summary = details.querySelector('summary')!;
  const text = details.querySelector('pre')!;
  text.removeAttribute('data-role');
  details.addEventListener('toggle', () => {
    summary.textContent = details.open ? uiText('E1134') : uiText('E1135');
    paint();
  });
  const actions = doc.createElement('div');
  actions.className = 'merge-actions';
  start.className = 'cache-button primary';
  cancel.className = 'cache-button';
  actions.append(start, cancel);
  const recoveryActions = doc.createElement('div');
  recoveryActions.className = 'merge-actions';
  for (const button of [settings, recheck, retry, discard]) {
    button.className = 'cache-button';
    recoveryActions.append(button);
  }
  block.append(
    saveProgress,
    saveProgressText,
    details,
    locationTrigger,
    locationEditor,
    actions,
    recoveryActions,
  );
  details.querySelector('summary')!.after(status);
  details.append(copyStatus, saveProgress, saveProgressText, directoryStatus);
  host.append(block);
  const lookupRetry = doc.createElement('button');
  lookupRetry.type = 'button';
  lookupRetry.className = 'cache-button';
  lookupRetry.textContent = uiText('E1738');
  lookupRetry.hidden = true;
  block.append(lookupRetry);
  let selection: YouTubeSelection | null = null;
  let supported = false;
  let separateSelection: YouTubeSelection | null = null;
  let separateSupported = false;
  let polling = false;
  let restoring = options.restore !== false;
  let lookupPending = false;
  let lookupFailed = false;
  let queryGeneration = 0;
  let requestingPermission = false;
  let locationConfirmationRequired = false;
  let locationSaving = false;
  const dockPermissionUi =
    doc.location?.protocol === 'https:' &&
    ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(doc.location.hostname);
  let dockCapability: { token: string; expiresAt: number } | undefined;
  let capabilityPending = false;
  let capabilityFailed = false;
  const capabilityRetry = doc.createElement('button');
  capabilityRetry.type = 'button';
  capabilityRetry.className = 'cache-button';
  capabilityRetry.textContent = uiText('E1739');
  capabilityRetry.hidden = true;
  block.append(capabilityRetry);
  const send = options.send ?? (async (message: UiRequest) => chrome.runtime.sendMessage(message));
  const tab = options.tabId === undefined ? {} : { tabId: options.tabId };
  async function prepareDockCapability() {
    if (!dockPermissionUi || capabilityPending || session.busy || !block.isConnected) return;
    capabilityPending = true;
    capabilityFailed = false;
    try {
      const response: ApiResponse<{ token: string; expiresAt: number }> =
        await chrome.runtime.sendMessage({ type: 'GET_YOUTUBE_PERMISSION_CAPABILITY', ...tab });
      if (
        !response.ok ||
        typeof response.data.token !== 'string' ||
        !Number.isFinite(response.data.expiresAt) ||
        response.data.expiresAt <= Date.now()
      )
        throw new Error('CAPABILITY_UNAVAILABLE');
      if (!block.isConnected) return;
      dockCapability = response.data;
      const token = dockCapability.token;
      setTimeout(() => {
        if (!block.isConnected || dockCapability?.token !== token) return;
        dockCapability = undefined;
        paint();
      }, 60_000);
    } catch {
      capabilityFailed = true;
    } finally {
      capabilityPending = false;
      if (block.isConnected) paint();
    }
  }
  capabilityRetry.addEventListener('click', () => {
    void prepareDockCapability();
  });
  const paint = () => {
    updateLocalizedMarkup(block);
    cancel.textContent = uiText('E0101');
    recheck.textContent = uiText('E1727');
    retry.textContent = uiText('E1728');
    discard.textContent = uiText('E1729');
    settings.textContent = uiText('E1730');
    chooseDirectory.textContent = uiText('E1735');
    lookupRetry.textContent = uiText('E1738');
    capabilityRetry.textContent = uiText('E1739');
    saveProgress.setAttribute('aria-label', uiText('E1731'));
    capabilityRetry.hidden = !dockPermissionUi || !capabilityFailed;
    capabilityRetry.disabled = capabilityPending || session.busy;
    if (
      dockPermissionUi &&
      !dockCapability &&
      !capabilityPending &&
      !capabilityFailed &&
      !session.busy &&
      !restoring &&
      (supported || separateSupported)
    )
      queueMicrotask(() => {
        void prepareDockCapability();
      });
    lookupRetry.hidden = !lookupFailed;
    lookupRetry.disabled = lookupPending;
    const snapshot = session.snapshot;
    options.onSnapshot?.(snapshot);
    saveProgress.hidden = saveProgressText.hidden = snapshot?.state !== 'saving';
    const totalSaveBytes = snapshot?.files.reduce((sum, file) => sum + file.size, 0) ?? 0;
    const savedBytes = snapshot?.files.reduce((sum, file) => sum + (file.savedBytes ?? 0), 0) ?? 0;
    const knownSaveProgress =
      !!snapshot?.files.length &&
      snapshot.files.every(
        (file) =>
          Number.isSafeInteger(file.savedBytes) &&
          file.savedBytes! >= 0 &&
          file.savedBytes! <= file.size,
      ) &&
      Number.isSafeInteger(totalSaveBytes) &&
      totalSaveBytes > 0;
    if (knownSaveProgress) {
      saveProgress.max = totalSaveBytes;
      saveProgress.value = savedBytes;
      saveProgressText.textContent = uiText('E1740', { p1: savedBytes, p2: totalSaveBytes });
    } else {
      saveProgress.removeAttribute('value');
      saveProgressText.textContent = uiText('E1741');
    }
    copy.hidden = !snapshot;
    const startLabel =
      snapshot?.state === 'canceled' && terminal(snapshot) ? uiText('E1250') : uiText('E0033');
    start.innerHTML = `${mediaDownloadIcon}<span>${startLabel}</span>`;
    start.disabled =
      locationRestoring ||
      locationSaving ||
      options.isSourceRefreshing?.() === true ||
      restoring ||
      session.busy ||
      !selection ||
      !supported ||
      (dockPermissionUi && !dockCapability);
    separate.hidden = true;
    separate.disabled =
      options.isSourceRefreshing?.() === true ||
      restoring ||
      session.busy ||
      !separateSelection ||
      !separateSupported ||
      (dockPermissionUi && !dockCapability) ||
      (saveLocation.value === 'custom' && !directoryDraft?.sessionId);
    chooseDirectory.hidden = directoryStatus.hidden = saveLocation.value !== 'custom';
    chooseDirectory.disabled = restoring || session.busy || directoryOpening;
    saveLocation.disabled = session.busy;
    locationTrigger.disabled = restoring || session.busy || directoryOpening;
    for (const [button, value] of [
      [automaticChoice, 'browser-default'],
      [askChoice, 'ask'],
    ] as const) {
      button.disabled = restoring || session.busy || directoryOpening || locationSaving;
      button.setAttribute(
        'aria-pressed',
        String(!locationConfirmationRequired && saveLocation.value === value),
      );
    }
    locationValue.textContent = locationConfirmationRequired
      ? uiText('E1246')
      : saveLocation.value === 'custom'
        ? (directoryDraft?.name ?? rememberedDirectoryName ?? uiText('E1742'))
        : saveLocation.value === 'ask'
          ? uiText('E0417')
          : 'Downloads/FoxFetch/YouTube';
    cancel.hidden = false;
    cancel.textContent = snapshot?.state === 'canceling' ? uiText('E1251') : uiText('E0101');
    cancel.disabled =
      !session.busy ||
      !session.jobId ||
      !snapshot ||
      requestingPermission ||
      snapshot?.state === 'canceling' ||
      (!!snapshot?.cleanupPending && ['failed', 'complete', 'canceled'].includes(snapshot.state));
    settings.hidden = snapshot?.error !== 'SOURCE_PERMISSION_REQUIRED';
    recheck.hidden =
      !!snapshot?.retryAvailable ||
      !snapshot?.cleanupPending ||
      !['complete', 'failed', 'canceled'].includes(snapshot.state);
    retry.hidden = discard.hidden = !snapshot?.retryAvailable;
    retry.disabled = discard.disabled = saveActionPending;
    recheck.disabled = checking;
    const stages = {
      get resolving() {
        return uiText('E0707');
      },
      preparing: snapshot?.preparationStage
        ? youtubePreparationStages[snapshot.preparationStage]
        : uiText('E1743'),
      get saving() {
        return uiText('E0712');
      },
      get canceling() {
        return uiText('E1744');
      },
      get canceled() {
        return uiText('E1745');
      },
      get complete() {
        return uiText('E0176');
      },
      get failed() {
        return uiText('E1149');
      },
    };
    const savedSelection = snapshot?.requestedSelection ?? snapshot?.selection;
    const displayedSelection =
      options.sharedActions && savedSelection?.mode === 'separate' ? separateSelection : selection;
    const matchesSavedSelection =
      !!displayedSelection &&
      !!savedSelection &&
      displayedSelection.videoId === savedSelection.videoId &&
      displayedSelection.videoTrackId === savedSelection.videoTrackId &&
      displayedSelection.audioTrackId === savedSelection.audioTrackId &&
      displayedSelection.container === savedSelection.container &&
      (displayedSelection.mode ?? 'merge') === (savedSelection.mode ?? 'merge');
    const completion = matchesSavedSelection ? uiText('E1746') : uiText('E1747');
    const previousCompletion = snapshot?.state === 'complete' && !matchesSavedSelection;
    status.textContent =
      session.notice ??
      (snapshot
        ? `${snapshot.state === 'complete' ? completion : stages[snapshot.state]}${snapshot.error ? `。${errors[snapshot.error] ?? uiText('E1748')}` : ''}${snapshot.cleanupPending && ['failed', 'complete', 'canceled'].includes(snapshot.state) ? uiText('E1749') : ''}`
        : supported || separateSupported
          ? uiText('E1750')
          : uiText('E1751'));
    // Selection validation is shown once by the owning selector above this status.
    if (snapshot?.state === 'preparing' && (snapshot.formatAttempt ?? 1) > 1)
      status.textContent = `${uiText('download.trying', { current: snapshot.formatAttempt, total: snapshot.formatTotal ?? snapshot.formatAttempt })} ${status.textContent}`;
    status.hidden = !!options.sharedActions && !snapshot && !session.notice;
    const attention =
      snapshot?.error ||
      (snapshot?.cleanupPending ? 'cleanup' : '') ||
      (session.notice && !session.busy ? session.notice : '');
    summary.title = attention ? uiText('E1752') : '';
    taskProgress.hidden = false;
    const totalBytes = snapshot ? reliableTaskTotal(snapshot.readBytes, snapshot.totalBytes) : null;
    const downloading =
      snapshot?.state === 'preparing' && snapshot.preparationStage === 'downloading';
    const segmentRatio = downloading ? segmentProgressRatio(snapshot?.segments) : null;
    const headingText = taskProgress.querySelector('.merge-progress-heading strong')?.firstChild;
    if (headingText)
      headingText.textContent = downloading
        ? totalBytes
          ? uiText('E1753')
          : segmentRatio !== null
            ? uiText('E1754')
            : uiText('E1755')
        : uiText('E1756');
    // Saving byte progress is shown separately. It is not overall acquisition progress.
    updateMediaTaskProgress(
      taskProgress,
      previousCompletion
        ? 0
        : snapshot?.state === 'complete'
          ? 1
          : !snapshot && !session.busy
            ? 0
            : downloading && totalBytes
              ? Math.floor((snapshot.readBytes / totalBytes) * 100) / 100
              : segmentRatio,
      status.textContent,
      !!snapshot && ['resolving', 'preparing', 'saving', 'canceling'].includes(snapshot.state),
    );
    if (
      snapshot &&
      snapshot.state !== 'complete' &&
      (!downloading || (!totalBytes && segmentRatio === null))
    ) {
      if (headingText) headingText.textContent = downloading ? uiText('E1755') : '';
      taskProgress.querySelector('[data-role="merge-progress-label"]')!.textContent = downloading
        ? uiText('E1757', { p1: formatTaskBytes(snapshot.readBytes) })
        : stages[snapshot.state];
    }
    const stateDot = taskProgress.querySelector<HTMLElement>('[data-role="merge-state"]')!;
    if (!snapshot && session.busy) {
      if (headingText) headingText.textContent = '';
      taskProgress.querySelector('[data-role="merge-progress-label"]')!.textContent =
        uiText('E0103');
    }
    stateDot.dataset.state = previousCompletion
      ? 'idle'
      : snapshot?.state === 'complete'
        ? 'ready'
        : snapshot?.state === 'failed'
          ? 'error'
          : session.busy
            ? 'loading'
            : 'idle';
    stateDot.setAttribute(
      'aria-label',
      snapshot && !previousCompletion ? stages[snapshot.state] : uiText('E0503'),
    );
    stateDot.title = stateDot.getAttribute('aria-label')!;
    const stateLabel = taskProgress.querySelector<HTMLElement>('[data-role="merge-state-label"]')!;
    stateLabel.hidden = !snapshot || previousCompletion;
    stateLabel.textContent = snapshot && !previousCompletion ? stages[snapshot.state] : '';
    details.hidden = false;
    text.textContent = snapshot
      ? [
          uiText('E1666', { p1: snapshot.jobId }),
          ...((snapshot.formatAttempt ?? 1) > 1
            ? [
                uiText('download.attempt', {
                  current: snapshot.formatAttempt,
                  total: snapshot.formatTotal ?? snapshot.formatAttempt,
                }),
                ...(snapshot.selection && options.describeSelection
                  ? [options.describeSelection(snapshot.selection)]
                  : []),
              ]
            : []),
          ...(downloading && snapshot.readSpeed != null
            ? [uiText('E1758', { p1: formatTaskBytes(snapshot.readSpeed) })]
            : []),
          ...(segmentRatio !== null && snapshot.segments
            ? [
                uiText('E1759', {
                  p1: snapshot.segments.video.completed,
                  p2: snapshot.segments.video.total,
                  p3: snapshot.segments.audio.completed,
                  p4: snapshot.segments.audio.total,
                }),
              ]
            : []),
          uiText('E1760', {
            p1: formatTaskBytes(snapshot.readBytes),
            p2: totalBytes ? ` / ${formatTaskBytes(totalBytes)}` : '',
          }),
          ...(snapshot.error ? [uiText('E1677', { p1: snapshot.error })] : []),
          ...snapshot.files.map(
            (file) =>
              `${
                {
                  get merged() {
                    return uiText('E0040');
                  },
                  get video() {
                    return uiText('E0021');
                  },
                  get audio() {
                    return uiText('E0022');
                  },
                }[file.kind]
              }：${
                {
                  get saving() {
                    return uiText('E1145');
                  },
                  get complete() {
                    return uiText('E0176');
                  },
                  get interrupted() {
                    return uiText('E1664');
                  },
                }[file.state]
              } · ${file.savedBytes === undefined ? uiText('E1761') : uiText('E1762', { p1: formatTaskBytes(file.savedBytes) })} / ${formatTaskBytes(file.size)}`,
          ),
          ...(snapshot.saveLocation === 'ask'
            ? uiText('E1763')
            : snapshot.saveLocation === 'custom'
              ? uiText('E1764')
              : ''
          )
            .split('\n')
            .filter(Boolean),
        ].join('\n')
      : uiText('E0503');
  };
  const accept = (snapshot: YouTubeTaskSnapshot | null) => {
    if (
      snapshot &&
      snapshot.jobId === session.jobId &&
      (snapshot.saveAttempt ?? 0) < (session.snapshot?.saveAttempt ?? 0)
    )
      return;
    // A finished task cannot return to saving because an earlier query arrived late.
    if (terminal(session.snapshot)) return;
    if (!snapshot || snapshot.jobId !== session.jobId || snapshot.videoId !== videoId) {
      session.notice = uiText('E1765');
      return;
    }
    session.snapshot = snapshot;
    delete session.notice;
    session.busy = !terminal(snapshot);
  };
  const poll = async () => {
    if (polling || !session.busy || !session.jobId) return;
    polling = true;
    const confirmationDeadline = Date.now() + 60_000;
    try {
      while (session.busy && block.isConnected) {
        if (Date.now() >= confirmationDeadline && (!session.snapshot || session.notice)) {
          lookupFailed = true;
          session.notice = uiText('E1766');
          paint();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!block.isConnected || !session.busy) break;
        const jobId: string = session.jobId!;
        const generation = queryGeneration;
        try {
          const result = await send({
            type: 'GET_YOUTUBE_DOWNLOAD',
            jobId,
            ...tab,
          });
          if (
            session.jobId !== jobId ||
            terminal(session.snapshot) ||
            generation !== queryGeneration
          )
            continue;
          if (result.ok) accept(result.data);
          else session.notice = uiText('E1767');
        } catch {
          if (
            session.jobId === jobId &&
            !terminal(session.snapshot) &&
            generation === queryGeneration
          )
            session.notice = uiText('E1768');
        }
        paint();
      }
    } finally {
      polling = false;
    }
  };
  saveLocation.addEventListener('change', () => {
    if (session.busy || locationSaving) return;
    locationTouched = true;
    locationRestoring = false;
    if (saveLocation.value === 'custom') {
      locationConfirmationRequired = true;
      session.notice = uiText('E1769');
      paint();
      return;
    }
    if (saveLocation.value !== 'custom') {
      locationSaving = true;
      locationConfirmationRequired = true;
      void saveMergeDownloadPathPolicy(
        'https://www.youtube.com/',
        saveLocation.value === 'ask' ? 'ask' : 'automatic',
      )
        .then(() => {
          locationConfirmationRequired = false;
          session.notice = '';
        })
        .catch(() => {
          session.notice = uiText('E1770');
        })
        .finally(() => {
          locationSaving = false;
          paint();
        });
    }
    directoryDraft = undefined;
    directoryOpening = false;
    directoryStatus.textContent = uiText('E0273');
    paint();
  });
  const startDownload = (
    chosenSelection: YouTubeSelection | null,
    ready: boolean,
    disabled: boolean,
  ) => {
    if (options.isSourceRefreshing?.()) return;
    if (restoring || session.busy || !chosenSelection || !ready || disabled) return;
    if (locationConfirmationRequired || saveLocation.value === 'custom') {
      if (locationEditor.hidden) locationTrigger.click();
      return;
    }
    if (dockPermissionUi && (!dockCapability || dockCapability.expiresAt <= Date.now())) {
      dockCapability = undefined;
      void prepareDockCapability();
      return;
    }
    const permissionToken = dockCapability?.token;
    dockCapability = undefined;
    session.busy = true;
    details.open = false;
    delete session.snapshot;
    session.notice = uiText('E0487');
    const custom = saveLocation.value === 'custom' ? directoryDraft : undefined;
    session.jobId = custom?.jobId ?? crypto.randomUUID();
    const jobId = session.jobId;
    const chosen = structuredClone(chosenSelection);
    const chosenLocation = custom
      ? 'custom'
      : saveLocation.value === 'ask'
        ? 'ask'
        : 'browser-default';
    directoryDraft = undefined;
    directoryStatus.textContent = uiText('E1771');
    paint();
    const request = {
      type: 'START_YOUTUBE_DOWNLOAD',
      jobId,
      selection: chosen,
      saveLocation: chosenLocation,
      ...(custom?.sessionId ? { directorySessionId: custom.sessionId } : {}),
      ...tab,
      ...(permissionToken ? { permissionToken } : {}),
    } as const;
    const extensionPermissionUi =
      doc.location?.protocol === 'chrome-extension:' &&
      ['/popup.html', '/sidepanel.html'].includes(doc.location.pathname);
    requestingPermission = extensionPermissionUi || dockPermissionUi;
    if (requestingPermission) {
      session.notice = uiText('E1772');
      paint();
    }
    void (extensionPermissionUi ? startYouTubeDownloadWithPermission(request, send) : send(request))
      .then((result) => {
        if (session.jobId !== jobId || terminal(session.snapshot)) return;
        if (result.ok) accept(result.data);
        else {
          const safeDockFailure =
            result.error === '未允许访问 YouTube 视频来源，下载未开始。' ||
            result.error === '本次授权入口已失效，请重新打开面板后重试。';
          session.busy = dockPermissionUi && !safeDockFailure;
          session.notice =
            extensionPermissionUi || dockPermissionUi ? result.error : uiText('E1773');
        }
      })
      .catch(() => {
        if (session.jobId === jobId && !terminal(session.snapshot))
          session.notice = uiText('E1774');
      })
      .finally(() => {
        requestingPermission = false;
        paint();
        void poll();
      });
  };
  start.addEventListener('click', () => startDownload(selection, supported, start.disabled));
  separate.addEventListener('click', () =>
    startDownload(separateSelection, separateSupported, separate.disabled),
  );
  cancel.addEventListener('click', () => {
    if (!session.jobId || !session.busy || cancel.disabled) return;
    cancel.disabled = true;
    const jobId = session.jobId;
    void send({ type: 'CANCEL_YOUTUBE_DOWNLOAD', jobId, ...tab })
      .then((result) => {
        if (session.jobId !== jobId || terminal(session.snapshot)) return;
        if (result.ok) accept(result.data);
      })
      .catch(() => {
        if (session.jobId === jobId && !terminal(session.snapshot))
          session.notice = uiText('E1775');
      })
      .finally(() => {
        paint();
        void poll();
      });
  });
  settings.addEventListener('click', () => {
    const open =
      location.protocol === 'chrome-extension:'
        ? import('../settings-frame').then((module) => module.openLocalSettings('permissions'))
        : send({ type: 'OPEN_YOUTUBE_PERMISSIONS', ...tab });
    void open.catch(() => {
      session.notice = uiText('E1776');
      paint();
    });
  });
  recheck.addEventListener('click', () => {
    if (checking || !session.jobId || recheck.hidden) return;
    checking = true;
    const jobId = session.jobId;
    paint();
    void send({ type: 'RECHECK_YOUTUBE_DOWNLOAD', jobId, ...tab })
      .then((result) => {
        if (session.jobId !== jobId || terminal(session.snapshot)) return;
        if (result.ok) accept(result.data);
        else session.notice = uiText('E1777');
      })
      .catch(() => {
        if (session.jobId === jobId && !terminal(session.snapshot))
          session.notice = uiText('E1777');
      })
      .finally(() => {
        checking = false;
        paint();
        void poll();
      });
  });
  for (const [button, type] of [
    [retry, 'RETRY_YOUTUBE_SAVE'],
    [discard, 'DISCARD_YOUTUBE_SAVE'],
  ] as const) {
    button.addEventListener('click', () => {
      if (saveActionPending || !session.jobId || !session.snapshot?.retryAvailable) return;
      saveActionPending = true;
      const jobId = session.jobId;
      // Invalidate older queries, but do not invent a successful retry before acknowledgement.
      queryGeneration++;
      paint();
      void send({ type, jobId, ...tab })
        .then((result) => {
          if (session.jobId !== jobId) return;
          if (result.ok) accept(result.data);
          else session.notice = uiText('E1778');
        })
        .catch(() => {
          if (session.jobId === jobId) session.notice = uiText('E1779');
        })
        .finally(() => {
          saveActionPending = false;
          paint();
          void poll();
        });
    });
  }
  copy.addEventListener('click', () => {
    if (!session.snapshot || copy.disabled) return;
    const diagnostic = formatYouTubeTaskDiagnostics(session.snapshot);
    copy.disabled = true;
    copyStatus.textContent = '';
    const write =
      options.copy ?? ((value: string) => doc.defaultView!.navigator.clipboard.writeText(value));
    void Promise.resolve()
      .then(() => write(diagnostic))
      .then(() => {
        copyStatus.textContent = uiText('E1780');
      })
      .catch(() => {
        copyStatus.textContent = uiText('E1781');
      })
      .finally(() => {
        copy.disabled = false;
      });
  });
  paint();
  subscribeViewLanguage(block, paint);
  const restoreCurrentTask = () => {
    if (lookupPending || !host.contains(block)) return;
    if (!restoring) {
      lookupFailed = false;
      session.notice = uiText('E1782');
      paint();
      void poll();
      return;
    }
    lookupPending = true;
    session.notice = uiText('E1783');
    paint();
    void send({ type: 'GET_CURRENT_YOUTUBE_DOWNLOAD', ...tab })
      .then((result) => {
        if (!host.contains(block)) return;
        if (!result.ok) throw new Error('TASK_LOOKUP_FAILED');
        if (result.data) {
          if (result.data.videoId !== videoId) throw new Error('TASK_LOOKUP_MISMATCH');
          session.jobId = result.data.jobId;
          delete session.snapshot;
          accept(result.data);
        } else if (!session.jobId || !session.busy) {
          session.busy = false;
          delete session.notice;
        } else {
          session.notice = uiText('E1784');
        }
        restoring = false;
        lookupFailed = false;
      })
      .catch(() => {
        if (!host.contains(block)) return;
        lookupFailed = true;
        session.notice = uiText('E1785');
      })
      .finally(() => {
        lookupPending = false;
        if (!host.contains(block)) return;
        paint();
        void poll();
      });
  };
  lookupRetry.addEventListener('click', restoreCurrentTask);
  void (async () => {
    const [policy, previous] = await Promise.all([
      getMergeDownloadPathPolicy('https://www.youtube.com/'),
      getLastVideoDirectory(),
    ]);
    if (!block.isConnected || locationTouched) return;
    locationRestoring = false;
    rememberedDirectoryName = previous?.name;
    saveLocation.value = policy.mode === 'automatic' ? 'browser-default' : policy.mode;
    if (policy.mode === 'custom') {
      locationConfirmationRequired = true;
      session.notice = uiText('E0755');
      rememberedDirectoryName = policy.directory.name;
      directoryStatus.textContent = uiText('E1786', { p1: policy.directory.name });
    }
    paint();
  })().catch(() => {
    if (!locationRestoring || locationTouched || !block.isConnected) return;
    session.notice = uiText('E1787');
    paint();
  });
  queueMicrotask(restoreCurrentTask);
  return {
    refresh: paint,
    selectSeparate: (value, ready) => {
      separateSelection = value;
      separateSupported = ready;
      paint();
    },
    select: (value, ready) => {
      selection = value;
      supported = ready;
      paint();
    },
  };
}
