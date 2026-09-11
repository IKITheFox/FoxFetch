import { describe, expect, it } from 'vitest';

import { reconcileProductQualitySelections } from '../../src/modules/media-products';

const product = (id: string, qualities: string[], defaultQualityId = qualities[0]) => ({
  id,
  qualities: qualities.map((qualityId) => ({ id: qualityId })),
  ...(defaultQualityId ? { defaultQualityId } : {}),
});

describe('product quality selection reconciliation', () => {
  it('preserves a stable choice through transient empty and partial scans', () => {
    const selected = { video: '4k-avc' };

    expect(reconcileProductQualitySelections(selected, [], true)).toBe(selected);
    expect(reconcileProductQualitySelections(selected, [product('video', ['720-avc'])], true)).toBe(
      selected,
    );
  });

  it('validates choices and prunes removed products after a committed scan', () => {
    expect(
      reconcileProductQualitySelections(
        { video: '4k-avc', removed: '1080-avc' },
        [product('video', ['1080-avc', '720-avc'], '1080-avc')],
        false,
      ),
    ).toEqual({ video: '1080-avc' });
  });

  it('adds a default for a newly discovered product during convergence', () => {
    expect(reconcileProductQualitySelections({}, [product('video', ['1080-avc'])], true)).toEqual({
      video: '1080-avc',
    });
  });
});
