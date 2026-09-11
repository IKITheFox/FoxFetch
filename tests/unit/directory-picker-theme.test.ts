import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_KEY } from '../../src/shared/constants';
import { startDirectoryPickerTheme } from '../../src/entrypoints/directory-picker/theme';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
  document.documentElement.removeAttribute('data-ui-theme-pending');
  document.documentElement.removeAttribute('style');
});

function browser(themeMode: string, systemDark: boolean) {
  const systemListeners = new Set<() => void>();
  const storageListeners = new Set<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  >();
  const system = {
    matches: systemDark,
    addEventListener: (_event: string, callback: () => void) => systemListeners.add(callback),
    removeEventListener: (_event: string, callback: () => void) => systemListeners.delete(callback),
  };
  const set = vi.fn();
  vi.stubGlobal('matchMedia', () => system);
  vi.stubGlobal('chrome', {
    storage: {
      sync: { get: vi.fn(async () => ({ [SETTINGS_KEY]: { themeMode } })), set },
      onChanged: {
        addListener: (
          callback: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => storageListeners.add(callback),
        removeListener: (
          callback: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void,
        ) => storageListeners.delete(callback),
      },
    },
  });
  return { system, systemListeners, storageListeners, set };
}

describe('directory picker explicit theme', () => {
  it('keeps initial HTML hidden until the saved theme resolves, then removes the curtain', async () => {
    browser('dark', false);
    let resolve!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.sync.get).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    document.documentElement.dataset.uiThemePending = '';
    document.documentElement.style.visibility = 'hidden';
    document.documentElement.style.background = 'transparent';
    const loading = startDirectoryPickerTheme();
    expect(document.documentElement.style.visibility).toBe('hidden');
    resolve({ [SETTINGS_KEY]: { themeMode: 'dark' } });
    const dispose = await loading;
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.hasAttribute('data-ui-theme-pending')).toBe(false);
    expect(document.documentElement.style.visibility).toBe('');
    expect(document.documentElement.style.background).toBe('');
    dispose();
  });
  it.each([
    ['dark', false],
    ['light', true],
  ] as const)('keeps explicit %s even when system disagrees', async (theme, systemDark) => {
    const mock = browser(theme, systemDark);
    const dispose = await startDirectoryPickerTheme();
    expect(document.documentElement.dataset.theme).toBe(theme);
    mock.system.matches = !systemDark;
    mock.systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(mock.set).not.toHaveBeenCalled();
    dispose();
    expect(mock.storageListeners.size).toBe(0);
    expect(mock.systemListeners.size).toBe(0);
  });
  it('follows system only in auto and applies live plugin preference changes', async () => {
    const mock = browser('auto', true);
    const dispose = await startDirectoryPickerTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    mock.system.matches = false;
    mock.systemListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe('light');
    mock.storageListeners.forEach((listener) =>
      listener({ [SETTINGS_KEY]: { newValue: { themeMode: 'dark' } } }, 'sync'),
    );
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(mock.set).not.toHaveBeenCalled();
    dispose();
  });
});
