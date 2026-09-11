import { useState } from 'react';

import { mediaArtworkDisplayUrl } from '../modules/media-products/media-artwork';
import { formatDuration } from '../shared/utils';
import { PlatformLogo, platformFromSource, platformLabel } from './PlatformLogo';

export interface MediaProductArtworkProps {
  source: string;
  poster?: string;
  artworkKey?: string;
  duration?: number | string;
}

/** Shared resource artwork; an unavailable cover never hides the platform or duration. */
export function MediaProductArtwork({
  source,
  poster,
  artworkKey,
  duration,
}: MediaProductArtworkProps) {
  const [failedPoster, setFailedPoster] = useState<string>();
  const platform = platformFromSource(source);
  const displayPoster = mediaArtworkDisplayUrl(poster);
  const attempt = `${artworkKey ?? ''}\u0000${displayPoster ?? ''}`;
  const visiblePoster = displayPoster && attempt !== failedPoster ? displayPoster : undefined;
  const durationText =
    typeof duration === 'number'
      ? Number.isFinite(duration) && duration >= 0
        ? formatDuration(duration)
        : undefined
      : duration?.trim();

  return (
    <div className="media-product-card__preview">
      <PlatformLogo platform={platform} />
      {visiblePoster ? (
        <img
          className="media-product-card__poster"
          src={visiblePoster}
          alt=""
          decoding="async"
          loading="lazy"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedPoster(attempt)}
        />
      ) : null}
      <span className="media-product-card__platform">{platformLabel(platform)}</span>
      {durationText ? <span className="media-product-card__duration">{durationText}</span> : null}
    </div>
  );
}
