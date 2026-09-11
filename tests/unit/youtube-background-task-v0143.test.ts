// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  YouTubeBackgroundTasks,
  type YouTubeTaskDependencies,
  type YouTubeTaskRequest,
} from '../../src/modules/youtube/background-task';
import type { YouTubeExecutionStatus } from '../../src/modules/youtube/offscreen-executor';

const request = (): YouTubeTaskRequest => ({
  jobId: '11111111-1111-4111-8111-111111111111',
  owner: {
    tabId: 1,
    documentId: 'doc',
    pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    navigationEpoch: 1,
    mediaEpoch: 1,
  },
  selection: {
    videoId: 'abcdefghijk',
    videoTrackId: 'v',
    audioTrackId: 'a',
    mode: 'merge',
    container: 'webm',
  },
});
function setup(
  checkpoint?: YouTubeTaskDependencies['checkpoint'],
  findDownloads?: YouTubeTaskDependencies['findDownloads'],
  authorizeDirectory?: YouTubeTaskDependencies['authorizeDirectory'],
) {
  const job = request();
  const status: YouTubeExecutionStatus = {
    jobId: job.jobId,
    state: 'ready',
    readBytes: 8,
    publicationCommitted: false,
    files: [
      {
        kind: 'merged',
        name: 'video.webm',
        mime: 'video/webm',
        size: 8,
        url: 'blob:chrome-extension://example/private',
      },
    ],
  };
  const plan = vi.fn<YouTubeTaskDependencies['plan']>().mockResolvedValue({
    videoId: job.selection.videoId,
    mode: 'merge',
    container: 'webm',
  } as never);
  const session = vi.fn<YouTubeTaskDependencies['session']>().mockResolvedValue({
    endpoint: 'https://r1.googlevideo.com/videoplayback?sig=secret',
  } as never);
  const command = vi.fn<YouTubeTaskDependencies['command']>().mockImplementation(async (c) => ({
    ...status,
    state: c.type === 'RELEASE' ? 'released' : status.state,
  }));
  const download = vi.fn<YouTubeTaskDependencies['download']>().mockResolvedValue(42);
  const search = vi
    .fn<YouTubeTaskDependencies['search']>()
    .mockResolvedValue({ state: 'complete', bytesReceived: 8, fileSize: 8 });
  const cancelDownload = vi
    .fn<YouTubeTaskDependencies['cancelDownload']>()
    .mockResolvedValue(undefined);
  const tasks = new YouTubeBackgroundTasks({
    extensionOrigin: 'chrome-extension://example',
    plan,
    session,
    command,
    download,
    search,
    cancelDownload,
    ...(checkpoint ? { checkpoint } : {}),
    ...(findDownloads ? { findDownloads } : {}),
    ...(authorizeDirectory ? { authorizeDirectory } : {}),
    pause: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  return { job, status, tasks, plan, session, command, download, search, cancelDownload };
}
async function finished(s: ReturnType<typeof setup>) {
  await vi.waitFor(() =>
    expect(['complete', 'failed', 'canceled']).toContain(
      s.tasks.status(s.job.jobId, s.job.owner)?.state,
    ),
  );
  return s.tasks.status(s.job.jobId, s.job.owner)!;
}

it('routes a fixed custom target through the directory executor without native downloads', async () => {
  const authorize = vi
    .fn<NonNullable<YouTubeTaskDependencies['authorizeDirectory']>>()
    .mockResolvedValue();
  const s = setup(undefined, undefined, authorize);
  const target = { handleId: 'youtube-22222222-2222-4222-8222-222222222222' };
  s.job.saveLocation = 'custom';
  s.job.directoryTarget = target;
  s.command.mockImplementation(async (c) => {
    if (c.type === 'SAVE_DIRECTORY') {
      expect(c.handleId).toBe(target.handleId);
      expect(c.filenames).toEqual(['abcdefghijk-video.webm']);
      s.status.directory = {
        state: 'verified',
        files: [{ ...target, kind: 'merged', fileName: 'video.webm', size: 8 }],
      };
    }
    return { ...s.status, state: c.type === 'RELEASE' ? 'released' : 'ready' };
  });
  for (let i = 0; i < 10; i++) s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    saveLocation: 'custom',
  });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(s.command.mock.calls.filter((call) => call[0].type === 'SAVE_DIRECTORY')).toHaveLength(1);
  expect(s.download).not.toHaveBeenCalled();
  expect(s.search).not.toHaveBeenCalled();
});
it.each(['retry', 'discard'] as const)(
  'retains partial directory output until explicit %s',
  async (action) => {
    const checkpoint = vi
      .fn<NonNullable<YouTubeTaskDependencies['checkpoint']>>()
      .mockResolvedValue();
    const s = setup(checkpoint, undefined, async () => {});
    const handleId = 'youtube-22222222-2222-4222-8222-222222222222';
    s.job.saveLocation = 'custom';
    s.job.directoryTarget = { handleId };
    s.job.selection.mode = 'separate';
    s.plan.mockResolvedValue({
      videoId: s.job.selection.videoId,
      mode: 'separate',
      container: null,
    } as never);
    s.status.files = ['video', 'audio'].map((kind) => ({
      kind: kind as 'video' | 'audio',
      name: `${kind}.webm`,
      mime: `${kind}/webm`,
      size: 8,
      url: `blob:chrome-extension://example/${kind}`,
    }));
    s.command.mockImplementation(async (command) => {
      if (command.type === 'SAVE_DIRECTORY')
        s.status.directory = {
          state: 'stopped',
          files: [{ kind: 'video', handleId, fileName: 'video.webm', size: 8 }],
          removed: [{ kind: 'audio', handleId, fileName: 'audio.webm', size: 8 }],
          unstarted: [],
        };
      if (command.type === 'RETRY_DIRECTORY') {
        expect(checkpoint.mock.calls.some(([record]) => record.saveAttempt === 1)).toBe(true);
        s.status.directory = {
          state: 'verified',
          attempt: command.attempt,
          files: ['video', 'audio'].map((kind) => ({
            kind: kind as 'video' | 'audio',
            handleId,
            fileName: `${kind}.webm`,
            size: 8,
          })),
        };
      }
      return {
        ...structuredClone(s.status),
        state: command.type === 'RELEASE' ? 'released' : 'ready',
      };
    });
    s.tasks.start(s.job);
    await vi.waitFor(() =>
      expect(s.tasks.status(s.job.jobId, s.job.owner)?.retryAvailable).toBe(true),
    );
    expect(s.command.mock.calls.some(([command]) => command.type === 'RELEASE')).toBe(false);
    if (action === 'retry') {
      for (let i = 0; i < 10; i++) s.tasks.retry(s.job.jobId, s.job.owner);
      await vi.waitFor(() =>
        expect(s.tasks.status(s.job.jobId, s.job.owner)?.state).toBe('complete'),
      );
      expect(
        s.command.mock.calls.filter(([command]) => command.type === 'RETRY_DIRECTORY'),
      ).toHaveLength(1);
    } else await s.tasks.discard(s.job.jobId, s.job.owner);
    await vi.waitFor(() =>
      expect(s.tasks.status(s.job.jobId, s.job.owner)?.cleanupPending).toBe(false),
    );
    expect(s.command.mock.calls.filter(([command]) => command.type === 'RELEASE')).toHaveLength(1);
    expect(s.plan).toHaveBeenCalledTimes(1);
    expect(s.download).not.toHaveBeenCalled();
  },
);
it('refuses custom acquisition without authorization and rechecks permission before saving', async () => {
  const unavailable = setup();
  unavailable.job.saveLocation = 'custom';
  unavailable.job.directoryTarget = { handleId: 'youtube-22222222-2222-4222-8222-222222222222' };
  expect(() => unavailable.tasks.start(unavailable.job)).toThrow('DIRECTORY_TARGET_UNAVAILABLE');
  const authorize = vi
    .fn<NonNullable<YouTubeTaskDependencies['authorizeDirectory']>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('DIRECTORY_PERMISSION_REQUIRED'));
  const s = setup(undefined, undefined, authorize);
  s.job.saveLocation = 'custom';
  s.job.directoryTarget = unavailable.job.directoryTarget;
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    error: 'DIRECTORY_PERMISSION_REQUIRED',
  });
  expect(s.command.mock.calls.some((call) => call[0].type === 'SAVE_DIRECTORY')).toBe(false);
  expect(s.download).not.toHaveBeenCalled();
});
it('retains an uncertain directory acknowledgement without falling back or releasing', async () => {
  const authorize = vi
    .fn<NonNullable<YouTubeTaskDependencies['authorizeDirectory']>>()
    .mockResolvedValue();
  const s = setup(undefined, undefined, authorize);
  s.job.saveLocation = 'custom';
  s.job.directoryTarget = { handleId: 'youtube-22222222-2222-4222-8222-222222222222' };
  s.command.mockImplementation(async (c) => {
    if (c.type === 'SAVE_DIRECTORY') throw new Error('Lost acknowledgement with private URL');
    return s.status;
  });
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    error: 'DIRECTORY_RECOVERY_PENDING',
    cleanupPending: true,
  });
  expect(s.command.mock.calls.some((call) => call[0].type === 'RELEASE')).toBe(false);
  expect(s.download).not.toHaveBeenCalled();
});

