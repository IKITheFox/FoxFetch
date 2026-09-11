// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  YouTubeOffscreenExecutor,
  type YouTubeExecutionRequest,
} from '../../src/modules/youtube/offscreen-executor';
import type { prepareYouTubeDownload } from '../../src/modules/youtube/prepare-download';

const request = (): YouTubeExecutionRequest => ({
  jobId: '11111111-1111-4111-8111-111111111111',
  plan: { videoId: 'abcdefghijk', mode: 'merge', container: 'webm' } as never,
  session: {} as never,
});
type Dependencies = NonNullable<ConstructorParameters<typeof YouTubeOffscreenExecutor>[0]>;
function setup(
  directorySave?: Dependencies['directorySave'],
  directoryRecheck?: Dependencies['directoryRecheck'],
  directoryRemoved?: Dependencies['directoryRemoved'],
  directoryRetry?: Dependencies['directoryRetry'],
) {
  const dispose = vi.fn(async () => {});
  const prepare = vi.fn<typeof prepareYouTubeDownload>().mockResolvedValue({
    mode: 'merge',
    files: [new File(['verified'], 'video.webm')],
    publicationCommitted: false,
    dispose,
  });
  const createUrl = vi.fn(() => 'blob:chrome-extension://example/owned-output');
  const revokeUrl = vi.fn();
  const executor = new YouTubeOffscreenExecutor({
    prepare,
    createUrl,
    revokeUrl,
    ...(directorySave ? { directorySave } : {}),
    ...(directoryRecheck ? { directoryRecheck } : {}),
    ...(directoryRemoved ? { directoryRemoved } : {}),
    ...(directoryRetry ? { directoryRetry } : {}),
  });
  return { executor, prepare, dispose, createUrl, revokeUrl };
}
async function settled(executor: YouTubeOffscreenExecutor, id: string) {
  await vi.waitFor(() => expect(executor.status(id)?.state).not.toBe('preparing'));
}
const directoryId = 'youtube-22222222-2222-4222-8222-222222222222';
it.each([false, true])(
  'rechecks retained output before retrying removed audio, tampered=%s',
  async (tampered) => {
    const allocation = async (r: Parameters<NonNullable<Dependencies['directorySave']>>[0]) => ({
      handleId: r.handleId,
      fileName: r.requestedName,
      size: r.size,
    });
    const save = vi
      .fn<NonNullable<Dependencies['directorySave']>>()
      .mockImplementation(async (r) => {
        if (r.kind === 'audio') throw new Error('WRITE_FAILED');
        return allocation(r);
      });
    const check = vi
      .fn<NonNullable<Dependencies['directoryRecheck']>>()
      .mockImplementation(allocation);
    const retry = vi
      .fn<NonNullable<Dependencies['directoryRetry']>>()
      .mockImplementation(allocation);
    const s = setup(save, check, allocation, retry),
      job = request();
    job.plan = { ...job.plan, mode: 'separate' };
    s.prepare.mockResolvedValue({
      mode: 'separate',
      files: [new File(['video'], 'video.webm'), new File(['audio'], 'audio.webm')],
      publicationCommitted: false,
      dispose: s.dispose,
    });
    s.executor.start(job);
    await settled(s.executor, job.jobId);
    const names = ['video.webm', 'audio.webm'];
    s.executor.saveDirectory(job.jobId, directoryId, names);
    await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('stopped'));
    if (tampered) check.mockRejectedValue(new Error('DIRECTORY_OUTPUT_MISMATCH'));
    for (const attempt of [0, -1, 1.5, 1001])
      expect(() => s.executor.retryDirectory(job.jobId, attempt)).toThrow('DIRECTORY_RETRY_REJECTED');
    for (let i = 0; i < 10; i++) s.executor.retryDirectory(job.jobId, 1);
    await vi.waitFor(() =>
      expect(s.executor.status(job.jobId)?.directory?.state).toBe(
        tampered ? 'unknown' : 'verified',
      ),
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0].kind).toBe('video');
    expect(retry).toHaveBeenCalledTimes(tampered ? 0 : 1);
    if (!tampered) expect(retry.mock.calls[0]![0].kind).toBe('audio');
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.prepare).toHaveBeenCalledTimes(1);
    expect(s.executor.status(job.jobId)?.directory?.attempt).toBe(1);
  },
);
it('settles cancellation before the first directory write without requiring a nonexistent allocation', async () => {
  const save = vi.fn<NonNullable<Dependencies['directorySave']>>();
  const s = setup(save),
    job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  expect((await s.executor.cancelDirectory(job.jobId))?.directory).toMatchObject({
    state: 'stopped',
    files: [],
    removed: [],
    unstarted: ['merged'],
  });
  expect(save).not.toHaveBeenCalled();
  await s.executor.release(job.jobId);
  expect(s.dispose).toHaveBeenCalledTimes(1);
});
it('permits release after recorded removal but not from a failed write alone', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockRejectedValue(new Error('WRITE_FAILED'));
  const removed = vi
    .fn<NonNullable<Dependencies['directoryRemoved']>>()
    .mockImplementation(async (r) => ({
      handleId: r.handleId,
      fileName: r.requestedName,
      size: r.size,
    }));
  const s = setup(save, undefined, removed),
    job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('stopped'));
  expect(s.executor.status(job.jobId)?.directory?.removed).toEqual([
    { kind: 'merged', handleId: directoryId, fileName: 'video.webm', size: 8 },
  ]);
  await s.executor.release(job.jobId);
  expect(s.dispose).toHaveBeenCalledTimes(1);
});
it('coalesces rechecks, retains the original source, and confirms only after read-only proof', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockRejectedValue(new Error('DIRECTORY_SAVE_UNCONFIRMED'));
  let finish!: () => void;
  const check = vi
    .fn<NonNullable<Dependencies['directoryRecheck']>>()
    .mockImplementation(async (r) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { handleId: r.handleId, fileName: 'video (1).webm', size: r.size };
    });
  const s = setup(save, check),
    job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  expect(() => s.executor.recheckDirectory(job.jobId)).toThrow('DIRECTORY_WRITE_PENDING');
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('unknown'));
  for (let i = 0; i < 10; i++) s.executor.recheckDirectory(job.jobId);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  await expect(s.executor.release(job.jobId)).rejects.toThrow('DIRECTORY_RECONCILIATION_REQUIRED');
  expect(s.dispose).not.toHaveBeenCalled();
  expect(check.mock.calls[0]![0]).toMatchObject({
    handleId: directoryId,
    requestedName: 'video.webm',
    size: 8,
  });
  finish();
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('verified'));
  expect(save).toHaveBeenCalledTimes(1);
  const released = s.executor.release(job.jobId);
  expect(() => s.executor.recheckDirectory(job.jobId)).toThrow('OUTPUT_NOT_READY');
  expect(() => s.executor.saveDirectory(job.jobId, directoryId, ['video.webm'])).toThrow(
    'OUTPUT_NOT_READY',
  );
  await released;
});
it('cancels a recheck without releasing or repeating a save and allows a later check', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockRejectedValue(new Error('DIRECTORY_SAVE_UNCONFIRMED'));
  const check = vi
    .fn<NonNullable<Dependencies['directoryRecheck']>>()
    .mockImplementation(async (r, _f, signal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { handleId: r.handleId, fileName: r.requestedName, size: r.size };
    });
  const s = setup(save, check),
    job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('unknown'));
  s.executor.recheckDirectory(job.jobId);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  expect((await s.executor.cancelDirectory(job.jobId))?.directory?.state).toBe('unknown');
  expect(s.dispose).not.toHaveBeenCalled();
  check.mockImplementationOnce(async (r) => ({
    handleId: r.handleId,
    fileName: r.requestedName,
    size: r.size,
  }));
  s.executor.recheckDirectory(job.jobId);
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('verified'));
  expect(save).toHaveBeenCalledTimes(1);
});
it('saves only ready outputs once, freezes the directory and exposes copied results', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockImplementation(async (r) => ({
      handleId: r.handleId,
      fileName: r.requestedName,
      size: r.size,
    }));
  const s = setup(save),
    job = request();
  s.executor.start(job);
  expect(() => s.executor.saveDirectory(job.jobId, directoryId, ['video.webm'])).toThrow(
    'OUTPUT_NOT_READY',
  );
  await settled(s.executor, job.jobId);
  for (let i = 0; i < 10; i++) s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  expect(() => s.executor.saveDirectory(job.jobId, directoryId, ['other.webm'])).toThrow(
    'DIRECTORY_TARGET_CHANGED',
  );
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('verified'));
  expect(save).toHaveBeenCalledTimes(1);
  const snapshot = s.executor.status(job.jobId)!;
  snapshot.directory!.files[0]!.fileName = 'mutated';
  expect(s.executor.status(job.jobId)?.directory?.files[0]?.fileName).toBe('video.webm');
  await s.executor.release(job.jobId);
  expect(s.dispose).toHaveBeenCalledTimes(1);
});
it('retains prepared source while a directory save is pending or unconfirmed', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockImplementation(async (_r, _f, signal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unexpected');
    });
  const s = setup(save),
    job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm']);
  await expect(s.executor.release(job.jobId)).rejects.toThrow('DIRECTORY_RECONCILIATION_REQUIRED');
  const status = await s.executor.cancelDirectory(job.jobId);
  expect(status?.directory?.state).toBe('unknown');
  await expect(s.executor.release(job.jobId)).rejects.toThrow('DIRECTORY_RECONCILIATION_REQUIRED');
  expect(s.dispose).not.toHaveBeenCalled();
});
it('keeps a verified first file when the second directory save fails', async () => {
  const save = vi
    .fn<NonNullable<Dependencies['directorySave']>>()
    .mockImplementationOnce(async (r) => ({
      handleId: r.handleId,
      fileName: r.requestedName,
      size: r.size,
    }))
    .mockRejectedValueOnce(new Error('DIRECTORY_PERMISSION_REQUIRED'));
  const s = setup(save),
    job = request();
  job.plan = { ...job.plan, mode: 'separate' };
  s.prepare.mockResolvedValue({
    mode: 'separate',
    files: [new File(['v'], 'video.webm'), new File(['a'], 'audio.webm')],
    publicationCommitted: false,
    dispose: s.dispose,
  });
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm', 'audio.webm']);
  await vi.waitFor(() => expect(s.executor.status(job.jobId)?.directory?.state).toBe('unknown'));
  expect(s.executor.status(job.jobId)?.directory?.files).toEqual([
    { kind: 'video', handleId: directoryId, fileName: 'video.webm', size: 1 },
  ]);
  s.executor.saveDirectory(job.jobId, directoryId, ['video.webm', 'audio.webm']);
  expect(save).toHaveBeenCalledTimes(2);
});
it('allows only one same-plan address refresh after a clean transport failure', async () => {
  const s = setup();
  s.prepare.mockRejectedValue(new Error('SOURCE_HTTP_403'));
  const job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  await expect(
    s.executor.refresh({ ...job, plan: { ...job.plan, mode: 'separate' } }),
  ).rejects.toThrow('JOB_SELECTION_CHANGED');
  expect((await s.executor.refresh(job)).state).toBe('preparing');
  await settled(s.executor, job.jobId);
  await expect(s.executor.refresh(job)).rejects.toThrow('SOURCE_REFRESH_UNAVAILABLE');
  expect(s.prepare).toHaveBeenCalledTimes(2);
  expect(s.createUrl).not.toHaveBeenCalled();
});
it('coalesces concurrent refresh attempts to one new acquisition', async () => {
  const s = setup();
  s.prepare.mockRejectedValue(new Error('SOURCE_HTTP_403'));
  const job = request();
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => s.executor.refresh(job)),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  await settled(s.executor, job.jobId);
  expect(s.prepare).toHaveBeenCalledTimes(2);
});
it('does not replace a failed owner whose temporary-file disposal failed', async () => {
  const s = setup();
  s.createUrl.mockImplementation(() => {
    throw new Error('SOURCE_HTTP_403');
  });
  s.dispose.mockRejectedValue(new Error('DISK_BUSY'));
  const job = request();
  s.executor.start(job);
  await vi.waitFor(() =>
    expect(s.executor.status(job.jobId)?.error).toBe('TEMPORARY_CLEANUP_FAILED'),
  );
  await expect(s.executor.refresh(job)).rejects.toThrow('SOURCE_REFRESH_UNAVAILABLE');
  expect(s.prepare).toHaveBeenCalledTimes(1);
  expect(s.dispose).toHaveBeenCalledTimes(1);
  s.dispose.mockResolvedValue(undefined);
  await s.executor.release(job.jobId);
  expect(s.dispose).toHaveBeenCalledTimes(2);
});
it('never refreshes ready files, verification failures, or a canceled failed task', async () => {
  for (const failure of [null, 'TRACK_IDENTITY_MISMATCH', 'SOURCE_HTTP_403']) {
    const s = setup();
    if (failure) s.prepare.mockRejectedValue(new Error(failure));
    const job = request();
    s.executor.start(job);
    await settled(s.executor, job.jobId);
    if (failure === 'SOURCE_HTTP_403') await s.executor.cancel(job.jobId);
    await expect(s.executor.refresh(job)).rejects.toThrow('SOURCE_REFRESH_UNAVAILABLE');
    expect(s.prepare).toHaveBeenCalledTimes(1);
  }
});
it('ten repeated starts prepare only once and readiness is not publication', async () => {
  const { executor, prepare, dispose } = setup();
  const job = request();
  for (let i = 0; i < 10; i++) executor.start(job);
  await settled(executor, job.jobId);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(executor.status(job.jobId)).toMatchObject({ state: 'ready', publicationCommitted: false });
  expect(dispose).not.toHaveBeenCalled();
});

