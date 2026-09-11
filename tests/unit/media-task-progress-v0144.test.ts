import { expect, it } from 'vitest';
import {
  mediaTaskProgressMarkup,
  updateMediaTaskProgress,
} from '../../src/shared/media-task-progress';

it('distinguishes unknown, zero and completed progress without stale accessibility values', () => {
  const host = document.createElement('div');
  host.innerHTML = mediaTaskProgressMarkup;
  const meter = host.querySelector<HTMLElement>('[role=progressbar]')!;
  const label = host.querySelector('[data-role=merge-progress-label]')!;
  updateMediaTaskProgress(host, 0, '等待开始', false);
  expect(label.textContent).toBe('0%');
  expect(meter.getAttribute('aria-valuenow')).toBe('0');
  updateMediaTaskProgress(host, null, '正在读取，大小未知', true);
  expect(label.textContent).toBe('--');
  expect(meter.hasAttribute('aria-valuenow')).toBe(false);
  expect(meter.dataset.indeterminate).toBe('true');
  updateMediaTaskProgress(host, NaN, '已取消', false);
  expect(meter.dataset.indeterminate).toBe('false');
  updateMediaTaskProgress(host, 1, '保存成功', false);
  expect(label.textContent).toBe('100%');
  expect(meter.getAttribute('aria-valuemax')).toBe('100');
  expect(meter.hasAttribute('data-indeterminate')).toBe(false);
});

it('updates only the specified task when both sites have a task panel', () => {
  const host = document.createElement('div');
  host.innerHTML = `<section>${mediaTaskProgressMarkup}</section><section>${mediaTaskProgressMarkup}</section>`;
  updateMediaTaskProgress(host.children[0]!, 0.32, 'B站', false);
  updateMediaTaskProgress(host.children[1]!, null, 'YouTube', true);
  expect(host.children[0]!.querySelector('[aria-valuenow]')?.getAttribute('aria-valuenow')).toBe(
    '32',
  );
  expect(host.children[1]!.querySelector('[aria-valuenow]')).toBeNull();
});
