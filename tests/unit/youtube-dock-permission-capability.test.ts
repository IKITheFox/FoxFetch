import { expect, it } from 'vitest';
import { YouTubeDockPermissionCapabilities } from '../../src/modules/youtube/dock-permission-capability';
import type { YouTubeTaskOwner } from '../../src/modules/youtube/background-task';
const owner: YouTubeTaskOwner = {
  tabId: 7,
  documentId: 'document',
  pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  navigationEpoch: 3,
  mediaEpoch: 5,
};

it('accepts only the exact document and media generation once', () => {
  const grants = new YouTubeDockPermissionCapabilities(() => 100);
  const { token } = grants.issue(owner);
  for (const other of [
    { ...owner, tabId: 8 },
    { ...owner, documentId: 'other' },
    { ...owner, pageUrl: `${owner.pageUrl}&list=other` },
    { ...owner, navigationEpoch: 4 },
    { ...owner, mediaEpoch: 6 },
  ])
    expect(grants.claim(token, other)).toBe(false);
  expect(grants.claim(token, owner)).toBe(true);
  expect(grants.claim(token, owner)).toBe(false);
});

it('keeps independent panel tokens but rejects expired and prior-worker tokens', () => {
  let now = 100;
  const grants = new YouTubeDockPermissionCapabilities(() => now);
  const first = grants.issue(owner);
  const second = grants.issue(owner);
  expect(grants.claim(first.token, owner)).toBe(true);
  expect(new YouTubeDockPermissionCapabilities().claim(second.token, owner)).toBe(false);
  now = second.expiresAt;
  expect(grants.claim(second.token, owner)).toBe(false);
});

it('uses the issuer URL for a matching live document and epochs exactly once', () => {
  const grants = new YouTubeDockPermissionCapabilities(() => 100);
  const { token } = grants.issue(owner);
  const { pageUrl: _, ...identity } = owner;
  expect(grants.claimDocument(token, { ...identity, documentId: 'old' })).toBeUndefined();
  expect(grants.claimDocument(token, { ...identity, navigationEpoch: 4 })).toBeUndefined();
  expect(grants.claimDocument(token, { ...identity, mediaEpoch: 6 })).toBeUndefined();
  expect(grants.claimDocument(token, identity)).toEqual(owner);
  expect(grants.claimDocument(token, identity)).toBeUndefined();
});
