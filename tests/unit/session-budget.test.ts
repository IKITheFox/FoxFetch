import { describe, expect, it, vi } from 'vitest';
import {
  compactManifestHistory,
  createSessionBudget,
  estimateSessionBytes,
  reclaimableSessionValue,
  SESSION_QUOTA_MESSAGE,
} from '../../src/modules/storage/session-budget';

function fixture(limit = Infinity) {
  const values: Record<string, unknown> = {};
  const area = {
    get: vi.fn(async (keys?: string | string[] | null) =>
      keys == null
        ? structuredClone(values)
        : Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]),
          ),
    ),
    getBytesInUse: vi.fn(async (keys?: string | string[] | null) =>
      estimateSessionBytes(
        keys == null
          ? values
          : Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys])
                .filter((key) => key in values)
                .map((key) => [key, values[key]]),
            ),
      ),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (estimateSessionBytes({ ...values, ...items }) > limit)
        throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      Object.assign(values, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
  };
  return { values, area, storage: createSessionBudget(() => area) };
}

describe('session budget', () => {
  it('reclaims legacy inline bodies while preserving A/V assets and capture bindings', async () => {
    const { values, storage } = fixture(1800);
    const capture = { videoAssetId: 'video', audioAssetId: 'audio' };
    const video = { id: 'video', kind: 'video', url: 'https://cdn.test/?signed=secret' };
    values['foxfetch:tab:7'] = { sourceCapture: capture, assets: [video, { id: 'image', kind: 'image', pageUrl: 'https://page.test', url: 'data:image/png;base64,' + 'A'.repeat(500), downloadable: true }] };
    await storage.set({ newTask: 'B'.repeat(400) });
    expect(values['foxfetch:tab:7']).toEqual({ sourceCapture: capture, assets: [video, { id: 'image', kind: 'image', pageUrl: 'https://page.test', url: '', downloadable: false, inlineImage: { token: '', pageUrl: 'https://page.test' } }] });
  });
  it('reclaims above the high watermark before the first failed write', async () => {
    const { values, storage, area } = fixture();
    values['foxfetch:source-capture-sessions'] = [
      { expiresAt: 1, payload: 'x'.repeat(4 * 1024 * 1024) },
    ];
    await storage.set({ small: true });
    expect(area.set.mock.calls[0]?.[0]).toEqual({ 'foxfetch:source-capture-sessions': [] });
    expect(values.small).toBe(true);
  });

  it('a fresh manager can recover pre-existing state after a worker restart', async () => {
    const { values, area } = fixture(1200);
    values['foxfetch:pending-network-assets:7'] = {
      version: 1,
      entries: [{ expiresAt: 1, payload: 'x'.repeat(350) }],
    };
    const restarted = createSessionBudget(() => area);
    await restarted.set({ next: 'y'.repeat(350) });
    expect(values['foxfetch:pending-network-assets:7']).toEqual({ version: 1, entries: [] });
  });

  it('recovers quota by pruning pre-existing expired records, preserving sensitive active work', async () => {
    const { values, storage } = fixture(2600);
    values['foxfetch:source-capture-sessions'] = [
      { expiresAt: 1, observations: 'x'.repeat(900) },
      { expiresAt: Date.now() + 100000, observations: ['live'] },
    ];
    const context = {
      videoUrl: 'https://cdn.test/?signature=secret',
      audioUrl: 'audio',
      requestHeaders: { authorization: 'secret' },
    };
    values['foxfetch:merge-context:active'] = context;
    await storage.set({ newState: 'y'.repeat(500) });
    expect(values['foxfetch:source-capture-sessions']).toEqual([
      { expiresAt: expect.any(Number), observations: ['live'] },
    ]);
    expect(values['foxfetch:merge-context:active']).toEqual(context);
    expect(values.newState).toHaveLength(500);
  });

  it('fails explicitly when only protected data remains and recovers the queue after failure', async () => {
    const { values, storage, area } = fixture(1000);
    values['foxfetch:merge-context:active'] = 'x'.repeat(300);
    await expect(storage.set({ incoming: 'y'.repeat(800) })).rejects.toThrow(SESSION_QUOTA_MESSAGE);
    expect(area.set).toHaveBeenCalledTimes(2);
    expect(values['foxfetch:merge-context:active']).toHaveLength(300);
    expect(values.incoming).toBeUndefined();
    await storage.set({ okay: true });
    expect(values.okay).toBe(true);
  });

  it('serializes concurrent writes and snapshots caller-owned data', async () => {
    const { storage, values } = fixture();
    const incoming = { value: { revision: 1 } };
    const first = storage.set(incoming);
    incoming.value.revision = 99;
    await Promise.all([first, storage.set({ second: true }), storage.remove('second')]);
    expect(values).toEqual({ value: { revision: 1 } });
  });

  it('does not retry non-quota errors', async () => {
    const { storage, area } = fixture();
    area.set.mockRejectedValue(new Error('Extension context invalidated'));
    await expect(storage.set({ x: 1 })).rejects.toThrow('Extension context invalidated');
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it('keeps all current-route provider identities and complete A/V manifests', () => {
    const entries = [
      {
        pageUrl: 'current',
        routeKey: 'BV1',
        documentId: 'doc',
        providerIdentity: 'CID1',
        validatedAt: 3,
        assets: ['video', 'audio'],
      },
      {
        pageUrl: 'current',
        routeKey: 'BV1',
        documentId: 'doc',
        providerIdentity: 'CID2',
        validatedAt: 2,
        assets: ['video2', 'audio2'],
      },
      {
        pageUrl: 'old',
        routeKey: 'BV0',
        documentId: 'doc',
        providerIdentity: 'CID0',
        validatedAt: 1,
        assets: ['old'],
      },
    ];
    expect(compactManifestHistory(entries, 0)).toEqual(entries.slice(0, 2));
    const current = { sourceCapture: { videoAssetId: 'v' }, assets: ['video', 'audio'] };
    expect(reclaimableSessionValue('foxfetch:tab:7', current, Date.now())).toBe(current);
  });

  it('retains live quarantined ownership records unchanged', () => {
    const live = {
      expiresAt: 200,
      context: { documentId: 'doc', routeKey: 'BV:CID' },
      asset: { url: 'signed' },
    };
    expect(
      reclaimableSessionValue(
        'foxfetch:pending-network-assets:7',
        { version: 1, entries: [{ expiresAt: 1 }, live] },
        100,
      ),
    ).toEqual({ version: 1, entries: [live] });
  });
});