it.each(['changed', 'same', 'failed-again', 'cancel'] as const)(
  'refreshes an address only once with exact original ownership: %s',
  async (scenario) => {
    const s = setup();
    s.session.mockImplementation(async () => {
      const second = s.session.mock.calls.length > 1;
      if (second)
        expect(s.tasks.status(s.job.jobId, s.job.owner)?.preparationStage).toBe(
          'refreshing-source',
        );
      if (second && scenario === 'cancel') s.tasks.cancel(s.job.jobId, s.job.owner);
      return {
        kind: 'direct',
        address: `https://r1.googlevideo.com/videoplayback?expire=1999999999&sig=${second && scenario !== 'same' ? 'new' : 'old'}`,
      } as never;
    });
    s.command.mockImplementation(async (command) => ({
      ...s.status,
      ...(command.type === 'START' || (command.type === 'REFRESH' && scenario === 'failed-again')
        ? { state: 'failed' as const, files: [], error: 'SOURCE_HTTP_403' }
        : command.type === 'RELEASE'
          ? { state: 'released' as const }
          : {}),
    }));
    s.tasks.start(s.job);
    const result = await finished(s);
    expect(result.state).toBe(
      scenario === 'changed' ? 'complete' : scenario === 'cancel' ? 'canceled' : 'failed',
    );
    expect(s.session).toHaveBeenCalledTimes(2);
    expect(s.command.mock.calls.filter(([c]) => c.type === 'REFRESH')).toHaveLength(
      scenario === 'changed' || scenario === 'failed-again' ? 1 : 0,
    );
    expect(s.download).toHaveBeenCalledTimes(scenario === 'changed' ? 1 : 0);
    expect(s.session.mock.calls[1]![0]).toEqual(s.session.mock.calls[0]![0]);
    expect(s.session.mock.calls[1]![1]).toEqual(s.job.owner);
    expect(JSON.stringify(result)).not.toMatch(/sig=|googlevideo/u);
  },
);

