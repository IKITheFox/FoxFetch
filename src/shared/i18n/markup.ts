import { t, subscribeLanguage, type MessageKey } from './index';

/** Only build-time-marked extension labels are touched, never page text or titles. */
export function updateLocalizedMarkup(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const previous = node.textContent ?? '';
    node.textContent =
      (previous.match(/^\s*/)?.[0] ?? '') +
      t(node.dataset.i18n as MessageKey) +
      (previous.match(/\s*$/)?.[0] ?? '');
  });
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach((node) => {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`) as MessageKey));
    });
  }
}

/** View lifetime only: observing removal does not inspect or translate DOM text. */
export function subscribeViewLanguage(element: HTMLElement, refresh: () => void): () => void {
  const unsubscribe = subscribeLanguage(refresh);
  const observer = new MutationObserver(() => {
    if (!element.isConnected) dispose();
  });
  const dispose = () => {
    unsubscribe();
    observer.disconnect();
  };
  observer.observe(element.ownerDocument, { childList: true, subtree: true });
  return dispose;
}