it('reports actual preparation stage callbacks and ignores callbacks after readiness', async () => {
  const s = setup();
  const job = request();
  s.prepare.mockImplementationOnce(async (_plan, _id, _session, _mode, options) => {
    for (const stage of [
      'downloading',
      'verifying-source',
      'merging',
      'verifying-output',
    ] as const) {
      options.onStage?.(stage);
      expect(s.executor.status(job.jobId)).toMatchObject({
        state: 'preparing',
        preparationStage: stage,
        publicationCommitted: false,
      });
    }
    return {
      mode: 'merge',
      files: [new File(['verified'], 'video.webm')],
      publicationCommitted: false,
      dispose: s.dispose,
    };
  });
  s.executor.start(job);
  await settled(s.executor, job.jobId);
  s.prepare.mock.calls[0]![4].onStage?.('downloading');
  expect(s.executor.status(job.jobId)).toMatchObject({
    state: 'ready',
    preparationStage: 'verifying-output',
    publicationCommitted: false,
  });
});
it('freezes execution identity against subsequent caller mutation and rejects changed duplicate plans', async () => {
  const { executor, prepare } = setup();
  const job = request();
  executor.start(job);
  job.plan = { ...job.plan, videoId: 'zyxwvutsrqp' };
  expect(() => executor.start(job)).toThrow('JOB_SELECTION_CHANGED');
  await settled(executor, job.jobId);
  expect(prepare.mock.calls[0]?.[0].videoId).toBe('abcdefghijk');
});
it('cancels before execution without starting any request', async () => {
  const { executor, prepare } = setup();
  const job = request();
  executor.start(job);
  const cancel = executor.cancel(job.jobId);
  expect(executor.status(job.jobId)?.state).toBe('canceling');
  expect((await cancel)?.state).toBe('canceled');
  expect(prepare).not.toHaveBeenCalled();
});
it('cancel during preparation reaches the signal and cleans a late result without creating URLs', async () => {
  const { executor, prepare, dispose, createUrl } = setup();
  let finish!: (result: Awaited<ReturnType<typeof prepareYouTubeDownload>>) => void;
  prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const job = request();
  executor.start(job);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  const canceled = executor.cancel(job.jobId);
  expect(prepare.mock.calls[0]?.[4].signal.aborted).toBe(true);
  finish({
    mode: 'merge',
    files: [new File(['x'], 'v.webm')],
    dispose,
    publicationCommitted: false,
  });
  expect((await canceled)?.state).toBe('canceled');
  expect(createUrl).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});
