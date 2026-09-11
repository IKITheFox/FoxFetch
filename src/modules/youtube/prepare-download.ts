import type { YouTubeSelectionPlan } from './selection';
import { stageYouTubeSabrSelection } from './sources/staged-selection';
import { prepareYouTubeMergedOutput } from './merged-output';
import { prepareYouTubeSeparateOutputs } from './separate-output';
import { prepareYouTubeDirectOutput } from './direct-output';
import type { YouTubeDirectSession } from './sources/direct-session';

/** Worker-side preparation. Ready files are not browser download completion. */
export async function prepareYouTubeDownload(
  plan: YouTubeSelectionPlan,
  videoId: string,
  session: Parameters<typeof stageYouTubeSabrSelection>[2] | YouTubeDirectSession,
  mode: 'merge' | 'separate',
  options: Parameters<typeof stageYouTubeSabrSelection>[3],
) {
  options.signal.throwIfAborted();
  // Reject a changed action before allocating storage or reading any media.
  if (mode !== plan.mode || (mode === 'merge' && !plan.container))
    throw new Error('OUTPUT_MODE_MISMATCH');
  if ('kind' in session && session.kind === 'direct-file') {
    if (videoId !== plan.videoId) throw new Error('PAGE_IDENTITY_CHANGED');
    return prepareYouTubeDirectOutput(plan, session, options);
  }
  if ('kind' in session) throw new Error('SOURCE_NOT_ALLOWED');
  const staged = await stageYouTubeSabrSelection(plan, videoId, session, options);
  let merged: Awaited<ReturnType<typeof prepareYouTubeMergedOutput>> | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    // Try both owned cleanups even when one fails; a failure remains retryable.
    const results = await Promise.allSettled([merged?.dispose(), staged.dispose()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    disposed = true;
  };
  try {
    options.signal.throwIfAborted();
    if (mode === 'merge') {
      merged = await prepareYouTubeMergedOutput(staged, {
        signal: options.signal,
        ...(options.onStage ? { onStage: options.onStage } : {}),
        ...(options.root ? { root: options.root } : {}),
      });
      options.signal.throwIfAborted();
      return { mode, files: [merged.file], publicationCommitted: false as const, dispose };
    }
    options.onStage?.('verifying-output');
    const separate = await prepareYouTubeSeparateOutputs(staged, options.signal);
    options.signal.throwIfAborted();
    return {
      mode,
      files: [separate.video, separate.audio],
      publicationCommitted: false as const,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
