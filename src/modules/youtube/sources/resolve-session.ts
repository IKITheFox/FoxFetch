import type { YouTubeSelectionPlan } from '../selection';
import {
  extractYouTubePageSession,
  type YouTubePageSessionResult,
  type YouTubePageSession,
} from './page-session';
import { bindYouTubeSabrSelection } from './selection-binding';

/** Background-only source reader. Caller validates the current tab's navigation
 * epoch both before and after the asynchronous MAIN-world read. No storage writes.
 */
export async function resolveYouTubePageSession(
  plan: YouTubeSelectionPlan,
  owner: { tabId: number; documentId: string },
  options: {
    signal: AbortSignal;
    assertCurrent: () => Promise<void>;
    execute?: (
      injection: chrome.scripting.ScriptInjection<[string], YouTubePageSessionResult>,
    ) => Promise<chrome.scripting.InjectionResult<YouTubePageSessionResult>[]>;
  },
): Promise<YouTubePageSession> {
  options.signal.throwIfAborted();
  await options.assertCurrent();
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 || !owner.documentId)
    throw new Error('PAGE_IDENTITY_CHANGED');
  const execute = options.execute ?? ((injection) => chrome.scripting.executeScript(injection));
  const results = await new Promise<chrome.scripting.InjectionResult<YouTubePageSessionResult>[]>(
    (resolve, reject) => {
      // executeScript itself is not abortable. Discard a late read-only result;
      // cancellation/timeout must not wait for an unresponsive page to execute.
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
      };
      const fail = (code: string) => {
        cleanup();
        reject(new Error(code));
      };
      const abort = () => fail('DOWNLOAD_CANCELED');
      const timer = setTimeout(() => fail('SOURCE_READ_TIMEOUT'), 5000);
      options.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          options.signal.throwIfAborted();
          return execute({
            target: { tabId: owner.tabId, documentIds: [owner.documentId] },
            world: 'MAIN',
            func: extractYouTubePageSession,
            args: [plan.videoId],
          });
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          () => fail(options.signal.aborted ? 'DOWNLOAD_CANCELED' : 'SOURCE_READ_FAILED'),
        );
    },
  );
  options.signal.throwIfAborted();
  await options.assertCurrent();
  options.signal.throwIfAborted();
  if (
    results.length !== 1 ||
    results[0]?.frameId !== 0 ||
    results[0].documentId !== owner.documentId
  )
    throw new Error('PAGE_IDENTITY_CHANGED');
  const result = results[0].result;
  if (!result || !result.ok)
    throw new Error(
      result?.error === 'PAGE_IDENTITY_CHANGED' || result?.error === 'SOURCE_NOT_ALLOWED'
        ? result.error
        : 'SOURCE_UNAVAILABLE',
    );
  if (result.videoId !== plan.videoId) throw new Error('PAGE_IDENTITY_CHANGED');
  // Exact source version, itag, tags, language, dimensions and fps must still match.
  bindYouTubeSabrSelection(plan, result.videoId, result.session.formats);
  return result.session;
}
