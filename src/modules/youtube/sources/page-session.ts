import type { SabrAcquisitionRequest } from './sabr';
import type { SelectedSabrFormat } from './selection-binding';

export type YouTubePageSession = Omit<SabrAcquisitionRequest, 'video' | 'audio' | 'formats'> & {
  formats: SelectedSabrFormat[];
};
export type YouTubePageSessionResult =
  | { ok: true; videoId: string; session: YouTubePageSession }
  | { ok: false; error: 'PAGE_IDENTITY_CHANGED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_NOT_ALLOWED' };

/** Self-contained MAIN-world read, called only for an explicit download attempt.
 * Private return value: never attach this object to a UI snapshot or persistent store.
 * Does not mutate playback, solve signatures, fetch media, or invent a session token.
 */
export function extractYouTubePageSession(expectedVideoId: string): YouTubePageSessionResult {
  type Obj = Record<string, unknown>;
  const fail = (
    error: Extract<YouTubePageSessionResult, { ok: false }>['error'],
  ): YouTubePageSessionResult => ({ ok: false, error });
  const object = (value: unknown): Obj | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined;
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value)
      ? value
      : undefined;
  const number = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
      return undefined;
    const result = Number(value);
    return Number.isFinite(result) && result > 0 && result <= max ? result : undefined;
  };
  try {
    const page = new URL(location.href);
    if (
      !/^[\w-]{11}$/u.test(expectedVideoId) ||
      page.protocol !== 'https:' ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(page.hostname) ||
      page.pathname !== '/watch' ||
      page.searchParams.get('v') !== expectedVideoId
    )
      return fail('PAGE_IDENTITY_CHANGED');
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
    const playerId = object(player.getVideoData?.())?.video_id;
    if (
      !response ||
      details?.videoId !== expectedVideoId ||
      (playerId && playerId !== expectedVideoId)
    )
      return fail('PAGE_IDENTITY_CHANGED');
    if (object(response.playabilityStatus)?.status !== 'OK' || details.isLive === true)
      return fail('SOURCE_UNAVAILABLE');
    const streaming = object(response.streamingData);
    const address = text(streaming?.serverAbrStreamingUrl, 32768);
    if (!address) return fail('SOURCE_UNAVAILABLE');
    const endpoint = new URL(address);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      !endpoint.hostname.endsWith('.googlevideo.com') ||
      endpoint.pathname !== '/videoplayback'
    )
      return fail('SOURCE_NOT_ALLOWED');
    const config = text(
      object(object(object(response.playerConfig)?.mediaCommonConfig)?.mediaUstreamerRequestConfig)
        ?.videoPlaybackUstreamerConfig,
      100_000,
    );
    const ytcfg = (window as Window & { ytcfg?: { get?: (key: string) => unknown } }).ytcfg;
    const context = object(ytcfg?.get?.('INNERTUBE_CONTEXT'));
    const client = object(context?.client);
    const clientName = number(ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_NAME'), 10000);
    const clientVersion = text(client?.clientVersion, 128);
    const duration = number(details.lengthSeconds, 31_536_000);
    if (
      !config ||
      !clientName ||
      !Number.isInteger(clientName) ||
      !clientVersion ||
      !duration ||
      !Array.isArray(streaming?.adaptiveFormats) ||
      streaming.adaptiveFormats.length > 200
    )
      return fail('SOURCE_UNAVAILABLE');
    const formats: SelectedSabrFormat[] = [];
    for (const raw of streaming.adaptiveFormats) {
      const f = object(raw);
      if (!f || f.drmFamilies || f.drmTrackType || f.drmInfos) continue;
      const itag = number(f.itag, 1_000_000),
        version = text(f.lastModified, 32);
      const mime = text(f.mimeType, 160),
        bitrate = number(f.bitrate),
        durationMs = number(f.approxDurationMs, 31_536_000_000);
      if (
        !itag ||
        !Number.isInteger(itag) ||
        !version ||
        !/^\d+$/u.test(version) ||
        !mime ||
        !/^(video|audio)\/(mp4|webm);\s*codecs="[\w., -]+"$/u.test(mime) ||
        !bitrate ||
        !durationMs
      )
        continue;
      const format: SelectedSabrFormat = {
        itag,
        lastModified: version,
        mimeType: mime,
        bitrate,
        approxDurationMs: durationMs,
      };
      for (const [key, value, max] of [
        ['width', f.width, 32768],
        ['height', f.height, 32768],
        ['fps', f.fps, 1000],
        ['contentLength', f.contentLength, Number.MAX_SAFE_INTEGER],
      ] as const) {
        const n = number(value, max);
        if (n !== undefined) format[key] = n;
      }
      const track = object(f.audioTrack),
        trackId = text(track?.id, 64),
        tags = text(f.xtags, 256);
      if (trackId) format.audioTrackId = trackId;
      if (tags) format.xtags = tags;
      const language = text(track?.languageCode ?? f.languageCode, 64);
      if (language) {
        try {
          const canonical = Intl.getCanonicalLocales(language)[0];
          if (canonical) format.language = canonical;
        } catch {
          /* unknown remains unknown; track identity is not a language */
        }
      }
      formats.push(format);
    }
    if (!formats.length) return fail('SOURCE_UNAVAILABLE');
    return {
      ok: true,
      videoId: expectedVideoId,
      session: {
        serverAbrStreamingUrl: endpoint.href,
        videoPlaybackUstreamerConfig: config,
        clientInfo: { clientName, clientVersion },
        durationMs: duration * 1000,
        formats,
      },
    };
  } catch {
    // Page getters and malformed URLs must not serialize private exception text.
    return fail('SOURCE_UNAVAILABLE');
  }
}
