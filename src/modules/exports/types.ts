import type { AudioCodec, VideoCodec } from 'mediabunny';

import type { IsoBmffDynamicRangeEvidence, MergeFailureDetail } from '../merge';

export type StandardSeparateOutputKind = 'video' | 'audio';

export interface OriginalAudioTrackEvidence {
  container: 'iso-bmff' | 'mp3';
  codec: 'aac' | 'mp3';
  sampleRate: number;
  numberOfChannels: number;
  packetCount: number;
  durationSeconds: number | null;
  /** Chunked full-file digests bind the publish-boundary check to the exact original bytes. */
  chunkSha256: string[];
}

export interface StandardSeparateOutputVerification {
  valid: true;
  sizeBytes: number;
  formatName: string;
  codec: VideoCodec | AudioCodec;
  durationSeconds: number | null;
  /** True only after an exact chunk-by-chunk source/output comparison. */
  sourceBytesPreserved?: true;
  dynamicRange?: IsoBmffDynamicRangeEvidence;
  originalAudio?: OriginalAudioTrackEvidence;
}

export interface CompletedStandardSeparateOutput {
  status: 'completed';
  kind: StandardSeparateOutputKind;
  extension: '.mp4' | '.mp3' | '.m4a';
  mimeType: 'video/mp4' | 'audio/mpeg' | 'audio/mp4';
  sourceCodec: VideoCodec | AudioCodec;
  outputCodec: VideoCodec | AudioCodec;
  outputMode?: 'standard-remux' | 'audio-transcode' | 'original-track';
  verification: StandardSeparateOutputVerification;
}

export type StandardSeparateOutputOutcome =
  | CompletedStandardSeparateOutput
  | {
      status: 'failed';
      kind: StandardSeparateOutputKind;
      failure: MergeFailureDetail;
    };

export interface CompletedStandardSeparateExport {
  status: 'completed' | 'partial' | 'failed';
  outcomes: readonly [StandardSeparateOutputOutcome, StandardSeparateOutputOutcome];
}
