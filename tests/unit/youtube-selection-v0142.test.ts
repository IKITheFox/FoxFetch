import { describe, expect, it } from 'vitest';
import type { YouTubeInspection, YouTubeCandidate } from '../../src/modules/youtube/inspection';
import {
  createYouTubeSelectionPlan,
  matchesYouTubeSelection,
  youTubeCodecs,
  youTubeContainer,
} from '../../src/modules/youtube/selection';

const video: YouTubeCandidate = {
  id: '248::separate',
  kind: 'video',
  composition: 'separate',
  mime: 'video/webm; codecs="vp09.00.51.08"',
  width: 1920,
  height: 1080,
  fps: 59.94,
  source: 'unavailable',
  dynamicRange: 'unknown',
};
const audio: YouTubeCandidate = {
  id: '251:en.4:separate',
  kind: 'audio',
  composition: 'separate',
  mime: 'audio/webm; codecs="opus"',
  language: 'en',
  source: 'unavailable',
  dynamicRange: 'unknown',
};
const view = (): YouTubeInspection => ({
  version: 1,
  pageType: 'watch',
  videoId: 'abcdefghijk',
  status: 'identified',
  transports: ['sabr'],
  candidates: [{ ...video }, { ...audio }],
  completeDownloadVerified: false,
});
const selection = {
  videoId: 'abcdefghijk',
  videoTrackId: video.id,
  audioTrackId: audio.id,
  container: 'auto' as const,
};

describe('YouTube v0.14.2 explicit selection', () => {
  it('rejects splitting a muxed source, including requests from an older interface', () => {
    const current = view();
    current.candidates[0] = {
      ...video,
      composition: 'muxed',
      mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    };
    const request = {
      videoId: selection.videoId,
      videoTrackId: video.id,
      container: 'auto' as const,
    };
    expect(createYouTubeSelectionPlan(current, { ...request, mode: 'separate' })).toEqual({
      ok: false,
      reason: '此来源已包含音频，请使用完整下载。',
    });
    expect(createYouTubeSelectionPlan(current, { ...request, mode: 'merge' }).ok).toBe(true);
  });
  it.each([
    ['avc1.640028', 'avc'],
    ['avc3.640028', 'avc'],
    ['vp9', 'vp9'],
    ['vp09.00.51.08', 'vp9'],
    ['av01.0.08M.08', 'av1'],
  ])('parses %s without using a filename', (codec, expected) => {
    expect(youTubeCodecs(`video/mp4; codecs="${codec}"`).video).toBe(expected);
  });
  it('does not infer AVC from MP4', () => expect(youTubeCodecs('video/mp4')).toEqual({}));
  it('recommends containers without changing shared site policy', () => {
    expect(youTubeContainer('avc', 'aac')).toBe('mp4');
    expect(youTubeContainer('vp9', 'opus')).toBe('webm');
    expect(youTubeContainer('av1', 'opus')).toBe('webm');
    expect(youTubeContainer('av1', 'aac')).toBe('mp4');
    expect(youTubeContainer('avc', 'opus')).toBeUndefined();
  });
  it('locks an immutable plan without granting download verification', () => {
    const current = view();
    const result = createYouTubeSelectionPlan(current, selection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.video.fps).toBe(59.94);
    expect(result.plan.container).toBe('webm');
    expect(result.plan.completeDownloadVerified).toBe(false);
    expect(Object.isFrozen(result.plan.video)).toBe(true);
    current.candidates[0]!.height = 360;
    expect(result.plan.video.height).toBe(1080);
    expect(matchesYouTubeSelection(result.plan, current)).toBe(false);
  });
  it('does not replace a language when its track disappears', () => {
    const current = view();
    current.candidates[1] = {
      ...audio,
      id: '251:ja.4:separate',
      language: 'ja',
      defaultAudio: true,
    };
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
  });
  it('does not substitute MP4 or transcode', () =>
    expect(createYouTubeSelectionPlan(view(), { ...selection, container: 'mp4' }).ok).toBe(false));
  it.each([
    ['avc1.640028', 'opus'],
    ['vp09.00.51.08', 'mp4a.40.2'],
  ])('allows separate %s/%s without inventing a shared container', (vc, ac) => {
    const current = view();
    current.candidates[0]!.mime = `video/mp4; codecs="${vc}"`;
    current.candidates[1]!.mime = `audio/mp4; codecs="${ac}"`;
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
    const result = createYouTubeSelectionPlan(current, { ...selection, mode: 'separate' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe('separate');
    expect(result.plan.container).toBeNull();
    expect(result.plan.audio?.language).toBe('en');
    expect(result.plan.video.mime).toBe(current.candidates[0]!.mime);
    expect(Object.isFrozen(result.plan)).toBe(true);
  });
  it('does not apply an explicit merge container to separately saved tracks', () => {
    expect(
      createYouTubeSelectionPlan(view(), {
        ...selection,
        mode: 'separate',
        container: 'mp4',
      }).ok,
    ).toBe(false);
  });
  it('rejects a different page and duplicate identities', () => {
    expect(createYouTubeSelectionPlan({ ...view(), videoId: 'zyxwvutsrqp' }, selection).ok).toBe(
      false,
    );
    const current = view();
    current.candidates.push({ ...video });
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
  });
  it('rejects protected and HDR sources', () => {
    const current = view();
    current.candidates[0]!.source = 'drm';
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
    current.candidates[0] = { ...video, dynamicRange: 'HDR-declared' };
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
  });
  it('does not depend on candidate ordering', () => {
    expect(
      createYouTubeSelectionPlan({ ...view(), candidates: [audio, video] }, selection),
    ).toEqual(createYouTubeSelectionPlan(view(), selection));
  });
  it('does not add a separate audio track to a muxed source', () => {
    const current = view();
    current.candidates[0] = {
      ...video,
      composition: 'muxed',
      mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    };
    expect(createYouTubeSelectionPlan(current, selection).ok).toBe(false);
    expect(
      createYouTubeSelectionPlan(current, {
        videoId: selection.videoId,
        videoTrackId: selection.videoTrackId,
        container: 'auto',
      }).ok,
    ).toBe(true);
  });
});
