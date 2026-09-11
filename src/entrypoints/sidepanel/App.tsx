import { t as uiText } from '../../shared/i18n';
import { ownedPageTitle } from '../../shared/i18n/legacy-message';
import { isUnresolvedVideoPlaceholder } from '../../shared/resource-visibility';
import { useEffect, useMemo, useRef, useState } from 'react';

import { IdentifiedVideoRow } from '../../components/IdentifiedVideoRow';
import { identifiedYouTubeVideo } from '../../modules/youtube/display-video';
import { openYouTubeTaskPage } from '../../modules/youtube/task-page';
import { Brand } from '../../components/Brand';
import { Button, IconButton } from '../../components/Button';
import { CurrentVideoArtwork } from '../../components/CurrentVideoArtwork';
import { YouTubeInspectionCard } from '../../components/YouTubeInspectionCard';
import { Icon } from '../../components/Icon';
import { MediaCard } from '../../components/MediaCard';
import { MediaProductCard } from '../../components/MediaProductCard';
import { SegmentedTrack } from '../../components/SegmentedTrack';
import { SourceCapturePanel } from '../../components/SourceCapturePanel';
import { InlineNotice, LoadingView, StateView } from '../../components/StateView';
import { StatusDot } from '../../components/StatusDot';
import { ThemeCycleButton } from '../../components/ThemeSwitch';
import { LanguageButton } from '../../components/LanguageButton';
import {
  startMediaAccessIntent,
  useAppSettings,
  useDownloads,
  useTabMedia,
} from '../../hooks/useExtensionApi';
import { useTheme } from '../../hooks/useTheme';
import { useStaticTextSelection } from '../../hooks/useStaticTextSelection';
import { selectCurrentVideoTitle } from '../../modules/media-products/media-artwork';
import {
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
import type { MediaKind, TabMediaState } from '../../shared/types';
import { formatBytes } from '../../shared/utils';
import { connectResourceCenterPresence } from './resource-center-presence';
import { buildResourceCenterMediaInventory } from './resource-center-media';

type Filter = 'all' | MediaKind;

const filterItems: Array<{
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

function activeVideoFromState(state?: TabMediaState): MediaProductPlaybackAnchor | undefined {
  const active = state?.activeMedia;
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
    scan,
    download,
    downloadMediaProduct,
    startSourceCapture,
    reloadSourceCapture,
    downloadResolvedSource,
    cancelSourceCapture,
  } = useTabMedia({ scanOnMount: false, requestHostPermissionOnManualScan: true });
  const downloads = useDownloads();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [resolvingAssetId, setResolvingAssetId] = useState<string>();
  const [downloadingProductId, setDownloadingProductId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedQualityByProduct, setSelectedQualityByProduct] = useState<Record<string, string>>(
    {},
  );

  const pageUrl = state?.pageUrl || activeTab?.url;
  const pageTitle = ownedPageTitle(
    selectCurrentVideoTitle(state) || state?.pageTitle || activeTab?.title || uiText('E0052'),
    pageUrl,
  );

  useEffect(() => {
    if (activeTab?.tabId == null) return undefined;
    return connectResourceCenterPresence(activeTab.tabId);
  }, [activeTab?.tabId]);

  const primaryVideo = useMemo(() => {
    const active = activeVideoFromState(state);
    if (active) return active;
    return selectPrimaryVideoAnchor(state?.mediaElements ?? []);
  }, [state]);
  const youtubeHost = useRef<HTMLDivElement>(null);
  const identified = state ? identifiedYouTubeVideo(state.youtube, state.pageUrl) : undefined;
  const inventory = useMemo(
    () =>
      pageUrl
        ? buildResourceCenterMediaInventory(
            (state?.assets ?? []).filter((asset) => !isUnresolvedVideoPlaceholder(asset)),
            {
              pageUrl,
              pageTitle,
              ...(primaryVideo ? { anchor: primaryVideo } : {}),
            },
            settings.showAdvancedMedia,
          )
        : {
            products: [],
            assets: [],
            rawAssets: state?.assets ?? [],
            counts: { image: 0, video: 0, audio: 0, playlist: 0 },
          },
    [pageTitle, pageUrl, primaryVideo, settings.showAdvancedMedia, state],
  );
  const { products, assets, rawAssets } = inventory;
  const counts = { ...inventory.counts, video: inventory.counts.video + Number(!!identified) };
  const showIdentified =
    identified &&
    (filter === 'all' || filter === 'video') &&
    [identified.title, identified.source].some((value) =>
      value.toLowerCase().includes(query.trim().toLowerCase()),
    );
  const openIdentified = () => {
    const host = youtubeHost.current?.querySelector<HTMLElement>('[data-youtube-status]');
    if (!identified || !host || !openYouTubeTaskPage(host, identified.id))
      setError(uiText('E0489'));
  };
  const visibleProducts = useMemo(() => {
    if (filter !== 'all' && filter !== 'video' && filter !== 'audio') return [];
    const normalized = query.trim().toLowerCase();
    return products.filter((product) => {
      if (filter === 'audio' && !product.capabilities.audioOnly) return false;
      if (!normalized) return true;
      return [
        product.title,
        product.pageUrl,
        ...product.videoTracks.flatMap((track) => [track.label, track.qualityLabel]),
        ...product.audioTracks.flatMap((track) => [track.label, track.qualityLabel]),
      ].some((value) => value.toLowerCase().includes(normalized));
    });
  }, [filter, products, query]);
  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (filter !== 'all' && asset.kind !== filter) return false;
      if (!normalized) return true;
      return [asset.filename, asset.url, asset.extension, asset.mime].some((value) =>
        value?.toLowerCase().includes(normalized),
      );
    });
  }, [assets, filter, query]);

  useEffect(() => {
    const validIds = new Set(assets.map((asset) => asset.id));
    setSelected((current) => new Set([...current].filter((id) => validIds.has(id))));
  }, [assets]);

  const selectedAssets = assets.filter((asset) => selected.has(asset.id));
  const selectedVideo = selectedAssets.filter((asset) => asset.kind === 'video');
  const selectedAudio = selectedAssets.filter((asset) => asset.kind === 'audio');
  const canMerge =
    selectedAssets.length === 2 && selectedVideo.length === 1 && selectedAudio.length === 1;
  const selectedBytes = selectedAssets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const allVisibleSelected =
    visibleAssets.length > 0 && visibleAssets.every((asset) => selected.has(asset.id));
  const primaryItemCount = Number(!!identified) + products.length + assets.length;
  const recentTasks = downloads
    .filter((item) => item.state === 'queued' || item.state === 'downloading')
    .slice(0, 2);
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
        : primaryItemCount > 0
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
        products,
        scanning || state?.status === 'scanning',
      ),
    );
  }, [products, scanning, state?.status]);

  const toggleAll = (checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const asset of visibleAssets) {
        if (checked) next.add(asset.id);
        else next.delete(asset.id);
      }
      return next;
    });
  };

  const startDownload = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBatchBusy(true);
    setNotice(undefined);
    try {
      await download(ids);
      setNotice(ids.length === 1 ? uiText('E0462') : uiText('E0490', { p1: ids.length }));
      setSelected(new Set());
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setBatchBusy(false);
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

    setDownloadingProductId(product.id);
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
          ? uiText('E0491')
          : mode === 'audio'
            ? uiText('E0465')
            : mode === 'video'
              ? uiText('E0466')
              : uiText('E0467'),
      );
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setDownloadingProductId(undefined);
    }
  };

  const createMergeJob = async () => {
    const video = selectedVideo[0];
    const audio = selectedAudio[0];
    if (!video || !audio) return;
    setMergeBusy(true);
    setNotice(undefined);
    try {
      const tabId = activeTab?.tabId;
      if (tabId == null) throw new Error(uiText('E0492'));
      if (!state || state.tabId !== tabId || !pageUrl || state.pageUrl !== pageUrl) {
        throw new Error(uiText('E0276'));
      }
      await startMediaAccessIntent({
        kind: 'merge-assets',
        tabId,
        videoAssetId: video.id,
        audioAssetId: audio.id,
        expectedPageUrl: state.pageUrl,
        expectedMediaEpoch: state.mediaEpoch ?? 0,
      });
      setSelected(new Set());
      setNotice(uiText('E0493'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0494'));
    } finally {
      setMergeBusy(false);
    }
  };

  const beginSourceCapture = async (blobAssetId: string) => {
    setCaptureBusy(true);
    setResolvingAssetId(blobAssetId);
    setNotice(undefined);
    try {
      const result = await startSourceCapture(blobAssetId);
      setNotice(result.capture.status === 'resolved' ? uiText('E0495') : uiText('E0496'));
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setCaptureBusy(false);
      setResolvingAssetId(undefined);
    }
  };

  const reloadCapture = async () => {
    const capture = state?.sourceCapture;
    if (!capture) return;
    setCaptureBusy(true);
    setNotice(undefined);
    try {
      await reloadSourceCapture(capture.id);
      setNotice(uiText('E0497'));
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setCaptureBusy(false);
    }
  };

  const downloadCapture = async () => {
    const capture = state?.sourceCapture;
    if (!capture) return;
    setCaptureBusy(true);
    setNotice(undefined);
    try {
      const result = await downloadResolvedSource(capture.id);
      setNotice(result.mode === 'merge' ? uiText('E0493') : uiText('E0462'));
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setCaptureBusy(false);
    }
  };

  const cancelCapture = async () => {
    const capture = state?.sourceCapture;
    if (!capture) return;
    setCaptureBusy(true);
    setNotice(undefined);
    try {
      await cancelSourceCapture(capture.id);
      setNotice(capture.status === 'resolved' ? uiText('E0498') : uiText('E0499'));
    } catch {
      // Hook exposes the detailed error.
    } finally {
      setCaptureBusy(false);
    }
  };

  const openOptions = async () => {
    try {
      await (await import('../../modules/settings-frame')).openLocalSettings();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('E0468'));
    }
  };

  return (
    <main className="app-shell sidepanel-shell" contentEditable={false}>
      <header className="sidepanel-header">
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

      <div className="sidepanel-main">
        <section className="resource-page-summary" aria-label={uiText('E0052')}>
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
          <div className="resource-page-summary__stats" aria-label={uiText('E0500')}>
            <span>
              <Icon name="video" size={12} /> {uiText('E0021')} <strong>{counts.video}</strong>
            </span>
            <span>
              <Icon name="image" size={12} /> {uiText('E0020')} <strong>{counts.image}</strong>
            </span>
            <span>
              <Icon name="audio" size={12} /> {uiText('E0022')} <strong>{counts.audio}</strong>
            </span>
            <span>
              <Icon name="playlist" size={12} /> {uiText('E0472')}{' '}
              <strong>{counts.playlist}</strong>
            </span>
          </div>
        </section>

        {error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : notice ? (
          <InlineNotice tone="success">{notice}</InlineNotice>
        ) : null}

        {state?.youtube ? (
          <div ref={youtubeHost}>
            <YouTubeInspectionCard
              view={state.youtube}
              tabId={state.tabId}
              refreshing={state.status === 'scanning'}
            />
          </div>
        ) : null}
        {state?.sourceCapture || recentTasks.length ? (
          <details
            className="surface-card resource-tools"
            {...(state?.sourceCapture ? { open: true } : {})}
          >
            <summary>{uiText('E0501')}</summary>
            <div className="resource-tools__content">
              {state?.sourceCapture ? (
                <SourceCapturePanel
                  capture={state.sourceCapture}
                  busy={captureBusy}
                  onReload={() => void reloadCapture()}
                  onDownload={() => void downloadCapture()}
                  onCancel={() => void cancelCapture()}
                  onRestart={() => void beginSourceCapture(state.sourceCapture!.blobAssetId)}
                />
              ) : null}
              {recentTasks.map((task) => (
                <div className="task-strip" key={task.id}>
                  <span className="task-strip__icon">
                    <Icon
                      name={task.state === 'downloading' ? 'spinner' : 'clock'}
                      className={task.state === 'downloading' ? 'spin' : undefined}
                      size={16}
                    />
                  </span>
                  <span className="task-strip__copy">
                    <strong>{task.filename}</strong>
                    <span>{task.state === 'downloading' ? uiText('E0502') : uiText('E0503')}</span>
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <div className="section-heading">
          <span className="section-heading__copy">
            <h2>{uiText('E0473')}</h2>
          </span>
          <span className="section-heading__count">
            {uiText('E0504')} {primaryItemCount} {uiText('E0474')}
          </span>
        </div>

        <div className="library-toolbar">
          <label className="search-field">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={uiText('E0505')}
              aria-label={uiText('E0506')}
            />
            {query ? (
              <button
                type="button"
                className="search-field__clear"
                aria-label={uiText('E0507')}
                onClick={() => setQuery('')}
              >
                <Icon name="close" size={14} />
              </button>
            ) : null}
          </label>
          <div className="library-toolbar__filters">
            <SegmentedTrack
              className="media-filter-track"
              value={filter}
              onChange={setFilter}
              label={uiText('E0475')}
              options={filterItems.map((item) => ({
                value: item.value,
                label: item.label,
                ...(item.icon ? { icon: <Icon name={item.icon} size={13} /> } : {}),
                count: item.value === 'all' ? primaryItemCount : counts[item.value],
              }))}
            />
            <label className="selection-control">
              <input
                className="sr-only"
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(event) => toggleAll(event.target.checked)}
              />
              <span className="selection-box">
                {allVisibleSelected ? <Icon name="check" size={12} /> : null}
              </span>{' '}
              {uiText('E0508')}{' '}
            </label>
          </div>
        </div>

        {loading && !state ? (
          <LoadingView label={uiText('E0509')} />
        ) : showIdentified || visibleProducts.length > 0 || visibleAssets.length > 0 ? (
          <div className="media-grid">
            {showIdentified && identified ? (
              <IdentifiedVideoRow
                {...identified}
                identity={`${state?.tabId}:${state?.mediaEpoch}:${identified.id}`}
                onOpen={openIdentified}
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
              return (
                <MediaProductCard
                  key={presentation.id}
                  {...presentation}
                  platform={product.provider}
                  artworkKey={`${product.pageUrl}:${state?.mediaEpoch ?? 0}:${state?.activeMedia?.lifecycleGeneration ?? 0}`}
                  {...((currentArtwork?.url ?? presentation.poster)
                    ? { poster: currentArtwork?.url ?? presentation.poster }
                    : {})}
                  loading={downloadingProductId === product.id}
                  onQualityChange={(qualityId) =>
                    setSelectedQualityByProduct((current) => ({
                      ...current,
                      [product.id]: qualityId,
                    }))
                  }
                  onDownload={(mode) => startProductDownload(product, mode, selectedQualityId)}
                />
              );
            })}
            {visibleAssets.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                selectable={asset.downloadable}
                selected={selected.has(asset.id)}
                onSelect={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(asset.id);
                    else next.delete(asset.id);
                    return next;
                  })
                }
                {...(asset.downloadable
                  ? { onDownload: () => void startDownload([asset.id]) }
                  : asset.url.startsWith('blob:') &&
                      (asset.kind === 'video' || asset.kind === 'audio')
                    ? {
                        onResolve: () => void beginSourceCapture(asset.id),
                        resolving: resolvingAssetId === asset.id,
                      }
                    : {})}
              />
            ))}
          </div>
        ) : (
          <StateView
            icon={query ? 'search' : 'image'}
            title={
              scanning
                ? uiText('E0477')
                : query || filter !== 'all'
                  ? uiText('E0511')
                  : uiText('E0478')
            }
            description={query || filter !== 'all' ? uiText('E0512') : uiText('E0513')}
            {...(state?.status === 'error'
              ? {
                  get actionLabel() {
                    return uiText('E0514');
                  },
                  onAction: () => void scan(),
                }
              : {})}
          />
        )}

        {rawAssets.length > 0 ? (
          <details className="surface-card raw-resource-section">
            <summary>
              {uiText('E0515')}
              {rawAssets.length}）
            </summary>
            <p> {uiText('E0516')} </p>
            <div className="media-grid">
              {rawAssets.map((asset) => (
                <MediaCard key={asset.id} asset={asset} compact />
              ))}
            </div>
          </details>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <aside className="selection-bar" aria-label={uiText('E0517')}>
          <span className="selection-bar__copy">
            <strong>
              {uiText('E0518')} {selected.size} {uiText('E0474')}
            </strong>
            <span>
              {canMerge
                ? uiText('E0519')
                : uiText('E0520', {
                    p1:
                      selectedBytes > 0 ? uiText('E0521', { p1: formatBytes(selectedBytes) }) : '',
                  })}
            </span>
          </span>
          <span className="selection-bar__actions">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              {' '}
              {uiText('E0522')}{' '}
            </Button>
            <Button
              size="md"
              icon="sparkle"
              loading={mergeBusy}
              disabled={!canMerge}
              title={canMerge ? uiText('E0523') : uiText('E0524')}
              onClick={() => void createMergeJob()}
            >
              {' '}
              {uiText('E0525')}{' '}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon="download"
              loading={batchBusy}
              onClick={() => void startDownload([...selected])}
            >
              {' '}
              {uiText('E0033')}{' '}
            </Button>
          </span>
        </aside>
      ) : null}
    </main>
  );
}
