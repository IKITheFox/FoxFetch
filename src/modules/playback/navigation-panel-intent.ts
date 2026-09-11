import { siteMediaRouteKey } from '../detector/site-media';

const KEY = 'foxfetch:playback-navigation:v0132';
const TTL = 12_000;
interface Intent {
  source: string;
  target?: string;
  expires: number;
}
function routeOf(doc: Document): string {
  const url = new URL(doc.URL);
  url.searchParams.delete('cid');
  return siteMediaRouteKey(url.href);
}

/** UI state only. Never authorizes a media operation or carries media URLs/credentials. */
export class NavigationPanelIntent {
  private intent: Intent | undefined;
  private userMode: 'launcher' | 'hidden' | undefined;
  constructor(private readonly doc: Document) {}

  begin(target?: string): void {
    this.clear();
    this.intent = {
      source: routeOf(this.doc),
      ...(target ? { target } : {}),
      expires: Date.now() + TTL,
    };
    // A full-document restore requires a known destination in this tab and origin.
    if (target) {
      try {
        this.doc.defaultView?.sessionStorage.setItem(KEY, JSON.stringify(this.intent));
      } catch {
        /* optional UI storage */
      }
    }
  }

  restore(): boolean {
    try {
      const storage = this.doc.defaultView?.sessionStorage;
      const raw = storage?.getItem(KEY);
      storage?.removeItem(KEY);
      if (!raw) return false;
      const value = JSON.parse(raw) as Intent;
      const type = (
        this.doc.defaultView?.performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined
      )?.type;
      if (
        type !== 'navigate' ||
        typeof value.target !== 'string' ||
        value.target !== routeOf(this.doc) ||
        !value.target.startsWith('bilibili:') ||
        typeof value.source !== 'string' ||
        value.target === value.source ||
        !Number.isFinite(value.expires) ||
        value.expires <= Date.now() ||
        value.expires > Date.now() + TTL
      )
        return false;
      this.intent = value;
      return true;
    } catch {
      return false;
    }
  }

  private matches(): boolean {
    const value = this.intent;
    if (!value) return false;
    const route = routeOf(this.doc);
    if (
      !route.startsWith('bilibili:') ||
      value.expires <= Date.now() ||
      (route !== value.source && value.target && route !== value.target)
    ) {
      this.clear();
      return false;
    }
    if (route !== value.source && !value.target) value.target = route;
    return true;
  }

  active(): boolean {
    return this.matches() && this.userMode == null;
  }

  dismiss(mode: 'launcher' | 'hidden'): void {
    if (!this.matches()) return;
    this.userMode = mode;
    try {
      this.doc.defaultView?.sessionStorage.removeItem(KEY);
    } catch {
      /* optional UI storage */
    }
  }

  manualMode(): 'launcher' | 'hidden' | undefined {
    return this.matches() ? this.userMode : undefined;
  }

  arrived(): boolean {
    return this.active() && routeOf(this.doc) !== this.intent!.source;
  }

  clear(): void {
    this.intent = undefined;
    this.userMode = undefined;
    try {
      this.doc.defaultView?.sessionStorage.removeItem(KEY);
    } catch {
      /* optional UI storage */
    }
  }
}
