import { expect, it } from 'vitest';
import {
  createMediaLocationDialog,
  mediaLocationDialogMarkup,
} from '../../src/shared/media-location-dialog';
it('retains the Bilibili directory binding contract', () => {
  const host = document.createElement('div');
  host.innerHTML = mediaLocationDialogMarkup;
  expect(host.querySelectorAll('[data-action="select-merge-path"]')).toHaveLength(2);
  expect(host.querySelectorAll('[data-action="cancel-merge-path"]')).toHaveLength(2);
  expect(
    host.querySelector('[data-role="merge-path-picker"]')!.getAttribute('aria-labelledby'),
  ).toBe('foxfetch-path-picker-title');
  expect(host.querySelector<HTMLElement>('[data-path-mode="ask"]')!.hidden).toBe(false);
  expect(host.querySelector('[data-path-mode="remembered"]')).toBeNull();
});
it('isolates instances and strips cross-site action bindings', () => {
  const first = createMediaLocationDialog(document);
  const second = createMediaLocationDialog(document);
  expect(first.root.getAttribute('aria-labelledby')).not.toBe(
    second.root.getAttribute('aria-labelledby'),
  );
  expect(first.root.querySelector('[data-action], [data-role]')).toBeNull();
  expect(first.root.hasAttribute('data-role')).toBe(false);
  expect(first.choices).toHaveLength(2);
  expect(first.root.querySelector('[data-path-mode="custom"]')).toBeNull();
  expect(first.close).toHaveLength(2);
});
