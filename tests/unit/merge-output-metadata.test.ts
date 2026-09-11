import { describe, expect, it, vi } from 'vitest';

import { resolveMergeMediaMetadata } from '../../src/modules/merge';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

describe('merge output metadata', () => {
  it('fetches a current-player cover without credentials and trusts image magic bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(PNG_BYTES.slice(), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );

    await expect(
      resolveMergeMediaMetadata(
        { title: '  Current video\n', coverUrl: 'https://i.example.test/cover.webp' },
        { fetch: fetchImpl },
      ),
    ).resolves.toEqual({
      title: 'Current video',
      cover: { data: PNG_BYTES, mimeType: 'image/png' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://i.example.test/cover.webp', {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    });
  });

  it('fails soft for a non-network or malformed cover while retaining the title', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      resolveMergeMediaMetadata(
        { title: 'Video title', coverUrl: 'blob:https://page.example/private' },
        { fetch: fetchImpl },
      ),
    ).resolves.toEqual({ title: 'Video title' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not accept HTML bytes even when the server declares an image', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('<html>not an image</html>', {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    await expect(
      resolveMergeMediaMetadata(
        { title: 'Video title', coverUrl: 'https://i.example.test/cover.jpg' },
        { fetch: fetchImpl },
      ),
    ).resolves.toEqual({ title: 'Video title' });
  });
});
