import type { YouTubeExecutionRequest } from '../offscreen-executor';

type Session = YouTubeExecutionRequest['session'];

export function youTubeSessionAddress(session: Session): string | undefined {
  const address = 'kind' in session ? session.address : session.serverAbrStreamingUrl;
  return typeof address === 'string' && address ? address : undefined;
}

export function isYouTubeAddressRejection(error: string | undefined): boolean {
  return [
    'SOURCE_ADDRESS_REJECTED',
    'SOURCE_HTTP_401',
    'SOURCE_HTTP_403',
    'SOURCE_HTTP_410',
  ].includes(error ?? '');
}

/** An explicit expiry is only a stale-address hint, never proof of permission
 * or validity. Missing/ambiguous values still require the normal HTTP checks. */
function explicitlyExpired(session: Session, now: number): boolean {
  const address = youTubeSessionAddress(session);
  if (!address) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const values = url.searchParams.getAll('expire');
  if (values.length !== 1 || !/^\d{10}$/u.test(values[0]!)) return false;
  return Number(values[0]) * 1000 <= now;
}

/** Re-read the same immutable plan through the existing current-document and
 * exact-track resolver. Never reload the page or change query/signature values. */
export async function readFreshYouTubeSession(
  resolve: () => Promise<Session>,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<Session> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const session = await resolve();
    signal.throwIfAborted();
    if (!explicitlyExpired(session, now())) return session;
  }
  throw new Error('SOURCE_ADDRESS_EXPIRED');
}
