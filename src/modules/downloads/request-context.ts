import type { MediaAsset } from '../../shared/types';

const DOWNLOAD_RULE_ID_START = 1_900_000_000;
const MERGE_RULE_ID_START = DOWNLOAD_RULE_ID_START + 10_000;
const RULE_ID_LIMIT = MERGE_RULE_ID_START + 10_000;
const MAX_REGEX_LENGTH = 2_000;

let ruleMutationTail: Promise<void> = Promise.resolve();

function serializeRuleMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = ruleMutationTail.then(operation, operation);
  ruleMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reproduce the useful part of the browser's strict-origin-when-cross-origin
 * referrer policy without leaking a page path or query to a third-party CDN.
 */
export function mediaRequestReferrer(mediaUrl: string, pageUrl: string): string | undefined {
  const media = parseHttpUrl(mediaUrl);
  const page = parseHttpUrl(pageUrl);
  if (!media || !page) return undefined;
  if (page.protocol === 'https:' && media.protocol === 'http:') return undefined;

  page.username = '';
  page.password = '';
  page.hash = '';
  return page.origin === media.origin ? page.href : `${page.origin}/`;
}

function capturedRequestReferrer(value?: string): string | undefined {
  const referrer = parseHttpUrl(value ?? '');
  if (!referrer) return undefined;
  referrer.username = '';
  referrer.password = '';
  referrer.hash = '';
  return referrer.href;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mediaRequestRegexFilter(media: URL): string | undefined {
  const exactFilter = `^${escapeRegexLiteral(media.href)}$`;
  if (exactFilter.length <= MAX_REGEX_LENGTH) return exactFilter;

  // Signed CDN URLs can exceed Chrome's regex limit because of their query.
  // Keep the fallback constrained to the exact scheme, host (and port), and
  // path. Only the query string may vary; this must never become a host-wide
  // rule.
  const exactOriginAndPath = `${media.protocol}//${media.host}${media.pathname}`;
  const pathFilter = `^${escapeRegexLiteral(exactOriginAndPath)}(\\?.*)?$`;
  return pathFilter.length <= MAX_REGEX_LENGTH ? pathFilter : undefined;
}

export function createMediaRequestRule(
  asset: Pick<MediaAsset, 'url' | 'pageUrl' | 'requestHeaders'>,
  id: number,
): chrome.declarativeNetRequest.Rule | undefined {
  const media = parseHttpUrl(asset.url);
  const fallbackReferrer = mediaRequestReferrer(asset.url, asset.pageUrl);
  const captured = asset.requestHeaders;
  const capturedReferrer = capturedRequestReferrer(captured?.referer);
  const referrer = capturedReferrer ?? fallbackReferrer;
  if (!media) return undefined;

  const regexFilter = mediaRequestRegexFilter(media);
  if (!regexFilter) return undefined;

  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  if (referrer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referrer });
  const origin = parseHttpUrl(captured?.origin ?? '')?.origin;
  if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
  if (
    captured?.authorization &&
    captured.authorization.length <= 16_384 &&
    !/[\r\n]/u.test(captured.authorization)
  ) {
    requestHeaders.push({
      header: 'Authorization',
      operation: 'set',
      value: captured.authorization,
    });
  }
  if (captured?.accept && captured.accept.length <= 16_384 && !/[\r\n]/u.test(captured.accept)) {
    requestHeaders.push({ header: 'Accept', operation: 'set', value: captured.accept });
  }
  if (requestHeaders.length === 0) return undefined;

  return {
    id,
    priority: 10_000,
    action: {
      type: 'modifyHeaders',
      requestHeaders,
    },
    condition: {
      regexFilter,
      isUrlFilterCaseSensitive: true,
      resourceTypes: ['other', 'media', 'xmlhttprequest'],
    },
  };
}

export function mediaRequestContextRequired(
  asset: Pick<MediaAsset, 'url' | 'pageUrl' | 'requestHeaders'>,
): boolean {
  return createMediaRequestRule(asset, DOWNLOAD_RULE_ID_START) != null;
}

export type MediaRequestContextSource = Pick<MediaAsset, 'url' | 'pageUrl' | 'requestHeaders'>;
export type MediaRequestContextScope = 'download' | 'merge';

function hostPermissionPattern(url: string): string | undefined {
  const parsed = parseHttpUrl(url);
  return parsed ? `${parsed.protocol}//${parsed.hostname}/*` : undefined;
}

function nextAvailableRuleId(
  rules: readonly chrome.declarativeNetRequest.Rule[],
  scope: MediaRequestContextScope,
): number | undefined {
  const used = new Set(rules.map((rule) => rule.id));
  const start = scope === 'merge' ? MERGE_RULE_ID_START : DOWNLOAD_RULE_ID_START;
  const limit = start + 10_000;
  for (let id = start; id < limit; id += 1) {
    if (!used.has(id)) return id;
  }
  return undefined;
}

/**
 * Install an exact, session-scoped Referer rule for downloads protected against
 * hotlinking. Cookies remain browser-managed by chrome.downloads and are never
 * copied into extension storage.
 */
export async function installMediaRequestContext(
  asset: MediaRequestContextSource,
  scope: MediaRequestContextScope = 'download',
): Promise<number | undefined> {
  const origin = hostPermissionPattern(asset.url);
  if (!origin || !chrome.declarativeNetRequest) return undefined;

  const hasHostAccess = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
  if (!hasHostAccess) return undefined;

  return serializeRuleMutation(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const id = nextAvailableRuleId(rules, scope);
    if (id == null) return undefined;
    const rule = createMediaRequestRule(asset, id);
    if (!rule) return undefined;
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    return id;
  });
}

export async function releaseMediaRequestContext(ruleId?: number): Promise<void> {
  if (
    ruleId == null ||
    ruleId < DOWNLOAD_RULE_ID_START ||
    ruleId >= RULE_ID_LIMIT ||
    !chrome.declarativeNetRequest
  ) {
    return;
  }
  await serializeRuleMutation(() =>
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }),
  );
}

export async function releaseMediaRequestContexts(ruleIds: readonly number[]): Promise<void> {
  const removable = [
    ...new Set(
      ruleIds.filter(
        (id) => Number.isInteger(id) && id >= DOWNLOAD_RULE_ID_START && id < RULE_ID_LIMIT,
      ),
    ),
  ];
  if (removable.length === 0 || !chrome.declarativeNetRequest) return;
  await serializeRuleMutation(() =>
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removable }),
  );
}

export async function cleanupMediaRequestContexts(activeRuleIds: readonly number[]): Promise<void> {
  if (!chrome.declarativeNetRequest) return;
  await serializeRuleMutation(async () => {
    const active = new Set(activeRuleIds);
    const removable = (await chrome.declarativeNetRequest.getSessionRules())
      .map((rule) => rule.id)
      .filter((id) => id >= DOWNLOAD_RULE_ID_START && id < RULE_ID_LIMIT && !active.has(id));
    if (removable.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removable });
    }
  });
}
