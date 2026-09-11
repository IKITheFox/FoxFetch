import { t as uiText } from '../../shared/i18n';
import { youTubeStatusText, type YouTubeInspection, type YouTubeCandidate } from './inspection';
import { disposeYouTubeSelection, renderYouTubeSelection } from './selection-view';
import { createDockMediaCard } from '../../shared/dock-media-card';
import { mountYouTubeTaskPage } from './task-page';
import { mediaArtworkDisplayUrl } from '../media-products/media-artwork';

const previewKeys = new WeakMap<HTMLElement, string>();
function updatePreview(
  preview: HTMLElement,
  view: YouTubeInspection,
  render?: (preview: HTMLElement) => void,
) {
  if (render) {
    render(preview);
    return;
  }
  const poster = mediaArtworkDisplayUrl(view.thumbnail);
  const key = `${view.videoId}:${poster ?? ''}`;
  if (previewKeys.get(preview) === key) return;
  previewKeys.set(preview, key);
  preview.textContent = 'YouTube';
  preview.dataset.artworkStatus = poster ? 'loading' : 'missing';
  if (!poster) return;
  const img = preview.ownerDocument.createElement('img');
  img.src = poster;
  img.alt = uiText('E0015');
  img.referrerPolicy = 'no-referrer';
  img.addEventListener(
    'load',
    () => {
      if (previewKeys.get(preview) === key) preview.dataset.artworkStatus = 'ready';
    },
    { once: true },
  );
  img.addEventListener(
    'error',
    () => {
      if (previewKeys.get(preview) === key) {
        img.remove();
        preview.dataset.artworkStatus = 'failed';
      }
    },
    { once: true },
  );
  preview.append(img);
}

export function youTubeCandidateText(candidate: YouTubeCandidate): string {
  const source = {
    get 'direct-candidate'() {
      return uiText('E1590');
    },
    get signed() {
      return uiText('E1591');
    },
    get drm() {
      return uiText('E1592');
    },
    get unavailable() {
      return uiText('E1593');
    },
  }[candidate.source];
  return [
    candidate.kind === 'audio' ? uiText('E0022') : uiText('E0021'),
    candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : '',
    candidate.fps ? `${candidate.fps} fps` : '',
    candidate.mime,
    candidate.composition === 'muxed' ? uiText('E1594') : uiText('E1595'),
    candidate.language
      ? uiText('E1596', {
          p1: candidate.language,
          p2: candidate.defaultAudio ? uiText('E1597') : '',
        })
      : '',
    candidate.dynamicRange === 'HDR-declared' ? uiText('E1598') : '',
    source,
  ]
    .filter(Boolean)
    .join(' · ');
}

