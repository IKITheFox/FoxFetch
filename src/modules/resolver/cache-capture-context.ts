/**
 * Resolve the page URL for a cache-capture request.
 *
 * A request sent by the in-page media agent has `sender.tab`; its sender URL is
 * the actual frame URL. Extension UIs such as popup.html do not have
 * `sender.tab`, and their `sender.url` must never be mistaken for the target
 * webpage.
 */
export function resolveCacheCapturePageUrl(
  tabUrl: string | undefined,
  senderUrl: string | undefined,
  sentByPageAgent: boolean,
): string | undefined {
  return sentByPageAgent ? (senderUrl ?? tabUrl) : tabUrl;
}
