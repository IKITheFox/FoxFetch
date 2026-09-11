import { Icon } from './Icon';

export interface BrandProps {
  compact?: boolean;
  subtitle?: string;
}

export function FoxMark({ size = 34 }: { size?: number }) {
  return (
    <span className="fox-mark" style={{ width: size, height: size }} aria-hidden="true">
      <img
        className="fox-mark__image fox-mark__image--light"
        src="/icons/foxfetch.svg"
        alt=""
        draggable={false}
      />
      <img
        className="fox-mark__image fox-mark__image--dark"
        src="/icons/foxfetch-dark.svg"
        alt=""
        draggable={false}
      />
    </span>
  );
}

export function Brand({ compact = false, subtitle }: BrandProps) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`}>
      <FoxMark size={compact ? 30 : 36} />
      <span className="brand__copy">
        <span className="brand__name" aria-label="FoxFetch">
          <span className="brand__fox" aria-hidden="true">
            Fox
          </span>
          <span className="brand__fetch" aria-hidden="true">
            Fetch
          </span>
        </span>
        {!compact && subtitle ? <span className="brand__subtitle">{subtitle}</span> : null}
      </span>
      {!compact ? (
        <span className="brand__spark">
          <Icon name="sparkle" size={13} />
        </span>
      ) : null}
    </div>
  );
}
