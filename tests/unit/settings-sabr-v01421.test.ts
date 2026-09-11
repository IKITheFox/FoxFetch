// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  fetchSabrResponse,
  safeNetworkEvents,
  waitForSabrRetry,
  type SabrNetworkEvent,
} from '../../src/modules/youtube/sources/sabr-transport';
import { issueSettingsFrame, verifySettingsFrame } from '../../src/modules/settings-frame-session';
import { openSettingsPage } from '../../src/modules/settings-entry';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const url = 'https://r1.googlevideo.com/videoplayback?sig=DO_NOT_LOG';
it('classifies confirmed timeouts separately from network errors', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const timer = new AbortController();
    setTimeout(() => timer.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return timer.signal;
  });
  const events: SabrNetworkEvent[] = [];
  const network = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new TypeError('DO_NOT_LOG')), {
          once: true,
        });
      }),
  );
  const result = fetchSabrResponse(
    url,
    {},
    {
      fetch: network,
      request: 1,
      timeoutMs: 10,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    },
  );
  const assertion = expect(result).rejects.toThrow('SABR_TIMEOUT');
  await vi.advanceTimersByTimeAsync(3540);
  await assertion;
  expect(events.every((e) => e.code === 'SABR_TIMEOUT')).toBe(true);
  expect(network).toHaveBeenCalledTimes(4);
});
it('retries before response then returns exactly one body', async () => {
  vi.useFakeTimers();
  const network = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('secret URL'))
    .mockResolvedValue(new Response('abc'));
  const events: SabrNetworkEvent[] = [];
  const result = fetchSabrResponse(
    url,
    {},
    {
      fetch: network,
      request: 1,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    },
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await (await result).text()).toBe('abc');
  expect(network).toHaveBeenCalledTimes(2);
  expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  expect(JSON.stringify(events)).not.toMatch(/DO_NOT_LOG|secret URL/);
  expect(network.mock.calls[0]![1]!.redirect).toBe('error');
});
it('stops after four attempts without exposing raw errors', async () => {
  vi.useFakeTimers();
  const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('DO_NOT_LOG'));
  const result = fetchSabrResponse(
    url,
    {},
    { fetch: network, request: 1, signal: new AbortController().signal },
  );
  const assertion = expect(result).rejects.toThrow('SABR_NETWORK_FAILED');
  await vi.advanceTimersByTimeAsync(3500);
  await assertion;
  expect(network).toHaveBeenCalledTimes(4);
});
it.each([401, 403, 410, 302])('does not retry HTTP %i', async (status) => {
  const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('error', { status }));
  await expect(
    fetchSabrResponse(
      url,
      {},
      { fetch: network, request: 1, signal: new AbortController().signal },
    ),
  ).rejects.toThrow(`SOURCE_HTTP_${status}`);
  expect(network).toHaveBeenCalledTimes(1);
});
it.each([429, 503])('retries transient HTTP %i with a finite budget', async (status) => {
  vi.useFakeTimers();
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('retry', { status, headers: { 'retry-after': '1' } }))
    .mockResolvedValue(new Response('ok'));
  const result = fetchSabrResponse(
    url,
    {},
    { fetch: network, request: 1, signal: new AbortController().signal },
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(network).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await result).text()).toBe('ok');
});
it('does not retry before a long server delay', async () => {
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '90' } }));
  await expect(
    fetchSabrResponse(
      url,
      {},
      { fetch: network, request: 1, signal: new AbortController().signal },
    ),
  ).rejects.toThrow('SOURCE_HTTP_429');
  expect(network).toHaveBeenCalledTimes(1);
});
it('cancels during backoff without another request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('network'));
  const result = fetchSabrResponse(
    url,
    {},
    { fetch: network, request: 1, signal: controller.signal },
  );
  const assertion = expect(result).rejects.toThrow('SABR_ABORTED');
  await vi.advanceTimersByTimeAsync(100);
  controller.abort();
  await assertion;
  await vi.advanceTimersByTimeAsync(4000);
  expect(network).toHaveBeenCalledTimes(1);
});
it('cancels an already aborted wait immediately', async () => {
  await expect(waitForSabrRetry(30000, AbortSignal.abort())).rejects.toThrow('SABR_ABORTED');
});
it('does not replay an interrupted response body', async () => {
  const network = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        pull(c) {
          c.error(new Error('DO_NOT_LOG'));
        },
      }),
    ),
  );
  const events: SabrNetworkEvent[] = [];
  const result = await fetchSabrResponse(
    url,
    {},
    {
      fetch: network,
      request: 1,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    },
  );
  await expect(result.text()).rejects.toThrow('SABR_BODY_INTERRUPTED');
  expect(network).toHaveBeenCalledTimes(1);
  expect(events.at(-1)?.phase).toBe('body');
});
it('stops immediately for confirmed missing permission without requesting it', async () => {
  const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network'));
  await expect(
    fetchSabrResponse(
      url,
      {},
      {
        fetch: network,
        request: 1,
        signal: new AbortController().signal,
        checkPermission: async () => false,
      },
    ),
  ).rejects.toThrow('SABR_PERMISSION_REQUIRED');
  expect(network).toHaveBeenCalledTimes(1);
});
it('drops extra fields and malformed error codes from diagnostic events', () => {
  const event = {
    request: 1,
    attempt: 1,
    phase: 'request' as const,
    elapsedMs: 10,
    code: url,
    url,
  };
  const result = safeNetworkEvents(Array(20).fill(event));
  expect(result).toHaveLength(16);
  expect(JSON.stringify(result)).not.toContain('googlevideo');
  expect(safeNetworkEvents([{ ...event, attempt: 8 }])).toEqual([]);
});

function mockChrome() {
  const values: Record<string, unknown> = {};
  const chrome = {
    runtime: { id: 'test', getURL: (p: string) => `chrome-extension://test/${p}` },
    tabs: {
      get: vi.fn().mockResolvedValue({ url: 'https://www.youtube.com/watch?v=abcdefghijk' }),
      create: vi.fn(),
    },
    storage: {
      session: {
        set: async (data: Record<string, unknown>) => Object.assign(values, data),
        get: async () => values,
        remove: async (key: string) => {
          delete values[key];
        },
      },
    },
  };
  vi.stubGlobal('chrome', chrome);
  return chrome;
}
it('binds a settings token to its exact tab and first frame document', async () => {
  mockChrome();
  const token = await issueSettingsFrame(7);
  const sender = {
    id: 'test',
    url: `chrome-extension://test/settings-float.html?token=${token}`,
    documentId: 'doc1',
    tab: { id: 7 },
  } as chrome.runtime.MessageSender;
  expect(await verifySettingsFrame({ ...sender, tab: { id: 8 } as chrome.tabs.Tab })).toBe(false);
  expect(await verifySettingsFrame(sender)).toBe(true);
  expect(await verifySettingsFrame({ ...sender, documentId: 'doc2' })).toBe(false);
  expect(await verifySettingsFrame({ ...sender, url: 'https://evil.test' })).toBe(false);
});
it('routes settings only to the supplied tab without opening a new tab', async () => {
  const chrome = mockChrome();
  const dispatch = vi.fn().mockResolvedValue({ ok: true });
  expect(await openSettingsPage(undefined, 7, dispatch)).toEqual({ opened: true });
  expect(dispatch.mock.calls[0]![0]).toBe(7);
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  chrome.tabs.get.mockResolvedValue({ url: 'chrome://extensions' });
  expect(await openSettingsPage(undefined, 7, dispatch)).toEqual({ opened: false });
});
