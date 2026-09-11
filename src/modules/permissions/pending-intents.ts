import type {
  MediaAccessIntent,
  MediaAccessIntentAction,
  MediaAccessIntentResult,
} from '../../shared/types';

export type { PermissionGatedMediaAction, PermissionGatedMediaIntent } from '../../shared/types';

const MEDIA_ACCESS_STORAGE_PREFIX = 'foxfetch:media-access-intent:';
const GENERAL_PERMISSION_STORAGE_PREFIX = 'foxfetch:permission-intent:';

export const MEDIA_ACCESS_INTENT_TTL_MS = 2 * 60_000;
export const PERMISSION_INTENT_TTL_MS = 5 * 60_000;

export type PendingPermissionIntentState = 'pending' | 'completed' | 'failed' | 'cancelled';
export type PendingMediaAccessIntentState = PendingPermissionIntentState;

export interface PermissionIntent<TAction = unknown> {
  id: string;
  action: TAction;
  createdAt: number;
  /** Exact optional permission bundle requested for this operation. */
  permissions?: chrome.permissions.Permissions;
}

export interface PendingPermissionIntent<
  TIntent extends PermissionIntent = PermissionIntent,
  TResult = unknown,
> {
  intent: TIntent;
  state: PendingPermissionIntentState;
  expiresAt: number;
  updatedAt: number;
  result?: TResult;
  error?: string;
}

export type PendingMediaAccessIntent = PendingPermissionIntent<
  MediaAccessIntent,
  MediaAccessIntentResult
>;

export interface SessionStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface PendingPermissionIntentStoreOptions {
  storagePrefix?: string;
  ttlMs?: number;
}

function isStoredIntent(value: unknown): value is PendingPermissionIntent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingPermissionIntent>;
  return (
    record.intent != null &&
    typeof record.intent === 'object' &&
    typeof record.intent.id === 'string' &&
    typeof record.intent.createdAt === 'number' &&
    'action' in record.intent &&
    typeof record.expiresAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    ['pending', 'completed', 'failed', 'cancelled'].includes(record.state ?? '')
  );
}

/**
 * Session-scoped storage for operations that must survive a popup closing while
 * Chrome owns a native permission prompt. It deliberately does not survive a
 * browser restart; callers must revalidate tab and media identity before commit.
 */
export class PendingPermissionIntentStore<
  TIntent extends PermissionIntent = PermissionIntent,
  TResult = unknown,
> {
  private readonly storagePrefix: string;
  private readonly ttlMs: number;

  constructor(
    private readonly storage: SessionStorageArea = chrome.storage.session,
    private readonly now: () => number = Date.now,
    options: PendingPermissionIntentStoreOptions = {},
  ) {
    this.storagePrefix = options.storagePrefix ?? GENERAL_PERMISSION_STORAGE_PREFIX;
    this.ttlMs = Math.max(1, options.ttlMs ?? PERMISSION_INTENT_TTL_MS);
  }

  private key(intentId: string): string {
    return `${this.storagePrefix}${intentId}`;
  }

  async stage(intent: TIntent): Promise<PendingPermissionIntent<TIntent, TResult>> {
    const existing = await this.read(intent.id);
    if (existing) {
      if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
        throw new Error('权限待办标识已被其他操作占用');
      }
      return existing;
    }

    const currentTime = this.now();
    const record: PendingPermissionIntent<TIntent, TResult> = {
      intent,
      state: 'pending',
      expiresAt: currentTime + this.ttlMs,
      updatedAt: currentTime,
    };
    await this.storage.set({ [this.key(intent.id)]: record });
    return record;
  }

  async read(intentId: string): Promise<PendingPermissionIntent<TIntent, TResult> | undefined> {
    const storageKey = this.key(intentId);
    const value = (await this.storage.get(storageKey))[storageKey];
    if (!isStoredIntent(value)) return undefined;
    if (value.expiresAt <= this.now()) {
      await this.storage.remove(storageKey);
      return undefined;
    }
    return value as PendingPermissionIntent<TIntent, TResult>;
  }

  async listPending(): Promise<Array<PendingPermissionIntent<TIntent, TResult>>> {
    const values = await this.storage.get(null);
    const pending: Array<PendingPermissionIntent<TIntent, TResult>> = [];
    const expired: string[] = [];
    for (const [storageKey, value] of Object.entries(values)) {
      if (!storageKey.startsWith(this.storagePrefix) || !isStoredIntent(value)) continue;
      if (value.expiresAt <= this.now()) {
        expired.push(storageKey);
      } else if (value.state === 'pending') {
        pending.push(value as PendingPermissionIntent<TIntent, TResult>);
      }
    }
    if (expired.length > 0) await this.storage.remove(expired);
    return pending;
  }

  async complete(intentId: string, result: TResult): Promise<void> {
    const current = await this.read(intentId);
    if (!current) return;
    await this.storage.set({
      [this.key(intentId)]: {
        ...current,
        state: 'completed',
        result,
        updatedAt: this.now(),
      } satisfies PendingPermissionIntent<TIntent, TResult>,
    });
  }

  async fail(intentId: string, error: unknown): Promise<void> {
    const current = await this.read(intentId);
    if (!current || current.state === 'completed') return;
    await this.storage.set({
      [this.key(intentId)]: {
        ...current,
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.now(),
      } satisfies PendingPermissionIntent<TIntent, TResult>,
    });
  }

  async cancel(intentId: string): Promise<void> {
    const current = await this.read(intentId);
    if (!current || current.state !== 'pending') return;
    await this.storage.set({
      [this.key(intentId)]: {
        ...current,
        state: 'cancelled',
        updatedAt: this.now(),
      } satisfies PendingPermissionIntent<TIntent, TResult>,
    });
  }
}

