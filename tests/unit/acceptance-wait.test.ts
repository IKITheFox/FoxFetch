import { expect, it } from 'vitest';
import { acceptanceWait } from '../e2e/acceptance-wait';

it('uses a bounded slow-browser observation budget without accepting invalid values', () => {
  for (const value of ['', 'NaN', 'Infinity', '-1', '1000']) expect(acceptanceWait(value)).toBe(90000);
  expect(acceptanceWait('90000')).toBe(90000);
  expect(acceptanceWait('105000')).toBe(105000);
  expect(acceptanceWait('120000')).toBe(120000);
  expect(acceptanceWait('999999')).toBe(120000);
});
