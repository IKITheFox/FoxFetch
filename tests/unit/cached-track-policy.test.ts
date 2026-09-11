import { describe, expect, it } from 'vitest';

import { selectCachedNetworkTrackPair } from '../../src/modules/resolver/cached-track-policy';
import type { MediaAsset, TabMediaState } from '../../src/shared/types';

const PAGE_URL = 'https://page.example/watch/1';

function asset(
  id: string,
  kind: MediaAsset['kind'],
  overrides: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    url: `https://cdn.example/${id}.m4s`,
    pageUrl: PAGE_URL,
    pageTitle: 'Video',
    frameId: 0,
    kind,
    detectedBy: ['network'],
    ...(kind === 'video' || kind === 'audio' ? { mime: `${kind}/mp4` } : {}),
    downloadable: true,
    discoveredAt: 1,
    ...overrides,
  };
}

function state(assets: MediaAsset[]): TabMediaState {
  return {
    tabId: 7,
    pageUrl: PAGE_URL,
    pageTitle: 'Video',
    scannedAt: 1,
    status: 'ready',
    assets,
    mediaElements: [],
  };
}

describe('cached network track policy', () => {
  it('selects one explicit video and audio pair from the current page and frame', () => {
    const video = asset('video', 'video');
    const audio = asset('audio', 'audio');
    const result = selectCachedNetworkTrackPair(
      state([
        asset('other-page-video', 'video', { pageUrl: 'https://page.example/watch/old' }),
        asset('other-frame-audio', 'audio', { frameId: 3 }),
        video,
        audio,
      ]),
      0,
    );

    expect(result).toEqual({ video, audio });
  });

  it('rejects tracks without an explicit matching media MIME', () => {
    const videoWithoutMime = asset('video-without-mime', 'video');
    delete videoWithoutMime.mime;
    expect(
      selectCachedNetworkTrackPair(state([videoWithoutMime, asset('audio', 'audio')]), 0),
    ).toBeUndefined();
    expect(
      selectCachedNetworkTrackPair(
        state([asset('video', 'video', { mime: 'audio/mp4' }), asset('audio', 'audio')]),
        0,
      ),
    ).toBeUndefined();
  });

  it('rejects DOM-only, non-downloadable and non-HTTP candidates', () => {
    const invalidVideos = [
      asset('dom-video', 'video', { detectedBy: ['dom'] }),
      asset('blocked-video', 'video', { downloadable: false }),
      asset('blob-video', 'video', { url: 'blob:https://page.example/video' }),
    ];

    for (const video of invalidVideos) {
      expect(
        selectCachedNetworkTrackPair(state([video, asset('audio', 'audio')]), 0),
      ).toBeUndefined();
    }
  });

  it('withholds an ambiguous cache instead of pairing the largest tracks independently', () => {
    const value = state([
      asset('video-large', 'video', { size: 100_000 }),
      asset('video-small', 'video', { size: 10_000 }),
      asset('audio', 'audio', { size: 1_000 }),
    ]);

    expect(selectCachedNetworkTrackPair(value, 0)).toBeUndefined();
  });

  it('selects the highest-resolution pair declared by the current page manifest', () => {
    const low = asset('video-720', 'video', {
      detectedBy: ['manifest'],
      width: 1280,
      height: 720,
    });
    const high = asset('video-1080', 'video', {
      detectedBy: ['manifest'],
      width: 1920,
      height: 1080,
    });
    const audio = asset('audio-manifest', 'audio', {
      detectedBy: ['manifest'],
    });

    expect(selectCachedNetworkTrackPair(state([low, audio, high]), 0)).toEqual({
      video: high,
      audio,
    });
  });

  it('never reselects a URL that just failed a direct download', () => {
    const failedVideo = asset('failed-video', 'video');
    const audio = asset('audio', 'audio');

    expect(
      selectCachedNetworkTrackPair(state([failedVideo, audio]), 0, new Set([failedVideo.url])),
    ).toBeUndefined();
  });
});
