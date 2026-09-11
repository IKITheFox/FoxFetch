import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { StagedYouTubeSelection } from './sources/staged-selection';
import { verifyYouTubeTrackParameters } from './track-verification';

/** Preserve complete original containers. No video conversion or MP3 audio fallback. */
export async function prepareYouTubeSeparateOutputs(
  staged: StagedYouTubeSelection,
  signal: AbortSignal,
) {
  const parameters = await verifyYouTubeTrackParameters(
    staged.plan,
    staged.video,
    staged.audio,
    signal,
  );
  async function wrap(blob: Blob, kind: 'video' | 'audio') {
    signal.throwIfAborted();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(blob, { maxCacheSize: 8 * 1024 * 1024 }),
    });
    const abort = () => input.dispose();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const format = await input.getFormat();
      signal.throwIfAborted();
      const extension =
        format.name === 'WebM'
          ? 'webm'
          : format.name === 'MP4'
            ? kind === 'audio'
              ? 'm4a'
              : 'mp4'
            : undefined;
      if (!extension) throw new Error('SOURCE_FORMAT_UNSUPPORTED');
      const mime = `${kind}/${extension === 'webm' ? 'webm' : 'mp4'}`;
      return new File([blob], `${kind}.${extension}`, { type: mime });
    } finally {
      signal.removeEventListener('abort', abort);
      input.dispose();
    }
  }
  // Original staged files remain owned by the caller until both saves finish.
  const video = await wrap(staged.video, 'video');
  const audio = await wrap(staged.audio, 'audio');
  return { video, audio, parameters };
}
