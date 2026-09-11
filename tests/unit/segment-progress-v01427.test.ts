import { expect, it } from 'vitest';
import { createSegmentProgressTracker } from '../../src/modules/youtube/sources/segment-progress';

it('keeps a valid percentage during transient absent updates without inventing advancement', () => {
  const track = createSegmentProgressTracker();
  expect(track(null)).toBeNull();
  const progress = { video: { completed: 35, total: 98 }, audio: { completed: 20, total: 55 } };
  expect(track(progress)).toEqual(progress);
  expect(track(null)).toEqual(progress);
  expect(
    track({ video: { completed: 34, total: 98 }, audio: { completed: 19, total: 55 } }),
  ).toEqual(progress);
  expect(
    track({ video: { completed: 36, total: 98 }, audio: { completed: 21, total: 55 } })?.video
      .completed,
  ).toBe(36);
});
it('does not carry progress into a new attempt or expose mutable cached state', () => {
  const track = createSegmentProgressTracker();
  const snapshot = track({ video: { completed: 1, total: 2 }, audio: { completed: 1, total: 2 } })!;
  snapshot.video.completed = 2;
  expect(track(null)?.video.completed).toBe(1);
  expect(createSegmentProgressTracker()(null)).toBeNull();
});
it('does not treat corrupt data as progress and accepts a changed denominator', () => {
  const track = createSegmentProgressTracker();
  expect(
    track({ video: { completed: NaN, total: 2 }, audio: { completed: 1, total: 2 } }),
  ).toBeNull();
  track({ video: { completed: 1, total: 2 }, audio: { completed: 1, total: 2 } });
  expect(
    track({ video: { completed: 1, total: 4 }, audio: { completed: 1, total: 4 } })?.video.total,
  ).toBe(4);
});
