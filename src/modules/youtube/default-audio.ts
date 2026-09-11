import type { YouTubeCandidate } from './inspection';
import { youTubeCodecs, youTubeContainer } from './selection';

/** Match within one language/role group; compatibility never changes that group. */
export function matchYouTubeAudio(
  candidates: readonly YouTubeCandidate[],
  video?: YouTubeCandidate,
): YouTubeCandidate | undefined {
  if (!video || video.composition === 'muxed') return undefined;
  const tracks = candidates.filter((c) => c.kind === 'audio' && c.composition === 'separate');
  const anchor = tracks.find((c) => c.defaultAudio) ?? tracks[0];
  if (!anchor) return undefined;
  const group = (c: YouTubeCandidate) =>
    JSON.stringify([c.audioTrackId ?? '', c.language ?? '', c.audioTrackName ?? '']);
  const videoCodec = youTubeCodecs(video.mime).video;
  const compatible = (c: YouTubeCandidate) => {
    const audioCodec = youTubeCodecs(c.mime).audio;
    return !!videoCodec && !!audioCodec && !!youTubeContainer(videoCodec, audioCodec);
  };
  const quality = (c: YouTubeCandidate) =>
    c.size && c.duration && c.size > 0 && c.duration > 0 ? c.size / c.duration : undefined;
  return tracks
    .filter((c) => group(c) === group(anchor) && c.source !== 'drm' && youTubeCodecs(c.mime).audio)
    .sort((a, b) => {
      const compatibility = Number(compatible(b)) - Number(compatible(a));
      if (compatibility) return compatibility;
      const aq = quality(a),
        bq = quality(b);
      return (
        (aq !== undefined && bq !== undefined ? bq - aq : 0) ||
        Number(!!b.defaultAudio) - Number(!!a.defaultAudio)
      );
    })[0];
}
