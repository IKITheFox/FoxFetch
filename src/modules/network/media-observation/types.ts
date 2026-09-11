export type NetworkMediaCandidateKind = 'video' | 'audio' | 'playlist' | 'unknown';

export type NetworkMediaCandidateRole = 'track' | 'segment' | 'playlist' | 'unknown';

export type NetworkMediaConfidence = 'high' | 'medium' | 'low';

export type NetworkMediaCandidateReason =
  | 'video-mime'
  | 'audio-mime'
  | 'playlist-mime'
  | 'video-extension'
  | 'audio-extension'
  | 'playlist-extension'
  | 'fragment-extension'
  | 'opaque-mime'
  | 'extensionless-url'
  | 'media-resource-type'
  | 'byte-range'
  | 'partial-response'
  | 'video-url-hint'
  | 'audio-url-hint'
  | 'redirected'
  | 'known-media-provider'
  | 'mime-only-xhr'
  | 'head-metadata'
  | 'container-track-handler';

/** Inclusive HTTP byte range. */
export interface NetworkByteRange {
  start: number;
  end: number;
  /** Complete resource size from Content-Range, when the server disclosed it. */
  total?: number;
}

export interface NetworkRedirect {
  fromUrl: string;
  toUrl: string;
  status: number;
  time: number;
}

/**
 * Browser-independent representation of one webRequest observation.
 *
 * `size` is the known complete resource size, not the Content-Length of an
 * individual 206 response. Put the latter in `range` instead.
 */
export interface NetworkMediaObservation {
  requestId: string;
  url: string;
  /** HTTP method as observed by webRequest. Legacy observations default to GET. */
  method?: string;
  initiator?: string;
  documentId?: string;
  frameId: number;
  resourceType: string;
  mime?: string;
  /** Track type read from a validated container initialization segment. */
  sniffedKind?: 'video' | 'audio';
  status: number;
  size?: number;
  time: number;
  range?: NetworkByteRange;
  redirect?: NetworkRedirect;
  requestHeaders?: MediaRequestHeaders;
}

export interface ResolvedNetworkMediaCandidate {
  /** The terminal URL after known redirects. */
  url: string;
  kind: NetworkMediaCandidateKind;
  role: NetworkMediaCandidateRole;
  confidence: NetworkMediaConfidence;
  confidenceScore: number;
  reasons: NetworkMediaCandidateReason[];

  /** Latest terminal response metadata for convenient consumers. */
  requestId: string;
  method?: string;
  initiator?: string;
  documentId?: string;
  frameId: number;
  resourceType: string;
  mime?: string;
  status: number;
  size?: number;
  time: number;
  redirect?: NetworkRedirect;
  requestHeaders?: MediaRequestHeaders;

  /** Complete provenance retained across URL, range, and redirect coalescing. */
  requestIds: string[];
  methods: string[];
  initiators: string[];
  documentIds: string[];
  frameIds: number[];
  resourceTypes: string[];
  redirects: NetworkRedirect[];
  observations: NetworkMediaObservation[];
  firstSeenAt: number;
  lastSeenAt: number;
  /** Unique bytes covered by observed ranges; this is not necessarily the full size. */
  observedBytes?: number;
}

export type NetworkTrackRecommendationReason =
  'paired' | 'missing-track' | 'low-confidence' | 'context-mismatch';

export interface NetworkTrackPair {
  video: ResolvedNetworkMediaCandidate;
  audio: ResolvedNetworkMediaCandidate;
  confidenceScore: number;
}

export interface NetworkTrackRecommendation {
  video?: ResolvedNetworkMediaCandidate;
  audio?: ResolvedNetworkMediaCandidate;
  pair?: NetworkTrackPair;
  autoPair: boolean;
  reason: NetworkTrackRecommendationReason;
}

export interface NetworkCaptureSnapshot {
  active: boolean;
  observations: NetworkMediaObservation[];
  candidates: ResolvedNetworkMediaCandidate[];
  recommendation: NetworkTrackRecommendation;
}
import type { MediaRequestHeaders } from '../../../shared/types';
