import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  content: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom';
}

export function Tooltip({ content, children, placement = 'bottom' }: TooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return;
    const host = trigger.current;
    const tip = bubble.current;
    const doc = host.ownerDocument;
    const win = doc.defaultView!;
    const position = () => {
      if (!host.isConnected || host.closest('[inert], [aria-hidden="true"]')) {
        setOpen(false);
        return;
      }
      const rect = host.getBoundingClientRect();
      tip.style.maxWidth = `${Math.max(80, Math.min(320, win.innerWidth - 16))}px`;
      const bounds = tip.getBoundingClientRect();
      const below = rect.bottom + 8;
      const above = rect.top - bounds.height - 8;
      const top =
        placement === 'top'
          ? above >= 8
            ? above
            : below
          : below + bounds.height <= win.innerHeight - 8
            ? below
            : above;
      tip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - bounds.width / 2, win.innerWidth - bounds.width - 8))}px`;
      tip.style.top = `${Math.max(8, Math.min(top, win.innerHeight - bounds.height - 8))}px`;
    };
    position();
    win.addEventListener('resize', position);
    doc.addEventListener('scroll', position, true);
    const observer = new MutationObserver(position);
    observer.observe(doc.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'aria-hidden'],
    });
    return () => {
      win.removeEventListener('resize', position);
      doc.removeEventListener('scroll', position, true);
      observer.disconnect();
    };
  }, [open, content, placement]);
  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');
  return (
    <span
      ref={trigger}
      className="tooltip"
      data-placement={placement}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen(false)}
    >
      {cloneElement(children, { 'aria-describedby': describedBy })}
      {open &&
        trigger.current &&
        createPortal(
          <span ref={bubble} id={id} className="tooltip__bubble tooltip__portal" role="tooltip">
            {content}
          </span>,
          trigger.current.ownerDocument.body,
        )}
    </span>
  );
}
