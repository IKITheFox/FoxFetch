type KnownMediaPlatform = 'bilibili' | 'youtube';

const BILIBILI_HOST = /(?:^|\.)bilibili\.com$/iu;
const YOUTUBE_HOST = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/iu;
const PLATFORM_SEPARATOR = String.raw`\s*[-\u2013\u2014_|\u00b7]\s*`;
const OPTIONAL_CACHE_MARKER = String.raw`(?:\s*[-_]\s*cache)?`;

const PLATFORM_TITLE_SUFFIXES: Readonly<Record<KnownMediaPlatform, RegExp>> = {
  bilibili: new RegExp(
    String.raw`(?:${PLATFORM_SEPARATOR})(?:\u54d4\u54e9\u54d4\u54e9(?:[\s_-]*bilibili)?|bilibili)${OPTIONAL_CACHE_MARKER}\s*$`,
    'iu',
  ),
  youtube: new RegExp(
    String.raw`(?:${PLATFORM_SEPARATOR})youtube(?:\s+music)?${OPTIONAL_CACHE_MARKER}\s*$`,
    'iu',
  ),
};

function mediaPlatform(pageUrl: string): KnownMediaPlatform | undefined {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    if (BILIBILI_HOST.test(hostname)) return 'bilibili';
    if (YOUTUBE_HOST.test(hostname)) return 'youtube';
  } catch {
    // An invalid or unavailable page URL must never make title cleanup destructive.
  }
  return undefined;
}

/**
 * Removes only provider-owned browser-title chrome from a known media site.
 *
 * A visible separator is deliberately required before the provider marker, so
 * titles whose actual subject ends in "Bilibili", "YouTube", or "cache" are
 * left intact. The optional cache marker is removed only when it follows that
 * provider marker, matching legacy names such as
 * `Video_哔哩哔哩_bilibili-cache` without treating `CPU-cache` as metadata.
 */
export function normalizeMediaTitle(pageTitle: string, pageUrl: string): string {
  const title = pageTitle.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const platform = mediaPlatform(pageUrl);
  if (!platform || !title) return title;
  return title.replace(PLATFORM_TITLE_SUFFIXES[platform], '').trim();
}
