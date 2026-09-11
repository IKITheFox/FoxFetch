import { afterEach, expect, it } from 'vitest';
import { messages } from '../../src/shared/i18n/catalog';
import {
  t,
  setLanguage,
  getLanguage,
  getSavedLanguage,
  previewLanguage,
} from '../../src/shared/i18n';
import { messageText } from '../../src/shared/i18n/legacy-message';
import { updateLocalizedMarkup } from '../../src/shared/i18n/markup';
import { normalizeVersion22Settings } from '../../src/shared/settings-normalize';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { mergeSettingsDraft } from '../../src/modules/storage/settings-ui';
import { youTubeLanguageLabel } from '../../src/modules/youtube/language-label';

afterEach(() => {
  previewLanguage(undefined);
  setLanguage('zh-CN');
});
it('keeps draft language separate from the saved choice', () => {
  previewLanguage('en');
  expect(getLanguage()).toBe('en');
  expect(getSavedLanguage()).toBe('zh-CN');
  expect(t('theme.auto')).toBe('Current theme: System');
  previewLanguage(undefined);
  expect(t('theme.auto')).toBe('当前主题：跟随系统');
});
it('has matching parameters and English text in every catalog pair', () => {
  const parameters = (value: string) =>
    [...value.matchAll(/\{([A-Za-z]\w*)\}/g)].map((m) => m[1]).sort();
  for (const [key, [zh, en]] of Object.entries(messages)) {
    expect(en, key).not.toMatch(/[一-龥]/);
    expect(parameters(en), key).toEqual(parameters(zh));
  }
});
it('translates explicitly marked labels without touching titles or filenames', () => {
  const root = document.createElement('div');
  root.innerHTML = '<span data-i18n="language.label">语言</span><strong>视频标题 中文.mp4</strong>';
  setLanguage('en');
  updateLocalizedMarkup(root);
  expect(root.querySelector('span')?.textContent).toBe('Language');
  expect(root.querySelector('strong')?.textContent).toBe('视频标题 中文.mp4');
  expect(youTubeLanguageLabel('en')).toBe('English (en)');
});
it('translates known notices and preserves interpolated data', () => {
  setLanguage('en');
  expect(messageText('下载连接失败，请检查网络后重新下载。')).not.toMatch(/[一-龥]/);
  expect(t('cache.failed', { reason: 'RAW_CODE' })).toContain('RAW_CODE');
});
it('ignores the retired filename setting and merges unrelated concurrent changes', () => {
  const base = structuredClone(DEFAULT_SETTINGS);
  const draft = { ...base, uiLanguage: 'en' as const };
  const current = { ...base, themeMode: 'dark' as const };
  expect(mergeSettingsDraft(base, draft, current)).toMatchObject({
    uiLanguage: 'en',
    themeMode: 'dark',
  });
  expect(
    normalizeVersion22Settings({
      ...base,
      download: { ...base.download, filenameTemplate: '../old/{index}' },
    }).download.filenameTemplate,
  ).toBe('{title}');
});
