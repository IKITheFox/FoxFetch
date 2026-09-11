export type StatusDotTone = 'idle' | 'loading' | 'ready' | 'partial' | 'error';

export interface StatusDotProps {
  tone: StatusDotTone;
  label: string;
  compact?: boolean;
  iconOnly?: boolean;
  className?: string;
}

export function StatusDot({
  tone,
  label,
  compact = false,
  iconOnly = false,
  className = '',
}: StatusDotProps) {
  return (
    <span
      className={`status-dot status-dot--${tone}${compact ? ' status-dot--compact' : ''}${iconOnly ? ' status-dot--icon-only' : ''}${className ? ` ${className}` : ''}`}
      role="status"
      aria-label={label}
      title={iconOnly ? label : undefined}
    >
      <i aria-hidden="true" />
      {iconOnly ? null : <span>{label}</span>}
    </span>
  );
}
