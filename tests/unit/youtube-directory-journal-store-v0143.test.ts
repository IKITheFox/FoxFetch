// @vitest-environment node
import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { YouTubeDirectoryJournalStore } from '../../src/modules/youtube/directory-journal-store';
import {
  YouTubeDirectoryJournal,
  type YouTubeDirectoryWriteRecord,
} from '../../src/modules/youtube/directory-journal';

const record: YouTubeDirectoryWriteRecord = {
  jobId: '11111111-1111-4111-8111-111111111111',
  kind: 'merged',
  handleId: 'youtube-22222222-2222-4222-8222-222222222222',
  requestedName: 'video.mp4',
  size: 1,
  phase: 'intent',
};
it('serializes duplicate reservations across two independent database connections', async () => {
  const options = {
    dbName: `directory-test-${crypto.randomUUID()}`,
    enforceExtensionOrigin: false,
  };
  const a = new YouTubeDirectoryJournalStore(options),
    b = new YouTubeDirectoryJournalStore(options);
  try {
    const results = await Promise.allSettled([
      new YouTubeDirectoryJournal(a).put(record, { createOnly: true }),
      new YouTubeDirectoryJournal(b).put(record, { createOnly: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await new YouTubeDirectoryJournal(a).read()).toEqual([record]);
  } finally {
    await a.close();
    await b.close();
  }
});
it('keeps both independent jobs and restores them after reopening storage', async () => {
  const options = {
    dbName: `directory-test-${crypto.randomUUID()}`,
    enforceExtensionOrigin: false,
  };
  const a = new YouTubeDirectoryJournalStore(options),
    b = new YouTubeDirectoryJournalStore(options);
  const other = { ...record, jobId: '33333333-3333-4333-8333-333333333333' };
  await Promise.all([
    new YouTubeDirectoryJournal(a).put(record),
    new YouTubeDirectoryJournal(b).put(other),
  ]);
  await a.close();
  await b.close();
  const reopened = new YouTubeDirectoryJournalStore(options);
  try {
    expect(await new YouTubeDirectoryJournal(reopened).read()).toEqual(
      expect.arrayContaining([record, other]),
    );
  } finally {
    await reopened.close();
  }
});
it('atomically reserves one removed-output retry across independent connections', async () => {
  const options = {
    dbName: `directory-test-${crypto.randomUUID()}`,
    enforceExtensionOrigin: false,
  };
  const a = new YouTubeDirectoryJournalStore(options),
    b = new YouTubeDirectoryJournalStore(options);
  try {
    const first = new YouTubeDirectoryJournal(a),
      second = new YouTubeDirectoryJournal(b);
    await first.put(record);
    const removed = { ...record, actualName: 'video.mp4', phase: 'removed' as const };
    await first.put(removed);
    const attempts = await Promise.allSettled([
      first.reserveRetry(removed),
      second.reserveRetry(removed),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await second.read()).toEqual([{ ...record, attempt: 1 }]);
    await expect(first.put(removed)).rejects.toThrow('DIRECTORY_JOURNAL_IDENTITY_CHANGED');
  } finally {
    await a.close();
    await b.close();
  }
});
it('aborts an invalid transaction without replacing existing data', async () => {
  const s = new YouTubeDirectoryJournalStore({
    dbName: `directory-test-${crypto.randomUUID()}`,
    enforceExtensionOrigin: false,
  });
  try {
    const j = new YouTubeDirectoryJournal(s);
    await j.put(record);
    await expect(j.put({ ...record, size: 2 })).rejects.toThrow(
      'DIRECTORY_JOURNAL_IDENTITY_CHANGED',
    );
    expect(await j.read()).toEqual([record]);
  } finally {
    await s.close();
  }
  await expect(s.read()).rejects.toThrow('DIRECTORY_JOURNAL_CLOSED');
});
it('rejects default construction outside the extension origin', () => {
  expect(() => new YouTubeDirectoryJournalStore()).toThrow('扩展自身');
});
