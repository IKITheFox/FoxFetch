import type { AudioCodec, StreamTargetChunk, VideoCodec } from 'mediabunny';

import type {
  IsoBmffDynamicRangeEvidence,
  VideoPacketEquivalenceEvidence,
} from './isobmff-dynamic-range';
import type { NativeFfmpegHelperCapability } from './native-ffmpeg-helper';

export type MergeContainer = 'mp4' | 'webm' | 'mkv';
export type MergeContainerPreference = MergeContainer | 'auto';

export interface MergeDynamicRangeConstraint {
  provider: 'bilibili';
  range: 'SDR' | 'HDR' | 'Dolby Vision' | 'unknown';
  /** `supported` is reserved for an output path that verifies preservation. */
  remuxable: 'supported' | 'unsupported' | 'unknown';
}

export type DrmSignal =
  | 'declared-encrypted'
  | 'eme'
  | 'encrypted-event'
  | 'waiting-for-key'
  | 'dash-content-protection'
  | 'dash-default-kid'
  | 'dash-pssh'
  | 'hls-key'
  | 'hls-keyformat'
  | 'hls-sample-aes'
  | 'mp4-pssh'
  | 'mp4-encrypted-video-entry'
  | 'mp4-encrypted-audio-entry'
  | 'mp4-sinf'
  | 'mp4-tenc';

export interface MergeSourceRequest {
  url: string;
  credentials?: RequestCredentials;
  declaredMimeType?: string;
  /**
   * Stable provider/player stream identity shared by the video and audio
   * representations. This must describe the media item (for example BVID/CID),
   * not a CDN URL or a per-track representation id.
   */
  streamIdentity?: string;
  /** Fail-closed provider metadata; it never grants access to a source URL. */
  dynamicRange?: MergeDynamicRangeConstraint;
  /**
   * Equivalent CDN locations for this exact representation. Callers must not
   * combine different quality, codec, or provider representation groups here.
   */
  sources?: readonly MergeSourceLocation[];
}

export interface MergeSourceLocation {
  url: string;
  credentials?: RequestCredentials;
  declaredMimeType?: string;
}

export type MergeCoverMimeType = 'image/jpeg' | 'image/png' | 'image/bmp';

/** Metadata selected by the trusted background for the current media epoch. */
export interface MergeMediaMetadataRequest {
  title?: string;
  /** HTTP(S) player poster only; fetched without credentials by the merge worker. */
  coverUrl?: string;
}

/** Bounded, validated metadata ready to be written by the muxer. */
export interface ResolvedMergeMediaMetadata {
  title?: string;
  cover?: {
    data: Uint8Array;
    mimeType: MergeCoverMimeType;
  };
}

export interface SeparateTrackMergeRequest {
  video: MergeSourceRequest;
  audio: MergeSourceRequest;
  preferredContainer?: MergeContainerPreference;
  fileName?: string;
  drmSignals?: DrmSignal[];
  metadata?: MergeMediaMetadataRequest;
}

export interface MediaTrackProbe {
  url: string;
  kind: 'video' | 'audio';
  formatName: string;
  mimeType: string;
  codec: VideoCodec | AudioCodec;
  codecParameterString: string | null;
  internalCodecId: string | number | null;
  durationSeconds: number | null;
  firstTimestampSeconds: number;
  sizeBytes: number | null;
  live: boolean;
}

export interface ContainerRecommendation {
  supported: boolean;
  container?: MergeContainer;
  extension?: '.mp4' | '.webm' | '.mkv';
  mimeType?: 'video/mp4' | 'video/webm' | 'video/x-matroska';
  compatibility: 'broad' | 'conditional' | 'limited' | 'unsupported';
  reason: string;
  warnings: string[];
}

export interface MergePlan {
  mode: 'packet-copy';
  container: MergeContainer;
  extension: '.mp4' | '.webm' | '.mkv';
  mimeType: 'video/mp4' | 'video/webm' | 'video/x-matroska';
  video: MediaTrackProbe;
  audio: MediaTrackProbe;
  estimatedInputBytes: number | null;
  estimatedDurationSeconds: number | null;
  warnings: string[];
  /** Present only when publishing needs an advanced dynamic-range proof. */
  dynamicRangeVerification?: {
    range: 'HDR' | 'Dolby Vision';
    strategy: 'browser-verified-packet-copy';
    verifyAfterTemporaryWrite: true;
    originalVideoTrackFallback: true;
    nativeHelper: NativeFfmpegHelperCapability;
  };
}

