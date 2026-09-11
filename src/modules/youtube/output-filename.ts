/** YouTube-only naming. Source format wins over extensions found in the title. */
export function buildYouTubeOutputFilename(
  videoId: string,
  sourceName: string,
  kind: 'merged' | 'video' | 'audio',
  title?: string,
): string {
  if (!/^[\w-]{11}$/u.test(videoId) || !/^(?:video|audio)\.(?:mp4|m4a|webm)$/u.test(sourceName))
    throw new Error('OUTPUT_FILENAME_INVALID');
  const directory = 'FoxFetch/YouTube/';
  if (!title?.trim()) return `${directory}${videoId}-${sourceName}`;
  const cleaned = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, '');
  // Bound UTF-8 bytes as well as UTF-16 length without splitting a surrogate pair.
  const encoder = new TextEncoder();
  let base = '',
    bytes = 0;
  for (const char of cleaned) {
    const size = encoder.encode(char).length;
    if (bytes + size > 180 || base.length + char.length > 120) break;
    base += char;
    bytes += size;
  }
  base = base.replace(/[. ]+$/gu, '') || `FoxFetch-${videoId}`;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base)) base = `_${base}`;
  const extension = sourceName.split('.').at(-1)!;
  const suffix = kind === 'merged' ? '' : kind === 'video' ? '-视频' : '-音频';
  return `${directory}${base}${suffix}.${extension}`;
}
