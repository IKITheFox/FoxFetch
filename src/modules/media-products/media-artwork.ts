import { normalizeMediaTitle } from '../../shared/media-title';
import type {
  BoundMediaArtwork,
  MediaAsset,
  MediaElementInfo,
  TabMediaState,
} from '../../shared/types';
import { siteMediaRouteKey } from '../detector/site-media';
import { providerIdentityMatchesPage } from './media-trust';

export interface CurrentVideoArtwork {
  url: string;
  source: 'active-player' | 'bound-track' | 'page-metadata';
  elementId: string;
  lifecycleGeneration: number;
  mediaEpoch: number;
  pageIdentity: string;
}

/**
 * Keep image URLs usable without ever accepting script schemes or embedded SVG.
 * The original query is preserved because provider artwork URLs may be signed.
 */
export function safeMediaArtworkUrl(value?: string, baseUrl?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^data:image\/(?:avif|gif|jpe?g|png|webp);/iu.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed, baseUrl);
    if (parsed.username || parsed.password) return undefined;
    if (!['blob:', 'http:', 'https:'].includes(parsed.protocol)) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** Own image renderers only: never rewrite page attributes or media download URLs. */
export function mediaArtworkDisplayUrl(value?: string, baseUrl?: string): string | undefined {
  const safe = safeMediaArtworkUrl(value, baseUrl);
  if (!safe) return undefined;
  if (!safe.startsWith('http:')) return safe;
  const parsed = new URL(safe);
  // Bilibili's image CDN supports HTTPS. Do not guess protocol support for
  // other providers, ports, signed hosts, or look-alike domain suffixes.
  if (!/^i[0-2]\.hdslb\.com$/u.test(parsed.hostname) || parsed.port) return undefined;
  parsed.protocol = 'https:';
  return parsed.href;
}

export type MediaArtworkContext = Pick<
  TabMediaState,
  'pageUrl' | 'activeMedia' | 'mediaEpoch' | 'providerIdentity'
>;

