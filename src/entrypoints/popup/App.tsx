import { t as uiText } from '../../shared/i18n';
import { ownedPageTitle } from '../../shared/i18n/legacy-message';
import { isUnresolvedVideoPlaceholder } from '../../shared/resource-visibility';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Brand } from '../../components/Brand';
import { IdentifiedVideoRow } from '../../components/IdentifiedVideoRow';
import { identifiedYouTubeVideo } from '../../modules/youtube/display-video';
import { Button, IconButton } from '../../components/Button';
import { CurrentVideoArtwork } from '../../components/CurrentVideoArtwork';
import { openLocalSettings } from '../../modules/settings-frame';
import { Icon } from '../../components/Icon';
import { MediaCard } from '../../components/MediaCard';
import { MediaProductCard } from '../../components/MediaProductCard';
import { SegmentedTrack } from '../../components/SegmentedTrack';
import { InlineNotice, LoadingView, StateView } from '../../components/StateView';
import { StatusDot } from '../../components/StatusDot';
import { ThemeCycleButton } from '../../components/ThemeSwitch';
import { LanguageButton } from '../../components/LanguageButton';
import { sendUiRequest, useAppSettings, useTabMedia } from '../../hooks/useExtensionApi';
import { useTheme } from '../../hooks/useTheme';
import { useStaticTextSelection } from '../../hooks/useStaticTextSelection';
import { selectCurrentVideoTitle } from '../../modules/media-products/media-artwork';
import {
  buildMediaProducts,
  isTrustedMediaAssetForDisplay,
  presentMediaProduct,
  reconcileProductQualitySelections,
  selectCurrentVideoArtworkForProduct,
  selectPrimaryVideoAnchor,
  selectProductDownload,
  type MediaProductCardDownloadMode as ProductCardDownloadMode,
  type MediaProduct,
  type MediaProductDownloadSelection as PopupProductDownloadSelection,
  type MediaProductPlaybackAnchor,
} from '../../modules/media-products';
import type { ActiveMediaFingerprint, TabMediaState } from '../../shared/types';
import { selectRecentPopupAssets, type PopupAssetFilter } from './popup-assets';

type Filter = PopupAssetFilter;

const filters: Array<{
  value: Filter;
  label: string;
  icon?: 'image' | 'video' | 'audio' | 'playlist';
}> = [
  {
    value: 'all',
    get label() {
      return uiText('E0456');
    },
  },
  {
    value: 'video',
    get label() {
      return uiText('E0021');
    },
    icon: 'video',
  },
  {
    value: 'image',
    get label() {
      return uiText('E0020');
    },
    icon: 'image',
  },
  {
    value: 'audio',
    get label() {
      return uiText('E0022');
    },
    icon: 'audio',
  },
];

function activeMediaFromState(state?: TabMediaState): ActiveMediaFingerprint | undefined {
  return state?.activeMedia;
}

function activeVideoFromState(state?: TabMediaState): MediaProductPlaybackAnchor | undefined {
  const active = activeMediaFromState(state);
  return active?.kind === 'video' ? { ...active, kind: 'video' } : undefined;
}

