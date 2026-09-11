import { StatusDot, type StatusDotTone } from './StatusDot';

export function MediaProductTitle({
  title,
  titleId,
  tone,
  status,
}: {
  title: string;
  titleId: string;
  tone: StatusDotTone;
  status: string;
}) {
  return (
    <span className="media-product-card__title-row">
      <strong id={titleId} title={title}>
        {title}
      </strong>
      <StatusDot tone={tone} label={status} compact iconOnly />
    </span>
  );
}
