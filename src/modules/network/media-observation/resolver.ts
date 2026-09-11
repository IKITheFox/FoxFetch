import type {
  NetworkByteRange,
  NetworkCaptureSnapshot,
  NetworkMediaCandidateKind,
  NetworkMediaCandidateReason,
  NetworkMediaCandidateRole,
  NetworkMediaConfidence,
  NetworkMediaObservation,
  NetworkRedirect,
  NetworkTrackRecommendation,
  ResolvedNetworkMediaCandidate,
} from './types';
import { isAllowedBilibiliMediaUrl } from '../../detector/bilibili-media';

const VIDEO_EXTENSIONS = new Set([
  'avi',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'ogv',
  'ts',
  'webm',
]);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav']);
const PLAYLIST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const SEGMENT_EXTENSIONS = new Set(['m4s']);
const EXCLUDED_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'css',
  'gif',
  'htm',
  'html',
  'jpeg',
  'jpg',
  'json',
  'png',
  'svg',
  'webp',
]);
const PLAYLIST_MIMES = new Set([
  'application/dash+xml',
  'application/mpegurl',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);
const OPAQUE_MIMES = new Set(['application/octet-stream', 'binary/octet-stream']);
const GOOGLEVIDEO_TRANSIENT_PARAMETERS = new Set(['range', 'rn', 'rbuf']);
const MIN_PLAUSIBLE_COMPLETE_MEDIA_BYTES = 16;
const XHR_RESOURCE_TYPES = new Set(['fetch', 'xmlhttprequest']);

interface CandidateSignal {
  kind: NetworkMediaCandidateKind;
  role: NetworkMediaCandidateRole;
  score: number;
  reasons: NetworkMediaCandidateReason[];
}

class UrlDisjointSet {
  private readonly parents = new Map<string, string>();

  add(url: string): void {
    if (!this.parents.has(url)) this.parents.set(url, url);
  }

  find(url: string): string {
    this.add(url);
    const parent = this.parents.get(url) ?? url;
    if (parent === url) return url;
    const root = this.find(parent);
    this.parents.set(url, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents.set(rightRoot, leftRoot);
  }
}

function normalizeMime(mime?: string): string | undefined {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

interface GoogleVideoUrlInfo {
  candidateUrl: string;
  identityKey: string;
  streamId: string;
  mime?: string;
  size?: number;
  range?: NetworkByteRange;
}

function decodedQueryParameterName(rawPair: string): string {
  const separator = rawPair.indexOf('=');
  const rawName = separator < 0 ? rawPair : rawPair.slice(0, separator);
  try {
    return decodeURIComponent(rawName.replace(/\+/gu, ' ')).toLowerCase();
  } catch {
    return rawName.toLowerCase();
  }
}

/** Remove selected query fields without reserializing the remaining signed parameters. */
function stripRawQueryParameters(url: string, parameters: ReadonlySet<string>): string {
  const hashless = url.split('#', 1)[0] ?? url;
  const queryStart = hashless.indexOf('?');
  if (queryStart < 0 || parameters.size === 0) return hashless;
  const base = hashless.slice(0, queryStart);
  const query = hashless.slice(queryStart + 1);
  const retained = query
    .split('&')
    .filter((pair) => !parameters.has(decodedQueryParameterName(pair)));
  return retained.length > 0 ? `${base}?${retained.join('&')}` : base;
}

function positiveSafeInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function googleVideoRange(value: string | null, total?: number): NetworkByteRange | undefined {
  const match = /^(\d+)-(\d+)$/u.exec(value?.trim() ?? '');
  if (!match?.[1] || !match[2]) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  return {
    start,
    end,
    ...(total != null && total > end ? { total } : {}),
  };
}

function googleVideoUrlInfo(url: string): GoogleVideoUrlInfo | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    (hostname !== 'googlevideo.com' && !hostname.endsWith('.googlevideo.com')) ||
    parsed.pathname !== '/videoplayback'
  ) {
    return undefined;
  }

  const streamId = parsed.searchParams.get('id')?.trim();
  const itag = parsed.searchParams.get('itag')?.trim();
  if (!streamId || !itag) return undefined;

  const signedParameters = new Set(
    (parsed.searchParams.get('sparams') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const removableParameters = new Set(
    [...GOOGLEVIDEO_TRANSIENT_PARAMETERS].filter((name) => !signedParameters.has(name)),
  );
  const candidateUrl = stripRawQueryParameters(url, removableParameters);
  const candidate = new URL(candidateUrl);
  const baseline = [...candidate.searchParams.entries()].sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
  );
  const mime = normalizeMime(parsed.searchParams.get('mime') ?? undefined);
  const size = positiveSafeInteger(parsed.searchParams.get('clen'));
  const range = googleVideoRange(parsed.searchParams.get('range'), size);

  return {
    candidateUrl,
    identityKey: `googlevideo:${streamId}:${itag}:${parsed.pathname}:${JSON.stringify(baseline)}`,
    streamId,
    ...(mime ? { mime } : {}),
    ...(size == null ? {} : { size }),
    ...(range ? { range } : {}),
  };
}

function enrichGoogleVideoObservation(
  observation: NetworkMediaObservation,
): NetworkMediaObservation {
  const info = googleVideoUrlInfo(observation.url);
  if (!info) return observation;
  const responseMime = normalizeMime(observation.mime);
  const useQueryMime = !responseMime || OPAQUE_MIMES.has(responseMime);
  const range = observation.range
    ? {
        ...observation.range,
        ...(observation.range.total == null &&
        info.size != null &&
        info.size > observation.range.end
          ? { total: info.size }
          : {}),
      }
    : info.range;
  const size = info.size ?? observation.size;
  return {
    ...observation,
    ...(useQueryMime && info.mime ? { mime: info.mime } : {}),
    ...(size == null ? {} : { size }),
    ...(range ? { range } : {}),
  };
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url.trim();
  }
}

export function networkMediaResourceIdentity(url: string): string {
  return googleVideoUrlInfo(url)?.identityKey ?? canonicalUrl(url);
}

function candidateUrl(url: string): string {
  return googleVideoUrlInfo(url)?.candidateUrl ?? canonicalUrl(url);
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const lastSegment = new URL(url).pathname.split('/').pop() ?? '';
    const dot = lastSegment.lastIndexOf('.');
    if (dot < 0 || dot === lastSegment.length - 1) return undefined;
    return lastSegment.slice(dot + 1).toLowerCase();
  } catch {
    return undefined;
  }
}

