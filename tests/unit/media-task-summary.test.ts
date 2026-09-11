import { expect, it } from 'vitest';
import {
  createMediaTaskSummary,
  mediaTaskSummaryMarkup,
} from '../../src/shared/media-task-summary';

it('preserves the Bilibili task title and preview binding contract', () => {
  const host = document.createElement('div');
  host.innerHTML = mediaTaskSummaryMarkup;
  expect(host.querySelectorAll('.merge-summary')).toHaveLength(1);
  expect(host.querySelector('[data-role="merge-title"]')!.textContent).toBe('正在准备完整视频');
  expect(host.querySelector('[data-role="merge-preview"]')!.getAttribute('aria-label')).toBe(
    '当前视频封面',
  );
});

it('uses the same structure with a safe title and no cross-site controller attributes', () => {
  const title = '<img src=x onerror=alert(1)> & 视频';
  const summary = createMediaTaskSummary(document, title);
  expect(summary.heading.textContent).toBe(title);
  expect(summary.heading.title).toBe(title);
  expect(summary.root.querySelector('img')).toBeNull();
  expect(summary.root.querySelector('[data-role]')).toBeNull();
  expect(summary.root.className).toBe('merge-summary');
  expect(summary.preview.className).toBe('merge-summary-preview');
});
