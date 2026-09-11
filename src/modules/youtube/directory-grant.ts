import type { YouTubeTaskOwner } from './background-task';
import {
  ExtensionDirectoryHandleStore,
  verifyDirectoryPermission,
  type StoredDirectoryHandle,
} from '../downloads/directory-handle-store';

export interface YouTubeDirectoryGrantOwner extends YouTubeTaskOwner {
  jobId: string;
  videoId: string;
}
export interface YouTubeDirectoryPickerIdentity {
  tabId: number;
  windowId: number;
  documentId: string;
}
interface Grant {
  owner: YouTubeDirectoryGrantOwner;
  picker: YouTubeDirectoryPickerIdentity;
  expiresAt: number;
  state: 'active' | 'claimed' | 'consumed';
  target?: { handleId: string; name: string; selectedAt: number };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const document = (value: string) => typeof value === 'string' && /^[\w-]{1,128}$/u.test(value);

/** YouTube-only, fail-closed picker authorization. A worker restart invalidates
 * these short-lived grants; it never restores permission from page-provided IDs.
 * The trusted background must authenticate sender URL/extension before use. */
export class YouTubeDirectoryGrants {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  issue(owner: YouTubeDirectoryGrantOwner, picker: YouTubeDirectoryPickerIdentity): string {
    const route = URL.canParse(owner.pageUrl) ? new URL(owner.pageUrl) : undefined;
    if (
      !uuid.test(owner.jobId) ||
      !/^[\w-]{11}$/u.test(owner.videoId) ||
      !integer(owner.tabId) ||
      !document(owner.documentId) ||
      !integer(owner.navigationEpoch) ||
      !integer(owner.mediaEpoch) ||
      !route ||
      route.protocol !== 'https:' ||
      route.username !== '' ||
      route.password !== '' ||
      !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(route.hostname) ||
      route.pathname !== '/watch' ||
      route.searchParams.getAll('v').length !== 1 ||
      route.searchParams.get('v') !== owner.videoId ||
      !integer(picker.tabId) ||
      !integer(picker.windowId) ||
      !document(picker.documentId)
    )
      throw new Error('DIRECTORY_GRANT_IDENTITY_INVALID');
    const now = this.now();
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id);
    if (this.grants.size >= 128) throw new Error('DIRECTORY_GRANT_CAPACITY_REACHED');
    const id = this.createId();
    if (!uuid.test(id) || this.grants.has(id)) throw new Error('DIRECTORY_GRANT_ID_INVALID');
    // Copy only identity fields, never page-supplied extra data or handles.
    this.grants.set(id, {
      owner: {
        jobId: owner.jobId,
        videoId: owner.videoId,
        tabId: owner.tabId,
        documentId: owner.documentId,
        pageUrl: owner.pageUrl,
        navigationEpoch: owner.navigationEpoch,
        mediaEpoch: owner.mediaEpoch,
      },
      picker: { tabId: picker.tabId, windowId: picker.windowId, documentId: picker.documentId },
      expiresAt: now + 3 * 60_000,
      state: 'active',
    });
    return id;
  }

  /** Claim synchronously before any asynchronous permission or storage work.
   * The returned guard must be checked after each await and before committing. */
  claim(id: string, owner: YouTubeDirectoryGrantOwner, picker: YouTubeDirectoryPickerIdentity) {
    const grant = this.grants.get(id);
    const matches =
      grant &&
      Object.entries(grant.owner).every(
        ([k, v]) => owner[k as keyof YouTubeDirectoryGrantOwner] === v,
      ) &&
      Object.entries(grant.picker).every(
        ([k, v]) => picker[k as keyof YouTubeDirectoryPickerIdentity] === v,
      );
    if (!matches || grant.state !== 'active' || grant.expiresAt <= this.now())
      throw new Error('DIRECTORY_GRANT_UNAVAILABLE');
    grant.state = 'claimed';
    const assertLive = () => {
      if (
        this.grants.get(id) !== grant ||
        grant.state !== 'claimed' ||
        grant.expiresAt <= this.now()
      )
        throw new Error('DIRECTORY_GRANT_UNAVAILABLE');
    };
    return {
      assertLive,
      consume: () => {
        assertLive();
        grant.state = 'consumed';
      },
    };
  }