function restoreSaving(s: ReturnType<typeof setup>, savePending = false) {
  s.tasks.restore([
    {
      request: s.job,
      state: 'saving',
      dispatched: true,
      cleanupPending: true,
      savePending,
      files: [{ kind: 'merged', size: 8, downloadId: savePending ? null : 42 }],
    },
  ]);
}

function restoreUnknownSave(s: ReturnType<typeof setup>, previousId: number | null = null) {
  s.tasks.restore([
    {
      request: s.job,
      state: 'saving',
      dispatched: true,
      cleanupPending: true,
      savePending: true,
      pendingFile: 0,
      files: [{ kind: 'merged', size: 8, downloadId: previousId }],
    },
  ]);
}
const recoveredDownload = {
  id: 77,
  url: 'blob:chrome-extension://example/private',
  byExtensionId: 'example',
};
it('recovers an unacknowledged native save only by its exact owned blob URL', async () => {
  const checkpoint = vi
    .fn<NonNullable<YouTubeTaskDependencies['checkpoint']>>()
    .mockResolvedValue(undefined);
  const find = vi
    .fn<NonNullable<YouTubeTaskDependencies['findDownloads']>>()
    .mockResolvedValue([recoveredDownload]);
  const s = setup(checkpoint, find);
  restoreUnknownSave(s);
  await s.tasks.refreshRecovered();
  expect(find).toHaveBeenCalledWith(recoveredDownload.url);
  expect(s.search).toHaveBeenCalledWith(77);
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
  });
  expect(checkpoint.mock.calls[0]![0]).toMatchObject({
    savePending: false,
    files: [{ downloadId: 77 }],
  });
  expect(s.download).not.toHaveBeenCalled();
});
it.each(
  [
    [],
    [recoveredDownload, { ...recoveredDownload, id: 78 }],
    [{ ...recoveredDownload, byExtensionId: 'another' }],
    [{ ...recoveredDownload, url: 'blob:chrome-extension://example/other' }],
  ].map((matches) => ({ matches })),
)('leaves ambiguous or foreign download matches unresolved: %j', async ({ matches }) => {
  const s = setup(undefined, async () => matches);
  restoreUnknownSave(s);
  await s.tasks.refreshRecovered();
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    cleanupPending: true,
  });
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
  expect(s.download).not.toHaveBeenCalled();
});
it('excludes the already recorded failed save when recovering an explicit retry', async () => {
  const s = setup(undefined, async () => [{ ...recoveredDownload, id: 42 }, recoveredDownload]);
  restoreUnknownSave(s, 42);
  await s.tasks.refreshRecovered();
  expect(s.search).toHaveBeenCalledWith(77);
  expect(s.search).not.toHaveBeenCalledWith(42);
});
it('does not release output when persisting the recovered ID fails', async () => {
  const s = setup(
    async () => {
      throw new Error('storage failed');
    },
    async () => [recoveredDownload],
  );
  restoreUnknownSave(s);
  await s.tasks.refreshRecovered();
  expect(s.search).not.toHaveBeenCalled();
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
});
it('restores a completed native save without downloading or resolving a source again', async () => {
  const s = setup();
  restoreSaving(s);
  await s.tasks.refreshRecovered();
  expect(s.tasks.current(s.job.owner, s.job.selection.videoId)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
  });
  expect(s.plan).not.toHaveBeenCalled();
  expect(s.session).not.toHaveBeenCalled();
  expect(s.download).not.toHaveBeenCalled();
  expect(s.command.mock.calls.map(([c]) => c.type)).toEqual(['RELEASE']);
});
it('observes an ongoing native save after restart and does not release its output', async () => {
  const s = setup();
  restoreSaving(s);
  s.search.mockResolvedValue({ state: 'in_progress', bytesReceived: 4, fileSize: 8 });
  await s.tasks.refreshRecovered();
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'saving',
    cleanupPending: true,
  });
  expect(s.command).not.toHaveBeenCalled();
  expect(() => s.tasks.start({ ...s.job, jobId: '22222222-2222-4222-8222-222222222222' })).toThrow(
    'JOB_BUSY',
  );
  s.search.mockResolvedValue({ state: 'complete', bytesReceived: 8, fileSize: 8 });
  await s.tasks.refreshRecovered();
  expect(s.tasks.status(s.job.jobId, s.job.owner)?.state).toBe('complete');
});

