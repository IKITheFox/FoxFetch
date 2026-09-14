import { budgetedSessionStorage } from '../storage/session-budget';
import type { StorageAreaLike } from './store';

export const MERGE_DIRECTORY_PICKER_SESSION_PREFIX = 'foxfetch:merge-directory-picker-session:';
export const MERGE_DIRECTORY_PICKER_SESSION_TTL_MS = 3 * 60 * 1_000;

export type MergeDirectoryPickerSessionState = 'opening' | 'active' | 'claimed' | 'consumed';

export interface MergeDirectoryPickerSession {
  id: string;
  jobId: string;
  sourceTabId: number;
  sourcePageUrl: string;
  mediaEpoch: number;
  state: MergeDirectoryPickerSessionState;
  issuedAt: number;
  expiresAt: number;
  popupWindowId?: number;
  popupTabId?: number;
  consumedAt?: number;
}

export interface MergeDirectoryPickerSessionOwner {
  jobId: string;
  sourceTabId: number;
  sourcePageUrl: string;
  mediaEpoch: number;
}

export interface MergeDirectoryPickerPopupIdentity {
  popupWindowId: number;
  popupTabId: number;
}

export interface IssuedMergeDirectoryPickerSession {
  session: MergeDirectoryPickerSession;
  reused: boolean;
}

