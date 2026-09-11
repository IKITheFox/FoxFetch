import { describe, expect, it } from 'vitest';
import {
  publicNetworkDiagnostic,
  publicTimelineDiagnostic,
  publicSourceTimelineDiagnostic,
} from '../../src/modules/jobs/public-diagnostics';

describe('public runtime diagnostic boundary', () => {
  it('rebuilds bounded source-box diagnostics without injected paths or payloads', () => {
    expect(
      publicSourceTimelineDiagnostic({
        issue: 'open-ended-offset',
        box: 'elst',
        sourceKind: 'audio',
        version: 1,
        entryCount: 1,
        entryIndex: 0,
        movieTimescale: 1000,
        mediaTimescale: 48000,
        duration: 0,
        mediaTime: 1024,
        rate: 65536,
        path: 'C:/private/user.mp4',
        url: 'https://private/?token=secret',
        payload: new Uint8Array([1]),
      }),
    ).toEqual({
      issue: 'open-ended-offset',
      box: 'elst',
      sourceKind: 'audio',
      version: 1,
      entryCount: 1,
      entryIndex: 0,
      movieTimescale: 1000,
      mediaTimescale: 48000,
      duration: 0,
      mediaTime: 1024,
      rate: 65536,
    });
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { issue: 'https://private.test', box: 'elst' },
    { issue: 'multiple-edits', box: 'moov/trak/edts/elst' },
    { issue: { toString: (): string => 'multiple-edits' }, box: 'elst' },
  ])('rejects source diagnostics without controlled issue and box: %s', (value) => {
    expect(publicSourceTimelineDiagnostic(value)).toBeUndefined();
  });
  it('drops invalid values instead of coercing them or exposing unsupported versions', () => {
    expect(
      publicSourceTimelineDiagnostic({
        issue: 'invalid-timebase',
        box: 'mdhd',
        sourceKind: 'private',
        version: 2,
        entryCount: '1',
        entryIndex: -1,
        movieTimescale: 0,
        mediaTimescale: 4294967296,
        duration: Infinity,
        mediaTime: -2,
        rate: 2147483648,
      }),
    ).toEqual({ issue: 'invalid-timebase', box: 'mdhd', movieTimescale: 0 });
    expect(
      publicSourceTimelineDiagnostic({
        issue: 'empty-edit-list',
        box: 'elst',
        version: 0,
        entryCount: 0,
        entryIndex: 0,
        duration: Number.MAX_SAFE_INTEGER,
        mediaTime: -1,
        rate: -2147483648,
      }),
    ).toMatchObject({
      version: 0,
      entryCount: 0,
      entryIndex: 0,
      duration: Number.MAX_SAFE_INTEGER,
      mediaTime: -1,
      rate: -2147483648,
    });
  });
  it.each([NaN, Infinity, -Infinity, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1])(
    'never coerces an invalid source integer %s',
    (number) => {
      expect(
        publicSourceTimelineDiagnostic({
          issue: 'metadata-limit',
          box: 'structure',
          entryCount: number,
          entryIndex: number,
          movieTimescale: number,
          mediaTimescale: number,
          duration: number,
          mediaTime: number,
          rate: number,
        }),
      ).toEqual({ issue: 'metadata-limit', box: 'structure' });
    },
  );
  it('bounds edit counts and indices independently of a worker-provided length', () => {
    expect(
      publicSourceTimelineDiagnostic({
        issue: 'metadata-limit',
        box: 'elst',
        entryCount: 1_000_001,
        entryIndex: 1_000_001,
        duration: -1,
      }),
    ).toEqual({ issue: 'metadata-limit', box: 'elst' });
  });
  it('rebuilds only numeric timeline evidence and no injected credentials', () => {
    expect(
      publicTimelineDiagnostic({
        track: 'audio',
        mismatch: 'duration',
        packetIndex: 0,
        sourceTimescale: 48_000,
        outputTimescale: 'secret',
        outputTimestampSeconds: Infinity,
        durationDeltaSeconds: 0,
        url: 'https://private.test/?token=secret',
        cookie: 'private',
      }),
    ).toEqual({
      track: 'audio',
      mismatch: 'duration',
      packetIndex: 0,
      sourceTimescale: 48_000,
      durationDeltaSeconds: 0,
    });
  });
  it.each([
    undefined,
    {},
    { track: 'video', mismatch: { toString: (): string => 'timestamp' }, packetIndex: 0 },
    { track: 'video', mismatch: 'timestamp', packetIndex: -1 },
    { track: 'video', mismatch: 'timestamp', packetIndex: NaN },
  ])('rejects malformed timing: %s', (value) =>
    expect(publicTimelineDiagnostic(value)).toBeUndefined(),
  );
  it('keeps a fallback warning numeric, not an arbitrary log or URI', () => {
    expect(
      publicNetworkDiagnostic({
        readMode: 'sequential',
        fallback: 'range-unavailable',
        responseStatus: 200,
        requestStart: 0,
        totalBytes: 20,
        responseEnd: -1,
        responseStart: '0',
        authorization: 'private',
        mediaUrl: 'https://private.test',
      }),
    ).toEqual({
      readMode: 'sequential',
      fallback: 'range-unavailable',
      responseStatus: 200,
      requestStart: 0,
      totalBytes: 20,
    });
    expect(publicNetworkDiagnostic({ readMode: 'https://private.test' })).toBeUndefined();
  });
});
