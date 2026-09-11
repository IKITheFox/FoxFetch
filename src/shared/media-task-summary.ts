/** Shared task header. Each site binds its own title and preview without page HTML. */
export const mediaTaskSummaryMarkup = `<div class="merge-summary">
  <span class="merge-summary-copy">
    <small><span data-i18n="E0021">视频</span></small>
    <strong data-role="merge-title"><span data-i18n="E1210">正在准备完整视频</span></strong>
  </span>
  <span class="merge-summary-preview" data-role="merge-preview" role="img" aria-label="当前视频封面" data-i18n-aria-label="E0015"></span>
</div>`;

export function createMediaTaskSummary(doc: Document, title: string) {
  const template = doc.createElement('template');
  template.innerHTML = mediaTaskSummaryMarkup;
  const root = template.content.firstElementChild as HTMLElement;
  const heading = root.querySelector<HTMLElement>('[data-role="merge-title"]')!;
  const preview = root.querySelector<HTMLElement>('[data-role="merge-preview"]')!;
  heading.textContent = heading.title = title;
  // Do not let the Bilibili controller update another site's task.
  heading.removeAttribute('data-role');
  preview.removeAttribute('data-role');
  return { root, heading, preview };
}