export type MergeFailureCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'HOST_PERMISSION_REQUIRED'
  | 'SOURCE_UNREADABLE'
  | 'SOURCE_FORMAT_UNSUPPORTED'
  | 'VIDEO_TRACK_MISSING'
  | 'AUDIO_TRACK_MISSING'
  | 'LIVE_STREAM_UNSUPPORTED'
  | 'DRM_PROTECTED'
  | 'CODEC_UNKNOWN'
  | 'CONTAINER_INCOMPATIBLE'
  | 'TIMELINE_MISMATCH'
  | 'RANGE_RESPONSE_INVALID'
  | 'TRANSCODE_REQUIRED'
  | 'DYNAMIC_RANGE_UNVERIFIED'
  | 'NETWORK_FAILED'
  | 'OUTPUT_WRITE_FAILED'
  | 'OUTPUT_PARSE_FAILED'
  | 'OUTPUT_TRACK_MISMATCH'
  | 'OUTPUT_TIMELINE_MISMATCH'
  | 'OUTPUT_AV_OFFSET_MISMATCH'
  | 'OUTPUT_DURATION_MISMATCH'
  | 'OUTPUT_METADATA_MISMATCH'
  | 'OUTPUT_SIZE_MISMATCH'
  | 'OUTPUT_SIGNATURE_MISMATCH'
  | 'OUTPUT_VERIFY_FAILED'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export type MergeDiagnosticStage =
  | 'storage'
  | 'source-selection'
  | 'source-headers'
  | 'source-body'
  | 'media-metadata'
  | 'decoder-config'
  | 'staging'
  | 'muxing'
  | 'dv-restore'
  | 'verify-video'
  | 'verify-audio'
  | 'verify-output'
  | 'saving';

/** Stable, URL-free reasons. Never derive public diagnostics from raw error messages. */
export type MergeFailureReason =
  | 'NETWORK_TIMEOUT'
  | 'BODY_STALLED'
  | 'PARSER_TIMEOUT'
  | 'WORKER_START_TIMEOUT'
  | 'WORKER_UNRESPONSIVE'
  | 'STORAGE_QUOTA'
  | 'RANGE_INVALID'
  | 'RANGE_UNSUPPORTED'
  | 'SOURCE_EDIT_LIST_UNSUPPORTED'
  | 'SOURCE_IDENTITY_MISMATCH'
  | 'DYNAMIC_RANGE_CONFLICT'
  | 'DV_CONFIG_MISSING'
  | 'DV_SOURCE_INCOMPLETE'
  | 'DV_SAMPLE_ENTRY_UNSUPPORTED'
  | 'DV_PROFILE_UNSUPPORTED'
  | 'DV_LAYERS_UNSUPPORTED'
  | 'DV_BIT_DEPTH_UNSUPPORTED'
  | 'DV_STRUCTURE_AMBIGUOUS'
  | 'HEVC_CONFIG_MISSING'
  | 'HDR_CONFIG_INCOMPLETE'
  | 'DV_COMPATIBILITY_VIEW_FAILED'
  | 'DV_RESTORE_FAILED'
  | 'VIDEO_PACKET_MISMATCH'
  | 'AUDIO_PACKET_MISMATCH'
  | 'PACKET_TIMELINE_MISMATCH'
  | 'DV_METADATA_MISMATCH'
  | 'HDR_METADATA_MISMATCH'
  | 'OUTPUT_READBACK_FAILED'
  | 'VERIFICATION_INCOMPLETE';

/** Controlled source-box timing evidence. Never contains paths, URLs, raw boxes or payloads. */
export interface MergeSourceTimelineDiagnostic {
  issue:
    | 'invalid-box'
    | 'metadata-limit'
    | 'unsupported-version'
    | 'invalid-timebase'
    | 'duplicate-metadata'
    | 'invalid-track'
    | 'malformed-edit-list'
    | 'edit-rate'
    | 'negative-media-time'
    | 'open-ended-offset'
    | 'multiple-edits'
    | 'empty-edit-list';
  box: 'moov' | 'mvhd' | 'trak' | 'tkhd' | 'mdhd' | 'hdlr' | 'elst' | 'structure';
  sourceKind?: 'video' | 'audio';
  version?: 0 | 1;
  entryCount?: number;
  entryIndex?: number;
  movieTimescale?: number;
  mediaTimescale?: number;
  duration?: number;
  mediaTime?: number;
  rate?: number;
}

/** Bounded, URL-free numeric evidence for a single packet timing failure. */
export interface MergePacketTimelineDiagnostic {
  track: 'video' | 'audio';
  packetIndex: number;
  mismatch: 'timestamp' | 'duration' | 'non-finite' | 'timebase';
  sourceTimestampSeconds?: number;
  normalizedSourceTimestampSeconds?: number;
  outputTimestampSeconds?: number;
  sourceDurationSeconds?: number;
  outputDurationSeconds?: number;
  originSeconds?: number;
  sourceTimescale?: number;
  outputTimescale?: number;
  timestampDeltaSeconds?: number;
  durationDeltaSeconds?: number;
  timestampToleranceSeconds?: number;
  durationToleranceSeconds?: number;
}

