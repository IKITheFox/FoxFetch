// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  YouTubeTaskJournal,
  readYouTubeRecoveryRecord,
  type YouTubeRecoveryRecord,
} from '../../src/modules/youtube/task-journal';
import { YouTubeBackgroundTasks } from '../../src/modules/youtube/background-task';
const record = (n = 1): YouTubeRecoveryRecord => ({
  request: {
    jobId: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
    owner: {
      tabId: 1,
      documentId: 'document-1',
      pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk&private=secret',
      navigationEpoch: 1,
      mediaEpoch: 1,
    },
    selection: {
      videoId: 'abcdefghijk',
      videoTrackId: '299::separate',
      audioTrackId: '140::separate',
      container: 'auto',
      mode: 'merge',
    },
  },
  state: 'saving',
  dispatched: true,
  cleanupPending: true,
  savePending: true,
  files: [{ kind: 'merged', size: 123, downloadId: null }],
});
function storage() {
  let raw: unknown;
  return {
    read: vi.fn(async () => structuredClone(raw)),
    write: vi.fn(async (value: unknown) => {
      raw = structuredClone(value);
    }),
    set: (value: unknown) => {
      raw = value;
    },
  };
}
it('retains a custom directory identity without storing private directory metadata', async () => {
  const s = storage(),
    r = record();
  r.request.saveLocation = 'custom';
  r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
  const value = {
    ...r,
    request: {
      ...r.request,
      directoryTarget: {
        ...r.request.directoryTarget,
        path: 'C:/private',
        name: 'private-directory',
      },
    },
  };
  await new YouTubeTaskJournal(s).access(value);
  const restored = (await new YouTubeTaskJournal(s).access())[0]!;
  expect(restored.request.saveLocation).toBe('custom');
  expect(restored.request.directoryTarget).toEqual(r.request.directoryTarget);
  expect(JSON.stringify(restored)).not.toContain('private');
  const changed = structuredClone(restored);
  changed.request.directoryTarget!.handleId = 'youtube-33333333-3333-4333-8333-333333333333';
  await expect(new YouTubeTaskJournal(s).access(changed)).rejects.toThrow(
    'TASK_JOURNAL_OWNER_CHANGED',
  );
});
it('rejects missing, wrong-platform and mixed native/directory save ownership', () => {
  const custom = record();
  custom.request.saveLocation = 'custom';
  expect(() => readYouTubeRecoveryRecord(custom)).toThrow('TASK_JOURNAL_INVALID');
  custom.request.directoryTarget = { handleId: 'bilibili-directory' };
  expect(() => readYouTubeRecoveryRecord(custom)).toThrow('TASK_JOURNAL_INVALID');
  custom.request.directoryTarget.handleId = 'youtube-11111111-1111-4111-8111-111111111111';
  custom.files[0]!.downloadId = 4;
  expect(() => readYouTubeRecoveryRecord(custom)).toThrow('TASK_JOURNAL_INVALID');
  custom.files[0]!.downloadId = null;
  custom.pendingFile = 0;
  expect(() => readYouTubeRecoveryRecord(custom)).toThrow('TASK_JOURNAL_INVALID');
  delete custom.pendingFile;
  custom.request.saveLocation = 'browser-default';
  expect(() => readYouTubeRecoveryRecord(custom)).toThrow('TASK_JOURNAL_INVALID');
});
it('never uses native-download recovery or releases uncertain custom directory outputs', async () => {
  const command = vi.fn(),
    search = vi.fn(),
    download = vi.fn();
  const tasks = new YouTubeBackgroundTasks({
    command,
    search,
    download,
    plan: vi.fn(),
    session: vi.fn(),
    cancelDownload: vi.fn(),
    extensionOrigin: 'chrome-extension://test',
  });
  const r = record();
  r.request.saveLocation = 'custom';
  r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
  tasks.restore([r]);
  await tasks.refreshRecovered();
  expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
    saveLocation: 'custom',
    error: 'DIRECTORY_RECOVERY_PENDING',
    cleanupPending: true,
  });
  expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'STATUS', jobId: r.request.jobId });
  expect(search).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});