function isPlaylistMime(mime?: string): boolean {
  return mime != null && (PLAYLIST_MIMES.has(mime) || mime.includes('mpegurl'));
}

function isExcludedMime(mime?: string): boolean {
  if (!mime) return false;
  return (
    mime.startsWith('image/') ||
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === 'text/css' ||
    mime === 'text/json' ||
    mime === 'application/json' ||
    mime.endsWith('+json')
  );
}

function mimeKind(mime?: string): NetworkMediaCandidateKind | undefined {
  if (!mime) return undefined;
  if (isPlaylistMime(mime)) return 'playlist';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return undefined;
}

function requestMethod(observation: NetworkMediaObservation): string {
  return observation.method?.trim().toUpperCase() || 'GET';
}

function isMetadataOnlyMethod(observation: NetworkMediaObservation): boolean {
  return requestMethod(observation) === 'HEAD';
}

function isKnownTelemetryUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === 'data.bilibili.com' ||
      hostname.endsWith('.data.bilibili.com') ||
      hostname === 'cm.bilibili.com' ||
      hostname === 'google-analytics.com' ||
      hostname.endsWith('.google-analytics.com') ||
      hostname === 'googletagmanager.com' ||
      hostname.endsWith('.googletagmanager.com') ||
      hostname === 'doubleclick.net' ||
      hostname.endsWith('.doubleclick.net')
    );
  } catch {
    return false;
  }
}