it('records cancellation before stopping a recovered native save and confirming its final state', async () => {
  const records: Parameters<NonNullable<YouTubeTaskDependencies['checkpoint']>>[0][] = [];
  const s = setup(async (record) => {
    records.push(structuredClone(record));
  });
  restoreSaving(s);
  let canceled = false;
  s.search.mockImplementation(async () => ({
    state: canceled ? 'interrupted' : 'in_progress',
    bytesReceived: 4,
    fileSize: 8,
  }));
  s.cancelDownload.mockImplementation(async () => {
    expect(records.at(-1)?.cancelRequested).toBe(true);
    canceled = true;
  });
  await s.tasks.refreshRecovered();
  expect(await s.tasks.cancelAndRecord(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'canceled',
    cleanupPending: false,
  });
  expect(s.cancelDownload).toHaveBeenCalledWith(42);
  expect(s.download).not.toHaveBeenCalled();
});

it('keeps cancellation intent through another restart even when the prior state was unknown', async () => {
  const s = setup();
  s.tasks.restore([
    {
      request: s.job,
      state: 'failed',
      dispatched: true,
      cleanupPending: true,
      savePending: false,
      cancelRequested: true,
      files: [{ kind: 'merged', size: 8, downloadId: 42 }],
    },
  ]);
  let canceled = false;
  s.search.mockImplementation(async () => ({
    state: canceled ? 'interrupted' : 'in_progress',
    bytesReceived: 4,
    fileSize: 8,
  }));
  s.cancelDownload.mockImplementation(async () => {
    canceled = true;
  });
  await s.tasks.refreshRecovered();
  expect(s.cancelDownload).toHaveBeenCalledTimes(1);
  expect(s.tasks.status(s.job.jobId, s.job.owner)?.state).toBe('canceled');
});

it('does not label a completed recovered file as canceled', async () => {
  const s = setup();
  restoreSaving(s);
  expect(await s.tasks.cancelAndRecord(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
  });
  expect(s.cancelDownload).not.toHaveBeenCalled();
});

it('does not acknowledge durable cancellation when its checkpoint fails', async () => {
  const s = setup(async () => {
    throw new Error('storage-failed');
  });
  restoreSaving(s);
  s.search.mockResolvedValue({ state: 'in_progress', bytesReceived: 4, fileSize: 8 });
  await s.tasks.refreshRecovered();
  await expect(s.tasks.cancelAndRecord(s.job.jobId, s.job.owner)).rejects.toThrow(
    'TASK_CHECKPOINT_FAILED',
  );
  expect(s.tasks.status(s.job.jobId, s.job.owner)?.state).toBe('canceling');
  expect(s.cancelDownload).toHaveBeenCalledWith(42);
});
it('never releases or repeats a native save whose ID was not acknowledged', async () => {
  const s = setup();
  restoreSaving(s, true);
  await s.tasks.refreshRecovered();
  await s.tasks.recheck(s.job.jobId, s.job.owner);
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    error: 'SAVE_STATUS_UNAVAILABLE',
    cleanupPending: true,
  });
  expect(s.command).not.toHaveBeenCalled();
  expect(s.download).not.toHaveBeenCalled();
});
it('keeps unknown browser history unresolved rather than accepting the recorded state', async () => {
  const s = setup();
  restoreSaving(s);
  s.search.mockResolvedValue(undefined);
  await s.tasks.refreshRecovered();
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    cleanupPending: true,
  });
  expect(s.command).not.toHaveBeenCalled();
});
it('marks interrupted preparation and releases the original executor without starting it again', async () => {
  const s = setup();
  s.tasks.restore([
    {
      request: s.job,
      state: 'preparing',
      dispatched: true,
      cleanupPending: true,
      savePending: false,
      files: [],
    },
  ]);
  await s.tasks.refreshRecovered();
  expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    error: 'TASK_INTERRUPTED',
    cleanupPending: false,
  });
  expect(s.command.mock.calls.map(([c]) => c.type)).toEqual(['RELEASE']);
  expect(s.session).not.toHaveBeenCalled();
});
it('rejects a new document trying to use the restored task ID', () => {
  const s = setup();
  restoreSaving(s);
  expect(() => s.tasks.status(s.job.jobId, { ...s.job.owner, documentId: 'other' })).toThrow(
    'JOB_OWNER_CHANGED',
  );
});

it('persists ownership before acquisition and pending save before its native call', async () => {
  const records: Parameters<NonNullable<YouTubeTaskDependencies['checkpoint']>>[0][] = [];
  const checkpoint = vi.fn<NonNullable<YouTubeTaskDependencies['checkpoint']>>(async (record) => {
    records.push(structuredClone(record));
  });
  const s = setup(checkpoint);
  s.download.mockImplementation(async () => {
    expect(records.at(-1)).toMatchObject({
      savePending: true,
      files: [{ size: 8, downloadId: null }],
    });
    return 42;
  });
  s.tasks.start(s.job);
  expect((await finished(s)).state).toBe('complete');
  expect(records[0]).toMatchObject({ dispatched: false, savePending: false, files: [] });
  expect(records.some((r) => r.dispatched && r.files.length === 0)).toBe(true);
  expect(records.some((r) => !r.savePending && r.files[0]?.downloadId === 42)).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(/blob:|sig=|private/u);
});

