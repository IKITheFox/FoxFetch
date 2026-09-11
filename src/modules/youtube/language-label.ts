import { t as uiText } from '../../shared/i18n';
import { getLanguage } from '../../shared/i18n';
/** Presentation only: never use a translated label as an audio-track identity. */
export function youTubeLanguageLabel(language?: string): string {
  if (!language || language === 'und') return uiText('E1577');
  try {
    const [canonical] = Intl.getCanonicalLocales(language);
    if (!canonical) return uiText('E1577');
    const name = new Intl.DisplayNames([getLanguage()], { type: 'language', fallback: 'none' }).of(
      canonical,
    );
    return name
      ? getLanguage() === 'en'
        ? `${name} (${canonical})`
        : `${name}（${canonical}）`
      : uiText('E1578', { p1: canonical });
  } catch {
    return uiText('E1577');
  }
}
