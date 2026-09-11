import type { MediaDockProductDownloadMode } from '../../shared/types';
import type { MediaProduct } from './media-products';

export const MEDIA_DOCK_TOKEN_TTL_MS = 90_000;
const MAX_GRANTS_PER_TAB = 64;
const STORAGE_PREFIX = 'foxfetch:media-dock-grant:';

export interface MediaDockProductGrantInput {
  tabId: number;
  pageUrl: string;
  mediaEpoch: number;
  mediaIdentity: string;
  snapshotRevision: string;
  productId: string;
  /** Metadata-only quality binding kept inside extension storage. */
  qualityId?: string;
  allowedModes: readonly MediaDockProductDownloadMode[];
  /** Modes whose selected output needs optional cross-origin media access. */
  permissionModes: readonly MediaDockProductDownloadMode[];
}

export interface MediaDockProductGrant extends MediaDockProductGrantInput {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MediaDockProductGrantRequest {
  tabId: number;
  pageUrl: string;
  mediaEpoch: number;
  mediaIdentity: string;
  snapshotRevision: string;
  mode: MediaDockProductDownloadMode;
}

export type MediaDockProductGrantContext = Pick<
  MediaDockProductGrantInput,
  'tabId' | 'pageUrl' | 'mediaEpoch' | 'mediaIdentity' | 'snapshotRevision'
>;

export type MediaDockProductPermissionRequest = Pick<
  MediaDockProductGrantRequest,
  'tabId' | 'pageUrl' | 'mode'
>;

export interface MediaDockGrantStorage {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface MediaDockPermissionMessageLike {
  type?: unknown;
  token?: unknown;
  qualityToken?: unknown;
  mode?: unknown;
}

export interface MediaDockPermissionSenderLike {
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
}

function storageKey(token: string): string {
  return `${STORAGE_PREFIX}${token}`;
}

function isDownloadMode(value: unknown): value is MediaDockProductDownloadMode {
  return value === 'audio' || value === 'video' || value === 'complete';
}

/**
 * Every downloadable network output needs source-host access. Besides merge
 * fetches, direct video/audio downloads may need an authenticated Referer rule;
 * skipping the gate can save a CDN error document instead of the media file.
 */
export function mediaDockPermissionModesForProduct(
  product: Pick<MediaProduct, 'defaultSelection'>,
): MediaDockProductDownloadMode[] {
  const modes: MediaDockProductDownloadMode[] = [];
  if (product.defaultSelection.complete) modes.push('complete');
  if (product.defaultSelection.videoTrackId) modes.push('video');
  if (product.defaultSelection.audioTrackId) modes.push('audio');
  return modes;
}

function sameContext(
  left: MediaDockProductGrantContext,
  right: MediaDockProductGrantContext,
): boolean {
  return (
    left.tabId === right.tabId &&
    left.pageUrl === right.pageUrl &&
    left.mediaEpoch === right.mediaEpoch &&
    left.mediaIdentity === right.mediaIdentity &&
    left.snapshotRevision === right.snapshotRevision
  );
}

function isGrant(value: unknown): value is MediaDockProductGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<MediaDockProductGrant>;
  return (
    typeof grant.token === 'string' &&
    Number.isInteger(grant.tabId) &&
    typeof grant.pageUrl === 'string' &&
    typeof grant.mediaEpoch === 'number' &&
    typeof grant.mediaIdentity === 'string' &&
    typeof grant.snapshotRevision === 'string' &&
    typeof grant.productId === 'string' &&
    (grant.qualityId == null || typeof grant.qualityId === 'string') &&
    Array.isArray(grant.allowedModes) &&
    grant.allowedModes.every(isDownloadMode) &&
    Array.isArray(grant.permissionModes) &&
    grant.permissionModes.every(isDownloadMode) &&
    typeof grant.issuedAt === 'number' &&
    typeof grant.expiresAt === 'number'
  );
}

/**
 * Issues one-shot capabilities for privileged product actions initiated by the
 * open Shadow DOM Dock. The web page never receives an asset id, URL or header.
 */
export class MediaDockProductGrantBroker {
  private readonly consumingTokens = new Set<string>();
  private readonly activeContexts = new Map<number, MediaDockProductGrantContext>();
  private readonly issuedGrants = new Map<string, MediaDockProductGrant>();
  private readonly permissionClaims = new Set<string>();

