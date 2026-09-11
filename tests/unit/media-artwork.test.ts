import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CurrentVideoArtwork } from '../../src/components/CurrentVideoArtwork';
import { siteMediaRouteKey } from '../../src/modules/detector';
import {
  safeMediaArtworkUrl,
  mediaArtworkDisplayUrl,
  readBoundMediaArtwork,
  validateBoundMediaArtwork,
  selectCurrentVideoArtwork,
  selectCurrentVideoArtworkForProduct,
  selectCurrentVideoTitle,
} from '../../src/modules/media-products';
import type {
  BoundMediaArtwork,
  MediaAsset,
  MediaElementInfo,
  TabMediaState,
} from '../../src/shared/types';

const pageUrl = 'https://www.bilibili.com/video/BV1current/';

function currentVideo(): MediaElementInfo {
  return {
    elementId: 'player-1',
    lifecycleGeneration: 4,
    frameId: 0,
    kind: 'video',
    title: '当前视频',
    poster: 'https://i0.hdslb.com/current.jpg?token=short-lived',
    duration: 96,
    currentTime: 12,
    playbackRate: 1,
    volume: 1,
    paused: false,
    visibleArea: 640 * 360,
    lastActiveAt: 10,
  };
}

function currentState(overrides: Partial<TabMediaState> = {}): TabMediaState {
  const video = currentVideo();
  return {
    tabId: 1,
    pageUrl,
    pageTitle: '当前视频',
    scannedAt: 20,
    status: 'ready',
    assets: [],
    mediaElements: [video],
    mediaEpoch: 7,
    activeMedia: {
      routeKey: siteMediaRouteKey(pageUrl),
      mediaEpoch: 7,
      elementId: video.elementId,
      lifecycleGeneration: video.lifecycleGeneration,
      frameId: video.frameId,
      kind: video.kind,
      title: video.title,
    },
    ...overrides,
  };
}