/** Describes transport behaviour, never its URL, headers or credentials. */
export interface MergeNetworkDiagnostic {
  readMode: 'range' | 'sequential' | 'local';
  fallback?: 'range-unavailable';
  responseStatus?: number;
  requestStart?: number;
  responseStart?: number;
  responseEnd?: number;
  totalBytes?: number;
}

/** Actual parsed video configuration, not a page/quality declaration. No raw boxes or hashes. */
export interface MergeVideoConfigurationDiagnostic {
  sampleEntryType?: 'dvh1' | 'dvhe' | 'hvc1' | 'hev1' | 'avc1' | 'avc3';
  /** Dolby Vision record profile/level, not HEVC general_profile_idc/level_idc. */
  profile?: number;
  level?: number;
  rpuPresent?: boolean;
  baseLayerPresent?: boolean;
  enhancementLayerPresent?: boolean;
  bitDepthLuma?: number;
  bitDepthChroma?: number;
  chromaFormatIdc?: number;
  parameterSetsComplete?: boolean;
  parameterSetsConflict?: boolean;
  colourSource?: 'colr' | 'sps-vui' | 'colr+sps-vui';
  colourConflict?: boolean;
  colourPrimaries?: number;
  transferCharacteristics?: number;
  matrixCoefficients?: number;
  fullRange?: boolean;
}

export interface MergeConfigurationDiagnostic {
  source?: MergeVideoConfigurationDiagnostic;
  output?: MergeVideoConfigurationDiagnostic;
}

export interface MergeFailureDetail {
  code: MergeFailureCode;
  message: string;
  retryable: boolean;
  canDownloadSeparately: boolean;
  reason?: MergeFailureReason;
  stage?: MergeDiagnosticStage;
  timeline?: MergePacketTimelineDiagnostic;
  sourceTimeline?: MergeSourceTimelineDiagnostic;
  network?: MergeNetworkDiagnostic;
  configuration?: MergeConfigurationDiagnostic;
  drmSignals?: DrmSignal[];
  /** Sanitized terminal HTTP status; response headers and credentials are never retained. */
  httpStatus?: number;
  /** Safe capability data for task/UI surfaces; never includes local paths or media URLs. */
  dynamicRangeCapability?: {
    range: 'HDR' | 'Dolby Vision' | 'unknown';
    browserVerifiedMerge: boolean;
    originalVideoTrackFallback: boolean;
    nativeHelper: NativeFfmpegHelperCapability;
  };
}

export type MergeCapability =
  | {
      status: 'supported';
      canMerge: true;
      canDownloadSeparately: true;
      plan: MergePlan;
    }
  | {
      status: 'unsupported' | 'blocked';
      canMerge: false;
      canDownloadSeparately: boolean;
      failure: MergeFailureDetail;
    };

export type RemuxPhase = 'probing' | 'fetching' | 'muxing' | 'saving' | 'verifying';

export interface RemuxProgress {
  phase: RemuxPhase;
  ratio: number | null;
  processedSeconds?: number;
  readBytes?: number;
  totalBytes?: number;
  message: string;
  stage?: MergeDiagnosticStage;
  elapsedMs?: number;
  idleMs?: number;
  packetCount?: number;
  network?: MergeNetworkDiagnostic;
}

export interface OutputVerification {
  valid: true;
  sizeBytes: number;
  formatName: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  durationSeconds: number | null;
  metadata?: {
    title?: string;
    coverEmbedded: boolean;
  };
  dynamicRange?: {
    range: 'HDR' | 'Dolby Vision';
    source: IsoBmffDynamicRangeEvidence;
    output: IsoBmffDynamicRangeEvidence;
    /** Encoded video packets plus normalized timestamps/durations. */
    packets: VideoPacketEquivalenceEvidence;
    /** Encoded AAC packets plus normalized timestamps/durations. */
    audioPackets: VideoPacketEquivalenceEvidence;
  };
}

export interface CompletedRemux {
  status: 'completed';
  plan: MergePlan;
  verification: OutputVerification;
}

export interface FileSystemWritableLike extends WritableStream<StreamTargetChunk> {
  write(data: StreamTargetChunk): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface FileSystemFileHandleLike {
  readonly name?: string;
  createWritable(): Promise<FileSystemWritableLike>;
  getFile(): Promise<File>;
}