function bilibiliArtworkPage(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return (
      (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) &&
      /\/video\/BV/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Validate at both the background boundary and the consuming UI. */
export function validateBoundMediaArtwork(
  artwork: BoundMediaArtwork | undefined,
  context: MediaArtworkContext,
): BoundMediaArtwork | undefined {
  const active = context.activeMedia;
  if (
    !artwork ||
    artwork.source !== 'page-metadata' ||
    !active ||
    active.kind !== 'video' ||
    typeof artwork.url !== 'string' ||
    typeof artwork.titleKey !== 'string' ||
    typeof artwork.elementId !== 'string' ||
    !Number.isSafeInteger(artwork.mediaEpoch) ||
    artwork.mediaEpoch < 0 ||
    !Number.isSafeInteger(artwork.lifecycleGeneration) ||
    artwork.lifecycleGeneration < 0
  )
    return undefined;
  const pageIdentity = siteMediaRouteKey(context.pageUrl);
  if (
    active.routeKey !== pageIdentity ||
    artwork.pageIdentity !== pageIdentity ||
    artwork.mediaEpoch !== (context.mediaEpoch ?? 0) ||
    active.mediaEpoch !== artwork.mediaEpoch ||
    artwork.frameId !== 0 ||
    active.frameId !== 0 ||
    artwork.elementId !== active.elementId ||
    artwork.lifecycleGeneration !== active.lifecycleGeneration ||
    !artwork.titleKey ||
    artwork.titleKey !== mediaArtworkTitleKey(active.title, context.pageUrl)
  )
    return undefined;
  if (
    bilibiliArtworkPage(context.pageUrl) &&
    (!context.providerIdentity ||
      typeof artwork.providerIdentity !== 'string' ||
      !/^bilibili:BV[0-9A-Za-z]+:[1-9]\d*$/u.test(artwork.providerIdentity) ||
      artwork.providerIdentity.toUpperCase() !== context.providerIdentity.toUpperCase() ||
      !providerIdentityMatchesPage(context.pageUrl, context.providerIdentity))
  )
    return undefined;
  const url = safeMediaArtworkUrl(artwork.url, context.pageUrl);
  if (
    !url ||
    (bilibiliArtworkPage(context.pageUrl) && /\/bfs\/manga-static\//iu.test(new URL(url).pathname))
  )
    return undefined;
  return {
    url,
    source: 'page-metadata',
    pageIdentity,
    mediaEpoch: artwork.mediaEpoch,
    elementId: artwork.elementId,
    lifecycleGeneration: artwork.lifecycleGeneration,
    frameId: 0,
    titleKey: artwork.titleKey,
    ...(bilibiliArtworkPage(context.pageUrl)
      ? { providerIdentity: context.providerIdentity! }
      : {}),
  };
}

/** Read only document metadata belonging to the admitted player; never scan images. */
export function readBoundMediaArtwork(
  doc: Document,
  context: MediaArtworkContext,
): BoundMediaArtwork | undefined {
  const active = context.activeMedia;
  if (!active || active.kind !== 'video' || active.frameId !== 0) return undefined;
  const pageUrl = context.pageUrl;
  const titleKey = mediaArtworkTitleKey(active.title, pageUrl);
  const metadataTitle = doc.querySelector<HTMLMetaElement>(
    'meta[property="og:title"], meta[name="twitter:title"]',
  )?.content;
  if (!titleKey || !metadataTitle || mediaArtworkTitleKey(metadataTitle, pageUrl) !== titleKey)
    return undefined;
  const rawMetadataPage =
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ||
    doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  let metadataPage: string | undefined;
  try {
    metadataPage = rawMetadataPage ? new URL(rawMetadataPage, pageUrl).href : undefined;
  } catch {
    return undefined;
  }
  if (bilibiliArtworkPage(pageUrl)) {
    // A matching title alone cannot disambiguate stale SPA metadata or two
    // videos with the same name. Require an exact BVID on Bilibili's canonical.
    if (
      !metadataPage ||
      !context.providerIdentity ||
      !providerIdentityMatchesPage(metadataPage, context.providerIdentity)
    )
      return undefined;
  } else if (metadataPage && siteMediaRouteKey(metadataPage) !== siteMediaRouteKey(pageUrl))
    return undefined;
  const url = safeMediaArtworkUrl(
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]')
      ?.content,
    pageUrl,
  );
  if (!url) return undefined;
  return validateBoundMediaArtwork(
    {
      url,
      source: 'page-metadata',
      pageIdentity: siteMediaRouteKey(pageUrl),
      mediaEpoch: context.mediaEpoch ?? 0,
      elementId: active.elementId,
      lifecycleGeneration: active.lifecycleGeneration,
      frameId: active.frameId,
      titleKey,
      ...(context.providerIdentity ? { providerIdentity: context.providerIdentity } : {}),
    },
    context,
  );
}

export function mediaArtworkTitleKey(title: string, pageUrl: string): string {
  return normalizeMediaTitle(title, pageUrl)
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase();
}

function exactActiveVideo(state: TabMediaState): MediaElementInfo | undefined {
  const active = state.activeMedia;
  const pageIdentity = siteMediaRouteKey(state.pageUrl);
  if (
    !active ||
    active.kind !== 'video' ||
    active.routeKey !== pageIdentity ||
    active.mediaEpoch !== (state.mediaEpoch ?? 0)
  ) {
    return undefined;
  }
  return state.mediaElements.find(
    (element) =>
      element.kind === 'video' &&
      element.frameId === active.frameId &&
      element.elementId === active.elementId &&
      element.lifecycleGeneration === active.lifecycleGeneration,
  );
}

export function selectCurrentVideoTitle(state?: TabMediaState): string | undefined {
  return state && exactActiveVideo(state)
    ? state.activeMedia?.title.trim() || undefined
    : undefined;
}

function isCurrentVideoTrack(
  asset: MediaAsset,
  video: MediaElementInfo,
  state: TabMediaState,
): boolean {
  if (asset.kind !== 'video' || asset.frameId !== video.frameId) return false;
  if (siteMediaRouteKey(asset.pageUrl) !== siteMediaRouteKey(state.pageUrl)) return false;
  const title = mediaArtworkTitleKey(state.activeMedia?.title ?? '', state.pageUrl);
  if (!title || mediaArtworkTitleKey(asset.pageTitle, asset.pageUrl) !== title) return false;
  // A poster on a scanned image is never evidence. Require the exact video URL,
  // or a provider BVID+CID bound to the current player (including part identity).
  if (video.sourceUrl && asset.url === video.sourceUrl) return true;
  const representation = asset.representation;
  if (!representation?.bvid || !representation.cid || !state.providerIdentity) return false;
  const [provider, bvid, cid] = state.providerIdentity.split(':');
  return (
    provider === 'bilibili' &&
    bvid?.toUpperCase() === representation.bvid.toUpperCase() &&
    cid === representation.cid
  );
}

/**
 * Select artwork only from the exact route/player generation accepted by the
 * background. A stale retained SPA video must never donate its poster.
 */
export function selectCurrentVideoArtwork(state?: TabMediaState): CurrentVideoArtwork | undefined {
  if (!state) return undefined;
  const exact = exactActiveVideo(state);
  if (!exact) return undefined;
  const playerPoster = mediaArtworkDisplayUrl(exact.poster, state.pageUrl);
  const trackPoster = playerPoster
    ? undefined
    : state.assets
        .filter((asset) => isCurrentVideoTrack(asset, exact, state))
        .sort((a, b) => (b.lastObservedAt ?? b.discoveredAt) - (a.lastObservedAt ?? a.discoveredAt))
        .map((asset) => mediaArtworkDisplayUrl(asset.poster, state.pageUrl))
        .find((poster) => poster !== undefined);
  const metadataPoster = mediaArtworkDisplayUrl(
    validateBoundMediaArtwork(state.artwork, state)?.url,
    state.pageUrl,
  );
  const url = playerPoster ?? trackPoster ?? metadataPoster;
  if (!url) return undefined;
  return {
    url,
    source: playerPoster ? 'active-player' : trackPoster ? 'bound-track' : 'page-metadata',
    elementId: exact.elementId,
    lifecycleGeneration: exact.lifecycleGeneration,
    mediaEpoch: state.mediaEpoch ?? 0,
    pageIdentity: siteMediaRouteKey(state.pageUrl),
  };
}

/** Do not paint the active player's artwork onto a retained or unrelated product card. */
export function selectCurrentVideoArtworkForProduct(
  state: TabMediaState | undefined,
  productPageUrl: string,
  productTitle: string,
): CurrentVideoArtwork | undefined {
  const artwork = selectCurrentVideoArtwork(state);
  if (!artwork || !state?.activeMedia) return undefined;
  if (siteMediaRouteKey(productPageUrl) !== artwork.pageIdentity) return undefined;
  if (
    mediaArtworkTitleKey(productTitle, productPageUrl) !==
    mediaArtworkTitleKey(state.activeMedia.title, state.pageUrl)
  ) {
    return undefined;
  }
  return artwork;
}
