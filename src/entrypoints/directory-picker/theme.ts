import { SETTINGS_KEY } from '../../shared/constants';
import { updateLocalizedMarkup } from '../../shared/i18n/markup';
import { subscribeLanguage } from '../../shared/i18n';
import { applyUiTheme, initializeUiTheme } from '../../shared/ui-theme';
import type { ThemeMode } from '../../shared/types';

/** Observe appearance only. Directory authorization never migrates or writes settings. */
export async function startDirectoryPickerTheme(): Promise<() => void> {
  updateLocalizedMarkup(document);
  const stopLanguage = subscribeLanguage(() => updateLocalizedMarkup(document));
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let selected: ThemeMode | undefined;
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'sync' || !(SETTINGS_KEY in changes)) return;
    const value = (changes[SETTINGS_KEY]?.newValue as { themeMode?: unknown } | undefined)
      ?.themeMode;
    selected = value === 'light' || value === 'dark' ? value : 'auto';
    applyUiTheme(selected, system.matches);
  };
  const onSystem = () => {
    if (selected !== undefined) applyUiTheme(selected, system.matches);
  };
  chrome.storage.onChanged.addListener(onStorage);
  system.addEventListener('change', onSystem);
  const initial = await initializeUiTheme();
  // A live preference update can arrive while the initial storage read waits.
  selected ??= initial;
  applyUiTheme(selected, system.matches);
  return () => {
    stopLanguage();
    chrome.storage.onChanged.removeListener(onStorage);
    system.removeEventListener('change', onSystem);
  };
}