  constructor(
    private readonly storage: MediaDockGrantStorage = chrome.storage.session,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => crypto.randomUUID(),
  ) {}

  async issue(input: MediaDockProductGrantInput): Promise<string> {
    this.activateContext(input);
    await this.pruneAndEnforceLimit(input.tabId);
    const issuedAt = this.now();
    const token = this.createToken();
    const grant: MediaDockProductGrant = {
      ...input,
      allowedModes: [...new Set(input.allowedModes)],
      permissionModes: [...new Set(input.permissionModes)],
      token,
      issuedAt,
      expiresAt: issuedAt + MEDIA_DOCK_TOKEN_TTL_MS,
    };
    await this.storage.set({ [storageKey(token)]: grant });
    this.issuedGrants.set(token, grant);
    return token;
  }

  /**
   * Mark the media identity that is currently rendered for a tab. This is
   * synchronous so a later click can be checked before calling
   * chrome.permissions.request(), which must retain the original user gesture.
   */
  activateContext(context: MediaDockProductGrantContext): void {
    const next = { ...context };
    const previous = this.activeContexts.get(context.tabId);
    this.activeContexts.set(context.tabId, next);
    if (!previous || sameContext(previous, next)) return;
    for (const [token, grant] of this.issuedGrants) {
      if (grant.tabId === context.tabId) {
        this.issuedGrants.delete(token);
        this.permissionClaims.delete(token);
      }
    }
  }

  /**
   * Atomically authorize a synchronous optional-permission prompt for a token
   * issued by this live Service Worker. Stale-context, unsupported-mode, and
   * replayed live tokens fail closed. Persisted grants are checked by consume().
   */
  claimPermissionRequest(token: string, request: MediaDockProductPermissionRequest): boolean {
    const grant = this.issuedGrants.get(token);
    const context = grant ? this.activeContexts.get(grant.tabId) : undefined;
    if (
      !grant ||
      !context ||
      grant.expiresAt <= this.now() ||
      this.permissionClaims.has(token) ||
      !sameContext(grant, context) ||
      grant.tabId !== request.tabId ||
      grant.pageUrl !== request.pageUrl ||
      !grant.allowedModes.includes(request.mode) ||
      !grant.permissionModes.includes(request.mode)
    ) {
      if (grant?.expiresAt != null && grant.expiresAt <= this.now()) {
        this.issuedGrants.delete(token);
        this.permissionClaims.delete(token);
      }
      return false;
    }
    this.permissionClaims.add(token);
    return true;
  }

  async consume(
    token: string,
    request: MediaDockProductGrantRequest,
  ): Promise<MediaDockProductGrant> {
    if (this.consumingTokens.has(token)) throw new Error('资源操作正在处理中，请勿重复点击');
    this.consumingTokens.add(token);
    try {
      const key = storageKey(token);
      const grantValue = (await this.storage.get(key))[key];
      const grant = isGrant(grantValue) ? grantValue : undefined;
      await this.storage.remove(key);
      this.issuedGrants.delete(token);
      this.permissionClaims.delete(token);
      if (!grant || grant.expiresAt <= this.now()) {
        throw new Error('资源操作已过期，请刷新常规下载列表');
      }
      if (
        grant.tabId !== request.tabId ||
        grant.pageUrl !== request.pageUrl ||
        grant.mediaEpoch !== request.mediaEpoch ||
        grant.mediaIdentity !== request.mediaIdentity ||
        grant.snapshotRevision !== request.snapshotRevision
      ) {
        throw new Error('页面或播放器已变化，请刷新常规下载列表');
      }
      if (!grant.allowedModes.includes(request.mode)) {
        throw new Error('当前成品不支持所选下载内容');
      }
      return {
        ...grant,
        allowedModes: [...grant.allowedModes],
        permissionModes: [...grant.permissionModes],
      };
    } finally {
      this.consumingTokens.delete(token);
    }
  }

