import {
  YouTubeDirectoryGrants,
  type YouTubeDirectoryGrantOwner,
  type YouTubeDirectoryPickerIdentity,
} from './directory-grant';

interface Pending {
  owner: YouTubeDirectoryGrantOwner;
  popup: Promise<{ tabId: number; windowId: number }>;
  expiresAt: number;
  sessionId?: string;
  documentId?: string;
}

/** Trusted background coordinator. Creates a popup first, then binds the exact
 * document reporting readiness. Page callers never choose popup identities. */
export class YouTubeDirectoryPickers {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly deps: {
      grants: YouTubeDirectoryGrants;
      assertCurrent(owner: YouTubeDirectoryGrantOwner): Promise<void>;
      open(nonce: string): Promise<{ tabId: number; windowId: number }>;
      close(windowId: number): Promise<void>;
      now?: () => number;
      createId?: () => string;
    },
  ) {}

  async open(owner: YouTubeDirectoryGrantOwner): Promise<string> {
    const copied = structuredClone(owner);
    await this.deps.assertCurrent(copied);
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= (this.deps.now ?? Date.now)()) await this.close(id);
    }
    await this.deps.assertCurrent({ ...copied });
    const existing = [...this.pending].find(([, pending]) =>
      Object.entries(pending.owner).every(
        ([key, value]) => copied[key as keyof YouTubeDirectoryGrantOwner] === value,
      ),
    );
    if (existing) {
      await existing[1].popup;
      await this.deps.assertCurrent({ ...copied });
      this.require(existing[0], existing[1]);
      return existing[0];
    }
    if (this.pending.size >= 128) throw new Error('DIRECTORY_PICKER_CAPACITY_REACHED');
    const nonce = (this.deps.createId ?? (() => crypto.randomUUID()))();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce) ||
      this.pending.has(nonce)
    )
      throw new Error('DIRECTORY_PICKER_ID_INVALID');
    const pending: Pending = {
      owner: copied,
      popup: Promise.resolve().then(() => this.deps.open(nonce)),
      expiresAt: (this.deps.now ?? Date.now)() + 180_000,
    };
    // Register before opening so an early ready message can await the same popup.
    this.pending.set(nonce, pending);
    try {
      const popup = await pending.popup;
      if (
        !Number.isSafeInteger(popup.tabId) ||
        popup.tabId < 0 ||
        !Number.isSafeInteger(popup.windowId) ||
        popup.windowId < 0
      )
        throw new Error('DIRECTORY_PICKER_IDENTITY_INVALID');
      await this.deps.assertCurrent({ ...copied });
      this.require(nonce, pending);
      return nonce;
    } catch (error) {
      this.pending.delete(nonce);
      const popup = await pending.popup.catch(() => undefined);
      if (popup && Number.isSafeInteger(popup.windowId) && popup.windowId >= 0)
        await this.deps.close(popup.windowId).catch(() => undefined);
      throw error;
    }
  }

  /** Sender URL, extension ID and top-level frame must be verified by the caller. */
  async ready(nonce: string, sender: YouTubeDirectoryPickerIdentity) {
    const pending = this.require(nonce);
    const identity = { ...sender };
    const popup = await pending.popup;
    this.require(nonce, pending);
    if (
      identity.tabId !== popup.tabId ||
      identity.windowId !== popup.windowId ||
      (pending.documentId !== undefined && pending.documentId !== identity.documentId)
    )
      throw new Error('DIRECTORY_PICKER_IDENTITY_CHANGED');
    await this.deps.assertCurrent({ ...pending.owner });
    this.require(nonce, pending);
    // Recheck after await: a different document may have completed first.
    if (pending.documentId !== undefined && pending.documentId !== identity.documentId)
      throw new Error('DIRECTORY_PICKER_IDENTITY_CHANGED');
    if (!pending.sessionId) {
      pending.sessionId = this.deps.grants.issue(pending.owner, identity);
      pending.documentId = identity.documentId;
    }
    return { sessionId: pending.sessionId, handleId: `youtube-${pending.sessionId}` };
  }

  async close(nonce: string): Promise<void> {
    const pending = this.pending.get(nonce);
    if (!pending) return;
    this.pending.delete(nonce);
    this.deps.grants.revokeJob(pending.owner.jobId);
    const popup = await pending.popup.catch(() => undefined);
    if (popup) await this.deps.close(popup.windowId);
  }

  waiting(nonce: string, owner: YouTubeDirectoryGrantOwner): boolean {
    const pending = this.pending.get(nonce);
    return (
      !!pending &&
      pending.expiresAt > (this.deps.now ?? Date.now)() &&
      Object.entries(pending.owner).every(
        ([key, value]) => owner[key as keyof YouTubeDirectoryGrantOwner] === value,
      )
    );
  }

  async sourceRemoved(tabId: number): Promise<void> {
    // Invalidate all matching requests synchronously, before waiting for any
    // popup still being created. Existing downloads own a separate target copy.
    this.deps.grants.revokeSourceTab(tabId);
    const removed: Pending[] = [];
    for (const [nonce, pending] of this.pending) {
      if (pending.owner.tabId !== tabId) continue;
      this.pending.delete(nonce);
      removed.push(pending);
    }
    await Promise.all(
      removed.map(async (pending) => {
        const popup = await pending.popup.catch(() => undefined);
        if (popup) await this.deps.close(popup.windowId).catch(() => undefined);
      }),
    );
  }

  /** Browser close events are authoritative only for the popup we created.
   * A successful finish already detached it, and must not revoke its target. */
  async windowRemoved(windowId: number): Promise<void> {
    for (const [nonce, pending] of this.pending) {
      const popup = await pending.popup.catch(() => undefined);
      if (popup?.windowId !== windowId || this.pending.get(nonce) !== pending) continue;
      this.pending.delete(nonce);
      this.deps.grants.revokeJob(pending.owner.jobId);
    }
  }

  async confirm(nonce: string, sender: YouTubeDirectoryPickerIdentity) {
    const context = await this.ready(nonce, sender);
    const pending = this.require(nonce);
    await this.deps.grants.confirm(context.sessionId, pending.owner, sender, {
      assertCurrent: this.deps.assertCurrent,
    });
    this.require(nonce, pending);
    return this.finish(nonce);
  }

  /** Successful selection is not cancellation. Detach the popup before closing
   * it so a later window-closed event cannot revoke the confirmed task target. */
  async finish(nonce: string) {
    const pending = this.require(nonce);
    await this.deps.assertCurrent({ ...pending.owner });
    this.require(nonce, pending);
    if (!pending.sessionId) throw new Error('DIRECTORY_GRANT_UNAVAILABLE');
    const target = this.deps.grants.target(pending.sessionId, pending.owner);
    const popup = await pending.popup;
    this.require(nonce, pending);
    await this.deps.assertCurrent({ ...pending.owner });
    this.require(nonce, pending);
    // Revalidate the grant after the last asynchronous ownership check.
    this.deps.grants.target(pending.sessionId, pending.owner);
    this.pending.delete(nonce);
    await this.deps.close(popup.windowId).catch(() => undefined);
    return { sessionId: pending.sessionId, ...target };
  }

  private require(nonce: string, expected?: Pending): Pending {
    const pending = this.pending.get(nonce);
    if (
      !pending ||
      (expected && pending !== expected) ||
      pending.expiresAt <= (this.deps.now ?? Date.now)()
    )
      throw new Error('DIRECTORY_PICKER_UNAVAILABLE');
    return pending;
  }
}
