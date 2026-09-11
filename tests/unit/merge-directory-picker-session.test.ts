import { describe, expect, it, vi } from 'vitest';

import {
  MERGE_DIRECTORY_PICKER_SESSION_PREFIX,
  MERGE_DIRECTORY_PICKER_SESSION_TTL_MS,
  MergeDirectoryPickerSessionBroker,
  openBoundMergeDirectoryPicker,
  type MergeDirectoryPickerOpenServices,
  type StorageAreaLike,
} from '../../src/modules/jobs';

class FakeStorage implements StorageAreaLike {
  readonly values = new Map<string, unknown>();

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return Object.fromEntries(this.values);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.map((key) => [key, this.values.get(key)]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

const owner = {
  jobId: 'job-private',
  sourceTabId: 42,
  sourcePageUrl: 'https://www.bilibili.com/video/BV1picker',
  mediaEpoch: 7,
};

const popup = { popupWindowId: 81, popupTabId: 82 };

describe('merge directory picker sessions', () => {
  it.each(['issue-read', 'issue-write', 'bind-read', 'bind-write', 'claim-write'] as const)(
    'cannot resurrect a revoked job when cancellation races a held %s',
    async (stage) => {
      const storage = new FakeStorage();
      const broker = new MergeDirectoryPickerSessionBroker(
        storage,
        () => 1_000,
        () => 'held',
      );
      if (stage.startsWith('bind') || stage === 'claim-write') await broker.getOrIssue(owner);
      if (stage === 'claim-write') await broker.bindPopup('held', popup);
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let first = true;
      if (stage.endsWith('read')) {
        const get = storage.get.bind(storage);
        vi.spyOn(storage, 'get').mockImplementation(async (keys) => {
          const snapshot = await get(keys);
          if (first) {
            first = false;
            enter();
            await held;
          }
          return snapshot;
        });
      } else {
        const set = storage.set.bind(storage);
        vi.spyOn(storage, 'set').mockImplementation(async (values) => {
          if (first) {
            first = false;
            enter();
            await held;
          }
          await set(values);
        });
      }
      const operation = stage.startsWith('issue')
        ? broker.getOrIssue(owner)
        : stage.startsWith('bind')
          ? broker.bindPopup('held', popup)
          : broker.claim('held', popup);
      const rejected = expect(operation).rejects.toThrow(/已失效|已过期/u);
      await entered;
      let cleared = false;
      const clearing = broker.clearJob(owner.jobId).then(() => {
        cleared = true;
      });
      if (stage.endsWith('read')) await clearing;
      else {
        await Promise.resolve();
        expect(cleared).toBe(false);
      }
      release();
      await rejected;
      await clearing;
      expect(storage.values.size).toBe(0);
      await expect(broker.getOrIssue(owner)).rejects.toThrow('已失效');
    },
  );

  it.each(['clearOtherOwners', 'createPopup', 'bindPopup', 'navigatePopup', 'focusPopup'] as const)(
    'closes a late popup and never recreates a picker after cancellation during %s',
    async (stage) => {
      const storage = new FakeStorage();
      const broker = new MergeDirectoryPickerSessionBroker(
        storage,
        () => 1_000,
        () => 'late-popup',
      );
      if (stage === 'focusPopup') {
        await broker.getOrIssue(owner);
        await broker.bindPopup('late-popup', popup);
      }
      let cancelled = false;
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const pause = async (current: string) => {
        if (stage === current) {
          enter();
          await held;
        }
      };
      const services: MergeDirectoryPickerOpenServices = {
        broker: {
          clearOtherOwners: async (nextOwner) => {
            await pause('clearOtherOwners');
            return broker.clearOtherOwners(nextOwner);
          },
          getOrIssue: (nextOwner) => broker.getOrIssue(nextOwner),
          bindPopup: async (id, window) => {
            await pause('bindPopup');
            return broker.bindPopup(id, window);
          },
          remove: (id) => broker.remove(id),
        },
        assertCurrent: async () => {
          if (cancelled) throw new Error('任务已停止');
        },
        closeWindows: vi.fn(async () => {}),
        createPopup: vi.fn(async () => {
          await pause('createPopup');
          return popup;
        }),
        inspectPopup: async () => {},
        focusPopup: vi.fn(async () => {
          await pause('focusPopup');
        }),
        navigatePopup: vi.fn(async () => {
          await pause('navigatePopup');
        }),
      };
      const opening = openBoundMergeDirectoryPicker(owner, services);
      const rejected = expect(opening).rejects.toThrow(/已停止|已过期|已失效/u);
      await entered;
      cancelled = true;
      await broker.clearJob(owner.jobId);
      release();
      await rejected;
      expect(storage.values.size).toBe(0);
      if (stage === 'clearOtherOwners') expect(services.createPopup).not.toHaveBeenCalled();
      else expect(services.closeWindows).toHaveBeenCalledWith([popup.popupWindowId]);
      if (stage === 'focusPopup') expect(services.createPopup).not.toHaveBeenCalled();
      if (stage === 'clearOtherOwners' || stage === 'createPopup' || stage === 'bindPopup')
        expect(services.navigatePopup).not.toHaveBeenCalled();
    },
  );

  it('revokes only a cancelled job and prevents its late claimed directory commit', async () => {
    let sequence = 0;
    const broker = new MergeDirectoryPickerSessionBroker(
      new FakeStorage(),
      () => 1_000,
      () => `scoped-${++sequence}`,
    );
    const first = await broker.getOrIssue(owner);
    const second = await broker.getOrIssue({ ...owner, jobId: 'other-job', sourceTabId: 43 });
    await broker.bindPopup(first.session.id, popup);
    const otherPopup = { popupWindowId: 91, popupTabId: 92 };
    await broker.bindPopup(second.session.id, otherPopup);
    await broker.claim(first.session.id, popup);
    expect(await broker.clearJob(owner.jobId)).toHaveLength(1);
    await expect(broker.commitClaim(first.session.id, popup)).rejects.toThrow();
    await expect(broker.authorize(second.session.id, otherPopup)).resolves.toMatchObject({
      jobId: 'other-job',
    });
  });

  it('requires a live claimed session at the final directory commit', async () => {
    const storage = new FakeStorage();
    let now = 1_000;
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => now,
      () => 'commit',
    );
    await broker.getOrIssue(owner);
    await broker.bindPopup('commit', popup);
    await expect(broker.commitClaim('commit', popup)).rejects.toThrow('已失效');
    await broker.claim('commit', popup);
    now += MERGE_DIRECTORY_PICKER_SESSION_TTL_MS + 1;
    await expect(broker.commitClaim('commit', popup)).rejects.toThrow('已过期');
    expect(storage.values.has(`${MERGE_DIRECTORY_PICKER_SESSION_PREFIX}commit`)).toBe(false);
  });

  it('commits once and rejects a cancelled or replayed final commit', async () => {
    const broker = new MergeDirectoryPickerSessionBroker(
      new FakeStorage(),
      () => 1_000,
      () => 'commit',
    );
    await broker.getOrIssue(owner);
    await broker.bindPopup('commit', popup);
    await broker.claim('commit', popup);
    await broker.commitClaim('commit', popup);
    await expect(broker.commitClaim('commit', popup)).rejects.toThrow('已经使用');
  });

  it('binds an opaque session to the exact source media and top-level popup', async () => {
    const storage = new FakeStorage();
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => 1_000,
      () => 'opaque',
    );
    const issued = await broker.getOrIssue(owner);

    expect(issued).toMatchObject({ reused: false, session: { id: 'opaque', state: 'opening' } });
    await expect(broker.bindPopup('opaque', popup)).resolves.toMatchObject({
      ...owner,
      ...popup,
      state: 'active',
    });
    await expect(broker.authorize('opaque', popup)).resolves.toMatchObject(owner);
    await expect(broker.authorize('opaque', { ...popup, popupTabId: 999 })).rejects.toThrow(
      /窗口不匹配/u,
    );
    await expect(broker.authorize('opaque', { ...popup, popupWindowId: 999 })).rejects.toThrow(
      /窗口不匹配/u,
    );
  });

  it('reuses one active picker for repeated clicks on the same job', async () => {
    const storage = new FakeStorage();
    let tokenIndex = 0;
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => 2_000,
      () => `opaque-${++tokenIndex}`,
    );
    const first = await broker.getOrIssue(owner);
    await broker.bindPopup(first.session.id, popup);
    const second = await broker.getOrIssue(owner);

    expect(second.reused).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session).toMatchObject(popup);
  });

  it('deduplicates simultaneous issue requests before a popup is bound', async () => {
    const storage = new FakeStorage();
    let tokenIndex = 0;
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => 2_500,
      () => `simultaneous-${++tokenIndex}`,
    );

    const [first, second] = await Promise.all([broker.getOrIssue(owner), broker.getOrIssue(owner)]);
    expect(first.session.id).toBe(second.session.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(tokenIndex).toBe(1);
  });

  it('allows one mutation claim and rejects concurrent or replayed commits', async () => {
    const storage = new FakeStorage();
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => 3_000,
      () => 'once',
    );
    await broker.getOrIssue(owner);
    await broker.bindPopup('once', popup);

    await expect(broker.claim('once', popup)).resolves.toMatchObject({ state: 'claimed' });
    await expect(broker.claim('once', popup)).rejects.toThrow(/已.*使用/u);
    await broker.consume('once');
    await expect(broker.authorize('once', popup)).rejects.toThrow(/已.*使用/u);
    await expect(broker.claim('once', popup)).rejects.toThrow(/已.*使用/u);
  });

  it('can release a failed commit claim for a retry in the same popup', async () => {
    const broker = new MergeDirectoryPickerSessionBroker(
      new FakeStorage(),
      () => 4_000,
      () => 'retry',
    );
    await broker.getOrIssue(owner);
    await broker.bindPopup('retry', popup);
    await broker.claim('retry', popup);
    await broker.releaseClaim('retry');

    await expect(broker.claim('retry', popup)).resolves.toMatchObject({ state: 'claimed' });
  });

  it('expires stale sessions and never revives their opaque id', async () => {
    const storage = new FakeStorage();
    let now = 5_000;
    let tokenIndex = 0;
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => now,
      () => `expiry-${++tokenIndex}`,
    );
    const first = await broker.getOrIssue(owner);
    await broker.bindPopup(first.session.id, popup);
    now += MERGE_DIRECTORY_PICKER_SESSION_TTL_MS + 1;

    await expect(broker.authorize(first.session.id, popup)).rejects.toThrow(/已过期/u);
    const replacement = await broker.getOrIssue(owner);
    expect(replacement.session.id).toBe('expiry-2');
    expect(replacement.reused).toBe(false);
  });

  it('clears a source tab and returns only its picker windows for closure', async () => {
    const storage = new FakeStorage();
    let tokenIndex = 0;
    const broker = new MergeDirectoryPickerSessionBroker(
      storage,
      () => 6_000,
      () => `tab-${++tokenIndex}`,
    );
    const first = await broker.getOrIssue(owner);
    await broker.bindPopup(first.session.id, popup);
    const other = await broker.getOrIssue({
      ...owner,
      jobId: 'other-tab-job',
      sourceTabId: 43,
    });
    await broker.bindPopup(other.session.id, { popupWindowId: 91, popupTabId: 92 });

    await expect(broker.clearSourceTab(42)).resolves.toEqual([81]);
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith(MERGE_DIRECTORY_PICKER_SESSION_PREFIX),
      ),
    ).toHaveLength(1);
    await expect(
      broker.authorize(other.session.id, { popupWindowId: 91, popupTabId: 92 }),
    ).resolves.toMatchObject({ sourceTabId: 43 });
  });

  it('consumes the session when its popup window closes', async () => {
    const broker = new MergeDirectoryPickerSessionBroker(
      new FakeStorage(),
      () => 6_500,
      () => 'closed-window',
    );
    await broker.getOrIssue(owner);
    await broker.bindPopup('closed-window', popup);

    await broker.consumePopupWindow(popup.popupWindowId);
    await expect(broker.authorize('closed-window', popup)).rejects.toThrow(/已.*使用/u);
  });

  it('invalidates a prior video session when the source tab changes owner', async () => {
    const broker = new MergeDirectoryPickerSessionBroker(
      new FakeStorage(),
      () => 7_000,
      () => crypto.randomUUID(),
    );
    const first = await broker.getOrIssue(owner);
    await broker.bindPopup(first.session.id, popup);
    const windows = await broker.clearOtherOwners({
      ...owner,
      jobId: 'new-job',
      sourcePageUrl: 'https://www.bilibili.com/video/BV1next',
      mediaEpoch: 8,
    });

    expect(windows).toEqual([81]);
    await expect(broker.authorize(first.session.id, popup)).rejects.toThrow(/已过期/u);
  });
});
