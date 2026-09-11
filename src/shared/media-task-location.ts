/** Shared save-location trigger; site controllers bind their own directory flow. */
export const mediaTaskLocationMarkup = `<button class="merge-path" type="button" data-merge-action="change-path" aria-label="更改保存位置" data-i18n-aria-label="E1797">
  <span class="merge-path-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
  <span class="merge-path-copy"><span><span data-i18n="E1732">保存位置</span></span><strong data-role="merge-path">Downloads/FoxFetch/web</strong></span>
  <em data-role="merge-path-action"><span data-i18n="E1799">更改</span></em>
</button>`;
