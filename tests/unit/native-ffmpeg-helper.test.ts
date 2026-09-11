import { describe, expect, it } from 'vitest';

import {
  FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION,
  detectNativeFfmpegHelper,
  helperCanSafelyMerge,
  isNativeFfmpegResponse,
  unavailableNativeFfmpegHelper,
} from '../../src/modules/merge';

describe('optional Native FFmpeg helper protocol', () => {
  it('is unavailable by default and never implies a bundled executable', () => {
    const capability = unavailableNativeFfmpegHelper();
    expect(capability).toMatchObject({
      available: false,
      unavailableReason: 'not-configured',
      operations: { hdrStreamCopy: false, dolbyVisionStreamCopy: false },
    });
    expect(helperCanSafelyMerge(capability, 'HDR')).toBe(false);
    expect(helperCanSafelyMerge(capability, 'Dolby Vision')).toBe(false);
  });

  it('accepts only versioned, fully verified capabilities', () => {
    const response = {
      protocolVersion: FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION,
      type: 'capabilities',
      capability: {
        protocolVersion: FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION,
        available: true,
        implementation: 'optional-native-ffmpeg-helper',
        ffmpegVersion: '8.0',
        operations: {
          hdrStreamCopy: true,
          dolbyVisionStreamCopy: true,
          verifiesIsoBmffMetadata: true,
          verifiesPacketContent: true,
        },
      },
    } as const;

    expect(isNativeFfmpegResponse(response)).toBe(true);
    expect(helperCanSafelyMerge(response.capability, 'Dolby Vision')).toBe(true);
    expect(isNativeFfmpegResponse({ ...response, protocolVersion: 999 })).toBe(false);
  });

  it('probes only through an explicitly injected transport', async () => {
    await expect(detectNativeFfmpegHelper()).resolves.toMatchObject({
      available: false,
      unavailableReason: 'not-configured',
    });
    await expect(
      detectNativeFfmpegHelper(async () => ({ protocolVersion: 99, type: 'capabilities' })),
    ).resolves.toMatchObject({ available: false, unavailableReason: 'protocol-mismatch' });
    await expect(
      detectNativeFfmpegHelper(async () => {
        throw new Error('native host is not installed');
      }),
    ).resolves.toMatchObject({ available: false, unavailableReason: 'host-not-found' });
  });
});
