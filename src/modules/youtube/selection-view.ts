import { t as uiText } from '../../shared/i18n';
import { automaticYouTubePlans, normalizePreference } from './automatic-selection';
import { subscribeViewLanguage } from '../../shared/i18n/markup';
import { messageText } from '../../shared/i18n/legacy-message';
import type { YouTubeInspection, YouTubeCandidate } from './inspection';
import { matchYouTubeAudio } from './default-audio';
import { disposeMediaLocationLayout } from '../../shared/media-location-dialog';
import { youTubeLanguageLabel } from './language-label';
import { createYouTubeSelectionPlan, youTubeCodecs, type YouTubeSelection } from './selection';
import { renderYouTubeTaskControls } from './task-view';
import { readYouTubeDraft, type YouTubeSelectionDraft } from './selection-preferences';
import { mountCustomSelect } from '../../components/mountCustomSelect';
import { mountDockVariantControl } from '../../shared/dock-variant-control';

type Draft = YouTubeSelectionDraft;
const drafts = new WeakMap<HTMLElement, Draft>();
const mountedControls = new WeakMap<HTMLElement, Array<() => void>>();
const taskRefreshers = new WeakMap<HTMLElement, () => void>();
export const youtubeVideoPreference = (candidate: YouTubeCandidate): string =>
  JSON.stringify([
    candidate.width,
    candidate.height,
    candidate.fps,
    candidate.mime,
    candidate.dynamicRange,
    candidate.composition,
    candidate.sourceTags ?? '',
    candidate.language ?? '',
    candidate.audioTrackId ?? '',
    candidate.audioTrackName ?? '',
  ]);
export function setYouTubeSelectionRefreshing(host: HTMLElement, refreshing: boolean): void {
  host.dataset.youtubeRefreshing = String(refreshing);
  taskRefreshers.get(host)?.();
}
export function disposeYouTubeSelection(host: HTMLElement): void {
  host
    .querySelectorAll<HTMLElement>('.youtube-location-dialog')
    .forEach(disposeMediaLocationLayout);
  mountedControls.get(host)?.forEach((dispose) => dispose());
  mountedControls.delete(host);
  taskRefreshers.delete(host);
}

/** Labels are presentation only: full candidate IDs remain the selection values. */
function distinguishOptions(values: Array<[string, string]>): Array<[string, string]> {
  const idsByLabel = new Map<string, string[]>();
  for (const [id, label] of values) {
    const ids = idsByLabel.get(label) ?? [];
    ids.push(id);
    idsByLabel.set(label, ids);
  }
  for (const ids of idsByLabel.values()) ids.sort();
  return values.map(([id, label]) => {
    const ids = idsByLabel.get(label)!;
    return [id, ids.length > 1 ? uiText('E1615', { p1: label, p2: ids.indexOf(id) + 1 }) : label];
  });
}