const signatures = new WeakMap<HTMLElement, string>();
const externalQualityFields = new WeakMap<HTMLElement, Element[]>();
const taskPages = new WeakMap<HTMLElement, () => void>();
function clearExternalQualityFields(container: HTMLElement): void {
  externalQualityFields.get(container)?.forEach((field) => field.remove());
  externalQualityFields.delete(container);
}
let cardSequence = 0;
export function disposeYouTubeInspection(container: HTMLElement): void {
  taskPages.get(container)?.();
  taskPages.delete(container);
  disposeYouTubeSelection(container);
  clearExternalQualityFields(container);
  signatures.delete(container);
}
/** Both React surfaces and the page Dock use textContent, never page-owned HTML. */
export function renderYouTubeInspection(
  container: HTMLElement,
  view: YouTubeInspection,
  task?: { downloads?: boolean; tabId?: number },
  layout?: {
    resourceHeader?: boolean;
    sharedControls?: boolean | 'dock';
    dockPreview?: (preview: HTMLElement) => void;
    /** React owns this stable slot; only the moved fields are owned here. */
    qualityHost?: HTMLElement;
    resourceCard?: HTMLElement;
    actionHost?: HTMLElement;
    taskBackButton?: HTMLButtonElement;
    taskBackHost?: HTMLElement;
  },
): void {
  const signature = JSON.stringify([
    { ...view, thumbnail: undefined },
    task,
    {
      resourceHeader: layout?.resourceHeader,
      sharedControls: layout?.sharedControls,
      externalQuality: !!layout?.qualityHost,
      dockPreview: !!layout?.dockPreview,
    },
  ]);
  if (
    signatures.get(container) === signature &&
    (container.firstElementChild?.hasAttribute('data-youtube-heading') ||
      (layout?.resourceHeader === false && container.childElementCount > 0))
  ) {
    for (const preview of container.querySelectorAll<HTMLElement>(
      '.dock-product-preview, .merge-summary-preview',
    ))
      updatePreview(preview, view, layout?.dockPreview);
    return;
  }
  signatures.set(container, signature);
  taskPages.get(container)?.();
  taskPages.delete(container);
  disposeYouTubeSelection(container);
  clearExternalQualityFields(container);
  container.replaceChildren();
  const doc = container.ownerDocument;
  container.dataset.youtubeStatus = view.status;
  container.style.overflowWrap = 'anywhere';
  container.style.whiteSpace = 'normal';
  container.style.minWidth = '0';
  container.style.maxWidth = '100%';
  const title = doc.createElement('h3');
  title.setAttribute('data-youtube-heading', '');
  title.textContent = view.title ?? uiText('E0112');
  if (layout?.dockPreview) {
    const header = createDockMediaCard(
      doc,
      view.title ?? uiText('E0112'),
      `foxfetch-youtube-title-${++cardSequence}`,
    );
    header.card.setAttribute('data-youtube-heading', '');
    header.card.dataset.youtubeVideo = view.videoId ?? '';
    header.fidelityDot.removeAttribute('data-role');
    header.fidelityDot.dataset.state = view.status === 'unplayable' ? 'blocked' : 'checking';
    header.fidelityDot.dataset.verification = 'pending';
    header.fidelityDot.setAttribute('aria-label', youTubeStatusText(view));
    header.fidelityDot.title = youTubeStatusText(view);
    layout.dockPreview(header.preview);
    container.append(header.card);
  } else if (layout?.resourceHeader !== false) container.append(title);
  if (view.thumbnail && layout?.resourceHeader !== false && !layout?.dockPreview) {
    const cover = doc.createElement('img');
    cover.src = view.thumbnail;
    cover.alt = uiText('E0015');
    cover.referrerPolicy = 'no-referrer';
    cover.style.cssText =
      'width:160px;max-width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px';
    cover.addEventListener(
      'error',
      () => {
        cover.hidden = true;
        const fallback = doc.createElement('p');
        fallback.textContent = uiText('E1600');
        cover.after(fallback);
      },
      { once: true },
    );
    container.append(cover);
  }
  const identity = doc.createElement('p');
  identity.textContent = [
    view.videoId,
    view.duration
      ? uiText('E1601', {
          p1: Math.floor(view.duration / 60),
          p2: String(Math.floor(view.duration % 60)).padStart(2, '0'),
        })
      : '',
    uiText('E1602', {
      p1: {
        get watch() {
          return uiText('E1603');
        },
        get shorts() {
          return uiText('E1604');
        },
        get live() {
          return uiText('E1605');
        },
        get embed() {
          return uiText('E1606');
        },
        get other() {
          return uiText('E1607');
        },
      }[view.pageType],
    }),
  ]
    .filter(Boolean)
    .join(' · ');
  const sourceDetails = doc.createElement('details');
  sourceDetails.className = 'merge-diagnostics';
  const sourceSummary = doc.createElement('summary');
  sourceSummary.textContent = uiText('E1608', { p1: view.candidates.length });
  sourceDetails.append(sourceSummary, identity);
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = youTubeStatusText(view);
  container.append(status);
  if (view.transports.length) {
    const transport = doc.createElement('p');
    transport.textContent = uiText('E1609', {
      p1: view.transports
        .map(
          (type) =>
            ({
              get direct() {
                return uiText('E1610');
              },
              get signed() {
                return uiText('E1611');
              },
              sabr: 'SABR',
              dash: 'DASH',
              hls: 'HLS',
              get drm() {
                return uiText('E1612');
              },
            })[type],
        )
        .join(' / '),
    });
    sourceDetails.append(transport);
  }
  if (view.candidates.length) {
    const taskPreview = (preview: HTMLElement) => updatePreview(preview, view, layout?.dockPreview);
    renderYouTubeSelection(container, view, task, layout?.sharedControls, taskPreview);
    if (layout?.qualityHost) {
      const fields = Array.from(container.querySelectorAll('fieldset > label')).slice(0, 2);
      for (const field of fields) {
        field.className = 'media-product-card__quality';
        if (field.firstChild?.nodeType === 3) field.firstChild.remove();
        layout.qualityHost.append(field);
      }
      externalQualityFields.set(container, fields);
    }
    if (layout?.dockPreview) {
      const body = container.querySelector('.dock-product-copy');
      const fields = container.querySelector('fieldset');
      if (body && fields) {
        const variants = doc.createElement('div');
        variants.className = 'dock-product-variants';
        for (const field of Array.from(fields.querySelectorAll(':scope > label')).slice(0, 2)) {
          field.className = 'dock-product-variant';
          // The shared trigger already has an explicit accessible name.
          if (field.firstChild?.nodeType === 3) field.firstChild.remove();
          variants.append(field);
        }
        body.append(variants);
      }
    }
    const list = doc.createElement('ul');
    for (const candidate of view.candidates) {
      const item = doc.createElement('li');
      item.textContent = youTubeCandidateText(candidate);
      item.style.marginBlock = '10px';
      list.append(item);
    }
    sourceDetails.append(list);
  }
  // Discovery data remains internal; production does not expose a candidate browser.
  if (!layout?.sharedControls) container.append(sourceDetails);
  const note = doc.createElement('p');
  note.textContent = task?.downloads ? uiText('E1613') : uiText('E1614');
  if (!layout?.sharedControls) container.append(note);
  if (layout?.sharedControls && view.status === 'identified') status.remove();
  if (layout?.sharedControls && task?.downloads && view.videoId) {
    const card = layout.resourceCard ?? container.querySelector<HTMLElement>('.dock-product');
    const actions = layout.actionHost ?? card?.querySelector<HTMLElement>('.dock-product-actions');
    const group = container.querySelector<HTMLElement>('fieldset');
    if (card && actions && group) {
      sourceDetails.append(status, note);
      taskPages.set(
        container,
        mountYouTubeTaskPage(container, view.videoId, card, group, actions, {
          ...(layout.taskBackButton ? { backButton: layout.taskBackButton } : {}),
          ...(layout.taskBackHost ? { backHost: layout.taskBackHost } : {}),
        }),
      );
    }
  }
}
