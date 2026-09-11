// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { YouTubeContextObservationPool } from '../../src/modules/youtube/sources/context-observation-pool';

afterEach(() => vi.useRealTimers());
const owner = {
  tabId: 1,
  documentId: 'doc',
  pageUrl: 'https://www.youtube.com/watch?v=-xJFOwv4DPc',
};
function fixture() {
  vi.useFakeTimers();
  const observations: Array<{ close: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn> }> =
    [];
  const create = vi.fn(() => {
    const entry = { close: vi.fn(), listen: vi.fn(() => () => {}) };
    observations.push(entry);
    return entry;
  });
  return { pool: new YouTubeContextObservationPool(create), observations, create };
}
it('retains the existing observer across repeated inspections, then transfers it to download', () => {
  const f = fixture();
  f.pool.warm(owner);
  f.pool.warm(owner);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.pool.take(owner)).toBe(f.observations[0]);
  expect(f.pool.take(owner)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.observations[0]!.close).not.toHaveBeenCalled();
});
it.each(['documentId', 'pageUrl'] as const)(
  'rejects changed %s and closes old request memory',
  (key) => {
    const f = fixture();
    f.pool.warm(owner);
    expect(f.pool.take({ ...owner, [key]: 'different' })).toBeUndefined();
    expect(f.observations[0]!.close).toHaveBeenCalledTimes(1);
  },
);
it('expires at two minutes even if inspection repeats', async () => {
  const f = fixture();
  f.pool.warm(owner);
  await vi.advanceTimersByTimeAsync(100000);
  f.pool.warm(owner);
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.pool.take(owner)).toBeUndefined();
  expect(f.observations[0]!.close).toHaveBeenCalledTimes(1);
});
it('limits open observers and clears them on permission removal', () => {
  const f = fixture();
  for (let tabId = 1; tabId <= 5; tabId++) f.pool.warm({ ...owner, tabId });
  expect(f.observations[0]!.close).toHaveBeenCalledTimes(1);
  f.pool.clearAll();
  expect(f.observations.every((o) => o.close.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
