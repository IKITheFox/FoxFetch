// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  YouTubeDirectoryJournal,
  type YouTubeDirectoryWriteRecord,
} from '../../src/modules/youtube/directory-journal';

const initial: YouTubeDirectoryWriteRecord = {
  jobId: '11111111-1111-4111-8111-111111111111',
  kind: 'merged',
  handleId: 'youtube-22222222-2222-4222-8222-222222222222',
  requestedName: 'video.mp4',
  size: 4,
  phase: 'intent',
};
function setup() {
  let data: unknown;
  const storage = {
    read: vi.fn(async () => structuredClone(data)),
    write: vi.fn(async (value: unknown) => {
      data = structuredClone(value);
    }),
  };
  return { storage, journal: new YouTubeDirectoryJournal(storage) };
}
it('persists intent, actual allocation and verified state across journal recreation', async () => {
  const s = setup();
  await s.journal.put(initial);
  const allocated = { ...initial, actualName: 'video (1).mp4', phase: 'allocated' as const };
  await s.journal.put(allocated);
  const recreated = new YouTubeDirectoryJournal(s.storage);
  expect(await recreated.read()).toEqual([allocated]);
  await recreated.put({ ...allocated, phase: 'verified' });
  await expect(recreated.put({ ...allocated, phase: 'intent' })).rejects.toThrow();
});
it('reserves only one retry for an exact removed attempt and fences late callbacks', async () => {
  const s = setup();
  await s.journal.put(initial);
  const removed = { ...initial, actualName: 'video.mp4', phase: 'removed' as const };
  await s.journal.put(removed);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => s.journal.reserveRetry(removed)),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const next = (await s.journal.read())[0]!;
  expect(next).toEqual({ ...initial, attempt: 1 });
  await expect(s.journal.put({ ...removed, phase: 'unknown' })).rejects.toThrow(
    'DIRECTORY_JOURNAL_IDENTITY_CHANGED',
  );
  await s.journal.put({ ...next, actualName: 'video (1).mp4', phase: 'allocated' });
  expect((await new YouTubeDirectoryJournal(s.storage).read())[0]?.attempt).toBe(1);
});
it.each(['verified', 'unknown', 'allocated'] as const)(
  'never retries an existing %s output',
  async (phase) => {
    const s = setup();
    await s.journal.put(initial);
    const allocated = { ...initial, actualName: 'video.mp4', phase: 'allocated' as const };
    await s.journal.put(allocated);
    await s.journal.put({ ...allocated, phase });
    await expect(s.journal.reserveRetry({ ...allocated, phase: 'removed' })).rejects.toThrow(
      'DIRECTORY_RETRY_REJECTED',
    );
    expect((await s.journal.read())[0]?.phase).toBe(phase);
  },
);
it('does not change fixed ownership or forget an actual filename', async () => {
  const s = setup();
  await s.journal.put(initial);
  const allocated = { ...initial, actualName: 'video.mp4', phase: 'allocated' as const };
  await s.journal.put(allocated);
  for (const patch of [
    { size: 5 },
    { requestedName: 'other.mp4' },
    { actualName: 'other.mp4' },
    { handleId: 'youtube-33333333-3333-4333-8333-333333333333' },
  ])
    await expect(s.journal.put({ ...allocated, ...patch })).rejects.toThrow(
      'DIRECTORY_JOURNAL_IDENTITY_CHANGED',
    );
  await s.journal.put({ ...allocated, phase: 'unknown' });
  await expect(s.journal.put({ ...allocated, phase: 'allocated' })).rejects.toThrow(
    'DIRECTORY_JOURNAL_TRANSITION_REJECTED',
  );
});
it('snapshots input before queued work and drops non-record data', async () => {
  const s = setup();
  const mutable = { ...initial, token: 'private', url: 'https://example.com' };
  const pending = s.journal.put(mutable);
  mutable.requestedName = 'changed.mp4';
  await pending;
  expect(await s.journal.read()).toEqual([initial]);
  expect(JSON.stringify(await s.storage.read())).not.toMatch(/private|https:/u);
});
it('rejects corrupted storage and propagates write failures', async () => {
  const s = setup();
  s.storage.read.mockResolvedValueOnce({ version: 2, records: [] });
  await expect(s.journal.read()).rejects.toThrow('DIRECTORY_JOURNAL_INVALID');
  s.storage.write.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(s.journal.put(initial)).rejects.toThrow('storage unavailable');
  expect(await s.journal.read()).toEqual([]);
  await s.journal.put(initial);
});
it('rejects a second owner for an already allocated directory filename', async () => {
  const s = setup();
  await s.journal.put(initial);
  await s.journal.put({ ...initial, actualName: 'video.mp4', phase: 'allocated' });
  const other = { ...initial, jobId: '33333333-3333-4333-8333-333333333333' };
  await s.journal.put(other);
  await expect(
    s.journal.put({ ...other, actualName: 'video.mp4', phase: 'allocated' }),
  ).rejects.toThrow('DIRECTORY_JOURNAL_INVALID');
});
