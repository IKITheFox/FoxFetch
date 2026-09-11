import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractCssUrls,
  extractSrcsetUrls,
  MediaDetector,
  resolveMediaUrl,
  scanDocument,
} from '../../src/modules/detector';
import type { MediaAsset } from '../../src/shared/types';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('media detector parsers', () => {
  it('extracts CSS URLs and srcset candidates', () => {
    expect(extractCssUrls('linear-gradient(#000,#fff), url("/a.webp"), url(\'b.png\')')).toEqual([
      '/a.webp',
      'b.png',
    ]);
    expect(extractSrcsetUrls('/small.jpg 1x, /large.jpg 2x, /wide.jpg 1280w')).toEqual([
      '/small.jpg',
      '/large.jpg',
      '/wide.jpg',
    ]);
    expect(extractSrcsetUrls('data:image/png;base64,AAAA 1x, /fallback.png 2x')).toEqual([
      'data:image/png;base64,AAAA',
      '/fallback.png',
    ]);
    expect(resolveMediaUrl('../clip.mp4', 'https://example.com/path/page')).toBe(
      'https://example.com/clip.mp4',
    );
    expect(resolveMediaUrl('javascript:alert(1)', 'https://example.com')).toBeUndefined();
  });
});

describe('scanDocument', () => {
  it('collects DOM, poster, CSS, links and performance resources with deduplication', () => {
    document.title = 'Media page';
    document.head.innerHTML = `
      <link rel="preload" as="audio" href="/teaser.bin" type="audio/aac">
      <meta property="og:image" content="/social.jpg">
    `;
    document.body.innerHTML = `
      <picture>
        <source srcset="/hero-small.webp 1x, /hero-large.webp 2x" type="image/webp">
        <img src="/hero.jpg" srcset="/hero.jpg 1x, /hero@2x.jpg 2x">
      </picture>
      <video src="/movie.mp4" poster="/poster.webp">
        <source src="/adaptive.m3u8" type="application/vnd.apple.mpegurl">
      </video>
      <audio><source src="/track.flac" type="audio/flac"></audio>
      <div style="background-image: url('/background.avif')"></div>
      <a href="/download.webm">download</a>
    `;

    const performanceEntry = {
      name: new URL('/hero.jpg', document.baseURI).href,
      entryType: 'resource',
      startTime: 0,
      duration: 1,
      initiatorType: 'img',
      encodedBodySize: 4_096,
      toJSON: () => ({}),
    } as unknown as PerformanceEntry;
    const assets = scanDocument(document, {
      now: () => 123,
      performanceEntries: [performanceEntry],
    });

    const byPath = (path: string) => assets.find((asset) => new URL(asset.url).pathname === path);
    expect(byPath('/hero.jpg')).toMatchObject({
      kind: 'image',
      detectedBy: expect.arrayContaining(['dom', 'performance']),
      size: 4_096,
      discoveredAt: 123,
    });
    expect(byPath('/adaptive.m3u8')).toMatchObject({ kind: 'playlist' });
    expect(byPath('/movie.mp4')).toMatchObject({
      kind: 'video',
      poster: expect.stringContaining('/poster.webp'),
    });
    expect(byPath('/poster.webp')).toMatchObject({ kind: 'image' });
    expect(byPath('/track.flac')).toMatchObject({ kind: 'audio', mime: 'audio/flac' });
    expect(byPath('/background.avif')).toMatchObject({ kind: 'image' });
    expect(byPath('/download.webm')).toMatchObject({ kind: 'video', detectedBy: ['link'] });
    expect(byPath('/teaser.bin')).toMatchObject({
      kind: 'audio',
      mime: 'audio/aac',
      extension: 'aac',
    });
    expect(byPath('/social.jpg')).toMatchObject({ kind: 'image', detectedBy: ['link'] });
  });

  it('scans media inside open shadow roots', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<img src="/shadow-image.png">';
    document.body.append(host);

    expect(scanDocument(document, { performanceEntries: [] })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: expect.stringContaining('/shadow-image.png'),
          kind: 'image',
        }),
      ]),
    );
  });

  it('ignores HTML player metadata while retaining direct media metadata', () => {
    document.head.innerHTML = `
      <meta property="og:video" content="/embed/player.html">
      <meta name="twitter:player:stream" content="/twitter/player.xhtml?autoplay=1">
      <meta property="og:video" content="/direct/movie.mp4">
      <meta name="twitter:player:stream" content="/direct/preview.webm">
      <meta property="og:audio" content="/direct/theme.mp3">
    `;

    const paths = scanDocument(document, { performanceEntries: [] }).map(
      (asset) => new URL(asset.url).pathname,
    );

    expect(paths).not.toContain('/embed/player.html');
    expect(paths).not.toContain('/twitter/player.xhtml');
    expect(paths).toEqual(
      expect.arrayContaining(['/direct/movie.mp4', '/direct/preview.webm', '/direct/theme.mp3']),
    );
  });

  it('ignores HTML documents assigned to media elements without a media MIME', () => {
    document.body.innerHTML = `
      <video src="https://player.example/embed/player.html"></video>
      <audio><source src="/audio-shell.xhtml"></audio>
      <video><source src="/actual-stream.html" type="video/mp4"></video>
    `;

    const assets = scanDocument(document, { performanceEntries: [] });
    const paths = assets.map((asset) => new URL(asset.url).pathname);

    expect(paths).not.toContain('/embed/player.html');
    expect(paths).not.toContain('/audio-shell.xhtml');
    expect(paths).toContain('/actual-stream.html');
  });

  it('does not publish a stale currentSrc while an SPA replaces the explicit media source', () => {
    const video = document.createElement('video');
    video.setAttribute('src', '/new-route.mp4');
    Object.defineProperty(video, 'currentSrc', {
      configurable: true,
      value: new URL('/old-route.mp4', document.baseURI).href,
    });
    document.body.append(video);

    const urls = scanDocument(document, { performanceEntries: [] }).map((asset) => asset.url);

    expect(urls).toContain(new URL('/new-route.mp4', document.baseURI).href);
    expect(urls).not.toContain(new URL('/old-route.mp4', document.baseURI).href);
  });

  it('uses meaningful fallback names for unresolved Blob media', () => {
    document.body.innerHTML = `
      <video src="blob:https://example.com/9c7bf23f-9f76-45c2-8e91-767ec1b7e001"></video>
      <audio src="blob:https://example.com/e83d694c-1653-483c-a203-d2e436fa91ce"></audio>
    `;

    const assets = scanDocument(document, { performanceEntries: [] });

    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'video', filename: '待解析视频', downloadable: false }),
        expect.objectContaining({ kind: 'audio', filename: '待解析音频', downloadable: false }),
      ]),
    );
    expect(assets.map((asset) => asset.filename)).not.toEqual(
      expect.arrayContaining([
        '9c7bf23f-9f76-45c2-8e91-767ec1b7e001',
        'e83d694c-1653-483c-a203-d2e436fa91ce',
      ]),
    );
  });

  it('ignores Performance Timing entries from before the current SPA route', () => {
    const entry = (name: string, startTime: number) =>
      ({
        name: new URL(name, document.baseURI).href,
        entryType: 'resource',
        startTime,
        duration: 1,
        initiatorType: 'video',
        toJSON: () => ({}),
      }) as unknown as PerformanceEntry;

    const assets = scanDocument(document, {
      performanceEntries: [entry('/old-route.mp4', 10), entry('/new-route.mp4', 30)],
      performanceSince: 20,
    });

    expect(assets.map((asset) => asset.url)).toEqual([expect.stringContaining('/new-route.mp4')]);
  });

  it('treats an updated media src attribute as authoritative over stale currentSrc', () => {
    const video = document.createElement('video');
    video.setAttribute('src', '/new-route.mp4');
    Object.defineProperty(video, 'currentSrc', {
      configurable: true,
      value: new URL('/old-route.mp4', document.baseURI).href,
    });
    document.body.append(video);

    const urls = scanDocument(document, { performanceEntries: [] }).map((asset) => asset.url);

    expect(urls).toContain(new URL('/new-route.mp4', document.baseURI).href);
    expect(urls).not.toContain(new URL('/old-route.mp4', document.baseURI).href);
  });
});

