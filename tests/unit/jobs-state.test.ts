import { describe, expect, it } from 'vitest';
import {
  InvalidMergeJobTransitionError,
  canTransitionMergeJob,
  mergeJobFromSeed,
  transitionMergeJob,
  updateMergeJobProgress,
} from '../../src/modules/jobs';

function job() {
  return mergeJobFromSeed({
    id: 'job-1',
    videoUrl: 'https://media.example/video.mp4',
    audioUrl: 'https://media.example/audio.m4a',
    title: 'demo',
    createdAt: 10,
  });
}

describe('merge job state machine', () => {
  it('accepts the successful state path', () => {
    let current = job();
    for (const state of [
      'resolving',
      'ready',
      'fetching',
      'muxing',
      'saving',
      'verifying',
    ] as const) {
      current = transitionMergeJob(current, state, {}, current.updatedAt + 1);
    }
    current = transitionMergeJob(
      current,
      'completed',
      { outputSizeBytes: 1024 },
      current.updatedAt + 1,
    );
    expect(current.state).toBe('completed');
    expect(current.outputSizeBytes).toBe(1024);
  });

  it('rejects impossible and incomplete success transitions', () => {
    expect(() => transitionMergeJob(job(), 'completed')).toThrow(InvalidMergeJobTransitionError);

    let current = job();
    for (const state of [
      'resolving',
      'ready',
      'fetching',
      'muxing',
      'saving',
      'verifying',
    ] as const) {
      current = transitionMergeJob(current, state);
    }
    expect(() => transitionMergeJob(current, 'completed')).toThrow(/outputSizeBytes/);
  });

  it('requires a DRM failure to enter blocked_drm', () => {
    const resolving = transitionMergeJob(job(), 'resolving');
    expect(() => transitionMergeJob(resolving, 'blocked_drm')).toThrow(/DRM_PROTECTED/);
    const blocked = transitionMergeJob(resolving, 'blocked_drm', {
      failure: {
        code: 'DRM_PROTECTED',
        message: 'protected',
        retryable: false,
        canDownloadSeparately: false,
        drmSignals: ['mp4-pssh'],
      },
    });
    expect(blocked.state).toBe('blocked_drm');
  });

  it('clamps progress and protects terminal states', () => {
    const resolving = transitionMergeJob(job(), 'resolving');
    const next = updateMergeJobProgress(resolving, {
      phase: 'probing',
      ratio: 2,
      readBytes: -1,
      totalBytes: 100,
      message: 'probe',
    });
    expect(next.progress).toMatchObject({ ratio: null, readBytes: 0 });
    expect(canTransitionMergeJob('completed', 'queued')).toBe(false);
  });
});
