import type { MediaAsset } from '../../shared/types';
import {
  extensionFromMime,
  extensionFromUrl,
  sanitizeFilename,
  stableId,
} from '../../shared/utils';
import {
  recommendNetworkMediaTracks,
  resolveNetworkMediaCandidates,
  type NetworkMediaObservation,
  type ResolvedNetworkMediaCandidate,
} from '../network/media-observation';
import type { BlobCaptureSession } from './capture-session';

export interface CaptureResolutionContext {
  pageUrl: string;
  pageTitle: string;
  expectedKind?: 'video' | 'audio';
}

export interface CaptureResolution {
  candidateCount: number;
  assets: MediaAsset[];
  directAssetId?: string;
  videoAssetId?: string;
  audioAssetId?: string;
  hasPlaylist: boolean;
}

function toNetworkObservation(
  observation: BlobCaptureSession['observations'][number],
): NetworkMediaObservation {
  return {
    requestId: observation.requestId ?? observation.id,
    url: observation.url,
    ...(observation.initiator ? { initiator: observation.initiator } : {}),
    documentId: observation.documentId,
    frameId: observation.frameId,
    resourceType: observation.resourceType ?? 'media',
    ...(observation.mime ? { mime: observation.mime } : {}),
    status: observation.status ?? 200,
    ...(observation.size == null ? {} : { size: observation.size }),
    time: observation.observedAt,
    ...(observation.range ? { range: observation.range } : {}),
    ...(observation.redirect ? { redirect: observation.redirect } : {}),
    ...(observation.requestHeaders ? { requestHeaders: { ...observation.requestHeaders } } : {}),
  };
}

function candidateToAsset(
  candidate: ResolvedNetworkMediaCandidate,
  context: CaptureResolutionContext,
): MediaAsset | undefined {
  if (candidate.kind !== 'video' && candidate.kind !== 'audio') return undefined;
  const extension =
    extensionFromMime(candidate.mime) ??
    extensionFromUrl(candidate.url) ??
    (candidate.kind === 'video' ? 'mp4' : 'm4a');
  const id = stableId(`resolved:${candidate.kind}:${candidate.url}`);
  const label = candidate.kind === 'video' ? '视频轨' : '音频轨';
  const pageName = sanitizeFilename(context.pageTitle, 'FoxFetch');
  return {
    id,
    url: candidate.url,
    pageUrl: context.pageUrl,
    pageTitle: context.pageTitle,
    frameId: candidate.frameId,
    kind: candidate.kind,
    detectedBy: ['network'],
    ...(candidate.mime ? { mime: candidate.mime } : {}),
    extension,
    filename: `${pageName}-${label}-${id}.${extension}`,
    ...(candidate.size == null ? {} : { size: candidate.size }),
    ...(candidate.requestHeaders ? { requestHeaders: { ...candidate.requestHeaders } } : {}),
    downloadable: true,
    discoveredAt: candidate.firstSeenAt,
  };
}

export function resolveCaptureSessionMedia(
  session: BlobCaptureSession,
  context: CaptureResolutionContext,
  allowSingleTrack: boolean,
): CaptureResolution {
  // A capture session can survive an intentional page reload. Only observations from the
  // currently adopted document are eligible: signed URLs from the retired document may still
  // be present in the bounded history, but must never win a later pairing decision.
  const currentDocumentObservations = session.documentId
    ? session.observations.filter((observation) => observation.documentId === session.documentId)
    : [];
  const candidates = resolveNetworkMediaCandidates(
    currentDocumentObservations.map(toNetworkObservation),
  );
  const recommendation = recommendNetworkMediaTracks(candidates);
  const hasPlaylist = candidates.some(
    (candidate) => candidate.kind === 'playlist' && candidate.confidence === 'high',
  );

  if (recommendation.autoPair && recommendation.pair) {
    const video = candidateToAsset(recommendation.pair.video, context);
    const audio = candidateToAsset(recommendation.pair.audio, context);
    if (video && audio) {
      return {
        candidateCount: candidates.length,
        assets: [video, audio],
        videoAssetId: video.id,
        audioAssetId: audio.id,
        hasPlaylist,
      };
    }
  }

  if (allowSingleTrack) {
    const highTracks = candidates.filter(
      (candidate) =>
        candidate.role === 'track' &&
        candidate.confidence === 'high' &&
        (candidate.kind === 'video' || candidate.kind === 'audio') &&
        (context.expectedKind == null || candidate.kind === context.expectedKind),
    );
    if (highTracks.length === 1) {
      const direct = candidateToAsset(highTracks[0]!, context);
      if (direct) {
        return {
          candidateCount: candidates.length,
          assets: [direct],
          directAssetId: direct.id,
          hasPlaylist,
        };
      }
    }
  }

  return { candidateCount: candidates.length, assets: [], hasPlaylist };
}