function isKnownProviderMediaUrl(value: string): boolean {
  try {
    if (isAllowedBilibiliMediaUrl(value)) return true;
    return googleVideoUrlInfo(value) != null;
  } catch {
    return false;
  }
}

function urlHint(url: string): 'video' | 'audio' | undefined {
  let decoded = url.toLowerCase();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed percent escape should not discard the otherwise usable URL.
  }

  const audio = /(?:^|[/?&_.=-])(audio|sound|aac|flac|m4a|mp3|opus)(?:$|[/?&_.=-])/u.test(decoded);
  const video = /(?:^|[/?&_.=-])(video|visual|h26[45]|av1|vp0?[89])(?:$|[/?&_.=-])/u.test(decoded);
  if (audio === video) return undefined;
  return audio ? 'audio' : 'video';
}

function confidenceFromScore(score: number): NetworkMediaConfidence {
  if (score >= 0.85) return 'high';
  if (score >= 0.6) return 'medium';
  return 'low';
}

function isRedirectEvent(observation: NetworkMediaObservation): boolean {
  return observation.status >= 300 && observation.status < 400 && observation.redirect != null;
}

function isUsableStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

function classifyCandidate(
  url: string,
  observations: readonly NetworkMediaObservation[],
): CandidateSignal | undefined {
  const terminal = observations.at(-1);
  if (!terminal || !isUsableStatus(terminal.status)) return undefined;
  const method = requestMethod(terminal);
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  if (isKnownTelemetryUrl(url)) return undefined;

  const knownSize = knownResourceSize(observations);
  if (
    knownSize != null &&
    knownSize < MIN_PLAUSIBLE_COMPLETE_MEDIA_BYTES &&
    observations.every((item) => item.range == null)
  ) {
    return undefined;
  }

  const normalizedMimes = observations.map((item) => normalizeMime(item.mime));
  const latestMime = normalizeMime(terminal.mime);
  const sniffedKind = [...observations]
    .reverse()
    .map((item) => item.sniffedKind)
    .find((item): item is 'video' | 'audio' => item === 'video' || item === 'audio');
  const strongKind = sniffedKind ?? [...normalizedMimes].reverse().map(mimeKind).find(Boolean);
  const extension = extensionFromUrl(url);

  if (!sniffedKind && isExcludedMime(latestMime)) return undefined;
  if (!strongKind && extension && EXCLUDED_EXTENSIONS.has(extension)) return undefined;
  if (
    !strongKind &&
    (terminal.resourceType.toLowerCase() === 'image' ||
      terminal.resourceType.toLowerCase() === 'stylesheet')
  ) {
    return undefined;
  }

  const reasons = new Set<NetworkMediaCandidateReason>();
  let kind: NetworkMediaCandidateKind = 'unknown';
  let role: NetworkMediaCandidateRole = 'unknown';
  let score = 0;

  if (sniffedKind) {
    kind = sniffedKind;
    role = 'track';
    score = 0.99;
    reasons.add('container-track-handler');
  } else if (strongKind === 'playlist') {
    kind = 'playlist';
    role = 'playlist';
    score = 0.98;
    reasons.add('playlist-mime');
  } else if (strongKind === 'video') {
    kind = 'video';
    role = 'track';
    score = 0.98;
    reasons.add('video-mime');
  } else if (strongKind === 'audio') {
    kind = 'audio';
    role = 'track';
    score = 0.98;
    reasons.add('audio-mime');
  } else if (extension && PLAYLIST_EXTENSIONS.has(extension)) {
    kind = 'playlist';
    role = 'playlist';
    score = 0.92;
    reasons.add('playlist-extension');
  } else if (extension && VIDEO_EXTENSIONS.has(extension)) {
    kind = 'video';
    role = 'track';
    score = 0.86;
    reasons.add('video-extension');
  } else if (extension && AUDIO_EXTENSIONS.has(extension)) {
    kind = 'audio';
    role = 'track';
    score = 0.86;
    reasons.add('audio-extension');
  } else if (extension && SEGMENT_EXTENSIONS.has(extension)) {
    role = 'segment';
    score = 0.62;
    reasons.add('fragment-extension');
  }

  if (extension && SEGMENT_EXTENSIONS.has(extension)) reasons.add('fragment-extension');

  const hint = urlHint(url);
  if (hint === 'video') {
    reasons.add('video-url-hint');
    if (kind === 'unknown') {
      kind = 'video';
      if (role === 'unknown') role = 'track';
    }
    if (!strongKind) score += 0.18;
  } else if (hint === 'audio') {
    reasons.add('audio-url-hint');
    if (kind === 'unknown') {
      kind = 'audio';
      if (role === 'unknown') role = 'track';
    }
    if (!strongKind) score += 0.18;
  }

  const hasOpaqueMime = normalizedMimes.some((mime) => mime != null && OPAQUE_MIMES.has(mime));
  if (hasOpaqueMime) {
    reasons.add('opaque-mime');
    score = Math.max(score, 0.34);
  }
  if (!extension) {
    reasons.add('extensionless-url');
    score = Math.max(score, 0.2);
  }
  if (observations.some((item) => item.resourceType.toLowerCase() === 'media')) {
    reasons.add('media-resource-type');
    if (!strongKind) score += 0.27;
  }
  if (observations.some((item) => item.range != null)) {
    reasons.add('byte-range');
    if (!strongKind) score += 0.14;
  }
  if (observations.some((item) => item.status === 206)) {
    reasons.add('partial-response');
    if (!strongKind) score += 0.08;
  }
  if (observations.some((item) => item.redirect != null)) reasons.add('redirected');

  const providerMedia = isKnownProviderMediaUrl(url);
  if (providerMedia) reasons.add('known-media-provider');
  if (isMetadataOnlyMethod(terminal)) reasons.add('head-metadata');

  const mimeOnlyXhr =
    (strongKind === 'video' || strongKind === 'audio') &&
    extension == null &&
    XHR_RESOURCE_TYPES.has(terminal.resourceType.toLowerCase()) &&
    !providerMedia &&
    hint == null &&
    !observations.some((item) => item.range != null || item.status === 206);
  if (mimeOnlyXhr) {
    reasons.add('mime-only-xhr');
    role = 'unknown';
    score = Math.min(score, 0.45);
  }

  const hasDirectMediaSignal =
    strongKind != null ||
    (extension != null &&
      (VIDEO_EXTENSIONS.has(extension) ||
        AUDIO_EXTENSIONS.has(extension) ||
        PLAYLIST_EXTENSIONS.has(extension) ||
        SEGMENT_EXTENSIONS.has(extension)));
  const hasOpaqueCandidateSignal =
    hasOpaqueMime && (!extension || SEGMENT_EXTENSIONS.has(extension));
  const hasExtensionlessCandidateSignal =
    !extension && (reasons.has('media-resource-type') || reasons.has('byte-range') || hint != null);

  if (!hasDirectMediaSignal && !hasOpaqueCandidateSignal && !hasExtensionlessCandidateSignal) {
    return undefined;
  }

  score = Math.min(0.99, Math.round(score * 100) / 100);
  return { kind, role, score, reasons: [...reasons] };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function cloneRedirect(redirect: NetworkRedirect): NetworkRedirect {
  return { ...redirect };
}

function cloneObservation(observation: NetworkMediaObservation): NetworkMediaObservation {
  return {
    ...observation,
    ...(observation.requestHeaders ? { requestHeaders: { ...observation.requestHeaders } } : {}),
    ...(observation.range ? { range: { ...observation.range } } : {}),
    ...(observation.redirect ? { redirect: cloneRedirect(observation.redirect) } : {}),
  };
}

function observedRangeBytes(observations: readonly NetworkMediaObservation[]): number | undefined {
  const ranges = observations
    .map((item) => item.range)
    .filter((range): range is NetworkByteRange => range != null)
    .map((range) => ({ start: range.start, end: range.end }))
    .filter((range) => range.start >= 0 && range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (ranges.length === 0) return undefined;

  let total = 0;
  let currentStart = ranges[0]?.start ?? 0;
  let currentEnd = ranges[0]?.end ?? -1;
  for (const range of ranges.slice(1)) {
    if (range.start <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, range.end);
    } else {
      total += currentEnd - currentStart + 1;
      currentStart = range.start;
      currentEnd = range.end;
    }
  }
  return total + currentEnd - currentStart + 1;
}

function knownResourceSize(observations: readonly NetworkMediaObservation[]): number | undefined {
  const sizes = observations.flatMap((item) => {
    const values: number[] = [];
    if (item.size != null && Number.isFinite(item.size) && item.size > 0) values.push(item.size);
    const total = item.range?.total;
    if (total != null && Number.isFinite(total) && total > 0) values.push(total);
    return values;
  });
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}

function terminalUrlForGroup(observations: readonly NetworkMediaObservation[]): string {
  const responses = observations.filter((item) => !isRedirectEvent(item));
  const latestResponse = responses.at(-1);
  if (latestResponse) return candidateUrl(latestResponse.url);
  const latestRedirect = observations
    .map((item) => item.redirect)
    .filter((item): item is NetworkRedirect => item != null)
    .at(-1);
  return candidateUrl(latestRedirect?.toUrl ?? observations.at(-1)?.url ?? '');
}

function terminalObservations(
  url: string,
  observations: readonly NetworkMediaObservation[],
): NetworkMediaObservation[] {
  const terminalKey = networkMediaResourceIdentity(url);
  const matching = observations.filter(
    (item) => !isRedirectEvent(item) && networkMediaResourceIdentity(item.url) === terminalKey,
  );
  return matching.length > 0 ? matching : observations.filter((item) => !isRedirectEvent(item));
}

export function parseNetworkByteRange(value: string): NetworkByteRange | undefined {
  const match = /^bytes(?:=|\s+)(\d+)-(\d+)(?:\/(\d+|\*))?$/iu.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] && match[3] !== '*' ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  if (total != null && (!Number.isSafeInteger(total) || total <= end)) return undefined;
  return { start, end, ...(total == null ? {} : { total }) };
}

