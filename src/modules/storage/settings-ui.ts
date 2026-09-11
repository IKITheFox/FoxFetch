import { t as uiText } from '../../shared/i18n';
import type { AppSettings } from '../../shared/types';
import { normalizeVersion22Settings } from '../../shared/settings-normalize';
export function permissionSummary(origins: string[]): string {
  if (
    origins.includes('<all_urls>') ||
    (origins.includes('http://*/*') && origins.includes('https://*/*'))
  )
    return uiText('E1557');
  if (!origins.length) return uiText('E1558');
  const groups = new Set<string>();
  for (const origin of origins) {
    const host = /^https?:\/\/(?:\*\.)?([^/]+)\//.exec(origin)?.[1];
    if (!host || host === '*') return uiText('E1559');
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/.test(host))
      groups.add('youtube');
    else if (/(^|\.)(bilibili\.com|bilivideo\.com|hdslb\.com)$/.test(host)) groups.add('bilibili');
    else return uiText('E1559');
  }
  return uiText('E1560', { p1: groups.size });
}
export function settingsValidation(s: AppSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (
    !Number.isFinite(s.playback.defaultRate) ||
    s.playback.defaultRate < 0.0625 ||
    s.playback.defaultRate > 16
  )
    errors.rate = uiText('E1561');
  if (!Number.isFinite(s.playback.seekStep) || s.playback.seekStep < 1 || s.playback.seekStep > 120)
    errors.seek = uiText('E1562');
  const { concurrentDownloads: count } = s.download;
  if (!Number.isInteger(count) || count < 1 || count > 8) errors.count = uiText('E1563');
  return errors;
}
export function mergeSettingsDraft(
  base: AppSettings,
  draft: AppSettings,
  current: AppSettings,
): AppSettings {
  const merge = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    c: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out = { ...c };
    for (const key of Object.keys(b)) {
      if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
      if (b[key] && typeof b[key] === 'object')
        out[key] = merge(
          (a[key] ?? {}) as Record<string, unknown>,
          b[key] as Record<string, unknown>,
          (c[key] ?? {}) as Record<string, unknown>,
        );
      else {
        if (
          JSON.stringify(a[key]) !== JSON.stringify(c[key]) &&
          JSON.stringify(b[key]) !== JSON.stringify(c[key])
        )
          throw new Error(uiText('E1567'));
        out[key] = b[key];
      }
    }
    return out;
  };
  return merge(
    normalizeVersion22Settings(base) as unknown as Record<string, unknown>,
    normalizeVersion22Settings(draft) as unknown as Record<string, unknown>,
    normalizeVersion22Settings(current) as unknown as Record<string, unknown>,
  ) as unknown as AppSettings;
}
