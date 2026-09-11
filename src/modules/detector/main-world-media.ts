import type {
  BilibiliCapabilitySupport,
  BilibiliDynamicRangeEvidence,
  BilibiliMediaRepresentation,
  MediaAsset,
} from '../../shared/types';
import {
  extensionFromMime,
  extensionFromUrl,
  filenameFromUrl,
  mergeMediaAssets,
  stableId,
} from '../../shared/utils';
import { isAllowedBilibiliMediaUrl } from './bilibili-media';
import { siteMediaRouteKey } from './site-media';

export const MAIN_WORLD_MEDIA_MANIFEST_VERSION = 1 as const;

export type MainWorldMediaProvider = 'bilibili' | 'youtube' | 'unsupported';

export interface MainWorldMediaManifestIdentity {
  bvid?: string;
  cid?: string;
  videoId?: string;
}

export interface MainWorldMediaManifestCandidate {
  url: string;
  kind: 'video' | 'audio';
  mime: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  representation?: BilibiliMediaRepresentation;
}

/** Plain structured-clone data returned by the MAIN-world probe. */
export interface MainWorldMediaManifestSnapshot {
  version: typeof MAIN_WORLD_MEDIA_MANIFEST_VERSION;
  provider: MainWorldMediaProvider;
  pageUrl: string;
  identity: MainWorldMediaManifestIdentity;
  candidates: MainWorldMediaManifestCandidate[];
}

/**
 * Read the currently exposed player manifest from the page's MAIN world.
 *
 * This function is intentionally self-contained: it can be passed directly as
 * `chrome.scripting.executeScript({ world: 'MAIN', func })`. Do not move its
 * nested helpers to module scope, because injected functions cannot close over
 * extension-module bindings. The result contains media metadata only—never
 * cookies, request headers, authorization values, or page objects.
 */
