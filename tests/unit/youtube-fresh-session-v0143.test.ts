// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readFreshYouTubeSession } from '../../src/modules/youtube/sources/fresh-session';
import type { YouTubeExecutionRequest } from '../../src/modules/youtube/offscreen-executor';
const now = 1800000000000;
const signal = () => new AbortController().signal;
function session(expire: string, direct = true): YouTubeExecutionRequest['session'] {
  const address = `https://r1.googlevideo.com/videoplayback?expire=${expire}&sig=private`;
  return (
    direct ? { kind: 'direct-file', address } : { serverAbrStreamingUrl: address }
  ) as YouTubeExecutionRequest['session'];
}
it.each([true, false])(
  're-reads an expired %s source once and returns the exact new object',
  async (direct) => {
    const fresh = session('1800000100', direct);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(session('1799999999', direct))
      .mockResolvedValue(fresh);
    expect(await readFreshYouTubeSession(resolve, signal(), () => now)).toBe(fresh);
    expect(resolve).toHaveBeenCalledTimes(2);
  },
);
it('stops after two stale results without returning an expired source', async () => {
  const resolve = vi.fn().mockResolvedValue(session('1799999999'));
  await expect(readFreshYouTubeSession(resolve, signal(), () => now)).rejects.toThrow(
    'SOURCE_ADDRESS_EXPIRED',
  );
  expect(resolve).toHaveBeenCalledTimes(2);
});
it.each(['', 'invalid', '1800000100', '1799999999&expire=1800000100'])(
  'does not infer expiry from absent, ambiguous or future hints: %s',
  async (value) => {
    const current = session(value);
    const resolve = vi.fn().mockResolvedValue(current);
    expect(await readFreshYouTubeSession(resolve, signal(), () => now)).toBe(current);
    expect(resolve).toHaveBeenCalledTimes(1);
  },
);
it('does not retry a resolver identity rejection', async () => {
  const resolve = vi.fn().mockRejectedValue(new Error('SELECTION_CHANGED'));
  await expect(readFreshYouTubeSession(resolve, signal(), () => now)).rejects.toThrow(
    'SELECTION_CHANGED',
  );
  expect(resolve).toHaveBeenCalledTimes(1);
});
it('does not re-read after cancellation during a pending resolver', async () => {
  const controller = new AbortController();
  const resolve = vi.fn(async () => {
    controller.abort();
    return session('1799999999');
  });
  await expect(readFreshYouTubeSession(resolve, controller.signal, () => now)).rejects.toThrow();
  expect(resolve).toHaveBeenCalledTimes(1);
});
