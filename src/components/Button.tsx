import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  trailingIcon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  icon,
  trailingIcon,
  variant = 'secondary',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} button--${size} ${className}`.trim()}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Icon name="spinner" className="spin" /> : icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
      {trailingIcon ? <Icon name={trailingIcon} /> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  active?: boolean;
  loading?: boolean;
}

export function IconButton({
  icon,
  label,
  active = false,
  loading = false,
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button${active ? ' is-active' : ''} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={loading ? 'spinner' : icon} className={loading ? 'spin' : undefined} />
    </button>
  );
}