export function extractMainWorldMediaManifest(): MainWorldMediaManifestSnapshot {
  type JsonRecord = Record<string, unknown>;
  type Candidate = MainWorldMediaManifestCandidate;

  const pageUrl = String(window.location?.href ?? '');
  let reportedPageUrl = pageUrl;
  const empty = (
    provider: MainWorldMediaProvider,
    identity: MainWorldMediaManifestIdentity = {},
  ): MainWorldMediaManifestSnapshot => ({
    version: 1,
    provider,
    pageUrl: reportedPageUrl,
    identity,
    candidates: [],
  });
  const asRecord = (value: unknown): JsonRecord | undefined => {
    if (typeof value === 'string') {
      if (!value || value.length > 8 * 1024 * 1024) return undefined;
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as JsonRecord)
          : undefined;
      } catch {
        return undefined;
      }
    }
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  };
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const asList = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : value == null ? [] : [value];
  const firstRecord = (...values: unknown[]): JsonRecord | undefined => {
    for (const value of values) {
      const record = asRecord(value);
      if (record) return record;
    }
    return undefined;
  };
  const firstString = (record: JsonRecord | undefined, ...keys: string[]): string | undefined => {
    if (!record) return undefined;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() && value.length <= 32_768) {
        return value.trim();
      }
    }
    return undefined;
  };
  const positiveNumber = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    if (typeof value === 'string' && !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const positiveInteger = (value: unknown): number | undefined => {
    const parsed = positiveNumber(value);
    return parsed != null && Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const shortString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized && normalized.length <= 256 && !/[\r\n]/u.test(normalized)
      ? normalized
      : undefined;
  };
  const normalizedCodecs = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > 192 ||
      !/^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/u.test(normalized)
    ) {
      return undefined;
    }
    return normalized.replace(/\s*,\s*/gu, ', ');
  };
  const frameRate = (value: unknown): string | undefined => {
    const normalized =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value.trim()
          : '';
    return normalized &&
      normalized.length <= 64 &&
      /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/u.test(normalized)
      ? normalized
      : undefined;
  };
  const normalizedFrameRate = (value?: string): string => {
    if (!value) return 'unknown';
    const [numeratorValue, denominatorValue] = value.split('/');
    const numerator = Number(numeratorValue);
    const denominator = denominatorValue == null ? 1 : Number(denominatorValue);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? String(Math.round((numerator / denominator) * 1_000) / 1_000)
      : value.toLowerCase();
  };
  const dynamicRangeFromText = (
    value: string | undefined,
  ): BilibiliMediaRepresentation['dynamicRange'] | undefined => {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return undefined;
    if (/dolby[\s_-]*vision|\bdovi\b|杜比视界/u.test(normalized)) return 'Dolby Vision';
    if (
      /(?:^|\W)hdr(?:10(?:\+)?|vivid)?(?:\W|$)|(?:^|\W)(?:pq|hlg)(?:\W|$)|真彩/u.test(normalized)
    ) {
      return 'HDR';
    }
    if (/(?:^|\W)sdr(?:\W|$)/u.test(normalized)) return 'SDR';
    if (/unknown|未知/u.test(normalized)) return 'unknown';
    return undefined;
  };
  const codecDynamicRange = (
    codecs: string | undefined,
  ): BilibiliMediaRepresentation['dynamicRange'] | undefined =>
    (codecs?.split(',') ?? []).some((codec) => /^(?:dvh1|dvhe)(?:\.|$)/iu.test(codec.trim()))
      ? 'Dolby Vision'
      : undefined;
  const dolbyProfile = (codecs: string | undefined): number | undefined => {
    for (const codec of codecs?.split(',') ?? []) {
      const match = /^(?:dvh1|dvhe)\.(\d{1,2})(?:\.|$)/iu.exec(codec.trim());
      if (!match?.[1]) continue;
      const profile = Number(match[1]);
      if (Number.isInteger(profile) && profile >= 0 && profile <= 127) return profile;
    }
    return undefined;
  };
  const numericIdentifier = (value: unknown): string | undefined => {
    const raw =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    return /^\d+$/u.test(raw) ? raw.replace(/^0+(?=\d)/u, '') : undefined;
  };
  const safeMediaUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length > 32_768) return undefined;
    const trimmed = value.trim();
    if (!/^https?:\/\//iu.test(trimmed)) return undefined;
    try {
      const parsed = new URL(trimmed);
      return parsed.username || parsed.password ? undefined : trimmed;
    } catch {
      return undefined;
    }
  };
  const mimeWithCodecs = (mime: string | undefined, codecs: unknown): string | undefined => {
    if (!mime) return undefined;
    if (/;\s*codecs\s*=/iu.test(mime)) return mime;
    if (typeof codecs !== 'string') return mime;
    const normalized = codecs.trim();
    if (
      !normalized ||
      normalized.length > 192 ||
      !/^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/u.test(normalized)
    ) {
      return mime;
    }
    return `${mime}; codecs="${normalized.replace(/\s*,\s*/gu, ', ')}"`;
  };
  const appendCandidate = (
    output: Candidate[],
    seen: Set<string>,
    rawUrl: unknown,
    kind: Candidate['kind'],
    mimeValue: unknown,
    metadata: Omit<Candidate, 'url' | 'kind' | 'mime'> = {},
  ): void => {
    const url = safeMediaUrl(rawUrl);
    const mime = typeof mimeValue === 'string' ? mimeValue.trim() : '';
    if (!url || mime.length > 256 || !mime.toLowerCase().startsWith(`${kind}/`)) return;
    const key = `${kind}\u0000${url}`;
    if (seen.has(key) || output.length >= 256) return;
    seen.add(key);
    output.push({ url, kind, mime, ...metadata });
  };

  let parsedPage: URL;
  try {
    parsedPage = new URL(pageUrl);
    reportedPageUrl = `${parsedPage.origin}${parsedPage.pathname}`;
  } catch {
    return empty('unsupported');
  }
  const hostname = parsedPage.hostname.toLowerCase();
  const globals = window as unknown as JsonRecord;

  if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
    const routeBvid = /\/video\/(BV[0-9A-Za-z]+)/iu.exec(parsedPage.pathname)?.[1]?.toUpperCase();
    if (!routeBvid) return empty('bilibili');
    const part = positiveInteger(parsedPage.searchParams.get('p')) ?? 1;
    const routeCid = numericIdentifier(parsedPage.searchParams.get('cid'));
    reportedPageUrl = `${parsedPage.origin}/video/${routeBvid}/?p=${part}${
      routeCid ? `&cid=${routeCid}` : ''
    }`;

    const initialState = asRecord(globals.__INITIAL_STATE__);
    const initialVideo = firstRecord(initialState?.videoData, initialState?.videoInfo);
    const initialBvid = firstString(initialState, 'bvid') ?? firstString(initialVideo, 'bvid');
    const initialPage =
      initialBvid?.toUpperCase() === routeBvid
        ? asArray(initialVideo?.pages)
            .map(asRecord)
            .find((page) => positiveInteger(page?.page) === part)
        : undefined;
    const initialPageCid =
      numericIdentifier(initialPage?.cid) ??
      (initialBvid?.toUpperCase() === routeBvid
        ? numericIdentifier(initialVideo?.cid ?? initialState?.cid)
        : undefined);
    const playInfo = asRecord(globals.__playinfo__);
    const payload = playInfo
      ? (firstRecord(playInfo.data, playInfo.result, playInfo) ?? playInfo)
      : undefined;
    const videoInfo = firstRecord(payload?.video_info, payload?.videoInfo);
    const dash = firstRecord(payload?.dash, videoInfo?.dash);
    const explicitBvid =
      firstString(playInfo, 'bvid') ??
      firstString(payload, 'bvid') ??
      firstString(videoInfo, 'bvid');
    const normalizedPlayInfoBvid = explicitBvid?.toUpperCase();
    const rawPlayInfoCid =
      numericIdentifier(playInfo?.cid) ??
      numericIdentifier(payload?.cid) ??
      numericIdentifier(videoInfo?.cid);
    const routeKnownCid = routeCid ?? initialPageCid;
    const playInfoIsCurrent =
      playInfo != null &&
      (normalizedPlayInfoBvid ? normalizedPlayInfoBvid === routeBvid : routeKnownCid != null) &&
      (routeKnownCid == null || rawPlayInfoCid == null || rawPlayInfoCid === routeKnownCid);
    const playInfoCid = playInfoIsCurrent ? (routeKnownCid ?? rawPlayInfoCid) : undefined;
    const expectedCid = routeKnownCid ?? playInfoCid;

    // A document_start MAIN-world hook passively clones playurl responses,
    // including legitimate next-video prefetches that arrive before the SPA
    // updates location.href. Treat this page-owned cache as untrusted. Select
    // only entries for the current BVID and, whenever one is known, its exact
    // CID. Without a CID, a single distinct cached CID is the only safe
    // fallback; choosing the newest of several parts could cross-wire media.
    const capturedCache = asRecord(globals.__foxfetchBilibiliManifestCacheV1__);
    const matchingCapturedEntries = asArray(capturedCache?.entries)
      .map(asRecord)
      .filter(
        (entry): entry is JsonRecord =>
          entry != null &&
          entry.version === 1 &&
          firstString(entry, 'bvid')?.toUpperCase() === routeBvid &&
          numericIdentifier(entry.cid) != null,
      )
      .sort(
        (left, right) =>
          (positiveNumber(right.capturedAt) ?? 0) - (positiveNumber(left.capturedAt) ?? 0),
      );
    const capturedEntry = expectedCid
      ? matchingCapturedEntries.find((entry) => numericIdentifier(entry.cid) === expectedCid)
      : new Set(matchingCapturedEntries.map((entry) => numericIdentifier(entry.cid))).size === 1
        ? matchingCapturedEntries[0]
        : undefined;
    const capturedCid = numericIdentifier(capturedEntry?.cid);

    if (playInfo && explicitBvid && explicitBvid.toUpperCase() !== routeBvid && !capturedEntry) {
      return empty('bilibili', { bvid: routeBvid });
    }
    if (expectedCid && rawPlayInfoCid && expectedCid !== rawPlayInfoCid && !capturedEntry) {
      return empty('bilibili', { bvid: routeBvid, cid: expectedCid });
    }
    const cid = expectedCid ?? capturedCid ?? playInfoCid;
    reportedPageUrl = `${parsedPage.origin}/video/${routeBvid}/?p=${part}${
      cid ? `&cid=${cid}` : ''
    }`;
    const identity: MainWorldMediaManifestIdentity = {
      bvid: routeBvid,
      ...(cid ? { cid } : {}),
    };
    const timeLength =
      positiveNumber(payload?.timelength) ??
      positiveNumber(videoInfo?.timelength) ??
      positiveNumber(playInfo?.timelength);
    const duration = timeLength != null ? timeLength / 1_000 : positiveNumber(dash?.duration);
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const supportFormats = new Map<number, JsonRecord>();
    for (const value of asArray(payload?.support_formats ?? payload?.supportFormats)) {
      const support = asRecord(value);
      const qn = positiveInteger(support?.quality ?? support?.qn ?? support?.id);
      if (support && qn != null) supportFormats.set(qn, support);
    }
    const addRepresentations = (
      values: unknown,
      kind: Candidate['kind'],
      audioType?: 'AAC' | 'Dolby' | 'FLAC',
    ): void => {
      for (const value of asList(values)) {
        const representation = asRecord(value);
        if (!representation) continue;
        const mime = mimeWithCodecs(
          firstString(representation, 'mimeType', 'mime_type'),
          representation.codecs,
        );
        const width = kind === 'video' ? positiveInteger(representation.width) : undefined;
        const height = kind === 'video' ? positiveInteger(representation.height) : undefined;
        const size = positiveInteger(representation.contentLength ?? representation.content_length);
        const id = positiveInteger(representation.id);
        const explicitQuality = positiveInteger(representation.quality);
        const qn = explicitQuality ?? id;
        const codecid = positiveInteger(representation.codecid ?? representation.codec_id);
        const codecs = normalizedCodecs(representation.codecs);
        const rate = frameRate(representation.frameRate ?? representation.frame_rate);
        const bandwidth = positiveInteger(representation.bandwidth);
        const support = qn == null ? undefined : supportFormats.get(qn);
        const newDescription =
          shortString(representation.new_description ?? representation.newDescription) ??
          shortString(support?.new_description ?? support?.newDescription);
        const description =
          newDescription ??
          shortString(representation.description) ??
          shortString(support?.description);
        const displayDescription =
          shortString(representation.display_desc ?? representation.displayDescription) ??
          shortString(support?.display_desc ?? support?.displayDescription);
        const superscript =
          shortString(representation.superscript) ?? shortString(support?.superscript);
        const explicitDynamicRange = shortString(
          representation.dynamicRange ??
            representation.dynamic_range ??
            representation.hdrType ??
            representation.hdr_type,
        );
        const dynamicDescription = [description, displayDescription, superscript]
          .filter(Boolean)
          .join(' ');
        const dynamicEvidence: BilibiliDynamicRangeEvidence[] = [];
        const addDynamicEvidence = (
          source: BilibiliDynamicRangeEvidence['source'],
          range: BilibiliMediaRepresentation['dynamicRange'] | undefined,
          detail?: string,
        ): void => {
          if (!range) return;
          const safeDetail = shortString(detail);
          dynamicEvidence.push({
            source,
            range,
            ...(safeDetail ? { detail: safeDetail.slice(0, 128) } : {}),
          });
        };
        addDynamicEvidence(
          'explicit-field',
          dynamicRangeFromText(explicitDynamicRange),
          explicitDynamicRange,
        );
        addDynamicEvidence(
          'quality-number',
          qn === 126 ? 'Dolby Vision' : qn === 125 ? 'HDR' : undefined,
          qn === 126 || qn === 125 ? `qn=${qn}` : undefined,
        );
        addDynamicEvidence('codec', codecDynamicRange(codecs), codecs?.split(',')[0]?.trim());
        addDynamicEvidence(
          'official-description',
          dynamicRangeFromText(dynamicDescription),
          dynamicDescription,
        );
        const decisiveRanges = new Set(
          dynamicEvidence.map((item) => item.range).filter((range) => range !== 'unknown'),
        );
        const dynamicRange =
          decisiveRanges.size > 1
            ? 'unknown'
            : (dynamicEvidence.find((item) => item.range !== 'unknown')?.range ??
              (dynamicEvidence.some((item) => item.range === 'unknown') ? 'unknown' : 'SDR'));
        const primaryCodecProfile = codecs?.split(',')[0]?.trim();
        const profile = dolbyProfile(codecs);
        const representationMetadata: BilibiliMediaRepresentation = {
          provider: 'bilibili',
          key: `bilibili:${[
            kind,
            qn ?? id ?? 'unknown',
            codecid ?? codecs?.toLowerCase() ?? 'unknown',
            normalizedFrameRate(rate),
            dynamicRange.toLowerCase().replace(/\s+/gu, '-'),
            kind === 'audio' ? (audioType ?? 'unknown').toLowerCase() : '',
          ].join(':')}`,
          delivery: 'dash',
          ...(id == null ? {} : { id }),
          ...(qn == null ? {} : { qn }),
          ...(explicitQuality == null ? {} : { quality: explicitQuality }),
          ...(codecid == null ? {} : { codecid }),
          ...(codecs ? { codecs } : {}),
          ...(primaryCodecProfile ? { codecProfile: primaryCodecProfile } : {}),
          ...(profile == null ? {} : { dolbyVisionProfile: profile }),
          ...(rate ? { frameRate: rate } : {}),
          ...(bandwidth == null ? {} : { bandwidth }),
          ...(description ? { description } : {}),
          ...(newDescription ? { newDescription } : {}),
          ...(displayDescription ? { displayDescription } : {}),
          ...(superscript ? { superscript } : {}),
          dynamicRange,
          dynamicRangeEvidence:
            decisiveRanges.size > 1
              ? [
                  ...dynamicEvidence,
                  {
                    source: 'conflict',
                    range: 'unknown',
                    detail: [...decisiveRanges].join(' / '),
                  },
                ]
              : dynamicEvidence.length > 0
                ? dynamicEvidence
                : [{ source: 'default-sdr', range: 'SDR' }],
          capabilities: {
            advertised: support != null,
            delivered: true,
            decodable: 'unknown',
            // MAIN-world data only proves that this representation was
            // delivered.  A conflict is terminal, but an unambiguous Dolby
            // Vision track must remain provisional so the merge worker can
            // stage the complete file and inspect dvcC/dvvC/dvwC itself.
            // Marking every delivered DV representation unsupported here
            // made the fallback snapshot disagree with the dedicated
            // Bilibili capture path and could hide "完整视频" after dedupe.
            remuxable: decisiveRanges.size > 1 ? 'unsupported' : 'unknown',
          },
          ...(kind === 'audio' ? { audioType: audioType ?? 'unknown' } : {}),
        };
        const metadata = {
          ...(width == null ? {} : { width }),
          ...(height == null ? {} : { height }),
          ...(duration == null ? {} : { duration }),
          ...(size == null ? {} : { size }),
          representation: representationMetadata,
        };
        for (const [sourceIndex, rawUrl] of [
          representation.baseUrl,
          representation.base_url,
          ...asList(representation.backupUrl),
          ...asList(representation.backup_url),
        ].entries()) {
          appendCandidate(candidates, seen, rawUrl, kind, mime, {
            ...metadata,
            representation: { ...representationMetadata, sourceIndex },
          });
        }
      }
    };
    if (playInfoIsCurrent && (!cid || !playInfoCid || cid === playInfoCid) && dash) {
      addRepresentations(dash.video, 'video');
      addRepresentations(dash.audio, 'audio', 'AAC');
      addRepresentations(asRecord(dash.dolby)?.audio, 'audio', 'Dolby');
      addRepresentations(asRecord(dash.flac)?.audio, 'audio', 'FLAC');
    }
    if (playInfoIsCurrent && (!cid || !playInfoCid || cid === playInfoCid)) {
      for (const [durlIndex, value] of asArray(payload?.durl).entries()) {
        const durl = asRecord(value);
        if (!durl) continue;
        const itemDuration = positiveNumber(durl.length);
        const effectiveDuration = itemDuration == null ? duration : itemDuration / 1_000;
        const itemSize = positiveInteger(durl.size);
        const durlQuality = positiveInteger(durl.quality);
        const durlRepresentation: BilibiliMediaRepresentation = {
          provider: 'bilibili',
          key: `bilibili:durl:${durlQuality ?? 'unknown'}:${durlIndex}`,
          delivery: 'durl',
          ...(durlQuality == null ? {} : { qn: durlQuality, quality: durlQuality }),
          dynamicRange: 'SDR',
          dynamicRangeEvidence: [{ source: 'default-sdr', range: 'SDR' }],
          capabilities: {
            advertised: false,
            delivered: true,
            decodable: 'unknown',
            remuxable: 'unknown',
          },
          audioType: 'AAC',
        };
        for (const [sourceIndex, rawUrl] of [
          durl.url,
          ...asList(durl.backupUrl),
          ...asList(durl.backup_url),
        ].entries()) {
          const mediaUrl = safeMediaUrl(rawUrl);
          if (!mediaUrl) continue;
          const extension = /\.([a-z0-9]{1,8})$/iu
            .exec(new URL(mediaUrl).pathname)?.[1]
            ?.toLowerCase();
          appendCandidate(
            candidates,
            seen,
            mediaUrl,
            'video',
            extension === 'flv' ? 'video/x-flv; codecs="mp4a"' : 'video/mp4; codecs="mp4a"',
            {
              ...(effectiveDuration == null ? {} : { duration: effectiveDuration }),
              ...(itemSize == null ? {} : { size: itemSize }),
              representation: { ...durlRepresentation, sourceIndex },
            },
          );
        }
      }
    }
    if (capturedEntry && (!cid || capturedCid === cid)) {
      for (const rawCandidate of asArray(capturedEntry.candidates)) {
        const candidate = asRecord(rawCandidate);
        if (!candidate || (candidate.kind !== 'video' && candidate.kind !== 'audio')) continue;
        const candidateWidth = positiveInteger(candidate.width);
        const candidateHeight = positiveInteger(candidate.height);
        const candidateDuration = positiveNumber(candidate.duration);
        const candidateSize = positiveInteger(candidate.size);
        const rawRepresentation = asRecord(candidate.representation);
        const representation = rawRepresentation
          ? ({
              ...rawRepresentation,
              provider: 'bilibili' as const,
            } as BilibiliMediaRepresentation)
          : undefined;
        appendCandidate(candidates, seen, candidate.url, candidate.kind, candidate.mime, {
          ...(candidateWidth == null ? {} : { width: candidateWidth }),
          ...(candidateHeight == null ? {} : { height: candidateHeight }),
          ...(candidateDuration == null ? {} : { duration: candidateDuration }),
          ...(candidateSize == null ? {} : { size: candidateSize }),
          ...(representation ? { representation } : {}),
        });
      }
    }
    return {
      version: 1,
      provider: 'bilibili',
      pageUrl: reportedPageUrl,
      identity,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        ...(candidate.representation
          ? { representation: { ...candidate.representation, ...identity } }
          : {}),
      })),
    };
  }

  if (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtube-nocookie.com' ||
    hostname.endsWith('.youtube-nocookie.com')
  ) {
    const routeVideoId =
      parsedPage.pathname === '/watch'
        ? parsedPage.searchParams.get('v')?.trim()
        : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(parsedPage.pathname)?.[1];
    if (!routeVideoId || !/^[0-9A-Za-z_-]{6,32}$/u.test(routeVideoId)) {
      return empty('youtube');
    }
    reportedPageUrl =
      parsedPage.pathname === '/watch'
        ? `${parsedPage.origin}/watch?v=${encodeURIComponent(routeVideoId)}`
        : `${parsedPage.origin}${parsedPage.pathname}`;

    const responses: JsonRecord[] = [];
    try {
      const player = document.getElementById('movie_player') as
        (HTMLElement & { getPlayerResponse?: () => unknown }) | null;
      const response = asRecord(player?.getPlayerResponse?.());
      if (response) responses.push(response);
    } catch {
      // A page-owned player API is optional and may throw while navigating.
    }
    const initialResponse = asRecord(globals.ytInitialPlayerResponse);
    if (initialResponse) responses.push(initialResponse);
    const ytplayer = asRecord(globals.ytplayer);
    const config = asRecord(ytplayer?.config);
    const args = asRecord(config?.args);
    const configResponse = asRecord(args?.player_response);
    if (configResponse) responses.push(configResponse);

    const response = responses.find(
      (candidate) => firstString(asRecord(candidate.videoDetails), 'videoId') === routeVideoId,
    );
    const identity: MainWorldMediaManifestIdentity = { videoId: routeVideoId };
    if (!response) return empty('youtube', identity);
    const videoDetails = asRecord(response.videoDetails);
    const streamingData = asRecord(response.streamingData);
    if (!streamingData) return empty('youtube', identity);

    const fallbackDuration = positiveNumber(videoDetails?.lengthSeconds);
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const value of [
      ...asArray(streamingData.formats),
      ...asArray(streamingData.adaptiveFormats),
    ]) {
      const format = asRecord(value);
      if (!format) continue;
      const mime = firstString(format, 'mimeType');
      const kind = mime?.toLowerCase().startsWith('video/')
        ? 'video'
        : mime?.toLowerCase().startsWith('audio/')
          ? 'audio'
          : undefined;
      if (!kind) continue;
      const width = kind === 'video' ? positiveInteger(format.width) : undefined;
      const height = kind === 'video' ? positiveInteger(format.height) : undefined;
      const approximateDuration = positiveNumber(format.approxDurationMs);
      const duration = approximateDuration != null ? approximateDuration / 1_000 : fallbackDuration;
      const size = positiveInteger(format.contentLength);
      appendCandidate(candidates, seen, format.url, kind, mime, {
        ...(width == null ? {} : { width }),
        ...(height == null ? {} : { height }),
        ...(duration == null ? {} : { duration }),
        ...(size == null ? {} : { size }),
      });
    }
    return { version: 1, provider: 'youtube', pageUrl: reportedPageUrl, identity, candidates };
  }

  return empty('unsupported');
}