it('keeps ready URLs until explicit release and does not restart a released ID', async () => {
  const { executor, prepare, dispose, revokeUrl } = setup();
  const job = request();
  executor.start(job);
  await settled(executor, job.jobId);
  await expect(executor.cancel(job.jobId)).rejects.toThrow('OUTPUT_RELEASE_REQUIRED');
  expect(dispose).not.toHaveBeenCalled();
  await Promise.all([executor.release(job.jobId), executor.release(job.jobId)]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  expect(executor.start(job).state).toBe('released');
  expect(prepare).toHaveBeenCalledTimes(1);
});
it('redacts private errors', async () => {
  const { executor, prepare } = setup();
  prepare.mockRejectedValueOnce(new Error('https://media.example/?token=private'));
  const job = request();
  executor.start(job);
  await settled(executor, job.jobId);
  expect(executor.status(job.jobId)?.error).toBe('YOUTUBE_PREPARATION_FAILED');
  expect(JSON.stringify(executor.status(job.jobId))).not.toContain('private');
});
it('does not expose an empty file as ready', async () => {
  const { executor, prepare, dispose, createUrl } = setup();
  prepare.mockResolvedValueOnce({
    mode: 'merge',
    files: [new File([], 'v.webm')],
    dispose,
    publicationCommitted: false,
  });
  const job = request();
  executor.start(job);
  await settled(executor, job.jobId);
  expect(executor.status(job.jobId)).toMatchObject({
    state: 'failed',
    error: 'OUTPUT_INCOMPLETE',
    files: [],
  });
  expect(createUrl).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});
it('permits retrying failed cleanup without re-preparing media', async () => {
  const { executor, prepare, dispose } = setup();
  const job = request();
  executor.start(job);
  await settled(executor, job.jobId);
  dispose.mockRejectedValueOnce(new Error('busy'));
  await expect(executor.release(job.jobId)).rejects.toThrow('busy');
  await executor.release(job.jobId);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(prepare).toHaveBeenCalledTimes(1);
});