it.each([1, 2, 3])(
  'stops before the next external action when checkpoint %i fails',
  async (failAt) => {
    let calls = 0;
    const checkpoint = vi.fn<NonNullable<YouTubeTaskDependencies['checkpoint']>>(async () => {
      if (++calls === failAt) throw new Error('private storage error');
    });
    const s = setup(checkpoint);
    s.tasks.start(s.job);
    const result = await finished(s);
    expect(result.error).toBe('TASK_CHECKPOINT_FAILED');
    expect(s.download).not.toHaveBeenCalled();
    if (failAt === 1) expect(s.plan).not.toHaveBeenCalled();
    if (failAt <= 2)
      expect(s.command.mock.calls.filter(([c]) => c.type === 'START')).toHaveLength(0);
  },
);

it('retains output ownership if a native save returns an unusable ID', async () => {
  const s = setup();
  s.download.mockResolvedValue(NaN);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', cleanupPending: true });
  await s.tasks.recheck(s.job.jobId, s.job.owner);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(0);
});

it('refreshes an explicitly stale address against the same plan before starting one execution', async () => {
  const s = setup();
  const old = {
    kind: 'direct-file',
    address: 'https://r1.googlevideo.com/videoplayback?expire=1000000000',
  };
  const fresh = { ...old, address: 'https://r1.googlevideo.com/videoplayback?expire=9000000000' };
  s.session.mockResolvedValueOnce(old as never).mockResolvedValueOnce(fresh as never);
  s.tasks.start(s.job);
  expect((await finished(s)).state).toBe('complete');
  expect(s.plan).toHaveBeenCalledTimes(1);
  expect(s.session).toHaveBeenCalledTimes(2);
  expect(s.session.mock.calls[1]![0]).toBe(s.session.mock.calls[0]![0]);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'START')).toHaveLength(1);
  expect(s.download).toHaveBeenCalledTimes(1);
});

it('does not allocate offscreen work or save a file when the refreshed address remains stale', async () => {
  const s = setup();
  s.session.mockResolvedValue({
    kind: 'direct-file',
    address: 'https://r1.googlevideo.com/videoplayback?expire=1000000000',
  } as never);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    error: 'SOURCE_ADDRESS_EXPIRED',
    cleanupPending: false,
  });
  expect(s.session).toHaveBeenCalledTimes(2);
  expect(s.command).not.toHaveBeenCalled();
  expect(s.download).not.toHaveBeenCalled();
});

it('ten repeated starts have one fixed source resolution and save; snapshots contain no private URLs', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) s.tasks.start(s.job);
  s.job.selection.videoTrackId = 'mutated';
  const result = await finished(s);
  expect(result).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    files: [{ state: 'complete' }],
  });
  expect(s.plan).toHaveBeenCalledTimes(1);
  expect(s.plan.mock.calls[0]![0].selection.videoTrackId).toBe('v');
  expect(s.download).toHaveBeenCalledTimes(1);
  expect(s.download.mock.calls[0]![0]).toMatchObject({
    filename: 'FoxFetch/YouTube/abcdefghijk-video.webm',
    conflictAction: 'uniquify',
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|blob:|googlevideo|https:/u);
  expect(() => s.tasks.start(s.job)).toThrow('JOB_SELECTION_CHANGED');
  expect(() => s.tasks.status(s.job.jobId, { tabId: 2, documentId: 'doc' })).toThrow(
    'JOB_OWNER_CHANGED',
  );
});
it('ready output is not success while Chrome is still saving and release waits', async () => {
  const s = setup();
  s.search.mockResolvedValue({ state: 'in_progress', bytesReceived: 3, fileSize: 8 });
  s.tasks.start(s.job);
  await vi.waitFor(() => expect(s.search).toHaveBeenCalled());
  expect(s.tasks.status(s.job.jobId, s.job.owner)?.state).toBe('saving');
  expect(s.tasks.status(s.job.jobId, s.job.owner)?.files).toMatchObject([
    { savedBytes: 3, size: 8 },
  ]);
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
  s.search.mockResolvedValue({ state: 'complete', bytesReceived: 8, fileSize: 8 });
  expect((await finished(s)).state).toBe('complete');
});