export interface MainWorldMediaManifestValidationContext {
  pageUrl: string;
  pageTitle?: string;
  frameId?: number;
  discoveredAt?: number;
}

export interface ValidatedMainWorldMediaManifest {
  provider: Exclude<MainWorldMediaProvider, 'unsupported'>;
  pageUrl: string;
  identity: MainWorldMediaManifestIdentity;
  assets: MediaAsset[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function providerForPage(
  pageUrl: string,
): Exclude<MainWorldMediaProvider, 'unsupported'> | undefined {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) return 'bilibili';
    if (
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com')
    ) {
      return 'youtube';
    }
  } catch {
    // Unsupported or malformed page URL.
  }
  return undefined;
}

function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function normalizedPositiveInteger(value: string | null): string | undefined {
  if (value == null || !/^\d+$/u.test(value.trim())) return undefined;
  const normalized = value.trim().replace(/^0+(?=\d)/u, '');
  return normalized !== '0' ? normalized : undefined;
}

function sameReportedRoute(
  provider: Exclude<MainWorldMediaProvider, 'unsupported'>,
  reportedPage: URL,
  expectedPage: URL,
): boolean {
  if (reportedPage.origin !== expectedPage.origin) return false;
  if (provider === 'youtube') {
    return siteMediaRouteKey(reportedPage.href) === siteMediaRouteKey(expectedPage.href);
  }

  const reportedBvid = /\/video\/(BV[0-9A-Za-z]+)/iu
    .exec(reportedPage.pathname)?.[1]
    ?.toUpperCase();
  const expectedBvid = /\/video\/(BV[0-9A-Za-z]+)/iu
    .exec(expectedPage.pathname)?.[1]
    ?.toUpperCase();
  const reportedPart = normalizedPositiveInteger(reportedPage.searchParams.get('p')) ?? '1';
  const expectedPart = normalizedPositiveInteger(expectedPage.searchParams.get('p')) ?? '1';
  if (!reportedBvid || reportedBvid !== expectedBvid || reportedPart !== expectedPart) return false;

  // Most Bilibili routes omit cid. The page-owned manifest may safely enrich
  // that route with the current cid; only a cid explicitly present in the
  // browser URL is authoritative enough to require exact agreement here.
  const expectedCid = normalizedPositiveInteger(expectedPage.searchParams.get('cid'));
  const reportedCid = normalizedPositiveInteger(reportedPage.searchParams.get('cid'));
  return expectedCid == null || reportedCid === expectedCid;
}

