import { describe, expect, it } from 'vitest';

import { MergeError, prepareVerifiedMergeDownloadBlob } from '../../src/modules/merge';
import type { CompletedRemux, MergeContainer } from '../../src/modules/merge/types';

function completed(container: MergeContainer, sizeBytes: number): CompletedRemux {
  const metadata = {
    mp4: { extension: '.mp4', mimeType: 'video/mp4' },
    webm: { extension: '.webm', mimeType: 'video/webm' },
    mkv: { extension: '.mkv', mimeType: 'video/x-matroska' },
  } as const;
  const output = metadata[container];
  return {
    status: 'completed',
    plan: {
      mode: 'packet-copy',
      container,
      extension: output.extension,
      mimeType: output.mimeType,
    },
    verification: {
      valid: true,
      sizeBytes,
    },
  } as CompletedRemux;
}

describe('verified merge download Blob', () => {
  it('retypes an MP4 stored under a text-like temporary filename without changing bytes', async () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    const temporaryFile = new Blob([bytes], { type: 'text/plain' });

    const output = await prepareVerifiedMergeDownloadBlob(
      temporaryFile,
      completed('mp4', bytes.byteLength),
    );

    expect(output.type).toBe('video/mp4');
    expect(output.size).toBe(bytes.byteLength);
    expect([...new Uint8Array(await output.arrayBuffer())]).toEqual([...bytes]);
  });

  it.each([
    ['webm', 'video/webm'],
    ['mkv', 'video/x-matroska'],
  ] as const)('assigns the verified MIME for an EBML %s output', async (container, mimeType) => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);
    const output = await prepareVerifiedMergeDownloadBlob(
      new Blob([bytes]),
      completed(container, bytes.byteLength),
    );

    expect(output.type).toBe(mimeType);
  });

  it('rejects a size mismatch before creating a native download URL', async () => {
    const file = new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])]);

    await expect(
      prepareVerifiedMergeDownloadBlob(file, completed('mp4', file.size + 1)),
    ).rejects.toBeInstanceOf(MergeError);
  });

  it('rejects content whose signature does not match the verified container', async () => {
    const file = new Blob([new TextEncoder().encode('permission denied')], {
      type: 'text/plain',
    });

    await expect(
      prepareVerifiedMergeDownloadBlob(file, completed('mp4', file.size)),
    ).rejects.toMatchObject({ detail: { code: 'OUTPUT_SIGNATURE_MISMATCH' } });
  });
});