function storageKey(id: string): string {
  return `${MERGE_DIRECTORY_PICKER_SESSION_PREFIX}${id}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSession(value: unknown): value is MergeDirectoryPickerSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<MergeDirectoryPickerSession>;
  return (
    typeof session.id === 'string' &&
    session.id.length > 0 &&
    typeof session.jobId === 'string' &&
    session.jobId.length > 0 &&
    isPositiveInteger(session.sourceTabId) &&
    typeof session.sourcePageUrl === 'string' &&
    session.sourcePageUrl.length > 0 &&
    isPositiveInteger(session.mediaEpoch) &&
    (session.state === 'opening' ||
      session.state === 'active' ||
      session.state === 'claimed' ||
      session.state === 'consumed') &&
    typeof session.issuedAt === 'number' &&
    typeof session.expiresAt === 'number' &&
    (session.popupWindowId == null || isPositiveInteger(session.popupWindowId)) &&
    (session.popupTabId == null || isPositiveInteger(session.popupTabId)) &&
    (session.consumedAt == null || typeof session.consumedAt === 'number')
  );
}

function sameOwner(
  session: MergeDirectoryPickerSession,
  owner: MergeDirectoryPickerSessionOwner,
): boolean {
  return (
    session.jobId === owner.jobId &&
    session.sourceTabId === owner.sourceTabId &&
    session.sourcePageUrl === owner.sourcePageUrl &&
    session.mediaEpoch === owner.mediaEpoch
  );
}

/**
 * Short-lived broker for a top-level extension directory picker.
 *
 * Only opaque ids cross the page boundary. A session is bound to both the
 * source media identity and the exact popup created by the Service Worker.
 */
export class MergeDirectoryPickerSessionBroker {
  private readonly issueFlights = new Map<string, Promise<IssuedMergeDirectoryPickerSession>>();
  private readonly liveClaims = new Set<string>();
  private readonly revokedJobs = new Set<string>();
  private readonly revokedSessions = new Set<string>();
  private readonly writes = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly storage: StorageAreaLike = budgetedSessionStorage,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async getOrIssue(
    owner: MergeDirectoryPickerSessionOwner,
  ): Promise<IssuedMergeDirectoryPickerSession> {
    this.assertNotRevoked(owner.jobId);
    const ownerKey = `${owner.sourceTabId}\n${owner.sourcePageUrl}\n${owner.mediaEpoch}\n${owner.jobId}`;
    const existingFlight = this.issueFlights.get(ownerKey);
    if (existingFlight) {
      const result = await existingFlight;
      this.assertNotRevoked(owner.jobId, result.session.id);
      return { session: { ...result.session }, reused: true };
    }
    const flight = this.issue(owner);
    this.issueFlights.set(ownerKey, flight);
    try {
      return await flight;
    } finally {
      this.issueFlights.delete(ownerKey);
    }
  }

  private async issue(
    owner: MergeDirectoryPickerSessionOwner,
  ): Promise<IssuedMergeDirectoryPickerSession> {
    const sessions = await this.readAll();
    this.assertNotRevoked(owner.jobId);
    const now = this.now();
    await this.removeSessions(
      sessions.filter((session) => session.expiresAt <= now).map((session) => session.id),
    );
    this.assertNotRevoked(owner.jobId);
    const existing = sessions.find(
      (session) =>
        session.expiresAt > now &&
        (session.state === 'opening' || session.state === 'active') &&
        sameOwner(session, owner),
    );
    if (existing) return { session: { ...existing }, reused: true };

    const issuedAt = now;
    const session: MergeDirectoryPickerSession = {
      id: this.createId(),
      ...owner,
      state: 'opening',
      issuedAt,
      expiresAt: issuedAt + MERGE_DIRECTORY_PICKER_SESSION_TTL_MS,
    };
    await this.writeLive(session);
    return { session: { ...session }, reused: false };
  }

  async bindPopup(
    id: string,
    popup: MergeDirectoryPickerPopupIdentity,
  ): Promise<MergeDirectoryPickerSession> {
    const session = await this.requireLive(id, false);
    if (session.state !== 'opening') {
      throw new Error('本次目录选择已使用或已失效，请重新选择。');
    }
    const bound: MergeDirectoryPickerSession = {
      ...session,
      ...popup,
      state: 'active',
    };
    await this.writeLive(bound);
    return { ...bound };
  }

  async authorize(
    id: string,
    popup: MergeDirectoryPickerPopupIdentity,
  ): Promise<MergeDirectoryPickerSession> {
    const session = await this.requireLive(id, true);
    if (session.state !== 'active' && session.state !== 'claimed') {
      throw new Error('目录选择尚未准备好，请稍后重试。');
    }
    if (session.popupWindowId !== popup.popupWindowId || session.popupTabId !== popup.popupTabId) {
      throw new Error('目录选择会话与当前窗口不匹配');
    }
    return { ...session };
  }

  /** Claim before mutating policy so concurrent replay cannot commit twice. */
  async claim(
    id: string,
    popup: MergeDirectoryPickerPopupIdentity,
  ): Promise<MergeDirectoryPickerSession> {
    if (this.liveClaims.has(id)) throw new Error('目录选择请求已被使用');
    this.liveClaims.add(id);
    try {
      const session = await this.authorize(id, popup);
      if (session.state !== 'active') throw new Error('目录选择请求已被使用');
      const claimed: MergeDirectoryPickerSession = { ...session, state: 'claimed' };
      await this.writeLive(claimed);
      return { ...claimed };
    } catch (error) {
      this.liveClaims.delete(id);
      throw error;
    }
  }

  async releaseClaim(id: string): Promise<void> {
    this.liveClaims.delete(id);
    const session = await this.read(id);
    if (!session || session.state !== 'claimed' || session.expiresAt <= this.now()) return;
    await this.writeLive({ ...session, state: 'active' });
  }

  async consume(id: string): Promise<void> {
    this.liveClaims.delete(id);
    const session = await this.read(id);
    if (!session || session.state === 'consumed') return;
    await this.writeLive({ ...session, state: 'consumed', consumedAt: this.now() });
  }

  /** Final commit must not silently succeed for an expired/cancelled grant. */
  async commitClaim(id: string, popup: MergeDirectoryPickerPopupIdentity): Promise<void> {
    const session = await this.authorize(id, popup);
    if (!this.liveClaims.has(id) || session.state !== 'claimed') {
      throw new Error('目录选择请求已失效，原保存位置未更改。');
    }
    await this.writeLive({ ...session, state: 'consumed', consumedAt: this.now() });
    this.liveClaims.delete(id);
  }

  async consumePopupWindow(popupWindowId: number): Promise<void> {
    const sessions = await this.readAll();
    await Promise.all(
      sessions
        .filter(
          (session) => session.popupWindowId === popupWindowId && session.state !== 'consumed',
        )
        .map((session) => this.consume(session.id)),
    );
  }

  /** Remove all grants for a source tab and return popup windows to close. */
  async clearSourceTab(sourceTabId: number): Promise<number[]> {
    const sessions = (await this.readAll()).filter(
      (session) => session.sourceTabId === sourceTabId,
    );
    await this.removeSessions(sessions.map((session) => session.id));
    return [
      ...new Set(
        sessions.flatMap((session) =>
          session.popupWindowId == null ? [] : [session.popupWindowId],
        ),
      ),
    ];
  }

  async clearOtherOwners(owner: MergeDirectoryPickerSessionOwner): Promise<number[]> {
    const sessions = (await this.readAll()).filter(
      (session) =>
        session.sourceTabId === owner.sourceTabId &&
        session.state !== 'consumed' &&
        !sameOwner(session, owner),
    );
    await this.removeSessions(sessions.map((session) => session.id));
    return [
      ...new Set(
        sessions.flatMap((session) =>
          session.popupWindowId == null ? [] : [session.popupWindowId],
        ),
      ),
    ];
  }

  /** Revoke only one cancelled task's pickers, including in-flight final claims. */
  async clearJob(jobId: string): Promise<MergeDirectoryPickerSession[]> {
    // Synchronous tombstone precedes storage reads and catches an issue/bind
    // suspended before its first write. Already-started writes must settle.
    this.revokedJobs.add(jobId);
    await Promise.allSettled([...(this.writes.get(jobId) ?? [])]);
    const sessions = (await this.readAll()).filter((session) => session.jobId === jobId);
    await this.removeSessions(sessions.map((session) => session.id));
    return sessions;
  }

  async remove(id: string): Promise<void> {
    this.revokedSessions.add(id);
    this.liveClaims.delete(id);
    await this.storage.remove(storageKey(id));
  }

  private async requireLive(
    id: string,
    rejectConsumed: boolean,
  ): Promise<MergeDirectoryPickerSession> {
    const session = await this.read(id);
    if (!session || session.expiresAt <= this.now()) {
      if (session) await this.remove(id);
      throw new Error('目录选择请求已过期，请从当前视频重新打开');
    }
    if (rejectConsumed && session.state === 'consumed') {
      throw new Error('目录选择请求已经使用，请重新打开');
    }
    this.assertNotRevoked(session.jobId, session.id);
    return session;
  }

  private assertNotRevoked(jobId: string, sessionId?: string): void {
    if (this.revokedJobs.has(jobId) || (sessionId != null && this.revokedSessions.has(sessionId))) {
      throw new Error('目录选择请求已失效，任务已停止或页面已变化。');
    }
  }

  private async writeLive(session: MergeDirectoryPickerSession): Promise<void> {
    this.assertNotRevoked(session.jobId, session.id);
    const writes = this.writes.get(session.jobId) ?? new Set<Promise<void>>();
    this.writes.set(session.jobId, writes);
    const task = this.storage.set({ [storageKey(session.id)]: session }).then(async () => {
      try {
        this.assertNotRevoked(session.jobId, session.id);
      } catch (error) {
        // A storage.set already in flight cannot be aborted, so remove its
        // late result before clearJob is allowed to report settlement.
        await this.storage.remove(storageKey(session.id));
        throw error;
      }
    });
    writes.add(task);
    try {
      await task;
    } finally {
      writes.delete(task);
      if (writes.size === 0) this.writes.delete(session.jobId);
    }
  }

  private async read(id: string): Promise<MergeDirectoryPickerSession | undefined> {
    const value = (await this.storage.get(storageKey(id)))[storageKey(id)];
    return isSession(value) ? value : undefined;
  }

  private async readAll(): Promise<MergeDirectoryPickerSession[]> {
    const records = await this.storage.get(null);
    return Object.entries(records).flatMap(([key, value]) =>
      key.startsWith(MERGE_DIRECTORY_PICKER_SESSION_PREFIX) && isSession(value) ? [value] : [],
    );
  }

  private async removeSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.liveClaims.delete(id);
      this.revokedSessions.add(id);
    }
    await this.storage.remove(ids.map(storageKey));
  }
}
