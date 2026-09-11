import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgePendingNetworkAssets,
  appendPendingNetworkAsset,
  clearTabState,
  createRouteTransitionState,
  getMainWorldAssetSnapshot,
  mergeAgentSnapshots,
  saveMainWorldAssetSnapshot,
  setTabState,
  peekPendingNetworkAssets,
} from '../../src/modules/storage/tab-state';
import type {
  ActiveMediaFingerprint,
  AgentSnapshot,
  MediaAsset,
  TabMediaState,
} from '../../src/shared/types';
import { mediaArtworkTitleKey } from '../../src/modules/media-products/media-artwork';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';
import { NETWORK_ASSET_TTL_MS } from '../../src/modules/storage/network-retention';

const values: Record<string, unknown> = {};

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    storage: {
      session: {
        async get(key: string) {
          return { [key]: values[key] };
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        },
      },
    },
  },
});

function asset(id: string, url: string, source: MediaAsset['detectedBy'][number]): MediaAsset {
  return {
    id,
    url,
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Watch',
    frameId: 0,
    kind: 'video',
    detectedBy: [source],
    filename: `${id}.mp4`,
    downloadable: true,
    discoveredAt: 1,
  };
}

function activeMedia(
  mediaEpoch: number,
  elementId = `player-${mediaEpoch}`,
): ActiveMediaFingerprint {
  return {
    routeKey: 'example:watch',
    mediaEpoch,
    elementId,
    lifecycleGeneration: mediaEpoch,
    frameId: 0,
    kind: 'video',
    title: elementId,
    sourceUrl: `blob:https://example.com/${elementId}`,
    duration: 60,
    width: 1920,
    height: 1080,
  };
}

