import { describe, expect, it } from 'vitest';
import { activeSampleDescriptions } from '../../src/modules/merge/sample-description';

function table(rows: number[][]): Uint8Array {
  const bytes = new Uint8Array(8 + rows.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, rows.length);
  rows.forEach((row, index) =>
    row.forEach((value, field) => view.setUint32(8 + index * 12 + field * 4, value)),
  );
  return bytes;
}

describe('active ISO-BMFF sample descriptions', () => {
  it('selects only explicitly referenced descriptions', () => {
    expect([
      ...activeSampleDescriptions(
        3,
        table([
          [1, 20, 2],
          [10, 20, 2],
        ]),
      ),
    ]).toEqual([2]);
  });
  it('keeps multiple active descriptions visible instead of guessing one', () => {
    expect([
      ...activeSampleDescriptions(
        3,
        table([
          [1, 20, 2],
          [10, 20, 3],
        ]),
      ),
    ]).toEqual([2, 3]);
    expect([...activeSampleDescriptions(2)]).toEqual([1, 2]);
    expect([...activeSampleDescriptions(2, table([]))]).toEqual([1, 2]);
  });
  it.each([
    [[0, 1, 1]],
    [[2, 1, 1]],
    [[1, 0, 1]],
    [[1, 1, 0]],
    [[1, 1, 3]],
    [
      [1, 1, 1],
      [1, 1, 2],
    ],
  ])('rejects invalid stsc row(s) %j', (...rows) => {
    expect(() => activeSampleDescriptions(2, table(rows))).toThrow();
  });
  it('rejects a truncated table', () => {
    expect(() => activeSampleDescriptions(2, table([[1, 1, 1]]).slice(0, -1))).toThrow();
  });
});
