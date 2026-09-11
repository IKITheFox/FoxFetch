import type { AppSettings } from './types';

/** Normalize retired/new fields before validation; never reset unrelated preferences. */
export function normalizeVersion22Settings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    uiLanguage: settings.uiLanguage === 'en' ? 'en' : 'zh-CN',
    download: {
      ...settings.download,
      filenameTemplate: '{title}',
      preference:
        settings.download.preference === 'quality' || settings.download.preference === 'size'
          ? settings.download.preference
          : 'compatibility',
    },
  };
}
