import { describe, expect, it } from 'vitest';

import {
  isMseCacheHostRequest,
  MSE_CACHE_HOST_PROTOCOL_VERSION,
  type MseCacheHostRequest,
} from '../../src/modules/resolver/mse-cache-host-protocol';

const base = {
  protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
  requestId: 'request-1',
  sessionId: 'session-1',
  outputId: 'output-1',
} as const;

describe('MSE cache host output protocol', () => {
  it.each<MseCacheHostRequest>([
    { ...base, operation: 'create-output' },
    { ...base, operation: 'write-output', position: 4096, bytes: new ArrayBuffer(8) },
    { ...base, operation: 'close-output' },
    { ...base, operation: 'get-output', mime: 'video/mp4' },
    { ...base, operation: 'delete-output' },
    {
      ...base,
      operation: 'export-standard-track',
      parts: [
        {
          trackId: 'video-track',
          mime: 'video/mp4',
          maxBytes: 1024,
          firstSequence: 1,
        },
      ],
      kind: 'video',
    },
    {
      ...base,
      operation: 'download-output',
      mime: 'video/mp4',
      filename: 'FoxFetch/Bilibili/Demo.mp4',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
      saveAs: true,
    },
  ])('accepts $operation requests', (request) => {
    expect(isMseCacheHostRequest(request)).toBe(true);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an unsafe output write position (%s)', (position) => {
    expect(
      isMseCacheHostRequest({
        ...base,
        operation: 'write-output',
        position,
        bytes: new ArrayBuffer(1),
      }),
    ).toBe(false);
  });

  it('rejects missing output identities and non-transferable bytes', () => {
    expect(
      isMseCacheHostRequest({
        ...base,
        outputId: '',
        operation: 'create-output',
      }),
    ).toBe(false);
    expect(
      isMseCacheHostRequest({
        ...base,
        operation: 'write-output',
        position: 0,
        bytes: new Uint8Array([1]),
      }),
    ).toBe(false);
    expect(
      isMseCacheHostRequest({
        ...base,
        operation: 'export-standard-track',
        parts: [
          {
            trackId: 'audio-track',
            mime: 'audio/mp4',
            maxBytes: 0,
            firstSequence: 1,
          },
        ],
        kind: 'audio',
      }),
    ).toBe(false);
  });
});
