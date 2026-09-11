import { messages, type MessageKey } from './catalog';
import { getLanguage, t } from './index';

const exact = new Map<string, MessageKey>();
const templates: Array<{ key: MessageKey; pattern: RegExp; names: string[] }> = [];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [key, pair] of Object.entries(messages)) {
  if (!/[一-龥]/.test(pair[0])) continue;
  const names: string[] = [];
  let position = 0;
  let pattern = '^';
  for (const match of pair[0].matchAll(/\{([A-Za-z]\w*)\}/g)) {
    pattern += escape(pair[0].slice(position, match.index)) + '([\\s\\S]*?)';
    names.push(match[1]!);
    position = match.index + match[0].length;
  }
  if (!names.length) exact.set(pair[0], key as MessageKey);
  else if (pair[0].replace(/\{[^}]*\}/g, '').length >= 4) {
    pattern += escape(pair[0].slice(position)) + '$';
    templates.push({ key: key as MessageKey, pattern: new RegExp(pattern), names });
  }
}

/** Compatibility boundary for extension-generated notices only. Never pass titles or paths. */
export function messageText(value: string): string {
  if (getLanguage() !== 'en') return value;
  const key = exact.get(value.trim());
  if (key) return t(key);
  for (const item of templates) {
    const match = item.pattern.exec(value);
    if (match)
      return t(item.key, Object.fromEntries(item.names.map((name, i) => [name, match[i + 1]])));
  }
  return value;
}

/** Browser-protected FoxFetch pages can be the active tab in a detached resource center. */
export function ownedPageTitle(value: string, url?: string): string {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function' && url?.startsWith(chrome.runtime.getURL('/'))
    ? messageText(value)
    : value;
}
