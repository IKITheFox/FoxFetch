import { expect, it } from 'vitest';
import { youTubeLanguageLabel } from '../../src/modules/youtube/language-label';

it('shows readable names without discarding source language codes', () => {
  expect(youTubeLanguageLabel('en')).toBe('英语（en）');
  expect(youTubeLanguageLabel('ja')).toBe('日语（ja）');
  expect(youTubeLanguageLabel('pt-br')).toContain('（pt-BR）');
  expect(youTubeLanguageLabel('zh-Hant')).toContain('（zh-Hant）');
});

it('does not interpret track identities or unknown metadata as a language', () => {
  for (const value of [undefined, '', 'und', 'en.4', '<script>']) {
    expect(youTubeLanguageLabel(value)).toBe('语言未知');
  }
});
