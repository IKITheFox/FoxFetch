import { describe, expect, it } from 'vitest';

import {
  BILIBILI_MANIFEST_CACHE_KEY,
  BILIBILI_MANIFEST_HOOK_VERSION,
  BILIBILI_MANIFEST_READY_EVENT,
  BILIBILI_ROUTE_CHANGED_EVENT,
  installBilibiliManifestCaptureMainWorld,
  replayCapturedBilibiliManifestRequestForCurrentRoute,
  type BilibiliManifestCache,
  type BilibiliManifestReadyDetail,
} from '../../src/modules/detector/bilibili-manifest-capture-main';

const PAGE_A = 'https://www.bilibili.com/video/BV1CURRENT1/?p=2';
const PLAYURL_A =
  'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1CURRENT1&cid=123&fnval=4048';
const PLAYURL_B =
  'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1PREFETCH2&cid=456&fnval=4048';
const VIDEO_URL = 'https://upos-video.bilivideo.com/upgcxcode/1/2/item-100145.m4s?token=1';
const AUDIO_URL = 'https://upos-audio.bilivideo.com/upgcxcode/1/2/item-30216.m4s?token=2';

function manifestJson(identity?: { bvid?: string; cid?: string }): string {
  return JSON.stringify({
    code: 0,
    ...identity,
    data: {
      secret: 'must-not-be-cached',
      timelength: 10_000,
      dash: {
        video: [{ baseUrl: VIDEO_URL, mimeType: 'video/mp4' }],
        audio: [{ baseUrl: AUDIO_URL, mimeType: 'audio/mp4' }],
      },
    },
  });
}

type InstallScope = NonNullable<Parameters<typeof installBilibiliManifestCaptureMainWorld>[0]> & {
  [BILIBILI_MANIFEST_CACHE_KEY]?: BilibiliManifestCache;
};

function fakeResponse(body = manifestJson()): Response {
  return {
    headers: { get: () => String(body.length) },
    clone: () => ({ text: async () => body }),
  } as unknown as Response;
}

