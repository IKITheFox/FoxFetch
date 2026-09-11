import { observeYouTubeSetupRequests } from './request-context';

type Owner = { tabId: number; documentId: string; pageUrl: string };
type Observation = ReturnType<typeof observeYouTubeSetupRequests>;

/** Authorized, short-lived memory only. Taking an entry transfers cleanup ownership. */
export class YouTubeContextObservationPool {
  private entries = new Map<
    number,
    { owner: Owner; observation: Observation; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private observe = observeYouTubeSetupRequests) {}

  clear(tabId: number) {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    this.entries.delete(tabId);
    clearTimeout(entry.timer);
    entry.observation.close();
  }

  clearAll() {
    for (const id of this.entries.keys()) this.clear(id);
  }

  warm(owner: Owner) {
    const previous = this.entries.get(owner.tabId);
    if (previous?.owner.documentId === owner.documentId && previous.owner.pageUrl === owner.pageUrl)
      return;
    this.clear(owner.tabId);
    // Cap total sensitive memory as well as each observer's request count.
    if (this.entries.size >= 4) this.clear(this.entries.keys().next().value!);
    const observation = this.observe(owner);
    const timer = setTimeout(() => this.clear(owner.tabId), 120_000);
    this.entries.set(owner.tabId, { owner: { ...owner }, observation, timer });
  }

  take(owner: Owner): Observation | undefined {
    const entry = this.entries.get(owner.tabId);
    if (!entry) return;
    if (entry.owner.documentId !== owner.documentId || entry.owner.pageUrl !== owner.pageUrl) {
      this.clear(owner.tabId);
      return;
    }
    this.entries.delete(owner.tabId);
    clearTimeout(entry.timer);
    return entry.observation;
  }
}