export function resolveNetworkMediaCandidates(
  input: readonly NetworkMediaObservation[],
): ResolvedNetworkMediaCandidate[] {
  const observations = input
    .filter((item) => item.requestId.trim() && item.url.trim())
    .map(cloneObservation)
    .map(enrichGoogleVideoObservation)
    .sort((left, right) => left.time - right.time);
  const urls = new UrlDisjointSet();
  const firstUrlByRequest = new Map<string, string>();

  for (const observation of observations) {
    const url = networkMediaResourceIdentity(observation.url);
    urls.add(url);
    const requestUrl = firstUrlByRequest.get(observation.requestId);
    if (requestUrl) urls.union(requestUrl, url);
    else firstUrlByRequest.set(observation.requestId, url);

    if (observation.redirect) {
      const from = networkMediaResourceIdentity(observation.redirect.fromUrl);
      const to = networkMediaResourceIdentity(observation.redirect.toUrl);
      urls.union(url, from);
      urls.union(from, to);
    }
  }

  const grouped = new Map<string, NetworkMediaObservation[]>();
  for (const observation of observations) {
    const root = urls.find(networkMediaResourceIdentity(observation.url));
    const group = grouped.get(root) ?? [];
    group.push(observation);
    grouped.set(root, group);
  }

  const candidates: ResolvedNetworkMediaCandidate[] = [];
  for (const group of grouped.values()) {
    const url = terminalUrlForGroup(group);
    const terminalGroup = terminalObservations(url, group);
    const latest = terminalGroup.at(-1);
    if (!latest) continue;
    const signal = classifyCandidate(url, terminalGroup);
    if (!signal) continue;

    const sniffedKind = [...terminalGroup]
      .reverse()
      .map((item) => item.sniffedKind)
      .find((item): item is 'video' | 'audio' => item === 'video' || item === 'audio');
    const mime = sniffedKind
      ? `${sniffedKind}/mp4`
      : ([...terminalGroup]
          .reverse()
          .map((item) => normalizeMime(item.mime))
          .find((item) => mimeKind(item) != null) ?? normalizeMime(latest.mime));
    const redirects = group
      .map((item) => item.redirect)
      .filter((item): item is NetworkRedirect => item != null)
      .map(cloneRedirect);
    const size = knownResourceSize(terminalGroup);
    const observedBytes = observedRangeBytes(terminalGroup);
    const latestRedirect = redirects.at(-1);
    const requestHeaders = [...terminalGroup]
      .reverse()
      .map((item) => item.requestHeaders)
      .find((item) => item != null);

    candidates.push({
      url,
      kind: signal.kind,
      role: signal.role,
      confidence: confidenceFromScore(signal.score),
      confidenceScore: signal.score,
      reasons: signal.reasons,
      requestId: latest.requestId,
      ...(latest.method ? { method: requestMethod(latest) } : {}),
      ...(latest.initiator ? { initiator: latest.initiator } : {}),
      ...(latest.documentId ? { documentId: latest.documentId } : {}),
      frameId: latest.frameId,
      resourceType: latest.resourceType,
      ...(mime ? { mime } : {}),
      status: latest.status,
      ...(size == null ? {} : { size }),
      time: latest.time,
      ...(latestRedirect ? { redirect: latestRedirect } : {}),
      ...(requestHeaders ? { requestHeaders: { ...requestHeaders } } : {}),
      requestIds: unique(group.map((item) => item.requestId)),
      methods: unique(group.map(requestMethod)),
      initiators: unique(
        group.map((item) => item.initiator).filter((item): item is string => Boolean(item)),
      ),
      documentIds: unique(
        group.map((item) => item.documentId).filter((item): item is string => Boolean(item)),
      ),
      frameIds: unique(group.map((item) => item.frameId)),
      resourceTypes: unique(group.map((item) => item.resourceType)),
      redirects,
      observations: group.map(cloneObservation),
      firstSeenAt: group[0]?.time ?? latest.time,
      lastSeenAt: group.at(-1)?.time ?? latest.time,
      ...(observedBytes == null ? {} : { observedBytes }),
    });
  }

  return candidates.sort(
    (left, right) =>
      right.confidenceScore - left.confidenceScore ||
      (right.size ?? 0) - (left.size ?? 0) ||
      right.lastSeenAt - left.lastSeenAt ||
      left.url.localeCompare(right.url),
  );
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function overlaps<T>(left: readonly T[], right: readonly T[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function contextsMatch(
  video: ResolvedNetworkMediaCandidate,
  audio: ResolvedNetworkMediaCandidate,
): boolean {
  const videoGoogle = googleVideoUrlInfo(video.url);
  const audioGoogle = googleVideoUrlInfo(audio.url);
  if (videoGoogle || audioGoogle) {
    if (!videoGoogle || !audioGoogle || videoGoogle.streamId !== audioGoogle.streamId) {
      return false;
    }
  }

  if (video.documentIds.length > 0 && audio.documentIds.length > 0) {
    return overlaps(video.documentIds, audio.documentIds);
  }

  const videoOrigins = video.initiators
    .map(originOf)
    .filter((item): item is string => Boolean(item));
  const audioOrigins = audio.initiators
    .map(originOf)
    .filter((item): item is string => Boolean(item));
  if (videoOrigins.length > 0 && audioOrigins.length > 0) {
    return overlaps(videoOrigins, audioOrigins);
  }

  return overlaps(video.frameIds, audio.frameIds);
}

function bestTrack(
  candidates: readonly ResolvedNetworkMediaCandidate[],
  kind: 'video' | 'audio',
): ResolvedNetworkMediaCandidate | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.kind === kind && candidate.role === 'track' && candidate.methods.includes('GET'),
    )
    .sort(compareTracks)[0];
}

function compareTracks(
  left: ResolvedNetworkMediaCandidate,
  right: ResolvedNetworkMediaCandidate,
): number {
  return (
    right.confidenceScore - left.confidenceScore ||
    (right.size ?? 0) - (left.size ?? 0) ||
    right.lastSeenAt - left.lastSeenAt
  );
}

function bestHighConfidencePair(
  candidates: readonly ResolvedNetworkMediaCandidate[],
): { video: ResolvedNetworkMediaCandidate; audio: ResolvedNetworkMediaCandidate } | undefined {
  const videos = candidates
    .filter(
      (candidate) =>
        candidate.kind === 'video' &&
        candidate.role === 'track' &&
        candidate.confidence === 'high' &&
        candidate.methods.includes('GET'),
    )
    .sort(compareTracks);
  const audios = candidates
    .filter(
      (candidate) =>
        candidate.kind === 'audio' &&
        candidate.role === 'track' &&
        candidate.confidence === 'high' &&
        candidate.methods.includes('GET'),
    )
    .sort(compareTracks);

  const pairs = videos.flatMap((video) =>
    audios.filter((audio) => contextsMatch(video, audio)).map((audio) => ({ video, audio })),
  );
  return pairs.sort(
    (left, right) =>
      Math.min(right.video.confidenceScore, right.audio.confidenceScore) -
        Math.min(left.video.confidenceScore, left.audio.confidenceScore) ||
      (right.video.size ?? 0) +
        (right.audio.size ?? 0) -
        ((left.video.size ?? 0) + (left.audio.size ?? 0)) ||
      Math.max(right.video.lastSeenAt, right.audio.lastSeenAt) -
        Math.max(left.video.lastSeenAt, left.audio.lastSeenAt),
  )[0];
}

export function recommendNetworkMediaTracks(
  candidates: readonly ResolvedNetworkMediaCandidate[],
): NetworkTrackRecommendation {
  const video = bestTrack(candidates, 'video');
  const audio = bestTrack(candidates, 'audio');
  const compatiblePair = bestHighConfidencePair(candidates);
  if (compatiblePair) {
    return {
      video: compatiblePair.video,
      audio: compatiblePair.audio,
      pair: {
        ...compatiblePair,
        confidenceScore: Math.min(
          compatiblePair.video.confidenceScore,
          compatiblePair.audio.confidenceScore,
        ),
      },
      autoPair: true,
      reason: 'paired',
    };
  }

  const selected = {
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
  };

  if (!video || !audio) {
    return { ...selected, autoPair: false, reason: 'missing-track' };
  }
  if (video.confidence !== 'high' || audio.confidence !== 'high') {
    return { ...selected, autoPair: false, reason: 'low-confidence' };
  }
  return { ...selected, autoPair: false, reason: 'context-mismatch' };
}

export class NetworkMediaCaptureSession {
  private active = true;
  private readonly observations: NetworkMediaObservation[] = [];

  get isActive(): boolean {
    return this.active;
  }

  observe(observation: NetworkMediaObservation): boolean {
    if (!this.active) return false;
    this.observations.push(cloneObservation(observation));
    return true;
  }

  snapshot(): NetworkCaptureSnapshot {
    const observations = this.observations.map(cloneObservation);
    const candidates = resolveNetworkMediaCandidates(observations);
    return {
      active: this.active,
      observations,
      candidates,
      recommendation: recommendNetworkMediaTracks(candidates),
    };
  }

  stop(): NetworkCaptureSnapshot {
    this.active = false;
    return this.snapshot();
  }
}
