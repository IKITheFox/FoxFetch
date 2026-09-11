import type { YouTubeCandidate } from '../inspection';
import type { YouTubeSelectionPlan } from '../selection';

/** Private and short-lived. Never persist or attach to a public task snapshot. */
export interface YouTubeDirectSession {
  kind: 'direct-file';
  videoId: string;
  candidateId: string;
  address: string;
  duration: number;
  expectedBytes?: number;
}
export type YouTubeDirectSessionResult =
  | { ok: true; session: YouTubeDirectSession }
  | {
      ok: false;
      error:
        'PAGE_IDENTITY_CHANGED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_NOT_ALLOWED' | 'SELECTION_CHANGED';
    };

/** Self-contained for MAIN-world serialization. Reads only the current player's
 * explicit format URL; never solves a cipher, guesses a language or alters playback.
 */
export function extractYouTubeDirectSession(
  videoId: string,
  selected: YouTubeCandidate,
): YouTubeDirectSessionResult {
  type Obj = Record<string, unknown>;
  const fail = (
    error: Extract<YouTubeDirectSessionResult, { ok: false }>['error'],
  ): YouTubeDirectSessionResult => ({ ok: false, error });
  const object = (v: unknown): Obj | undefined =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
  const text = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max && !/[\p{Cc}]/u.test(v)
      ? v
      : undefined;
  const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    if ((typeof v !== 'string' && typeof v !== 'number') || !String(v).trim()) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
  };
  try {
    const page = new URL(location.href);
    if (
      !/^[\w-]{11}$/u.test(videoId) ||
      page.protocol !== 'https:' ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(page.hostname) ||
      page.pathname !== '/watch' ||
      page.searchParams.get('v') !== videoId
    )
      return fail('PAGE_IDENTITY_CHANGED');
    if (
      selected.kind !== 'video' ||
      selected.composition !== 'muxed' ||
      selected.source !== 'direct-candidate' ||
      selected.dynamicRange !== 'unknown'
    )
      return fail('SOURCE_NOT_ALLOWED');
    const player = document.getElementById('movie_player') as
      (HTMLElement & { getPlayerResponse?: () => unknown; getVideoData?: () => unknown }) | null;
    if (
      !player ||
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    )
      return fail('SOURCE_UNAVAILABLE');
    const response = object(player.getPlayerResponse?.());
    const details = object(response?.videoDetails);
    const actualId = object(player.getVideoData?.())?.video_id;
    if (details?.videoId !== videoId || (actualId && actualId !== videoId))
      return fail('PAGE_IDENTITY_CHANGED');
    if (object(response?.playabilityStatus)?.status !== 'OK' || details.isLive === true)
      return fail('SOURCE_UNAVAILABLE');
    const formats = object(response?.streamingData)?.formats;
    if (!Array.isArray(formats) || formats.length > 200) return fail('SOURCE_UNAVAILABLE');
    let match: YouTubeDirectSession | undefined;
    for (const item of formats) {
      const format = object(item);
      if (!format) continue;
      const itag = number(format.itag, 1_000_000);
      if (!Number.isInteger(itag)) continue;
      const audio = object(format.audioTrack);
      const audioId = text(audio?.id, 64);
      const rawVersion = text(format.lastModified, 32);
      const version = rawVersion && /^\d+$/u.test(rawVersion) ? rawVersion : undefined;
      const tags = text(format.xtags, 256);
      const id = `${itag}:${audioId ?? ''}:muxed${version || tags ? `:${version ?? ''}:${encodeURIComponent(tags ?? '')}` : ''}`;
      if (id !== selected.id) continue;
      if (match) return fail('SELECTION_CHANGED');
      if (
        format.drmFamilies ||
        format.drmInfos ||
        format.drmTrackType ||
        format.signatureCipher ||
        format.cipher
      )
        return fail('SOURCE_NOT_ALLOWED');
      const transfer = object(format.colorInfo)?.transferCharacteristics;
      if (transfer === 'SMPTEST2084' || transfer === 'ARIB_STD_B67')
        return fail('SOURCE_NOT_ALLOWED');
      const languageCode = text(audio?.languageCode ?? format.languageCode, 64);
      let language: string | undefined;
      if (languageCode) {
        try {
          language = Intl.getCanonicalLocales(languageCode)[0];
        } catch {
          /* unknown stays unknown */
        }
      }
      const duration = number(Number(format.approxDurationMs) / 1000, 31_536_000);
      const size = number(format.contentLength);
      if (
        text(format.mimeType, 160) !== selected.mime ||
        number(format.width, 32768) !== selected.width ||
        number(format.height, 32768) !== selected.height ||
        number(format.fps, 1000) !== selected.fps ||
        language !== selected.language ||
        duration !== selected.duration ||
        size !== selected.size ||
        audioId !== selected.audioTrackId ||
        version !== selected.sourceVersion ||
        tags !== selected.sourceTags
      )
        return fail('SELECTION_CHANGED');
      const address = text(format.url, 32768);
      if (!address) return fail('SOURCE_UNAVAILABLE');
      const url = new URL(address);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) ||
        url.pathname !== '/videoplayback'
      )
        return fail('SOURCE_NOT_ALLOWED');
      const expectedDuration = duration ?? number(details.lengthSeconds, 31_536_000);
      if (!expectedDuration || (size !== undefined && !Number.isSafeInteger(size)))
        return fail('SOURCE_UNAVAILABLE');
      match = {
        kind: 'direct-file',
        videoId,
        candidateId: id,
        address,
        duration: expectedDuration,
        ...(size === undefined ? {} : { expectedBytes: size }),
      };
    }
    return match ? { ok: true, session: match } : fail('SELECTION_CHANGED');
  } catch {
    return fail('SOURCE_UNAVAILABLE');
  }
}

