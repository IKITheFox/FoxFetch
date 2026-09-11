import { describe, expect, it } from 'vitest';
import {
  notifyDownloadActivity,
  presentDownloadActivity,
} from '../../src/modules/downloads/activity';
import type { DownloadActivityOwner, DownloadRecord } from '../../src/shared/types';

const owner: DownloadActivityOwner = {
  tabId: 4,
  pageIdentity: 'https://example.test/video/1',
  mediaEpoch: 2,
};
const record = (patch: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id: 'private-record',
  assetId: 'asset',
  filename: 'secret.mp4',
  url: 'https://private.test/video?token=secret',
  kind: 'video',
  state: 'downloading',
  createdAt: 100,
  updatedAt: 200,
  owner,
  ...patch,
});

describe('direct-download launcher activity', () => {
  it('never waits for or propagates failed/hung UI delivery', async () => {
    let calls = 0;
    expect(
      notifyDownloadActivity(() => {
        calls++;
        return new Promise(() => undefined);
      }),
    ).toBeUndefined();
    expect(notifyDownloadActivity(() => Promise.reject(new Error('disconnected')))).toBeUndefined();
    expect(() =>
      notifyDownloadActivity(() => {
        throw new Error('synchronous failure');
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(calls).toBe(1);
  });
  it('does not rebind an old document when a hard reload repeats the same URL and media epoch', () => {
    const oldOwner = { ...owner, documentId: 'document-A' };
    const newOwner = { ...owner, documentId: 'document-B' };
    expect(presentDownloadActivity([record({ owner: oldOwner })], newOwner, 1, 250).state).toBe(
      'idle',
    );
    const view = presentDownloadActivity([record({ owner: newOwner })], newOwner, 1, 250);
    expect(view.state).toBe('downloading');
    expect(JSON.stringify(view)).not.toContain('document-B');
  });
  it('counts admitted downloads rather than treating a pending batch as one file', () => {
    expect(presentDownloadActivity([], owner, 1, 250, 1)).toMatchObject({
      state: 'preparing',
      activeCount: 0,
    });
    expect(
      presentDownloadActivity([record(), record({ id: 'second' })], owner, 1, 250, 3),
    ).toMatchObject({ state: 'downloading', activeCount: 2 });
  });
  it('reports the active task with no URL, filename or private record identity', () => {
    const view = presentDownloadActivity([record()], owner, 3, 250);
    expect(view).toEqual({
      pageIdentity: owner.pageIdentity,
      mediaEpoch: 2,
      revision: 3,
      state: 'downloading',
      activeCount: 1,
      updatedAt: 250,
    });
    expect(JSON.stringify(view)).not.toMatch(/secret|private/);
  });
  it.each([
    { ...owner, tabId: 5 },
    { ...owner, mediaEpoch: 3 },
    { ...owner, pageIdentity: 'https://example.test/video/2' },
    undefined,
  ])('ignores another owner or unbound historical record: %s', (other) => {
    const candidate = record();
    if (other) candidate.owner = other;
    else delete candidate.owner;
    expect(presentDownloadActivity([candidate], owner, 1, 250).state).toBe('idle');
  });
  it('keeps active work ahead of old terminal records and preparing work visible', () => {
    const done = record({ state: 'complete', updatedAt: 240 });
    expect(presentDownloadActivity([done, record()], owner, 1, 250).state).toBe('downloading');
    expect(presentDownloadActivity([done], owner, 1, 250, 1).state).toBe('preparing');
    expect(presentDownloadActivity([record({ state: 'queued' })], owner, 1, 250).state).toBe(
      'preparing',
    );
  });
  it.each([
    ['complete', undefined, 'completed'],
    ['interrupted', 'NETWORK_FAILED', 'failed'],
    ['interrupted', 'USER_CANCELED', 'cancelled'],
  ] as const)(
    'shows a bounded %s/%s terminal without treating cancellation as failure',
    (state, error, expected) => {
      const records = [record({ state, ...(error ? { error } : {}) })];
      expect(presentDownloadActivity(records, owner, 1, 250).state).toBe(expected);
      expect(presentDownloadActivity(records, owner, 2, 12_200).state).toBe('idle');
    },
  );
});
