import { describe, expect, it, vi } from 'vitest';
import {
  beginPageAssistedMergeStaging,
  cleanupExpiredStagedMergeInputs,
  cleanupStagedMergeInputs,
  resolveMergeRequestSources,
  reuseStagedMergeInputsFromOpfs,
  stageMergeInputsToOpfs,
  type MergeStagingDirectory,
} from '../../src/modules/merge';

class MemoryWritable {
  readonly chunks: Uint8Array[] = [];
  aborted = false;

  async write(data: BufferSource | Blob | string): Promise<void> {
    const view =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
    this.chunks.push(view.slice());
  }

  async close(): Promise<void> {}

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class MemoryFileHandle {
  readonly kind = 'file';
  writable = new MemoryWritable();

  async createWritable(): Promise<MemoryWritable> {
    this.writable = new MemoryWritable();
    return this.writable;
  }

  async getFile(): Promise<File> {
    return new File(
      this.writable.chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer),
      'input.media',
      {
        type: 'application/octet-stream',
      },
    );
  }
}

class MemoryDirectory implements MergeStagingDirectory {
  readonly files = new Map<string, MemoryFileHandle>();
  readonly removals: string[] = [];

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException('missing', 'NotFoundError');
    const handle = new MemoryFileHandle();
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    this.removals.push(name);
    if (!this.files.delete(name)) throw new DOMException('missing', 'NotFoundError');
  }

  async *entries(): AsyncIterableIterator<[string, { kind?: string }]> {
    for (const [name, handle] of this.files) yield [name, handle];
  }
}

const request = {
  video: { url: 'https://media.example/video.m4s' },
  audio: { url: 'https://media.example/audio.m4s' },
} as const;

