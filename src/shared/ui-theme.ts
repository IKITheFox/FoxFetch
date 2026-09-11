import { SETTINGS_KEY } from './constants';
import type { ThemeMode } from './types';

export type ResolvedTheme = 'light' | 'dark';

function themeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

/** Seed hooks from the preference already applied before React mounts. */
export function initialUiThemeMode(): ThemeMode {
  return themeMode(document.documentElement.dataset.themeMode);
}

export function applyUiTheme(
  mode: ThemeMode,
  systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches,
): ResolvedTheme {
  const resolved = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

/** Read only the saved appearance preference; do not migrate or write settings. */
export async function initializeUiTheme(): Promise<ThemeMode> {
  let mode: ThemeMode = 'auto';
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    mode = themeMode((stored[SETTINGS_KEY] as { themeMode?: unknown } | undefined)?.themeMode);
  } catch {
    // A denied/unavailable store still has a deterministic system-theme fallback.
  }
  applyUiTheme(mode);
  // The HTML curtain is present before styles/scripts load. Reveal the surface
  // only after its explicit preference (or deterministic fallback) is applied.
  if (document.documentElement.hasAttribute('data-ui-theme-pending')) {
    document.documentElement.style.removeProperty('visibility');
    document.documentElement.style.removeProperty('background');
  }
  delete document.documentElement.dataset.uiThemePending;
  document.documentElement.dataset.uiThemeReady = 'true';
  return mode;
}
