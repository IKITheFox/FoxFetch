import { describe, expect, it } from 'vitest';

import type { BlobCaptureSession } from '../../src/modules/resolver/capture-session';
import { resolveCaptureSessionMedia } from '../../src/modules/resolver/capture-resolution';

function session(): BlobCaptureSession {
  return {
    id: 'capture',
    binding: { tabId: 1, blobAssetId: 'blob', frameId: 0 },
    state: 'capturing',
    documentId: 'doc',
    documentEpoch: 1,
    documentBoundAt: 1,
    retiredDocumentIds: [],
    candidateOrigins: [],
    observations: [],
    resolvedAssetIds: [],
    droppedObservationCount: 0,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 999_999,
  };
}

describe('Blob capture resolution', () => {
  it('turns high-confidence M4S video and audio requests into a mergeable pair', () => {
    const value = session();
    value.observations = [
      {
        id: 'video-request',
        requestId: 'video-request',
        tabId: 1,
        frameId: 0,
        documentId: 'doc',
        url: 'https://cdn.example/video-track.m4s?token=secret',
        observedAt: 10,
        resourceType: 'xmlhttprequest',
        mime: 'video/mp4',
        status: 206,
        range: { start: 0, end: 1_023, total: 10_000 },
        requestHeaders: {
          referer: 'https://example.com/watch',
          authorization: 'Bearer video-token',
        },
      },
      {
        id: 'audio-request',
        requestId: 'audio-request',
        tabId: 1,
        frameId: 0,
        documentId: 'doc',
        url: 'https://cdn.example/audio-track.m4s?token=secret',
        observedAt: 11,
        resourceType: 'xmlhttprequest',
        mime: 'audio/mp4',
        status: 206,
        range: { start: 0, end: 1_023, total: 2_000 },
      },
    ];

    const result = resolveCaptureSessionMedia(
      value,
      { pageUrl: 'https://example.com/watch', pageTitle: '演示视频' },
      false,
    );

    expect(result.assets).toHaveLength(2);
    expect(result.videoAssetId).toBeTruthy();
    expect(result.audioAssetId).toBeTruthy();
    expect(result.assets.map((asset) => asset.extension)).toEqual(['mp4', 'm4a']);
    expect(result.assets[0]?.url).toContain('token=secret');
    expect(result.assets[0]?.requestHeaders).toEqual({
      referer: 'https://example.com/watch',
      authorization: 'Bearer video-token',
    });
  });

  it('accepts a quiet single track only when it matches the bound media kind', () => {
    const audioOnly = session();
    audioOnly.observations = [
      {
        id: 'audio-track',
        requestId: 'audio-track',
        tabId: 1,
        frameId: 0,
        documentId: 'doc',
        url: 'https://cdn.example/audio.m4s',
        observedAt: 10,
        resourceType: 'media',
        mime: 'audio/mp4',
        kind: 'audio',
        status: 200,
      },
    ];

    expect(
      resolveCaptureSessionMedia(
        audioOnly,
        { pageUrl: 'https://example.com/watch', pageTitle: 'Example', expectedKind: 'video' },
        true,
      ).assets,
    ).toEqual([]);
    expect(
      resolveCaptureSessionMedia(
        audioOnly,
        { pageUrl: 'https://example.com/watch', pageTitle: 'Example', expectedKind: 'audio' },
        true,
      ).directAssetId,
    ).toBeDefined();
  });

  it('waits before accepting one direct track', () => {
    const value = session();
    value.observations = [
      {
        id: 'video-request',
        requestId: 'video-request',
        tabId: 1,
        frameId: 0,
        documentId: 'doc',
        url: 'https://cdn.example/movie.mp4',
        observedAt: 10,
        resourceType: 'media',
        mime: 'video/mp4',
        status: 200,
      },
    ];

    const context = { pageUrl: 'https://example.com/watch', pageTitle: 'Movie' };
    expect(resolveCaptureSessionMedia(value, context, false).assets).toHaveLength(0);
    expect(resolveCaptureSessionMedia(value, context, true).directAssetId).toBeTruthy();
  });

  it('ignores retired-document tracks when resolving the current document', () => {
    const value = session();
    value.documentId = 'document-new';
    value.documentEpoch = 2;
    value.retiredDocumentIds = ['document-old'];
    value.observations = [
      {
        id: 'old-video',
        requestId: 'old-video',
        tabId: 1,
        frameId: 0,
        documentId: 'document-old',
        url: 'https://old-cdn.example/video.m4s',
        observedAt: 10,
        resourceType: 'xmlhttprequest',
        mime: 'video/mp4',
        status: 206,
      },
      {
        id: 'old-audio',
        requestId: 'old-audio',
        tabId: 1,
        frameId: 0,
        documentId: 'document-old',
        url: 'https://old-cdn.example/audio.m4s',
        observedAt: 11,
        resourceType: 'xmlhttprequest',
        mime: 'audio/mp4',
        status: 206,
      },
      {
        id: 'new-video',
        requestId: 'new-video',
        tabId: 1,
        frameId: 0,
        documentId: 'document-new',
        url: 'https://new-cdn.example/movie.mp4?token=current',
        observedAt: 20,
        resourceType: 'media',
        mime: 'video/mp4',
        status: 200,
        requestHeaders: {
          referer: 'https://example.com/new-video',
        },
      },
    ];

    const result = resolveCaptureSessionMedia(
      value,
      { pageUrl: 'https://example.com/new-video', pageTitle: 'New video' },
      true,
    );

    expect(result).toMatchObject({
      candidateCount: 1,
      assets: [
        {
          url: 'https://new-cdn.example/movie.mp4?token=current',
          requestHeaders: { referer: 'https://example.com/new-video' },
        },
      ],
    });
    expect(result.directAssetId).toBe(result.assets[0]?.id);
    expect(result.videoAssetId).toBeUndefined();
    expect(result.audioAssetId).toBeUndefined();
  });
});
