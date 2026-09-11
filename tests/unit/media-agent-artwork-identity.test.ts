import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSnapshot,
  ApiResponse,
  MediaElementInfo,
  TabMediaState,
} from '../../src/shared/types';
import { createMediaArtworkIdentity } from '../../src/modules/media-products/media-artwork-identity';
import {
  extractMainWorldMediaManifest,
  validateMainWorldMediaManifest,
} from '../../src/modules/detector/main-world-media';

const harness = vi.hoisted(() => ({
  media: [] as MediaElementInfo[],
  listener: undefined as
    | undefined
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        reply: (value: ApiResponse<AgentSnapshot>) => void,
      ) => boolean | undefined),
  paint: vi.fn(),
}));
vi.mock('../../src/modules/detector', async (load) => ({
  ...(await load<typeof import('../../src/modules/detector')>()),
  MediaDetector: class {
    start() {}
    stop() {}
    scanNow() {}
    resetForMediaChange() {}
    markNavigation() {}
    getAssets() {
      return [];
    }
  },
}));
vi.mock('../../src/modules/playback', async (load) => ({
  ...(await load<typeof import('../../src/modules/playback')>()),
  PlaybackManager: class {
    constructor(
      _doc: Document,
      private options: { onChange: (media: MediaElementInfo[]) => void },
    ) {}
    start() {
      this.options.onChange(harness.media);
    }
    stop() {}
    refresh() {
      this.options.onChange(harness.media);
    }
    getMediaElements() {
      return harness.media;
    }
  },
  FloatingPlaybackController: class {
    resetForNavigation() {}
    update() {}
    destroy() {}
    refreshResources() {}
    applySettings() {}
    setArtwork(value: unknown) {
      harness.paint(value);
    }
  },
}));
vi.mock('../../src/modules/resolver/mse-cache-capture', () => ({
  MseCacheCaptureRuntime: class {
    destroy() {}
    resetForMediaChange() {}
  },
}));

type RuntimeGlobal = typeof globalThis & { __foxfetchMediaAgentV6__?: { destroy(): void } };
const scope = globalThis as RuntimeGlobal;
let main: () => AgentSnapshot;
const pageUrl = 'https://www.bilibili.com/video/BV15z4y1Z734/';
const title = '【4K HDR】这才是看世界的正确方式！！｜Links_哔哩哔哩_bilibili';

function send(
  message: unknown,
  sender: chrome.runtime.MessageSender = {
    id: 'fixture-extension',
    url: 'chrome-extension://fixture-extension/background.js',
  },
) {
  let complete: (response: ApiResponse<AgentSnapshot>) => void;
  const promise = new Promise<ApiResponse<AgentSnapshot>>((resolve) => {
    complete = resolve;
  });
  const accepted = harness.listener!(message, sender, complete!);
  return accepted ? promise : Promise.resolve(undefined);
}

beforeEach(async () => {
  vi.stubGlobal('defineUnlistedScript', (value: unknown) => value);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'fixture-extension',
      getURL: (file: string) => `chrome-extension://fixture-extension/${file}`,
      sendMessage: vi.fn(async () => ({ ok: false })),
      onMessage: {
        addListener: (value: typeof harness.listener) => {
          harness.listener = value;
        },
        removeListener: vi.fn(),
      },
    },
  });
  vi.stubGlobal('window', window);
  window.history.replaceState({}, '', '/');
  // A document with the Bilibili URL is provided as the Agent's real document.
  const doc = document.implementation.createHTMLDocument(title);
  Object.defineProperty(doc, 'URL', { value: pageUrl });
  Object.defineProperty(doc, 'defaultView', { value: window });
  for (const [property, content] of [
    ['og:title', title],
    ['og:url', pageUrl],
    ['og:image', 'https://i2.hdslb.com/bfs/archive/current.jpg'],
  ]) {
    const meta = doc.createElement('meta');
    meta.setAttribute('property', property!);
    meta.content = content!;
    doc.head.append(meta);
  }
  vi.stubGlobal('document', doc);
  harness.media = [
    {
      elementId: 'player',
      lifecycleGeneration: 1,
      frameId: 0,
      kind: 'video',
      title,
      currentTime: 0,
      playbackRate: 1,
      volume: 1,
      paused: true,
      visibleArea: 100,
      lastActiveAt: 1,
    },
  ];
  harness.paint.mockClear();
  main = (await import('../../src/entrypoints/media-agent')).default.main as () => AgentSnapshot;
});
afterEach(() => {
  scope.__foxfetchMediaAgentV6__?.destroy();
  delete scope.__foxfetchMediaAgentV6__;
  vi.unstubAllGlobals();
});

