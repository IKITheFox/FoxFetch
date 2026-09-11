import type { TabMediaState } from '../../src/shared/types';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';
export function youtubeUiState(): TabMediaState {
  const pageUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
  const sourceUrl = 'blob:https://www.youtube.com/current';
  return {
    tabId: 7,
    pageUrl,
    pageTitle: 'Fixture video',
    scannedAt: 1,
    status: 'ready',
    mediaEpoch: 0,
    mediaElements: [],
    activeMedia: {
      routeKey: siteMediaRouteKey(pageUrl),
      mediaEpoch: 0,
      elementId: 'main',
      lifecycleGeneration: 1,
      frameId: 0,
      kind: 'video',
      title: 'Fixture video',
      sourceUrl,
    },
    assets: [
      {
        id: 'blob',
        url: sourceUrl,
        pageUrl,
        pageTitle: 'Fixture video',
        frameId: 0,
        kind: 'video',
        detectedBy: ['dom'],
        filename: '待解析视频',
        downloadable: false,
        discoveredAt: 1,
      },
      {
        id: 'image',
        url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
        pageUrl,
        pageTitle: 'Fixture video',
        frameId: 0,
        kind: 'image',
        detectedBy: ['dom'],
        downloadable: true,
        discoveredAt: 2,
      },
    ],
    youtube: {
      version: 1,
      videoId: 'abcdefghijk',
      pageType: 'watch',
      title: 'Fixture video',
      duration: 45,
      thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
      status: 'identified',
      transports: ['sabr'],
      completeDownloadVerified: false,
      candidates: [
        {
          id: '299::separate',
          kind: 'video',
          composition: 'separate',
          mime: 'video/mp4; codecs="avc1.640028"',
          width: 1920,
          height: 1080,
          fps: 30,
          dynamicRange: 'unknown',
          source: 'unavailable',
        },
        {
          id: '140::separate',
          kind: 'audio',
          composition: 'separate',
          mime: 'audio/mp4; codecs="mp4a.40.2"',
          defaultAudio: true,
          dynamicRange: 'unknown',
          source: 'unavailable',
        },
      ],
    },
  };
}
