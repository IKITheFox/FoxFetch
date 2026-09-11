import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSettings, saveSettings } from '../../src/modules/storage/settings';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../../src/shared/constants';
import type { AppSettings } from '../../src/shared/types';

const MIGRATION_KEY = 'foxfetch:settings-migration:title-template-v1';
const originalChrome = globalThis.chrome;

afterEach(() => {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: originalChrome,
  });
});

function installSettingsStorage(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const get = vi.fn(async (keys?: string | string[] | null) => {
    if (typeof keys === 'string') return { [keys]: values[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    }
    return { ...values };
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(values, items);
  });
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { storage: { sync: { get, set } } },
  });
  return { values, get, set };
}

describe('settings filename-template migration', () => {
  it('uses the page title alone for new installations', async () => {
    const storage = installSettingsStorage();

    await expect(getSettings()).resolves.toMatchObject({
      download: { filenameTemplate: '{title}' },
    });
    expect(storage.values[MIGRATION_KEY]).toBe(true);
    expect(storage.values[SETTINGS_KEY]).toBeUndefined();
  });

  it('migrates the legacy default once while preserving the other settings', async () => {
    const legacy: AppSettings = {
      ...DEFAULT_SETTINGS,
      themeMode: 'dark',
      download: {
        ...DEFAULT_SETTINGS.download,
        concurrentDownloads: 6,
        filenameTemplate: '{title}-{index}',
      },
    };
    const storage = installSettingsStorage({ [SETTINGS_KEY]: legacy });

    await expect(getSettings()).resolves.toMatchObject({
      themeMode: 'dark',
      download: { concurrentDownloads: 6, filenameTemplate: '{title}' },
    });
    expect(storage.values[SETTINGS_KEY]).toMatchObject({
      themeMode: 'dark',
      download: { concurrentDownloads: 6, filenameTemplate: '{title}' },
    });
    expect(storage.values[MIGRATION_KEY]).toBe(true);

    storage.set.mockClear();
    await getSettings();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('ignores the retired custom template without destructively rewriting its stored value on read', async () => {
    const custom: AppSettings = {
      ...DEFAULT_SETTINGS,
      download: {
        ...DEFAULT_SETTINGS.download,
        filenameTemplate: '{title}-自定义-{index}',
      },
    };
    const storage = installSettingsStorage({ [SETTINGS_KEY]: custom });

    await expect(getSettings()).resolves.toMatchObject({
      download: { filenameTemplate: '{title}' },
    });
    expect(storage.values[SETTINGS_KEY]).toEqual(custom);
    expect(storage.set).toHaveBeenCalledWith({ [MIGRATION_KEY]: true });
  });

  it('normalizes the retired template on every subsequent save', async () => {
    const storage = installSettingsStorage({ [MIGRATION_KEY]: true });

    const saved = await saveSettings({
      download: {
        ...DEFAULT_SETTINGS.download,
        filenameTemplate: '{title}-{index}',
      },
    });

    expect(saved.download.filenameTemplate).toBe('{title}');
    await expect(getSettings()).resolves.toMatchObject({
      download: { filenameTemplate: '{title}' },
    });
    expect(storage.values[SETTINGS_KEY]).toMatchObject({
      download: { filenameTemplate: '{title}' },
    });
  });
});
