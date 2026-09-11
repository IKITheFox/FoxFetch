/** Static extension-owned markup shared by the two site task presenters. */
export const mediaTaskProgressMarkup = `<div class="merge-progress-heading"><strong><span data-i18n="E1756">总进度 </span><span data-role="merge-progress-label">--</span></strong><span class="merge-state-inline"><span class="merge-state-dot" data-role="merge-state" data-state="loading" role="status" aria-label="正在准备" data-i18n-aria-label="E1800" title="正在准备" data-i18n-title="E1800"></span><span class="merge-state-label" data-role="merge-state-label" hidden><span data-i18n="E0176">保存成功</span></span></span></div><div class="merge-meter" role="progressbar" aria-label="下载任务进度" data-i18n-aria-label="E1801"><span data-role="merge-progress"></span></div>`;

/** Unknown total is not zero and must never be represented by an invented percentage. */
export function updateMediaTaskProgress(
  root: ParentNode,
  ratio: number | null,
  status: string,
  animateUnknown: boolean,
): void {
  const known = ratio !== null && Number.isFinite(ratio);
  const percent = known ? Math.min(100, Math.max(0, ratio * 100)) : 0;
  const label = root.querySelector('[data-role="merge-progress-label"]');
  if (label) label.textContent = known ? `${Math.round(percent)}%` : '--';
  const fill = root.querySelector<HTMLElement>('[data-role="merge-progress"]');
  if (fill) fill.style.width = `${percent}%`;
  const meter = root.querySelector<HTMLElement>('.merge-meter');
  if (!meter) return;
  meter.setAttribute('aria-valuetext', status);
  if (known) {
    delete meter.dataset.indeterminate;
    meter.setAttribute('aria-valuenow', String(Math.round(percent)));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
  } else {
    meter.dataset.indeterminate = String(animateUnknown);
    meter.removeAttribute('aria-valuenow');
    meter.removeAttribute('aria-valuemin');
    meter.removeAttribute('aria-valuemax');
  }
}
