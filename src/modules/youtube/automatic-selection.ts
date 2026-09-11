import type { YouTubeInspection } from './inspection';
import { createYouTubeSelectionPlan, type YouTubeSelectionPlan } from './selection';
import { matchYouTubeAudio } from './default-audio';

export type DownloadPreference = 'compatibility' | 'quality' | 'size';
export const normalizePreference = (value: unknown): DownloadPreference =>
  value === 'quality' || value === 'size' ? value : 'compatibility';
export const resolutionKey = (video: YouTubeSelectionPlan['video']): string =>
  `${video.width ?? '?'}×${video.height ?? '?'} · ${video.fps ?? '?'} fps`;

/** Public metadata only; background must acquire and authorize each selected source. */
export function automaticYouTubePlans(
  view: YouTubeInspection,
  quality: string,
  preference: DownloadPreference,
): YouTubeSelectionPlan[] {
  const plans: YouTubeSelectionPlan[] = [];
  for (const video of view.candidates) {
    if (
      video.kind !== 'video' ||
      (video.source === 'unavailable' && !view.transports.includes('sabr')) ||
      resolutionKey(video) !== quality
    )
      continue;
    const anchor = matchYouTubeAudio(view.candidates, video);
    const audios =
      video.composition === 'muxed'
        ? [undefined]
        : view.candidates.filter(
            (a) =>
              a.kind === 'audio' &&
              anchor &&
              a.language === anchor.language &&
              a.audioTrackId === anchor.audioTrackId &&
              a.audioTrackName === anchor.audioTrackName,
          );
    for (const audio of audios) {
      const result = createYouTubeSelectionPlan(view, {
        videoId: view.videoId ?? '',
        videoTrackId: video.id,
        ...(audio ? { audioTrackId: audio.id } : {}),
        container: 'auto',
        mode: 'merge',
      });
      if (result.ok) plans.push(result.plan);
    }
  }
  const compatibility = (p: YouTubeSelectionPlan) =>
    p.videoCodec === 'avc' && p.audioCodec === 'aac'
      ? 0
      : p.audioCodec === 'aac'
        ? 1
        : p.videoCodec === 'vp9'
          ? 2
          : 3;
  const size = (p: YouTubeSelectionPlan) =>
    p.video.size && (!p.audio || p.audio.size) ? p.video.size + (p.audio?.size ?? 0) : undefined;
  return plans.sort((a, b) => {
    if (preference === 'quality') {
      // At fixed resolution/rate, declared bitrate is a heuristic, not a quality guarantee.
      const rate = (p: YouTubeSelectionPlan) =>
        p.video.size && p.video.duration ? p.video.size / p.video.duration : undefined;
      const x = rate(a),
        y = rate(b);
      if (x !== undefined && y !== undefined && x !== y) return y - x;
    }
    if (preference === 'size') {
      const x = size(a),
        y = size(b);
      if (x !== undefined && y !== undefined && x !== y) return x - y;
      const efficiency = { av1: 0, vp9: 1, avc: 2 };
      if (efficiency[a.videoCodec] !== efficiency[b.videoCodec])
        return efficiency[a.videoCodec] - efficiency[b.videoCodec];
    }
    // Resolution and frame rate are fixed by the explicit user choice. No codec-name quality claim.
    return (
      compatibility(a) - compatibility(b) ||
      (a.audio?.size && b.audio?.size ? b.audio.size - a.audio.size : 0) ||
      Number(!!b.audio?.defaultAudio) - Number(!!a.audio?.defaultAudio) ||
      a.video.id.localeCompare(b.video.id) ||
      (a.audio?.id ?? '').localeCompare(b.audio?.id ?? '')
    );
  });
}

/** Only definite format failures; network, protection, buffer and storage errors are not format evidence. */
export function canTryAnotherFormat(code?: string): boolean {
  return ['SOURCE_FORMAT_UNSUPPORTED', 'CONTAINER_INCOMPATIBLE', 'TRANSCODE_REQUIRED'].includes(
    code ?? '',
  );
}
