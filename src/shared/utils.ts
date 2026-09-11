import { MEDIA_EXTENSIONS } from './constants';
import type { MediaAsset, MediaKind } from './types';

export function stableId(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function extensionFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split('/').pop() ?? '';
    const dot = lastSegment.lastIndexOf('.');
    if (dot < 0 || dot === lastSegment.length - 1) return undefined;
    return lastSegment.slice(dot + 1).toLowerCase();
  } catch {
    return undefined;
  }
}

const MIME_EXTENSION_MAP: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mp2t': 'ts',
  'video/x-flv': 'flv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
};

export function extensionFromMime(mime?: string): string | undefined {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized ? MIME_EXTENSION_MAP[normalized] : undefined;
}

/**
 * Merge duplicate discoveries without letting a filename-style URL suffix
 * override the stronger content type reported by the browser or server.
 */
export function mergeMediaAssets(target: MediaAsset, incoming: MediaAsset): MediaAsset {
  const incomingMimeExtension = extensionFromMime(incoming.mime);
  const targetMimeExtension = extensionFromMime(target.mime);
  const mime = incomingMimeExtension
    ? incoming.mime
    : targetMimeExtension
      ? target.mime
      : (incoming.mime ?? target.mime);
  const extension =
    incomingMimeExtension ?? targetMimeExtension ?? incoming.extension ?? target.extension;
  const observationTimes = [target.lastObservedAt, incoming.lastObservedAt].filter(
    (value): value is number => Number.isFinite(value),
  );
  const lastObservedAt = observationTimes.length > 0 ? Math.max(...observationTimes) : undefined;

  return {
    ...target,
    ...incoming,
    ...(mime ? { mime } : {}),
    ...(extension ? { extension } : {}),
    detectedBy: [...new Set([...target.detectedBy, ...incoming.detectedBy])],
    discoveredAt: Math.min(target.discoveredAt, incoming.discoveredAt),
    ...(lastObservedAt == null ? {} : { lastObservedAt }),
  };
}

export function basenameFromPath(input: string): string {
  return input.split(/[\\/]/u).pop() || input;
}

export function classifyMedia(url: string, mime = ''): MediaKind | undefined {
  const normalizedMime = mime.toLowerCase();
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime.includes('mpegurl') || normalizedMime.includes('dash+xml')) return 'playlist';

  const extension = extensionFromUrl(url);
  if (!extension) return undefined;
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(extension)) return kind as MediaKind;
  }
  return undefined;
}

export function sanitizeFilename(input: string, fallback = 'foxfetch-media'): string {
  const cleaned = input
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

export function filenameFromUrl(url: string, fallback: string): string {
  try {
    const raw = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return sanitizeFilename(raw || fallback, fallback);
  } catch {
    return sanitizeFilename(fallback);
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function clampRate(rate: number): number {
  return Math.min(16, Math.max(0.0625, Math.round(rate * 100) / 100));
}

export function mergeDeepSettings<T extends object>(base: T, patch: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      const baseValue = result[key];
      result[key] = mergeDeepSettings(
        (baseValue != null && typeof baseValue === 'object' ? baseValue : {}) as object,
        value as object,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}
