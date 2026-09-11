import { describe, expect, it, vi } from 'vitest';
import type { TabMediaState } from '../../src/shared/types';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';

import {
  bindRouteGenerationCommit,
  claimRouteGeneration,
  confirmProvisionalSameDocument,
  finalizeProvisionalDocumentReplacement,
  GenerationAwareTaskQueue,
  nextWorkerGeneration,
  rebaseSameMediaRouteState,
  safeWorkerGenerationBase,
  seedDocumentReplacementRouteGeneration,
  seedRouteGeneration,
} from '../../src/modules/detector/route-convergence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('SPA route generation convergence', () => {
  const first = 'https://www.bilibili.com/video/BV1FIRST001/?spm_id_from=old';
  const second = 'https://www.bilibili.com/video/BV1SECOND02/?vd_source=next';

  it('uses one generation when tabs.onUpdated is followed by AGENT_PAGE_CHANGED', () => {
    const seeded = seedRouteGeneration(first, 4, 'document-live');
    const browserClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-live',
        now: 100,
      },
      4,
    );
    expect(browserClaim).toMatchObject({ advanced: true, marker: { epoch: 5 } });

    const agentClaim = claimRouteGeneration(
      browserClaim.marker,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 120 },
      5,
    );
    expect(agentClaim).toMatchObject({
      advanced: false,
      pairedSpaTransition: false,
      marker: {
        epoch: 5,
        awaitingAgent: false,
        awaitingTrailingTabsUntil: 870,
        documentId: 'document-live',
      },
    });
    expect(agentClaim.marker).not.toHaveProperty('provisionalDocumentId');
  });

  it('finalizes a same-origin full navigation in the provisional tabs generation', () => {
    const seeded = seedRouteGeneration(first, 40, 'document-a');
    const tabsClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-a',
        now: 7_000,
      },
      40,
    );

    expect(tabsClaim).toMatchObject({
      advanced: true,
      marker: {
        epoch: 41,
        documentId: 'document-a',
        provisionalDocumentId: 'document-a',
      },
    });

    const finalized = finalizeProvisionalDocumentReplacement(
      tabsClaim.marker,
      second,
      'document-a',
      'document-b',
      7_100,
    );
    expect(finalized).toMatchObject({
      epoch: 41,
      routeKey: siteMediaRouteKey(second),
      pageUrl: second,
      awaitingAgent: false,
      awaitingTrailingTabsUntil: 7_850,
      documentId: 'document-b',
    });
    expect(finalized).not.toHaveProperty('provisionalDocumentId');
    expect(finalized).not.toHaveProperty('awaitingAgentUntil');

    const trailingLoading = claimRouteGeneration(
      finalized,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-b',
        now: 7_120,
      },
      41,
    );
    expect(trailingLoading).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 41, documentId: 'document-b' },
    });
  });

  it('does not fold READY takeover without matching provisional route proof', () => {
    const seeded = seedRouteGeneration(first, 50, 'document-a');
    expect(
      finalizeProvisionalDocumentReplacement(seeded, first, 'document-a', 'document-b'),
    ).toBeUndefined();

    const tabsClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-a',
        now: 8_000,
      },
      50,
    );
    expect(
      finalizeProvisionalDocumentReplacement(
        tabsClaim.marker,
        'https://www.bilibili.com/video/BV1THIRD003/',
        'document-a',
        'document-b',
      ),
    ).toBeUndefined();
  });

  it('keeps same-URL reload and tabs-missed READY takeover outside provisional finalization', () => {
    const seeded = seedRouteGeneration(first, 60, 'document-a');
    const reload = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: first,
        documentNavigation: true,
        documentId: 'document-a',
        now: 9_000,
      },
      60,
    );
    expect(reload).toMatchObject({ advanced: true, marker: { epoch: 61 } });
    expect(reload.marker).not.toHaveProperty('provisionalDocumentId');
    expect(
      finalizeProvisionalDocumentReplacement(reload.marker, first, 'document-a', 'document-b'),
    ).toBeUndefined();

    const tabsMissed = claimRouteGeneration(
      seeded,
      {
        source: 'agent',
        pageUrl: second,
        documentId: 'document-b',
        now: 10_000,
      },
      60,
    );
    expect(tabsMissed).toMatchObject({ advanced: true, marker: { epoch: 61 } });
    expect(tabsMissed.marker).not.toHaveProperty('provisionalDocumentId');
  });

  it('lets a read-led route claim finalize once and settle on same-document injection proof', () => {
    const seeded = seedRouteGeneration(first, 70, 'document-a');
    const readClaim = claimRouteGeneration(
      seeded,
      {
        source: 'read',
        pageUrl: second,
        documentId: 'document-a',
        now: 11_000,
      },
      70,
    );
    expect(readClaim).toMatchObject({
      advanced: true,
      marker: {
        epoch: 71,
        provisionalDocumentId: 'document-a',
      },
    });

    const sameDocument = confirmProvisionalSameDocument(
      readClaim.marker,
      second,
      'document-a',
      11_100,
    );
    expect(sameDocument).toMatchObject({
      epoch: 71,
      documentId: 'document-a',
      awaitingAgent: false,
      awaitingTrailingTabsUntil: 11_850,
    });
    expect(sameDocument).not.toHaveProperty('provisionalDocumentId');

    const newDocument = finalizeProvisionalDocumentReplacement(
      readClaim.marker,
      second,
      'document-a',
      'document-b',
    );
    expect(newDocument).toMatchObject({ epoch: 71, documentId: 'document-b' });
  });

  it('folds tabs URL/loading halves that arrive after new-document READY', () => {
    const readyFirst = seedDocumentReplacementRouteGeneration(second, 81, 'document-b', 12_000);
    const combinedTabs = claimRouteGeneration(
      readyFirst,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-b',
        now: 12_100,
      },
      81,
    );
    expect(combinedTabs).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 81, documentId: 'document-b' },
    });

    const trailingLoading = claimRouteGeneration(
      combinedTabs.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-b',
        now: 12_120,
      },
      81,
    );
    expect(trailingLoading).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 81 },
    });

    const expiredReload = claimRouteGeneration(
      readyFirst,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-b',
        now: 12_800,
      },
      81,
    );
    expect(expiredReload).toMatchObject({ advanced: true, pairedSpaTransition: false });
  });

  it('folds READY -> loading-only -> URL-only as one generation', () => {
    const readyFirst = seedDocumentReplacementRouteGeneration(second, 91, 'document-b', 13_000);
    const loading = claimRouteGeneration(
      readyFirst,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-b',
        now: 13_100,
      },
      91,
    );
    const url = claimRouteGeneration(
      loading.marker,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-b',
        now: 13_120,
      },
      91,
    );
    expect(loading).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(url).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 91 },
    });
  });

  it('folds one trailing loading event after tabs URL -> Agent confirmation', () => {
    const seeded = seedRouteGeneration(first, 4, 'document-live');
    const browserUrlClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 100,
      },
      4,
    );
    const agentClaim = claimRouteGeneration(
      browserUrlClaim.marker,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 120 },
      5,
    );
    const trailingLoading = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 140,
      },
      5,
    );

    expect(trailingLoading).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 5, awaitingAgent: false, documentId: 'document-live' },
    });
    expect(trailingLoading.marker.awaitingTrailingTabsUntil).toBeUndefined();

    // The slot is one-shot. A subsequent loading edge is a real document
    // navigation and must advance even if Chrome still exposes the old id.
    const realReload = claimRouteGeneration(
      trailingLoading.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 150,
      },
      5,
    );
    expect(realReload).toMatchObject({ advanced: true, pairedSpaTransition: false });
  });

  it('expires an unpaired tabs claim so a later reload cannot be swallowed', () => {
    const seeded = seedRouteGeneration(first, 4, 'document-live');
    const browserUrlClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 100,
      },
      4,
    );
    const laterReload = claimRouteGeneration(
      browserUrlClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 900,
      },
      5,
    );

    expect(laterReload).toMatchObject({ advanced: true, pairedSpaTransition: false });
  });

  it('does not consume the trailing slot for a different document', () => {
    const seeded = seedRouteGeneration(first, 4, 'document-live');
    const browserUrlClaim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 100,
      },
      4,
    );
    const agentClaim = claimRouteGeneration(
      browserUrlClaim.marker,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 120 },
      5,
    );
    const newDocumentLoading = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-reloaded',
        now: 140,
      },
      5,
    );

    expect(newDocumentLoading).toMatchObject({ advanced: true, pairedSpaTransition: false });
  });

  it('folds the inverse Agent -> tabs ordering only for the live document window', () => {
    const seeded = seedRouteGeneration(first, 8, 'document-live');
    const agentClaim = claimRouteGeneration(
      seeded,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 1_000 },
      8,
    );
    expect(agentClaim).toMatchObject({ advanced: true, marker: { epoch: 9 } });

    const browserClaim = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-live',
        now: 1_100,
      },
      9,
    );
    expect(browserClaim).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 9 },
    });

    const realReload = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-live',
        now: 2_000,
      },
      9,
    );
    expect(realReload).toMatchObject({ advanced: true, pairedSpaTransition: false });
  });

  it('folds Agent -> tabs URL-only -> tabs loading as one atomic SPA transition', () => {
    const seeded = seedRouteGeneration(first, 8, 'document-live');
    const agentClaim = claimRouteGeneration(
      seeded,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 1_000 },
      8,
    );
    const urlHalf = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 1_100,
      },
      9,
    );
    const loadingHalf = claimRouteGeneration(
      urlHalf.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 1_120,
      },
      9,
    );

    expect(urlHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(urlHalf.marker.awaitingTabsUntil).toBeUndefined();
    expect(urlHalf.marker.awaitingTrailingTabsUntil).toBe(1_850);
    expect(loadingHalf).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 9, awaitingAgent: false, documentId: 'document-live' },
    });
    expect(loadingHalf.marker.awaitingTrailingTabsUntil).toBeUndefined();
  });

  it('folds Agent -> combined tabs edge -> trailing loading as one atomic SPA transition', () => {
    const seeded = seedRouteGeneration(first, 14, 'document-live');
    const agentClaim = claimRouteGeneration(
      seeded,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 2_000 },
      14,
    );
    const combinedHalf = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-live',
        now: 2_100,
      },
      15,
    );
    const trailingLoading = claimRouteGeneration(
      combinedHalf.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 2_120,
      },
      15,
    );

    expect(combinedHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(combinedHalf.marker.awaitingTrailingTabsUntil).toBe(2_850);
    expect(trailingLoading).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(trailingLoading.marker.awaitingTrailingTabsUntil).toBeUndefined();
  });

  it('folds Agent -> tabs loading-only -> tabs URL-only as one atomic SPA transition', () => {
    const seeded = seedRouteGeneration(first, 24, 'document-live');
    const agentClaim = claimRouteGeneration(
      seeded,
      { source: 'agent', pageUrl: second, documentId: 'document-live', now: 3_000 },
      24,
    );
    const loadingHalf = claimRouteGeneration(
      agentClaim.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 3_100,
      },
      25,
    );
    const urlHalf = claimRouteGeneration(
      loadingHalf.marker,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 3_120,
      },
      25,
    );

    expect(loadingHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(loadingHalf.marker.awaitingTrailingTabsUntil).toBe(3_850);
    expect(urlHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(urlHalf.marker.awaitingTrailingTabsUntil).toBeUndefined();
  });

  it('does not open a navigation gate for URL-only -> loading-only while awaiting Agent', () => {
    const seeded = seedRouteGeneration(first, 30, 'document-live');
    const urlHalf = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: second,
        urlChanged: true,
        documentId: 'document-live',
        now: 4_000,
      },
      30,
    );
    const loadingHalf = claimRouteGeneration(
      urlHalf.marker,
      {
        source: 'tabs',
        pageUrl: second,
        documentNavigation: true,
        documentId: 'document-live',
        now: 4_020,
      },
      31,
    );

    expect(loadingHalf).toMatchObject({
      advanced: false,
      pairedSpaTransition: true,
      marker: { epoch: 31, awaitingAgent: true, documentId: 'document-live' },
    });
  });

  it('preserves the inverse-pair window when an intervening state/scan commit binds the document', () => {
    const previous = seedRouteGeneration(first, 20, 'document-a');
    const agentClaim = claimRouteGeneration(
      previous,
      {
        pageUrl: second,
        source: 'agent',
        documentId: 'document-a',
        now: 1_000,
      },
      20,
    );
    const committed = bindRouteGenerationCommit(
      { ...agentClaim.marker, epoch: 21 },
      second,
      21,
      'document-a',
    );

    expect(committed?.awaitingTabsUntil).toBe(1_750);
    const browserClaim = claimRouteGeneration(
      committed,
      {
        pageUrl: second,
        source: 'tabs',
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-a',
        now: 1_100,
      },
      21,
    );
    expect(browserClaim.advanced).toBe(false);
    expect(browserClaim.pairedSpaTransition).toBe(true);
  });

  it('does not advance for tracking-only URL changes on the same media route', () => {
    const seeded = seedRouteGeneration(
      'https://www.bilibili.com/video/BV1SECOND02/?p=1&vd_source=one',
      3,
      'doc',
    );
    const claim = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: 'https://www.bilibili.com/video/BV1SECOND02/?p=1&spm_id_from=two',
        documentId: 'doc',
      },
      3,
    );
    expect(claim).toMatchObject({ advanced: false, sameMediaRoute: true, marker: { epoch: 3 } });
  });

  it('folds the trailing loading notification after a tracking-only URL half', () => {
    const original = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&vd_source=one';
    const tracking = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&spm_id_from=two';
    const seeded = seedRouteGeneration(original, 3, 'document-live');
    const urlHalf = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: tracking,
        urlChanged: true,
        documentId: 'document-live',
        now: 5_000,
      },
      3,
    );
    const loadingHalf = claimRouteGeneration(
      urlHalf.marker,
      {
        source: 'tabs',
        pageUrl: tracking,
        documentNavigation: true,
        documentId: 'document-live',
        now: 5_020,
      },
      3,
    );

    expect(urlHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(urlHalf.marker.awaitingTrailingTabsUntil).toBe(5_750);
    expect(loadingHalf).toMatchObject({ advanced: false, pairedSpaTransition: true });
    expect(loadingHalf.marker.awaitingTrailingTabsUntil).toBeUndefined();
  });

  it('treats a combined tracking URL/loading notification as provisional until document proof', () => {
    const original = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&vd_source=one';
    const tracking = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&spm_id_from=two';
    const seeded = seedRouteGeneration(original, 3, 'document-live');
    const combined = claimRouteGeneration(
      seeded,
      {
        source: 'tabs',
        pageUrl: tracking,
        documentNavigation: true,
        urlChanged: true,
        documentId: 'document-live',
        now: 6_000,
      },
      3,
    );

    expect(combined).toMatchObject({
      advanced: false,
      sameMediaRoute: true,
      pairedSpaTransition: true,
      marker: { epoch: 3, documentId: 'document-live' },
    });
  });

  it('rebases tracking-only URLs without discarding the settled media state', () => {
    const oldUrl = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&vd_source=one';
    const nextUrl = 'https://www.bilibili.com/video/BV1SECOND02/?p=1&spm_id_from=two';
    const state: TabMediaState = {
      tabId: 1,
      pageUrl: oldUrl,
      pageTitle: 'Old title',
      scannedAt: 1,
      status: 'ready',
      assets: [
        {
          id: 'video',
          url: 'https://cdn.example/video.m4s',
          pageUrl: oldUrl,
          pageTitle: 'Old title',
          frameId: 0,
          kind: 'video',
          detectedBy: ['manifest'],
          filename: 'video.m4s',
          downloadable: true,
          discoveredAt: 1,
        },
      ],
      mediaElements: [],
      mediaEpoch: 2,
    };

    const rebased = rebaseSameMediaRouteState(state, nextUrl, 'Current title');
    expect(rebased).toMatchObject({
      pageUrl: nextUrl,
      pageTitle: 'Current title',
      status: 'ready',
      mediaEpoch: 2,
      assets: [{ id: 'video', pageUrl: nextUrl, pageTitle: 'Current title' }],
    });
  });
});

