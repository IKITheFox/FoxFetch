import { describe, expect, it } from 'vitest';
import {
  MERGE_DOWNLOAD_PROGRESS_END,
  MERGE_MUX_PROGRESS_END,
  mergeJobFromSeed,
  transitionMergeJob,
  updateMergeJobProgress,
} from '../../src/modules/jobs';

function job() {
  return mergeJobFromSeed({
    id: 'progress-job',
    videoUrl: 'https://media.example/video.mp4',
    audioUrl: 'https://media.example/audio.m4a',
    createdAt: 1,
  });
}

describe('public merge progress projection', () => {
  it('maps download to 0-70 and local merge to 70-94 without regressing', () => {
    let current = updateMergeJobProgress(job(), {
      phase: 'fetching',
      ratio: 0.46,
      readBytes: 52,
      totalBytes: 113,
      message: 'download',
    });
    expect(current.progress.ratio).toBeCloseTo(0.322);

    current = updateMergeJobProgress(current, {
      phase: 'muxing',
      ratio: 0.5,
      readBytes: 113,
      totalBytes: 113,
      message: 'mux',
    });
    expect(current.progress.ratio).toBeCloseTo(
      MERGE_DOWNLOAD_PROGRESS_END + (MERGE_MUX_PROGRESS_END - MERGE_DOWNLOAD_PROGRESS_END) * 0.5,
    );

    const reached = current.progress.ratio;
    current = updateMergeJobProgress(current, {
      phase: 'fetching',
      ratio: 1,
      readBytes: 113,
      totalBytes: 113,
      message: 'late download event',
    });
    expect(current.progress.phase).toBe('muxing');
    expect(current.progress.ratio).toBe(reached);
    expect(current.progress.message).toBe('mux');

    current = updateMergeJobProgress(current, {
      phase: 'muxing',
      ratio: 0.1,
      readBytes: 113,
      totalBytes: 113,
      message: 'regressing mux event',
    });
    expect(current.progress.ratio).toBe(reached);
  });

  it('does not invent a percentage while source length is unknown', () => {
    const current = updateMergeJobProgress(job(), {
      phase: 'fetching',
      ratio: null,
      readBytes: 8 * 1024 * 1024,
      totalBytes: null,
      message: 'unknown total',
    });
    expect(current.progress.ratio).toBeNull();
    expect(current.progress.readBytes).toBe(8 * 1024 * 1024);
  });

  it('reserves 100 percent for the verified browser-save completion transition', () => {
    const submittedOnly = updateMergeJobProgress(job(), {
      phase: 'idle',
      ratio: 1,
      readBytes: 0,
      totalBytes: null,
      message: 'submitted but not confirmed',
    });
    expect(submittedOnly.progress.ratio).toBe(0.99);

    let current = updateMergeJobProgress(job(), {
      phase: 'saving',
      ratio: 1,
      readBytes: 100,
      totalBytes: 100,
      message: 'finalize',
    });
    expect(current.progress.ratio).toBe(0.95);

    current = updateMergeJobProgress(current, {
      phase: 'verifying',
      ratio: 1,
      readBytes: 100,
      totalBytes: 100,
      message: 'browser save pending',
    });
    expect(current.progress.ratio).toBe(0.99);

    let stateful = transitionMergeJob(job(), 'resolving');
    stateful = transitionMergeJob(stateful, 'ready');
    stateful = transitionMergeJob(stateful, 'fetching');
    stateful = transitionMergeJob(stateful, 'muxing');
    stateful = transitionMergeJob(stateful, 'saving');
    stateful = transitionMergeJob(stateful, 'verifying', { progress: current.progress });
    stateful = transitionMergeJob(stateful, 'completed', {
      outputSizeBytes: 123,
      progress: { ...stateful.progress, ratio: 1 },
    });
    expect(stateful.progress.ratio).toBe(1);
  });

  it('freezes the last useful percentage when a task fails', () => {
    let current = transitionMergeJob(job(), 'resolving');
    current = transitionMergeJob(current, 'ready');
    current = transitionMergeJob(current, 'fetching');
    current = updateMergeJobProgress(current, {
      phase: 'fetching',
      ratio: 0.5,
      readBytes: 50,
      totalBytes: 100,
      message: 'download',
    });
    const reached = current.progress.ratio;
    current = transitionMergeJob(current, 'failed', {
      failure: {
        code: 'NETWORK_FAILED',
        message: 'failed',
        retryable: true,
        canDownloadSeparately: true,
      },
      progress: { ...current.progress, ratio: null, message: 'failed' },
    });
    expect(current.progress.ratio).toBe(reached);
    expect(current.progress.message).toBe('failed');
  });
});