it('rechecks a recovered directory output before confirming and releasing it', async () => {
  const r = record();
  r.request.saveLocation = 'custom';
  r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
  const base = {
    jobId: r.request.jobId,
    state: 'ready',
    readBytes: 123,
    files: [],
    publicationCommitted: false,
  };
  const file = {
    kind: 'merged',
    size: 123,
    handleId: r.request.directoryTarget.handleId,
    fileName: 'saved.mp4',
  };
  const command = vi
    .fn()
    .mockResolvedValueOnce({ ...base, directory: { state: 'unknown', files: [] } })
    .mockResolvedValueOnce({ ...base, directory: { state: 'checking', files: [] } })
    .mockResolvedValueOnce({ ...base, directory: { state: 'verified', files: [file] } })
    .mockResolvedValueOnce({ ...base, state: 'released' });
  const checkpoint = vi.fn<(record: YouTubeRecoveryRecord) => Promise<void>>().mockResolvedValue();
  const download = vi.fn(),
    search = vi.fn();
  const tasks = new YouTubeBackgroundTasks({
    command,
    checkpoint,
    download,
    search,
    plan: vi.fn(),
    session: vi.fn(),
    cancelDownload: vi.fn(),
    extensionOrigin: 'chrome-extension://test',
  });
  tasks.restore([r]);
  await tasks.refreshRecovered();
  expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
    state: 'saving',
    cleanupPending: true,
  });
  await tasks.refreshRecovered();
  expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
    state: 'complete',
    cleanupPending: false,
    files: [{ state: 'complete', savedBytes: 123 }],
  });
  expect(command.mock.calls.map((call) => call[0].type)).toEqual([
    'STATUS',
    'RECHECK_DIRECTORY',
    'STATUS',
    'RELEASE',
  ]);
  expect(checkpoint.mock.calls[0]![0]).toMatchObject({
    state: 'complete',
    savePending: false,
    cleanupPending: true,
  });
  expect(download).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
});
it.each(['resume', 'canceled', 'denied'] as const)(
  'recovers a recorded directory retry before dispatch: %s',
  async (mode) => {
    const r = record();
    r.saveAttempt = 1;
    r.cancelRequested = mode === 'canceled';
    r.request.saveLocation = 'custom';
    r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
    const file = {
      kind: 'merged',
      size: 123,
      handleId: r.request.directoryTarget.handleId,
      fileName: 'saved.mp4',
    };
    let retried = false;
    const command = vi.fn(async (c) => {
      if (c.type === 'RETRY_DIRECTORY') {
        expect(c.attempt).toBe(1);
        retried = true;
      }
      return {
        jobId: r.request.jobId,
        state: c.type === 'RELEASE' ? 'released' : 'ready',
        readBytes: 123,
        files: [],
        publicationCommitted: false,
        directory: retried
          ? { state: 'verified', attempt: 1, files: [file] }
          : { state: 'stopped', files: [], removed: [file], unstarted: [] },
      };
    });
    const authorizeDirectory = vi.fn(async () => {
      if (mode === 'denied') throw new Error('DIRECTORY_PERMISSION_REQUIRED');
    });
    const download = vi.fn(),
      plan = vi.fn();
    const tasks = new YouTubeBackgroundTasks({
      command: command as never,
      authorizeDirectory,
      download,
      plan,
      checkpoint: async () => {},
      search: vi.fn(),
      session: vi.fn(),
      cancelDownload: vi.fn(),
      extensionOrigin: 'chrome-extension://test',
    });
    tasks.restore([r]);
    await tasks.refreshRecovered();
    expect(command.mock.calls.filter(([c]) => c.type === 'RETRY_DIRECTORY')).toHaveLength(
      mode === 'resume' ? 1 : 0,
    );
    expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
      state: mode === 'resume' ? 'complete' : mode === 'canceled' ? 'canceled' : 'failed',
      cleanupPending: mode === 'denied',
      saveAttempt: 1,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  'settles recovered cancellation only with complete removal evidence: %s',
  async (proven) => {
    const r = record();
    r.cancelRequested = true;
    r.request.saveLocation = 'custom';
    r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
    const command = vi.fn().mockImplementation(async (c) => ({
      jobId: r.request.jobId,
      state: c.type === 'RELEASE' ? 'released' : 'ready',
      files: [],
      directory: {
        state: 'stopped',
        files: [],
        unstarted: [],
        removed: proven
          ? [
              {
                kind: 'merged',
                size: 123,
                handleId: r.request.directoryTarget!.handleId,
                fileName: 'partial.mp4',
              },
            ]
          : [],
      },
    }));
    const tasks = new YouTubeBackgroundTasks({
      command,
      download: vi.fn(),
      search: vi.fn(),
      plan: vi.fn(),
      session: vi.fn(),
      cancelDownload: vi.fn(),
      extensionOrigin: 'chrome-extension://test',
    });
    tasks.restore([r]);
    await tasks.refreshRecovered();
    expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
      state: proven ? 'canceled' : 'failed',
      cleanupPending: !proven,
    });
    expect(command.mock.calls.some((call) => call[0].type === 'RELEASE')).toBe(proven);
  },
);
it.each(['wrong-directory', 'wrong-size', 'duplicate-role'] as const)(
  'retains directory recovery with invalid %s evidence',
  async (invalid) => {
    const r = record();
    r.request.saveLocation = 'custom';
    r.request.directoryTarget = { handleId: 'youtube-11111111-1111-4111-8111-111111111111' };
    const file = {
      kind: 'merged',
      size: invalid === 'wrong-size' ? 1 : 123,
      handleId: invalid === 'wrong-directory' ? 'other' : r.request.directoryTarget.handleId,
      fileName: 'saved.mp4',
    };
    const command = vi.fn().mockResolvedValue({
      jobId: r.request.jobId,
      state: 'ready',
      files: [],
      directory: {
        state: 'verified',
        files: invalid === 'duplicate-role' ? [file, file] : [file],
      },
    });
    const tasks = new YouTubeBackgroundTasks({
      command,
      download: vi.fn(),
      search: vi.fn(),
      plan: vi.fn(),
      session: vi.fn(),
      cancelDownload: vi.fn(),
      extensionOrigin: 'chrome-extension://test',
    });
    tasks.restore([r]);
    await tasks.refreshRecovered();
    expect(tasks.status(r.request.jobId, r.request.owner)).toMatchObject({
      state: 'failed',
      cleanupPending: true,
    });
    expect(command.mock.calls.some((call) => call[0].type === 'RELEASE')).toBe(false);
  },
);
it('preserves the unknown-save marker across reconstruction, without private extras', async () => {
  const s = storage();
  const r = {
    ...record(),
    session: { token: 'private-token' },
    url: 'blob:private',
    files: [{ ...record().files[0]!, path: 'C:/private', url: 'https://private' }],
  };
  await new YouTubeTaskJournal(s).access(r);
  const recovered = await new YouTubeTaskJournal(s).access();
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ savePending: true, files: [{ downloadId: null }] });
  expect(JSON.stringify(recovered)).not.toMatch(/private|secret|token|blob:/u);
});
it('captures checkpoints before their caller mutates them and serializes concurrent jobs', async () => {
  const s = storage(),
    journal = new YouTubeTaskJournal(s),
    r = record();
  const first = journal.access(r);
  r.files[0]!.size = 999;
  await Promise.all([first, journal.access(record(2))]);
  expect((await journal.access()).map((r) => r.files[0]!.size)).toEqual([123, 123]);
});
it('does not erase invalid or newer-version ownership records', async () => {
  const s = storage();
  for (const raw of [
    null,
    { version: 2, records: [] },
    { version: 1, records: [record(), record()] },
  ]) {
    s.set(raw);
    await expect(new YouTubeTaskJournal(s).access(record(2))).rejects.toThrow(
      'TASK_JOURNAL_INVALID',
    );
  }
  expect(s.write).not.toHaveBeenCalled();
});
it('rejects reusing an existing ID for a different document or selection', async () => {
  const s = storage(),
    journal = new YouTubeTaskJournal(s);
  await journal.access(record());
  const changed = record();
  changed.request.owner.documentId = 'another-document';
  await expect(journal.access(changed)).rejects.toThrow('TASK_JOURNAL_OWNER_CHANGED');
  expect(s.write).toHaveBeenCalledTimes(1);
});
it('does not evict ownership to make room for another job', async () => {
  const s = storage();
  s.set({ version: 1, records: Array.from({ length: 128 }, (_, i) => record(i + 1)) });
  await expect(new YouTubeTaskJournal(s).access(record(129))).rejects.toThrow(
    'TASK_JOURNAL_CAPACITY',
  );
  expect(s.write).not.toHaveBeenCalled();
});
it('propagates a failed checkpoint but allows an explicit later attempt', async () => {
  const s = storage(),
    journal = new YouTubeTaskJournal(s);
  s.write.mockRejectedValueOnce(new Error('storage-failed'));
  await expect(journal.access(record())).rejects.toThrow('storage-failed');
  expect(await journal.access()).toEqual([]);
  await journal.access(record());
  expect(await journal.access()).toHaveLength(1);
});
it('rejects duplicate browser IDs and incomplete separate-output ownership', () => {
  const r = record();
  r.request.selection.mode = 'separate';
  r.files = [
    { kind: 'video', size: 5, downloadId: 1 },
    { kind: 'audio', size: 4, downloadId: 1 },
  ];
  expect(() => readYouTubeRecoveryRecord(r)).toThrow('TASK_JOURNAL_INVALID');
  r.files.pop();
  expect(() => readYouTubeRecoveryRecord(r)).toThrow('TASK_JOURNAL_INVALID');
});

it('rejects sharing a native download ID between different jobs on both read and write', async () => {
  const s = storage(),
    journal = new YouTubeTaskJournal(s);
  const first = record(),
    second = record(2);
  first.files[0]!.downloadId = 123;
  second.files[0]!.downloadId = 123;
  await journal.access(first);
  await expect(journal.access(second)).rejects.toThrow('TASK_JOURNAL_INVALID');
  s.set({ version: 1, records: [first, second] });
  await expect(journal.access()).rejects.toThrow('TASK_JOURNAL_INVALID');
  expect(s.write).toHaveBeenCalledTimes(1);
});