describe('worker generation clock', () => {
  it('starts a later worker above values emitted by an earlier worker', () => {
    const earlierBase = safeWorkerGenerationBase(1_700_000_000_000);
    const earlierValue = nextWorkerGeneration(earlierBase, earlierBase, 37);
    const restartedBase = safeWorkerGenerationBase(1_700_000_000_001);
    const restartedValue = nextWorkerGeneration(restartedBase, restartedBase, 1);
    expect(restartedValue).toBeGreaterThan(earlierValue);
    expect(Number.isSafeInteger(restartedValue)).toBe(true);
  });
});

describe('generation-aware task queue', () => {
  it('never joins a previous-generation scan promise', async () => {
    const queue = new GenerationAwareTaskQueue<string>();
    const oldScan = deferred<string>();
    const newScan = deferred<string>();
    const oldOperation = vi.fn(() => oldScan.promise);
    const newOperation = vi.fn(() => newScan.promise);

    const oldResult = queue.run(1, false, oldOperation);
    await Promise.resolve();
    const newResult = queue.run(2, false, newOperation);
    await Promise.resolve();

    expect(oldOperation).toHaveBeenCalledTimes(1);
    expect(newOperation).toHaveBeenCalledTimes(1);
    expect(newResult).not.toBe(oldResult);

    newScan.resolve('new');
    await expect(newResult).resolves.toBe('new');
    oldScan.resolve('old');
    await expect(oldResult).resolves.toBe('old');
  });

  it('coalesces automatic work and bounds forced refresh to one queued pass', async () => {
    const queue = new GenerationAwareTaskQueue<number>();
    const active = deferred<number>();
    const operation = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(() => active.promise)
      .mockResolvedValueOnce(2);

    const first = queue.run(7, false, operation);
    const coalesced = queue.run(7, false, operation);
    const forced = queue.run(7, true, operation);
    const duplicateForced = queue.run(7, true, operation);
    expect(coalesced).toBe(first);
    expect(duplicateForced).toBe(forced);

    active.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(forced).resolves.toBe(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('times out a hanging all-frame scan and lets force supersede it', async () => {
    vi.useFakeTimers();
    try {
      const queue = new GenerationAwareTaskQueue<string>({
        timeoutMs: 4_000,
        forceStartsFresh: true,
      });
      const hangingIframe = deferred<string>();
      const operation = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => hangingIframe.promise)
        .mockResolvedValueOnce('fresh');

      const first = queue.run('route-b:2', false, operation);
      await Promise.resolve();
      const forced = queue.run('route-b:2', true, operation);
      await expect(forced).resolves.toBe('fresh');
      expect(operation).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(4_000);
      await expect(first).rejects.toMatchObject({ name: 'GenerationTaskTimeoutError' });
      hangingIframe.resolve('stale');
    } finally {
      vi.useRealTimers();
    }
  });
});
