import type { ReactNode, Ref } from 'react';

/** Shared visual structure only. Track selection and task ownership stay with the caller. */
export function MediaProductLayout({
  cardRef,
  titleId,
  busy,
  menuOpen = false,
  hasQualityPicker = false,
  artwork,
  children,
  actions,
  menu,
  className = '',
}: {
  cardRef?: Ref<HTMLElement>;
  titleId: string;
  busy?: boolean;
  menuOpen?: boolean;
  hasQualityPicker?: boolean;
  artwork: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  className?: string;
}) {
  return (
    <article
      ref={cardRef}
      className={`media-product-card${menuOpen ? ' is-menu-open' : ''}${hasQualityPicker ? ' has-quality-picker' : ''} ${className}`.trim()}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      {artwork}
      <div className="media-product-card__body">{children}</div>
      {actions == null ? null : <div className="media-product-card__actions">{actions}</div>}
      {menu}
    </article>
  );
}
