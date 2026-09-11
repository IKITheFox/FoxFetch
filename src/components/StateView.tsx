import { t as uiText } from '../shared/i18n';
import { messageText } from '../shared/i18n/legacy-message';
import type { ReactNode } from 'react';

import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export interface StateViewProps {
  icon?: IconName;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
  children?: ReactNode;
}

export function StateView({
  icon = 'image',
  title,
  description,
  actionLabel,
  onAction,
  compact = false,
  children,
}: StateViewProps) {
  return (
    <div className={`state-view${compact ? ' state-view--compact' : ''}`}>
      <span className="state-view__icon">
        <Icon name={icon} size={compact ? 20 : 24} />
      </span>
      <strong>{title}</strong>
      {description ? <p>{messageText(description)}</p> : null}
      {actionLabel && onAction ? (
        <Button size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
      {children}
    </div>
  );
}

export function LoadingView({
  label = uiText('E0106'),
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={`loading-view${compact ? ' loading-view--compact' : ''}`} role="status">
      <span className="loading-orbit">
        <span />
      </span>
      <span>{label}</span>
    </div>
  );
}

export function InlineNotice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'error' | 'success';
}) {
  return (
    <div
      className={`inline-notice inline-notice--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon name={tone === 'error' ? 'error' : tone === 'success' ? 'check' : 'info'} size={16} />
      <span>{typeof children === 'string' ? messageText(children) : children}</span>
    </div>
  );
}
