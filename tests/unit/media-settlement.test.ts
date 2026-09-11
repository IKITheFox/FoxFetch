import { describe, expect, it } from 'vitest';

import {
  assessMediaScanSettlement,
  isSupportedMediaVideoPage,
  mediaScanSettlementKey,
} from '../../src/modules/detector/media-settlement';

const player = [{ kind: 'video' as const }];

describe('media scan settlement', () => {
  it('keys retries by stable media route and player epoch', () => {
    const first = mediaScanSettlementKey(
      'https://www.youtube.com/watch?v=Current_01&list=RD1&index=2',
      4,
    );
    expect(first).toBe(
      mediaScanSettlementKey('https://www.youtube.com/watch?v=Current_01&t=30', 4),
    );
    expect(first).not.toBe(
      mediaScanSettlementKey('https://www.youtube.com/watch?v=Different_2', 4),
    );
    expect(first).not.toBe(mediaScanSettlementKey('https://www.youtube.com/watch?v=Current_01', 5));
    expect(
      mediaScanSettlementKey('https://www.bilibili.com/video/BV1CURRENT01/?p=2&vd_source=one', 4),
    ).toBe(
      mediaScanSettlementKey('https://www.bilibili.com/video/BV1CURRENT01/?p=2&spm_id_from=two', 4),
    );
  });

  it.each([
    'https://www.bilibili.com/video/BV1CURRENT01/?p=2',
    'https://www.youtube.com/watch?v=Current_01',
    'https://www.youtube.com/shorts/Current_01',
    'https://www.youtube-nocookie.com/embed/Current_01',
  ])('recognizes supported video route %s', (pageUrl) => {
    expect(isSupportedMediaVideoPage(pageUrl)).toBe(true);
  });

  it.each([
    'https://www.bilibili.com/',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://example.com/video/BV1CURRENT01',
    'chrome://extensions/',
  ])('does not retry a non-video route %s', (pageUrl) => {
    expect(
      assessMediaScanSettlement({
        pageUrl,
        mediaEpoch: 1,
        mediaElements: player,
        products: [],
      }),
    ).toMatchObject({ shouldRetry: false, reason: 'unsupported-route' });
  });

  it('keeps a bounded convergence pass alive while a supported player mounts late', () => {
    expect(
      assessMediaScanSettlement({
        pageUrl: 'https://www.bilibili.com/video/BV1CURRENT01/',
        mediaEpoch: 1,
        mediaElements: [],
        products: [],
      }),
    ).toMatchObject({ shouldRetry: true, reason: 'no-video-player' });
  });

  it('retries an incomplete product and settles as soon as complete media exists', () => {
    const pageUrl = 'https://www.youtube.com/watch?v=Current_01';
    expect(
      assessMediaScanSettlement({
        pageUrl,
        mediaEpoch: 2,
        mediaElements: player,
        products: [{ capabilities: { complete: false } }],
      }),
    ).toMatchObject({ shouldRetry: true, reason: 'incomplete' });
    expect(
      assessMediaScanSettlement({
        pageUrl,
        mediaEpoch: 2,
        mediaElements: player,
        products: [{ capabilities: { complete: true } }],
      }),
    ).toMatchObject({ shouldRetry: false, reason: 'complete' });
  });

  it('ends an exhausted retry generation as degraded instead of loading forever', () => {
    expect(
      assessMediaScanSettlement({
        pageUrl: 'https://www.bilibili.com/video/BV1CURRENT01/',
        mediaEpoch: 3,
        mediaElements: player,
        products: [{ capabilities: { complete: false } }],
        retryExhausted: true,
      }),
    ).toMatchObject({ status: 'degraded', shouldRetry: false, reason: 'incomplete' });
  });
});
