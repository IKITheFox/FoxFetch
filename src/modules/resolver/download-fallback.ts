import type { DownloadRecord } from '../../shared/types';

const FALLBACK_CONTEXTS_KEY = 'foxfetch:mse-download-fallbacks';
const FALLBACK_CONTEXT_TTL_MS = 30 * 60_000;
const MAX_FALLBACK_CONTEXTS = 64;

export interface MseDownloadFallbackContext {
  chromeDownloadId: number;
  tabId: number;
  assetId: string;
  createdAt: number;
  expiresAt: number;
}

let mutationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isContext(value: unknown): value is MseDownloadFallbackContext {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MseDownloadFallbackContext>;
  return (
    Number.isInteger(candidate.chromeDownloadId) &&
    Number(candidate.chromeDownloadId) >= 0 &&
    Number.isInteger(candidate.tabId) &&
    Number(candidate.tabId) >= 0 &&
    typeof candidate.assetId === 'string' &&
    candidate.assetId.length > 0 &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

async function readContexts(now: number): Promise<MseDownloadFallbackContext[]> {
  const stored = (await chrome.storage.session.get(FALLBACK_CONTEXTS_KEY))[FALLBACK_CONTEXTS_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter(isContext).filter((context) => context.expiresAt > now);
}

async function writeContexts(contexts: readonly MseDownloadFallbackContext[]): Promise<void> {
  await chrome.storage.session.set({
    [FALLBACK_CONTEXTS_KEY]: contexts
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_FALLBACK_CONTEXTS),
  });
}

export async function rememberMseDownloadFallbacks(
  tabId: number,
  records: readonly DownloadRecord[],
  now = Date.now(),
): Promise<void> {
  const incoming = records.flatMap((record): MseDownloadFallbackContext[] =>
    record.chromeDownloadId == null
      ? []
      : [
          {
            chromeDownloadId: record.chromeDownloadId,
            tabId,
            assetId: record.assetId,
            createdAt: now,
            expiresAt: now + FALLBACK_CONTEXT_TTL_MS,
          },
        ],
  );
  if (incoming.length === 0) return;

  await serialize(async () => {
    const current = await readContexts(now);
    const byDownloadId = new Map(
      [...current, ...incoming].map((context) => [context.chromeDownloadId, context]),
    );
    await writeContexts([...byDownloadId.values()]);
  });
}

export function takeMseDownloadFallback(
  chromeDownloadId: number,
  now = Date.now(),
): Promise<MseDownloadFallbackContext | undefined> {
  return serialize(async () => {
    const current = await readContexts(now);
    const found = current.find((context) => context.chromeDownloadId === chromeDownloadId);
    if (found) {
      await writeContexts(
        current.filter((context) => context.chromeDownloadId !== chromeDownloadId),
      );
    } else {
      await writeContexts(current);
    }
    return found;
  });
}

export async function clearMseDownloadFallbacksForTab(
  tabId: number,
  now = Date.now(),
): Promise<void> {
  await serialize(async () => {
    const current = await readContexts(now);
    await writeContexts(current.filter((context) => context.tabId !== tabId));
  });
}

export function shouldStartMseCacheFallback(error?: string): boolean {
  const normalized = error?.trim().toUpperCase() ?? '';
  return (
    !normalized.includes('USER_') && !normalized.includes('FILE_') && !normalized.includes('CRASH')
  );
}