  /** Confirm only the handle reserved for this picker, never an arbitrary key
   * supplied by a page. No permission prompt or file mutation is performed. */
  async confirm(
    id: string,
    owner: YouTubeDirectoryGrantOwner,
    picker: YouTubeDirectoryPickerIdentity,
    options: {
      assertCurrent: (owner: YouTubeDirectoryGrantOwner) => Promise<void>;
      store?: { get(id: string): Promise<StoredDirectoryHandle | undefined> };
    },
  ): Promise<{ handleId: string; name: string; selectedAt: number }> {
    const claim = this.claim(id, owner, picker);
    const grant = this.grants.get(id)!;
    const handleId = `youtube-${id}`;
    const ownedStore = options.store ? undefined : new ExtensionDirectoryHandleStore();
    try {
      await options.assertCurrent({ ...grant.owner });
      claim.assertLive();
      const stored = await (options.store ?? ownedStore!).get(handleId);
      claim.assertLive();
      if (
        !stored ||
        stored.metadata.handleId !== handleId ||
        stored.metadata.name !== stored.handle.name ||
        !stored.metadata.name ||
        !Number.isSafeInteger(stored.metadata.selectedAt) ||
        stored.metadata.selectedAt < 0
      )
        throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
      const target = {
        handleId,
        name: stored.metadata.name,
        selectedAt: stored.metadata.selectedAt,
      };
      if ((await verifyDirectoryPermission(stored.handle)) !== 'granted')
        throw new Error('DIRECTORY_PERMISSION_REQUIRED');
      claim.assertLive();
      await options.assertCurrent({ ...grant.owner });
      claim.assertLive();
      // Final metadata commit and consumption are synchronous in this worker.
      // A new task cannot observe a half-committed target.
      claim.consume();
      grant.target = target;
      return { ...target };
    } finally {
      await ownedStore?.close();
    }
  }

  /** Resolve a confirmed target for the original job immediately before start.
   * Starting a task must still query current filesystem permission separately. */
  target(id: string, owner: YouTubeDirectoryGrantOwner) {
    const grant = this.grants.get(id);
    if (
      !grant ||
      grant.state !== 'consumed' ||
      !grant.target ||
      grant.expiresAt <= this.now() ||
      !Object.entries(grant.owner).every(
        ([k, v]) => owner[k as keyof YouTubeDirectoryGrantOwner] === v,
      )
    )
      throw new Error('DIRECTORY_GRANT_UNAVAILABLE');
    return { ...grant.target };
  }

  revokeJob(jobId: string): void {
    for (const [id, grant] of this.grants) if (grant.owner.jobId === jobId) this.grants.delete(id);
  }

  /** A source page may learn the display name and opaque session, never select
   * a stored handle. Resolve again at start; this reply is not authorization. */
  confirmed(owner: YouTubeDirectoryGrantOwner) {
    const matches = [...this.grants].filter(
      ([, grant]) =>
        grant.state === 'consumed' &&
        grant.target &&
        grant.expiresAt > this.now() &&
        Object.entries(grant.owner).every(
          ([key, value]) => owner[key as keyof YouTubeDirectoryGrantOwner] === value,
        ),
    );
    if (matches.length > 1) throw new Error('DIRECTORY_GRANT_AMBIGUOUS');
    const match = matches[0];
    if (!match) return null;
    const target = this.target(match[0], owner);
    return { sessionId: match[0], name: target.name };
  }
  revokeTab(tabId: number): void {
    for (const [id, grant] of this.grants)
      if (grant.owner.tabId === tabId || grant.picker.tabId === tabId) this.grants.delete(id);
  }

  revokeSourceTab(tabId: number): void {
    for (const [id, grant] of this.grants)
      if (grant.owner.tabId === tabId) this.grants.delete(id);
  }
}
