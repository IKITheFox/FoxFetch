import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, TabMediaState } from '../../src/shared/types';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';
import {
  acceptMediaArtworkIdentity,
  createMediaArtworkIdentity,
  validateMediaArtworkIdentityReply,
  selectDocumentBoundMainWorldManifest,
} from '../../src/modules/media-products/media-artwork-identity';
import { readBoundMediaArtwork } from '../../src/modules/media-products/media-artwork';

const pageUrl = 'https://www.bilibili.com/video/BV15z4y1Z734/?spm_id_from=fixture';
const title = '【4K HDR】哔哩哔哩 真·HDR ON！！这才是看世界的正确方式｜Links_哔哩哔哩_bilibili';
const documentKey = 'agent-document-fixture-12345678';

function fixture() {
  const activeMedia = {
    routeKey: siteMediaRouteKey(pageUrl),
    mediaEpoch: 7,
    elementId: 'player',
    lifecycleGeneration: 2,
    frameId: 0,
    kind: 'video' as const,
    title,
  };
  const snapshot: AgentSnapshot = {
    pageUrl,
    pageTitle: title,
    mediaEpoch: 7,
    activeMedia,
    assets: [],
    artworkDocumentKey: documentKey,
    mediaElements: [
      {
        ...activeMedia,
        paused: true,
        currentTime: 0,
        playbackRate: 1,
        volume: 1,
        visibleArea: 2160 * 1080,
        lastActiveAt: 1,
      },
    ],
  };
  const state: TabMediaState = {
    ...snapshot,
    tabId: 1,
    status: 'ready',
    scannedAt: 1,
    providerIdentity: 'bilibili:BV15z4y1Z734:1234',
  };
  const doc = document.implementation.createHTMLDocument(title);
  for (const [property, content] of [
    ['og:title', title],
    ['og:url', 'https://www.bilibili.com/video/BV15z4y1Z734/'],
    ['og:image', 'https://i2.hdslb.com/bfs/archive/current.jpg@1200w_630h'],
  ]) {
    const meta = doc.createElement('meta');
    meta.setAttribute('property', property!);
    meta.content = content!;
    doc.head.append(meta);
  }
  return { snapshot, state, doc };
}

