import { t as uiText } from '../../shared/i18n';
/** YouTube-only, read-only discovery. No signature solver, playback mutation or download grant. */
export interface YouTubeCandidate {
  id: string;
  kind: 'video' | 'audio';
  composition: 'muxed' | 'separate';
  mime: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  size?: number;
  language?: string;
  audioTrackId?: string;
  audioTrackName?: string;
  sourceVersion?: string;
  sourceTags?: string;
  defaultAudio?: boolean;
  dynamicRange: 'HDR-declared' | 'unknown';
  source: 'direct-candidate' | 'signed' | 'drm' | 'unavailable';
}
export interface YouTubeInspection {
  version: 1;
  pageType: 'watch' | 'shorts' | 'live' | 'embed' | 'other';
  videoId?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  status:
    'waiting' | 'identified' | 'advertisement' | 'unplayable' | 'unsupported-page' | 'disabled';
  transports: Array<'direct' | 'signed' | 'sabr' | 'dash' | 'hls' | 'drm'>;
  candidates: YouTubeCandidate[];
  /** A manifest or player response never proves complete-download support. */
  completeDownloadVerified: false;
}

export function isYouTubePage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return (
      url.protocol === 'https:' &&
      ['youtube.com', 'youtube-nocookie.com'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

/** Self-contained so Chrome can serialize it into MAIN. Only explicit fields leave the page. */
export function extractYouTubeInspection(): YouTubeInspection {
  const url = new URL(location.href);
  const allowed = ['youtube.com', 'youtube-nocookie.com'].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  const segment = url.pathname.split('/')[1];
  const pageType: YouTubeInspection['pageType'] =
    allowed && ['watch', 'shorts', 'live', 'embed'].includes(segment ?? '')
      ? (segment as YouTubeInspection['pageType'])
      : 'other';
  const rawId = pageType === 'watch' ? url.searchParams.get('v') : url.pathname.split('/')[2];
  const videoId = rawId && /^[\w-]{11}$/u.test(rawId) ? rawId : undefined;
  const result: YouTubeInspection = {
    version: 1,
    pageType,
    ...(videoId ? { videoId } : {}),
    status: videoId ? 'waiting' : 'unsupported-page',
    transports: [],
    candidates: [],
    completeDownloadVerified: false,
  };
  if (!allowed || url.protocol !== 'https:' || !videoId) return result;
  type RecordValue = Record<string, unknown>;
  const record = (value: unknown): RecordValue | undefined =>
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as RecordValue)
      : undefined;
  const text = (value: unknown, max = 256): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= max
      ? [...value]
          .map((character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character,
          )
          .join('')
          .trim()
      : undefined;
  const num = (value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined =>
    (typeof value === 'string' || typeof value === 'number') &&
    String(value).trim() &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= max
      ? Number(value)
      : undefined;
  const player = document.getElementById('movie_player') as
    (HTMLElement & { getPlayerResponse?: () => unknown; getVideoData?: () => unknown }) | null;
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) {
    result.status = 'advertisement';
    return result;
  }
  let current: RecordValue | undefined;
  let playerId: string | undefined;
  try {
    current = record(player?.getPlayerResponse?.());
    playerId = text(record(player?.getVideoData?.())?.video_id);
  } catch {
    /* optional site API */
  }
  if (playerId && playerId !== videoId) return result;
  const initial = record((window as unknown as RecordValue).ytInitialPlayerResponse);
  // A present current response is authoritative, including a mismatched/stale one.
  // Never fall back to SSR data while the current player is switching videos.
  const response = current ?? initial;
  const details = record(response?.videoDetails);
  if (details?.videoId !== videoId) return result;
  const playability = record(response?.playabilityStatus);
  if (playability?.status !== 'OK') {
    result.status = 'unplayable';
    return result;
  }
  result.status = 'identified';
  const title = text(details.title, 512);
  if (title) result.title = title;
  const duration = num(details.lengthSeconds, 31_536_000);
  if (duration && details.isLive !== true) result.duration = duration;
  if (details.isLive === true) result.pageType = 'live';
  const thumbnails = record(details.thumbnail)?.thumbnails;
  if (Array.isArray(thumbnails)) {
    for (const thumbnail of thumbnails.slice(0, 20).reverse()) {
      try {
        const image = new URL(String(record(thumbnail)?.url ?? ''));
        if (
          image.protocol === 'https:' &&
          !image.username &&
          !image.password &&
          !image.port &&
          (image.hostname === 'i.ytimg.com' || image.hostname === 'i9.ytimg.com') &&
          new RegExp(`^/(?:vi|vi_webp)/${videoId}/[\\w.-]+$`, 'u').test(image.pathname)
        ) {
          image.search = '';
          image.hash = '';
          result.thumbnail = image.href;
          break;
        }
      } catch {
        /* no guessed cover URL */
      }
    }
  }
  if (result.pageType !== 'watch') return result;
  const streaming = record(response?.streamingData);
  if (!streaming) return result;
  const transports = new Set<YouTubeInspection['transports'][number]>();
  if (typeof streaming.serverAbrStreamingUrl === 'string') transports.add('sabr');
  if (typeof streaming.dashManifestUrl === 'string') transports.add('dash');
  if (typeof streaming.hlsManifestUrl === 'string') transports.add('hls');
  const seen = new Set<string>();
  for (const [key, composition] of [
    ['formats', 'muxed'],
    ['adaptiveFormats', 'separate'],
  ] as const) {
    const formats = streaming[key];
    if (!Array.isArray(formats)) continue;
    for (const raw of formats.slice(0, 200)) {
      const format = record(raw);
      if (!format) continue;
      const mime = text(format.mimeType, 160);
      const itag = num(format.itag, 1_000_000);
      if (
        !mime ||
        !/^(video|audio)\/(mp4|webm)(?:;\s*codecs="[\w., -]+")?$/u.test(mime) ||
        !Number.isInteger(itag)
      )
        continue;
      const audioTrack = record(format.audioTrack);
      const audioTrackId = text(audioTrack?.id, 64);
      // Track IDs (for example en.4) are identifiers, not BCP-47 language tags.
      const declaredLanguage = text(audioTrack?.languageCode ?? format.languageCode, 64);
      let language: string | undefined;
      if (declaredLanguage) {
        try {
          language = Intl.getCanonicalLocales(declaredLanguage)[0];
        } catch {
          /* unknown language */
        }
      }
      const rawVersion = text(format.lastModified, 32);
      const sourceVersion = rawVersion && /^\d+$/u.test(rawVersion) ? rawVersion : undefined;
      const sourceTags = text(format.xtags, 256);
      const suffix =
        sourceVersion || sourceTags
          ? `:${sourceVersion ?? ''}:${encodeURIComponent(sourceTags ?? '')}`
          : '';
      const id = `${itag}:${audioTrackId ?? ''}:${composition}${suffix}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let source: YouTubeCandidate['source'] = 'unavailable';
      if (format.drmFamilies || format.drmTrackType || format.drmInfos) {
        source = 'drm';
        transports.add('drm');
      } else if (format.signatureCipher || format.cipher) {
        source = 'signed';
        transports.add('signed');
      } else if (typeof format.url === 'string') {
        try {
          const media = new URL(format.url);
          if (
            media.protocol === 'https:' &&
            !media.username &&
            !media.password &&
            !media.port &&
            (media.hostname === 'googlevideo.com' || media.hostname.endsWith('.googlevideo.com')) &&
            media.pathname === '/videoplayback'
          ) {
            source = 'direct-candidate';
            transports.add('direct');
          }
        } catch {
          /* malformed or unrelated source */
        }
      }
      const candidate: YouTubeCandidate = {
        id,
        kind: mime.startsWith('audio/') ? 'audio' : 'video',
        composition,
        mime,
        source,
        dynamicRange:
          record(format.colorInfo)?.transferCharacteristics === 'SMPTEST2084' ||
          record(format.colorInfo)?.transferCharacteristics === 'ARIB_STD_B67'
            ? 'HDR-declared'
            : 'unknown',
      };
      for (const [field, value, max] of [
        ['width', format.width, 32768],
        ['height', format.height, 32768],
        ['fps', format.fps, 1000],
        ['size', format.contentLength, Number.MAX_SAFE_INTEGER],
        ['duration', Number(format.approxDurationMs) / 1000, 31_536_000],
      ] as const) {
        const n = num(value, max);
        if (n) candidate[field] = n;
      }
      if (language) candidate.language = language;
      if (audioTrackId) candidate.audioTrackId = audioTrackId;
      const audioTrackName = text(audioTrack?.displayName, 128);
      if (audioTrackName) candidate.audioTrackName = audioTrackName;
      if (sourceVersion) candidate.sourceVersion = sourceVersion;
      if (sourceTags) candidate.sourceTags = sourceTags;
      const defaultAudio = record(format.audioTrack)?.audioIsDefault;
      if (typeof defaultAudio === 'boolean') candidate.defaultAudio = defaultAudio;
      result.candidates.push(candidate);
    }
  }
  result.transports = [...transports];
  return result;
}

/** Rebuild the explicit view schema at the extension trust boundary; never retain arbitrary page fields. */
export function validateYouTubeInspection(
  value: unknown,
  pageUrl: string,
): YouTubeInspection | undefined {
  if (!isYouTubePage(pageUrl) || !value || typeof value !== 'object') return undefined;
  const raw = value as YouTubeInspection;
  const url = new URL(pageUrl);
  const expected =
    url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.split('/')[2];
  const expectedId = expected && /^[\w-]{11}$/u.test(expected) ? expected : undefined;
  const segment = url.pathname.split('/')[1];
  const expectedType = ['watch', 'shorts', 'live', 'embed'].includes(segment ?? '')
    ? segment
    : 'other';
  if (raw.pageType !== expectedType && !(expectedType === 'watch' && raw.pageType === 'live'))
    return undefined;
  if (
    raw.version !== 1 ||
    raw.videoId !== expectedId ||
    !['watch', 'shorts', 'live', 'embed', 'other'].includes(raw.pageType) ||
    ![
      'waiting',
      'identified',
      'advertisement',
      'unplayable',
      'unsupported-page',
      'disabled',
    ].includes(raw.status)
  )
    return undefined;
  const result: YouTubeInspection = {
    version: 1,
    pageType: raw.pageType,
    ...(expectedId ? { videoId: expectedId } : {}),
    status: raw.status,
    transports: [],
    candidates: [],
    completeDownloadVerified: false,
  };
  const safeText = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.length <= max &&
    [...v].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
  if (raw.status !== 'identified') return result;
  if (safeText(raw.title, 512)) result.title = raw.title;
  if (
    typeof raw.duration === 'number' &&
    Number.isFinite(raw.duration) &&
    raw.duration > 0 &&
    raw.duration <= 31_536_000
  )
    result.duration = raw.duration;
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.length < 2048) {
    try {
      const image = new URL(raw.thumbnail);
      if (
        image.protocol === 'https:' &&
        !image.username &&
        !image.password &&
        !image.port &&
        ['i.ytimg.com', 'i9.ytimg.com'].includes(image.hostname) &&
        expectedId &&
        new RegExp(`^/(?:vi|vi_webp)/${expectedId}/[\\w.-]+$`, 'u').test(image.pathname)
      ) {
        image.search = '';
        image.hash = '';
        result.thumbnail = image.href;
      }
    } catch {
      /* invalid cover */
    }
  }
  result.transports = Array.isArray(raw.transports)
    ? [
        ...new Set(
          raw.transports.filter((t) =>
            ['direct', 'signed', 'sabr', 'dash', 'hls', 'drm'].includes(t),
          ),
        ),
      ].slice(0, 6)
    : [];
  if (!Array.isArray(raw.candidates) || result.pageType !== 'watch') return result;
  const seen = new Set<string>();
  for (const c of raw.candidates.slice(0, 400)) {
    if (
      !c ||
      !safeText(c.id, 2048) ||
      !/^\d+:[\w.-]*:(muxed|separate)(?::\d*:[\w.!~*'()%+-]*)?$/u.test(c.id) ||
      seen.has(c.id) ||
      !['video', 'audio'].includes(c.kind) ||
      !['muxed', 'separate'].includes(c.composition) ||
      !safeText(c.mime, 160) ||
      !/^(audio|video)\/(mp4|webm)(?:;\s*codecs="[\w., -]+")?$/u.test(c.mime) ||
      !['direct-candidate', 'signed', 'drm', 'unavailable'].includes(c.source)
    )
      continue;
    seen.add(c.id);
    const candidate: YouTubeCandidate = {
      id: c.id,
      kind: c.kind,
      composition: c.composition,
      mime: c.mime,
      source: c.source,
      dynamicRange: c.dynamicRange === 'HDR-declared' ? 'HDR-declared' : 'unknown',
    };
    for (const [key, max] of [
      ['width', 32768],
      ['height', 32768],
      ['fps', 1000],
      ['size', Number.MAX_SAFE_INTEGER],
      ['duration', 31_536_000],
    ] as const) {
      const n = c[key];
      if (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max) candidate[key] = n;
    }
    if (safeText(c.language, 64)) {
      try {
        const language = Intl.getCanonicalLocales(c.language)[0];
        if (language) candidate.language = language;
      } catch {
        /* unknown language */
      }
    }
    if (safeText(c.audioTrackId, 64) && /^[\w.-]+$/u.test(c.audioTrackId))
      candidate.audioTrackId = c.audioTrackId;
    if (safeText(c.audioTrackName, 128)) candidate.audioTrackName = c.audioTrackName;
    if (safeText(c.sourceVersion, 32) && /^\d+$/u.test(c.sourceVersion))
      candidate.sourceVersion = c.sourceVersion;
    if (safeText(c.sourceTags, 256)) candidate.sourceTags = c.sourceTags;
    const expectedSuffix =
      candidate.sourceVersion || candidate.sourceTags
        ? `:${candidate.sourceVersion ?? ''}:${encodeURIComponent(candidate.sourceTags ?? '')}`
        : '';
    const baseId = c.id.split(':').slice(0, 3).join(':');
    if (c.id !== `${baseId}${expectedSuffix}`) continue;
    if (typeof c.defaultAudio === 'boolean') candidate.defaultAudio = c.defaultAudio;
    result.candidates.push(candidate);
  }
  return result;
}

export function youTubeStatusText(view: YouTubeInspection): string {
  if (view.status === 'disabled') return uiText('E1570');
  if (view.status === 'advertisement') return uiText('E1571');
  if (view.status === 'waiting') return uiText('E0131');
  if (view.status === 'unplayable') return uiText('E1572');
  if (view.status === 'unsupported-page' || view.pageType !== 'watch') return uiText('E1573');
  return view.candidates.length
    ? uiText('E1574', { p1: view.candidates.length })
    : view.transports.includes('sabr')
      ? uiText('E1575')
      : uiText('E1576');
}