/** Read only the bound top-level document; discard reads after navigation or cancellation. */
export async function resolveYouTubeDirectSession(
  plan: YouTubeSelectionPlan,
  owner: { tabId: number; documentId: string },
  options: {
    signal: AbortSignal;
    assertCurrent: () => Promise<void>;
    execute?: (
      injection: chrome.scripting.ScriptInjection<
        [string, YouTubeCandidate],
        YouTubeDirectSessionResult
      >,
    ) => Promise<chrome.scripting.InjectionResult<YouTubeDirectSessionResult>[]>;
  },
): Promise<YouTubeDirectSession> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(owner.tabId) || owner.tabId < 0 || !owner.documentId)
    throw new Error('PAGE_IDENTITY_CHANGED');
  if (plan.video.composition !== 'muxed' || plan.video.source !== 'direct-candidate')
    throw new Error('SOURCE_NOT_ALLOWED');
  await options.assertCurrent();
  options.signal.throwIfAborted();
  const execute = options.execute ?? ((injection) => chrome.scripting.executeScript(injection));
  const results = await new Promise<chrome.scripting.InjectionResult<YouTubeDirectSessionResult>[]>(
    (resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error('DOWNLOAD_CANCELED'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('SOURCE_READ_TIMEOUT'));
      }, 5000);
      options.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          options.signal.throwIfAborted();
          return execute({
            target: { tabId: owner.tabId, documentIds: [owner.documentId] },
            world: 'MAIN',
            func: extractYouTubeDirectSession,
            args: [plan.videoId, { ...plan.video }],
          });
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          () => {
            cleanup();
            reject(new Error(options.signal.aborted ? 'DOWNLOAD_CANCELED' : 'SOURCE_READ_FAILED'));
          },
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
  if (!result?.ok)
    throw new Error(
      result &&
        [
          'PAGE_IDENTITY_CHANGED',
          'SOURCE_UNAVAILABLE',
          'SOURCE_NOT_ALLOWED',
          'SELECTION_CHANGED',
        ].includes(result.error)
        ? result.error
        : 'SOURCE_UNAVAILABLE',
    );
  if (
    result.session.videoId !== plan.videoId ||
    result.session.candidateId !== plan.video.id ||
    result.session.kind !== 'direct-file'
  )
    throw new Error('SELECTION_CHANGED');
  return result.session;
}