it('forwards preparation stages without treating verification as a saved file', async () => {
  const s = setup();
  s.status.state = 'preparing';
  s.status.preparationStage = 'verifying-output';
  s.tasks.start(s.job);
  await vi.waitFor(() =>
    expect(s.tasks.status(s.job.jobId, s.job.owner)).toMatchObject({
      state: 'preparing',
      preparationStage: 'verifying-output',
    }),
  );
  expect(s.download).not.toHaveBeenCalled();
  s.status.state = 'ready';
  expect((await finished(s)).state).toBe('complete');
});
it('cancel before source resolution does no work', async () => {
  const s = setup();
  s.tasks.start(s.job);
  s.tasks.cancel(s.job.jobId, s.job.owner);
  expect((await finished(s)).state).toBe('canceled');
  expect(s.plan).not.toHaveBeenCalled();
  expect(s.download).not.toHaveBeenCalled();
});
it('cancel during preparation releases the executor and never saves a ready race result', async () => {
  const s = setup();
  s.status.state = 'preparing';
  s.tasks.start(s.job);
  await vi.waitFor(() => expect(s.command).toHaveBeenCalled());
  s.tasks.cancel(s.job.jobId, s.job.owner);
  s.status.state = 'ready';
  expect((await finished(s)).state).toBe('canceled');
  expect(s.download).not.toHaveBeenCalled();
  expect(s.command).toHaveBeenCalledWith({ type: 'RELEASE', jobId: s.job.jobId });
});
it('cancel while downloads.download is pending cancels its late ID before releasing output', async () => {
  const s = setup();
  let accept!: (id: number) => void;
  s.download.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  s.search.mockResolvedValue({ state: 'interrupted', bytesReceived: 0, fileSize: 8 });
  s.tasks.start(s.job);
  await vi.waitFor(() => expect(s.download).toHaveBeenCalled());
  s.tasks.cancel(s.job.jobId, s.job.owner);
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
  accept(99);
  expect((await finished(s)).state).toBe('canceled');
  expect(s.cancelDownload).toHaveBeenCalledWith(99);
  expect(s.cancelDownload.mock.invocationCallOrder[0]).toBeLessThan(
    s.command.mock.invocationCallOrder.at(-1)!,
  );
});
it('a missing browser status keeps the output rather than assuming it can be released', async () => {
  const s = setup();
  s.search.mockResolvedValue(undefined);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', cleanupPending: true });
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
});
it('wrong completed size is failure, not complete', async () => {
  const s = setup();
  s.search.mockResolvedValue({ state: 'complete', bytesReceived: 7, fileSize: 7 });
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', error: 'SAVE_INCOMPLETE' });
});
it('separate partial failure retains successful file status and stops the other reader before cleanup', async () => {
  const s = setup();
  s.job.selection.mode = 'separate';
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'separate',
    container: null,
  } as never);
  s.status.files = [
    { ...s.status.files[0]!, kind: 'video' },
    { ...s.status.files[0]!, kind: 'audio', name: 'audio.webm' },
  ];
  s.download.mockResolvedValueOnce(42).mockResolvedValueOnce(43);
  s.search.mockImplementation(async (id) => ({
    state: id === 42 ? 'complete' : 'interrupted',
    bytesReceived: id === 42 ? 8 : 3,
    fileSize: 8,
  }));
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    files: [{ state: 'complete' }, { state: 'interrupted' }],
  });
});
it('source failure is sanitized, and a different new task ID can run after it', async () => {
  const s = setup();
  s.session.mockRejectedValueOnce(new Error('https://r1.googlevideo.com/?secret=private'));
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', error: 'DOWNLOAD_FAILED' });
  expect(s.download).not.toHaveBeenCalled();
  s.job.jobId = '22222222-2222-4222-8222-222222222222';
  s.status.jobId = s.job.jobId;
  s.tasks.start(s.job);
  expect((await finished(s)).state).toBe('complete');
});
it('rejects offscreen output from another extension before Chrome save', async () => {
  const s = setup();
  s.status.files[0]!.url = 'blob:chrome-extension://attacker/private';
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', error: 'OUTPUT_INVALID' });
  expect(s.download).not.toHaveBeenCalled();
});

it('recheck retains unknown or active saves and releases only after exact browser completion', async () => {
  const s = setup();
  s.search.mockResolvedValue(undefined);
  s.tasks.start(s.job);
  await finished(s);
  expect(await s.tasks.recheck(s.job.jobId, s.job.owner)).toMatchObject({ cleanupPending: true });
  s.search.mockResolvedValue({ state: 'in_progress', bytesReceived: 4, fileSize: 8 });
  await s.tasks.recheck(s.job.jobId, s.job.owner);
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
  s.search.mockResolvedValue({ state: 'complete', bytesReceived: 8, fileSize: 8 });
  expect(await s.tasks.recheck(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    files: [{ state: 'complete' }],
  });
  expect(s.download).toHaveBeenCalledTimes(1);
});

it('reports success when cancellation loses the race to a fully saved file', async () => {
  const s = setup();
  let resolve!: (id: number) => void;
  s.download.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  s.tasks.start(s.job);
  await vi.waitFor(() => expect(s.download).toHaveBeenCalledTimes(1));
  s.tasks.cancel(s.job.jobId, s.job.owner);
  resolve(42);
  const result = await finished(s);
  expect(result).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    files: [{ state: 'complete' }],
  });
  expect(result.error).toBeUndefined();
  expect(s.cancelDownload).toHaveBeenCalledWith(42);
});

it('recheck deduplicates concurrent requests and keeps ownership after a wrong-job release', async () => {
  const s = setup();
  s.search.mockResolvedValue(undefined);
  s.tasks.start(s.job);
  await finished(s);
  let resolve!: (value: YouTubeExecutionStatus) => void;
  s.command.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  s.search.mockResolvedValue({ state: 'complete', bytesReceived: 8, fileSize: 8 });
  const checks = Array.from({ length: 10 }, () => s.tasks.recheck(s.job.jobId, s.job.owner));
  await vi.waitFor(() =>
    expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(1),
  );
  resolve({ ...s.status, state: 'released', jobId: 'other-job' });
  for (const result of await Promise.all(checks)) expect(result?.cleanupPending).toBe(true);
  s.command.mockResolvedValue({ ...s.status, state: 'released' });
  expect(await s.tasks.recheck(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    files: [{ state: 'complete' }],
  });
});

