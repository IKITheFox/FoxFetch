/** Shared save-location dialog; controllers retain permission and persistence ownership. */
export const mediaLocationDialogMarkup = `<div class="merge-path-layer" data-role="merge-path-picker" role="dialog" aria-modal="true" aria-labelledby="foxfetch-path-picker-title" hidden>
  <button class="merge-path-backdrop" type="button" data-action="cancel-merge-path" aria-label="取消选择保存位置" data-i18n-aria-label="E1788"></button>
  <div class="merge-path-dialog">
    <div class="merge-path-dialog-head">
      <strong id="foxfetch-path-picker-title"><span data-i18n="E1249">选择保存位置</span></strong>
      <button class="icon-button" type="button" data-action="cancel-merge-path" aria-label="关闭保存位置选择" data-i18n-aria-label="E1789">×</button>
    </div>
    <button class="merge-path-choice" type="button" data-action="select-merge-path" data-path-mode="automatic" aria-pressed="false">
      <span class="merge-path-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 17v2h14v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="merge-path-choice-copy"><strong><span data-i18n="E1790">默认位置</span></strong><small data-role="merge-default-path">Downloads/FoxFetch/当前平台</small></span>
      <span class="merge-path-choice-check" aria-hidden="true">✓</span>
    </button>
    <button class="merge-path-choice" type="button" data-action="select-merge-path" data-path-mode="ask" aria-pressed="false">
      <span class="merge-path-choice-icon" aria-hidden="true">↳</span>
      <span class="merge-path-choice-copy"><strong><span data-i18n="E0417">保存时选择位置</span></strong><small><span data-i18n="E1736">文件准备完成后打开浏览器保存窗口</span></small></span>
      <span class="merge-path-choice-check" aria-hidden="true">✓</span>
    </button>
    <div class="merge-path-steps" hidden><button type="button" data-location-step="-1" aria-label="上一种保存方式" data-i18n-aria-label="E1792"><span data-i18n="E1793">上一项</span></button><span aria-live="polite"></span><button type="button" data-location-step="1" aria-label="下一种保存方式" data-i18n-aria-label="E1794"><span data-i18n="E1795">下一项</span></button></div>
  </div>
</div>`;

export function createMediaLocationDialog(doc: Document) {
  const template = doc.createElement('template');
  template.innerHTML = mediaLocationDialogMarkup;
  const root = template.content.firstElementChild as HTMLElement;
  const title = root.querySelector<HTMLElement>('.merge-path-dialog-head strong')!;
  title.id = `foxfetch-location-${crypto.randomUUID()}`;
  root.setAttribute('aria-labelledby', title.id);
  const choices = Array.from(root.querySelectorAll<HTMLButtonElement>('.merge-path-choice'));
  const close = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-action="cancel-merge-path"]'),
  );
  for (const node of [root, ...root.querySelectorAll<HTMLElement>('[data-role], [data-action]')]) {
    node.removeAttribute('data-role');
    node.removeAttribute('data-action');
  }
  return { root, choices, close, body: root.querySelector<HTMLElement>('.merge-path-dialog')! };
}

const layouts = new WeakMap<HTMLElement, { update: () => void; observer?: ResizeObserver }>();
/** The same measured layout is used in the Dock and the extension surfaces. */
export function updateMediaLocationLayout(root: HTMLElement): void {
  const existing = layouts.get(root);
  if (existing) {
    existing.update();
    return;
  }
  const choices = [...root.querySelectorAll<HTMLButtonElement>('.merge-path-choice')];
  const steps = root.querySelector<HTMLElement>('.merge-path-steps')!;
  let index = 0;
  let wasHidden = true;
  const update = () => {
    if (root.hidden) {
      wasHidden = true;
      return;
    }
    if (wasHidden) {
      index = Math.max(
        0,
        choices.findIndex((c) => c.getAttribute('aria-pressed') === 'true'),
      );
      root.scrollTop = 0;
      root.querySelector('.merge-path-dialog')!.scrollTop = 0;
      wasHidden = false;
    }
    const height = root.clientHeight;
    const compact = height > 0 && height < 290;
    root.toggleAttribute('data-compact', compact);
    steps.hidden = !compact;
    choices.forEach((choice, n) =>
      choice.toggleAttribute('data-step-hidden', compact && n !== index),
    );
    steps.querySelector('span')!.textContent = `${index + 1} / ${choices.length}`;
  };
  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-location-step]');
    if (!button) return;
    event.stopPropagation();
    index = (index + Number(button.dataset.locationStep) + choices.length) % choices.length;
    update();
    choices[index]?.focus();
  });
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
  root.addEventListener('keydown', (event) => {
    // The YouTube controller already owns its trap; the static Dock uses this one.
    if (!root.hasAttribute('data-role') || root.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      root.querySelector<HTMLButtonElement>('.icon-button')?.click();
    } else if (event.key === 'Tab') {
      const buttons = [
        ...root.querySelectorAll<HTMLButtonElement>(
          '.icon-button, .merge-path-choice:not([data-step-hidden]), .merge-path-steps:not([hidden]) button',
        ),
      ].filter((b) => !b.disabled && !b.hidden);
      const tree = root.getRootNode();
      const active =
        tree instanceof ShadowRoot ? tree.activeElement : root.ownerDocument.activeElement;
      const current = buttons.indexOf(active as HTMLButtonElement);
      event.preventDefault();
      event.stopPropagation();
      buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  });
  layouts.set(root, { update, ...(observer ? { observer } : {}) });
  observer?.observe(root);
  update();
}

export function disposeMediaLocationLayout(root: HTMLElement): void {
  layouts.get(root)?.observer?.disconnect();
  layouts.delete(root);
}
