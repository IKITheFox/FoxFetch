import { t as uiText } from '../shared/i18n';
import { forwardRef, type KeyboardEventHandler } from 'react';

import { Icon } from './Icon';

export interface SplitDownloadButtonProps {
  label?: string;
  loading?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  menuButtonId?: string;
  showLabel?: boolean;
  onPrimaryClick: () => void;
  onMenuToggle: () => void;
  onMenuKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
}

export const SplitDownloadButton = forwardRef<HTMLButtonElement, SplitDownloadButtonProps>(
  function SplitDownloadButton(
    {
      label = uiText('E0033'),
      loading = false,
      disabled = false,
      expanded = false,
      controls,
      menuButtonId,
      showLabel = false,
      onPrimaryClick,
      onMenuToggle,
      onMenuKeyDown,
    },
    menuButtonRef,
  ) {
    return (
      <span className={`split-download${showLabel ? ' split-download--labelled' : ''}`}>
        <button
          type="button"
          className="split-download__primary"
          aria-label={loading ? uiText('E0102', { p1: label }) : label}
          title={loading ? uiText('E0103') : label}
          disabled={disabled || loading}
          onClick={onPrimaryClick}
        >
          <Icon
            name={loading ? 'spinner' : 'download'}
            size={17}
            className={loading ? 'spin' : undefined}
          />
          {showLabel ? <span>{label}</span> : null}
        </button>
        <button
          ref={menuButtonRef}
          id={menuButtonId}
          type="button"
          className="split-download__menu"
          aria-label={loading ? uiText('E0102', { p1: label }) : uiText('E0104', { p1: label })}
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? controls : undefined}
          title={uiText('E0105')}
          disabled={disabled || loading}
          onClick={onMenuToggle}
          onKeyDown={onMenuKeyDown}
        >
          <Icon name="chevron-down" size={13} />
        </button>
      </span>
    );
  },
);
