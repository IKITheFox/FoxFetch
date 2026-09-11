import { describe, expect, it } from 'vitest';
import {
  BILIBILI_MANIFEST_HOOK_STATUS_EVENT,
  BILIBILI_MANIFEST_HOOK_VERSION,
  BILIBILI_MANIFEST_HOOK_CHECK_EVENT,
  BILIBILI_MANIFEST_READY_EVENT,
  BILIBILI_ROUTE_CHANGED_EVENT,
  bilibiliManifestHookStatus,
  bilibiliRouteChangedIdentityForCurrentRoute,
  manifestReadyIdentityForCurrentRoute,
} from '../../src/modules/playback';

describe('Bilibili manifest-ready bridge contract', () => {
  it('shares the exact MAIN-world event name and keeps hook checks URL-free', () => {
    expect(BILIBILI_MANIFEST_READY_EVENT).toBe('foxfetch:bilibili-manifest-ready');
    expect(BILIBILI_MANIFEST_HOOK_CHECK_EVENT).toBe('foxfetch:bilibili-manifest-hook-check');
    expect(BILIBILI_MANIFEST_HOOK_STATUS_EVENT).toBe('foxfetch:bilibili-manifest-hook-status');
    expect(BILIBILI_ROUTE_CHANGED_EVENT).toBe('foxfetch:bilibili-route-changed');
    const event = new Event(BILIBILI_MANIFEST_HOOK_CHECK_EVENT);
    expect(event).not.toHaveProperty('detail');
  });

  it('accepts only bvid/cid identity for the video in the current route', () => {
    const pageUrl = 'https://www.bilibili.com/video/BV1d2tW6NEdK/?from=search';
    expect(
      manifestReadyIdentityForCurrentRoute(pageUrl, {
        bvid: 'BV1D2TW6NEDK',
        cid: '001234',
        revision: 7,
      }),
    ).toEqual({ bvid: 'BV1D2TW6NEDK', cid: '1234', revision: 7 });
    expect(
      manifestReadyIdentityForCurrentRoute(`${pageUrl}&cid=1234`, {
        bvid: 'BV1D2TW6NEDK',
        cid: '1234',
        revision: 8,
      }),
    ).toEqual({ bvid: 'BV1D2TW6NEDK', cid: '1234', revision: 8 });
  });

  it('rejects another route, malformed identity, and any detail carrying media data', () => {
    const pageUrl = 'https://www.bilibili.com/video/BV1d2tW6NEdK/';
    expect(
      manifestReadyIdentityForCurrentRoute(pageUrl, {
        bvid: 'BV1FJTIZWEVA',
        cid: '1234',
        revision: 1,
      }),
    ).toBeUndefined();
    expect(
      manifestReadyIdentityForCurrentRoute(pageUrl, {
        bvid: 'BV1D2TW6NEDK',
        cid: '1234',
        revision: 1,
        videoUrl: 'https://media.example/video.m4s',
      }),
    ).toBeUndefined();
    expect(manifestReadyIdentityForCurrentRoute(pageUrl, { bvid: 'BV1D2TW6NEDK' })).toBeUndefined();
  });

  it('validates the versioned URL-free hook status handshake', () => {
    expect(
      bilibiliManifestHookStatus({
        version: BILIBILI_MANIFEST_HOOK_VERSION,
        checkRevision: 3,
        captureRevision: 9,
        fetch: true,
        xhr: true,
        routeBridgeBound: true,
      }),
    ).toEqual({
      version: BILIBILI_MANIFEST_HOOK_VERSION,
      checkRevision: 3,
      captureRevision: 9,
      fetch: true,
      xhr: true,
      routeBridgeBound: true,
    });
    expect(
      bilibiliManifestHookStatus({
        version: BILIBILI_MANIFEST_HOOK_VERSION - 1,
        checkRevision: 3,
        captureRevision: 9,
        fetch: true,
        xhr: true,
        routeBridgeBound: true,
      }),
    ).toBeUndefined();
  });

  it('validates only identity data for the current History route', () => {
    const pageUrl = 'https://www.bilibili.com/video/BV1d2tW6NEdK/?cid=1234';
    expect(
      bilibiliRouteChangedIdentityForCurrentRoute(pageUrl, {
        bvid: 'bv1d2tw6nedk',
        cid: '001234',
      }),
    ).toEqual({ bvid: 'BV1D2TW6NEDK', cid: '1234' });
    expect(
      bilibiliRouteChangedIdentityForCurrentRoute(pageUrl, {
        bvid: 'BV1D2TW6NEDK',
        cid: '9999',
      }),
    ).toBeUndefined();
    expect(
      bilibiliRouteChangedIdentityForCurrentRoute(pageUrl, {
        bvid: 'BV1D2TW6NEDK',
        cid: '1234',
        url: pageUrl,
      }),
    ).toBeUndefined();
  });
});
