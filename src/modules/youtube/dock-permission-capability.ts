import type { YouTubeTaskOwner } from './background-task';

/** Live-worker, one-shot permission prompt capability; never a download authorization. */
export class YouTubeDockPermissionCapabilities {
  private readonly grants = new Map<string, { owner: YouTubeTaskOwner; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(owner: YouTubeTaskOwner): { token: string; expiresAt: number } {
    for (const [key, grant] of this.grants)
      if (grant.expiresAt <= this.now()) this.grants.delete(key);
    // Bounded even when tabs disappear without sending a cleanup message.
    if (this.grants.size >= 128) this.grants.delete(this.grants.keys().next().value!);
    const token = crypto.randomUUID();
    const expiresAt = this.now() + 90_000;
    this.grants.set(token, { owner: { ...owner }, expiresAt });
    return { token, expiresAt };
  }

  claimDocument(
    token: unknown,
    identity: Omit<YouTubeTaskOwner, 'pageUrl'>,
  ): YouTubeTaskOwner | undefined {
    if (typeof token !== 'string') return;
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= this.now()) return;
    if (
      grant.owner.tabId !== identity.tabId ||
      grant.owner.documentId !== identity.documentId ||
      grant.owner.navigationEpoch !== identity.navigationEpoch ||
      grant.owner.mediaEpoch !== identity.mediaEpoch
    )
      return;
    this.grants.delete(token);
    // The caller revalidates this trusted URL against the live document after prompting.
    return { ...grant.owner };
  }

  claim(token: unknown, owner: YouTubeTaskOwner): boolean {
    if (typeof token !== 'string') return false;
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= this.now()) return false;
    if (
      grant.owner.tabId !== owner.tabId ||
      grant.owner.documentId !== owner.documentId ||
      grant.owner.pageUrl !== owner.pageUrl ||
      grant.owner.navigationEpoch !== owner.navigationEpoch ||
      grant.owner.mediaEpoch !== owner.mediaEpoch
    )
      return false;
    this.grants.delete(token);
    return true;
  }
}
