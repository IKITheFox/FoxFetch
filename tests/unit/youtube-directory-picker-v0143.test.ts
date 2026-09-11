import { expect, it, vi } from 'vitest';
import { YouTubeDirectoryGrants } from '../../src/modules/youtube/directory-grant';
import { YouTubeDirectoryPickers } from '../../src/modules/youtube/directory-picker';

const nonce = '11111111-1111-4111-8111-111111111111';
const session = '33333333-3333-4333-8333-333333333333';
const owner = {
  jobId: '22222222-2222-4222-8222-222222222222',
  videoId: 'abcdefghijk',
  tabId: 1,
  documentId: 'source',
  pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  navigationEpoch: 1,
  mediaEpoch: 1,
};
const sender = { tabId: 2, windowId: 3, documentId: 'picker' };
function setup() {
  const grants = new YouTubeDirectoryGrants(
    () => 100,
    () => session,
  );
  const deps = {
    grants,
    assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
    open: vi.fn(async () => ({ tabId: 2, windowId: 3 })),
    close: vi.fn(async () => {}),
    now: () => 100,
    createId: () => nonce,
  };
  return { grants, deps, pickers: new YouTubeDirectoryPickers(deps) };
}
it('binds only the document from the background-created popup and reuses its ready reply', async () => {
  const s = setup();
  await s.pickers.open(owner);
  await expect(s.pickers.ready(nonce, { ...sender, tabId: 99 })).rejects.toThrow(
    'DIRECTORY_PICKER_IDENTITY_CHANGED',
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () => s.pickers.ready(nonce, sender)),
  );
  expect(results).toEqual(
    Array.from({ length: 10 }, () => ({ sessionId: session, handleId: `youtube-${session}` })),
  );
  await expect(s.pickers.ready(nonce, { ...sender, documentId: 'reloaded' })).rejects.toThrow(
    'DIRECTORY_PICKER_IDENTITY_CHANGED',
  );
  s.grants.claim(session, owner, sender).consume();
});
it('closes the exact new window when its source changes during open', async () => {
  const s = setup();
  s.deps.assertCurrent
    .mockResolvedValueOnce()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
  await expect(s.pickers.open(owner)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  expect(s.deps.close).toHaveBeenCalledExactlyOnceWith(3);
  await expect(s.pickers.ready(nonce, sender)).rejects.toThrow('DIRECTORY_PICKER_UNAVAILABLE');
});
it('coalesces ten concurrent opens into one popup for the same owner', async () => {
  const s = setup();
  expect(await Promise.all(Array.from({ length: 10 }, () => s.pickers.open(owner)))).toEqual(
    Array(10).fill(nonce),
  );
  expect(s.deps.open).toHaveBeenCalledTimes(1);
  expect(await s.pickers.open(owner)).toBe(nonce);
  expect(s.deps.open).toHaveBeenCalledTimes(1);
});
it('requires a confirmed target before finishing and preserves it when the window closes', async () => {
  const s = setup();
  await s.pickers.open(owner);
  await s.pickers.ready(nonce, sender);
  await expect(s.pickers.finish(nonce)).rejects.toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  expect(s.deps.close).not.toHaveBeenCalled();
  await s.grants.confirm(session, owner, sender, {
    assertCurrent: s.deps.assertCurrent,
    store: {
      get: async () => ({
        metadata: { handleId: `youtube-${session}`, name: 'Selected', selectedAt: 90 },
        handle: {
          kind: 'directory',
          name: 'Selected',
          queryPermission: async () => 'granted',
          getDirectoryHandle: vi.fn(),
        },
      }),
    },
  });
  expect(await s.pickers.finish(nonce)).toMatchObject({
    sessionId: session,
    handleId: `youtube-${session}`,
  });
  await s.pickers.close(nonce); // Simulate a late window-closed notification.
  await s.pickers.windowRemoved(3);
  expect(s.deps.close).toHaveBeenCalledExactlyOnceWith(3);
  expect(s.grants.target(session, owner).handleId).toBe(`youtube-${session}`);
});
it('revokes the in-flight claim when the picker is canceled', async () => {
  const s = setup();
  await s.pickers.open(owner);
  await s.pickers.ready(nonce, sender);
  const claim = s.grants.claim(session, owner, sender);
  await s.pickers.close(nonce);
  expect(() => claim.consume()).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  expect(s.deps.close).toHaveBeenCalledExactlyOnceWith(3);
});
it('ends waiting only for its own closed popup and revokes an unfinished grant', async () => {
  const s = setup();
  await s.pickers.open(owner);
  await s.pickers.ready(nonce, sender);
  expect(s.pickers.waiting(nonce, owner)).toBe(true);
  expect(s.pickers.waiting(nonce, { ...owner, documentId: 'other' })).toBe(false);
  await s.pickers.windowRemoved(99);
  expect(s.pickers.waiting(nonce, owner)).toBe(true);
  const claim = s.grants.claim(session, owner, sender);
  await s.pickers.windowRemoved(3);
  expect(s.pickers.waiting(nonce, owner)).toBe(false);
  expect(() => claim.consume()).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  expect(s.deps.close).not.toHaveBeenCalled();
});
it('source removal invalidates the grant immediately and only closes that source popup', async () => {
  const s = setup();
  await s.pickers.open(owner);
  await s.pickers.ready(nonce, sender);
  const claim = s.grants.claim(session, owner, sender);
  await s.pickers.sourceRemoved(99);
  expect(s.pickers.waiting(nonce, owner)).toBe(true);
  const removal = s.pickers.sourceRemoved(owner.tabId);
  expect(s.pickers.waiting(nonce, owner)).toBe(false);
  expect(() => claim.consume()).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
  await removal;
  expect(s.deps.close).toHaveBeenCalledExactlyOnceWith(3);
});
it('rejects a ready request whose source changes while being verified', async () => {
  const s = setup();
  await s.pickers.open(owner);
  s.deps.assertCurrent.mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
  await expect(s.pickers.ready(nonce, sender)).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  expect(() => s.grants.claim(session, owner, sender)).toThrow('DIRECTORY_GRANT_UNAVAILABLE');
});
