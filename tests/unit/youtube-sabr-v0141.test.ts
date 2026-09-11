import { describe, expect, it } from 'vitest';
import type { InitializedFormat } from 'googlevideo/sabr-stream';
import type { SabrFormat } from 'googlevideo/shared-types';
import {
  validateSabrEndpoint,
  validateSabrTrack,
  validateSabrSelection,
  assertSabrBufferBudget,
} from '../../src/modules/youtube/sources/sabr';

const expected: SabrFormat = {
  itag: 299,
  lastModified: '123456',
  bitrate: 2000,
  approxDurationMs: 1000,
};
function complete(): InitializedFormat {
  return {
    formatInitializationMetadata: {
      formatId: { itag: 299, lastModified: '123456' },
      endSegmentNumber: '1',
      durationUnits: '1000',
      durationTimescale: '1000',
    },
    downloadedSegments: new Map(
      [0, 1].map((number) => [
        number,
        {
          segmentNumber: number,
          formatIdKey: '299',
          bufferedChunks: [],
          mediaHeader: { sequenceNumber: number, contentLength: '10' },
        },
      ]),
    ),
    lastMediaHeaders: [],
  };
}

describe('SABR transport boundaries', () => {
  it('bounds retained media and active writes, not lifetime response overhead', () => {
    const mb = 1024 * 1024;
    // Thousands of completed protocol responses do not consume the next response budget.
    for (let i = 0; i < 1000; i++) assertSabrBufferBudget(mb, 0, 0);
    expect(() => assertSabrBufferBudget(32 * mb + 1, 0, 0)).not.toThrow();
    expect(() => assertSabrBufferBudget(64 * mb + 1, 0, 0)).toThrow('SABR_BUFFER_LIMIT');
    expect(() => assertSabrBufferBudget(mb, 63 * mb, 1)).toThrow('SABR_BUFFER_LIMIT');
    expect(() => assertSabrBufferBudget(mb, 60 * mb, 4 * mb)).toThrow('SABR_BUFFER_LIMIT');
    expect(() => assertSabrBufferBudget(mb, 0, 0)).not.toThrow();
    expect(() => assertSabrBufferBudget(mb, NaN, 0)).toThrow('SABR_BUFFER_LIMIT');
  });
  it('rejects ambiguous protocol keys rather than mixing language tracks', () => {
    const english = { ...expected, audioTrackId: 'en.4' };
    const japanese = { ...expected, audioTrackId: 'ja.4' };
    expect(() => validateSabrSelection([english, japanese], english)).toThrow(
      'TRACK_IDENTITY_MISMATCH',
    );
    expect(() =>
      validateSabrSelection(
        [
          { ...english, xtags: 'lang=en' },
          { ...japanese, xtags: 'lang=ja' },
        ],
        { ...english, xtags: 'lang=en' },
      ),
    ).not.toThrow();
    expect(() => validateSabrSelection([english], japanese)).toThrow('TRACK_IDENTITY_MISMATCH');
  });
  it.each([
    'http://rr1.googlevideo.com/videoplayback',
    'https://rr1.googlevideo.com.attacker.test/videoplayback',
    'https://localhost/videoplayback',
    'https://rr1.googlevideo.com:8080/videoplayback',
    'https://name:password@rr1.googlevideo.com/videoplayback',
    'https://rr1.googlevideo.com/other',
  ])('rejects %s', (url) => {
    expect(() => validateSabrEndpoint(url)).toThrow('SOURCE_NOT_ALLOWED');
  });
  it('permits an HTTPS media endpoint without altering signed parameters', () => {
    const url = 'https://rr1.googlevideo.com/videoplayback?sig=a%2Fb';
    expect(validateSabrEndpoint(url).href).toBe(url);
  });
  it('requires every segment including initialization and the terminal segment', () => {
    expect(validateSabrTrack(complete(), expected, 20)).toMatchObject({ segments: 2, bytes: 20 });
    for (const missing of [0, 1]) {
      const input = complete();
      input.downloadedSegments.delete(missing);
      expect(() => validateSabrTrack(input, expected, 10)).toThrow('SEGMENT_MISSING');
    }
  });
  it('rejects byte loss and mismatched representation', () => {
    expect(() => validateSabrTrack(complete(), expected, 19)).toThrow('SEGMENT_MISSING');
    expect(() =>
      validateSabrTrack(complete(), { ...expected, lastModified: '654321' }, 20),
    ).toThrow('TRACK_IDENTITY_MISMATCH');
  });
  it('does not consider absent duration or endpoint metadata complete', () => {
    const input = complete();
    delete input.formatInitializationMetadata.durationTimescale;
    expect(() => validateSabrTrack(input, expected, 20)).toThrow('SEGMENT_MISSING');
  });
  it('rejects invalid byte counts and totals outside exact integer range', () => {
    for (const bytes of [NaN, Infinity, -1, 0, 20.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateSabrTrack(complete(), expected, bytes)).toThrow('SEGMENT_MISSING');
    }
    const input = complete();
    for (const segment of input.downloadedSegments.values()) {
      segment.mediaHeader.contentLength = String(Number.MAX_SAFE_INTEGER);
    }
    expect(() => validateSabrTrack(input, expected, Number.MAX_SAFE_INTEGER)).toThrow(
      'SEGMENT_MISSING',
    );
  });
});