it('recheck rejects another owner and does not touch an already released task', async () => {
  const s = setup();
  s.tasks.start(s.job);
  await finished(s);
  await expect(
    s.tasks.recheck(s.job.jobId, { ...s.job.owner, documentId: 'other' }),
  ).rejects.toThrow('JOB_OWNER_CHANGED');
  s.command.mockClear();
  s.search.mockClear();
  expect((await s.tasks.recheck(s.job.jobId, s.job.owner))?.state).toBe('complete');
  expect(s.command).not.toHaveBeenCalled();
  expect(s.search).not.toHaveBeenCalled();
  expect(await s.tasks.recheck('unknown', s.job.owner)).toBeNull();
});

it('recheck turns a formerly unknown partial save into a retry of only the failed file', async () => {
  const s = setup();
  s.job.selection.mode = 'separate';
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'separate',
    container: null,
  } as never);
  s.status.files = [
    { ...s.status.files[0]!, kind: 'video' },
    { ...s.status.files[0]!, kind: 'audio', name: 'audio.webm' },
  ];
  s.download.mockResolvedValueOnce(42).mockResolvedValueOnce(43).mockResolvedValueOnce(44);
  s.search.mockResolvedValue(undefined);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ state: 'failed', cleanupPending: true });
  s.search.mockImplementation(async (id) => ({
    state: id === 43 ? 'interrupted' : 'complete',
    bytesReceived: id === 43 ? 2 : 8,
    fileSize: 8,
  }));
  expect(await s.tasks.recheck(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    error: 'SAVE_INCOMPLETE',
    retryAvailable: true,
    cleanupPending: true,
    files: [{ state: 'complete' }, { state: 'interrupted' }],
  });
  expect(s.command.mock.calls.some(([c]) => c.type === 'RELEASE')).toBe(false);
  s.tasks.retry(s.job.jobId, s.job.owner);
  expect(await finished(s)).toMatchObject({ state: 'complete', cleanupPending: false });
  expect(s.download.mock.calls.map(([o]) => o.filename.split('/').at(-1))).toEqual([
    'abcdefghijk-video.webm',
    'abcdefghijk-audio.webm',
    'abcdefghijk-audio.webm',
  ]);
  expect(s.plan).toHaveBeenCalledTimes(1);
});

it('freezes the requested save dialog choice and rejects changing it for the same task', async () => {
  const s = setup();
  s.job.saveLocation = 'ask';
  s.tasks.start(s.job);
  s.job.saveLocation = 'browser-default';
  expect(() => s.tasks.start(s.job)).toThrow('JOB_SELECTION_CHANGED');
  expect(await finished(s)).toMatchObject({ state: 'complete', saveLocation: 'ask' });
  expect(s.download).toHaveBeenCalledWith(
    expect.objectContaining({ saveAs: true, conflictAction: 'uniquify' }),
  );
});

it('a rejected save dialog never reports success or retries the save automatically', async () => {
  const s = setup();
  s.job.saveLocation = 'ask';
  s.download.mockRejectedValue(new Error('User canceled the save dialog'));
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    files: [{ kind: 'merged', state: 'interrupted' }],
    cleanupPending: true,
    retryAvailable: true,
  });
  expect(s.download).toHaveBeenCalledTimes(1);
});

it('reports both expected outputs if the second separate save cannot start', async () => {
  const s = setup();
  s.job.selection.mode = 'separate';
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'separate',
    container: null,
  } as never);
  s.status.files = [
    { ...s.status.files[0]!, kind: 'video' },
    { ...s.status.files[0]!, kind: 'audio', name: 'audio.webm' },
  ];
  s.download.mockResolvedValueOnce(42).mockRejectedValueOnce(new Error('canceled dialog'));
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({
    state: 'failed',
    error: 'SAVE_START_FAILED',
    files: [
      { kind: 'video', state: 'complete' },
      { kind: 'audio', state: 'interrupted' },
    ],
  });
  expect(s.download).toHaveBeenCalledTimes(2);
});

it('retries only the failed separate output, with one source acquisition and one retry for ten clicks', async () => {
  const s = setup();
  s.job.selection.mode = 'separate';
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'separate',
    container: null,
  } as never);
  s.status.files = [
    { ...s.status.files[0]!, kind: 'video' },
    { ...s.status.files[0]!, kind: 'audio', name: 'audio.webm' },
  ];
  s.download
    .mockResolvedValueOnce(42)
    .mockRejectedValueOnce(new Error('save failed'))
    .mockResolvedValueOnce(43);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ retryAvailable: true, cleanupPending: true });
  expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(0);
  await s.tasks.recheck(s.job.jobId, s.job.owner);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(0);
  for (let i = 0; i < 10; i++) s.tasks.retry(s.job.jobId, s.job.owner);
  expect(await finished(s)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    retryAvailable: false,
  });
  expect(s.download.mock.calls.map(([options]) => options.filename.split('/').at(-1))).toEqual([
    'abcdefghijk-video.webm',
    'abcdefghijk-audio.webm',
    'abcdefghijk-audio.webm',
  ]);
  expect(s.plan).toHaveBeenCalledTimes(1);
  expect(s.session).toHaveBeenCalledTimes(1);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'START')).toHaveLength(1);
});