describe('MediaDetector', () => {
  it('observes SPA mutations and retains newly discovered media', async () => {
    vi.useFakeTimers();
    const changes: string[][] = [];
    const detector = new MediaDetector(document, {
      debounceMs: 10,
      performanceEntries: [],
      onChange: (assets) => changes.push(assets.map((asset) => asset.url)),
    });
    detector.start();

    const image = document.createElement('img');
    image.src = '/dynamic.webp';
    document.body.append(image);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(detector.getAssets()).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/dynamic.webp'), kind: 'image' }),
    ]);
    expect(changes.at(-1)).toEqual([expect.stringContaining('/dynamic.webp')]);
    detector.stop();
  });

  it('debounces media mutations and replaces removed or changed DOM assets', async () => {
    vi.useFakeTimers();
    const diffs: Array<{
      added: string[];
      updated: string[];
      removed: string[];
    }> = [];
    const detector = new MediaDetector(document, {
      debounceMs: 200,
      performanceEntries: [],
      onDiff: (diff) =>
        diffs.push({
          added: diff.added.map((asset) => asset.url),
          updated: diff.updated.map((asset) => asset.url),
          removed: diff.removed.map((asset) => asset.url),
        }),
    });
    detector.start();

    const video = document.createElement('video');
    video.src = '/first.mp4';
    document.body.append(video);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(199);
    expect(detector.getAssets()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(detector.getAssets()).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/first.mp4') }),
    ]);

    video.src = '/second.mp4';
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(detector.getAssets()).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/second.mp4') }),
    ]);
    expect(diffs.at(-1)).toMatchObject({
      added: [expect.stringContaining('/second.mp4')],
      removed: [expect.stringContaining('/first.mp4')],
    });

    video.remove();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(detector.getAssets()).toEqual([]);
    expect(diffs.at(-1)?.removed).toEqual([expect.stringContaining('/second.mp4')]);
    detector.stop();
  });

  it('automatically follows pushState and replaceState route changes', async () => {
    vi.useFakeTimers();
    const originalUrl = location.href;
    const detector = new MediaDetector(document, {
      debounceMs: 20,
      performanceEntries: [],
    });
    try {
      document.body.innerHTML = '<video src="/route-one.mp4"></video>';
      detector.start();

      history.pushState({}, '', '/route-two');
      document.body.innerHTML = '<video src="/route-two.mp4"></video>';
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/route-two.mp4') }),
      ]);

      history.replaceState({}, '', '/route-three');
      document.body.innerHTML = '<audio src="/route-three.mp3"></audio>';
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/route-three.mp3') }),
      ]);
    } finally {
      detector.stop();
      history.replaceState({}, '', originalUrl);
    }
  });

  it('publishes a fresh snapshot when an SPA updates only the page title', async () => {
    vi.useFakeTimers();
    const originalTitle = document.title;
    const snapshots: MediaAsset[][] = [];
    const detector = new MediaDetector(document, {
      debounceMs: 20,
      performanceEntries: [],
      onChange: (assets) => snapshots.push(assets),
    });
    try {
      document.title = '第一个视频';
      document.body.innerHTML = '<video src="/same-player.mp4"></video>';
      detector.start();

      document.title = '第二个视频';
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);

      expect(snapshots).toHaveLength(2);
      expect(snapshots.at(-1)?.[0]).toMatchObject({
        pageTitle: '第二个视频',
        url: expect.stringContaining('/same-player.mp4'),
      });
    } finally {
      detector.stop();
      document.title = originalTitle;
    }
  });

  it('rescans after a YouTube navigation event even without a DOM mutation', async () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    document.body.append(video);
    const detector = new MediaDetector(document, {
      debounceMs: 20,
      performanceEntries: [],
    });
    detector.start();
    expect(detector.getAssets()).toEqual([]);

    Object.defineProperty(video, 'currentSrc', {
      configurable: true,
      value: new URL('/event-driven.mp4', document.baseURI).href,
    });
    document.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.advanceTimersByTimeAsync(20);

    expect(detector.getAssets()).toEqual([
      expect.objectContaining({ url: expect.stringContaining('/event-driven.mp4') }),
    ]);
    detector.stop();
  });

  it('uses URL polling only as a navigation fallback, not as a periodic full scan', async () => {
    vi.useFakeTimers();
    const detector = new MediaDetector(document, {
      debounceMs: 20,
      navigationPollMs: 100,
      performanceEntries: [],
    });
    const scan = vi.spyOn(detector, 'scanNow');
    detector.start();
    await vi.advanceTimersByTimeAsync(100);
    const settledCalls = scan.mock.calls.length;

    await vi.advanceTimersByTimeAsync(500);
    expect(scan).toHaveBeenCalledTimes(settledCalls);
    detector.stop();
  });

  it('coalesces PerformanceObserver entries and expires network-only media by TTL', async () => {
    vi.useFakeTimers();
    const originalObserver = window.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;
    class FakePerformanceObserver implements PerformanceObserver {
      constructor(nextCallback: PerformanceObserverCallback) {
        callback = nextCallback;
      }
      disconnect(): void {}
      observe(): void {}
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }
    Object.defineProperty(window, 'PerformanceObserver', {
      configurable: true,
      value: FakePerformanceObserver,
    });
    const detector = new MediaDetector(document, {
      debounceMs: 20,
      performanceEntries: [],
      performanceTtlMs: 100,
    });
    try {
      detector.start();
      const entry = {
        name: new URL('/network-only.mp4', document.baseURI).href,
        entryType: 'resource',
        startTime: 10,
        duration: 1,
        initiatorType: 'video',
        toJSON: () => ({}),
      } as unknown as PerformanceEntry;
      callback?.(
        { getEntries: () => [entry] } as unknown as PerformanceObserverEntryList,
        {} as PerformanceObserver,
      );
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({
          url: expect.stringContaining('/network-only.mp4'),
          detectedBy: ['performance'],
        }),
      ]);

      await vi.advanceTimersByTimeAsync(99);
      expect(detector.getAssets()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(detector.getAssets()).toEqual([]);
    } finally {
      detector.stop();
      Object.defineProperty(window, 'PerformanceObserver', {
        configurable: true,
        value: originalObserver,
      });
    }
  });

  it('drops old Performance Timing media on a same-URL media generation reset', () => {
    const entry = (name: string, startTime: number) =>
      ({
        name: new URL(name, document.baseURI).href,
        entryType: 'resource',
        startTime,
        duration: 1,
        initiatorType: 'video',
        encodedBodySize: 4_096,
        toJSON: () => ({}),
      }) as unknown as PerformanceEntry;
    const oldPerformance = entry('/old-generation.mp4', 10);
    const entries: PerformanceEntry[] = [oldPerformance];
    const performanceNow = vi.spyOn(window.performance, 'now').mockReturnValue(20);
    const detector = new MediaDetector(document, {
      performanceEntries: entries,
      performanceTtlMs: 60_000,
    });

    try {
      detector.start();
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({
          url: expect.stringContaining('/old-generation.mp4'),
          detectedBy: ['performance'],
        }),
      ]);

      // A real SPA may remove the previous player one task before it inserts the
      // replacement. The reset must purge the old TTL entry even while the DOM
      // has no current player.
      document.body.replaceChildren();
      detector.resetForMediaChange();

      expect(detector.getAssets()).toEqual([]);

      document.body.innerHTML = '<video src="/new-generation.mp4"></video>';
      detector.scanNow();

      expect(detector.getAssets()).toEqual([
        expect.objectContaining({
          url: expect.stringContaining('/new-generation.mp4'),
          detectedBy: ['dom'],
        }),
      ]);
      expect(detector.getAssets()).not.toContainEqual(
        expect.objectContaining({ url: expect.stringContaining('/old-generation.mp4') }),
      );

      entries.push(entry('/new-generation-network.mp4', 21));
      detector.scanNow();
      expect(detector.getAssets().map((asset) => asset.url)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('/new-generation.mp4'),
          expect.stringContaining('/new-generation-network.mp4'),
        ]),
      );
    } finally {
      detector.stop();
      performanceNow.mockRestore();
    }
  });

  it('drops media retained from the previous SPA URL', () => {
    const originalUrl = location.href;
    const detector = new MediaDetector(document, { performanceEntries: [] });
    try {
      document.body.innerHTML = '<img src="/old-page.webp">';
      detector.start();
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/old-page.webp') }),
      ]);

      history.pushState({}, '', '/next-video');
      document.body.innerHTML = '<video src="/new-page.mp4"></video>';
      detector.scanNow();

      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/new-page.mp4') }),
      ]);
    } finally {
      detector.stop();
      history.replaceState({}, '', originalUrl);
    }
  });

  it('keeps the first PerformanceObserver batch after an SPA URL change', () => {
    const originalUrl = location.href;
    const originalObserver = window.PerformanceObserver;
    let callback: PerformanceObserverCallback | undefined;

    class FakePerformanceObserver implements PerformanceObserver {
      constructor(nextCallback: PerformanceObserverCallback) {
        callback = nextCallback;
      }

      disconnect(): void {}
      observe(): void {}
      takeRecords(): PerformanceEntryList {
        return [];
      }
    }

    Object.defineProperty(window, 'PerformanceObserver', {
      configurable: true,
      value: FakePerformanceObserver,
    });
    const detector = new MediaDetector(document, { performanceEntries: [] });
    try {
      detector.start();
      history.pushState({}, '', '/observer-route');
      const entry = {
        name: new URL('/first-route-video.mp4', document.baseURI).href,
        entryType: 'resource',
        startTime: 5,
        duration: 1,
        initiatorType: 'video',
        toJSON: () => ({}),
      } as unknown as PerformanceEntry;
      callback?.(
        { getEntries: () => [entry] } as unknown as PerformanceObserverEntryList,
        {} as PerformanceObserver,
      );

      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/first-route-video.mp4') }),
      ]);
    } finally {
      detector.stop();
      history.replaceState({}, '', originalUrl);
      Object.defineProperty(window, 'PerformanceObserver', {
        configurable: true,
        value: originalObserver,
      });
    }
  });

  it('does not carry the last timed resource across an explicit SPA navigation', () => {
    const originalUrl = location.href;
    const oldEntry = {
      name: new URL('/old-route.mp4', document.baseURI).href,
      entryType: 'resource',
      startTime: 5,
      duration: 1,
      initiatorType: 'video',
      toJSON: () => ({}),
    } as unknown as PerformanceEntry;
    const entries: PerformanceEntry[] = [oldEntry];
    const detector = new MediaDetector(document, { performanceEntries: entries });

    try {
      detector.start();
      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/old-route.mp4') }),
      ]);

      history.pushState({}, '', '/explicit-route');
      detector.markNavigation();
      entries.push({
        ...oldEntry,
        name: new URL('/new-route.mp4', document.baseURI).href,
        startTime: 6,
      });
      detector.scanNow();

      expect(detector.getAssets()).toEqual([
        expect.objectContaining({ url: expect.stringContaining('/new-route.mp4') }),
      ]);
    } finally {
      detector.stop();
      history.replaceState({}, '', originalUrl);
    }
  });
});
