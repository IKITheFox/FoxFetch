import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { inlineImageDigest } from '../../src/modules/detector/inline-image-digest';

it('matches SHA-256 test vectors without SubtleCrypto, including large Unicode input', async () => {
  vi.stubGlobal('crypto', {});
  try {
    for (const text of ['', 'abc', 'data:image/png;base64,' + 'A'.repeat(100000), '图片'.repeat(1000)]) {
      expect(await inlineImageDigest(text)).toBe(createHash('sha256').update(text).digest('hex'));
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