it.each(['interrupted', 'in_progress'] as const)(
  'ignores a late sibling query after retry has completed: %s',
  async (state) => {
    const s = setup();
    s.job.selection.mode = 'separate';
    s.plan.mockResolvedValue({
      videoId: s.job.selection.videoId,
      mode: 'separate',
      container: null,
    } as never);
    s.status.files = [
      { ...s.status.files[0]!, kind: 'video' },
      { ...s.status.files[0]!, kind: 'audio', name: 'audio.webm' },
    ];
    s.download.mockResolvedValueOnce(42).mockResolvedValueOnce(43).mockResolvedValueOnce(44);
    let late!: (value: Awaited<ReturnType<YouTubeTaskDependencies['search']>>) => void;
    const pending = new Promise<Awaited<ReturnType<YouTubeTaskDependencies['search']>>>(
      (resolve) => {
        late = resolve;
      },
    );
    let firstVideo = true;
    let firstAudio = true;
    s.search.mockImplementation(async (id) => {
      if (id === 42 && firstVideo) {
        firstVideo = false;
        return pending;
      }
      if (id === 43 && firstAudio) {
        firstAudio = false;
        throw new Error('temporarily unavailable');
      }
      return {
        state: id === 43 ? 'interrupted' : 'complete',
        bytesReceived: id === 43 ? 2 : 8,
        fileSize: 8,
      };
    });
    s.tasks.start(s.job);
    expect(await finished(s)).toMatchObject({ state: 'failed', retryAvailable: true });
    s.tasks.retry(s.job.jobId, s.job.owner);
    const completed = await finished(s);
    expect(completed).toMatchObject({
      state: 'complete',
      files: [{ state: 'complete' }, { state: 'complete' }],
    });
    const queryCount = s.search.mock.calls.length;
    late({ state, bytesReceived: 1, fileSize: 8 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.tasks.status(s.job.jobId, s.job.owner)).toEqual(completed);
    expect(s.download).toHaveBeenCalledTimes(3);
    expect(s.search).toHaveBeenCalledTimes(queryCount);
  },
);

it('explicit discard releases failed outputs and prevents reuse without deleting a saved file', async () => {
  const s = setup();
  s.download.mockRejectedValueOnce(new Error('save failed'));
  s.tasks.start(s.job);
  await finished(s);
  expect(() => s.tasks.retry(s.job.jobId, { ...s.job.owner, tabId: 9 })).toThrow(
    'JOB_OWNER_CHANGED',
  );
  expect(await s.tasks.discard(s.job.jobId, s.job.owner)).toMatchObject({
    state: 'failed',
    cleanupPending: false,
    retryAvailable: false,
  });
  s.tasks.retry(s.job.jobId, s.job.owner);
  expect(s.download).toHaveBeenCalledTimes(1);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(1);
});

it('freezes the verified page title for save retries and keeps uniquify conflict handling', async () => {
  const s = setup();
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'merge',
    container: 'webm',
    title: '原视频标题',
  } as never);
  s.download.mockRejectedValueOnce(new Error('save dialog canceled')).mockResolvedValueOnce(43);
  s.tasks.start(s.job);
  expect(await finished(s)).toMatchObject({ retryAvailable: true });
  s.plan.mockResolvedValue({
    videoId: s.job.selection.videoId,
    mode: 'merge',
    container: 'webm',
    title: '后来改变的标题',
  } as never);
  s.tasks.retry(s.job.jobId, s.job.owner);
  expect(await finished(s)).toMatchObject({ state: 'complete' });
  expect(s.plan).toHaveBeenCalledTimes(1);
  for (const [options] of s.download.mock.calls)
    expect(options).toMatchObject({
      filename: 'FoxFetch/YouTube/原视频标题.webm',
      conflictAction: 'uniquify',
    });
});

it('cancel during a retried pending save waits for the late ID before release', async () => {
  const s = setup();
  s.download.mockRejectedValueOnce(new Error('first save failed'));
  s.tasks.start(s.job);
  await finished(s);
  let resolve!: (id: number) => void;
  s.download.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  expect(s.tasks.retry(s.job.jobId, s.job.owner)).toMatchObject({
    saveAttempt: 1,
    state: 'saving',
  });
  await vi.waitFor(() => expect(s.download).toHaveBeenCalledTimes(2));
  s.tasks.cancel(s.job.jobId, s.job.owner);
  expect(s.command.mock.calls.filter(([c]) => c.type === 'RELEASE')).toHaveLength(0);
  s.search.mockResolvedValue({ state: 'interrupted', bytesReceived: 0, fileSize: 8 });
  resolve(77);
  expect(await finished(s)).toMatchObject({
    state: 'canceled',
    retryAvailable: false,
    cleanupPending: false,
  });
  expect(s.cancelDownload).toHaveBeenCalledWith(77);
  expect(s.plan).toHaveBeenCalledTimes(1);
});

it('discovers only the current owner and prevents two surfaces starting different IDs for one video', async () => {
  const s = setup();
  s.tasks.start(s.job);
  expect(s.tasks.current(s.job.owner, s.job.selection.videoId)?.jobId).toBe(s.job.jobId);
  expect(
    s.tasks.current({ ...s.job.owner, documentId: 'other' }, s.job.selection.videoId),
  ).toBeNull();
  expect(s.tasks.current(s.job.owner, 'othervideo1')).toBeNull();
  expect(() => s.tasks.start({ ...s.job, jobId: '22222222-2222-4222-8222-222222222222' })).toThrow(
    'JOB_BUSY',
  );
  await finished(s);
});
