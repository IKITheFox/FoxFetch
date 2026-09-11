import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../../shared/constants';
import { appSettingsSchema } from '../../shared/schemas';
import type { AppSettings } from '../../shared/types';
import { mergeDeepSettings } from '../../shared/utils';
import { mergeSettingsDraft } from './settings-ui';
import { normalizeVersion22Settings } from '../../shared/settings-normalize';

const LEGACY_DEFAULT_FILENAME_TEMPLATE = '{title}-{index}';
const FILENAME_TEMPLATE_MIGRATION_KEY = 'foxfetch:settings-migration:title-template-v1';

function storedFilenameTemplate(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const download = (value as { download?: unknown }).download;
  if (download == null || typeof download !== 'object') return undefined;
  const template = (download as { filenameTemplate?: unknown }).filenameTemplate;
  return typeof template === 'string' ? template : undefined;
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await chrome.storage.sync.get([SETTINGS_KEY, FILENAME_TEMPLATE_MIGRATION_KEY]);
  const value = stored[SETTINGS_KEY];
  const merged = mergeDeepSettings(DEFAULT_SETTINGS, (value ?? {}) as Partial<AppSettings>);
  const parsed = appSettingsSchema.safeParse(normalizeVersion22Settings(merged));
  let settings = parsed.success ? parsed.data : DEFAULT_SETTINGS;

  if (stored[FILENAME_TEMPLATE_MIGRATION_KEY] !== true) {
    const migrateLegacyDefault = storedFilenameTemplate(value) === LEGACY_DEFAULT_FILENAME_TEMPLATE;
    if (migrateLegacyDefault) {
      settings = {
        ...settings,
        download: {
          ...settings.download,
          filenameTemplate: DEFAULT_SETTINGS.download.filenameTemplate,
        },
      };
    }
    await chrome.storage.sync.set({
      ...(migrateLegacyDefault ? { [SETTINGS_KEY]: settings } : {}),
      [FILENAME_TEMPLATE_MIGRATION_KEY]: true,
    });
  }

  // Existing site save choices remain authoritative during the UI migration.
  const local = await chrome.storage.local?.get('foxfetch:video-save-policy');
  const mode = (local?.['foxfetch:video-save-policy'] as { mode?: string } | undefined)?.mode;
  if (mode === 'ask' || mode === 'automatic')
    settings = { ...settings, download: { ...settings.download, saveAs: mode === 'ask' } };
  return settings;
}

let saving: Promise<unknown> = Promise.resolve();
export function saveSettings(
  patch: Partial<AppSettings>,
  base?: AppSettings,
): Promise<AppSettings> {
  const operation = saving.then(async () => {
    const current = await getSettings();
    const next = appSettingsSchema.parse(
      normalizeVersion22Settings(
        base
          ? mergeSettingsDraft(base, mergeDeepSettings(base, patch), current)
          : mergeDeepSettings(current, patch),
      ),
    );
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    if (patch.download?.saveAs !== undefined)
      await chrome.storage.local?.set({
        'foxfetch:video-save-policy': { mode: next.download.saveAs ? 'ask' : 'automatic' },
      });
    return next;
  });
  saving = operation.catch(() => undefined);
  return operation;
}