describe('current media artwork', () => {
  it('upgrades only audited display artwork hosts without changing the discovered URL', () => {
    const original = 'http://i0.hdslb.com/bfs/archive/cover.jpg@272w?token=a%2Fb&x=1';
    expect(safeMediaArtworkUrl(original, pageUrl)).toBe(original);
    expect(mediaArtworkDisplayUrl(original, pageUrl)).toBe(original.replace('http:', 'https:'));
    expect(mediaArtworkDisplayUrl('//i0.hdslb.com/cover.jpg', pageUrl)).toBe(
      'https://i0.hdslb.com/cover.jpg',
    );
    expect(mediaArtworkDisplayUrl('http://i0.hdslb.com:8080/cover.jpg', pageUrl)).toBeUndefined();
    expect(
      mediaArtworkDisplayUrl('http://i0.hdslb.com.evil.test/cover.jpg', pageUrl),
    ).toBeUndefined();
    expect(mediaArtworkDisplayUrl('http://unknown.example/cover.jpg', pageUrl)).toBeUndefined();
    expect(mediaArtworkDisplayUrl('https://unknown.example/cover.jpg', pageUrl)).toBe(
      'https://unknown.example/cover.jpg',
    );
  });

  it('shares title-and-route-bound metadata only after BVID/CID and player generation validation', () => {
    const state = currentState({ providerIdentity: 'bilibili:BV1current:101' });
    delete state.mediaElements[0]!.poster;
    const doc = document.implementation.createHTMLDocument('当前视频');
    for (const [property, content] of [
      ['og:title', '当前视频'],
      ['og:url', pageUrl],
      ['og:image', 'http://i0.hdslb.com/bfs/archive/current.jpg@272w'],
    ]) {
      const meta = doc.createElement('meta');
      meta.setAttribute('property', property!);
      meta.content = content!;
      doc.head.append(meta);
    }
    const artwork = readBoundMediaArtwork(doc, state)!;
    expect(artwork).toMatchObject({
      source: 'page-metadata',
      mediaEpoch: 7,
      providerIdentity: 'bilibili:BV1current:101',
    });
    expect(validateBoundMediaArtwork(artwork, state)).toEqual(artwork);
    expect(selectCurrentVideoArtwork({ ...state, artwork })).toMatchObject({
      source: 'page-metadata',
      url: 'https://i0.hdslb.com/bfs/archive/current.jpg@272w',
    });
    expect(
      validateBoundMediaArtwork(artwork, { ...state, providerIdentity: 'bilibili:BV1current:102' }),
    ).toBeUndefined();
    expect(validateBoundMediaArtwork(artwork, { ...state, mediaEpoch: 8 })).toBeUndefined();
    expect(
      validateBoundMediaArtwork(artwork, {
        ...state,
        activeMedia: { ...state.activeMedia!, lifecycleGeneration: 5 },
      }),
    ).toBeUndefined();
    expect(
      validateBoundMediaArtwork(artwork, {
        ...state,
        pageUrl: 'https://www.bilibili.com/video/BV1other/',
      }),
    ).toBeUndefined();
    const unconfirmedState = { ...state };
    delete unconfirmedState.providerIdentity;
    expect(readBoundMediaArtwork(doc, unconfirmedState)).toBeUndefined();
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content =
      'https://www.bilibili.com/video/BV1other/';
    expect(readBoundMediaArtwork(doc, state)).toBeUndefined();
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content = pageUrl;
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content =
      'http://i0.hdslb.com/bfs/manga-static/recommendation.jpg@272w';
    expect(readBoundMediaArtwork(doc, state)).toBeUndefined();
    expect(
      validateBoundMediaArtwork(
        { ...artwork, source: 'scanned-image' } as unknown as BoundMediaArtwork,
        state,
      ),
    ).toBeUndefined();
  });
  it('uses a current provider-bound video poster but rejects an image, wrong part, or stale player', () => {
    const video = currentVideo();
    delete video.poster;
    const asset: MediaAsset = {
      id: 'current-video',
      url: 'https://cdn.example.com/video.m4s',
      pageUrl,
      pageTitle: '当前视频',
      frameId: 0,
      kind: 'video',
      detectedBy: ['manifest'],
      poster: 'https://i0.hdslb.com/bound-cover.jpg',
      downloadable: true,
      discoveredAt: 21,
      representation: {
        provider: 'bilibili',
        bvid: 'BV1current',
        cid: '101',
        key: 'video-80',
        delivery: 'dash',
      },
    };
    const state = currentState({
      mediaElements: [video],
      assets: [asset],
      providerIdentity: 'bilibili:BV1current:101',
    });
    expect(selectCurrentVideoArtwork(state)).toMatchObject({
      source: 'bound-track',
      url: asset.poster,
    });
    expect(selectCurrentVideoTitle(state)).toBe('当前视频');
    expect(
      selectCurrentVideoArtwork({ ...state, providerIdentity: 'bilibili:BV1current:102' }),
    ).toBeUndefined();
    expect(
      selectCurrentVideoArtwork({ ...state, assets: [{ ...asset, kind: 'image' }] }),
    ).toBeUndefined();
    expect(
      selectCurrentVideoArtwork({ ...state, assets: [{ ...asset, pageTitle: '推荐视频' }] }),
    ).toBeUndefined();
    expect(
      selectCurrentVideoArtwork({
        ...state,
        activeMedia: { ...state.activeMedia!, mediaEpoch: 6 },
      }),
    ).toBeUndefined();
    expect(
      selectCurrentVideoTitle({ ...state, activeMedia: { ...state.activeMedia!, mediaEpoch: 6 } }),
    ).toBeUndefined();
  });
  it('renders the exact active poster over a platform fallback and rejects a stale epoch', () => {
    const current = renderToStaticMarkup(
      createElement(CurrentVideoArtwork, {
        state: currentState(),
        source: pageUrl,
        title: '当前视频',
      }),
    );
    expect(current).toContain('current-video-artwork has-artwork');
    expect(current).toContain('https://i0.hdslb.com/current.jpg?token=short-lived');
    expect(current).toContain('当前视频 的视频封面');
    expect(current).not.toContain('role="img"');

    const stale = renderToStaticMarkup(
      createElement(CurrentVideoArtwork, {
        state: currentState({
          activeMedia: { ...currentState().activeMedia!, mediaEpoch: 6 },
        }),
        source: pageUrl,
        title: '当前视频',
      }),
    );
    expect(stale).not.toContain('current-video-artwork has-artwork');
    expect(stale).not.toContain('current.jpg');
    expect(stale).toContain('data-artwork-source="platform-fallback"');
    expect(stale).toContain('role="img"');

    const routeChangedAheadOfState = renderToStaticMarkup(
      createElement(CurrentVideoArtwork, {
        state: currentState(),
        source: 'https://www.bilibili.com/video/BV1next/',
        title: '下一个视频',
      }),
    );
    expect(routeChangedAheadOfState).not.toContain('current.jpg');
    expect(routeChangedAheadOfState).toContain('data-artwork-source="platform-fallback"');
  });

  it('uses only the active player poster from the exact route and media epoch', () => {
    expect(selectCurrentVideoArtwork(currentState())).toEqual({
      url: 'https://i0.hdslb.com/current.jpg?token=short-lived',
      source: 'active-player',
      elementId: 'player-1',
      lifecycleGeneration: 4,
      mediaEpoch: 7,
      pageIdentity: siteMediaRouteKey(pageUrl),
    });

    expect(
      selectCurrentVideoArtwork(
        currentState({
          activeMedia: { ...currentState().activeMedia!, mediaEpoch: 6 },
        }),
      ),
    ).toBeUndefined();
    expect(
      selectCurrentVideoArtwork(
        currentState({
          activeMedia: {
            ...currentState().activeMedia!,
            lifecycleGeneration: 3,
          },
        }),
      ),
    ).toBeUndefined();

    expect(selectCurrentVideoArtworkForProduct(currentState(), pageUrl, '当前视频')).toBeDefined();
    expect(
      selectCurrentVideoArtworkForProduct(currentState(), pageUrl, '其他视频'),
    ).toBeUndefined();
    expect(
      selectCurrentVideoArtworkForProduct(
        currentState(),
        'https://www.bilibili.com/video/BV1other/',
        '当前视频',
      ),
    ).toBeUndefined();
  });

  it('rejects executable, credential-bearing, and embedded SVG artwork URLs', () => {
    expect(safeMediaArtworkUrl('javascript:alert(1)', pageUrl)).toBeUndefined();
    expect(
      safeMediaArtworkUrl('https://user:secret@example.com/cover.jpg', pageUrl),
    ).toBeUndefined();
    expect(
      safeMediaArtworkUrl('data:image/svg+xml,<svg onload="alert(1)"/>', pageUrl),
    ).toBeUndefined();
    expect(safeMediaArtworkUrl('/cover.webp', pageUrl)).toBe('https://www.bilibili.com/cover.webp');
  });
});
