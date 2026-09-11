import { describe, expect, it } from 'vitest';

import type { MediaAsset } from '../../src/shared/types';
import {
  authoritativeNetworkAssetKeys,
  canAdoptQuarantinedNetworkAsset,
  mediaRequestHeadersFromWebRequest,
  responseSizeFromHeaders,
  startNetworkObserver,
  stopNetworkObserver,
  type NetworkRequestContext,
} from '../../src/modules/network/observer';
import type { NetworkMediaObservation } from '../../src/modules/network/media-observation';

describe('network media metadata', () => {
  it('adopts quarantined SPA requests only with current-route or authoritative identity', () => {
    const asset: MediaAsset = {
      id: 'track-1',
      url: 'https://cdn.example/video.m4s',
      pageUrl: 'https://www.bilibili.com/',
      pageTitle: '',
      frameId: 0,
      kind: 'video',
      detectedBy: ['network'],
      filename: 'video.m4s',
      downloadable: true,
      discoveredAt: 1,
      requestHeaders: {
        referer: 'https://www.bilibili.com/video/BV1CURRENT01/?vd_source=one',
      },
    };
    expect(
      canAdoptQuarantinedNetworkAsset(
        asset,
        'https://www.bilibili.com/video/BV1CURRENT01/?spm_id_from=two',
        new Set(),
      ),
    ).toBe(true);
    expect(
      canAdoptQuarantinedNetworkAsset(
        asset,
        'https://www.bilibili.com/video/BV1DIFFERENT2/',
        new Set(),
      ),
    ).toBe(false);

    const unidentified: MediaAsset = { ...asset };
    delete unidentified.requestHeaders;
    expect(
      canAdoptQuarantinedNetworkAsset(
        unidentified,
        'https://www.bilibili.com/video/BV1CURRENT01/',
        new Set(),
      ),
    ).toBe(false);
    expect(
      canAdoptQuarantinedNetworkAsset(
        unidentified,
        'https://www.bilibili.com/video/BV1CURRENT01/',
        new Set(['track-1']),
      ),
    ).toBe(true);

    const sameUrlManifest: MediaAsset = {
      ...asset,
      id: 'manifest-track-with-different-id',
      detectedBy: ['manifest'],
    };
    expect(
      canAdoptQuarantinedNetworkAsset(
        { ...asset, requestHeaders: { referer: 'https://www.bilibili.com/video/BV1OLDVIDEO/' } },
        'https://www.bilibili.com/video/BV1CURRENT01/',
        new Set(authoritativeNetworkAssetKeys(sameUrlManifest)),
      ),
    ).toBe(true);
  });

  it('never adopts a prefetched Bilibili DASH asset into route A from its stale referer', () => {
    const prefetchedForB: MediaAsset = {
      id: 'prefetched-b-audio',
      url: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/22/11/99887766/media-b-1-30216.m4s?deadline=1',
      pageUrl: 'https://www.bilibili.com/',
      pageTitle: '',
      frameId: 0,
      kind: 'audio',
      detectedBy: ['network'],
      downloadable: true,
      discoveredAt: 1,
      requestHeaders: {
        referer: 'https://www.bilibili.com/video/BV1ROUTEA01/',
      },
    };

    expect(
      canAdoptQuarantinedNetworkAsset(
        prefetchedForB,
        'https://www.bilibili.com/video/BV1ROUTEA01/',
        new Set(),
      ),
    ).toBe(false);
    expect(
      canAdoptQuarantinedNetworkAsset(
        prefetchedForB,
        'https://www.bilibili.com/video/BV1ROUTEB02/',
        new Set(),
      ),
    ).toBe(false);

    const authoritativeForB: MediaAsset = {
      ...prefetchedForB,
      id: 'manifest-b-audio',
      detectedBy: ['manifest'],
    };
    expect(
      canAdoptQuarantinedNetworkAsset(
        prefetchedForB,
        'https://www.bilibili.com/video/BV1ROUTEB02/',
        new Set(authoritativeNetworkAssetKeys(authoritativeForB)),
      ),
    ).toBe(true);
  });

  it('uses the total size from a partial Content-Range response', () => {
    expect(
      responseSizeFromHeaders(206, [
        { name: 'Content-Length', value: '1024' },
        { name: 'Content-Range', value: 'bytes 0-1023/7340032' },
      ]),
    ).toBe(7_340_032);
  });

  it('does not report a range chunk as the complete media size', () => {
    expect(
      responseSizeFromHeaders(206, [{ name: 'Content-Length', value: '1024' }]),
    ).toBeUndefined();
    expect(responseSizeFromHeaders(200, [{ name: 'Content-Length', value: '2048' }])).toBe(2_048);
  });

  it('retains only replay-safe request headers and never copies Cookie', () => {
    expect(
      mediaRequestHeadersFromWebRequest([
        { name: 'Referer', value: 'https://www.bilibili.com/video/BV1' },
        { name: 'Origin', value: 'https://www.bilibili.com' },
        { name: 'Authorization', value: 'Bearer short-lived-token' },
        { name: 'Accept', value: 'video/mp4,*/*' },
        { name: 'Cookie', value: 'SESSDATA=must-not-be-copied' },
      ]),
    ).toEqual({
      referer: 'https://www.bilibili.com/video/BV1',
      origin: 'https://www.bilibili.com',
      authorization: 'Bearer short-lived-token',
      accept: 'video/mp4,*/*',
    });
  });

  it('forwards M4S response metadata to the capture resolver without reading the body', async () => {
    let headersListener:
      ((details: chrome.webRequest.OnHeadersReceivedDetails) => unknown) | undefined;
    let redirectListener:
      ((details: chrome.webRequest.OnBeforeRedirectDetails) => unknown) | undefined;
    let requestListener:
      ((details: chrome.webRequest.OnBeforeSendHeadersDetails) => unknown) | undefined;
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        webRequest: {
          onHeadersReceived: {
            addListener(listener: typeof headersListener) {
              headersListener = listener;
            },
            removeListener() {
              headersListener = undefined;
            },
          },
          onBeforeRedirect: {
            addListener(listener: typeof redirectListener) {
              redirectListener = listener;
            },
            removeListener() {
              redirectListener = undefined;
            },
          },
          onBeforeSendHeaders: {
            addListener(listener: typeof requestListener) {
              requestListener = listener;
            },
            removeListener() {
              requestListener = undefined;
            },
          },
          onCompleted: {
            addListener() {},
            removeListener() {},
          },
          onErrorOccurred: {
            addListener() {},
            removeListener() {},
          },
        },
      },
    });

    const assets: MediaAsset[] = [];
    const contexts: NetworkRequestContext[] = [];
    const observations: NetworkMediaObservation[] = [];
    let mediaEpoch = 7;
    startNetworkObserver(
      (_tabId, asset, context) => {
        assets.push(asset);
        contexts.push(context);
      },
      (_tabId, observation) => {
        observations.push(observation);
      },
      () => mediaEpoch,
    );
    expect(headersListener).toBeTypeOf('function');
    requestListener?.({
      requestId: 'request-1',
      url: 'https://cdn.example/video.m4s',
      tabId: 4,
      frameId: 0,
      parentFrameId: -1,
      type: 'xmlhttprequest',
      method: 'GET',
      timeStamp: 99,
      requestHeaders: [
        { name: 'Referer', value: 'https://page.example/watch/1' },
        { name: 'Origin', value: 'https://page.example' },
        { name: 'Authorization', value: 'Bearer media-token' },
        { name: 'Cookie', value: 'session=private' },
      ],
      documentId: 'doc-1',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    mediaEpoch = 8;
    headersListener?.({
      requestId: 'request-1',
      url: 'https://cdn.example/video.m4s',
      tabId: 4,
      frameId: 0,
      parentFrameId: -1,
      type: 'xmlhttprequest',
      method: 'GET',
      timeStamp: 100,
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content',
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Range', value: 'bytes 0-1023/8192' },
      ],
      documentId: 'doc-1',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    await Promise.resolve();

    expect(observations).toEqual([
      expect.objectContaining({
        mime: 'video/mp4',
        method: 'GET',
        resourceType: 'xmlhttprequest',
        size: 8_192,
        range: { start: 0, end: 1_023, total: 8_192 },
        requestHeaders: {
          referer: 'https://page.example/watch/1',
          origin: 'https://page.example',
          authorization: 'Bearer media-token',
        },
      }),
    ]);
    expect(redirectListener).toBeTypeOf('function');
    expect(contexts[0]).toMatchObject({
      frameId: 0,
      documentId: 'doc-1',
      mediaEpoch: 7,
      routeKey: 'https://page.example/watch/1',
    });

    headersListener?.({
      requestId: 'worker-restarted-request',
      url: 'https://cdn.example/restarted.mp4',
      tabId: 4,
      frameId: 0,
      parentFrameId: -1,
      type: 'media',
      method: 'GET',
      timeStamp: 100.5,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: [
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: '8192' },
      ],
      documentId: 'doc-1',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    await Promise.resolve();
    expect(contexts.at(-1)).toMatchObject({
      frameId: 0,
      documentId: 'doc-1',
      mediaEpoch: -1,
    });

    const googleVideoBase =
      'id=youtube-stream&itag=137&source=youtube&mime=video%2Fmp4&clen=10000&sparams=expire%2Cid%2Citag%2Csource%2Cmime%2Cclen&expire=1900000000&sig=shared-signature';
    headersListener?.({
      requestId: 'googlevideo-1',
      url: `https://r1---sn.example.googlevideo.com/videoplayback?${googleVideoBase}&range=0-999&rn=1&rbuf=0`,
      tabId: 4,
      frameId: 0,
      parentFrameId: -1,
      type: 'xmlhttprequest',
      method: 'GET',
      timeStamp: 101,
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content',
      responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
      documentId: 'doc-1',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    headersListener?.({
      requestId: 'googlevideo-2',
      url: `https://r2---sn.example.googlevideo.com/videoplayback?range=1000-1999&rn=2&rbuf=0&${googleVideoBase}`,
      tabId: 4,
      frameId: 0,
      parentFrameId: -1,
      type: 'xmlhttprequest',
      method: 'GET',
      timeStamp: 102,
      statusCode: 206,
      statusLine: 'HTTP/1.1 206 Partial Content',
      responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
      documentId: 'doc-1',
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
    });
    await Promise.resolve();

    const googleVideoAssets = assets.filter((asset) => asset.url.includes('/videoplayback?'));
    expect(googleVideoAssets).toHaveLength(2);
    expect(googleVideoAssets[0]?.id).toBe(googleVideoAssets[1]?.id);
    for (const asset of googleVideoAssets) {
      expect(asset).toMatchObject({
        kind: 'video',
        mime: 'video/mp4',
        size: 10_000,
        lastObservedAt: expect.any(Number),
      });
      expect(asset.lastObservedAt).toBe(asset.discoveredAt);
      expect(asset.url).not.toMatch(/[?&](?:range|rn|rbuf)=/u);
      expect(asset.url).toContain('sig=shared-signature');
    }

    const assetCountBeforeRejectedRequests = assets.length;
    for (const request of [
      {
        requestId: 'post-video',
        url: 'https://cdn.example/upload.mp4',
        method: 'POST',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '1000' },
        ],
      },
      {
        requestId: 'head-video',
        url: 'https://cdn.example/video.mp4',
        method: 'HEAD',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '1000' },
        ],
      },
      {
        requestId: 'tiny-telemetry',
        url: 'https://data.bilibili.com/web',
        method: 'GET',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '2' },
        ],
      },
      {
        requestId: 'mime-only-xhr',
        url: 'https://api.example/web',
        method: 'GET',
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: '1000' },
        ],
      },
    ] as const) {
      headersListener?.({
        requestId: request.requestId,
        url: request.url,
        tabId: 4,
        frameId: 0,
        parentFrameId: -1,
        type: 'xmlhttprequest',
        method: request.method,
        timeStamp: 103,
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: [...request.responseHeaders],
        documentId: 'doc-1',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
      });
    }
    await Promise.resolve();

    expect(assets).toHaveLength(assetCountBeforeRejectedRequests);
    expect(observations.slice(-4).map((item) => item.method)).toEqual([
      'POST',
      'HEAD',
      'GET',
      'GET',
    ]);
    stopNetworkObserver();
  });
});
