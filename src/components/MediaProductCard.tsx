import { t as uiText } from '../shared/i18n';
import { messageText } from '../shared/i18n/legacy-message';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import type {
  MediaProductCardDownloadMode,
  MediaProductDownloadOption,
  MediaProductQualityOption,
} from '../modules/media-products';
import { CustomSelect } from './CustomSelect';
import { Icon, type IconName } from './Icon';
import { MediaProductArtwork } from './MediaProductArtwork';
import { SplitDownloadButton } from './SplitDownloadButton';
import { MediaProductTitle } from './MediaProductTitle';
import { MediaProductLayout } from './MediaProductLayout';

export type MediaProductDownloadMode = MediaProductCardDownloadMode;
export type { MediaProductDownloadOption } from '../modules/media-products';
export type { MediaProductQualityOption } from '../modules/media-products';

export interface MediaProductCardQualityOption extends MediaProductQualityOption {
  clarity?: string;
  codec?: string;
}

export interface MediaProductCardProps {
  title: string;
  domain: string;
  platform?: string;
  poster?: string;
  /** Change with the admitted route/player epoch; permits one fresh image attempt. */
  artworkKey?: string;
  duration?: number | string;
  selectedQuality?: string;
  selectedQualityId?: string;
  qualityOptions?: MediaProductCardQualityOption[];
  options: MediaProductDownloadOption[];
  loading?: boolean;
  onQualityChange?: (qualityId: string) => void;
  onDownload: (mode: MediaProductDownloadMode) => void | Promise<void>;
}

interface DownloadModeMeta {
  label: string;
  detail: string;
  icon: IconName;
}

const downloadModeMeta: Record<MediaProductDownloadMode, DownloadModeMeta> = {
  complete: {
    get label() {
      return uiText('E0040');
    },
    get detail() {
      return uiText('E0041');
    },
    icon: 'sparkle',
  },
  video: {
    get label() {
      return uiText('E0042');
    },
    get detail() {
      return uiText('E0043');
    },
    icon: 'video',
  },
  audio: {
    get label() {
      return uiText('E0044');
    },
    get detail() {
      return uiText('E0045');
    },
    icon: 'audio',
  },
};

const recognizedCodecs = new Set(['AVC', 'HEVC', 'AV1', 'VP9']);

