import { expect, it, vi } from 'vitest';
import { YouTubeDirectoryGrants } from '../../src/modules/youtube/directory-grant';
import type { StoredDirectoryHandle } from '../../src/modules/downloads/directory-handle-store';

const id = '11111111-1111-4111-8111-111111111111';
const owner = {
  jobId: '22222222-2222-4222-8222-222222222222',
  videoId: 'abcdefghijk',
  tabId: 1,
  documentId: 'source-doc',
  pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  navigationEpoch: 3,
  mediaEpoch: 4,
};
const picker = { tabId: 2, windowId: 3, documentId: 'picker-doc' };
it('accepts the actual watch URL with normal query parameters but rejects ambiguous video identities', () => {
  const broker = new YouTubeDirectoryGrants(
    () => 100,
    () => id,
  );
  const actual = { ...owner, pageUrl: `${owner.pageUrl}&t=30&list=playlist` };
  broker.issue(actual, picker);
  broker.claim(id, actual, picker).consume();
  for (const pageUrl of [
    `${owner.pageUrl}&v=zyxwvutsrqp`,
    'https://www.youtube.com/shorts/abcdefghijk',
    'https://other.example/watch?v=abcdefghijk',
  ])
    expect(() => new YouTubeDirectoryGrants().issue({ ...owner, pageUrl }, picker)).toThrow(
      'DIRECTORY_GRANT_IDENTITY_INVALID',
    );
});
function confirmation() {
  const broker = new YouTubeDirectoryGrants(
    () => 100,
    () => id,
  );
  broker.issue(owner, picker);
  const requestPermission = vi.fn(async () => 'granted' as const);
  const stored: StoredDirectoryHandle = {
    metadata: { handleId: `youtube-${id}`, name: 'Selected', selectedAt: 90 },
    handle: {
      kind: 'directory',
      name: 'Selected',
      queryPermission: vi.fn(async () => 'granted' as const),
      requestPermission,
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(),
      removeEntry: vi.fn(),
    },
  };
  const options = {
    store: { get: vi.fn(async () => stored) },
    assertCurrent: vi.fn(async () => {}),
  };
  return { broker, stored, options, requestPermission };
}
it('confirms only the session-reserved directory and returns a fixed task target', async () => {
  const s = confirmation();
  expect(() => s.broker.target(id, owner)).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  const result = await s.broker.confirm(id, owner, picker, s.options);
  expect(s.options.store.get).toHaveBeenCalledWith(`youtube-${id}`);
  expect(s.options.assertCurrent).toHaveBeenCalledTimes(2);
  result.name = 'mutated';
  s.stored.metadata.name = 'changed later';
  expect(s.broker.target(id, owner)).toEqual({
    handleId: `youtube-${id}`,
    name: 'Selected',
    selectedAt: 90,
  });
  expect(() => s.broker.target(id, { ...owner, mediaEpoch: 10 })).toThrow(
    'DIRECTORY_GRANT_UNAVAILABLE',
  );
  expect(s.requestPermission).not.toHaveBeenCalled();
  expect(s.stored.handle.getFileHandle).not.toHaveBeenCalled();
  expect(s.stored.handle.removeEntry).not.toHaveBeenCalled();
});
it('exposes only the display name and session to the exact confirmed source job', async () => {
  const s = confirmation();
  expect(s.broker.confirmed(owner)).toBeNull();
  await s.broker.confirm(id, owner, picker, s.options);
  const display = s.broker.confirmed(owner)!;
  expect(display).toEqual({ sessionId: id, name: 'Selected' });
  display.name = 'changed';
  expect(s.broker.confirmed(owner)?.name).toBe('Selected');
  for (const patch of [{ jobId: crypto.randomUUID() }, { documentId: 'other' }, { mediaEpoch: 8 }])
    expect(s.broker.confirmed({ ...owner, ...patch })).toBeNull();
  s.broker.revokeJob(owner.jobId);
  expect(s.broker.confirmed(owner)).toBeNull();
});
it.each(['permission', 'navigation', 'cancellation', 'wrong-handle'] as const)(
  'does not bind a target after %s changes during confirmation',
  async (cause) => {
    const s = confirmation();
    if (cause === 'permission')
      vi.mocked(s.stored.handle.queryPermission!).mockResolvedValue('denied');
    if (cause === 'navigation')
      s.options.assertCurrent.mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
    if (cause === 'cancellation')
      s.options.store.get.mockImplementation(async () => {
        s.broker.revokeJob(owner.jobId);
        return s.stored;
      });
    if (cause === 'wrong-handle') s.stored.metadata.handleId = 'bilibili-directory';
    await expect(s.broker.confirm(id, owner, picker, s.options)).rejects.toThrow();
    expect(() => s.broker.target(id, owner)).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
    expect(s.requestPermission).not.toHaveBeenCalled();
  },
);
it('rejects concurrent confirmations before a second directory lookup', async () => {
  const s = confirmation();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => s.broker.confirm(id, owner, picker, s.options)),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(s.options.store.get).toHaveBeenCalledTimes(1);
});
it('allows one claim for the exact source and picker document, then consumes it', () => {
  const broker = new YouTubeDirectoryGrants(
    () => 100,
    () => id,
  );
  const source = { ...owner },
    popup = { ...picker };
  broker.issue(source, popup);
  source.mediaEpoch++;
  popup.documentId = 'mutated';
  const claim = broker.claim(id, owner, picker);
  expect(() => broker.claim(id, owner, picker)).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  claim.assertLive();
  claim.consume();
  expect(() => claim.assertLive()).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
});
it('rejects other documents, navigations, videos and popup identities without consuming the real grant', () => {
  const broker = new YouTubeDirectoryGrants(
    () => 100,
    () => id,
  );
  broker.issue(owner, picker);
  for (const patch of [
    { documentId: 'other' },
    { navigationEpoch: 5 },
    { mediaEpoch: 5 },
    { videoId: 'zyxwvutsrqp' },
    { tabId: 9 },
  ])
    expect(() => broker.claim(id, { ...owner, ...patch }, picker)).toThrow(
      'DIRECTORY_GRANT_UNAVAILABLE',
    );
  for (const patch of [{ documentId: 'other' }, { tabId: 9 }, { windowId: 9 }])
    expect(() => broker.claim(id, owner, { ...picker, ...patch })).toThrow(
      'DIRECTORY_GRANT_UNAVAILABLE',
    );
  broker.claim(id, owner, picker).consume();
});
it.each(['job', 'source-tab', 'picker-tab', 'expiry'] as const)(
  'invalidates an in-flight claim after %s',
  (cause) => {
    let now = 100;
    const broker = new YouTubeDirectoryGrants(
      () => now,
      () => id,
    );
    broker.issue(owner, picker);
    const claim = broker.claim(id, owner, picker);
    if (cause === 'job') broker.revokeJob(owner.jobId);
    if (cause === 'source-tab') broker.revokeTab(owner.tabId);
    if (cause === 'picker-tab') broker.revokeTab(picker.tabId);
    if (cause === 'expiry') now += 180_000;
    expect(() => claim.consume()).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  },
);
it('does not restore grants after worker recreation or accept an unrelated page', () => {
  const broker = new YouTubeDirectoryGrants(
    () => 100,
    () => id,
  );
  expect(() => broker.issue({ ...owner, pageUrl: 'https://www.bilibili.com/' }, picker)).toThrow(
    'DIRECTORY_GRANT_IDENTITY_INVALID',
  );
  broker.issue(owner, picker);
  expect(() => new YouTubeDirectoryGrants().claim(id, owner, picker)).toThrow(
    'DIRECTORY_GRANT_UNAVAILABLE',
  );
});
