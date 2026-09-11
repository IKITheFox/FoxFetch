import { siteMediaRouteKey } from '../../src/modules/detector/site-media';
import type { DownloadRecord, MediaAsset, TabMediaState } from '../../src/shared/types';

export const uiPageUrl = 'https://www.bilibili.com/video/BV1UI0000001/';
export const uiTitle = '当前视频：城市与山川 · 长标题在窄面板中正确省略';
/** Synthetic geometry only; not a real video or AI-generated artwork. The PNG
 * below is an offline rasterization of this SVG because production intentionally
 * rejects SVG data URLs. Keep this source self-contained and without scripts. */
export const uiPosterSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" fill="#202944"/>
  <circle cx="269" cy="39" r="24" fill="#ffb66d"/>
  <path d="M0 130 72 52 157 130Z" fill="#8971db"/>
  <path d="M78 133 179 38 290 133Z" fill="#6653a8"/>
  <path d="M137 80 179 38 218 82 190 71 177 82 164 66Z" fill="#e5dcfa"/>
  <path d="M0 115Q80 92 161 116T320 105V180H0Z" fill="#347f99"/>
  <path d="M0 141Q90 121 180 143T320 136V180H0Z" fill="#286377"/>
  <text x="16" y="151" fill="#ffffff" font-size="25" font-weight="700" font-family="Microsoft YaHei, sans-serif">测试封面</text>
  <text x="17" y="169" fill="#c3e3e6" font-size="10" font-family="sans-serif" letter-spacing="1">SYNTHETIC TEST COVER</text>
</svg>`;
export const uiPoster =
  'data:image/png;base64,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';

export function populatedUiState(): TabMediaState {
  const videos: MediaAsset[] = [120, 116, 112, 80, 64, 32, 16].map((qn, index) => ({
    id: `ui-video-${qn}`,
    url: `https://cdn.bilivideo.com/ui-${qn}.m4s`,
    pageUrl: uiPageUrl,
    pageTitle: uiTitle,
    frameId: 0,
    kind: 'video',
    detectedBy: ['manifest'],
    mime: 'video/mp4; codecs="avc1.640028"',
    width: index === 0 ? 3840 : 1920,
    height: index === 0 ? 2160 : 1080,
    duration: 96,
    poster: uiPoster,
    downloadable: true,
    discoveredAt: 20,
    lastObservedAt: 20,
    representation: {
      provider: 'bilibili',
      bvid: 'BV1UI0000001',
      cid: '123',
      key: `video-${qn}`,
      delivery: 'dash',
      qn,
      codecs: 'avc1.640028',
      frameRate: '30.000',
      dynamicRange: 'SDR',
    },
  }));
  const audio: MediaAsset = {
    id: 'ui-audio',
    url: 'https://cdn.bilivideo.com/ui-audio.m4s',
    pageUrl: uiPageUrl,
    pageTitle: uiTitle,
    frameId: 0,
    kind: 'audio',
    detectedBy: ['manifest'],
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    duration: 96,
    downloadable: true,
    discoveredAt: 20,
    representation: {
      provider: 'bilibili',
      bvid: 'BV1UI0000001',
      cid: '123',
      key: 'audio',
      delivery: 'dash',
      codecs: 'mp4a.40.2',
    },
  };
  const images: MediaAsset[] = Array.from({ length: 12 }, (_, index) => ({
    id: `image-${index}`,
    url: `https://i0.hdslb.com/ui-${index}.jpg`,
    pageUrl: uiPageUrl,
    pageTitle: uiTitle,
    frameId: 0,
    kind: 'image',
    detectedBy: ['dom'],
    filename: `${'long_resource_filename_'.repeat(8)}${index}.jpg`,
    mime: 'image/jpeg',
    extension: 'jpg',
    width: 400,
    height: 240,
    downloadable: true,
    discoveredAt: 20,
  }));
  return {
    tabId: 7,
    pageUrl: uiPageUrl,
    pageTitle: '网页旧标题',
    status: 'ready',
    scannedAt: 20,
    assets: [...videos, audio, ...images],
    mediaEpoch: 3,
    providerIdentity: 'bilibili:BV1UI0000001:123',
    activeMedia: {
      routeKey: siteMediaRouteKey(uiPageUrl),
      mediaEpoch: 3,
      elementId: 'player',
      lifecycleGeneration: 2,
      frameId: 0,
      kind: 'video',
      title: uiTitle,
    },
    mediaElements: [
      {
        elementId: 'player',
        lifecycleGeneration: 2,
        frameId: 0,
        kind: 'video',
        title: uiTitle,
        poster: uiPoster,
        sourceUrl: videos[0]!.url,
        duration: 96,
        currentTime: 12,
        playbackRate: 1,
        volume: 1,
        paused: true,
        visibleArea: 640 * 360,
        lastActiveAt: 20,
      },
    ],
  };
}

export const uiRecentTasks: DownloadRecord[] = [
  {
    id: 'task',
    assetId: 'asset',
    filename: `${'long_download_name_'.repeat(12)}.mp4`,
    url: 'https://cdn.bilivideo.com/task.mp4',
    kind: 'video',
    state: 'downloading',
    createdAt: 1,
    updatedAt: 2,
  },
];
