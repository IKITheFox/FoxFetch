import { t as uiText } from './i18n';
export function createDockVariantControl(doc: Document, label: string, listId: string) {
  const root = doc.createElement('div');
  root.className = 'dock-variant-select';
  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dock-variant-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', listId);
  const value = doc.createElement('span');
  value.className = 'dock-variant-value';
  const chevron = doc.createElement('i');
  chevron.className = 'dock-variant-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  const list = doc.createElement('div');
  list.id = listId;
  list.className = 'dock-variant-list';
  list.setAttribute('popover', 'manual');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  list.hidden = true;
  root.append(trigger, list);
  return { root, trigger, value, list };
}

let sequence = 0;
/** A DOM site controller keeps the exact source value; both sites use the same control structure. */
export function mountDockVariantControl(source: HTMLSelectElement) {
  const doc = source.ownerDocument;
  const label = source.getAttribute('aria-label') ?? '';
  const display = source.style.getPropertyValue('display');
  const displayPriority = source.style.getPropertyPriority('display');
  const { root, trigger, value, list } = createDockVariantControl(
    doc,
    label,
    `foxfetch-source-choice-${++sequence}`,
  );
  source.after(root);
  source.hidden = true;
  source.style.setProperty('display', 'none', 'important');
  source.setAttribute('aria-hidden', 'true');
  source.removeAttribute('aria-label');
  let disposed = false;
  const close = (focus = false) => {
    if (typeof list.hidePopover === 'function' && list.matches(':popover-open')) list.hidePopover();
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  };
  const refresh = () => {
    if (disposed) return;
    const currentLabel = source.getAttribute('aria-label') ?? label;
    trigger.setAttribute('aria-label', currentLabel);
    list.setAttribute('aria-label', currentLabel);
    trigger.disabled = source.disabled || !source.options.length;
    const selected = Array.from(source.options).find((option) => option.value === source.value);
    value.textContent = selected?.text ?? uiText('E0016');
    value.title = value.textContent;
    const old = new Map(
      Array.from(list.children, (node) => [
        (node as HTMLElement).dataset.value,
        node as HTMLButtonElement,
      ]),
    );
    const desired = Array.from(source.options, (option) => {
      const button = old.get(option.value) ?? doc.createElement('button');
      old.delete(option.value);
      button.type = 'button';
      button.className = 'dock-variant-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === source.value));
      button.tabIndex = option.value === source.value ? 0 : -1;
      button.disabled = option.disabled;
      button.textContent = option.text;
      button.onclick = () => {
        if (disposed || source.disabled || button.disabled) return;
        source.value = option.value;
        source.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
        refresh();
        close(true);
      };
      return button;
    });
    old.forEach((node) => node.remove());
    desired.forEach((node, index) => {
      if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    });
    if (trigger.disabled) close();
  };
  const open = () => {
    if (trigger.disabled) return;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Popover uses the top layer; explicit coordinates avoid clipping by the Dock.
    if (typeof list.showPopover === 'function' && list.isConnected) {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(
        Math.max(80, rect.width),
        Math.max(1, doc.defaultView!.innerWidth - 16),
      );
      const height = Math.min(148, Math.max(32, list.scrollHeight));
      const top =
        rect.bottom + 4 + height <= doc.defaultView!.innerHeight - 8
          ? rect.bottom + 4
          : Math.max(8, rect.top - height - 4);
      Object.assign(list.style, {
        position: 'fixed',
        margin: '0',
        left: `${Math.max(8, Math.min(rect.left, doc.defaultView!.innerWidth - width - 8))}px`,
        top: `${top}px`,
        bottom: 'auto',
        width: `${width}px`,
        minWidth: `${width}px`,
        maxWidth: `${width}px`,
        boxSizing: 'border-box',
        right: 'auto',
      });
      list.showPopover();
    }
    (
      list.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ??
      list.querySelector<HTMLButtonElement>('button:not(:disabled)')
    )?.focus();
  };
  trigger.onclick = () => (list.hidden ? open() : close());
  // This site controller owns these events. The enclosing Dock delegates Bilibili actions.
  root.onclick = (event) => event.stopPropagation();
  root.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (list.hidden) {
      open();
      return;
    }
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const active = buttons.findIndex((button) => button === event.target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (active + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const outside = (event: Event) => {
    if (!event.composedPath().includes(root)) close();
  };
  doc.addEventListener('pointerdown', outside);
  const moved = () => close();
  doc.defaultView!.addEventListener('resize', moved);
  const observer = new doc.defaultView!.MutationObserver(refresh);
  observer.observe(source, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  source.addEventListener('change', refresh);
  refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    close();
    observer.disconnect();
    source.removeEventListener('change', refresh);
    doc.removeEventListener('pointerdown', outside);
    doc.defaultView!.removeEventListener('resize', moved);
    root.remove();
    source.hidden = false;
    if (display) source.style.setProperty('display', display, displayPriority);
    else source.style.removeProperty('display');
    source.removeAttribute('aria-hidden');
    source.setAttribute('aria-label', label);
  };
}
