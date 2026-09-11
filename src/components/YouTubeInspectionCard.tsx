import { t as uiText } from '../shared/i18n';
import { useEffect, useId, useRef } from 'react';
import { youTubeStatusText, type YouTubeInspection } from '../modules/youtube/inspection';
import { disposeYouTubeInspection, renderYouTubeInspection } from '../modules/youtube/presentation';
import { MediaProductArtwork } from './MediaProductArtwork';
import { MediaProductTitle } from './MediaProductTitle';
import { MediaProductLayout } from './MediaProductLayout';
import { setYouTubeSelectionRefreshing } from '../modules/youtube/selection-view';

export function YouTubeInspectionCard({
  view,
  tabId,
  refreshing = false,
}: {
  view: YouTubeInspection;
  tabId: number;
  refreshing?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const qualityRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (ref.current) setYouTubeSelectionRefreshing(ref.current, refreshing);
  }, [refreshing]);
  useEffect(() => {
    const host = ref.current;
    const header = host
      ?.closest('.app-shell')
      ?.querySelector<HTMLElement>('header .topbar__actions');
    if (host)
      renderYouTubeInspection(
        host,
        view,
        { downloads: true, tabId },
        {
          resourceHeader: false,
          sharedControls: true,
          ...(qualityRef.current ? { qualityHost: qualityRef.current } : {}),
          ...(cardRef.current ? { resourceCard: cardRef.current } : {}),
          ...(actionRef.current ? { actionHost: actionRef.current } : {}),
          ...(header ? { taskBackHost: header } : {}),
        },
      );
  }, [view, tabId]);
  useEffect(() => {
    const host = ref.current;
    return () => {
      if (host) disposeYouTubeInspection(host);
    };
  }, []);
  return (
    <section className="surface-card" style={{ padding: 20 }} aria-label={uiText('E0111')}>
      <MediaProductLayout
        cardRef={cardRef}
        actions={<div ref={actionRef} />}
        titleId={titleId}
        hasQualityPicker={
          view.status === 'identified' && view.pageType === 'watch' && view.candidates.length > 0
        }
        artwork={
          <MediaProductArtwork
            source="youtube"
            {...(view.thumbnail === undefined ? {} : { poster: view.thumbnail })}
            {...(view.videoId === undefined ? {} : { artworkKey: view.videoId })}
            {...(view.duration === undefined ? {} : { duration: view.duration })}
          />
        }
      >
        <MediaProductTitle
          title={view.title ?? uiText('E0112')}
          titleId={titleId}
          tone={
            view.status === 'identified'
              ? 'partial'
              : view.status === 'unplayable'
                ? 'error'
                : 'idle'
          }
          status={youTubeStatusText(view)}
        />
        <div ref={qualityRef} className="media-product-card__quality-grid" />
      </MediaProductLayout>
      <div ref={ref} />
    </section>
  );
}
