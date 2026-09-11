import type { YouTubeSelectionPlan } from '../selection';
import type { YouTubePreparationStage } from '../preparation-stage';
import { verifyYouTubeTrackParameters, type YouTubeTrackVerification } from '../track-verification';
import { acquireSabrTracks, type SabrAcquisitionRequest, type SabrTrackEvidence } from './sabr';
import { bindYouTubeSabrSelection, type SelectedSabrFormat } from './selection-binding';

export interface StagedYouTubeSelection {
  readonly plan: YouTubeSelectionPlan;
  readonly video: File;
  readonly audio: File;
  readonly evidence: { video: SabrTrackEvidence; audio: SabrTrackEvidence };
  readonly parameters: YouTubeTrackVerification;
  dispose(): Promise<void>;
}

/** Complete selected tracks in private storage. Never publish partial files as successful output. */
export async function stageYouTubeSabrSelection(
  plan: YouTubeSelectionPlan,
  videoId: string,
  session: Omit<SabrAcquisitionRequest, 'video' | 'audio' | 'formats'> & {
    formats: SelectedSabrFormat[];
  },
  options: {
    signal: AbortSignal;
    root?: FileSystemDirectoryHandle;
    fetch?: typeof fetch;
    onProgress?: (bytes: number) => void;
    onDiagnostic?: (code: string, value: number) => void;
    onNetwork?: (event: import('./sabr-transport').SabrNetworkEvent) => void;
    onSegments?: (progress: import('./segment-progress').SegmentProgress | null) => void;
    onTotal?: (bytes: number | null) => void;
    onStage?: (stage: YouTubePreparationStage) => void;
  },
): Promise<StagedYouTubeSelection> {
  options.signal.throwIfAborted();
  const selected = bindYouTubeSabrSelection(plan, videoId, session.formats);
  // SABR segment lengths do not prove the size of the assembled selected tracks.
  options.onTotal?.(null);
  const root = options.root ?? (await navigator.storage.getDirectory());
  const name = `youtube-selected-${crypto.randomUUID()}`;
  const directory = await root.getDirectoryHandle(name, { create: true });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    await root.removeEntry(name, { recursive: true });
    disposed = true;
  };
  const streams: FileSystemWritableFileStream[] = [];
  try {
    const videoHandle = await directory.getFileHandle('video.track', { create: true });
    const audioHandle = await directory.getFileHandle('audio.track', { create: true });
    const video = await videoHandle.createWritable();
    streams.push(video);
    const audio = await audioHandle.createWritable();
    streams.push(audio);
    options.signal.throwIfAborted();
    options.onStage?.('downloading');
    const evidence = await acquireSabrTracks(
      { ...session, ...selected },
      {
        video,
        audio,
        segmentDirectory: directory,
        signal: options.signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.onSegments ? { onSegments: options.onSegments } : {}),
        ...(options.onNetwork ? { onNetwork: options.onNetwork } : {}),
        ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      },
    );
    options.signal.throwIfAborted();
    const [videoFile, audioFile] = await Promise.all([
      videoHandle.getFile(),
      audioHandle.getFile(),
    ]);
    if (videoFile.size !== evidence.video.bytes || audioFile.size !== evidence.audio.bytes)
      throw new Error('SEGMENT_MISSING');
    options.onStage?.('verifying-source');
    const parameters = await verifyYouTubeTrackParameters(
      plan,
      videoFile,
      audioFile,
      options.signal,
    );
    return { plan, video: videoFile, audio: audioFile, evidence, parameters, dispose };
  } catch (error) {
    // Some failures happen before the acquisition reader owns both streams.
    await Promise.allSettled(streams.map((stream) => stream.abort()));
    await dispose();
    throw error;
  }
}