describe('OPFS merge input staging', () => {
  it('restarts once from zero instead of appending a full 200 after partial 206', async () => {
    const root = new MemoryDirectory();
    const videoRanges: Array<string | null> = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).includes('audio')) return new Response(new Uint8Array([8]));
      const range = new Headers(init?.headers).get('range');
      videoRanges.push(range);
      if (range === 'bytes=0-')
        return new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-1/4', etag: '"v1"' },
        });
      return new Response(new Uint8Array([9, 8, 7, 6]), { headers: { 'content-length': '4' } });
    }) as typeof fetch;
    const staged = await stageMergeInputsToOpfs(request, 'range-disappeared', {
      root,
      fetchFn,
      skipSourceSelection: true,
    });
    expect([...new Uint8Array(await staged.videoBlob.arrayBuffer())]).toEqual([9, 8, 7, 6]);
    expect(videoRanges).toEqual(['bytes=0-', 'bytes=2-', null]);
    expect(staged.readBytes).toBe(5);
  });

  it('rejects a changed declared total while receiving successive 206 parts', async () => {
    const root = new MemoryDirectory();
    let count = 0;
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('audio')) return new Response(new Uint8Array([8]));
      return ++count === 1
        ? new Response(new Uint8Array([1, 2]), {
            status: 206,
            headers: { 'content-range': 'bytes 0-1/4', etag: '"v1"' },
          })
        : new Response(new Uint8Array([3, 4, 5]), {
            status: 206,
            headers: { 'content-range': 'bytes 2-4/5', etag: '"v1"' },
          });
    }) as typeof fetch;
    await expect(
      stageMergeInputsToOpfs(request, 'changed-total', {
        root,
        fetchFn,
        skipSourceSelection: true,
      }),
    ).rejects.toMatchObject({ detail: { reason: 'RANGE_INVALID' } });
    expect(root.files.size).toBe(0);
  });

  it('does not falsely confirm strict cleanup when OPFS denies removal', async () => {
    const root = new MemoryDirectory();
    root.removeEntry = async () => {
      throw new DOMException('busy', 'InvalidStateError');
    };
    await expect(cleanupStagedMergeInputs(root, 'busy', { strict: true })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    await expect(cleanupStagedMergeInputs(root, 'busy')).resolves.toBeUndefined();
  });

  it('preserves cancellation and clears both temporary tracks with a stalled peer', async () => {
    const root = new MemoryDirectory();
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response(new ReadableStream<Uint8Array>()));
    const task = stageMergeInputsToOpfs(request, 'cancel-stalled', {
      root,
      fetchFn,
      signal: controller.signal,
      skipSourceSelection: true,
    });
    const failure = expect(task).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    controller.abort();
    await failure;
    expect(root.files.size).toBe(0);
  });
  it('keeps progress indeterminate until both sizes are known, then completes at one', async () => {
    const root = new MemoryDirectory();
    const progress: Array<{ ratio: number | null; readBytes?: number; totalBytes?: number }> = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return url.includes('video')
        ? new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-length': '4' },
          })
        : new Response(new Uint8Array([5, 6]), { status: 200 });
    }) as typeof fetch;

    const staged = await stageMergeInputsToOpfs(request, 'job/unsafe', {
      root,
      fetchFn,
      now: () => 1_000,
      onProgress: (event) => progress.push(event),
    });

    expect(progress.some((event) => event.ratio == null)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ ratio: 1, readBytes: 6, totalBytes: 6 });
    expect(staged.videoBlob.size).toBe(4);
    expect(staged.audioBlob.size).toBe(2);
    expect([...root.files.keys()]).toEqual([
      'merge-job-unsafe-video.input',
      'merge-job-unsafe-audio.input',
    ]);

    await staged.cleanup();
    expect(root.files.size).toBe(0);
  });

  it('continues a bounded partial response without duplicating bytes', async () => {
    const root = new MemoryDirectory();
    const seenRanges: string[] = [];
    const videoParts = [
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/5', etag: '"same-video"' },
      }),
      new Response(new Uint8Array([4, 5]), {
        status: 206,
        headers: { 'content-range': 'bytes 3-4/5', etag: '"same-video"' },
      }),
    ];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const requestedRange = new Headers(init?.headers).get('range') ?? '';
      seenRanges.push(requestedRange);
      if (requestedRange === 'bytes=0-0') {
        return String(input).includes('video')
          ? new Response(new Uint8Array([1]), {
              status: 206,
              headers: { 'content-range': 'bytes 0-0/5' },
            })
          : new Response(new Uint8Array([8]), {
              status: 206,
              headers: { 'content-range': 'bytes 0-0/1' },
            });
      }
      return String(input).includes('video')
        ? videoParts.shift()!
        : new Response(new Uint8Array([8]), {
            status: 200,
            headers: { 'content-length': '1' },
          });
    }) as typeof fetch;

    const staged = await stageMergeInputsToOpfs(request, 'range-job', { root, fetchFn });
    expect(staged.videoBlob.size).toBe(5);
    expect(staged.readBytes).toBe(6);
    expect(seenRanges).toContain('bytes=0-');
    expect(seenRanges).toContain('bytes=3-');
    await staged.cleanup();
  });

  it('removes both temporary inputs when either track fails', async () => {
    const root = new MemoryDirectory();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) =>
      String(input).includes('video')
        ? new Response(null, { status: 403 })
        : new Response(new Uint8Array([1]), { status: 200 }),
    ) as typeof fetch;

    await expect(stageMergeInputsToOpfs(request, 'failed-job', { root, fetchFn })).rejects.toThrow(
      /HTTP 403/u,
    );
    expect(root.files.size).toBe(0);
    expect(root.removals).toContain('merge-failed-job-video.input');
    expect(root.removals).toContain('merge-failed-job-audio.input');

    await cleanupStagedMergeInputs(root, 'failed-job');
  });

  it('marks only an unambiguous all-mirror 403 source-selection failure', async () => {
    const all403 = vi.fn(async () => new Response(null, { status: 403 })) as typeof fetch;
    await expect(resolveMergeRequestSources(request, { fetchFn: all403 })).rejects.toMatchObject({
      detail: { code: 'NETWORK_FAILED', httpStatus: 403 },
    });

    let calls = 0;
    const mixed = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('transport failed');
      return new Response(null, { status: 403 });
    }) as typeof fetch;
    await expect(resolveMergeRequestSources(request, { fetchFn: mixed })).rejects.not.toMatchObject(
      {
        detail: { httpStatus: 403 },
      },
    );
  });

  it('prefers a strict 206 mirror over a primary origin that ignores Range', async () => {
    const root = new MemoryDirectory();
    const primaryVideo = 'https://primary.example/video.m4s';
    const backupVideo = 'https://backup.example/video.m4s';
    const downloadUrls: string[] = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      if (range === 'bytes=0-0') {
        if (url === primaryVideo) return new Response(new Uint8Array([9]), { status: 200 });
        const total = url === backupVideo ? 3 : 1;
        return new Response(new Uint8Array([1]), {
          status: 206,
          headers: { 'content-range': `bytes 0-0/${total}` },
        });
      }
      downloadUrls.push(url);
      const bytes = url === backupVideo ? new Uint8Array([1, 2, 3]) : new Uint8Array([4]);
      return new Response(bytes, {
        status: 206,
        headers: { 'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
      });
    }) as typeof fetch;

    const staged = await stageMergeInputsToOpfs(
      {
        video: { url: primaryVideo, sources: [{ url: backupVideo }] },
        audio: request.audio,
      },
      'mirror-job',
      { root, fetchFn },
    );

    expect(staged.videoBlob.size).toBe(3);
    expect(downloadUrls).toContain(backupVideo);
    expect(downloadUrls).not.toContain(primaryVideo);
    await staged.cleanup();
  });

  it('marks all-200 origins for sequential OPFS and rejects malformed 206 ranges', async () => {
    const allSequential = vi.fn(
      async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    ) as typeof fetch;
    await expect(resolveMergeRequestSources(request, { fetchFn: allSequential })).resolves.toEqual(
      expect.objectContaining({ requiresLocalBlobSource: true }),
    );

    const malformed = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: { 'content-range': 'bytes 4-4/10' },
        }),
    ) as typeof fetch;
    await expect(resolveMergeRequestSources(request, { fetchFn: malformed })).rejects.toMatchObject(
      {
        detail: { code: 'RANGE_RESPONSE_INVALID' },
      },
    );
  });

  it('forces a delivered Dolby Vision request through complete local staging even with strict 206 sources', async () => {
    const strictRange = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/10' },
        }),
    ) as typeof fetch;

    await expect(
      resolveMergeRequestSources(
        {
          ...request,
          video: {
            ...request.video,
            dynamicRange: {
              provider: 'bilibili',
              range: 'Dolby Vision',
              remuxable: 'unknown',
            },
          },
        },
        { fetchFn: strictRange },
      ),
    ).resolves.toEqual(expect.objectContaining({ requiresLocalBlobSource: true }));
    expect(strictRange).toHaveBeenCalledTimes(2);
  });

  it('reuses HTTP 200 preflight bytes so each track has one complete transfer', async () => {
    const root = new MemoryDirectory();
    const fullGets = new Map<string, number>();
    const fullBytes = new Map<string, number>();
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const bytes = url.includes('video') ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6]);
      const range = new Headers(init?.headers).get('range');
      if (range !== 'bytes=0-0') {
        fullGets.set(url, (fullGets.get(url) ?? 0) + 1);
        fullBytes.set(url, (fullBytes.get(url) ?? 0) + bytes.byteLength);
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      });
    }) as typeof fetch;

    const preflight = await stageMergeInputsToOpfs(request, 'reused-200-job', {
      root,
      fetchFn,
      now: () => 1_000,
      preserveForReuse: true,
    });
    expect(preflight.readBytes).toBe(6);

    const execute = await reuseStagedMergeInputsFromOpfs(request, 'reused-200-job', {
      root,
      now: () => 1_001,
    });
    expect(execute).not.toBeNull();
    expect(execute?.readBytes).toBe(6);
    expect(fullGets).toEqual(
      new Map([
        [request.video.url, 1],
        [request.audio.url, 1],
      ]),
    );
    expect([...fullBytes.values()].reduce((total, value) => total + value, 0)).toBe(6);

    const descriptor = await root
      .getFileHandle('merge-reused-200-job-staging.json')
      .then((handle) => handle.getFile())
      .then((file) => file.text());
    expect(descriptor).not.toContain('media.example');
    expect(JSON.parse(descriptor)).toMatchObject({
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      videoBytes: 4,
      audioBytes: 2,
      readBytes: 6,
    });
    await execute?.cleanup();
    expect(root.files.size).toBe(0);
  });

  it('rejects mismatched or expired reusable inputs and removes every staging file', async () => {
    const root = new MemoryDirectory();
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const bytes = String(input).includes('video')
        ? new Uint8Array([1, 2, 3])
        : new Uint8Array([4]);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      });
    }) as typeof fetch;

    await stageMergeInputsToOpfs(request, 'identity-job', {
      root,
      fetchFn,
      now: () => 10,
      preserveForReuse: true,
      reuseTtlMs: 100,
    });
    await expect(
      reuseStagedMergeInputsFromOpfs(
        { ...request, video: { url: 'https://media.example/other-video.m4s' } },
        'identity-job',
        { root, now: () => 11 },
      ),
    ).resolves.toBeNull();
    expect(root.files.size).toBe(0);

    await stageMergeInputsToOpfs(request, 'expired-job', {
      root,
      fetchFn,
      now: () => 20,
      preserveForReuse: true,
      reuseTtlMs: 5,
    });
    await cleanupExpiredStagedMergeInputs(root, { now: () => 26 });
    expect(root.files.size).toBe(0);
    expect(root.removals).toContain('merge-expired-job-staging.json');
  });

  it('restarts a failed full transfer from byte zero on an equivalent mirror', async () => {
    const root = new MemoryDirectory();
    const primary = 'https://primary.example/video.m4s';
    const mirror = 'https://mirror.example/video.m4s';
    const fullAttempts: string[] = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      if (range === 'bytes=0-0') {
        const total = url.includes('audio') ? 1 : 4;
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'content-range': `bytes 0-0/${total}` },
        });
      }
      fullAttempts.push(url);
      if (url === primary) {
        let pull = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pull++ === 0) controller.enqueue(new Uint8Array([9, 9]));
              else controller.error(new TypeError('connection reset'));
            },
          }),
          {
            status: 206,
            headers: { 'content-range': 'bytes 0-3/4' },
          },
        );
      }
      const bytes = url === mirror ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([8]);
      return new Response(bytes, {
        status: 206,
        headers: { 'content-range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
      });
    }) as typeof fetch;

    const staged = await stageMergeInputsToOpfs(
      {
        video: { url: primary, sources: [{ url: mirror }] },
        audio: request.audio,
      },
      'full-get-failover',
      { root, fetchFn },
    );

    expect(fullAttempts.filter((url) => url === primary)).toHaveLength(1);
    expect(fullAttempts.filter((url) => url === mirror)).toHaveLength(1);
    expect([...new Uint8Array(await staged.videoBlob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(staged.readBytes).toBe(5);
    await staged.cleanup();
  });

  it('keeps the original primary as fallback when a selected strict-range mirror fails', async () => {
    const root = new MemoryDirectory();
    const primary = 'https://primary-200.example/video.m4s';
    const strictMirror = 'https://strict-206.example/video.m4s';
    const fullAttempts: string[] = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      if (range === 'bytes=0-0') {
        if (url === primary) return new Response(new Uint8Array([0]), { status: 200 });
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/2' },
        });
      }
      fullAttempts.push(url);
      if (url === strictMirror) return new Response(null, { status: 503 });
      const bytes = url === primary ? new Uint8Array([6, 7]) : new Uint8Array([8, 9]);
      return new Response(bytes, {
        status: url === primary ? 200 : 206,
        headers: url === primary ? { 'content-length': '2' } : { 'content-range': 'bytes 0-1/2' },
      });
    }) as typeof fetch;

    const staged = await stageMergeInputsToOpfs(
      {
        video: { url: primary, sources: [{ url: strictMirror }] },
        audio: request.audio,
      },
      'selected-mirror-fallback',
      { root, fetchFn },
    );

    expect(fullAttempts.filter((url) => url === strictMirror || url === primary)).toEqual([
      strictMirror,
      primary,
    ]);
    expect([...new Uint8Array(await staged.videoBlob.arrayBuffer())]).toEqual([6, 7]);
    await staged.cleanup();
  });

  it('does not try another mirror after cancellation', async () => {
    const root = new MemoryDirectory();
    const backup = 'https://backup.example/video.m4s';
    const attempted: string[] = [];
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      if (range === 'bytes=0-0') {
        return new Response(new Uint8Array([0]), {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/1' },
        });
      }
      attempted.push(url);
      if (url === request.video.url) throw new DOMException('Aborted', 'AbortError');
      return new Response(new Uint8Array([1]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/1' },
      });
    }) as typeof fetch;

    await expect(
      stageMergeInputsToOpfs(
        { ...request, video: { ...request.video, sources: [{ url: backup }] } },
        'cancelled-mirror-job',
        { root, fetchFn },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempted).not.toContain(backup);
    expect(root.files.size).toBe(0);
  });

  it('rejects DRM and cross-media identities before probing any mirror', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      resolveMergeRequestSources({ ...request, drmSignals: ['eme'] }, { fetchFn }),
    ).rejects.toMatchObject({ detail: { code: 'DRM_PROTECTED' } });
    await expect(
      resolveMergeRequestSources(
        {
          video: { ...request.video, streamIdentity: 'bilibili:BV1A:cid=1' },
          audio: { ...request.audio, streamIdentity: 'bilibili:BV1B:cid=2' },
        },
        { fetchFn },
      ),
    ).rejects.toMatchObject({ detail: { code: 'TIMELINE_MISMATCH' } });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('page-assisted OPFS merge staging', () => {
  const identifiedRequest = {
    video: {
      url: 'https://upos-video.bilivideo.com/upgcxcode/1/2/video.m4s?token=1',
      streamIdentity: 'bilibili:BV1RANGE001:42001',
    },
    audio: {
      url: 'https://upos-audio.bilivideo.com/upgcxcode/1/2/audio.m4s?token=2',
      streamIdentity: 'bilibili:BV1RANGE001:42001',
    },
  } as const;

  it('commits only a complete contiguous pair and reuses the hash-bound descriptor', async () => {
    const root = new MemoryDirectory();
    const session = await beginPageAssistedMergeStaging(identifiedRequest, 'page-stage-ok', {
      root,
      now: () => 1_000,
      reuseTtlMs: 5_000,
    });

    await expect(session.append('video', 0, 4, new Uint8Array([1, 2]))).resolves.toEqual({
      persistedBytes: 2,
      trackBytes: 2,
    });
    await session.append('audio', 0, 2, new Uint8Array([8, 9]));
    await session.append('video', 2, 4, new Uint8Array([3, 4]));
    const committed = await session.commit();

    expect(committed.readBytes).toBe(6);
    expect([...root.files.keys()]).toEqual([
      'merge-page-stage-ok-video.input',
      'merge-page-stage-ok-audio.input',
      'merge-page-stage-ok-staging.json',
    ]);
    const reusable = await reuseStagedMergeInputsFromOpfs(identifiedRequest, 'page-stage-ok', {
      root,
      now: () => 2_000,
    });
    expect(reusable).toMatchObject({ readBytes: 6 });
    expect(await reusable!.videoBlob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(await reusable!.audioBlob.arrayBuffer()).toEqual(new Uint8Array([8, 9]).buffer);
  });

  it.each([
    ['gap', 1, 4],
    ['overlap', 0, 4],
    ['changed total', 2, 5],
  ])('atomically removes both tracks after a %s', async (_label, offset, total) => {
    const root = new MemoryDirectory();
    const session = await beginPageAssistedMergeStaging(identifiedRequest, 'page-stage-bad', {
      root,
    });
    await session.append('video', 0, 4, new Uint8Array([1, 2]));

    await expect(
      session.append('video', offset, total, new Uint8Array([3, 4])),
    ).rejects.toMatchObject({ detail: { code: 'RANGE_RESPONSE_INVALID' } });
    expect(root.files.size).toBe(0);
    expect(root.removals).toContain('merge-page-stage-bad-staging.json');
  });

  it('refuses an incomplete commit and leaves no descriptor or partial input', async () => {
    const root = new MemoryDirectory();
    const session = await beginPageAssistedMergeStaging(
      identifiedRequest,
      'page-stage-incomplete',
      { root },
    );
    await session.append('video', 0, 4, new Uint8Array([1, 2]));
    await session.append('audio', 0, 2, new Uint8Array([8, 9]));

    await expect(session.commit()).rejects.toMatchObject({
      detail: { code: 'NETWORK_FAILED' },
    });
    expect(root.files.size).toBe(0);
  });

  it('rejects DRM and mismatched stream identities before creating files', async () => {
    const drmRoot = new MemoryDirectory();
    await expect(
      beginPageAssistedMergeStaging(
        { ...identifiedRequest, drmSignals: ['declared-encrypted'] },
        'page-stage-drm',
        { root: drmRoot },
      ),
    ).rejects.toMatchObject({ detail: { code: 'DRM_PROTECTED' } });
    expect(drmRoot.files.size).toBe(0);

    const identityRoot = new MemoryDirectory();
    await expect(
      beginPageAssistedMergeStaging(
        {
          ...identifiedRequest,
          audio: { ...identifiedRequest.audio, streamIdentity: 'bilibili:BV1OTHER001:42002' },
        },
        'page-stage-identity',
        { root: identityRoot },
      ),
    ).rejects.toMatchObject({ detail: { code: 'TIMELINE_MISMATCH' } });
    expect(identityRoot.files.size).toBe(0);
  });
});
