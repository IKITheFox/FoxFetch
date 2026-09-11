// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  fetchSabrResponse,
  safeNetworkEvents,
  type SabrNetworkEvent,
} from '../../src/modules/youtube/sources/sabr-transport';

it('does not bind an injected network function to the configuration object', async () => {
  let receiver: unknown = 'unset';
  const network: typeof fetch = async function (this: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- The receiver is the regression under test.
    receiver = this;
    return new Response('ok');
  };
  const response = await fetchSabrResponse(
    'https://example.test/media',
    {},
    {
      fetch: network,
      signal: new AbortController().signal,
      request: 1,
    },
  );
  expect(await response.text()).toBe('ok');
  expect(receiver).toBeUndefined();
});

it('reports an invocation failure once without leaking its raw message', async () => {
  const events: SabrNetworkEvent[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(
      new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation SECRET"),
    );
  await expect(
    fetchSabrResponse(
      'https://example.test/media?secret=1',
      {},
      {
        fetch,
        signal: new AbortController().signal,
        request: 1,
        onEvent: (event) => events.push(event),
      },
    ),
  ).rejects.toThrow('SABR_INVOCATION_FAILED');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(safeNetworkEvents(events)[0]?.code).toBe('SABR_INVOCATION_FAILED');
  expect(JSON.stringify(events)).not.toMatch(/SECRET|secret=1/);
});
