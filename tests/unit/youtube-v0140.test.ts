import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractYouTubeInspection,
  isYouTubePage,
  validateYouTubeInspection,
  youTubeStatusText,
} from '../../src/modules/youtube/inspection';
import { renderYouTubeInspection } from '../../src/modules/youtube/presentation';
import { PlaybackManager } from '../../src/modules/playback/playback-manager';
import { FloatingPlaybackController } from '../../src/modules/playback/floating-controller';
import { getSettings, saveSettings } from '../../src/modules/storage/settings';
import { getTabState, setTabState } from '../../src/modules/storage/tab-state';
import type { TabMediaState } from '../../src/shared/types';

const id = 'abcdefghijk';
const page = `https://www.youtube.com/watch?v=${id}`;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
function route(url = page) {
  Object.defineProperty(globalThis, 'location', { value: new URL(url), configurable: true });
  Object.defineProperty(document, 'URL', { value: url, configurable: true });
}
function response(videoId = id) {
  return {
    videoDetails: {
      videoId,
      title: '当前视频',
      lengthSeconds: '120',
      thumbnail: {
        thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg?private=secret` }],
      },
    },
    playabilityStatus: { status: 'OK' },
    streamingData: {
      formats: [
        {
          itag: 18,
          mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
          width: 640,
          height: 360,
          url: 'https://r1.googlevideo.com/videoplayback?sig=secret',
        },
      ],
      adaptiveFormats: [
        {
          itag: 248,
          mimeType: 'video/webm; codecs="vp09.00.51.08"',
          width: 1920,
          height: 1080,
          fps: 60,
          signatureCipher: 'secret',
          colorInfo: { transferCharacteristics: 'SMPTEST2084' },
        },
        {
          itag: 251,
          mimeType: 'audio/webm; codecs="opus"',
          contentLength: '1234',
          audioTrack: { id: 'en.4', audioIsDefault: true },
          url: 'https://r1.googlevideo.com/videoplayback?token=secret',
        },
      ],
      serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?secret',
    },
  };
}
function mount(value = response()) {
  const player = document.createElement('div');
  player.id = 'movie_player';
  player.innerHTML = '<video style="width:400px;height:200px" src="/current.mp4"></video>';
  Reflect.set(player, 'getPlayerResponse', () => value);
  Reflect.set(player, 'getVideoData', () => ({ video_id: id }));
  document.body.append(player);
  return player;
}
beforeEach(() => {
  route();
  const values: Record<string, unknown> = {};
  const storage = {
    get: async (keys?: string | string[] | null) =>
      typeof keys === 'string'
        ? { [keys]: values[keys] }
        : Array.isArray(keys)
          ? Object.fromEntries(keys.map((key) => [key, values[key]]))
          : { ...values },
    set: async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    },
  };
  vi.stubGlobal('chrome', { storage: { sync: storage, session: storage } });
});
afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'ytInitialPlayerResponse');
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
  else Reflect.deleteProperty(document, 'URL');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('YouTube v0.14.0 isolated inspection', () => {
  it('keeps different source versions and tags distinct at the trust boundary', () => {
    const data = response();
    const first = data.streamingData.adaptiveFormats[0]!;
    Reflect.set(first, 'lastModified', '123');
    Reflect.set(first, 'xtags', 'lang=en');
    const second = { ...first };
    Reflect.set(second, 'lastModified', '124');
    Reflect.set(second, 'xtags', 'lang=ja');
    data.streamingData.adaptiveFormats.push(second);
    mount(data);
    const extracted = extractYouTubeInspection();
    const versions = extracted.candidates.filter((c) => c.id.startsWith('248:'));
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((c) => c.id)).size).toBe(2);
    expect(validateYouTubeInspection(extracted, page)?.candidates).toHaveLength(4);
    versions[0]!.sourceTags = 'different';
    expect(validateYouTubeInspection(extracted, page)?.candidates).toHaveLength(3);
  });
  it('extracts exact current metadata and real format fields without exposing source secrets', () => {
    mount();
    const result = extractYouTubeInspection();
    expect(result).toMatchObject({
      videoId: id,
      title: '当前视频',
      duration: 120,
      status: 'identified',
      completeDownloadVerified: false,
      transports: ['sabr', 'direct', 'signed'],
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[1]).toMatchObject({
      fps: 60,
      dynamicRange: 'HDR-declared',
      source: 'signed',
    });
    expect(result.candidates[2]).toMatchObject({
      audioTrackId: 'en.4',
      defaultAudio: true,
      size: 1234,
    });
    expect(result.candidates[2]?.language).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/secret|signatureCipher|googlevideo/);
    expect(validateYouTubeInspection(result, page)).toEqual(result);
  });
  it('rejects stale player identity and never falls back to old initial data', () => {
    mount(response('mnopqrstuvw'));
    Reflect.set(window, 'ytInitialPlayerResponse', response());
    expect(extractYouTubeInspection()).toMatchObject({ status: 'waiting', candidates: [] });
  });
  it('ignores mismatched initial data when no player exists', () => {
    Reflect.set(window, 'ytInitialPlayerResponse', response('mnopqrstuvw'));
    expect(extractYouTubeInspection().status).toBe('waiting');
  });
  it.each(['ad-showing', 'ad-interrupting'])('does not expose advertising sources: %s', (cls) => {
    mount().classList.add(cls);
    expect(extractYouTubeInspection()).toMatchObject({ status: 'advertisement', candidates: [] });
  });
  it.each(['LOGIN_REQUIRED', 'ERROR', 'UNPLAYABLE'])(
    'does not expose formats for nonplayable status %s',
    (status) => {
      const value = response();
      value.playabilityStatus.status = status;
      mount(value);
      expect(extractYouTubeInspection()).toMatchObject({ status: 'unplayable', candidates: [] });
    },
  );
  it.each(['shorts', 'embed', 'live'])('only identifies page type for %s', (kind) => {
    route(`https://www.youtube.com/${kind}/${id}`);
    mount();
    const result = extractYouTubeInspection();
    expect(result.pageType).toBe(kind);
    expect(result.candidates).toEqual([]);
    expect(youTubeStatusText(result)).toContain('暂不支持');
  });
  it('separates live content from ended premieres and ordinary point-of-view videos', () => {
    const value = response();
    Reflect.set(value.videoDetails, 'isLive', true);
    mount(value);
    expect(extractYouTubeInspection()).toMatchObject({ pageType: 'live', candidates: [] });
    expect(extractYouTubeInspection().duration).toBeUndefined();
  });
  it('does not infer HDR or 4K from title and disallows deceptive CDN hosts', () => {
    const value = response();
    value.videoDetails.title = '4K HDR';
    value.streamingData.formats[0]!.url = 'https://googlevideo.com.attacker.test/videoplayback';
    mount(value);
    expect(extractYouTubeInspection().candidates[0]).toMatchObject({
      height: 360,
      dynamicRange: 'unknown',
      source: 'unavailable',
    });
  });
  it('preserves DRM exclusion over a direct address', () => {
    const value = response();
    Reflect.set(value.streamingData.formats[0]!, 'drmFamilies', ['WIDEVINE']);
    mount(value);
    expect(extractYouTubeInspection().candidates[0]?.source).toBe('drm');
  });
  it('revalidates exact identity, page type, field limits, cover ownership and false download capability', () => {
    mount();
    const result = extractYouTubeInspection();
    expect(
      validateYouTubeInspection(result, `https://www.youtube.com/watch?v=mnopqrstuvw`),
    ).toBeUndefined();
    expect(validateYouTubeInspection({ ...result, pageType: 'shorts' }, page)).toBeUndefined();
    const view = validateYouTubeInspection(
      {
        ...result,
        completeDownloadVerified: true,
        token: 'secret',
        thumbnail: 'https://i.ytimg.com/vi/other/hqdefault.jpg',
        candidates: [
          ...result.candidates,
          { ...result.candidates[0], id: 'forged', url: 'secret' },
        ],
      },
      page,
    )!;
    expect(view.completeDownloadVerified).toBe(false);
    expect(view.thumbnail).toBeUndefined();
    expect(view.candidates).toHaveLength(3);
    expect(JSON.stringify(view)).not.toContain('secret');
  });
  it('accepts timestamps and playlist changes but rejects look-alike page domains', () => {
    mount();
    expect(
      validateYouTubeInspection(extractYouTubeInspection(), page + '&t=30&list=PL1'),
    ).toBeDefined();
    for (const url of [
      'https://youtube.com.evil.test/watch?v=' + id,
      'https://evilyoutube.com/',
      'http://www.youtube.com/watch?v=' + id,
    ])
      expect(isYouTubePage(url)).toBe(false);
  });
  it('renders text safely, preserves an open disclosure and creates no download button', () => {
    mount();
    const view = extractYouTubeInspection();
    view.title = '<img src=x onerror=alert(1)>';
    const container = document.createElement('div');
    renderYouTubeInspection(container, view);
    expect(container.querySelector('h3')?.textContent).toBe(view.title);
    expect(container.querySelector('button')).toBeNull();
    const details = container.querySelector('details')!;
    details.open = true;
    renderYouTubeInspection(container, { ...view });
    expect(container.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    container.textContent = '正在读取当前视频信息。';
    renderYouTubeInspection(container, view);
    expect(container.querySelector('h3')?.textContent).toBe(view.title);
  });
  it('rejects arbitrary MIME parameters instead of exposing page-provided source URLs', () => {
    const data = response();
    data.streamingData.formats[0]!.mimeType =
      'video/mp4; url=https://private.invalid/?token=secret';
    mount(data);
    expect(extractYouTubeInspection().candidates.some((c) => c.id.startsWith('18:'))).toBe(false);
    const view = extractYouTubeInspection();
    view.candidates[0]!.mime = 'video/webm; url=https://private.invalid/?token=secret';
    expect(JSON.stringify(validateYouTubeInspection(view, page))).not.toContain('private.invalid');
  });
  it('keeps only the main YouTube player and excludes advertisements from playback controls', () => {
    const player = mount();
    const extra = document.createElement('video');
    extra.src = '/hidden.mp4';
    document.body.append(extra);
    const manager = new PlaybackManager(document);
    manager.start();
    expect(manager.getMediaElements()).toHaveLength(1);
    player.classList.add('ad-showing');
    expect(manager.getMediaElements()).toEqual([]);
    manager.stop();
  });
  it('exposes the sanitized inspection in the actual floating resource view', () => {
    mount();
    const manager = new PlaybackManager(document);
    manager.start();
    const controller = new FloatingPlaybackController(document, manager);
    controller.openResources();
    controller.setResourceSnapshot({
      status: 'ready',
      products: [],
      youtube: extractYouTubeInspection(),
    });
    expect(controller.shadowRoot.querySelector('[data-youtube-status]')?.textContent).toContain(
      '当前视频',
    );
    expect(controller.shadowRoot.querySelector('[data-action="open-cache"]')).toHaveProperty(
      'disabled',
      true,
    );
    controller.destroy();
    manager.stop();
  });
  it('keeps the platform switch optional for legacy settings and persists an explicit false', async () => {
    const before = await getSettings();
    expect(before.youtubeEnabled).not.toBe(false);
    const next = await saveSettings({ youtubeEnabled: false });
    expect(next.youtubeEnabled).toBe(false);
    expect(next.playback).toEqual(before.playback);
    await saveSettings({ youtubeEnabled: true });
  });
  it('fences raw YouTube media downloads without changing Bilibili asset flags', async () => {
    const create = (pageUrl: string, tabId: number): TabMediaState => ({
      tabId,
      pageUrl,
      pageTitle: 'test',
      scannedAt: 1,
      status: 'ready',
      mediaElements: [],
      assets: [
        {
          id: 'a',
          url: 'https://r1.googlevideo.com/videoplayback',
          pageUrl,
          pageTitle: 'test',
          frameId: 0,
          kind: 'video',
          downloadable: true,
          detectedBy: ['network'],
          discoveredAt: 1,
        },
      ],
    });
    const youtube = create(page, 1400);
    await setTabState(youtube);
    expect(youtube.assets[0]?.downloadable).toBe(false);
    expect((await getTabState(1400))?.assets[0]?.downloadable).toBe(false);
    const bili = create('https://www.bilibili.com/video/BV1Test/', 1401);
    await setTabState(bili);
    expect(bili.assets[0]?.downloadable).toBe(true);
  });
});