describe('tab media state merging', () => {
  beforeEach(async () => {
    for (const key of Object.keys(values)) delete values[key];
    await clearTabState(7);
  });

  it('retains only current top-frame artwork and drops an omitted/stale binding at the next snapshot', async () => {
    const pageUrl = 'https://www.bilibili.com/video/BV1ARTWORK01/';
    const active = { ...activeMedia(3), routeKey: siteMediaRouteKey(pageUrl), title: '当前视频' };
    const artwork = {
      source: 'page-metadata' as const,
      url: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
      pageIdentity: active.routeKey,
      mediaEpoch: 3,
      elementId: active.elementId,
      lifecycleGeneration: active.lifecycleGeneration,
      frameId: 0,
      titleKey: mediaArtworkTitleKey(active.title, pageUrl),
      providerIdentity: 'bilibili:BV1ARTWORK01:11',
    };
    const state: TabMediaState = {
      tabId: 7,
      pageUrl,
      pageTitle: active.title,
      scannedAt: 1,
      status: 'ready',
      assets: [],
      mediaElements: [],
      mediaEpoch: 3,
      activeMedia: active,
      providerIdentity: artwork.providerIdentity,
    };
    await setTabState(state);
    const snapshot: AgentSnapshot & { frameId: number } = {
      pageUrl,
      pageTitle: active.title,
      assets: [],
      mediaElements: [],
      mediaEpoch: 3,
      activeMedia: active,
      frameId: 0,
      artwork,
    };
    const accepted = await mergeAgentSnapshots(7, [snapshot], state);
    expect(accepted.artwork).toEqual(artwork);
    await setTabState({ ...accepted, providerIdentity: artwork.providerIdentity });
    const next = { ...snapshot };
    delete next.artwork;
    expect((await mergeAgentSnapshots(7, [next], state)).artwork).toBeUndefined();
    await setTabState(state);
    expect(
      (
        await mergeAgentSnapshots(
          7,
          [{ ...snapshot, artwork: { ...artwork, mediaEpoch: 2 } }],
          state,
        )
      ).artwork,
    ).toBeUndefined();
    await setTabState(state);
    expect(
      (
        await mergeAgentSnapshots(
          7,
          [{ ...snapshot, artwork: { ...artwork, providerIdentity: 'bilibili:BV1ARTWORK01:12' } }],
          state,
        )
      ).artwork,
    ).toBeUndefined();
  });

  it('removes every route-scoped value while an SPA video is changing', () => {
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch?v=old',
      pageTitle: '旧视频',
      scannedAt: 1,
      status: 'error',
      error: '页面已变化，请重新扫描',
      assets: [asset('old-video', 'https://cdn.example/old.mp4', 'network')],
      mediaElements: [
        {
          elementId: 'old-player',
          lifecycleGeneration: 1,
          frameId: 0,
          kind: 'video',
          title: '旧视频',
          currentTime: 10,
          playbackRate: 1,
          volume: 1,
          paused: false,
          visibleArea: 100,
          lastActiveAt: 1,
        },
      ],
      mediaEpoch: 4,
      activeMedia: activeMedia(4, 'old-player'),
      sourceCapture: {
        id: 'old-capture',
        tabId: 7,
        blobAssetId: 'old-video',
        status: 'capturing',
        startedAt: 1,
        updatedAt: 2,
        observationCount: 1,
        candidateCount: 1,
      },
    };

    expect(
      createRouteTransitionState(7, 'https://example.com/watch?v=new', '新视频', current, {
        now: 99,
      }),
    ).toEqual({
      tabId: 7,
      pageUrl: 'https://example.com/watch?v=new',
      pageTitle: '新视频',
      scannedAt: 99,
      status: 'scanning',
      assets: [],
      mediaElements: [],
    });
  });

  it('preserves a source capture only for an explicit same-page reload intent', () => {
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: '视频',
      scannedAt: 1,
      status: 'ready',
      assets: [],
      mediaElements: [],
      sourceCapture: {
        id: 'reload-capture',
        tabId: 7,
        blobAssetId: 'blob-video',
        status: 'waiting_for_playback',
        startedAt: 1,
        updatedAt: 2,
        observationCount: 0,
        candidateCount: 0,
      },
    };
    const next = createRouteTransitionState(7, current.pageUrl, current.pageTitle, current, {
      now: 2,
      preserveSourceCapture: true,
    });

    expect(next.sourceCapture).toEqual(current.sourceCapture);
    expect(next.assets).toEqual([]);
    expect(next.mediaElements).toEqual([]);
  });

  it('persists worker -1 network quarantine across an in-memory worker restart', async () => {
    const pendingAsset = asset(
      'worker-restart-audio',
      'https://upos-sz-mirrorcos.bilivideo.com/path/media-1-30216.m4s',
      'network',
    );
    await appendPendingNetworkAsset(
      7,
      {
        asset: pendingAsset,
        context: { frameId: 0, documentId: 'document-a', mediaEpoch: -1 },
        expiresAt: 5_000,
      },
      64,
      1_000,
    );

    await expect(peekPendingNetworkAssets(7, 2_000)).resolves.toEqual([
      {
        asset: pendingAsset,
        context: { frameId: 0, documentId: 'document-a', mediaEpoch: -1 },
        expiresAt: 5_000,
      },
    ]);
    await expect(peekPendingNetworkAssets(7, 2_000)).resolves.toHaveLength(1);
    await acknowledgePendingNetworkAssets(
      7,
      [
        {
          asset: pendingAsset,
          context: { frameId: 0, documentId: 'document-a', mediaEpoch: -1 },
          expiresAt: 5_000,
        },
      ],
      2_000,
    );
    await expect(peekPendingNetworkAssets(7, 2_000)).resolves.toEqual([]);
  });

  it('acknowledges a processed quarantine snapshot without deleting later arrivals', async () => {
    const first = {
      asset: asset('first', 'https://cdn.example/first.mp4', 'network'),
      context: { frameId: 0, documentId: 'document-a', mediaEpoch: -1 },
      expiresAt: 5_000,
    };
    const second = {
      asset: asset('second', 'https://cdn.example/second.mp4', 'network'),
      context: { frameId: 0, documentId: 'document-a', mediaEpoch: -1 },
      expiresAt: 5_000,
    };
    await appendPendingNetworkAsset(7, first, 64, 1_000);
    const processing = await peekPendingNetworkAssets(7, 2_000);
    await appendPendingNetworkAsset(7, second, 64, 2_001);
    await acknowledgePendingNetworkAssets(7, processing, 2_002);

    await expect(peekPendingNetworkAssets(7, 2_003)).resolves.toEqual([second]);
  });

  it('retains same-page network-only assets when a DOM rescan commits', async () => {
    const observedAt = Date.now();
    const networkOnly = {
      ...asset('network-only', 'https://cdn.example/manifest.m3u8', 'network'),
      lastObservedAt: observedAt,
    };
    const sharedNetwork = {
      ...asset('shared', 'https://cdn.example/video.mp4', 'network'),
      lastObservedAt: observedAt,
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch',
      scannedAt: 1,
      status: 'scanning',
      assets: [networkOnly, sharedNetwork],
      mediaElements: [],
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 1,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          assets: [asset('shared', sharedNetwork.url, 'dom')],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.assets.map((item) => item.id).sort()).toEqual(['network-only', 'shared']);
    expect(merged.assets.find((item) => item.id === 'shared')?.detectedBy.sort()).toEqual([
      'dom',
      'network',
    ]);
  });

  it('persists, enriches, and rebinds a validated MAIN snapshot across lifecycle epochs', async () => {
    const video = {
      ...asset('manifest-video', 'https://cdn.example/video.m4s', 'manifest'),
      kind: 'video' as const,
    };
    const audio = {
      ...asset('manifest-audio', 'https://cdn.example/audio.m4s', 'manifest'),
      kind: 'audio' as const,
    };

    await saveMainWorldAssetSnapshot(7, video.pageUrl, 4, [video], 'document-current');
    await saveMainWorldAssetSnapshot(7, video.pageUrl, 4, [audio], 'document-current');

    await expect(
      getMainWorldAssetSnapshot(7, video.pageUrl, 4, 'document-current'),
    ).resolves.toEqual(expect.arrayContaining([video, audio]));
    await expect(
      getMainWorldAssetSnapshot(7, video.pageUrl, 5, 'document-current'),
    ).resolves.toEqual(expect.arrayContaining([video, audio]));
    await expect(
      getMainWorldAssetSnapshot(7, video.pageUrl, 4, 'document-reloaded'),
    ).resolves.toEqual([]);
  });

  it('never rebinds a persisted MAIN snapshot across media routes', async () => {
    const firstUrl = 'https://www.bilibili.com/video/BV1FIRST001/';
    const secondUrl = 'https://www.bilibili.com/video/BV1SECOND02/';
    const video = {
      ...asset('manifest-video', 'https://cdn.example/video.m4s', 'manifest'),
      pageUrl: firstUrl,
      kind: 'video' as const,
    };
    await saveMainWorldAssetSnapshot(
      7,
      firstUrl,
      4,
      [video],
      'document-current',
      'bilibili:BV1FIRST001:123',
    );

    await expect(getMainWorldAssetSnapshot(7, secondUrl, 5, 'document-current')).resolves.toEqual(
      [],
    );
  });

  it('does not downgrade same-generation MAIN tracks when an isolated scan is empty', async () => {
    const manifestAudio = {
      ...asset('manifest-audio', 'https://cdn.example/audio.m4s', 'manifest'),
      pageUrl: 'https://www.bilibili.com/video/BV1LIFECYCLE/',
      kind: 'audio' as const,
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: manifestAudio.pageUrl,
      pageTitle: manifestAudio.pageTitle,
      scannedAt: 1,
      status: 'ready',
      assets: [manifestAudio],
      mediaElements: [],
      mediaEpoch: 4,
      activeMedia: activeMedia(4),
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          mediaEpoch: 4,
          activeMedia: activeMedia(4),
          assets: [],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.assets).toEqual([manifestAudio]);
  });

  it('does not delete validated MAIN tracks on a duplicate player lifecycle epoch', async () => {
    const manifestAudio = {
      ...asset('manifest-audio', 'https://cdn.example/audio.m4s', 'manifest'),
      pageUrl: 'https://www.bilibili.com/video/BV1LIFECYCLE/',
      kind: 'audio' as const,
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: manifestAudio.pageUrl,
      pageTitle: manifestAudio.pageTitle,
      scannedAt: 1,
      status: 'ready',
      assets: [manifestAudio],
      mediaElements: [],
      mediaEpoch: 4,
      activeMedia: activeMedia(4),
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          mediaEpoch: 5,
          activeMedia: activeMedia(5),
          assets: [],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.mediaEpoch).toBe(5);
    expect(merged.assets).toEqual([manifestAudio]);
  });

  it('drops previous network-only assets when the same URL advances media epoch', async () => {
    const oldNetwork = {
      ...asset('old-network', 'https://cdn.example/old-video.m4s', 'network'),
      lastObservedAt: Date.now(),
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Old media',
      scannedAt: 1,
      status: 'ready',
      assets: [oldNetwork],
      mediaElements: [],
      mediaEpoch: 4,
      activeMedia: activeMedia(4, 'old-player'),
    };
    await setTabState(current);

    const fresh = asset('new-video', 'https://cdn.example/new-video.m4s', 'performance');
    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 5,
          activeMedia: activeMedia(5, 'new-player'),
          pageUrl: current.pageUrl,
          pageTitle: 'New media',
          assets: [fresh],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.mediaEpoch).toBe(5);
    expect(merged.assets.map((item) => item.id)).toEqual(['new-video']);
    expect(merged.assets).not.toContainEqual(expect.objectContaining({ id: 'old-network' }));
  });

  it('drops an old network and performance mixed asset across a same-URL media epoch', async () => {
    const oldMixed = {
      ...asset('old-mixed', 'https://cdn.example/old-mixed.m4s', 'network'),
      detectedBy: ['network', 'performance'] as MediaAsset['detectedBy'],
      lastObservedAt: Date.now(),
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Old media',
      scannedAt: 1,
      status: 'ready',
      assets: [oldMixed],
      mediaElements: [],
      mediaEpoch: 4,
      activeMedia: activeMedia(4, 'old-player'),
    };
    await setTabState(current);

    const fresh = asset('new-video', 'https://cdn.example/new-video.m4s', 'performance');
    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 5,
          activeMedia: activeMedia(5, 'new-player'),
          pageUrl: current.pageUrl,
          pageTitle: 'New media',
          assets: [fresh],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.assets.map((item) => item.id)).toEqual(['new-video']);
    expect(merged.assets).not.toContainEqual(expect.objectContaining({ id: 'old-mixed' }));
  });

  it('persists only the top-frame active player identity', async () => {
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch',
      scannedAt: 1,
      status: 'scanning',
      assets: [],
      mediaElements: [],
    };
    await setTabState(current);
    const topActive = activeMedia(4, 'top-player');

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 3,
          mediaEpoch: 99,
          activeMedia: { ...activeMedia(99, 'iframe-player'), frameId: 3 },
          pageUrl: current.pageUrl,
          pageTitle: 'Frame',
          assets: [],
          mediaElements: [],
        },
        {
          frameId: 0,
          mediaEpoch: 4,
          activeMedia: topActive,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          assets: [],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.mediaEpoch).toBe(4);
    expect(merged.activeMedia).toEqual(topActive);
  });

  it('does not let a late same-URL scan roll the accepted media epoch backwards', async () => {
    const currentAsset = asset('current-video', 'https://cdn.example/current.mp4', 'dom');
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Current',
      scannedAt: 1,
      status: 'ready',
      assets: [currentAsset],
      mediaElements: [],
      mediaEpoch: 8,
      activeMedia: activeMedia(8, 'current-player'),
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 7,
          activeMedia: activeMedia(7, 'old-player'),
          pageUrl: current.pageUrl,
          pageTitle: 'Old response',
          assets: [asset('old-video', 'https://cdn.example/old.mp4', 'dom')],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.status).toBe('ready');
    expect(merged.mediaEpoch).toBe(8);
    expect(merged.activeMedia).toEqual(current.activeMedia);
    expect(merged.assets).toEqual([currentAsset]);
  });

  it('expires quiet network assets on the same route without deleting current snapshot assets', async () => {
    const now = 2_000_000;
    const staleTime = now - NETWORK_ASSET_TTL_MS - 1;
    const staleNetwork = {
      ...asset('stale-network', 'https://cdn.example/old-video.mp4', 'network'),
      discoveredAt: staleTime,
      lastObservedAt: staleTime,
    };
    const currentManifest = {
      ...asset('current-manifest', 'https://cdn.example/current.mpd', 'network'),
      detectedBy: ['network', 'manifest'] as MediaAsset['detectedBy'],
      discoveredAt: staleTime,
      lastObservedAt: staleTime,
    };
    const unscannedFrame = {
      ...asset('iframe-network', 'https://cdn.example/frame-video.mp4', 'network'),
      frameId: 3,
      discoveredAt: staleTime,
      lastObservedAt: staleTime,
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch',
      scannedAt: staleTime,
      status: 'ready',
      assets: [staleNetwork, currentManifest, unscannedFrame],
      mediaElements: [],
    };
    await setTabState(current);

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const merged = await mergeAgentSnapshots(
        7,
        [
          {
            frameId: 0,
            mediaEpoch: 1,
            pageUrl: current.pageUrl,
            pageTitle: current.pageTitle,
            assets: [
              {
                ...currentManifest,
                detectedBy: ['manifest'],
                discoveredAt: now,
              },
            ],
            mediaElements: [],
          },
        ],
        current,
      );

      expect(merged.assets.map((item) => item.id).sort()).toEqual([
        'current-manifest',
        'iframe-network',
      ]);
      expect(merged.assets.find((item) => item.id === 'current-manifest')?.detectedBy).toEqual([
        'network',
        'manifest',
      ]);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('keeps an expired network asset referenced by the source capture result', async () => {
    const now = 3_000_000;
    const staleTime = now - NETWORK_ASSET_TTL_MS - 1;
    const resolved = {
      ...asset('resolved-video', 'https://cdn.example/resolved.mp4', 'network'),
      discoveredAt: staleTime,
      lastObservedAt: staleTime,
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: resolved.pageUrl,
      pageTitle: resolved.pageTitle,
      scannedAt: staleTime,
      status: 'ready',
      assets: [resolved],
      mediaElements: [],
      sourceCapture: {
        id: 'capture-1',
        tabId: 7,
        blobAssetId: 'blob-1',
        directAssetId: resolved.id,
        status: 'resolved',
        startedAt: 1,
        updatedAt: 2,
        observationCount: 3,
        candidateCount: 1,
      },
    };
    await setTabState(current);

    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const merged = await mergeAgentSnapshots(
        7,
        [
          {
            frameId: 0,
            mediaEpoch: 1,
            pageUrl: current.pageUrl,
            pageTitle: current.pageTitle,
            assets: [],
            mediaElements: [],
          },
        ],
        current,
      );
      expect(merged.assets).toEqual([resolved]);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('does not replace a network MIME extension with a DOM URL suffix', async () => {
    const network = {
      ...asset('shared-audio', 'https://cdn.example/audio.bin', 'network'),
      kind: 'audio' as const,
      mime: 'audio/aac',
      extension: 'aac',
    };
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: network.pageUrl,
      pageTitle: network.pageTitle,
      scannedAt: 1,
      status: 'ready',
      assets: [network],
      mediaElements: [],
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 1,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          assets: [
            {
              id: network.id,
              url: network.url,
              pageUrl: network.pageUrl,
              pageTitle: network.pageTitle,
              frameId: network.frameId,
              kind: network.kind,
              detectedBy: ['dom'],
              extension: 'bin',
              downloadable: true,
              discoveredAt: 2,
            },
          ],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.assets[0]).toMatchObject({ extension: 'aac' });
  });

  it('retains an active source capture when a DOM rescan commits', async () => {
    const current: TabMediaState = {
      tabId: 7,
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch',
      scannedAt: 1,
      status: 'scanning',
      assets: [],
      mediaElements: [],
      sourceCapture: {
        id: 'capture-1',
        tabId: 7,
        blobAssetId: 'blob-1',
        status: 'capturing',
        startedAt: 1,
        updatedAt: 2,
        observationCount: 3,
        candidateCount: 2,
      },
    };
    await setTabState(current);

    const merged = await mergeAgentSnapshots(
      7,
      [
        {
          frameId: 0,
          mediaEpoch: 1,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          assets: [],
          mediaElements: [],
        },
      ],
      current,
    );

    expect(merged.sourceCapture).toEqual(current.sourceCapture);
  });
});
