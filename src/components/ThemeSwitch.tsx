import type { ThemeMode } from '../shared/types';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { t } from '../shared/i18n';
import { useLanguage } from '../hooks/useLanguage';

const themeMeta: Record<ThemeMode, { label: string; icon: 'system' | 'sun' | 'moon' }> = {
  auto: { label: '跟随系统', icon: 'system' },
  light: { label: '浅色', icon: 'sun' },
  dark: { label: '深色', icon: 'moon' },
};

const nextTheme: Record<ThemeMode, ThemeMode> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
};

export interface ThemeCycleButtonProps {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  disabled?: boolean;
  className?: string;
}

/** A single square button that cycles system → light → dark. */
export function ThemeCycleButton({
  value,
  onChange,
  disabled = false,
  className = '',
}: ThemeCycleButtonProps) {
  useLanguage();
  const current = themeMeta[value];
  const next = nextTheme[value];
  const description = t(`theme.${value}`);
  return (
    <Tooltip content={description}>
      <button
        type="button"
        className={`icon-button theme-cycle-button${className ? ` ${className}` : ''}`}
        aria-label={description}
        disabled={disabled}
        onClick={() => onChange(next)}
      >
        <Icon name={current.icon} size={17} />
      </button>
    </Tooltip>
  );
}

/** @deprecated Use ThemeCycleButton; retained for source compatibility. */
export interface ThemeSwitchProps extends ThemeCycleButtonProps {
  compact?: boolean;
}

/** @deprecated Use ThemeCycleButton. */
export function ThemeSwitch({ compact: _compact, ...props }: ThemeSwitchProps) {
  return <ThemeCycleButton {...props} />;
}
