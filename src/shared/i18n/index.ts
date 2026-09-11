import { messages, type MessageKey } from './catalog';

export type UiLanguage = 'zh-CN' | 'en';
let saved: UiLanguage = 'zh-CN';
let preview: UiLanguage | undefined;
const listeners = new Set<() => void>();
export const normalizeLanguage = (value: unknown): UiLanguage => (value === 'en' ? 'en' : 'zh-CN');
export const getLanguage = (): UiLanguage => preview ?? saved;
export const getSavedLanguage = (): UiLanguage => saved;
function notify() {
  if (
    typeof document !== 'undefined' &&
    typeof location !== 'undefined' &&
    location.protocol === 'chrome-extension:'
  ) {
    document.documentElement.lang = getLanguage();
    const title = (
      {
        '/settings-float.html': 'surface.settings',
        '/options.html': 'surface.settings',
        '/sidepanel.html': 'surface.resources',
        '/offscreen.html': 'surface.background',
      } as const
    )[location.pathname as '/options.html'];
    if (title) document.title = t(title);
  }
  for (const listener of listeners) listener();
}
export function setLanguage(value: unknown) {
  const next = normalizeLanguage(value);
  if (next !== saved) {
    saved = next;
    notify();
  }
}
/** Settings previews are confined to their document and never persisted here. */
export function previewLanguage(value?: UiLanguage) {
  if (preview !== value) {
    preview = value;
    notify();
  }
}
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
type Params = Readonly<Record<string, unknown>>;
export function t(key: MessageKey, params: Params = {}, language = getLanguage()): string {
  const text = messages[key][language === 'en' ? 1 : 0];
  return text.replace(/\{([A-Za-z]\w*)\}/g, (token, name: string) =>
    Object.hasOwn(params, name) ? String(params[name] ?? '') : token,
  );
}

// Read-only synchronization: writes use the existing settings gateway and its conflict rules.
if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  let changed = false;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'sync' && changes['foxfetch:settings']) {
      changed = true;
      setLanguage(
        (changes['foxfetch:settings'].newValue as { uiLanguage?: unknown } | undefined)?.uiLanguage,
      );
    }
  });
  void chrome.storage.sync
    .get('foxfetch:settings')
    .then((value) => {
      if (!changed)
        setLanguage(
          (value['foxfetch:settings'] as { uiLanguage?: unknown } | undefined)?.uiLanguage,
        );
    })
    .catch(() => undefined);
}

export { type MessageKey };