describe('actual Agent artwork identity message', () => {
  it('returns and paints metadata after trusted SSR identity feedback without a ready event', async () => {
    const initial = main();
    expect(initial.artwork).toBeUndefined();
    // Exercise the real initial-manifest reader/validator. There is no capture
    // cache and no event emitter on this SSR window; only page-owned globals.
    const readSsr = Function(
      'window',
      'document',
      'URL',
      `return (${extractMainWorldMediaManifest.toString()})();`,
    ) as (scope: unknown, doc: unknown, url: typeof URL) => unknown;
    const extracted = readSsr(
      {
        location: { href: pageUrl },
        __INITIAL_STATE__: { bvid: 'BV15z4y1Z734', videoData: { cid: 1234 } },
        __playinfo__: {
          data: {
            dash: {
              video: [
                {
                  id: 80,
                  codecid: 7,
                  baseUrl:
                    'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/fixture-100026.m4s',
                  mimeType: 'video/mp4',
                  codecs: 'avc1.640028',
                  width: 1920,
                  height: 1080,
                },
              ],
            },
          },
        },
      },
      { getElementById: () => null },
      URL,
    );
    const validated = validateMainWorldMediaManifest(extracted, { pageUrl });
    expect(validated?.assets).toHaveLength(1);
    expect(validated?.identity.cid).toBe('1234');
    const state: TabMediaState = {
      ...initial,
      tabId: 1,
      status: 'ready',
      scannedAt: 1,
      providerIdentity: `bilibili:${validated!.identity.bvid}:${validated!.identity.cid}`,
    };
    const binding = createMediaArtworkIdentity(initial, state, 'current-doc', 'current-doc');
    expect(binding).toBeDefined();
    const result = await send({ type: 'AGENT_BIND_ARTWORK_IDENTITY', binding });
    expect(result?.ok && result.data.artwork?.url).toBe(
      'https://i2.hdslb.com/bfs/archive/current.jpg',
    );
    expect(harness.paint).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerIdentity: state.providerIdentity }),
    );
  });

  it('does not let a page sender bind the artwork identity', async () => {
    const initial = main();
    const state: TabMediaState = {
      ...initial,
      tabId: 1,
      status: 'ready',
      scannedAt: 1,
      providerIdentity: 'bilibili:BV15z4y1Z734:1234',
    };
    const binding = createMediaArtworkIdentity(initial, state, 'current-doc', 'current-doc');
    expect(
      await send({ type: 'AGENT_BIND_ARTWORK_IDENTITY', binding }, { id: 'foreign-extension' }),
    ).toBeUndefined();
    expect(
      await send(
        { type: 'AGENT_BIND_ARTWORK_IDENTITY', binding },
        { id: 'fixture-extension', tab: { id: 1 } as chrome.tabs.Tab },
      ),
    ).toBeUndefined();
    expect(harness.paint).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'page-metadata' }),
    );
  });

  it('clears the previous CID on a same-URL player epoch and accepts fresh SSR identity without ready', async () => {
    const initial = main();
    const oldState: TabMediaState = {
      ...initial,
      tabId: 1,
      status: 'ready',
      scannedAt: 1,
      providerIdentity: 'bilibili:BV15z4y1Z734:1234',
    };
    const oldBinding = createMediaArtworkIdentity(initial, oldState, 'doc', 'doc')!;
    const first = await send({ type: 'AGENT_BIND_ARTWORK_IDENTITY', binding: oldBinding });
    expect(first?.ok && first.data.artwork?.providerIdentity).toBe(oldState.providerIdentity);
    harness.media = [
      { ...harness.media[0]!, elementId: 'replacement-player', lifecycleGeneration: 2 },
    ];
    const changed = await send({ type: 'AGENT_SCAN' });
    expect(changed?.ok).toBe(true);
    if (!changed?.ok) throw new Error('Agent scan did not respond');
    expect(changed.data.mediaEpoch).toBeGreaterThan(initial.mediaEpoch);
    expect(changed.data.artwork).toBeUndefined();
    const nextState: TabMediaState = {
      ...oldState,
      ...changed.data,
      providerIdentity: 'bilibili:BV15z4y1Z734:5678',
    };
    const nextBinding = createMediaArtworkIdentity(changed.data, nextState, 'doc', 'doc')!;
    const stale = await send({ type: 'AGENT_BIND_ARTWORK_IDENTITY', binding: oldBinding });
    expect(stale?.ok && stale.data.artwork).toBeUndefined();
    const next = await send({ type: 'AGENT_BIND_ARTWORK_IDENTITY', binding: nextBinding });
    expect(next?.ok && next.data.artwork?.providerIdentity).toBe(nextState.providerIdentity);
  });
});
