import { t as uiText } from '../../shared/i18n';
import { subscribeLanguage } from '../../shared/i18n';
import { mediaDownloadIcon } from '../../shared/media-download-icon';

const pages = new WeakMap<HTMLElement, { videoId: string; open: boolean }>();
const openers = new WeakMap<
  HTMLElement,
  { videoId: string; open: () => void; close: () => void }
>();
export function closeYouTubeTaskPage(host: HTMLElement): void {
  openers.get(host)?.close();
}
export function openYouTubeTaskPage(host: HTMLElement, videoId: string): boolean {
  const opener = openers.get(host);
  if (!opener || opener.videoId !== videoId || !host.isConnected) return false;
  opener.open();
  return true;
}
/** Navigation only. Opening/returning never creates, cancels, or restarts a task. */
export function mountYouTubeTaskPage(
  host: HTMLElement,
  videoId: string,
  card: HTMLElement,
  group: HTMLElement,
  actionHost: HTMLElement,
  navigation: { backButton?: HTMLButtonElement; backHost?: HTMLElement } = {},
) {
  let state = pages.get(host);
  if (!state || state.videoId !== videoId) {
    state = { videoId, open: false };
    pages.set(host, state);
  }
  const current = state;
  const doc = host.ownerDocument;
  const launch = doc.createElement('button');
  launch.type = 'button';
  launch.className = 'dock-product-trigger media-task-open';
  launch.setAttribute('aria-label', uiText('E1682'));
  launch.innerHTML = mediaDownloadIcon;
  actionHost.append(launch);
  const back = navigation.backButton ?? doc.createElement('button');
  const previousDisplay = back.style.getPropertyValue('display');
  const previousPriority = back.style.getPropertyPriority('display');
  if (!navigation.backButton) {
    back.type = 'button';
    back.className = 'media-task-return';
    back.setAttribute('aria-label', uiText('E1087'));
    back.title = uiText('E1087');
    back.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (navigation.backHost) navigation.backHost.prepend(back);
    else group.prepend(back);
  }
  const cardDisplay = card.style.getPropertyValue('display');
  const cardPriority = card.style.getPropertyPriority('display');
  const groupDisplay = group.style.getPropertyValue('display');
  const groupPriority = group.style.getPropertyPriority('display');
  const paint = (focus = false) => {
    launch.setAttribute('aria-label', uiText('E0018'));
    back.setAttribute('aria-label', uiText('E1087'));
    back.title = uiText('E1087');
    group.style.setProperty('display', current.open ? 'grid' : 'none', 'important');
    group.setAttribute('aria-hidden', String(!current.open));
    if (current.open) card.style.setProperty('display', 'none', 'important');
    else card.style.setProperty('display', cardDisplay, cardPriority);
    host.dataset.youtubeTaskOpen = String(current.open);
    back.style.setProperty('display', current.open ? 'grid' : 'none', 'important');
    if (focus) (current.open ? back : launch).focus();
  };
  const open = () => {
    current.open = true;
    paint(true);
  };
  openers.set(host, {
    videoId,
    open,
    close: () => {
      current.open = false;
      paint();
    },
  });
  launch.addEventListener('click', open);
  const returnToResources = (event: MouseEvent) => {
    event.stopPropagation();
    current.open = false;
    paint(true);
  };
  back.addEventListener('click', returnToResources);
  paint();
  const stopLanguage = subscribeLanguage(() => paint());
  return () => {
    stopLanguage();
    openers.delete(host);
    launch.remove();
    back.removeEventListener('click', returnToResources);
    if (navigation.backButton) back.style.setProperty('display', previousDisplay, previousPriority);
    else back.remove();
    card.style.setProperty('display', cardDisplay, cardPriority);
    group.style.setProperty('display', groupDisplay, groupPriority);
    group.removeAttribute('aria-hidden');
    delete host.dataset.youtubeTaskOpen;
  };
}
