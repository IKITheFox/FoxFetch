import type { SabrFormat } from 'googlevideo/shared-types';
import type { YouTubeCandidate } from '../inspection';
import type { YouTubeSelectionPlan } from '../selection';
import { validateSabrSelection } from './sabr';

/** Private acquisition metadata, including exact fps not represented by SabrFormat. */
export type SelectedSabrFormat = SabrFormat & { fps?: number };

/** Resolve exact selected tracks. No "best available" or direct-URL fallback. */
export function bindYouTubeSabrSelection(
  plan: YouTubeSelectionPlan,
  videoId: string,
  formats: SelectedSabrFormat[],
): { video: SelectedSabrFormat; audio: SelectedSabrFormat } {
  if (videoId !== plan.videoId || !plan.audio || plan.video.composition !== 'separate')
    throw new Error('TRACK_IDENTITY_MISMATCH');
  const resolve = (candidate: Readonly<YouTubeCandidate>): SelectedSabrFormat => {
    // A source without version metadata cannot be safely refreshed into a plan.
    if (!candidate.sourceVersion) throw new Error('SOURCE_IDENTITY_UNVERIFIED');
    const itag = Number(candidate.id.split(':')[0]);
    const matching = formats.filter(
      (f) =>
        f.itag === itag &&
        f.lastModified === candidate.sourceVersion &&
        (f.xtags ?? '') === (candidate.sourceTags ?? '') &&
        (f.audioTrackId ?? '') === (candidate.audioTrackId ?? '') &&
        f.mimeType === candidate.mime &&
        (candidate.kind !== 'video' ||
          (f.width === candidate.width &&
            f.height === candidate.height &&
            f.fps === candidate.fps)) &&
        (!candidate.language || f.language === candidate.language) &&
        (candidate.size === undefined || f.contentLength === candidate.size),
    );
    if (matching.length !== 1) throw new Error('TRACK_IDENTITY_MISMATCH');
    const format = matching[0]!;
    validateSabrSelection(formats, format);
    return { ...format };
  };
  return { video: resolve(plan.video), audio: resolve(plan.audio) };
}
