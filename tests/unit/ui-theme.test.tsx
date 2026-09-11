import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Brand } from '../../src/components/Brand';
import { useTheme } from '../../src/hooks/useTheme';
import { SETTINGS_KEY } from '../../src/shared/constants';
import { applyUiTheme, initialUiThemeMode, initializeUiTheme } from '../../src/shared/ui-theme';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
  delete document.documentElement.dataset.uiThemeReady;
  delete document.documentElement.dataset.uiThemePending;
  vi.unstubAllGlobals();
});

describe('UI theme initialization', () => {
  it.each([
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['auto', true, 'dark'],
    ['auto', false, 'light'],
  ] as const)('resolves %s with system dark=%s to %s', (mode, systemDark, resolved) => {
    expect(applyUiTheme(mode, systemDark)).toBe(resolved);
    expect(document.documentElement.dataset.theme).toBe(resolved);
    expect(document.documentElement.style.colorScheme).toBe(resolved);
    expect(initialUiThemeMode()).toBe(mode);
  });

  it('reads sync preferences before mounting a brand and seeds the first hook render', async () => {
    const get = vi.fn().mockResolvedValue({ [SETTINGS_KEY]: { themeMode: 'dark' } });
    vi.stubGlobal('chrome', { storage: { sync: { get } } });
    document.documentElement.dataset.uiThemePending = '';
    expect(await initializeUiTheme()).toBe('dark');
    expect(document.documentElement.hasAttribute('data-ui-theme-pending')).toBe(false);
    expect(document.documentElement.dataset.uiThemeReady).toBe('true');
    expect(get).toHaveBeenCalledWith(SETTINGS_KEY);
    const firstRenderThemes: string[] = [];
    function FirstBrand() {
      useTheme(initialUiThemeMode());
      firstRenderThemes.push(document.documentElement.dataset.theme!);
      return <Brand />;
    }
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<FirstBrand />));
    expect(firstRenderThemes.every((theme) => theme === 'dark')).toBe(true);
    expect(host.querySelectorAll('img[draggable="false"]')).toHaveLength(2);
  });

  it('uses a deterministic automatic fallback when the settings read fails', async () => {
    vi.stubGlobal('chrome', {
      storage: { sync: { get: vi.fn().mockRejectedValue(new Error('offline')) } },
    });
    expect(await initializeUiTheme()).toBe('auto');
    expect(document.documentElement.dataset.themeMode).toBe('auto');
  });
});
