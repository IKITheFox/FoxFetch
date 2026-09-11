import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import type { YouTubeSelectionPlan } from './selection';

/** Actual file metadata, not copied from the manifest or filename. */
export interface YouTubeTrackVerification {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  audioLanguage: string;
  /** Whole-file packet statistics; not a nominal CFR claim or decode proof. */
  videoPacketCount: number;
  averageVideoFrameRate: number;
  /** This first check is not a full packet/timeline/playback verification. */
  completePlaybackVerified: false;
}

export async function verifyYouTubeTrackParameters(
  plan: YouTubeSelectionPlan,
  videoBlob: Blob,
  audioBlob: Blob,
  signal: AbortSignal,
  mode: 'separate' | 'merged' = 'separate',
): Promise<YouTubeTrackVerification> {
  signal.throwIfAborted();
  if (mode === 'merged' && (plan.mode !== 'merge' || !plan.container))
    throw new Error('OUTPUT_MODE_MISMATCH');
  // A merged result must be one file. Otherwise two separate files could each
  // satisfy half of the checks without proving the published file has both tracks.
  if (mode === 'merged' && videoBlob !== audioBlob) throw new Error('TRACK_IDENTITY_MISMATCH');
  const videoInput = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(videoBlob, { maxCacheSize: 8 * 1024 * 1024 }),
  });
  const audioInput = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(audioBlob, { maxCacheSize: 8 * 1024 * 1024 }),
  });
  const abort = () => {
    videoInput.dispose();
    audioInput.dispose();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const [videos, strayAudio, audios, strayVideo] = await Promise.all([
      videoInput.getVideoTracks(),
      videoInput.getAudioTracks(),
      audioInput.getAudioTracks(),
      audioInput.getVideoTracks(),
    ]);
    signal.throwIfAborted();
    if (
      videos.length !== 1 ||
      audios.length !== 1 ||
      (mode === 'separate' && (strayAudio.length || strayVideo.length)) ||
      (mode === 'merged' && (strayAudio.length !== 1 || strayVideo.length !== 1))
    )
      throw new Error('TRACK_IDENTITY_MISMATCH');
    if (mode === 'merged' && (await videoInput.getFormat()).name.toLowerCase() !== plan.container)
      throw new Error('OUTPUT_SELECTION_MISMATCH');
    const video = videos[0]!;
    const audio = audios[0]!;
    const [videoCodec, audioCodec, width, height, audioLanguage] = await Promise.all([
      video.getCodec(),
      audio.getCodec(),
      video.getCodedWidth(),
      video.getCodedHeight(),
      audio.getLanguageCode(),
    ]);
    signal.throwIfAborted();
    if (
      videoCodec !== plan.videoCodec ||
      audioCodec !== plan.audioCodec ||
      width !== plan.video.width ||
      height !== plan.video.height
    )
      throw new Error('OUTPUT_SELECTION_MISMATCH');
    // Scan metadata for every packet, not just an initial prefix. This also
    // supports VFR: a declared nominal rate is not necessarily the average.
    let packetCount = 0;
    let firstTimestamp = Infinity;
    let lastTimestamp = -Infinity;
    let singleDuration = 0;
    for await (const packet of new EncodedPacketSink(video).packets(undefined, undefined, {
      metadataOnly: true,
    })) {
      signal.throwIfAborted();
      if (!Number.isFinite(packet.timestamp)) throw new Error('VIDEO_TIMING_UNVERIFIED');
      packetCount++;
      firstTimestamp = Math.min(firstTimestamp, packet.timestamp);
      lastTimestamp = Math.max(lastTimestamp, packet.timestamp);
      singleDuration = packet.duration;
    }
    // WebM often omits the last packet's duration. Count presentation intervals
    // instead of treating that missing duration as zero and inflating the FPS.
    const averagePacketRate =
      packetCount > 1 ? (packetCount - 1) / (lastTimestamp - firstTimestamp) : 1 / singleDuration;
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(packetCount) ||
      packetCount <= 0 ||
      !Number.isFinite(averagePacketRate) ||
      averagePacketRate <= 0
    )
      throw new Error('VIDEO_TIMING_UNVERIFIED');
    // Language names/ISO-639 forms vary by container. Preserve this as evidence;
    // do not infer a different selected audioTrackId from a container label.
    return {
      videoCodec,
      audioCodec,
      width,
      height,
      audioLanguage,
      videoPacketCount: packetCount,
      averageVideoFrameRate: averagePacketRate,
      completePlaybackVerified: false,
    };
  } finally {
    signal.removeEventListener('abort', abort);
    videoInput.dispose();
    audioInput.dispose();
  }
}
