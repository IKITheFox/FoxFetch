import { expect, it } from 'vitest';
import type { YouTubeSelectionPlan } from '../../src/modules/youtube/selection';
import {
  bindYouTubeSabrSelection,
  type SelectedSabrFormat,
} from '../../src/modules/youtube/sources/selection-binding';

const video: SelectedSabrFormat = {
  itag: 248,
  lastModified: '123',
  xtags: 'v',
  mimeType: 'video/webm; codecs="vp9"',
  width: 1920,
  height: 1080,
  fps: 59.94,
  bitrate: 1000,
  approxDurationMs: 1000,
};
const audio: SelectedSabrFormat = {
  itag: 251,
  lastModified: '456',
  xtags: 'lang=en',
  audioTrackId: 'en.4',
  language: 'en',
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 100,
  approxDurationMs: 1000,
};
const plan: YouTubeSelectionPlan = {
  mode: 'merge',
  videoId: 'abcdefghijk',
  videoCodec: 'vp9',
  audioCodec: 'opus',
  container: 'webm',
  completeDownloadVerified: false,
  video: {
    id: '248::separate:123:v',
    kind: 'video',
    composition: 'separate',
    mime: video.mimeType!,
    width: 1920,
    height: 1080,
    fps: 59.94,
    sourceVersion: '123',
    sourceTags: 'v',
    source: 'unavailable',
    dynamicRange: 'unknown',
  },
  audio: {
    id: '251:en.4:separate:456:lang%3Den',
    kind: 'audio',
    composition: 'separate',
    mime: audio.mimeType!,
    sourceVersion: '456',
    sourceTags: 'lang=en',
    audioTrackId: 'en.4',
    language: 'en',
    source: 'unavailable',
    dynamicRange: 'unknown',
  },
};
it('binds both selected SABR tracks rather than the first format', () => {
  const bound = bindYouTubeSabrSelection(plan, plan.videoId, [audio, video]);
  expect(bound).toEqual({ video, audio });
  expect(bound.video).not.toBe(video);
});
it.each([
  { height: 360 },
  { fps: 30 },
  { lastModified: '124' },
  { xtags: 'other' },
  { mimeType: 'video/mp4; codecs="avc1.640028"' },
])('rejects changed video representation %j', (change) => {
  expect(() =>
    bindYouTubeSabrSelection(plan, plan.videoId, [{ ...video, ...change }, audio]),
  ).toThrow('TRACK_IDENTITY_MISMATCH');
});
it('rejects another language even if itag is the same', () => {
  expect(() =>
    bindYouTubeSabrSelection(plan, plan.videoId, [
      video,
      { ...audio, language: 'ja', audioTrackId: 'ja.4' },
    ]),
  ).toThrow('TRACK_IDENTITY_MISMATCH');
});
it('rejects a stale page and a duplicate catalog entry', () => {
  expect(() => bindYouTubeSabrSelection(plan, 'zyxwvutsrqp', [video, audio])).toThrow(
    'TRACK_IDENTITY_MISMATCH',
  );
  expect(() => bindYouTubeSabrSelection(plan, plan.videoId, [video, video, audio])).toThrow(
    'TRACK_IDENTITY_MISMATCH',
  );
});
