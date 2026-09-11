import type { MergeJob } from './types';
import type { MediaProduct } from '../media-products/media-products';

/** Completion is immutable; only current, identical logical tracks can seed a new job. */
export function canRepeatMergeDownload(job: MergeJob): boolean {
  return (
    (job.state === 'completed' ||
      (job.state === 'cancelled' &&
        job.cancellationRequestedAt != null &&
        !job.cancellationFailure &&
        !job.publicationPending)) &&
    job.repeatSelection != null &&
    job.repeatedByJobId == null &&
    (job.state === 'cancelled' || job.cancellationRequestedAt == null)
  );
}

export function selectRepeatTracks(job: MergeJob, products: readonly MediaProduct[]) {
  if (!canRepeatMergeDownload(job)) throw new Error('请从当前视频重新选择下载内容');
  const selection = job.repeatSelection!;
  const matches = [];
  for (const product of products) {
    const videos = product.videoTracks.filter((track) =>
      job.videoStreamIdentity
        ? track.streamIdentity === job.videoStreamIdentity
        : track.id === selection.videoTrackId,
    );
    const audios = product.audioTracks.filter((track) =>
      job.audioStreamIdentity
        ? track.streamIdentity === job.audioStreamIdentity
        : track.id === selection.audioTrackId,
    );
    if (videos.length !== 1 || audios.length !== 1) continue;
    const videoTrack = videos[0]!;
    const audioTrack = audios[0]!;
    if (!videoTrack || !audioTrack) continue;
    if (
      videoTrack.streamIdentity !== job.videoStreamIdentity ||
      audioTrack.streamIdentity !== job.audioStreamIdentity
    )
      continue;
    matches.push({ product, videoTrack, audioTrack });
  }
  if (matches.length === 1) return matches[0]!;
  throw new Error('原来选择的画质或音轨暂不可用，请重新选择下载内容');
}
