import { describe, expect, it, vi } from 'vitest';

import {
  MergeJobRequestContextLease,
  inheritUnchangedMergeJobContexts,
  mergeJobDownloadAssets,
  mergeJobRequestContextSources,
} from '../../src/modules/jobs';
import type { MergeJobSeed } from '../../src/shared/types';

function seed(): MergeJobSeed {
  return {
    id: 'merge-context',
    videoUrl: 'https://video.example/track.m4s?token=video',
    audioUrl: 'https://audio.example/track.m4s?token=audio',
    videoContext: {
      pageUrl: 'https://page.example/watch/1',
      requestHeaders: {
        referer: 'https://page.example/watch/1',
        authorization: 'Bearer video-token',
      },
    },
    audioContext: {
      pageUrl: 'https://page.example/watch/1',
      requestHeaders: {
        origin: 'https://page.example',
        authorization: 'Bearer audio-token',
      },
    },
    title: '演示',
    createdAt: 100,
  };
}

describe('merge job request context', () => {
  it('inherits request context when a terminal job is replaced with the same URLs', () => {
    const previous = seed();
    const inherited = inheritUnchangedMergeJobContexts(
      previous,
      previous.videoUrl,
      previous.audioUrl,
    );

    expect(inherited).toEqual({
      videoContext: previous.videoContext,
      audioContext: previous.audioContext,
    });
    previous.videoContext!.requestHeaders!.authorization = 'Bearer mutated';
    expect(inherited.videoContext?.requestHeaders?.authorization).toBe('Bearer video-token');
  });

  it('does not leak context to a changed track URL', () => {
    const previous = seed();
    const inherited = inheritUnchangedMergeJobContexts(
      previous,
      'https://video.example/replacement.m4s',
      previous.audioUrl,
    );

    expect(inherited.videoContext).toBeUndefined();
    expect(inherited.audioContext).toEqual(previous.audioContext);
  });

  it('keeps video and audio context attached to the correct source', () => {
    const value = seed();
    const sources = mergeJobRequestContextSources(value);
    const assets = mergeJobDownloadAssets(value);

    expect(sources).toEqual([
      {
        url: value.videoUrl,
        pageUrl: 'https://page.example/watch/1',
        requestHeaders: {
          referer: 'https://page.example/watch/1',
          authorization: 'Bearer video-token',
        },
      },
      {
        url: value.audioUrl,
        pageUrl: 'https://page.example/watch/1',
        requestHeaders: {
          origin: 'https://page.example',
          authorization: 'Bearer audio-token',
        },
      },
    ]);
    expect(assets).toEqual([
      expect.objectContaining({
        kind: 'video',
        url: value.videoUrl,
        requestHeaders: { authorization: 'Bearer video-token', referer: expect.any(String) },
      }),
      expect.objectContaining({
        kind: 'audio',
        url: value.audioUrl,
        requestHeaders: { authorization: 'Bearer audio-token', origin: expect.any(String) },
      }),
    ]);

    value.videoContext!.requestHeaders!.authorization = 'Bearer mutated';
    expect(sources[0]?.requestHeaders?.authorization).toBe('Bearer video-token');
    expect(assets[0].requestHeaders?.authorization).toBe('Bearer video-token');
  });

  it('installs the owning track context for every same-representation mirror', () => {
    const value: MergeJobSeed = {
      ...seed(),
      videoSources: [
        {
          url: 'https://video-backup.example/track.m4s?token=backup',
          declaredMimeType: 'video/mp4; codecs="avc1.640028"',
        },
      ],
      audioSources: [{ url: 'https://audio-backup.example/track.m4s?token=backup' }],
    };

    expect(mergeJobRequestContextSources(value)).toEqual([
      expect.objectContaining({
        url: value.videoUrl,
        requestHeaders: { authorization: 'Bearer video-token', referer: expect.any(String) },
      }),
      expect.objectContaining({
        url: value.videoSources![0]!.url,
        requestHeaders: { authorization: 'Bearer video-token', referer: expect.any(String) },
      }),
      expect.objectContaining({
        url: value.audioUrl,
        requestHeaders: { authorization: 'Bearer audio-token', origin: expect.any(String) },
      }),
      expect.objectContaining({
        url: value.audioSources![0]!.url,
        requestHeaders: { authorization: 'Bearer audio-token', origin: expect.any(String) },
      }),
    ]);
  });

  it('installs both rules and releases them as one lease', async () => {
    let nextId = 10;
    const install = vi.fn(async () => nextId++);
    const release = vi.fn(async () => undefined);
    const lease = new MergeJobRequestContextLease({ install, release });

    await expect(lease.ensure(seed())).resolves.toEqual([10, 11]);
    expect(install).toHaveBeenCalledTimes(2);
    expect(lease.activeRuleIds).toEqual([10, 11]);

    await lease.release();
    expect(release).toHaveBeenCalledWith([10, 11]);
    expect(lease.activeRuleIds).toEqual([]);
  });

  it('rolls back a partial install when the second track fails', async () => {
    const install = vi
      .fn<(source: ReturnType<typeof mergeJobRequestContextSources>[number]) => Promise<number>>()
      .mockResolvedValueOnce(21)
      .mockRejectedValueOnce(new Error('DNR unavailable'));
    const release = vi.fn(async () => undefined);
    const lease = new MergeJobRequestContextLease({ install, release });

    await expect(lease.ensure(seed())).rejects.toThrow('DNR unavailable');
    expect(release).toHaveBeenCalledWith([21]);
    expect(lease.activeRuleIds).toEqual([]);
  });

  it('serializes an unload release behind an in-flight install', async () => {
    let resolveFirst!: (id: number) => void;
    const first = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    const install = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(32);
    const release = vi.fn(async () => undefined);
    const lease = new MergeJobRequestContextLease({ install, release });

    const installing = lease.ensure(seed());
    const releasing = lease.release();
    resolveFirst(31);

    await expect(installing).resolves.toEqual([31, 32]);
    await releasing;
    expect(release).toHaveBeenLastCalledWith([31, 32]);
    expect(lease.activeRuleIds).toEqual([]);
  });
});