export interface PermissionIntentBrokerMessages {
  expired: string;
  failed: string;
  cancelled: string;
  permissionRequired: string;
}

const DEFAULT_BROKER_MESSAGES: PermissionIntentBrokerMessages = {
  expired: '权限确认已过期，请重新点击下载',
  failed: '下载任务创建失败',
  cancelled: '已取消下载',
  permissionRequired: '需要先授予所选媒体来源权限',
};

export type PermissionIntentOperation<TIntent extends PermissionIntent, TResult> = (
  intentId: string,
  action: TIntent['action'],
  intent: TIntent,
) => Promise<TResult>;

export type PermissionIntentAccessCheck<TIntent extends PermissionIntent> = (
  intent: TIntent,
) => Promise<boolean>;

/**
 * Coordinates a foreground continuation and permissions.onAdded without
 * duplicates. The operation should also use intentId as its durable idempotency
 * key so an interrupted Service Worker cannot duplicate an external side effect.
 */
export class PermissionIntentBroker<
  TIntent extends PermissionIntent = PermissionIntent,
  TResult = unknown,
> {
  private readonly executions = new Map<string, Promise<TResult>>();
  private readonly messages: PermissionIntentBrokerMessages;

  constructor(
    private readonly store: PendingPermissionIntentStore<TIntent, TResult>,
    private readonly hasAccess: PermissionIntentAccessCheck<TIntent>,
    private readonly execute: PermissionIntentOperation<TIntent, TResult>,
    messages: Partial<PermissionIntentBrokerMessages> = {},
  ) {
    this.messages = { ...DEFAULT_BROKER_MESSAGES, ...messages };
  }

  commit(intentId: string): Promise<TResult> {
    const running = this.executions.get(intentId);
    if (running) return running;
    const execution = this.executeOnce(intentId);
    this.executions.set(intentId, execution);
    void execution.finally(() => this.executions.delete(intentId)).catch(() => undefined);
    return execution;
  }

  async resumePending(): Promise<void> {
    const pending = await this.store.listPending();
    await Promise.allSettled(pending.map((record) => this.commit(record.intent.id)));
  }

  private async executeOnce(intentId: string): Promise<TResult> {
    const record = await this.store.read(intentId);
    if (!record) throw new Error(this.messages.expired);
    if (record.state === 'completed' && 'result' in record) return record.result as TResult;
    if (record.state === 'failed') throw new Error(record.error || this.messages.failed);
    if (record.state === 'cancelled') throw new Error(this.messages.cancelled);
    if (!(await this.hasAccess(record.intent))) throw new Error(this.messages.permissionRequired);

    try {
      const result = await this.execute(intentId, record.intent.action, record.intent);
      await this.store.complete(intentId, result);
      return result;
    } catch (error) {
      await this.store.fail(intentId, error);
      throw error;
    }
  }
}

/** Backward-compatible store used by the v0.5 media merge protocol. */
export class PendingMediaAccessIntentStore extends PendingPermissionIntentStore<
  MediaAccessIntent,
  MediaAccessIntentResult
> {
  constructor(storage: SessionStorageArea = chrome.storage.session, now: () => number = Date.now) {
    super(storage, now, {
      storagePrefix: MEDIA_ACCESS_STORAGE_PREFIX,
      ttlMs: MEDIA_ACCESS_INTENT_TTL_MS,
    });
  }

  override async stage(intent: MediaAccessIntent): Promise<PendingMediaAccessIntent> {
    const existing = await this.read(intent.id);
    if (existing) return super.stage(intent);

    const staged = await super.stage(intent);
    const pending = await this.listPending();
    await Promise.all(
      pending
        .filter(
          (record) =>
            record.intent.id !== intent.id && record.intent.action.tabId === intent.action.tabId,
        )
        .map((record) => this.cancel(record.intent.id)),
    );
    return staged;
  }
}

export type MediaAccessIntentOperation = (
  intentId: string,
  action: MediaAccessIntentAction,
) => Promise<MediaAccessIntentResult>;

/** Backward-compatible broker used by the existing background integration. */
export class MediaAccessIntentBroker extends PermissionIntentBroker<
  MediaAccessIntent,
  MediaAccessIntentResult
> {
  constructor(
    store: PendingMediaAccessIntentStore,
    hasAccess: () => Promise<boolean>,
    execute: MediaAccessIntentOperation,
  ) {
    super(store, hasAccess, execute, {
      expired: '权限确认已过期，请重新点击合并下载',
      failed: '合并下载任务创建失败',
      cancelled: '已取消合并下载',
      permissionRequired: '需要先授予完整媒体访问权限',
    });
  }
}