function qualityParts(option: MediaProductCardQualityOption): { clarity: string; codec: string } {
  const parts = option.label
    .split(/\s*·\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const explicitCodec = option.codec?.trim().toUpperCase();
  const codec = explicitCodec || parts.find((part) => recognizedCodecs.has(part.toUpperCase()));
  const clarity =
    option.clarity?.trim() ||
    parts.filter((part) => part.toUpperCase() !== codec?.toUpperCase()).join(' · ') ||
    option.label;
  return { clarity, codec: codec?.toUpperCase() || uiText('E0046') };
}

export function MediaProductCard({
  title,
  domain,
  platform,
  poster,
  artworkKey,
  duration,
  selectedQuality,
  selectedQualityId,
  qualityOptions = [],
  options,
  loading = false,
  onQualityChange,
  onDownload,
}: MediaProductCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const triggerId = useId();
  const menuId = useId();
  const selectedId = selectedQualityId ?? qualityOptions[0]?.id ?? '';
  const qualityRows = qualityOptions.map((quality) => ({ quality, ...qualityParts(quality) }));
  const selectedRow = qualityRows.find((row) => row.quality.id === selectedId) ?? qualityRows[0];
  const selectedClarity = selectedRow?.clarity ?? '';
  const selectedCodec = selectedRow?.codec ?? '';
  const clarityOptions = [
    ...new Map(
      qualityRows.map((row) => [
        row.clarity,
        {
          value: row.clarity,
          label: row.clarity,
          ...(row.quality.detail ? { detail: row.quality.detail } : {}),
        },
      ]),
    ).values(),
  ];
  const codecOptions = [
    ...new Map(
      qualityRows
        .filter((row) => row.clarity === selectedClarity)
        .map((row) => [row.codec, { value: row.codec, label: row.codec }]),
    ).values(),
  ];
  const completeAvailable = options.some(
    (option) => option.mode === 'complete' && option.available !== false,
  );
  const videoAvailable = options.some(
    (option) => option.mode === 'video' && option.available !== false,
  );
  const audioAvailable = options.some(
    (option) => option.mode === 'audio' && option.available !== false,
  );
  const availability = completeAvailable
    ? selectedRow?.quality.completeCheckRequired
      ? {
          tone: 'partial' as const,
          get label() {
            return uiText('E0047');
          },
        }
      : {
          tone: 'ready' as const,
          get label() {
            return uiText('E0048');
          },
        }
    : videoAvailable || audioAvailable
      ? { tone: 'partial' as const, label: videoAvailable ? uiText('E0049') : uiText('E0050') }
      : {
          tone: 'idle' as const,
          get label() {
            return uiText('E0051');
          },
        };
  const primaryOption =
    options.find((option) => option.mode === 'complete' && option.available !== false) ??
    options.find((option) => option.mode === 'video' && option.available !== false) ??
    options.find((option) => option.mode === 'audio' && option.available !== false);

  const chooseClarity = (clarity: string) => {
    const candidates = qualityRows.filter((row) => row.clarity === clarity);
    const next =
      candidates.find((row) => row.codec === selectedCodec) ??
      candidates.find((row) => row.codec === 'AVC') ??
      candidates[0];
    if (next) onQualityChange?.(next.quality.id);
  };

  const chooseCodec = (codec: string) => {
    const next = qualityRows.find((row) => row.clarity === selectedClarity && row.codec === codec);
    if (next) onQualityChange?.(next.quality.id);
  };

  useEffect(() => {
    if (!menuOpen) return;

    const closeWhenOutside = (event: PointerEvent) => {
      const card = cardRef.current;
      if (card && !event.composedPath().includes(card)) setMenuOpen(false);
    };

    const ownerDocument = cardRef.current?.ownerDocument ?? document;
    ownerDocument.addEventListener('pointerdown', closeWhenOutside);
    return () => ownerDocument.removeEventListener('pointerdown', closeWhenOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (loading) setMenuOpen(false);
  }, [loading]);

  const closeMenu = (restoreTriggerFocus = false) => {
    setMenuOpen(false);
    if (restoreTriggerFocus) triggerRef.current?.focus();
  };

  const openMenuFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMenuOpen(true);
  };

  const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      setMenuOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) {
      return;
    }

    event.preventDefault();
    const root = menuRef.current?.getRootNode();
    const activeElement = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const currentIndex = items.indexOf(activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowUp'
            ? (currentIndex - 1 + items.length) % items.length
            : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  };

  const startDownload = (mode: MediaProductDownloadMode) => {
    setMenuOpen(false);
    void onDownload(mode);
  };

  return (
    <MediaProductLayout
      cardRef={cardRef}
      titleId={titleId}
      busy={loading}
      menuOpen={menuOpen}
      hasQualityPicker={qualityOptions.length > 0}
      artwork={
        <MediaProductArtwork
          source={platform ?? (domain.trim() || uiText('E0052'))}
          {...(poster === undefined ? {} : { poster })}
          {...(artworkKey === undefined ? {} : { artworkKey })}
          {...(duration === undefined ? {} : { duration })}
        />
      }
      children={
        <>
          <MediaProductTitle
            title={title}
            titleId={titleId}
            tone={availability.tone}
            status={availability.label}
          />
          {qualityOptions.length > 0 && selectedRow ? (
            <div className="media-product-card__quality-grid">
              <div className="media-product-card__quality">
                <CustomSelect
                  compact
                  value={selectedClarity}
                  options={clarityOptions}
                  label={uiText('E0053', { p1: title })}
                  disabled={loading || !onQualityChange}
                  onChange={chooseClarity}
                />
              </div>
              <div className="media-product-card__quality">
                <CustomSelect
                  compact
                  value={selectedCodec}
                  options={codecOptions}
                  label={uiText('E0054', { p1: title })}
                  disabled={loading || !onQualityChange}
                  onChange={chooseCodec}
                />
              </div>
            </div>
          ) : null}
          {selectedRow?.quality.detail?.trim() ||
          (qualityOptions.length === 0 && selectedQuality?.trim()) ? (
            <span
              className="media-product-card__meta"
              title={selectedRow?.quality.detail ?? selectedQuality}
            >
              {selectedRow?.quality.detail?.trim() ?? selectedQuality?.trim()}
            </span>
          ) : null}
        </>
      }
      actions={
        <SplitDownloadButton
          ref={triggerRef}
          label={uiText('E0032', { p1: title })}
          loading={loading}
          disabled={!primaryOption}
          expanded={menuOpen}
          controls={menuId}
          menuButtonId={triggerId}
          onPrimaryClick={() => primaryOption && startDownload(primaryOption.mode)}
          onMenuToggle={() => setMenuOpen((open) => !open)}
          onMenuKeyDown={openMenuFromKeyboard}
        />
      }
      menu={
        menuOpen ? (
          <div
            ref={menuRef}
            id={menuId}
            className="media-product-card__menu"
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={moveMenuFocus}
          >
            <span className="media-product-card__menu-title">{uiText('E0055')}</span>
            {options.map((option) => {
              const optionMeta = downloadModeMeta[option.mode];
              const available = option.available !== false;
              return (
                <button
                  key={option.mode}
                  type="button"
                  role="menuitem"
                  className={`media-product-card__menu-item media-product-card__menu-item--${option.mode}`}
                  disabled={!available}
                  onClick={() => startDownload(option.mode)}
                >
                  <span className="media-product-card__menu-icon" aria-hidden="true">
                    <Icon name={optionMeta.icon} size={17} />
                  </span>
                  <span className="media-product-card__menu-copy">
                    <strong>{messageText(option.label ?? optionMeta.label)}</strong>
                    <small>
                      {messageText(
                        available
                          ? (option.detail ?? optionMeta.detail)
                          : (option.detail ?? uiText('E0056')),
                      )}
                    </small>
                  </span>
                  {option.mode === 'complete' && available ? (
                    <span className="media-product-card__recommended">{uiText('E0057')}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null
      }
    />
  );
}