  async clearTab(tabId: number): Promise<void> {
    this.activeContexts.delete(tabId);
    for (const [token, grant] of this.issuedGrants) {
      if (grant.tabId === tabId) {
        this.issuedGrants.delete(token);
        this.permissionClaims.delete(token);
      }
    }
    const records = await this.readAll();
    const keys = records.filter(([, grant]) => grant.tabId === tabId).map(([key]) => key);
    if (keys.length > 0) await this.storage.remove(keys);
  }

  private async readAll(): Promise<Array<[string, MediaDockProductGrant]>> {
    const values = await this.storage.get(null);
    return Object.entries(values).flatMap(([key, value]) =>
      key.startsWith(STORAGE_PREFIX) && isGrant(value) ? [[key, value]] : [],
    );
  }

  private async pruneAndEnforceLimit(tabId: number): Promise<void> {
    const currentTime = this.now();
    const records = await this.readAll();
    const expired = records
      .filter(([, grant]) => grant.expiresAt <= currentTime)
      .map(([key]) => key);
    const candidates = records
      .filter(([, grant]) => grant.expiresAt > currentTime && grant.tabId === tabId)
      .sort(([, left], [, right]) => left.issuedAt - right.issuedAt);
    const excess = candidates
      .slice(0, Math.max(0, candidates.length - MAX_GRANTS_PER_TAB + 1))
      .map(([key]) => key);
    const removals = [...new Set([...expired, ...excess])];
    if (removals.length > 0) {
      for (const key of removals) {
        const token = key.slice(STORAGE_PREFIX.length);
        this.issuedGrants.delete(token);
        this.permissionClaims.delete(token);
      }
      await this.storage.remove(removals);
    }
  }
}

/** Validate a product download click before synchronously opening Chrome's prompt. */
export function claimMediaDockPermissionFromMessage(
  message: unknown,
  sender: MediaDockPermissionSenderLike,
  broker: Pick<MediaDockProductGrantBroker, 'claimPermissionRequest'>,
): boolean {
  const request =
    message != null && typeof message === 'object'
      ? (message as MediaDockPermissionMessageLike)
      : undefined;
  const tabId = sender.tab?.id;
  // A top-frame MessageSender.url can retain the initially committed document
  // URL across an SPA route. tabs.Tab.url is authoritative for the current
  // top-frame route and matches the state used during eventual consumption.
  const pageUrl = sender.tab?.url ?? sender.url;
  const selectedToken =
    typeof request?.qualityToken === 'string' ? request.qualityToken : request?.token;
  if (
    request?.type !== 'DOWNLOAD_MEDIA_DOCK_PRODUCT' ||
    typeof selectedToken !== 'string' ||
    !isDownloadMode(request.mode) ||
    typeof tabId !== 'number' ||
    !Number.isInteger(tabId) ||
    (sender.frameId ?? 0) !== 0 ||
    typeof pageUrl !== 'string' ||
    pageUrl.length === 0
  ) {
    return false;
  }
  const claimed = broker.claimPermissionRequest(selectedToken, {
    tabId,
    pageUrl,
    mode: request.mode,
  });
  if (claimed) return true;

  // MV3 may stop the worker after the sanitized product snapshot was issued.
  // The opaque grant remains in storage.session, but its synchronous in-memory
  // index does not. A production grant is a UUID; allow the extension-owned
  // top-frame content script to start the user-gesture-bound prompt, then let
  // consume() perform the authoritative asynchronous storage/context check.
  // Invalid/stale grants can at most produce a browser-controlled prompt and
  // can never reach a download side effect.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    selectedToken,
  );
}

/** Wait for the first-click permission decision before creating/opening the Dock. */
export async function createMergeDockAfterPermissionSettles<TResult>(
  permissionRequest: Promise<boolean> | undefined,
  createDock: () => Promise<TResult>,
): Promise<TResult> {
  await permissionRequest?.catch(() => false);
  return createDock();
}