async function settleCapture(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Bilibili document-start manifest capture', () => {
  it('clones fetch responses without consuming or replacing the original promise', async () => {
    let receiver: unknown;
    let cloned = 0;
    let originalRead = 0;
    const response = {
      headers: { get: () => String(manifestJson().length) },
      clone() {
        cloned += 1;
        return { text: async () => manifestJson() };
      },
      async text() {
        originalRead += 1;
        return manifestJson();
      },
    } as unknown as Response;
    const originalPromise = Promise.resolve(response);
    const originalFetch = Object.assign(
      function (this: unknown): Promise<Response> {
        // The assertion intentionally verifies the native receiver is preserved.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        receiver = this;
        return originalPromise;
      },
      { staticSentinel: 42 },
    );
    const scope = {
      location: { href: PAGE_A },
      fetch: originalFetch as typeof fetch,
    } as unknown as InstallScope;
    const originalPrototype = Object.getPrototypeOf(originalFetch);

    expect(installBilibiliManifestCaptureMainWorld(scope)).toMatchObject({
      fetch: true,
      alreadyInstalled: false,
    });
    const callingReceiver = { name: 'page-fetch-receiver' };
    const returned = scope.fetch?.call(callingReceiver, PLAYURL_A);
    expect(returned).toBe(originalPromise);
    await returned;
    await settleCapture();

    expect(receiver).toBe(callingReceiver);
    expect(Object.getPrototypeOf(scope.fetch)).toBe(originalPrototype);
    expect(Reflect.get(scope.fetch as object, 'staticSentinel')).toBe(42);
    expect(cloned).toBe(1);
    expect(originalRead).toBe(0);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1CURRENT1',
      cid: '123',
      candidates: [
        expect.objectContaining({ kind: 'video', url: VIDEO_URL }),
        expect.objectContaining({ kind: 'audio', url: AUDIO_URL }),
      ],
    });
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).not.toHaveProperty('part');
    expect(JSON.stringify(scope[BILIBILI_MANIFEST_CACHE_KEY])).not.toContain('must-not-be-cached');

    const installedFetch = scope.fetch;
    expect(installBilibiliManifestCaptureMainWorld(scope).alreadyInstalled).toBe(true);
    expect(scope.fetch).toBe(installedFetch);
  });

  it('keeps immutable request identity when a prefetched fetch resolves after the route changes', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const events: BilibiliManifestReadyDetail[] = [];
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => responsePromise) as typeof fetch,
      CustomEvent: class<T> {
        constructor(
          readonly type: string,
          readonly init: CustomEventInit<T>,
        ) {}

        get detail(): T {
          return this.init.detail as T;
        }
      } as unknown as typeof CustomEvent,
      dispatchEvent(event: Event) {
        const manifestEvent = event as CustomEvent<BilibiliManifestReadyDetail>;
        expect(manifestEvent.type).toBe(BILIBILI_MANIFEST_READY_EVENT);
        events.push(manifestEvent.detail);
        return true;
      },
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    const returned = scope.fetch?.(PLAYURL_B);
    scope.location.href = 'https://www.bilibili.com/video/BV1AFTER999/?p=1';
    resolveResponse?.(fakeResponse());
    await returned;
    await settleCapture();

    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1PREFETCH2',
      cid: '456',
    });
    expect(events).toEqual([{ bvid: 'BV1PREFETCH2', cid: '456', revision: 1 }]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(JSON.stringify(events)).not.toContain('http');
  });

  it('normalizes protocol-relative fetch inputs before applying the strict API allowlist', async () => {
    let cloneCount = 0;
    const scope = {
      location: { href: PAGE_A },
      fetch: (() =>
        Promise.resolve({
          headers: { get: () => String(manifestJson().length) },
          clone() {
            cloneCount += 1;
            return { text: async () => manifestJson() };
          },
        } as unknown as Response)) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.(
      '//api.bilibili.com/x/player/wbi/playurl?bvid=BV1PREFETCH2&cid=456&fnval=4048',
    );
    await scope.fetch?.('/x/player/wbi/playurl?bvid=BV1CURRENT1&cid=123');
    await settleCapture();

    expect(cloneCount).toBe(1);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1PREFETCH2',
      cid: '456',
    });
  });

  it('captures prefetched JSON XHR responses even before location moves to that BVID', () => {
    class FakeXhr {
      status = 200;
      responseType = 'json';
      response: unknown = JSON.parse(manifestJson());
      responseText = '';
      private readonly listeners = new Map<string, () => void>();

      addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
      }

      open(_method: string, _url: string): void {}

      send(): void {
        this.listeners.get('load')?.();
      }
    }

    const scope = {
      location: { href: PAGE_A },
      XMLHttpRequest: FakeXhr,
    } as unknown as InstallScope;
    expect(installBilibiliManifestCaptureMainWorld(scope)).toMatchObject({ xhr: true });

    const Xhr = scope.XMLHttpRequest!;
    const prefetched = new Xhr();
    prefetched.open('GET', PLAYURL_B);
    scope.location.href = 'https://www.bilibili.com/video/BV1PREFETCH2/';
    prefetched.send();

    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1PREFETCH2',
      cid: '456',
    });
  });

  it('rejects non-allowlisted requests, non-GET requests, and mismatched response identities', async () => {
    let cloneCount = 0;
    const body = manifestJson({ bvid: 'BV1DIFFERENT', cid: '999' });
    const scope = {
      location: { href: PAGE_A },
      fetch: (() =>
        Promise.resolve({
          headers: { get: () => String(body.length) },
          clone() {
            cloneCount += 1;
            return { text: async () => body };
          },
        } as unknown as Response)) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.('https://api.bilibili.com/x/player/playurl?bvid=BV1CURRENT1&cid=123', {
      method: 'POST',
    });
    await scope.fetch?.(
      'https://api.bilibili.com.evil.example/x/player/playurl?bvid=BV1CURRENT1&cid=123',
    );
    await scope.fetch?.('http://api.bilibili.com/x/player/playurl?bvid=BV1CURRENT1&cid=123');
    await scope.fetch?.(PLAYURL_A);
    await settleCapture();

    expect(cloneCount).toBe(1);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]).toBeUndefined();
  });

  it('keeps a bounded recommendation-prefetch cache and de-duplicates one BVID/CID', async () => {
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => Promise.resolve(fakeResponse())) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    for (let index = 1; index <= 40; index += 1) {
      await scope.fetch?.(
        `https://api.bilibili.com/x/player/playurl?bvid=BV1CACHE${index}&cid=${index}`,
      );
      await settleCapture();
    }
    scope.location.href = 'https://www.bilibili.com/video/BV1CACHE40/?p=9';
    await scope.fetch?.(
      'https://api.bilibili.com/x/player/playurl?bvid=BV1CACHE40&cid=40&fnval=4048',
    );
    await settleCapture();

    const entries = scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries ?? [];
    expect(entries).toHaveLength(32);
    expect(
      entries.filter((entry) => entry.bvid === 'BV1CACHE40' && entry.cid === '40'),
    ).toHaveLength(1);
  });

  it('unions incremental representations and replaces only refreshed signed mirrors', async () => {
    const refreshedVideoUrl =
      'https://upos-video.bilivideo.com/upgcxcode/1/2/item-100145.m4s?token=refreshed';
    const bodies = [
      manifestJson(),
      JSON.stringify({
        code: 0,
        data: {
          timelength: 10_000,
          dash: {
            video: [
              {
                id: 80,
                codecid: 7,
                baseUrl: refreshedVideoUrl,
                mimeType: 'video/mp4',
              },
            ],
          },
        },
      }),
    ];
    // Add matching representation identity to the first response.
    const first = JSON.parse(bodies[0]!) as {
      data: { dash: { video: Array<Record<string, unknown>> } };
    };
    Object.assign(first.data.dash.video[0]!, { id: 80, codecid: 7 });
    bodies[0] = JSON.stringify(first);
    let request = 0;
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => Promise.resolve(fakeResponse(bodies[request++]))) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.(PLAYURL_A);
    await settleCapture();
    await scope.fetch?.(PLAYURL_A);
    await settleCapture();

    const candidates = scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.url)).toContain(refreshedVideoUrl);
    expect(candidates.map((candidate) => candidate.url)).not.toContain(VIDEO_URL);
    expect(candidates.map((candidate) => candidate.url)).toContain(AUDIO_URL);
    expect(candidates.filter((candidate) => candidate.kind === 'audio')).toHaveLength(1);
  });

  it('retains an earlier delivered HDR representation across incremental same-BVID/CID responses', async () => {
    const hdrUrl = 'https://upos-video.bilivideo.com/upgcxcode/1/2/item-125-hevc.m4s?token=hdr';
    const avcUrl = 'https://upos-video.bilivideo.com/upgcxcode/1/2/item-80-avc.m4s?token=avc';
    const bodies = [
      JSON.stringify({
        code: 0,
        data: {
          timelength: 10_000,
          support_formats: [{ quality: 125, new_description: 'HDR 真彩' }],
          dash: {
            video: [
              {
                id: 125,
                codecid: 12,
                codecs: 'hev1.2.4.L120.90',
                baseUrl: hdrUrl,
                mimeType: 'video/mp4',
              },
            ],
            audio: [
              {
                id: 30280,
                codecs: 'mp4a.40.2',
                baseUrl: AUDIO_URL,
                mimeType: 'audio/mp4',
              },
            ],
          },
        },
      }),
      JSON.stringify({
        code: 0,
        data: {
          timelength: 10_000,
          support_formats: [{ quality: 80, new_description: '1080P 高清' }],
          dash: {
            video: [
              {
                id: 80,
                codecid: 7,
                codecs: 'avc1.640028',
                baseUrl: avcUrl,
                mimeType: 'video/mp4',
              },
            ],
          },
        },
      }),
    ];
    let request = 0;
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => Promise.resolve(fakeResponse(bodies[request++]))) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.(PLAYURL_A);
    await settleCapture();
    await scope.fetch?.(PLAYURL_A);
    await settleCapture();

    const entry = scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0];
    expect(entry?.revision).toBe(2);
    expect(
      entry?.candidates
        .filter((candidate) => candidate.kind === 'video')
        .map((candidate) => candidate.representation?.qn),
    ).toEqual([80, 125]);
    expect(entry?.candidates.map((candidate) => candidate.url)).toEqual(
      expect.arrayContaining([avcUrl, hdrUrl, AUDIO_URL]),
    );
    expect(entry?.diagnostics?.advertisedFormats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          qn: 125,
          dynamicRange: 'HDR',
          capabilities: expect.objectContaining({ advertised: true, delivered: true }),
        }),
      ]),
    );
  });

  it('replays a prefetched manifest identity when its SPA route becomes current', async () => {
    const events: BilibiliManifestReadyDetail[] = [];
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => Promise.resolve(fakeResponse())) as typeof fetch,
      CustomEvent: class<T> {
        constructor(
          readonly type: string,
          readonly init: CustomEventInit<T>,
        ) {}

        get detail(): T {
          return this.init.detail as T;
        }
      } as unknown as typeof CustomEvent,
      dispatchEvent(event: Event) {
        events.push((event as CustomEvent<BilibiliManifestReadyDetail>).detail);
        return true;
      },
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);
    await scope.fetch?.(PLAYURL_B);
    await settleCapture();
    events.length = 0;

    scope.location.href = 'https://www.bilibili.com/video/BV1PREFETCH2/';
    installBilibiliManifestCaptureMainWorld(scope);
    expect(events).toEqual([{ bvid: 'BV1PREFETCH2', cid: '456', revision: 1 }]);

    installBilibiliManifestCaptureMainWorld(scope);
    expect(events).toHaveLength(1);
  });

  it('repairs replaced fetch and XHR hooks without wrapping its own healthy hooks', async () => {
    let firstFetchCalls = 0;
    let replacementFetchCalls = 0;
    let replacementOpenCalls = 0;
    class FakeXhr {
      status = 200;
      responseType = 'json';
      response: unknown = JSON.parse(manifestJson());
      responseText = '';
      private readonly listeners = new Map<string, () => void>();

      addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
      }

      open(_method: string, _url: string): void {}

      send(): void {
        this.listeners.get('load')?.();
      }
    }
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => {
        firstFetchCalls += 1;
        return Promise.resolve(fakeResponse());
      }) as typeof fetch,
      XMLHttpRequest: FakeXhr,
    } as unknown as InstallScope;

    installBilibiliManifestCaptureMainWorld(scope);
    const firstWrappedFetch = scope.fetch;
    const firstWrappedOpen = scope.XMLHttpRequest?.prototype.open;
    installBilibiliManifestCaptureMainWorld(scope);
    expect(scope.fetch).toBe(firstWrappedFetch);
    expect(scope.XMLHttpRequest?.prototype.open).toBe(firstWrappedOpen);

    scope.fetch = (() => {
      replacementFetchCalls += 1;
      return Promise.resolve(fakeResponse());
    }) as typeof fetch;
    const replacementOpen = function (this: XMLHttpRequest, _method: string, _url: string): void {
      replacementOpenCalls += 1;
    };
    scope.XMLHttpRequest!.prototype.open = replacementOpen as XMLHttpRequest['open'];
    const repaired = installBilibiliManifestCaptureMainWorld(scope);
    expect(repaired).toMatchObject({ fetch: true, xhr: true, alreadyInstalled: true });
    expect(scope.fetch).not.toBe(firstWrappedFetch);
    expect(scope.fetch).not.toBe(replacementOpen);
    expect(scope.XMLHttpRequest?.prototype.open).not.toBe(replacementOpen);

    await scope.fetch?.(PLAYURL_A);
    await settleCapture();
    const RepairedXhr = scope.XMLHttpRequest!;
    const repairedXhr = new RepairedXhr();
    repairedXhr.open('GET', PLAYURL_B);
    repairedXhr.send();
    expect(firstFetchCalls).toBe(0);
    expect(replacementFetchCalls).toBe(1);
    expect(replacementOpenCalls).toBe(1);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1PREFETCH2',
      cid: '456',
    });
  });

  it('captures Request-shaped fetch input, credentials, a fragment-free URL, and revisions', async () => {
    const scope = {
      location: { href: PAGE_A },
      fetch: (() => Promise.resolve(fakeResponse())) as typeof fetch,
    } as unknown as InstallScope;
    const first = installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.({
      url: `${PLAYURL_A}#page-owned-fragment`,
      method: 'GET',
      credentials: 'include',
    } as Request);
    await settleCapture();
    await scope.fetch?.(PLAYURL_A);
    await settleCapture();

    expect(first).toMatchObject({
      version: BILIBILI_MANIFEST_HOOK_VERSION,
      checkRevision: 1,
      captureRevision: 0,
    });
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]).toMatchObject({
      revision: 2,
      entries: [
        expect.objectContaining({
          bvid: 'BV1CURRENT1',
          cid: '123',
          revision: 2,
          requestUrl: PLAYURL_A,
          requestCredentials: 'same-origin',
        }),
      ],
    });
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]?.requestUrl).not.toContain('#');
  });

  it('maps aid/avid only when current INITIAL_STATE proves the exact BVID and CID', async () => {
    let cloneCount = 0;
    const scope = {
      location: { href: PAGE_A },
      __INITIAL_STATE__: {
        bvid: 'BV1CURRENT1',
        aid: 98_765,
        videoData: {
          bvid: 'BV1CURRENT1',
          aid: 98_765,
          pages: [
            { page: 1, cid: 111 },
            { page: 2, cid: 123 },
          ],
        },
      },
      fetch: (() =>
        Promise.resolve({
          headers: { get: () => String(manifestJson().length) },
          clone() {
            cloneCount += 1;
            return { text: async () => manifestJson() };
          },
        } as unknown as Response)) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);

    await scope.fetch?.(
      'https://api.bilibili.com/x/player/wbi/playurl?avid=98765&cid=123&fnval=4048',
    );
    await scope.fetch?.(
      'https://api.bilibili.com/x/player/wbi/playurl?avid=98765&cid=111&fnval=4048',
    );
    await scope.fetch?.(
      'https://api.bilibili.com/x/player/wbi/playurl?aid=98766&cid=123&fnval=4048',
    );
    await settleCapture();

    expect(cloneCount).toBe(1);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1CURRENT1',
      cid: '123',
      revision: 1,
    });
  });

  it('uses the current INITIAL_STATE part CID to replay one unambiguous cache revision', async () => {
    const events: BilibiliManifestReadyDetail[] = [];
    const scope = {
      location: { href: 'https://www.bilibili.com/video/BV1CURRENT1/?p=2' },
      __INITIAL_STATE__: {
        bvid: 'BV1CURRENT1',
        videoData: {
          bvid: 'BV1CURRENT1',
          pages: [
            { page: 1, cid: 111 },
            { page: 2, cid: 222 },
          ],
        },
      },
      fetch: (() => Promise.resolve(fakeResponse())) as typeof fetch,
      CustomEvent: class<T> {
        constructor(
          readonly type: string,
          readonly init: CustomEventInit<T>,
        ) {}

        get detail(): T {
          return this.init.detail as T;
        }
      } as unknown as typeof CustomEvent,
      dispatchEvent(event: Event) {
        if (event.type === BILIBILI_MANIFEST_READY_EVENT) {
          events.push((event as CustomEvent<BilibiliManifestReadyDetail>).detail);
        }
        return true;
      },
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);
    await scope.fetch?.('https://api.bilibili.com/x/player/playurl?bvid=BV1CURRENT1&cid=111');
    await settleCapture();
    await scope.fetch?.('https://api.bilibili.com/x/player/playurl?bvid=BV1CURRENT1&cid=222');
    await settleCapture();
    events.length = 0;

    installBilibiliManifestCaptureMainWorld(scope);

    expect(events).toEqual([{ bvid: 'BV1CURRENT1', cid: '222', revision: 2 }]);
  });

  it('bridges pushState, replaceState and popstate without stacking wrappers', () => {
    const listeners = new Map<string, Set<EventListener>>();
    const routeEvents: Array<{ bvid: string; cid?: string }> = [];
    let pushCalls = 0;
    let replaceCalls = 0;
    let pushReceiver: unknown;
    const scope = {
      location: { href: PAGE_A },
      history: {
        pushState(this: unknown, _data: unknown, _unused: string, url?: string | URL | null) {
          pushCalls += 1;
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          pushReceiver = this;
          if (url != null) scope.location.href = new URL(String(url), scope.location.href).href;
        },
        replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
          replaceCalls += 1;
          if (url != null) scope.location.href = new URL(String(url), scope.location.href).href;
        },
      },
      CustomEvent: class<T> {
        constructor(
          readonly type: string,
          readonly init: CustomEventInit<T>,
        ) {}

        get detail(): T {
          return this.init.detail as T;
        }
      } as unknown as typeof CustomEvent,
      dispatchEvent(event: Event) {
        if (event.type === BILIBILI_ROUTE_CHANGED_EVENT) {
          routeEvents.push((event as CustomEvent<{ bvid: string; cid?: string }>).detail);
        }
        return true;
      },
      addEventListener(type: string, listener: EventListener) {
        const bucket = listeners.get(type) ?? new Set<EventListener>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
    } as unknown as InstallScope;

    const first = installBilibiliManifestCaptureMainWorld(scope);
    const installedPush = scope.history?.pushState;
    const second = installBilibiliManifestCaptureMainWorld(scope);
    expect(scope.history?.pushState).toBe(installedPush);
    expect(first).toMatchObject({ routeBridgeBound: true, checkRevision: 1 });
    expect(second).toMatchObject({ routeBridgeBound: true, checkRevision: 2 });

    scope.history?.pushState({}, '', '/video/BV1PREFETCH2/?cid=456');
    scope.history?.replaceState({}, '', '/video/BV1PREFETCH2/?cid=456&p=2');
    for (const listener of listeners.get('popstate') ?? []) listener(new Event('popstate'));

    expect(pushCalls).toBe(1);
    expect(replaceCalls).toBe(1);
    expect(pushReceiver).toBe(scope.history);
    expect(routeEvents).toEqual([
      { bvid: 'BV1PREFETCH2', cid: '456' },
      { bvid: 'BV1PREFETCH2', cid: '456' },
      { bvid: 'BV1PREFETCH2', cid: '456' },
    ]);
  });

  it('recovers a missed current manifest from a recent strict Performance entry', async () => {
    const fetchCredentials: RequestCredentials[] = [];
    const scope = {
      location: { href: `${PAGE_A}&cid=123` },
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCredentials.push(init?.credentials ?? 'same-origin');
        return Promise.resolve(fakeResponse());
      }) as typeof fetch,
      performance: {
        now: () => 25_000,
        getEntriesByType: () =>
          [
            {
              name: `${PLAYURL_A}#ignored`,
              startTime: 9_000,
              responseEnd: 10_000,
            } as PerformanceResourceTiming,
          ] as PerformanceEntryList,
      },
    } as unknown as InstallScope;

    installBilibiliManifestCaptureMainWorld(scope);
    await settleCapture();
    await settleCapture();

    expect(fetchCredentials).toEqual(['include']);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.entries[0]).toMatchObject({
      bvid: 'BV1CURRENT1',
      cid: '123',
      revision: 1,
      requestUrl: PLAYURL_A,
      requestCredentials: 'include',
    });
  });

  it('actively replays a captured request at most once across the refreshed revision', async () => {
    let fetchCalls = 0;
    const scope = {
      location: { href: `${PAGE_A}&cid=123` },
      fetch: (() => {
        fetchCalls += 1;
        return Promise.resolve(fakeResponse());
      }) as typeof fetch,
    } as unknown as InstallScope;
    installBilibiliManifestCaptureMainWorld(scope);
    await scope.fetch?.(PLAYURL_A, { credentials: 'include' });
    await settleCapture();

    expect(await replayCapturedBilibiliManifestRequestForCurrentRoute(scope)).toBe(true);
    expect(await replayCapturedBilibiliManifestRequestForCurrentRoute(scope)).toBe(false);
    expect(fetchCalls).toBe(2);
    expect(scope[BILIBILI_MANIFEST_CACHE_KEY]?.revision).toBe(2);
  });
});
