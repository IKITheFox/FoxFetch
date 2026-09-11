import type { MediaAsset, TabMediaState } from '../../shared/types';
import { siteMediaRouteKey } from '../detector/site-media';
import { mediaArtworkDisplayUrl } from '../media-products/media-artwork';
import { isYouTubePage, type YouTubeInspection } from './inspection';

/** The thumbnail is display metadata, never a source for a media download. */
export function identifiedYouTubeVideo(view: YouTubeInspection | undefined, pageUrl: string) {
  if (!view?.videoId || view.status !== 'identified' || !isYouTubePage(pageUrl)) return undefined;
  const url = new URL(pageUrl);
  const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.split('/')[2];
  if (id !== view.videoId) return undefined;
  return {
    id: view.videoId,
    title: view.title || 'YouTube 视频',
    source: 'youtube',
    poster: mediaArtworkDisplayUrl(view.thumbnail),
    duration: view.duration,
  };
}

/** Only replace the admitted main player's unresolved DOM source, not all blobs. */
export function isIdentifiedYouTubePlaceholder(
  asset: MediaAsset,
  state: TabMediaState | undefined,
): boolean {
  if (!state || !identifiedYouTubeVideo(state.youtube, state.pageUrl)) return false;
  const active = state.activeMedia;
  return (
    !!active &&
    active.kind === 'video' &&
    active.mediaEpoch === (state.mediaEpoch ?? 0) &&
    active.routeKey === siteMediaRouteKey(state.pageUrl) &&
    asset.kind === 'video' &&
    !asset.downloadable &&
    asset.url.startsWith('blob:') &&
    asset.url === active.sourceUrl &&
    asset.frameId === active.frameId &&
    siteMediaRouteKey(asset.pageUrl) === active.routeKey
  );
}
