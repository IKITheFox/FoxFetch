import { t as uiText } from '../shared/i18n';
import { useState } from 'react';

import { siteMediaRouteKey } from '../modules/detector';
import { selectCurrentVideoArtwork } from '../modules/media-products';
import type { TabMediaState } from '../shared/types';
import { PlatformLogo } from './PlatformLogo';
import { identifiedYouTubeVideo } from '../modules/youtube/display-video';

export interface CurrentVideoArtworkProps {
  state?: TabMediaState | undefined;
  source?: string | undefined;
  title?: string | undefined;
}

/**
 * Paint only the poster bound to the exact active player generation. A
 * platform mark remains underneath as a safe fallback when the poster is
 * absent or fails to load; unrelated scanned page images are never guessed.
 */
export function CurrentVideoArtwork({ state, source, title }: CurrentVideoArtworkProps) {
  const selectedArtwork = selectCurrentVideoArtwork(state);
  const expectedPageIdentity = source ? siteMediaRouteKey(source) : undefined;
  const artwork =
    selectedArtwork &&
    (!expectedPageIdentity || selectedArtwork.pageIdentity === expectedPageIdentity)
      ? selectedArtwork
      : undefined;
  const samePage =
    state && (!expectedPageIdentity || siteMediaRouteKey(state.pageUrl) === expectedPageIdentity);
  const currentPlayer =
    !state?.activeMedia ||
    (state.activeMedia.mediaEpoch === (state.mediaEpoch ?? 0) &&
      state.activeMedia.routeKey === siteMediaRouteKey(state.pageUrl));
  const youtube =
    samePage && currentPlayer ? identifiedYouTubeVideo(state.youtube, state.pageUrl) : undefined;
  const candidates = [
    ...(youtube?.poster ? [{ url: youtube.poster, source: 'youtube-inspection' }] : []),
    ...(artwork ? [{ url: artwork.url, source: artwork.source }] : []),
  ].filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
  const attempt = JSON.stringify([
    expectedPageIdentity,
    state?.tabId,
    state?.mediaEpoch,
    state?.activeMedia?.elementId,
    state?.activeMedia?.lifecycleGeneration,
    candidates,
  ]);
  return <ArtworkAttempt key={attempt} candidates={candidates} source={source} title={title} />;
}

function ArtworkAttempt({
  candidates,
  source,
  title,
}: Pick<CurrentVideoArtworkProps, 'source' | 'title'> & {
  candidates: Array<{ url: string; source: string }>;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const artwork = candidates.find((item) => !failed.includes(item.url));
  const visibleArtworkUrl = artwork?.url;

  return (
    <span
      className={`current-video-artwork${visibleArtworkUrl ? ' has-artwork' : ''}`}
      data-artwork-source={visibleArtworkUrl ? artwork?.source : 'platform-fallback'}
    >
      {!visibleArtworkUrl ? <PlatformLogo source={source} /> : null}
      {visibleArtworkUrl ? (
        <img
          key={visibleArtworkUrl}
          className="current-video-artwork__image"
          src={visibleArtworkUrl}
          alt={title ? uiText('E0014', { p1: title }) : uiText('E0015')}
          decoding="async"
          loading="eager"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() =>
            setFailed((previous) =>
              previous.includes(visibleArtworkUrl) ? previous : [...previous, visibleArtworkUrl],
            )
          }
        />
      ) : null}
    </span>
  );
}
