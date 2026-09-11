import { createRoot } from 'react-dom/client';
import { CustomSelect } from './CustomSelect';

/** Data-only native selection bridges an existing controller to the shared UI.
 * The owner must dispose this mount before replacing the panel.
 */
export function mountCustomSelect(source: HTMLSelectElement) {
  const doc = source.ownerDocument;
  const label = source.getAttribute('aria-label') ?? '';
  const display = source.style.getPropertyValue('display');
  const displayPriority = source.style.getPropertyPriority('display');
  const target = doc.createElement('div');
  source.after(target);
  source.hidden = true;
  source.style.setProperty('display', 'none', 'important');
  source.setAttribute('aria-hidden', 'true');
  source.removeAttribute('aria-label');
  source.tabIndex = -1;
  const root = createRoot(target);
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    root.render(
      <CustomSelect
        compact
        preserveMissingValue
        label={source.getAttribute('aria-label') ?? label}
        value={source.value}
        disabled={source.disabled}
        options={Array.from(source.options, (option) => ({
          value: option.value,
          label: option.text,
          disabled: option.disabled,
        }))}
        onChange={(value) => {
          if (disposed || source.disabled) return;
          source.value = value;
          source.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
          refresh();
        }}
      />,
    );
  };
  const observer = new doc.defaultView!.MutationObserver(refresh);
  observer.observe(source, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  source.addEventListener('change', refresh);
  refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    source.removeEventListener('change', refresh);
    // The owner can dispose during its own React commit. Detach synchronously,
    // then release this independent root after the parent commit has finished.
    queueMicrotask(() => root.unmount());
    target.remove();
    source.hidden = false;
    if (display) source.style.setProperty('display', display, displayPriority);
    else source.style.removeProperty('display');
    source.removeAttribute('aria-hidden');
    source.removeAttribute('tabindex');
    source.setAttribute('aria-label', label);
  };
}
