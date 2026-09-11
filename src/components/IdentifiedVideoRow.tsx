import { t as uiText } from '../shared/i18n';
import { useId } from 'react';
import { MediaProductLayout } from './MediaProductLayout';
import { MediaProductArtwork } from './MediaProductArtwork';
import { MediaProductTitle } from './MediaProductTitle';
import { IconButton } from './Button';

/** Navigation-only row: deliberately has no quality controls or batch selection. */
export function IdentifiedVideoRow({
  title,
  source,
  poster,
  duration,
  identity,
  onOpen,
  busy = false,
}: {
  title: string;
  source: string;
  poster?: string | undefined;
  duration?: number | undefined;
  identity: string;
  onOpen: () => void;
  busy?: boolean;
}) {
  const titleId = useId();
  return (
    <MediaProductLayout
      titleId={titleId}
      busy={busy}
      className="identified-video-row"
      artwork={
        <MediaProductArtwork
          source={source}
          {...(poster ? { poster } : {})}
          {...(duration === undefined ? {} : { duration })}
          artworkKey={identity}
        />
      }
      actions={
        <IconButton icon="download" label={uiText('E0018')} disabled={busy} onClick={onOpen} />
      }
    >
      <MediaProductTitle title={title} titleId={titleId} tone="partial" status={uiText('E0019')} />
    </MediaProductLayout>
  );
}
