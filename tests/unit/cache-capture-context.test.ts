import { describe, expect, it } from 'vitest';

import { resolveCacheCapturePageUrl } from '../../src/modules/resolver/cache-capture-context';

describe('cache capture request context', () => {
  it('uses the target tab URL for requests from the extension Popup', () => {
    expect(
      resolveCacheCapturePageUrl(
        'https://www.bilibili.com/video/BV1test',
        'chrome-extension://extension-id/popup.html',
        false,
      ),
    ).toBe('https://www.bilibili.com/video/BV1test');
  });

  it('uses the actual frame URL for requests sent by the page agent', () => {
    expect(
      resolveCacheCapturePageUrl(
        'https://www.bilibili.com/video/BV1test',
        'https://player.bilibili.com/player.html',
        true,
      ),
    ).toBe('https://player.bilibili.com/player.html');
  });
});
