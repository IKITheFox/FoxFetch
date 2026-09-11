import { afterEach, expect, it, vi } from 'vitest';
import { installYouTubeOffscreenExecutor } from '../../src/entrypoints/offscreen/youtube-executor';

afterEach(() => vi.unstubAllGlobals());
function listener() {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension',
      getURL: (path: string) => `chrome-extension://extension/${path}`,
      onMessage: { addListener },
    },
  });
  installYouTubeOffscreenExecutor();
  return addListener.mock.calls[0]![0] as (
    command: unknown,
    sender: unknown,
    respond: (value: unknown) => void,
  ) => boolean;
}
const command = {
  channel: 'foxfetch-youtube-execution-v1',
  target: 'offscreen',
  type: 'STATUS',
  jobId: '11111111-1111-4111-8111-111111111111',
};
it.each([
  { id: 'extension', tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  { id: 'other', url: 'chrome-extension://extension/background.js' },
  { id: 'extension', url: 'chrome-extension://extension/popup.html' },
  { id: 'extension', url: 'chrome-extension://extension/background.js/other' },
])('rejects commands outside the owning background worker: %j', (sender) => {
  for (const type of [
    'STATUS',
    'REFRESH',
    'SAVE_DIRECTORY',
    'CANCEL_DIRECTORY',
    'RECHECK_DIRECTORY',
    'RETRY_DIRECTORY',
  ]) {
    const respond = vi.fn();
    expect(listener()({ ...command, type }, sender, respond)).toBe(false);
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'UNTRUSTED_EXECUTION_SENDER' });
  }
});
it('routes a trusted refresh to the executor without permitting an unknown job', async () => {
  const respond = vi.fn();
  expect(
    listener()(
      { ...command, type: 'REFRESH', plan: {}, session: {} },
      { id: 'extension', url: 'chrome-extension://extension/background.js' },
      respond,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'YOUTUBE_EXECUTION_REJECTED' }),
  );
});
it('accepts status from the exact background and does not expose unrelated jobs', async () => {
  const respond = vi.fn();
  expect(
    listener()(
      command,
      { id: 'extension', url: 'chrome-extension://extension/background.js' },
      respond,
    ),
  ).toBe(true);
  await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true, status: null }));
});
it('rejects directory retry for a job without an owned saved target', async () => {
  const respond = vi.fn();
  expect(
    listener()(
      { ...command, type: 'RETRY_DIRECTORY', attempt: 1 },
      { id: 'extension', url: 'chrome-extension://extension/background.js' },
      respond,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'YOUTUBE_EXECUTION_REJECTED' }),
  );
});
it('leaves the existing Bilibili offscreen channel untouched', () => {
  const respond = vi.fn();
  expect(listener()({ ...command, channel: 'foxfetch-merge-offscreen-v1' }, {}, respond)).toBe(
    false,
  );
  expect(respond).not.toHaveBeenCalled();
});