/** UI draft only. It never grants acquisition capability or starts a network request. */
export function renderYouTubeSelection(
  host: HTMLElement,
  view: YouTubeInspection,
  task?: { downloads?: boolean; tabId?: number },
  sharedControls: boolean | 'dock' = false,
  renderTaskPreview?: (preview: HTMLElement) => void,
): void {
  disposeYouTubeSelection(host);
  if (view.status !== 'identified' || view.pageType !== 'watch' || !view.videoId) return;
  let draft = drafts.get(host);
  if (!draft || draft.videoId !== view.videoId) {
    draft = {
      videoId: view.videoId,
      quality: '',
      codec: '',
      audio: '',
      container: 'auto',
      mode: 'merge',
    };
    drafts.set(host, draft);
  }
  const state = draft;
  const doc = host.ownerDocument;
  const group = doc.createElement('fieldset');
  group.style.cssText = 'min-width:0;border:0;padding:0;margin:0;display:grid;gap:10px';
  const legend = doc.createElement('legend');
  legend.hidden = true;
  legend.textContent = uiText('E1616');
  group.append(legend);
  const videos = view.candidates.filter((c) => c.kind === 'video');
  const qualityKey = (c: (typeof videos)[number]) =>
    `${c.width ?? '?'}×${c.height ?? '?'} · ${c.fps ?? '?'} fps`;
  const select = (title: string) => {
    const label = doc.createElement('label');
    label.textContent = title;
    const element = doc.createElement('select');
    element.setAttribute('aria-label', title);
    element.style.cssText =
      'display:block;width:100%;max-width:100%;min-width:0;padding:8px;color:inherit;background:transparent;border:1px solid currentColor;border-radius:8px';
    label.append(element);
    group.append(label);
    return element;
  };
  const options = (element: HTMLSelectElement, values: Array<[string, string]>, value: string) => {
    element.replaceChildren();
    const add = (key: string, text: string) => {
      const option = doc.createElement('option');
      option.value = key;
      option.textContent = text;
      element.append(option);
    };
    add('', uiText('E1618'));
    values.forEach(([key, text]) => add(key, text));
    element.value = values.some(([key]) => key === value) ? value : '';
  };
  const quality = select(uiText('E1619'));
  const preference = select(uiText('download.preference'));
  const codec = select(uiText('E1620'));
  const audio = select(uiText('E1621'));
  const mode = select(uiText('E1622'));
  const container = select(uiText('E1623'));
  for (const element of [codec, audio, mode, container]) element.parentElement!.hidden = true;
  if (sharedControls) {
    mode.parentElement!.hidden = true;
    container.parentElement!.hidden = true;
  }
  const summary = doc.createElement('p');
  summary.setAttribute('role', 'status');
  group.append(summary);
  const preferenceStatus = doc.createElement('p');
  preferenceStatus.className = 'media-selection-status';
  preferenceStatus.setAttribute('aria-live', 'polite');
  group.append(preferenceStatus);
  let writes: Promise<unknown> = Promise.resolve();
  let pendingWrites = 0;
  let editGeneration = 0;
  let unsavedEdit = false;
  const persist = () => {
    if (!task?.downloads) return;
    editGeneration++;
    const generation = editGeneration;
    unsavedEdit = true;
    pendingWrites++;
    const saved = { ...state };
    preferenceStatus.textContent = uiText('E1624');
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        const result = await chrome.runtime.sendMessage({
          type: 'SET_YOUTUBE_SELECTION',
          videoId: saved.videoId,
          draft: saved,
          ...(task.tabId === undefined ? {} : { tabId: task.tabId }),
        });
        if (!result.ok) throw new Error('SELECTION_SAVE_FAILED');
      })
      .then(() => {
        if (generation === editGeneration) {
          unsavedEdit = false;
          preferenceStatus.textContent = '';
        }
      })
      .catch(() => {
        preferenceStatus.textContent = uiText('E1625');
      })
      .finally(() => {
        pendingWrites--;
      });
  };
  const controls = task?.downloads
    ? renderYouTubeTaskControls(group, view.videoId, {
        ...task,
        sharedActions: !!sharedControls,
        summaryTitle: view.title ?? uiText('E0796'),
        onSnapshot: (snapshot) => {
          summary.hidden = (snapshot?.formatAttempt ?? 1) > 1;
        },
        describeSelection: (selection) => {
          const actual = createYouTubeSelectionPlan(view, selection);
          if (!actual.ok) return messageText(actual.reason);
          const p = actual.plan;
          return uiText('E1633', {
            p1: qualityKey(p.video),
            p2: p.videoCodec.toUpperCase(),
            p3: youTubeLanguageLabel(p.audio?.language ?? p.video.language),
            p4: p.audioCodec.toUpperCase(),
            p5: p.container?.toUpperCase() ?? '',
            p6: '',
          });
        },
        ...(renderTaskPreview ? { renderSummaryPreview: renderTaskPreview } : {}),
        isSourceRefreshing: () => host.dataset.youtubeRefreshing === 'true',
      })
    : undefined;
  if (controls) taskRefreshers.set(host, controls.refresh);
  if (controls && sharedControls) {
    const status = group.querySelector('[data-youtube-task-status]')!;
    status.after(summary, preferenceStatus);
  }
  const update = () => {
    for (const [element, key] of [
      [quality, 'E1619'],
      [preference, 'download.preference'],
      [codec, 'E1620'],
      [audio, 'E1621'],
      [mode, 'E1622'],
      [container, 'E1623'],
    ] as const) {
      const title = uiText(key);
      element.setAttribute('aria-label', title);
      const labelText = element.parentElement?.firstChild;
      if (labelText?.nodeType === 3) labelText.textContent = title;
    }
    if (controls && sharedControls)
      group.querySelector('[data-youtube-task-status]')!.after(summary);
    controls?.select(null, false);
    controls?.selectSeparate(null, false);
    if (sharedControls) {
      state.mode = 'merge';
      state.container = 'auto';
    }
    const qualities = [
      ...new Set(
        [...videos]
          .sort(
            (a, b) =>
              (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) ||
              (b.fps ?? 0) - (a.fps ?? 0),
          )
          .map(qualityKey),
      ),
    ];
    if (!state.quality) state.quality = qualities[0] ?? '';
    state.preference = normalizePreference(state.preference);
    options(
      preference,
      (['compatibility', 'quality', 'size'] as const).map((value) => [
        value,
        uiText(`download.${value}`),
      ]),
      state.preference,
    );
    const automatic = automaticYouTubePlans(view, state.quality, state.preference)[0];
    state.codec = automatic?.video.id ?? '';
    state.videoPreference = automatic ? youtubeVideoPreference(automatic.video) : '';
    state.container = 'auto';
    options(
      quality,
      qualities.map((q) => [q, q]),
      state.quality,
    );
    const available = videos.filter((c) => qualityKey(c) === state.quality);
    if (!available.some((c) => c.id === state.codec) && state.videoPreference) {
      const equivalent = available.filter(
        (c) => c.source !== 'drm' && youtubeVideoPreference(c) === state.videoPreference,
      );
      if (equivalent.length === 1) state.codec = equivalent[0]!.id;
    }
    options(
      codec,
      distinguishOptions(
        available.map((c) => [
          c.id,
          `${youTubeCodecs(c.mime).video?.toUpperCase() ?? uiText('E1626')}${c.composition === 'muxed' ? uiText('E1627') : ''}${c.source === 'drm' ? uiText('E1628') : ''}`,
        ]),
      ),
      state.codec,
    );
    const selected = available.find((c) => c.id === state.codec);
    if (selected) state.videoPreference = youtubeVideoPreference(selected);
    const muxed = selected?.composition === 'muxed';
    audio.parentElement!.hidden = true;
    // Audio is automatic; old saved Opus/language choices are no longer UI inputs.
    audio.disabled = true;
    state.audio = automatic?.audio?.id ?? '';
    options(
      audio,
      distinguishOptions(
        view.candidates
          .filter((c) => c.kind === 'audio')
          .map((c) => [
            c.id,
            `${youTubeLanguageLabel(c.language)}${c.audioTrackName ? ` · ${c.audioTrackName}` : ''} · ${youTubeCodecs(c.mime).audio?.toUpperCase() ?? uiText('E1626')}${c.defaultAudio ? uiText('E1629') : ''}`,
          ]),
      ),
      state.audio,
    );
    options(mode, [['merge', uiText('E0033')]], 'merge');
    state.mode = 'merge';
    options(
      container,
      [
        ['auto', uiText('E1630')],
        ['mp4', 'MP4'],
        ['webm', 'WebM'],
      ],
      state.container,
    );
    if (!selected) {
      summary.textContent = uiText('E1631');
      return;
    }
    if (!muxed && !state.audio) {
      controls?.select(null, false);
      summary.textContent = uiText('E1632');
      return;
    }
    const selection: YouTubeSelection = {
      preference: state.preference,
      videoId: state.videoId,
      videoTrackId: selected.id,
      ...(!muxed && state.audio ? { audioTrackId: state.audio } : {}),
      container: state.container,
      mode: muxed ? 'merge' : state.mode,
    };
    const result = createYouTubeSelectionPlan(view, selection);
    if (sharedControls && !muxed) {
      const separateSelection: YouTubeSelection = {
        ...selection,
        mode: 'separate',
        container: 'auto',
      };
      const separatePlan = createYouTubeSelectionPlan(view, separateSelection);
      controls?.selectSeparate(
        separatePlan.ok ? separateSelection : null,
        separatePlan.ok && view.transports.includes('sabr'),
      );
    }
    controls?.select(
      result.ok ? selection : null,
      result.ok &&
        ((selected.composition === 'separate' && view.transports.includes('sabr')) ||
          (selected.composition === 'muxed' &&
            selected.source === 'direct-candidate' &&
            result.plan.mode === 'merge' &&
            selected.mime.startsWith(`video/${result.plan.container}`))),
      muxed,
    );
    summary.textContent = result.ok
      ? uiText('E1633', {
          p1: state.quality,
          p2: result.plan.videoCodec.toUpperCase(),
          p3: youTubeLanguageLabel(muxed ? selected.language : result.plan.audio?.language),
          p4: result.plan.audioCodec.toUpperCase(),
          p5: result.plan.container?.toUpperCase() ?? uiText('E1634'),
          p6: muxed ? uiText('E1635') : '',
        })
      : messageText(result.reason);
    if (controls && sharedControls) {
      const details = group.querySelector<HTMLDetailsElement>('[data-youtube-task-details]')!;
      details.dataset.selectionAttention = result.ok ? '' : result.reason;
    }
    if (result.ok && controls && sharedControls) {
      const audioTrack = result.plan.audio;
      if (audioTrack && !view.candidates.some((c) => c.kind === 'audio' && c.defaultAudio))
        summary.textContent += uiText('E1636');
      group.querySelector('[data-youtube-task-details]')!.append(summary);
    }
  };
  quality.addEventListener('change', () => {
    state.quality = quality.value;
    update();
    persist();
  });
  preference.addEventListener('change', () => {
    state.preference = normalizePreference(preference.value);
    update();
    persist();
  });
  codec.addEventListener('change', () => {
    state.codec = codec.value;
    update();
    persist();
  });
  container.addEventListener('change', () => {
    if (['auto', 'mp4', 'webm'].includes(container.value))
      state.container = container.value as Draft['container'];
    update();
    persist();
  });
  mode.addEventListener('change', () => {
    if (mode.value === 'merge' || mode.value === 'separate') state.mode = mode.value;
    update();
    persist();
  });
  update();
  host.append(group);
  subscribeViewLanguage(group, update);
  mountedControls.set(
    host,
    [quality, preference].map(
      sharedControls === 'dock' ? mountDockVariantControl : mountCustomSelect,
    ),
  );
  // Re-query through the authenticated background handler, not raw session storage.
  // A removed/replaced panel stops polling and cannot apply a late response.
  const currentPanel = () =>
    group.isConnected && host.contains(group) && drafts.get(host) === state;
  const scheduleSync = () => {
    if (!task?.downloads || !currentPanel()) return;
    doc.defaultView!.setTimeout(() => void sync(), 2000);
  };
  const sync = async () => {
    if (!currentPanel()) return;
    const generation = editGeneration;
    try {
      if (pendingWrites || unsavedEdit) return;
      const result = await chrome.runtime.sendMessage({
        type: 'GET_YOUTUBE_SELECTION',
        videoId: state.videoId,
        ...(task?.tabId === undefined ? {} : { tabId: task.tabId }),
      });
      if (!currentPanel() || pendingWrites || unsavedEdit || generation !== editGeneration) return;
      const incoming = result.ok ? readYouTubeDraft(result.data) : null;
      if (!incoming || incoming.videoId !== state.videoId) return;
      incoming.audio =
        matchYouTubeAudio(
          view.candidates,
          videos.find((candidate) => candidate.id === incoming.codec),
        )?.id ?? '';
      if (sharedControls) {
        incoming.mode = 'merge';
        incoming.container = 'auto';
      }
      if (JSON.stringify(incoming) !== JSON.stringify(state)) {
        Object.assign(state, incoming);
        update();
      }
    } catch {
      // A transient read failure must not erase the current explicit selection.
    } finally {
      scheduleSync();
    }
  };
  if (task?.downloads) {
    const selectors = [quality, preference];
    selectors.forEach((element) => {
      element.disabled = true;
    });
    controls?.select(null, false);
    preferenceStatus.textContent = uiText('E1637');
    void Promise.resolve()
      .then(async () => {
        const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (currentPanel() && settings.ok && editGeneration === 0)
          state.preference = normalizePreference(settings.data?.download?.preference);
        return chrome.runtime.sendMessage({
          type: 'GET_YOUTUBE_SELECTION',
          videoId: state.videoId,
          ...(task.tabId === undefined ? {} : { tabId: task.tabId }),
        });
      })
      .then((result) => {
        if (!result.ok) throw new Error('SELECTION_LOOKUP_FAILED');
        if (!host.contains(group) || drafts.get(host) !== state) return;
        if (result.data !== null) {
          const restored = readYouTubeDraft(result.data);
          if (!restored || restored.videoId !== state.videoId)
            throw new Error('SELECTION_LOOKUP_INVALID');
          Object.assign(state, restored);
        }
        preferenceStatus.textContent = '';
      })
      .catch(() => {
        preferenceStatus.textContent = uiText('E1638');
      })
      .finally(() => {
        selectors.forEach((element) => {
          element.disabled = false;
        });
        if (host.contains(group) && drafts.get(host) === state) update();
        scheduleSync();
      });
  }
}
