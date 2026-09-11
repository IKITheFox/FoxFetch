import { remuxStagedBlobsToFile } from '../merge/executor';
import type {
  FileSystemFileHandleLike,
  FileSystemWritableLike,
  RemuxProgress,
} from '../merge/types';
import type { StreamTargetChunk } from 'mediabunny';
import type { StagedYouTubeSelection } from './sources/staged-selection';
import { verifyYouTubeTrackParameters } from './track-verification';
import type { YouTubePreparationStage } from './preparation-stage';

/** Merge privately first. Publication/download completion remains the job owner's responsibility. */
export async function prepareYouTubeMergedOutput(
  staged: StagedYouTubeSelection,
  options: {
    signal: AbortSignal;
    root?: FileSystemDirectoryHandle;
    onProgress?: (progress: RemuxProgress) => void;
    onStage?: (stage: YouTubePreparationStage) => void;
  },
) {
  options.signal.throwIfAborted();
  if (staged.plan.mode !== 'merge' || !staged.plan.container)
    throw new Error('OUTPUT_MODE_MISMATCH');
  // Recheck files at this boundary; a caller cannot grant validity by supplying a metadata object.
  const sourceParameters = await verifyYouTubeTrackParameters(
    staged.plan,
    staged.video,
    staged.audio,
    options.signal,
  );
  const root = options.root ?? (await navigator.storage.getDirectory());
  const name = `youtube-merged-${crypto.randomUUID()}.${staged.plan.container}`;
  const fileHandle = await root.getFileHandle(name, { create: true });
  let removed = false;
  const dispose = async () => {
    if (!removed) {
      await root.removeEntry(name);
      removed = true;
    }
  };
  const handle: FileSystemFileHandleLike = {
    name,
    getFile: () => fileHandle.getFile(),
    async createWritable() {
      const writer = await fileHandle.createWritable();
      const write = (chunk: StreamTargetChunk) => writer.write(chunk);
      const abort = (reason?: unknown) => writer.abort(reason);
      const stream = new WritableStream<StreamTargetChunk>({
        write,
        close: () => writer.close(),
        abort,
      });
      return Object.assign(stream, { write, abort }) as FileSystemWritableLike;
    },
  };
  try {
    options.onStage?.('merging');
    const result = await remuxStagedBlobsToFile(
      staged.video,
      staged.audio,
      handle,
      staged.video.size + staged.audio.size,
      {
        signal: options.signal,
        preferredContainer: staged.plan.container,
        videoStreamIdentity: staged.plan.videoId,
        audioStreamIdentity: staged.plan.videoId,
        // Explicitly preserve unknown too; container defaults must not assign a language.
        audioLanguageCode: sourceParameters.audioLanguage || 'und',
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    options.signal.throwIfAborted();
    if (result.plan.mode !== 'packet-copy' || result.plan.container !== staged.plan.container)
      throw new Error('OUTPUT_SELECTION_MISMATCH');
    const file = await fileHandle.getFile();
    options.onStage?.('verifying-output');
    const parameters = await verifyYouTubeTrackParameters(
      staged.plan,
      file,
      file,
      options.signal,
      'merged',
    );
    if ((parameters.audioLanguage || 'und') !== (sourceParameters.audioLanguage || 'und'))
      throw new Error('OUTPUT_SELECTION_MISMATCH');
    // Compare the actual full-file rate and packet count before/after remux.
    // Do not force VFR to the manifest's rounded nominal FPS. Allow only 2 ms
    // for the two endpoints being quantized into a millisecond WebM timebase.
    const sourceSpan =
      Math.max(1, sourceParameters.videoPacketCount - 1) / sourceParameters.averageVideoFrameRate;
    const outputSpan =
      Math.max(1, parameters.videoPacketCount - 1) / parameters.averageVideoFrameRate;
    if (
      parameters.videoPacketCount !== sourceParameters.videoPacketCount ||
      !Number.isFinite(sourceSpan) ||
      !Number.isFinite(outputSpan) ||
      Math.abs(sourceSpan - outputSpan) > 0.002001
    )
      throw new Error('OUTPUT_FRAME_RATE_MISMATCH');
    return { file, result, parameters, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
