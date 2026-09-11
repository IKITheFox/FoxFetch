import type { MediaKind } from '../../shared/types';

export const DOWNLOAD_ROOT_DIRECTORY = 'FoxFetch';

export type DownloadFilePickerPurpose = 'merge' | 'cache-merge';

const PLATFORM_HOSTS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|\.)bilibili\.com$/iu, 'bilibili'],
  [/(?:^|\.)bilivideo\.com$/iu, 'bilibili'],
  [/(?:^|\.)youtube\.com$/iu, 'youtube'],
  [/(?:^|\.)youtube-nocookie\.com$/iu, 'youtube'],
  [/(?:^|\.)youtu\.be$/iu, 'youtube'],
  [/(?:^|\.)vimeo\.com$/iu, 'vimeo'],
  [/(?:^|\.)douyin\.com$/iu, 'douyin'],
  [/(?:^|\.)tiktok\.com$/iu, 'tiktok'],
  [/(?:^|\.)x\.com$/iu, 'x'],
  [/(?:^|\.)twitter\.com$/iu, 'x'],
];

function asciiDirectorySegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^www\./u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return normalized || fallback;
}

/** Resolve an English/ASCII platform directory from the page that owns the media. */
export function downloadPlatformDirectory(pageUrl: string): string {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    const known = PLATFORM_HOSTS.find(([pattern]) => pattern.test(hostname));
    if (known) return known[1];
    return asciiDirectorySegment(hostname, 'web');
  } catch {
    return 'web';
  }
}

export function buildDownloadDirectory(pageUrl: string, _kind: MediaKind): string {
  const platform = downloadPlatformDirectory(pageUrl);
  return `${DOWNLOAD_ROOT_DIRECTORY}/${platform === 'youtube' ? 'YouTube' : platform === 'bilibili' ? 'Bilibili' : platform}`;
}

/** Human-facing absolute-style label; chrome.downloads itself must receive the relative path. */
export function displayDownloadDirectory(pageUrl: string, kind: MediaKind): string {
  return `Downloads/${buildDownloadDirectory(pageUrl, kind)}`;
}

/**
 * File System Access cannot be pointed at an unapproved nested path. A stable,
 * platform-scoped picker id lets Chrome remember the directory the user chose
 * for this purpose, while `startIn: 'downloads'` remains the first-use fallback.
 */
export function downloadFilePickerId(pageUrl: string, purpose: DownloadFilePickerPurpose): string {
  const prefix = purpose === 'merge' ? 'ff-merge-' : 'ff-cache-';
  return `${prefix}${downloadPlatformDirectory(pageUrl).toLowerCase()}`
    .slice(0, 32)
    .replace(/-+$/u, '');
}
