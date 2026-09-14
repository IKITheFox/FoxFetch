import { describe, expect, it } from 'vitest';
import {
  BLOB_CAPTURE_SESSION_STATES,
  BlobCaptureSessionLimitError,
  BlobCaptureSessionRegistry,
  InvalidBlobCaptureSessionError,
  InvalidBlobCaptureTransitionError,
  normalizeBlobCaptureOrigin,
  type BlobCaptureObservation,
} from '../../src/modules/resolver/capture-session';

function observation(
  id: string,
  documentId: string,
  observedAt: number,
  overrides: Partial<BlobCaptureObservation> = {},
): BlobCaptureObservation {
  return {
    id,
    tabId: 7,
    frameId: 2,
    documentId,
    url: `https://cdn.example/${id}.m4s`,
    observedAt,
    kind: 'segment',
    ...overrides,
  };
}

describe('BlobCaptureSessionRegistry', () => {
  it('bounds long observations by bytes without truncating URLs or credentials', () => {
    const registry = new BlobCaptureSessionRegistry({ maxObservationBytesPerSession: 2000 }, () => 1000);
    registry.create({ id: 'bounded', tabId: 7, frameId: 2, blobAssetId: 'blob', documentId: 'doc' });
    registry.transition('bounded', 'capturing');
    const first = observation('first', 'doc', 1000, { url: `https://cdn.example/${'a'.repeat(500)}`, requestHeaders: { authorization: 'keep-exact' } });
    const second = { ...first, id: 'second' };
    expect(registry.recordObservation('bounded', first).accepted).toBe(true);
    const result = registry.recordObservation('bounded', second);
    expect(result).toMatchObject({ accepted: true, evictedObservationIds: ['first'] });
    expect(registry.get('bounded')?.observations).toEqual([second]);
    expect(registry.recordObservation('bounded', { ...second, id: 'huge', url: `https://cdn.example/${'x'.repeat(2000)}` }).accepted).toBe(false);
    expect(registry.get('bounded')?.observations).toEqual([second]);
  });

  it('migrates count-only observation snapshots under the byte budget', () => {
    const old = new BlobCaptureSessionRegistry({}, () => 1000);
    old.create({ id: 'legacy', tabId: 7, frameId: 2, blobAssetId: 'blob', documentId: 'doc' });
    old.transition('legacy', 'capturing');
    for (const id of ['first', 'second']) old.recordObservation('legacy', observation(id, 'doc', 1000, { url: `https://cdn.example/${'a'.repeat(500)}` }));
    const fresh = new BlobCaptureSessionRegistry({ maxObservationBytesPerSession: 2000 }, () => 1000);
    const restored = fresh.restore(old.get('legacy')!);
    expect(restored.observations.map((entry) => entry.id)).toEqual(['second']);
    expect(restored.droppedObservationCount).toBe(1);
    expect(restored.binding).toEqual(old.get('legacy')!.binding);
  });
  it('models the permission, reload, capture, analysis and resolution path', () => {
    let now = 1_000;
    const registry = new BlobCaptureSessionRegistry({}, () => now);
    let session = registry.create({
      id: 'capture-1',
      tabId: 7,
      blobAssetId: 'blob-asset-1',
      frameId: 2,
      elementId: 'video-1',
      initialState: 'permission_required',
      documentId: 'document-old',
      candidateOrigins: ['https://media.example/path/file.mp4'],
    });

    expect(BLOB_CAPTURE_SESSION_STATES).toEqual([
      'permission_required',
      'reload_required',
      'waiting_for_playback',
      'capturing',
      'analyzing',
      'resolved',
      'failed',
      'cancelled',
    ]);
    expect(session.candidateOrigins).toEqual(['https://media.example']);

    now += 10;
    session = registry.transition(session.id, 'reload_required');
    expect(session.state).toBe('reload_required');

    now += 10;
    const adopted = registry.adoptDocument(session.id, 'document-new');
    expect(adopted).toMatchObject({
      accepted: true,
      replacedDocumentId: 'document-old',
      session: {
        state: 'waiting_for_playback',
        documentId: 'document-new',
        documentEpoch: 2,
        retiredDocumentIds: ['document-old'],
      },
    });
    if (!adopted.accepted) throw new Error('new document was not adopted');

    now += 10;
    session = registry.transition(session.id, 'capturing');
    const recorded = registry.recordObservation(
      session.id,
      observation('request-1', 'document-new', now, {
        elementId: 'video-1',
        origin: 'https://cdn.example',
        assetId: 'network-asset-1',
      }),
    );
    expect(recorded).toMatchObject({
      accepted: true,
      observation: { id: 'request-1' },
      session: {
        candidateOrigins: ['https://media.example', 'https://cdn.example'],
      },
    });

    now += 10;
    session = registry.transition(session.id, 'analyzing');
    now += 10;
    session = registry.transition(session.id, 'resolved', {
      resolvedAssetIds: ['video-track', 'audio-track'],
    });
    expect(session).toMatchObject({
      state: 'resolved',
      resolvedAssetIds: ['video-track', 'audio-track'],
      observations: [{ id: 'request-1' }],
    });
    expect(() => registry.transition(session.id, 'capturing')).toThrow(
      InvalidBlobCaptureTransitionError,
    );
  });

  it('adopts a new document and rejects retired, unknown and expired observations', () => {
    let now = 100;
    const registry = new BlobCaptureSessionRegistry(
      {
        observationMaxAgeMs: 100,
        futureObservationToleranceMs: 5,
        sessionIdleTtlMs: 10_000,
      },
      () => now,
    );
    const session = registry.create({
      id: 'capture-1',
      tabId: 7,
      blobAssetId: 'blob-asset-1',
      frameId: 2,
      documentId: 'document-1',
    });
    registry.transition(session.id, 'capturing');

    now = 200;
    registry.transition(session.id, 'reload_required');
    now = 300;
    registry.adoptDocument(session.id, 'document-2');
    registry.transition(session.id, 'capturing');

    expect(
      registry.recordObservation(session.id, observation('old', 'document-1', now)),
    ).toMatchObject({ accepted: false, reason: 'retired_document' });
    expect(
      registry.recordObservation(session.id, observation('unknown', 'document-3', now)),
    ).toMatchObject({ accepted: false, reason: 'document_not_adopted' });
    expect(
      registry.recordObservation(session.id, observation('predates-bind', 'document-2', 299)),
    ).toMatchObject({ accepted: false, reason: 'stale_observation' });

    now = 1_000;
    expect(
      registry.recordObservation(session.id, observation('expired', 'document-2', 899)),
    ).toMatchObject({ accepted: false, reason: 'expired_observation' });
    expect(
      registry.recordObservation(session.id, observation('future', 'document-2', 1_006)),
    ).toMatchObject({ accepted: false, reason: 'future_observation' });
    expect(
      registry.recordObservation(
        session.id,
        observation('wrong-frame', 'document-2', now, { frameId: 3 }),
      ),
    ).toMatchObject({ accepted: false, reason: 'binding_mismatch' });

    const boundedHistory = new BlobCaptureSessionRegistry({ maxRetiredDocumentIds: 1 }, () => now);
    boundedHistory.create({
      id: 'bounded-history',
      tabId: 7,
      blobAssetId: 'blob-bounded',
      frameId: 2,
      documentId: 'document-a',
    });
    expect(boundedHistory.adoptDocument('bounded-history', 'document-b')).toMatchObject({
      accepted: true,
    });
    expect(boundedHistory.adoptDocument('bounded-history', 'document-c')).toMatchObject({
      accepted: false,
      reason: 'document_history_limit',
    });
    expect(boundedHistory.adoptDocument('bounded-history', 'document-a')).toMatchObject({
      accepted: false,
      reason: 'retired_document',
    });
  });

  it('bounds observations, origins and resolved ids without mutating returned snapshots', () => {
    let now = 1_000;
    const registry = new BlobCaptureSessionRegistry(
      {
        maxObservationsPerSession: 2,
        maxCandidateOrigins: 2,
        maxResolvedAssetIds: 2,
      },
      () => now,
    );
    const session = registry.create({
      id: 'capture-1',
      tabId: 7,
      blobAssetId: 'blob-asset-1',
      frameId: 2,
      documentId: 'document-1',
      candidateOrigins: ['https://seed.example'],
    });
    registry.transition(session.id, 'capturing');

    let lastResult;
    for (const [index, origin] of ['a.example', 'b.example', 'c.example'].entries()) {
      now += 1;
      lastResult = registry.recordObservation(
        session.id,
        observation(`observation-${index + 1}`, 'document-1', now, {
          url: `https://${origin}/segment.m4s`,
          origin: `https://${origin}`,
        }),
      );
      expect(lastResult.accepted).toBe(true);
    }

    expect(lastResult).toMatchObject({
      accepted: true,
      evictedObservationIds: ['observation-1'],
      session: {
        candidateOrigins: ['https://b.example', 'https://c.example'],
        droppedObservationCount: 1,
        observations: [{ id: 'observation-2' }, { id: 'observation-3' }],
      },
    });

    now += 1;
    registry.transition(session.id, 'analyzing');
    const resolved = registry.transition(session.id, 'resolved', {
      resolvedAssetIds: ['asset-1', 'asset-2', 'asset-3'],
    });
    expect(resolved.resolvedAssetIds).toEqual(['asset-2', 'asset-3']);

    resolved.observations.length = 0;
    resolved.binding.tabId = 999;
    expect(registry.get(session.id)).toMatchObject({
      binding: { tabId: 7 },
      observations: [{ id: 'observation-2' }, { id: 'observation-3' }],
    });
  });

  it('restores a validated snapshot without touching its expiry or retaining caller references', () => {
    let now = 1_000;
    const source = new BlobCaptureSessionRegistry({}, () => now);
    const created = source.create({
      id: 'capture-restored',
      tabId: 7,
      blobAssetId: 'blob-asset-1',
      frameId: 2,
      documentId: 'document-1',
    });
    source.transition(created.id, 'capturing');
    now += 10;
    source.recordObservation(
      created.id,
      observation('request-1', 'document-1', now, {
        initiator: 'https://page.example',
        resourceType: 'media',
        status: 206,
        size: 1_024,
        requestHeaders: {
          referer: 'https://page.example/watch',
          origin: 'https://page.example',
          authorization: 'Bearer short-lived-token',
        },
        range: { start: 0, end: 1_023, total: 8_192 },
        redirect: {
          fromUrl: 'https://media.example/source',
          toUrl: 'https://cdn.example/request-1.m4s',
          status: 302,
          time: now - 1,
        },
      }),
    );
    const snapshot = source.get(created.id);
    if (!snapshot) throw new Error('source snapshot is missing');

    const restoredRegistry = new BlobCaptureSessionRegistry({}, () => 50_000);
    const restored = restoredRegistry.restore(snapshot);
    expect(restored).toEqual(snapshot);
    expect(restored.expiresAt).toBe(snapshot.expiresAt);
    expect(restored.observations[0]).toMatchObject({
      initiator: 'https://page.example',
      resourceType: 'media',
      status: 206,
      size: 1_024,
      requestHeaders: {
        referer: 'https://page.example/watch',
        origin: 'https://page.example',
        authorization: 'Bearer short-lived-token',
      },
      range: { start: 0, end: 1_023, total: 8_192 },
      redirect: {
        fromUrl: 'https://media.example/source',
        toUrl: 'https://cdn.example/request-1.m4s',
        status: 302,
      },
    });

    if (snapshot.observations[0]?.range) snapshot.observations[0].range.start = 512;
    if (snapshot.observations[0]?.redirect) {
      snapshot.observations[0].redirect.toUrl = 'https://mutated.example/redirect';
    }
    if (snapshot.observations[0]?.requestHeaders) {
      snapshot.observations[0].requestHeaders.authorization = 'Bearer mutated';
    }
    snapshot.observations.length = 0;
    snapshot.candidateOrigins.push('https://mutated.example');
    expect(restoredRegistry.get(restored.id)).toEqual(restored);

    const invalid = { ...restored, candidateOrigins: ['not-an-origin'] };
    expect(() => restoredRegistry.restore(invalid)).toThrow(InvalidBlobCaptureSessionError);

    const invalidRange = {
      ...restored,
      observations: [{ ...restored.observations[0]!, range: { start: 10, end: 9 } }],
    };
    expect(() => restoredRegistry.restore(invalidRange)).toThrow(InvalidBlobCaptureSessionError);
  });

  it('enforces the session limit while allowing the oldest terminal session to be replaced', () => {
    let now = 1_000;
    const registry = new BlobCaptureSessionRegistry({ maxSessions: 1 }, () => now);
    const active = registry.create({
      id: 'active',
      tabId: 7,
      blobAssetId: 'blob-active',
      frameId: 2,
    });

    expect(() =>
      registry.create({ id: 'blocked', tabId: 8, blobAssetId: 'blob-blocked', frameId: 0 }),
    ).toThrow(BlobCaptureSessionLimitError);

    now += 1;
    registry.transition(active.id, 'cancelled');
    const replacement = registry.create({
      id: 'replacement',
      tabId: 8,
      blobAssetId: 'blob-replacement',
      frameId: 0,
    });
    expect(registry.get(active.id)).toBeUndefined();
    expect(replacement.id).toBe('replacement');
  });

  it('upserts the same restored id while enforcing capacity for a different id', () => {
    const source = new BlobCaptureSessionRegistry({}, () => 1_000);
    const first = source.create({
      id: 'restored-1',
      tabId: 7,
      blobAssetId: 'blob-1',
      frameId: 0,
    });
    const second = source.create({
      id: 'restored-2',
      tabId: 8,
      blobAssetId: 'blob-2',
      frameId: 0,
    });
    const target = new BlobCaptureSessionRegistry({ maxSessions: 1 }, () => 1_000);

    target.restore(first);
    const replaced = target.restore({
      ...first,
      candidateOrigins: ['https://media.example'],
    });
    expect(target.size).toBe(1);
    expect(replaced.candidateOrigins).toEqual(['https://media.example']);
    expect(() => target.restore(second)).toThrow(BlobCaptureSessionLimitError);

    target.transition(first.id, 'cancelled');
    expect(target.restore(second).id).toBe(second.id);
    expect(target.get(first.id)).toBeUndefined();
  });

  it('normalizes HTTP and Blob origins for permission candidates', () => {
    expect(normalizeBlobCaptureOrigin('https://media.example/path/video.mp4')).toBe(
      'https://media.example',
    );
    expect(normalizeBlobCaptureOrigin('blob:https://media.example/asset-id')).toBe(
      'https://media.example',
    );
    expect(normalizeBlobCaptureOrigin('data:video/mp4;base64,AAAA')).toBeUndefined();
  });
});
