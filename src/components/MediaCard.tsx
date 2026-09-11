import { t as uiText } from '../shared/i18n';
import { useState } from 'react';

import type { MediaAsset } from '../shared/types';
import { mediaArtworkDisplayUrl } from '../modules/media-products/media-artwork';
import { formatBytes, formatDuration } from '../shared/utils';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

const kindMeta = {
  image: {
    get label() {
      return uiText('E0020');
    },
    icon: 'image' as IconName,
  },
  video: {
    get label() {
      return uiText('E0021');
    },
    icon: 'video' as IconName,
  },
  audio: {
    get label() {
      return uiText('E0022');
    },
    icon: 'audio' as IconName,
  },
  playlist: {
    get label() {
      return uiText('E0023');
    },
    icon: 'playlist' as IconName,
  },
};

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return uiText('E0024');
  }
}

function assetTitle(asset: MediaAsset): string {
  return (
    asset.filename ||
    asset.url.split('/').pop()?.split('?')[0] ||
    uiText('E0025', { p1: kindMeta[asset.kind].label })
  );
}

export interface MediaCardProps {
  asset: MediaAsset;
  compact?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onDownload?: () => void;
  onResolve?: () => void;
  resolving?: boolean;
}

export function MediaCard({
  asset,
  compact = false,
  selectable = false,
  selected = false,
  onSelect,
  onDownload,
  onResolve,
  resolving = false,
}: MediaCardProps) {
  const [failedPreview, setFailedPreview] = useState<string>();
  const meta = kindMeta[asset.kind];
  const previewUrl = mediaArtworkDisplayUrl(
    asset.kind === 'image' ? asset.url : asset.poster,
    asset.pageUrl,
  );
  const previewAttempt = `${asset.id}\u0000${previewUrl ?? ''}`;
  const dimensions = asset.width && asset.height ? `${asset.width}×${asset.height}` : undefined;
  const detail = [
    asset.extension?.toUpperCase(),
    dimensions,
    asset.duration ? formatDuration(asset.duration) : undefined,
    formatBytes(asset.size),
  ]
    .filter((value) => value && value !== '大小未知')
    .join(' · ');
  const sourceDetail = [
    uiText('E0027', { p1: hostFromUrl(asset.url) }),
    detail || uiText('E0028', { p1: meta.label }),
  ]
    .filter(Boolean)
    .join(' · ');
  const typeLabel = asset.extension?.trim().toUpperCase() || meta.label;

  return (
    <article
      className={`media-card${compact ? ' media-card--compact' : ''}${selected ? ' is-selected' : ''}${!asset.downloadable && onResolve ? ' media-card--resolvable' : ''}`}
    >
      {selectable ? (
        <label className="media-card__check" title={selected ? uiText('E0029') : uiText('E0030')}>
          <input
            className="sr-only"
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect?.(event.target.checked)}
          />
          <span aria-hidden="true">{selected ? <Icon name="check" size={13} /> : null}</span>
        </label>
      ) : null}
      <div className={`media-card__preview media-card__preview--${asset.kind}`}>
        {previewUrl && failedPreview !== previewAttempt ? (
          <img
            src={previewUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedPreview(previewAttempt)}
          />
        ) : (
          <Icon name={meta.icon} size={compact ? 20 : 24} />
        )}
        {!compact ? (
          <span className="media-card__kind">
            <Icon name={meta.icon} size={11} /> {meta.label}
          </span>
        ) : null}
      </div>
      <div className="media-card__body">
        <span className="media-card__title-row">
          <strong title={assetTitle(asset)}>{assetTitle(asset)}</strong>
          <Tooltip content={sourceDetail} placement="top">
            <button
              type="button"
              className="media-card__info"
              aria-label={uiText('E0031', { p1: assetTitle(asset) })}
            >
              <Icon name="info" size={12} />
            </button>
          </Tooltip>
        </span>
        <span className="media-card__type">{typeLabel}</span>
      </div>
      {onDownload ? (
        <button
          type="button"
          className="media-card__download"
          onClick={onDownload}
          aria-label={uiText('E0032', { p1: assetTitle(asset) })}
          title={uiText('E0033')}
        >
          <Icon name="download" size={17} />
        </button>
      ) : !asset.downloadable && onResolve ? (
        <button
          type="button"
          className="media-card__resolve"
          onClick={onResolve}
          disabled={resolving}
          aria-label={`${resolving ? uiText('E0034') : uiText('E0035')} ${assetTitle(asset)}`}
          title={resolving ? uiText('E0036') : uiText('E0035')}
        >
          <Icon
            name={resolving ? 'spinner' : 'sparkle'}
            size={15}
            className={resolving ? 'spin' : undefined}
          />
          <span className="media-card__resolve-label">
            {resolving ? uiText('E0037') : uiText('E0035')}
          </span>
        </button>
      ) : !asset.downloadable ? (
        <span
          className="media-card__unavailable"
          title={uiText('E0038')}
          aria-label={uiText('E0039')}
        >
          <Icon name="shield" size={15} />
        </span>
      ) : null}
    </article>
  );
}
