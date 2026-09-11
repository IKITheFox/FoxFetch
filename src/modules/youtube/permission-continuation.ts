import {
  PendingPermissionIntentStore,
  PermissionIntentBroker,
  type PermissionIntent,
  type SessionStorageArea,
} from '../permissions/pending-intents';
import type { YouTubeTaskOwner, YouTubeTaskRequest, YouTubeTaskSnapshot } from './background-task';
import { YOUTUBE_SOURCE_PERMISSIONS } from './source-permissions';

type Intent = PermissionIntent<YouTubeTaskRequest>;

/** Background-only continuation. Owner and directory target must be resolved by trusted handlers. */
export class YouTubePermissionContinuation {
  private readonly store: PendingPermissionIntentStore<Intent, YouTubeTaskSnapshot>;
  private readonly broker: PermissionIntentBroker<Intent, YouTubeTaskSnapshot>;
  private readonly operations = new Map<string, Promise<unknown>>();

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    void current
      .finally(() => {
        if (this.operations.get(id) === current) this.operations.delete(id);
      })
      .catch(() => undefined);
    return current;
  }
  constructor(
    private readonly dependencies: {
      storage: SessionStorageArea;
      assertCurrent: (owner: YouTubeTaskOwner) => Promise<void>;
      hasAccess: () => Promise<boolean>;
      start: (request: YouTubeTaskRequest) => Promise<YouTubeTaskSnapshot>;
      now?: () => number;
    },
  ) {
    this.store = new PendingPermissionIntentStore(dependencies.storage, dependencies.now, {
      storagePrefix: 'foxfetch:youtube-permission-intent:',
    });
    this.broker = new PermissionIntentBroker(
      this.store,
      dependencies.hasAccess,
      async (_id, action) => {
        await dependencies.assertCurrent(action.owner);
        // The task engine must also use this fixed jobId as its durable idempotency key.
        return dependencies.start(structuredClone(action));
      },
    );
  }

  async stage(request: YouTubeTaskRequest): Promise<string> {
    const action = structuredClone(request);
    return this.serialize(action.jobId, async () => {
      await this.dependencies.assertCurrent(action.owner);
      const previous = await this.store.read(action.jobId);
      if (previous) {
        if (JSON.stringify(previous.intent.action) !== JSON.stringify(action))
          throw new Error('授权任务与原下载选择不一致，请重新开始。');
        return action.jobId;
      }
      await this.store.stage({
        id: action.jobId,
        createdAt: (this.dependencies.now ?? Date.now)(),
        action,
        permissions: YOUTUBE_SOURCE_PERMISSIONS,
      });
      return action.jobId;
    });
  }

  /** Revalidate caller ownership even when the broker already has a completed result. */
  async commit(id: string, owner: YouTubeTaskOwner): Promise<YouTubeTaskSnapshot> {
    const caller = { ...owner };
    return this.serialize(id, async () => {
      await this.assertOwner(id, caller);
      return this.broker.commit(id);
    });
  }

  async cancel(id: string, owner: YouTubeTaskOwner): Promise<void> {
    const caller = { ...owner };
    return this.serialize(id, async () => {
      await this.assertOwner(id, caller);
      const record = await this.store.read(id);
      if (!record || (record.state !== 'pending' && record.state !== 'cancelled'))
        throw new Error('任务已处理，不能确认取消授权任务。请查询下载状态。');
      await this.store.cancel(id);
    });
  }

  /** permissions.onAdded uses the original stored owner, never the currently active tab. */
  async resumePending(): Promise<void> {
    const pending = await this.store.listPending();
    await Promise.allSettled(
      pending.map((record) => this.commit(record.intent.id, record.intent.action.owner)),
    );
  }

  private async assertOwner(id: string, owner: YouTubeTaskOwner): Promise<void> {
    const record = await this.store.read(id);
    const expected = record?.intent.action.owner;
    if (
      !expected ||
      expected.tabId !== owner.tabId ||
      expected.documentId !== owner.documentId ||
      expected.pageUrl !== owner.pageUrl ||
      expected.navigationEpoch !== owner.navigationEpoch ||
      expected.mediaEpoch !== owner.mediaEpoch
    )
      throw new Error('授权对应的视频页面已变化，请重新开始。');
    await this.dependencies.assertCurrent(owner);
  }
}
