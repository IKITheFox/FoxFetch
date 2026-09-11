import { t as uiText } from '../shared/i18n';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';

export interface CustomSelectOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export interface CustomSelectProps {
  value: string;
  options: readonly CustomSelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  id?: string;
  leading?: ReactNode;
  preserveMissingValue?: boolean;
}

function enabledIndex(
  options: readonly CustomSelectOption[],
  from: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const candidate = (from + direction * offset + options.length) % options.length;
    if (!options[candidate]?.disabled) return candidate;
  }
  return -1;
}

/** A browser-independent, keyboard-accessible select/listbox. */
export function CustomSelect({
  value,
  options,
  onChange,
  label,
  disabled = false,
  compact = false,
  className = '',
  id,
  leading,
  preserveMissingValue = false,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom');
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wasOpenRef = useRef(false);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected =
    (selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? options[selectedIndex]
      : undefined) ??
    (preserveMissingValue ? undefined : options.find((option) => !option.disabled));
  const selectedValue = selected?.value ?? null;
  const activeIndex = options.findIndex(
    (option) => option.value === activeValue && !option.disabled,
  );

  useEffect(() => {
    if (!open) return;
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (
        rootRef.current &&
        !path.includes(rootRef.current) &&
        (!listboxRef.current || !path.includes(listboxRef.current))
      ) {
        setOpen(false);
      }
    };
    ownerDocument.addEventListener('pointerdown', onPointerDown);
    return () => ownerDocument.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;

    // Parent views rebuild option arrays during live scans. Track the active
    // option by its stable value so a semantically equivalent refresh does not
    // steal focus or reset the listbox scroll position. Reconcile only when the
    // listbox has just opened or the active option truly disappeared/disabled.
    if (!justOpened && activeIndex >= 0) return;

    const nextIndex =
      selectedValue !== null
        ? options.findIndex((option) => option.value === selectedValue && !option.disabled)
        : enabledIndex(options, -1, 1);
    const nextValue = nextIndex >= 0 ? (options[nextIndex]?.value ?? null) : null;
    if (nextValue !== activeValue) setActiveValue(nextValue);
    queueMicrotask(() => optionRefs.current[nextIndex]?.focus());
  }, [activeIndex, activeValue, open, options, selectedValue]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const listbox = listboxRef.current;
    const ownerWindow = rootRef.current?.ownerDocument.defaultView;
    if (!trigger || !listbox || !ownerWindow) return;

    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const viewport = ownerWindow.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? ownerWindow.innerWidth;
      const viewportHeight = viewport?.height ?? ownerWindow.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const margin = 8;
      const gap = 6;
      const naturalHeight = Math.max(listbox.scrollHeight, listbox.getBoundingClientRect().height);
      const requiredHeight = Math.min(220, Math.max(34, naturalHeight));
      const below = Math.max(0, viewportBottom - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - viewportTop - margin - gap);
      const nextPlacement = below < requiredHeight && above > below ? 'top' : 'bottom';
      const availableHeight = Math.max(34, nextPlacement === 'top' ? above : below);
      const maxHeight = Math.min(220, availableHeight);
      const availableWidth = Math.max(1, viewportWidth - margin * 2);
      const preferredMinWidth = Math.min(154, availableWidth);
      const width = Math.min(Math.max(rect.width, preferredMinWidth), availableWidth);
      const left = Math.min(
        Math.max(rect.left, viewportLeft + margin),
        Math.max(viewportLeft + margin, viewportRight - margin - width),
      );
      const renderedHeight = Math.min(requiredHeight, maxHeight);
      const top =
        nextPlacement === 'top'
          ? Math.max(viewportTop + margin, rect.top - gap - renderedHeight)
          : Math.min(viewportBottom - margin - renderedHeight, rect.bottom + gap);

      setPlacement(nextPlacement);
      setFloatingStyle({
        left,
        top,
        width,
        maxHeight,
      });
    };

    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(trigger);
    ownerWindow.addEventListener('resize', place);
    ownerWindow.addEventListener('scroll', place, true);
    ownerWindow.visualViewport?.addEventListener('resize', place);
    ownerWindow.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', place);
      ownerWindow.removeEventListener('scroll', place, true);
      ownerWindow.visualViewport?.removeEventListener('resize', place);
      ownerWindow.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, options]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const move = (direction: 1 | -1) => {
    const nextIndex = enabledIndex(options, activeIndex, direction);
    if (nextIndex < 0) return;
    setActiveValue(options[nextIndex]?.value ?? null);
    optionRefs.current[nextIndex]?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveValue(selectedValue);
      setOpen(true);
    }
  };

  const onListboxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const start = event.key === 'Home' ? -1 : 0;
      const nextIndex = enabledIndex(options, start, event.key === 'Home' ? 1 : -1);
      setActiveValue(options[nextIndex]?.value ?? null);
      optionRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`custom-select${compact ? ' custom-select--compact' : ''}${className ? ` ${className}` : ''}`}
      data-open={open ? 'true' : 'false'}
      data-placement={placement}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="custom-select__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setActiveValue(selectedValue);
          setOpen(true);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {leading ? <span className="custom-select__leading">{leading}</span> : null}
        <span className="custom-select__value" title={selected?.label}>
          {selected?.label ?? (preserveMissingValue && value ? uiText('E0016') : uiText('E0017'))}
        </span>
        <Icon name="chevron-down" size={14} className="custom-select__chevron" />
      </button>

      {open && rootRef.current?.ownerDocument.body
        ? createPortal(
            <div
              ref={listboxRef}
              id={listboxId}
              className="custom-select__listbox custom-select__listbox--portal"
              data-placement={placement}
              role="listbox"
              contentEditable={false}
              aria-label={label}
              style={{ ...floatingStyle, visibility: floatingStyle ? 'visible' : 'hidden' }}
              onKeyDown={onListboxKeyDown}
            >
              {options.map((option, index) => (
                <button
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  key={option.value}
                  type="button"
                  className="custom-select__option"
                  role="option"
                  aria-selected={option.value === selectedValue}
                  disabled={option.disabled}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onMouseEnter={() => setActiveValue(option.value)}
                  onClick={() => choose(index)}
                >
                  <span className="custom-select__option-copy">
                    <strong>{option.label}</strong>
                    {option.detail ? <small>{option.detail}</small> : null}
                  </span>
                  {option.value === value ? <Icon name="check" size={14} /> : null}
                </button>
              ))}
            </div>,
            rootRef.current.ownerDocument.body,
          )
        : null}
    </div>
  );
}
