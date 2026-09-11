import { expect, it } from 'vitest';
import { formatTaskBytes, reliableTaskTotal } from '../../src/shared/task-bytes';

it.each([
  [0, '0 B'],
  [1023, '1023 B'],
  [1024, '1 KB'],
  [1536, '1.5 KB'],
  [1048576, '1 MB'],
  [1073741824, '1 GB'],
  [NaN, '大小未知'],
  [-1, '大小未知'],
])('formats %s', (bytes, text) => {
  expect(formatTaskBytes(bytes as number)).toBe(text);
});
it('requires a positive safe total and compatible read count', () => {
  expect(reliableTaskTotal(5, 10)).toBe(10);
  for (const total of [undefined, null, 0, -1, NaN, Infinity, 4])
    expect(reliableTaskTotal(5, total)).toBeNull();
});
