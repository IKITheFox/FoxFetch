import { t as uiText } from './i18n';
export type MediaPlatformKind =
  | 'bilibili'
  | 'douyin'
  | 'iqiyi'
  | 'tencent'
  | 'tiktok'
  | 'vimeo'
  | 'youku'
  | 'youtube'
  | 'generic';

export interface MediaPlatformView {
  kind: MediaPlatformKind;
  label: string;
}

const PLATFORM_LABELS: Readonly<Record<MediaPlatformKind, string>> = {
  get bilibili() {
    return uiText('E1805');
  },
  get douyin() {
    return uiText('E1806');
  },
  get iqiyi() {
    return uiText('E1807');
  },
  get tencent() {
    return uiText('E1808');
  },
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
  get youku() {
    return uiText('E1809');
  },
  youtube: 'YouTube',
  get generic() {
    return uiText('E1810');
  },
};

function sourceHostname(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (!normalized) return '';
  try {
    return new URL(
      /^[a-z][a-z\d+.-]*:/iu.test(normalized) ? normalized : `https://${normalized}`,
    ).hostname.replace(/^www\./u, '');
  } catch {
    return normalized.replace(/^www\./u, '').split(/[/:?#]/u, 1)[0] ?? '';
  }
}

/** One platform-name mapping shared by Popup, Side Panel, and the in-page Dock. */
export function mediaPlatformFromSource(source?: string): MediaPlatformKind {
  const literal = source?.trim().toLowerCase();
  if (literal && Object.hasOwn(PLATFORM_LABELS, literal)) return literal as MediaPlatformKind;
  const host = sourceHostname(source ?? '');
  if (/(?:^|\.)(?:bilibili\.com|bilivideo\.com)$|^b23\.tv$/u.test(host)) {
    return 'bilibili';
  }
  if (/(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|googlevideo\.com)$|^youtu\.be$/u.test(host)) {
    return 'youtube';
  }
  if (/(?:^|\.)douyin\.com$/u.test(host)) return 'douyin';
  if (/(?:^|\.)tiktok\.com$/u.test(host)) return 'tiktok';
  if (/(?:^|\.)vimeo\.com$/u.test(host)) return 'vimeo';
  if (/(?:^|\.)youku\.com$/u.test(host)) return 'youku';
  if (/(?:^|\.)iqiyi\.com$/u.test(host)) return 'iqiyi';
  if (/(?:^|\.)(?:v\.qq\.com|video\.qq\.com)$/u.test(host)) return 'tencent';
  return 'generic';
}

export function mediaPlatformLabel(platform: MediaPlatformKind): string {
  return PLATFORM_LABELS[platform];
}

export function mediaPlatformView(source?: string): MediaPlatformView {
  const kind = mediaPlatformFromSource(source);
  return { kind, label: mediaPlatformLabel(kind) };
}