function validIdentity(
  provider: Exclude<MainWorldMediaProvider, 'unsupported'>,
  value: unknown,
  pageUrl: string,
): MainWorldMediaManifestIdentity | undefined {
  const identity = asRecord(value);
  if (!identity) return undefined;
  const page = new URL(pageUrl);
  if (provider === 'bilibili') {
    const expectedBvid = /\/video\/(BV[0-9A-Za-z]+)/iu.exec(page.pathname)?.[1]?.toUpperCase();
    const bvid = typeof identity.bvid === 'string' ? identity.bvid.trim().toUpperCase() : '';
    if (!expectedBvid || bvid !== expectedBvid) return undefined;
    const cid =
      typeof identity.cid === 'string' && /^\d+$/u.test(identity.cid.trim())
        ? identity.cid.trim().replace(/^0+(?=\d)/u, '')
        : undefined;
    const expectedCid = page.searchParams
      .get('cid')
      ?.trim()
      .replace(/^0+(?=\d)/u, '');
    if (expectedCid && (!cid || expectedCid !== cid)) return undefined;
    return { bvid: expectedBvid, ...(cid ? { cid } : {}) };
  }
  const expectedVideoId =
    page.pathname === '/watch'
      ? page.searchParams.get('v')?.trim()
      : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(page.pathname)?.[1];
  const videoId = typeof identity.videoId === 'string' ? identity.videoId.trim() : '';
  return expectedVideoId && videoId === expectedVideoId ? { videoId } : undefined;
}