export function App() {
  useStaticTextSelection();
  const { settings, saveSettings } = useAppSettings();
  useTheme(settings.themeMode);
  const {
    activeTab,
    state,
    loading,
    scanning,
    error,
    setError,
    download,
    downloadMediaProduct,
    openSidePanel,
  } = useTabMedia();
  const [filter, setFilter] = useState<Filter>('all');
  const [downloadingId, setDownloadingId] = useState<string>();
  const [cacheBusy, setCacheBusy] = useState(false);
  const openingView = useRef(false);
  const [notice, setNotice] = useState<string>();
  const [selectedQualityByProduct, setSelectedQualityByProduct] = useState<Record<string, string>>(
    {},
  );

  const identified = state ? identifiedYouTubeVideo(state.youtube, state.pageUrl) : undefined;
  const assets = useMemo(
    () => (state?.assets ?? []).filter((asset) => !isUnresolvedVideoPlaceholder(asset)),
    [state],
  );
  const pageUrl = state?.pageUrl || activeTab?.url;
  const pageTitle = ownedPageTitle(
    selectCurrentVideoTitle(state) || state?.pageTitle || activeTab?.title || uiText('E0052'),
    pageUrl,
  );
  const primaryVideo = useMemo(() => {
    const active = activeVideoFromState(state);
    if (active) return active;
    return selectPrimaryVideoAnchor(state?.mediaElements ?? []);
  }, [state]);
  const mediaProducts = useMemo(
    () =>
      pageUrl
        ? buildMediaProducts(assets, {
            pageUrl,
            pageTitle,
            ...(primaryVideo ? { anchor: primaryVideo } : {}),
          }).filter(
            (product) =>
              product.videoTracks.length > 0 &&
              (product.capabilities.complete || product.capabilities.videoOnly),
          )
        : [],
    [assets, pageTitle, pageUrl, primaryVideo],
  );
  const productAssetIds = useMemo(
    () =>
      new Set(
        mediaProducts.flatMap((product) =>
          [...product.videoTracks, ...product.audioTracks].flatMap((track) =>
            track.sources.map((source) => source.id),
          ),
        ),
      ),
    [mediaProducts],
  );
  const ungroupedAssets = useMemo(
    () =>
      pageUrl
        ? assets.filter(
            (asset) =>
              !productAssetIds.has(asset.id) &&
              isTrustedMediaAssetForDisplay(asset, {
                pageUrl,
                ...(primaryVideo ? { anchor: primaryVideo } : {}),
              }),
          )
        : [],
    [assets, pageUrl, primaryVideo, productAssetIds],
  );
  const counts = useMemo(
    () => ({
      image: ungroupedAssets.filter((asset) => asset.kind === 'image').length,
      video:
        Number(!!identified) +
        mediaProducts.length +
        ungroupedAssets.filter((asset) => asset.kind === 'video').length,
      audio:
        mediaProducts.filter((product) => product.capabilities.audioOnly).length +
        ungroupedAssets.filter((asset) => asset.kind === 'audio').length,
      playlist: ungroupedAssets.filter((asset) => asset.kind === 'playlist').length,
    }),
    [mediaProducts, ungroupedAssets, identified],
  );
  const visibleProducts = useMemo(
    () =>
      filter === 'all' || filter === 'video'
        ? mediaProducts
        : filter === 'audio'
          ? mediaProducts.filter((product) => product.capabilities.audioOnly)
          : [],
    [filter, mediaProducts],
  );
  const recent = useMemo(
    () => selectRecentPopupAssets(ungroupedAssets, filter),
    [filter, ungroupedAssets],
  );
  const totalVisibleAssets = Number(!!identified) + mediaProducts.length + ungroupedAssets.length;
  const showIdentified = !!identified && (filter === 'all' || filter === 'video');
  const scanPresentation = error
    ? {
        tone: 'error' as const,
        get label() {
          return uiText('E0457');
        },
      }
    : scanning || state?.status === 'scanning'
      ? {
          tone: 'loading' as const,
          get label() {
            return uiText('E0458');
          },
        }
      : state?.status === 'ready'
        ? {
            tone: 'ready' as const,
            get label() {
              return uiText('E0459');
            },
          }
        : totalVisibleAssets > 0
          ? {
              tone: 'partial' as const,
              get label() {
                return uiText('E0460');
              },
            }
          : {
              tone: 'idle' as const,
              get label() {
                return uiText('E0461');
              },
            };

  useEffect(() => {
    setSelectedQualityByProduct((current) =>
      reconcileProductQualitySelections(
        current,
        mediaProducts,
        scanning || state?.status === 'scanning',
      ),
    );
  }, [mediaProducts, scanning, state?.status]);

  const startDownload = async (assetId: string) => {
    setDownloadingId(assetId);
    setNotice(undefined);
    try {
      await download([assetId]);
      setNotice(uiText('E0462'));
    } catch {
      // The hook exposes a user-facing error.
    } finally {
      setDownloadingId(undefined);
    }
  };

  const startProductDownload = async (
    product: MediaProduct,
    mode: ProductCardDownloadMode,
    qualityId?: string,
  ) => {
    let selection: PopupProductDownloadSelection;
    try {
      selection = selectProductDownload(product, mode, qualityId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0463'));
      return;
    }

    setDownloadingId(product.id);
    setNotice(undefined);
    try {
      const result = await downloadMediaProduct(
        product.id,
        selection.mode,
        selection.videoAssetId,
        selection.audioAssetId,
        selection.qualityId,
        selection.videoTrackId,
      );
      setNotice(
        result.mode === 'merge'
          ? uiText('E0464')
          : mode === 'audio'
            ? uiText('E0465')
            : mode === 'video'
              ? uiText('E0466')
              : uiText('E0467'),
      );
    } catch {
      // The hook exposes a user-facing error.
    } finally {
      setDownloadingId(undefined);
    }
  };

  const openOptions = async () => {
    try {
      const result = await sendUiRequest<{ opened: boolean }>({
        type: 'OPEN_OPTIONS',
        ...(activeTab?.tabId !== undefined ? { tabId: activeTab.tabId } : {}),
      });
      if (result.opened) window.close();
      else {
        await openLocalSettings(undefined, true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0468'));
    }
  };

  const openVideoView = async (target: 'resources' | 'playback') => {
    if (openingView.current) return;
    if (!state || state.tabId !== activeTab?.tabId) {
      setError(uiText('E0469'));
      return;
    }
    openingView.current = true;
    setCacheBusy(true);
    setNotice(undefined);
    try {
      await sendUiRequest<null>({
        type: 'OPEN_VIDEO_VIEW',
        tabId: state.tabId,
        pageUrl: state.pageUrl,
        mediaEpoch: state.mediaEpoch ?? 0,
        target,
      });
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0470'));
    } finally {
      openingView.current = false;
      setCacheBusy(false);
    }
  };

  const openResourceCenter = async () => {
    try {
      await openSidePanel();
      // Keep exactly one primary FoxFetch surface visible. The page Dock is
      // suppressed by the background; the transient action popup closes here.
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0471'));
    }
  };

  return (
    <main className="app-shell popup-shell" contentEditable={false}>
      <header className="popup-header">
        <div className="topbar">
          <Brand compact />
          <div className="topbar__actions">
            <LanguageButton value={settings.uiLanguage} onChange={saveSettings} />
            <ThemeCycleButton
              value={settings.themeMode}
              onChange={(themeMode) => void saveSettings({ themeMode }).catch(() => undefined)}
            />
            <IconButton
              icon="settings"
              label={uiText('E0397')}
              onClick={() => void openOptions()}
            />
          </div>
        </div>
      </header>

      <div className="popup-content">
        <section
          className="surface-card page-summary page-summary--compact"
          aria-label={uiText('E0052')}
        >
          <div className="page-summary__top">
            <div className="page-summary__site">
              <CurrentVideoArtwork
                state={state}
                source={activeTab?.url ?? pageUrl}
                title={pageTitle}
              />
              <span className="page-summary__copy">
                <strong title={pageTitle}>{pageTitle}</strong>
              </span>
            </div>
            <StatusDot {...scanPresentation} iconOnly />
          </div>
          <div className="stats-grid">
            <div className="stat-pill stat-pill--video">
              <span>
                <Icon name="video" size={11} /> {uiText('E0021')}{' '}
              </span>
              <strong>{counts.video}</strong>
            </div>
            <div className="stat-pill">
              <span>
                <Icon name="image" size={11} /> {uiText('E0020')}{' '}
              </span>
              <strong>{counts.image}</strong>
            </div>
            <div className="stat-pill stat-pill--audio">
              <span>
                <Icon name="audio" size={11} /> {uiText('E0022')}{' '}
              </span>
              <strong>{counts.audio}</strong>
            </div>
            <div className="stat-pill stat-pill--playlist">
              <span>
                <Icon name="playlist" size={11} /> {uiText('E0472')}{' '}
              </span>
              <strong>{counts.playlist}</strong>
            </div>
          </div>
        </section>

        {error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : notice ? (
          <InlineNotice tone="success">{notice}</InlineNotice>
        ) : null}

        <div className="popup-filter-row">
          <div className="section-heading__copy">
            <h2 style={{ margin: 0, fontSize: 14 }}>{uiText('E0473')}</h2>
          </div>
          <span className="section-heading__count">
            {totalVisibleAssets} {uiText('E0474')}
          </span>
        </div>

        <SegmentedTrack
          className="media-filter-track"
          value={filter}
          onChange={setFilter}
          label={uiText('E0475')}
          options={filters.map((item) => ({
            value: item.value,
            label: item.label,
            ...(item.icon ? { icon: <Icon name={item.icon} size={13} /> } : {}),
            count: item.value === 'all' ? totalVisibleAssets : counts[item.value],
          }))}
        />

        {loading && !state ? (
          <LoadingView compact label={uiText('E0476')} />
        ) : showIdentified || visibleProducts.length > 0 || recent.length > 0 ? (
          <div className="popup-resource-list">
            {showIdentified && identified ? (
              <IdentifiedVideoRow
                {...identified}
                identity={`${state?.tabId}:${state?.mediaEpoch}:${identified.id}`}
                onOpen={() => void openVideoView('resources')}
                busy={cacheBusy}
              />
            ) : null}
            {visibleProducts.map((product) => {
              const selectedQualityId =
                selectedQualityByProduct[product.id] ?? product.defaultQualityId;
              const presentation = presentMediaProduct(
                product,
                primaryVideo?.duration,
                selectedQualityId,
                true,
              );
              const currentArtwork = selectCurrentVideoArtworkForProduct(
                state,
                product.pageUrl,
                product.title,
              );
              return filter === 'audio' ? (
                <MediaProductCard
                  key={presentation.id}
                  {...presentation}
                  platform={product.provider}
                  loading={downloadingId === product.id}
                  onDownload={(mode) => startProductDownload(product, mode, selectedQualityId)}
                />
              ) : (
                <IdentifiedVideoRow
                  title={presentation.title}
                  source={product.provider}
                  key={presentation.id}
                  identity={product.id}
                  poster={currentArtwork?.url ?? presentation.poster}
                  duration={primaryVideo?.duration}
                  busy={cacheBusy}
                  onOpen={() => void openVideoView('resources')}
                />
              );
            })}
            {recent.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                compact
                {...(asset.downloadable
                  ? { onDownload: () => void startDownload(asset.id) }
                  : asset.url.startsWith('blob:') &&
                      (asset.kind === 'video' || asset.kind === 'audio')
                    ? {
                        onResolve: () => void openResourceCenter(),
                      }
                    : {})}
              />
            ))}
          </div>
        ) : (
          <StateView
            compact
            icon={filter === 'all' ? 'search' : filter}
            title={
              scanning
                ? uiText('E0477')
                : totalVisibleAssets === 0
                  ? uiText('E0478')
                  : uiText('E0479')
            }
            description={totalVisibleAssets === 0 ? uiText('E0480') : uiText('E0481')}
          />
        )}
      </div>

      <footer className="popup-footer">
        <div className="popup-actions">
          <Button
            variant="primary"
            size="lg"
            icon="panel"
            disabled={!activeTab}
            onClick={() => void openResourceCenter()}
          >
            {' '}
            {uiText('E0482')}{' '}
          </Button>
          <Button
            size="lg"
            icon="download"
            loading={cacheBusy}
            disabled={!activeTab}
            title={uiText('E0483')}
            onClick={() => void openVideoView('resources')}
          >
            {' '}
            {uiText('E0484')}{' '}
          </Button>
          <Button
            size="lg"
            icon="speed"
            title={uiText('E0485')}
            aria-label={uiText('E0485')}
            disabled={!activeTab || cacheBusy}
            onClick={() => void openVideoView('playback')}
          >
            {' '}
            {uiText('E0486')}{' '}
          </Button>
        </div>
      </footer>
      {downloadingId ? (
        <span className="sr-only" role="status">
          {' '}
          {uiText('E0487')}{' '}
        </span>
      ) : null}
    </main>
  );
}