describe('background-confirmed artwork identity handshake', () => {
  it('does not bind an old MAIN result to a new Agent document on the same URL', () => {
    const manifest = {
      provider: 'bilibili' as const,
      pageUrl,
      identity: { bvid: 'BV15z4y1Z734', cid: '1234' },
      assets: [],
    };
    expect(
      selectDocumentBoundMainWorldManifest({ manifest, documentId: 'old-doc' }, 'new-doc'),
    ).toBeUndefined();
    expect(
      selectDocumentBoundMainWorldManifest({ manifest, documentId: 'new-doc' }, undefined),
    ).toBeUndefined();
    expect(
      selectDocumentBoundMainWorldManifest({ manifest, documentId: 'new-doc' }, 'new-doc'),
    ).toBe(manifest);
  });
  it('completes the no-ready-event SSR manifest path with a poster-less player', () => {
    const { snapshot, state, doc } = fixture();
    // The admitted initial SSR manifest supplied the background identity, but
    // no playurl capture event has supplied one to this Agent.
    expect(readBoundMediaArtwork(doc, snapshot)).toBeUndefined();
    const binding = createMediaArtworkIdentity(snapshot, state, 'doc-1', 'doc-1')!;
    expect(binding).toBeDefined();
    const identity = acceptMediaArtworkIdentity(binding, snapshot, documentKey)!;
    expect(identity).toBe(state.providerIdentity);
    const artwork = readBoundMediaArtwork(doc, { ...snapshot, providerIdentity: identity })!;
    expect(artwork?.url).toContain('/bfs/archive/current.jpg');
    const reply = { ...snapshot, artwork };
    expect(validateMediaArtworkIdentityReply(reply, binding, state)).toEqual(artwork);
    expect(JSON.stringify(binding)).not.toMatch(/https?:|cookie|headers|\.m4s/iu);
  });

  it('does not issue to another document, old media epoch, player, or route', () => {
    const { snapshot, state } = fixture();
    expect(createMediaArtworkIdentity(snapshot, state, 'old-doc', 'doc-1')).toBeUndefined();
    const legacySnapshot = { ...snapshot };
    delete legacySnapshot.artworkDocumentKey;
    expect(createMediaArtworkIdentity(legacySnapshot, state, 'doc-1', 'doc-1')).toBeUndefined();
    expect(
      createMediaArtworkIdentity({ ...snapshot, mediaEpoch: 6 }, state, 'doc-1', 'doc-1'),
    ).toBeUndefined();
    expect(
      createMediaArtworkIdentity(
        { ...snapshot, activeMedia: { ...snapshot.activeMedia!, lifecycleGeneration: 1 } },
        state,
        'doc-1',
        'doc-1',
      ),
    ).toBeUndefined();
    expect(
      createMediaArtworkIdentity(
        { ...snapshot, pageUrl: 'https://www.bilibili.com/video/BV1other1234/' },
        state,
        'doc-1',
        'doc-1',
      ),
    ).toBeUndefined();
  });

  it('Agent rejects a stale document key, epoch, player, route and conflicting known CID', () => {
    const { snapshot, state } = fixture();
    const binding = createMediaArtworkIdentity(snapshot, state, 'doc-1', 'doc-1')!;
    for (const changed of [
      { artworkDocumentKey: 'previous-agent-document' },
      { mediaEpoch: 6 },
      { lifecycleGeneration: 1 },
      { elementId: 'recommendation-player' },
      { pageIdentity: 'bilibili:BV1other1234:p:1' },
      { providerIdentity: 'bilibili:BV15z4y1Z734:9999' },
    ])
      expect(
        acceptMediaArtworkIdentity({ ...binding, ...changed }, state, documentKey),
      ).toBeUndefined();
  });

  it('rejects late replies after a CID/epoch change or from another Agent instance', () => {
    const { snapshot, state, doc } = fixture();
    const binding = createMediaArtworkIdentity(snapshot, state, 'doc-1', 'doc-1')!;
    const reply = { ...snapshot, artwork: readBoundMediaArtwork(doc, state)! };
    expect(
      validateMediaArtworkIdentityReply(reply, binding, {
        ...state,
        providerIdentity: 'bilibili:BV15z4y1Z734:9999',
      }),
    ).toBeUndefined();
    expect(
      validateMediaArtworkIdentityReply(reply, binding, { ...state, mediaEpoch: 8 }),
    ).toBeUndefined();
    expect(
      validateMediaArtworkIdentityReply(
        { ...reply, artworkDocumentKey: 'old-agent-key' },
        binding,
        state,
      ),
    ).toBeUndefined();
    expect(
      validateMediaArtworkIdentityReply(
        {
          ...reply,
          artwork: { ...reply.artwork!, providerIdentity: 'bilibili:BV15z4y1Z734:9999' },
        },
        binding,
        state,
      ),
    ).toBeUndefined();
  });

  it('retains canonical and image-source checks after successful identity feedback', () => {
    const { snapshot, state, doc } = fixture();
    const binding = createMediaArtworkIdentity(snapshot, state, 'doc-1', 'doc-1')!;
    const providerIdentity = acceptMediaArtworkIdentity(binding, snapshot, documentKey)!;
    const context = { ...snapshot, providerIdentity };
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content =
      'https://www.bilibili.com/video/BV1other1234/';
    expect(readBoundMediaArtwork(doc, context)).toBeUndefined();
    doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content = pageUrl;
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content =
      'https://i2.hdslb.com/bfs/manga-static/recommendation.jpg';
    expect(readBoundMediaArtwork(doc, context)).toBeUndefined();
  });
});