function validCandidateNumber(
  value: unknown,
  maximum: number,
  integer = false,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    return undefined;
  }
  return integer && !Number.isInteger(value) ? undefined : value;
}

function validRepresentationString(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\r\n]/u.test(normalized)
    ? normalized
    : undefined;
}

function validatedBilibiliRepresentation(value: unknown): BilibiliMediaRepresentation | undefined {
  const raw = asRecord(value);
  if (raw?.provider !== 'bilibili' || (raw.delivery !== 'dash' && raw.delivery !== 'durl')) {
    return undefined;
  }
  const key = validRepresentationString(raw.key, 512);
  if (!key || !/^bilibili:[a-z0-9:._+-]+$/iu.test(key)) return undefined;
  const id = validCandidateNumber(raw.id, 1_000_000, true);
  const bvid =
    typeof raw.bvid === 'string' && /^BV[0-9A-Z]+$/iu.test(raw.bvid.trim())
      ? raw.bvid.trim().toUpperCase()
      : undefined;
  const cid =
    typeof raw.cid === 'string' && /^\d+$/u.test(raw.cid.trim())
      ? raw.cid.trim().replace(/^0+(?=\d)/u, '')
      : undefined;
  const qn = validCandidateNumber(raw.qn, 1_000_000, true);
  const quality = validCandidateNumber(raw.quality, 1_000_000, true);
  const codecid = validCandidateNumber(raw.codecid, 1_000_000, true);
  const codecs = validRepresentationString(raw.codecs, 192);
  const codecProfile = validRepresentationString(raw.codecProfile, 128);
  const dolbyVisionProfile = validCandidateNumber(raw.dolbyVisionProfile, 127, true);
  const rawFrameRate = validRepresentationString(raw.frameRate, 64);
  const validFrameRate =
    rawFrameRate && /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/u.test(rawFrameRate)
      ? rawFrameRate
      : undefined;
  const bandwidth = validCandidateNumber(raw.bandwidth, Number.MAX_SAFE_INTEGER, true);
  const description = validRepresentationString(raw.description);
  const newDescription = validRepresentationString(raw.newDescription);
  const displayDescription = validRepresentationString(raw.displayDescription);
  const superscript = validRepresentationString(raw.superscript);
  const dynamicRange =
    raw.dynamicRange === 'SDR' ||
    raw.dynamicRange === 'HDR' ||
    raw.dynamicRange === 'Dolby Vision' ||
    raw.dynamicRange === 'unknown'
      ? raw.dynamicRange
      : undefined;
  const audioType =
    raw.audioType === 'AAC' ||
    raw.audioType === 'Dolby' ||
    raw.audioType === 'FLAC' ||
    raw.audioType === 'unknown'
      ? raw.audioType
      : undefined;
  const dynamicRangeEvidence: BilibiliDynamicRangeEvidence[] | undefined = Array.isArray(
    raw.dynamicRangeEvidence,
  )
    ? raw.dynamicRangeEvidence
        .slice(0, 8)
        .map((value): BilibiliDynamicRangeEvidence | undefined => {
          const evidence = asRecord(value);
          if (!evidence) return undefined;
          const source = evidence.source;
          const range = evidence.range;
          if (
            source !== 'explicit-field' &&
            source !== 'quality-number' &&
            source !== 'codec' &&
            source !== 'initialization-segment' &&
            source !== 'official-description' &&
            source !== 'default-sdr' &&
            source !== 'conflict'
          ) {
            return undefined;
          }
          if (
            range !== 'SDR' &&
            range !== 'HDR' &&
            range !== 'Dolby Vision' &&
            range !== 'unknown'
          ) {
            return undefined;
          }
          const detail = validRepresentationString(evidence.detail, 128);
          return { source, range, ...(detail ? { detail } : {}) };
        })
        .filter((value): value is BilibiliDynamicRangeEvidence => value != null)
    : undefined;
  const rawCapabilities = asRecord(raw.capabilities);
  const capabilitySupport = (value: unknown): BilibiliCapabilitySupport | undefined =>
    value === 'supported' || value === 'unsupported' || value === 'unknown' ? value : undefined;
  const decodable = capabilitySupport(rawCapabilities?.decodable);
  const remuxable = capabilitySupport(rawCapabilities?.remuxable);
  const capabilities =
    typeof rawCapabilities?.advertised === 'boolean' &&
    rawCapabilities.delivered === true &&
    decodable &&
    remuxable
      ? {
          advertised: rawCapabilities.advertised,
          delivered: true as const,
          decodable,
          remuxable,
        }
      : undefined;
  const sourceIndex =
    typeof raw.sourceIndex === 'number' &&
    Number.isInteger(raw.sourceIndex) &&
    raw.sourceIndex >= 0 &&
    raw.sourceIndex <= 256
      ? raw.sourceIndex
      : undefined;
  return {
    provider: 'bilibili',
    key,
    delivery: raw.delivery,
    ...(bvid ? { bvid } : {}),
    ...(cid ? { cid } : {}),
    ...(id == null ? {} : { id }),
    ...(qn == null ? {} : { qn }),
    ...(quality == null ? {} : { quality }),
    ...(codecid == null ? {} : { codecid }),
    ...(codecs ? { codecs } : {}),
    ...(codecProfile ? { codecProfile } : {}),
    ...(dolbyVisionProfile == null ? {} : { dolbyVisionProfile }),
    ...(validFrameRate ? { frameRate: validFrameRate } : {}),
    ...(bandwidth == null ? {} : { bandwidth }),
    ...(description ? { description } : {}),
    ...(newDescription ? { newDescription } : {}),
    ...(displayDescription ? { displayDescription } : {}),
    ...(superscript ? { superscript } : {}),
    ...(dynamicRange ? { dynamicRange } : {}),
    ...(dynamicRangeEvidence && dynamicRangeEvidence.length > 0 ? { dynamicRangeEvidence } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(audioType ? { audioType } : {}),
    ...(sourceIndex == null ? {} : { sourceIndex }),
  };
}

function validatedCandidate(
  value: unknown,
  provider: Exclude<MainWorldMediaProvider, 'unsupported'>,
): MainWorldMediaManifestCandidate | undefined {
  const candidate = asRecord(value);
  if (!candidate || (candidate.kind !== 'video' && candidate.kind !== 'audio')) return undefined;
  if (
    typeof candidate.url !== 'string' ||
    candidate.url.length === 0 ||
    candidate.url.length > 32_768 ||
    typeof candidate.mime !== 'string' ||
    candidate.mime.length === 0 ||
    candidate.mime.length > 256 ||
    /[\r\n]/u.test(candidate.mime)
  ) {
    return undefined;
  }
  const mime = candidate.mime.trim();
  if (!mime.toLowerCase().startsWith(`${candidate.kind}/`)) return undefined;

  let url: URL;
  try {
    url = new URL(candidate.url.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (provider === 'bilibili') {
    if (!isAllowedBilibiliMediaUrl(url.href)) return undefined;
  } else if (
    !hostnameMatches(hostname, 'googlevideo.com') ||
    url.pathname !== '/videoplayback' ||
    !url.searchParams.get('id') ||
    !url.searchParams.get('itag')
  ) {
    return undefined;
  }

  const width = validCandidateNumber(candidate.width, 32_768, true);
  const height = validCandidateNumber(candidate.height, 32_768, true);
  const duration = validCandidateNumber(candidate.duration, 14 * 24 * 60 * 60);
  const size = validCandidateNumber(candidate.size, Number.MAX_SAFE_INTEGER, true);
  const representation =
    provider === 'bilibili' ? validatedBilibiliRepresentation(candidate.representation) : undefined;
  return {
    url: candidate.url.trim(),
    kind: candidate.kind,
    mime,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(duration == null ? {} : { duration }),
    ...(size == null ? {} : { size }),
    ...(representation ? { representation } : {}),
  };
}

/**
 * Revalidate an untrusted MAIN-world result and convert it to background-owned
 * MediaAssets. Invalid candidates are ignored; an invalid route/provider/
 * identity rejects the entire snapshot.
 */
export function validateMainWorldMediaManifest(
  value: unknown,
  context: MainWorldMediaManifestValidationContext,
): ValidatedMainWorldMediaManifest | undefined {
  const snapshot = asRecord(value);
  const provider = providerForPage(context.pageUrl);
  if (
    !snapshot ||
    !provider ||
    snapshot.version !== MAIN_WORLD_MEDIA_MANIFEST_VERSION ||
    snapshot.provider !== provider ||
    typeof snapshot.pageUrl !== 'string' ||
    snapshot.pageUrl.length > 32_768 ||
    !Array.isArray(snapshot.candidates) ||
    snapshot.candidates.length > 256
  ) {
    return undefined;
  }
  try {
    const reportedPage = new URL(snapshot.pageUrl);
    const expectedPage = new URL(context.pageUrl);
    if (!sameReportedRoute(provider, reportedPage, expectedPage)) return undefined;
  } catch {
    return undefined;
  }
  const identity = validIdentity(provider, snapshot.identity, context.pageUrl);
  if (!identity) return undefined;

  const discoveredAt = context.discoveredAt ?? Date.now();
  const frameId = context.frameId ?? 0;
  const pageTitle = context.pageTitle?.trim() || '当前页面';
  const assets = new Map<string, MediaAsset>();
  for (const rawCandidate of snapshot.candidates) {
    const candidate = validatedCandidate(rawCandidate, provider);
    if (!candidate) continue;
    const id = stableId(`${candidate.kind}:${candidate.url}`);
    if (assets.has(id)) continue;
    const extension = extensionFromMime(candidate.mime) ?? extensionFromUrl(candidate.url);
    assets.set(id, {
      id,
      url: candidate.url,
      pageUrl: context.pageUrl,
      pageTitle,
      frameId,
      kind: candidate.kind,
      detectedBy: ['manifest'],
      mime: candidate.mime,
      ...(extension ? { extension } : {}),
      filename: filenameFromUrl(candidate.url, `foxfetch-${candidate.kind}-${id}`),
      ...(candidate.width == null ? {} : { width: candidate.width }),
      ...(candidate.height == null ? {} : { height: candidate.height }),
      ...(candidate.duration == null ? {} : { duration: candidate.duration }),
      ...(candidate.size == null ? {} : { size: candidate.size }),
      ...(candidate.representation
        ? {
            representation: {
              ...candidate.representation,
              ...(provider === 'bilibili'
                ? { bvid: identity.bvid!, ...(identity.cid ? { cid: identity.cid } : {}) }
                : {}),
            },
          }
        : {}),
      downloadable: true,
      discoveredAt,
    });
  }
  return {
    provider,
    pageUrl: context.pageUrl,
    identity,
    assets: [...assets.values()],
  };
}

/** Keep a validated MAIN-world supplement in a later isolated-world snapshot. */
export function mergeValidatedMainWorldAssets(
  isolatedAssets: readonly MediaAsset[],
  mainWorldAssets: readonly MediaAsset[],
): MediaAsset[] {
  const currentRepresentationSources = new Map<string, Set<string>>();
  for (const asset of mainWorldAssets) {
    const key = asset.representation?.key;
    if (!key) continue;
    const sources = currentRepresentationSources.get(key);
    if (sources) sources.add(asset.url);
    else currentRepresentationSources.set(key, new Set([asset.url]));
  }
  const retained = isolatedAssets.filter((asset) => {
    const key = asset.representation?.key;
    const currentSources = key ? currentRepresentationSources.get(key) : undefined;
    return !currentSources || currentSources.has(asset.url);
  });
  const assets = new Map(retained.map((asset) => [asset.id, asset]));
  for (const asset of mainWorldAssets) {
    const previous = assets.get(asset.id);
    if (!previous) {
      assets.set(asset.id, asset);
      continue;
    }
    const merged = mergeMediaAssets(previous, asset);
    assets.set(asset.id, {
      ...merged,
      ...((asset.representation ?? previous.representation)
        ? {
            representation: {
              ...(previous.representation ?? asset.representation!),
              ...(asset.representation ?? {}),
            },
          }
        : {}),
    });
  }
  return [...assets.values()];
}
