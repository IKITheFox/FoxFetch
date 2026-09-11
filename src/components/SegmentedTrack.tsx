import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedTrackOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface SegmentedTrackProps<T extends string> {
  value: T;
  options: readonly SegmentedTrackOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}

export function SegmentedTrack<T extends string>({
  value,
  options,
  onChange,
  label,
  className = '',
}: SegmentedTrackProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const style = {
    '--segment-count': Math.max(1, options.length),
    '--segment-index': selectedIndex,
  } as CSSProperties;

  const move = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    let nextIndex =
      event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : currentIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      if (event.key !== 'Home' && event.key !== 'End') {
        nextIndex = (nextIndex + direction + options.length) % options.length;
      }
      const option = options[nextIndex];
      if (option && !option.disabled) {
        onChange(option.value);
        buttonRefs.current[nextIndex]?.focus();
        return;
      }
      if (event.key === 'Home') nextIndex += 1;
      if (event.key === 'End') nextIndex -= 1;
    }
  };

  return (
    <div
      className={`segmented-track${className ? ` ${className}` : ''}`}
      style={style}
      role="tablist"
      aria-label={label}
    >
      <span className="segmented-track__thumb" aria-hidden="true" />
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            key={option.value}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={active ? 'is-active' : ''}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.icon ? <span className="segmented-track__icon">{option.icon}</span> : null}
            <span className="segmented-track__label">{option.label}</span>
            {option.count != null ? <em>{option.count}</em> : null}
          </button>
        );
      })}
    </div>
  );
}
