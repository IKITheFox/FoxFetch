import { afterEach, describe, expect, it, vi } from 'vitest';

import { remuxCapturedBlobsToFile, type FileSystemFileHandleLike } from '../../src/modules/merge';
import {
  MSE_CACHE_CAPTURE_HOST_ID,
  MseCacheCaptureRuntime,
  detectMseDrmSignal,
  inferMseTrackMime,
  isExtensionContextInvalidatedError,
  mseCacheRouteKeyForUrl,
} from '../../src/modules/resolver/mse-cache-capture';
import {
  normalizeCapturedTrackPair,
  type CapturedFragmentPart,
  type NormalizedCapturedTrack,
} from '../../src/modules/resolver/mse-fragment-normalizer';
import type {
  MseCacheAppendResult,
  MseCacheChunkStore,
  MseCacheMergeOutput,
  MseCacheStandardTrackOutput,
} from '../../src/modules/resolver/mse-cache-store';

function arrayBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

function chunk(
  sessionId: string,
  bytes: ArrayBuffer,
  sequence = 1,
  mime = 'application/octet-stream',
  trackId = 'track-1',
  groupId = 'media-source-1',
  timing: Record<string, unknown> = {},
) {
  return {
    channel: 'foxfetch:mse-cache:v1',
    direction: 'main-to-agent',
    type: 'chunk',
    sessionId,
    trackId,
    groupId,
    mime,
    sequence,
    bytes,
    // Unit fixtures model chunks that the MAIN hook accepted as the
    // initialization append unless a test explicitly overrides this flag.
    initialization: true,
    ...timing,
  };
}

function passthroughTrack(
  parts: readonly CapturedFragmentPart[],
  kind: 'video' | 'audio',
): NormalizedCapturedTrack {
  const format = parts[0]?.mime.includes('webm') ? 'webm' : 'mp4';
  const mime = `${kind}/${format}`;
  return {
    blob: new Blob(
      parts.map((part) => part.blob),
      { type: mime },
    ),
    mime,
    format,
    partCount: parts.length,
    fragmentCount: parts.length,
    droppedDuplicateCount: 0,
    warnings: [],
  };
}

const passthroughCapturedTracks: typeof normalizeCapturedTrackPair = async (
  videoParts,
  audioParts,
) => ({
  video: passthroughTrack(videoParts, 'video'),
  audio: passthroughTrack(audioParts, 'audio'),
});

function completedStandardTrackOutput(
  kind: 'video' | 'audio',
  onDownload: (filename: string) => void | Promise<void> = () => undefined,
): MseCacheStandardTrackOutput {
  const extension = kind === 'video' ? '.mp4' : '.mp3';
  const mimeType = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  return {
    result: {
      status: 'completed',
      kind,
      extension,
      mimeType,
      sourceCodec: kind === 'video' ? 'avc' : 'aac',
      outputCodec: kind === 'video' ? 'avc' : 'mp3',
      verification: {
        valid: true,
        sizeBytes: 1024,
        formatName: kind === 'video' ? 'ISO Base Media' : 'MP3',
        codec: kind === 'video' ? 'avc' : 'mp3',
        durationSeconds: 10,
      },
    },
    download: vi.fn(async (filename: string) => {
      await onDownload(filename);
      return { downloadId: kind === 'video' ? 17 : 18 };
    }),
    remove: vi.fn(async () => undefined),
  };
}

function standardTrackOutputFactory(
  onDownload: (filename: string, kind: 'video' | 'audio') => void | Promise<void> = () => undefined,
) {
  return vi.fn(
    async (
      _sessionId: string,
      _parts: readonly {
        trackId: string;
        mime: string;
        maxBytes: number;
        firstSequence: number;
      }[],
      _outputId: string,
      kind: 'video' | 'audio',
    ) => completedStandardTrackOutput(kind, (filename) => onDownload(filename, kind)),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.querySelector(`#${MSE_CACHE_CAPTURE_HOST_ID}`)?.remove();
  Reflect.deleteProperty(window, 'showSaveFilePicker');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MSE cache capture runtime', () => {
  it('uses only the media title for Bilibili cache filenames', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({
      sessionId: 'clean-title',
      title: '公司 10 个月不发工资，你能撑多久！_哔哩哔哩_bilibili-cache',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });

    expect(runtime.getSnapshot().filename).toBe('公司 10 个月不发工资,你能撑多久!');
    runtime.destroy();
  });

  it('infers late-hook MP4/WebM track MIME and downloads verified standard tracks', async () => {
    expect(inferMseTrackMime(new Uint8Array(arrayBuffer('....ftyp....vide....avc1')))).toBe(
      'video/mp4',
    );
    expect(
      inferMseTrackMime(
        new Uint8Array(
          Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode('A_OPUS')]).buffer,
        ),
      ),
    ).toBe('audio/webm');

    let finishSave: (() => void) | undefined;
    const standardDownload = vi.fn<(filename: string) => Promise<void>>(
      (_filename) =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const createStandardTrackOutput = standardTrackOutputFactory((filename) =>
      standardDownload(filename),
    );
    const runtime = new MseCacheCaptureRuntime(document, {
      themeMode: 'dark',
      createStandardTrackOutput,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'capture-1',
      title: 'Demo',
      reason: 'SERVER_FORBIDDEN',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    const first = arrayBuffer('....ftyp....moov....vide....avc1');
    expect(runtime.handleMainMessage(chunk('capture-1', first))).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'capturing',
      capturedBytes: first.byteLength,
      trackCount: 1,
      sourceCount: 1,
    });
    expect(document.querySelector(`#${MSE_CACHE_CAPTURE_HOST_ID}`)).toBeNull();

    const downloading = runtime.downloadCaptured();
    const second = arrayBuffer('second-fragment');
    expect(runtime.handleMainMessage(chunk('capture-1', second, 2))).toBe(true);
    expect(runtime.getSnapshot().capturedBytes).toBe(first.byteLength + second.byteLength);
    await vi.waitFor(() => expect(standardDownload).toHaveBeenCalledOnce());
    finishSave?.();
    await expect(downloading).resolves.toEqual(['Demo.mp4']);
    expect(standardDownload).toHaveBeenCalledWith('FoxFetch/Bilibili/Demo.mp4');
    expect(createStandardTrackOutput).toHaveBeenCalledWith(
      'capture-1',
      [
        {
          trackId: 'track-1',
          mime: 'video/mp4',
          maxBytes: first.byteLength,
          firstSequence: 1,
        },
      ],
      expect.stringMatching(/^standard-\d+-video-/u),
      'video',
    );

    runtime.destroy();
  });

  it('opens the save picker synchronously and merges one same-source video/audio pair', async () => {
    const handle = {
      name: 'Demo.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const pickMergeFile = vi.fn(() => Promise.resolve(handle));
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      container: 'mp4' as const,
      extension: '.mp4' as const,
      mimeType: 'video/mp4' as const,
      sizeBytes: 1234,
      durationSeconds: 10,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      pickMergeFile,
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    const videoBytes = arrayBuffer('video-fragment');
    const audioBytes = arrayBuffer('audio-fragment');
    runtime.handleMainMessage(
      chunk('capture-1', videoBytes, 1, 'video/mp4; codecs="avc1.640028"', 'video-1'),
    );
    runtime.handleMainMessage(
      chunk('capture-1', audioBytes, 2, 'audio/mp4; codecs="mp4a.40.2"', 'audio-1'),
    );
    runtime.setClearAfterDownload(true);
    const downloading = runtime.downloadCaptured(true);
    expect(pickMergeFile).toHaveBeenCalledOnce();
    expect(pickMergeFile).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Demo.mp4', extension: '.mp4' }),
    );

    await expect(downloading).resolves.toEqual(['Demo.mp4']);
    expect(remuxCapturedBlobs).toHaveBeenCalledOnce();
    const [videoBlob, audioBlob, pickedHandle, options] = (
      remuxCapturedBlobs as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(videoBlob).toMatchObject({ size: videoBytes.byteLength, type: 'video/mp4' });
    expect(audioBlob).toMatchObject({ size: audioBytes.byteLength, type: 'audio/mp4' });
    expect(pickedHandle).toBe(handle);
    expect(options).toMatchObject({
      preferredContainer: 'mp4',
      videoStreamIdentity: expect.stringMatching(/^mse-cache:capture-1:/u),
      audioStreamIdentity: expect.stringMatching(/^mse-cache:capture-1:/u),
    });
    expect(options.videoStreamIdentity).toBe(options.audioStreamIdentity);
    expect(runtime.getSnapshot().message).toContain('已无损合并并验证');
    expect(runtime.getSnapshot()).toMatchObject({ capturedBytes: 0, tracks: [] });
    runtime.destroy();
  });

  it('stages a picked merge in extension storage and publishes only verified bytes', async () => {
    const stagedFile = new File(['....ftypverified-cache-output'], 'merge.partial', {
      type: 'text/plain',
    });
    const stagedHandle = {
      name: 'merge.partial',
      createWritable: vi.fn(),
      getFile: vi.fn(async () => stagedFile),
    } as unknown as FileSystemFileHandleLike;
    const destinationWritable = {
      write: vi.fn(async (_blob: Blob) => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const destinationHandle = {
      name: 'Verified.mp4',
      createWritable: vi.fn(async () => destinationWritable),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const remove = vi.fn(async () => undefined);
    const download = vi.fn(async () => ({ downloadId: 1 }));
    const createMergeOutput = vi.fn(async (): Promise<MseCacheMergeOutput> => ({
      handle: stagedHandle,
      remove,
      download,
    }));
    const store = new (class implements MseCacheChunkStore {
      readonly kind = 'opfs' as const;
      private readonly chunks = new Map<string, ArrayBuffer[]>();
      append(sessionId: string, trackId: string, bytes: ArrayBuffer) {
        const key = `${sessionId}:${trackId}`;
        this.chunks.set(key, [...(this.chunks.get(key) ?? []), bytes]);
        return { persistedBytes: bytes.byteLength };
      }
      async getBlob(sessionId: string, trackId: string, mime: string) {
        return new Blob(this.chunks.get(`${sessionId}:${trackId}`) ?? [], { type: mime });
      }
      async clearSession() {}
      createMergeOutput = createMergeOutput;
    })();
    let finishRemux:
      | ((result: {
          status: 'completed';
          container: 'mp4';
          extension: '.mp4';
          mimeType: 'video/mp4';
          sizeBytes: number;
          durationSeconds: number;
        }) => void)
      | undefined;
    const remuxCapturedBlobs = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRemux = resolve;
        }),
    ) as unknown as typeof remuxCapturedBlobsToFile;
    const pickMergeFile = vi.fn(() => Promise.resolve(destinationHandle));
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      downloadSaveAs: true,
      pickMergeFile,
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'atomic-picked-merge', title: 'Verified' });
    runtime.handleMainMessage(
      chunk('atomic-picked-merge', arrayBuffer('video'), 1, 'video/mp4', 'video'),
    );
    runtime.handleMainMessage(
      chunk('atomic-picked-merge', arrayBuffer('audio'), 2, 'audio/mp4', 'audio'),
    );
    await vi.waitFor(() => expect(runtime.getSnapshot().capturedBytes).toBeGreaterThan(0));

    const pending = runtime.downloadCaptured(true);
    expect(pickMergeFile).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(remuxCapturedBlobs).toHaveBeenCalledOnce());
    expect(remuxCapturedBlobs).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.any(Blob),
      stagedHandle,
      expect.objectContaining({ preferredContainer: 'mp4' }),
    );
    expect(destinationHandle.createWritable).not.toHaveBeenCalled();

    finishRemux?.({
      status: 'completed',
      container: 'mp4',
      extension: '.mp4',
      mimeType: 'video/mp4',
      sizeBytes: stagedFile.size,
      durationSeconds: 10,
    });
    await expect(pending).resolves.toEqual(['Verified.mp4']);
    expect(destinationWritable.write).toHaveBeenCalledOnce();
    const publishedBlob = destinationWritable.write.mock.calls[0]?.[0] as Blob;
    expect(publishedBlob).toMatchObject({ size: stagedFile.size, type: 'video/mp4' });
    expect(destinationWritable.close).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('does not publish staging bytes when a picked merge fails verification', async () => {
    const stagedHandle = {
      name: 'merge.partial',
      createWritable: vi.fn(),
      getFile: vi.fn(async () => new File(['partial'], 'merge.partial')),
    } as unknown as FileSystemFileHandleLike;
    const destinationHandle = {
      name: 'Failed.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const remove = vi.fn(async () => undefined);
    const store = new (class implements MseCacheChunkStore {
      readonly kind = 'opfs' as const;
      private readonly chunks = new Map<string, ArrayBuffer[]>();
      append(sessionId: string, trackId: string, bytes: ArrayBuffer) {
        const key = `${sessionId}:${trackId}`;
        this.chunks.set(key, [...(this.chunks.get(key) ?? []), bytes]);
        return { persistedBytes: bytes.byteLength };
      }
      async getBlob(sessionId: string, trackId: string, mime: string) {
        return new Blob(this.chunks.get(`${sessionId}:${trackId}`) ?? [], { type: mime });
      }
      async clearSession() {}
      createMergeOutput = vi.fn(async (): Promise<MseCacheMergeOutput> => ({
        handle: stagedHandle,
        remove,
        download: vi.fn(async () => ({ downloadId: 1 })),
      }));
    })();
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      downloadSaveAs: true,
      pickMergeFile: vi.fn(async () => destinationHandle),
      remuxCapturedBlobs: vi.fn(async () => {
        throw new Error('输出验证失败');
      }) as unknown as typeof remuxCapturedBlobsToFile,
      normalizeCapturedTracks: passthroughCapturedTracks,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'failed-picked-merge', title: 'Failed' });
    runtime.handleMainMessage(
      chunk('failed-picked-merge', arrayBuffer('video'), 1, 'video/mp4', 'video'),
    );
    runtime.handleMainMessage(
      chunk('failed-picked-merge', arrayBuffer('audio'), 2, 'audio/mp4', 'audio'),
    );
    await vi.waitFor(() => expect(runtime.getSnapshot().capturedBytes).toBeGreaterThan(0));

    await expect(runtime.downloadCaptured(true)).rejects.toThrow('输出验证失败');
    expect(destinationHandle.createWritable).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('opens the native cache picker in Downloads and remembers the confirmed site directory', async () => {
    const handle = {
      name: 'Cache.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const showSaveFilePicker = vi.fn(async () => handle);
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: showSaveFilePicker,
    });
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      sizeBytes: 32,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'native-picker',
      title: 'Cache',
      pageUrl: 'https://www.youtube.com/watch?v=test',
    });
    runtime.handleMainMessage(
      chunk('native-picker', arrayBuffer('video'), 1, 'video/mp4', 'video'),
    );
    runtime.handleMainMessage(
      chunk('native-picker', arrayBuffer('audio'), 2, 'audio/mp4', 'audio'),
    );

    await expect(runtime.downloadCaptured(true)).resolves.toEqual(['Cache.mp4']);
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ff-cache-youtube',
        suggestedName: 'Cache.mp4',
        startIn: 'downloads',
      }),
    );
    runtime.destroy();
  });

  it('uses extension-origin streamed output and the unified directory when saveAs is disabled', async () => {
    const handle = {
      name: '测试视频.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const download = vi.fn(async () => ({ downloadId: 41 }));
    const remove = vi.fn(async () => undefined);
    const createMergeOutput = vi.fn(async (): Promise<MseCacheMergeOutput> => ({
      handle,
      download,
      remove,
    }));
    const store = new (class implements MseCacheChunkStore {
      readonly kind = 'opfs' as const;
      private readonly chunks = new Map<string, ArrayBuffer[]>();
      append(sessionId: string, trackId: string, bytes: ArrayBuffer) {
        const key = `${sessionId}:${trackId}`;
        this.chunks.set(key, [...(this.chunks.get(key) ?? []), bytes]);
        return { persistedBytes: bytes.byteLength };
      }
      async getBlob(sessionId: string, trackId: string, mime: string, maxBytes?: number) {
        const blob = new Blob(this.chunks.get(`${sessionId}:${trackId}`) ?? [], { type: mime });
        return maxBytes == null ? blob : blob.slice(0, maxBytes, mime);
      }
      async clearSession() {}
      createMergeOutput = createMergeOutput;
    })();
    const pickMergeFile = vi.fn(async () => handle);
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      container: 'mp4' as const,
      extension: '.mp4' as const,
      mimeType: 'video/mp4' as const,
      sizeBytes: 8192,
      durationSeconds: 10,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const saveBlob = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      downloadSaveAs: false,
      pickMergeFile,
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
      saveBlob,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'streamed-merge',
      title: '测试视频_哔哩哔哩_bilibili-cache',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    runtime.handleMainMessage(
      chunk('streamed-merge', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main'),
    );
    runtime.handleMainMessage(
      chunk('streamed-merge', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main'),
    );
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().capturedBytes).toBe(
        arrayBuffer('video').byteLength + arrayBuffer('audio').byteLength,
      ),
    );

    await expect(runtime.downloadCaptured(true)).resolves.toEqual(['测试视频.mp4']);
    expect(pickMergeFile).not.toHaveBeenCalled();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(createMergeOutput).toHaveBeenCalledWith(
      'streamed-merge',
      expect.stringMatching(/^merge-\d+-[a-z0-9]+$/u),
      '测试视频.mp4',
      'video/mp4',
    );
    expect(remuxCapturedBlobs).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.any(Blob),
      handle,
      expect.objectContaining({ preferredContainer: 'mp4' }),
    );
    expect(download).toHaveBeenCalledWith('FoxFetch/Bilibili/测试视频.mp4', {
      pageUrl: 'https://www.bilibili.com/video/BV1test',
      saveAs: false,
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().message).toContain('Downloads/FoxFetch/Bilibili/测试视频.mp4');
    runtime.destroy();
  });

  it('selects the largest same-source pair from multiple media sources', async () => {
    const handle = {
      name: 'Main.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const pickMergeFile = vi.fn(() => Promise.resolve(handle));
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      sizeBytes: 4096,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const saveBlob = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      pickMergeFile,
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
      saveBlob,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'capture-1', title: 'Main' });
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('tiny-ad'), 1, 'video/mp4', 'ad-video', 'ad-source'),
    );
    const mainVideo = arrayBuffer('main-video-fragment-is-largest');
    const mainAudio = arrayBuffer('main-audio-fragment');
    runtime.handleMainMessage(
      chunk('capture-1', mainVideo, 2, 'video/mp4', 'main-video', 'main-source'),
    );
    runtime.handleMainMessage(
      chunk('capture-1', mainAudio, 3, 'audio/mp4', 'main-audio', 'main-source'),
    );
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('x'), 4, 'audio/mp4', 'alternate-audio', 'main-source'),
    );

    expect(runtime.getSnapshot()).toMatchObject({ sourceCount: 2, trackCount: 4, canMerge: true });
    await expect(runtime.downloadCaptured(true)).resolves.toEqual(['Main.mp4']);
    expect(saveBlob).not.toHaveBeenCalled();
    const [videoBlob, audioBlob] = (remuxCapturedBlobs as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(videoBlob).toMatchObject({ size: mainVideo.byteLength });
    expect(audioBlob).toMatchObject({ size: mainAudio.byteLength });
    runtime.destroy();
  });

  it('refuses the largest byte pair when its captured timelines do not overlap', async () => {
    const saveBlob = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      saveBlob,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'non-overlap', title: 'Non overlap' });
    runtime.handleMainMessage(
      chunk(
        'non-overlap',
        arrayBuffer('largest-video-fragment'),
        1,
        'video/mp4',
        'video',
        'main-source',
        { bufferedRanges: [[0, 10]], duration: 20 },
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'non-overlap',
        arrayBuffer('largest-audio-fragment'),
        2,
        'audio/mp4',
        'audio',
        'main-source',
        { bufferedRanges: [[10.5, 20]], duration: 20 },
      ),
    );

    expect(runtime.getSnapshot()).toMatchObject({
      canMerge: false,
      mergeBlockReason: expect.stringMatching(/不重叠/u),
    });
    await expect(runtime.downloadCaptured(true)).rejects.toMatchObject({
      detail: expect.objectContaining({ code: 'TIMELINE_MISMATCH', canDownloadSeparately: true }),
    });
    expect(saveBlob).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it('selects the unique timeline-compatible pair instead of a larger incompatible track', async () => {
    const handle = { name: 'Compatible.mp4' } as FileSystemFileHandleLike;
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      sizeBytes: 321,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      pickMergeFile: vi.fn(async () => handle),
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
    });
    runtime.start({ sessionId: 'compatible-pair', title: 'Compatible' });
    const videoBytes = arrayBuffer('video-track');
    const compatibleAudioBytes = arrayBuffer('audio');
    runtime.handleMainMessage(
      chunk('compatible-pair', videoBytes, 1, 'video/mp4', 'video', 'main-source', {
        bufferedRanges: [[0, 10]],
        duration: 10,
      }),
    );
    runtime.handleMainMessage(
      chunk(
        'compatible-pair',
        arrayBuffer('incompatible-audio-is-much-larger'),
        2,
        'audio/mp4',
        'audio-other-lifecycle',
        'main-source',
        { bufferedRanges: [[12, 22]], duration: 22 },
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'compatible-pair',
        compatibleAudioBytes,
        3,
        'audio/mp4',
        'audio-compatible',
        'main-source',
        { bufferedRanges: [[0.05, 10]], duration: 10 },
      ),
    );

    expect(runtime.getSnapshot().canMerge).toBe(true);
    await expect(runtime.downloadCaptured(true)).resolves.toEqual(['Compatible.mp4']);
    const [videoBlob, audioBlob] = (remuxCapturedBlobs as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(videoBlob).toMatchObject({ size: videoBytes.byteLength });
    expect(audioBlob).toMatchObject({ size: compatibleAudioBytes.byteLength });
    runtime.destroy();
  });

  it('rejects multiple timeline-compatible candidates as a changeType ambiguity', async () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'ambiguous-pairs', title: 'Ambiguous' });
    const timing = { bufferedRanges: [[0, 10]], duration: 10 };
    runtime.handleMainMessage(
      chunk(
        'ambiguous-pairs',
        arrayBuffer('video'),
        1,
        'video/mp4',
        'video',
        'main-source',
        timing,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'ambiguous-pairs',
        arrayBuffer('audio-one'),
        2,
        'audio/mp4',
        'audio-one',
        'main-source',
        timing,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'ambiguous-pairs',
        arrayBuffer('audio-two-is-larger'),
        3,
        'audio/mp4',
        'audio-two',
        'main-source',
        timing,
      ),
    );

    expect(runtime.getSnapshot()).toMatchObject({
      canMerge: false,
      mergeBlockReason: expect.stringMatching(/多组|changeType/u),
    });
    await expect(runtime.downloadCaptured(true)).rejects.toThrow(/changeType/u);
    runtime.destroy();
  });

  it('normalizes sequential MP4 changeType epochs before invoking the remuxer', async () => {
    const handle = { name: 'ChangeType.mp4' } as FileSystemFileHandleLike;
    const normalizeCapturedTracks = vi.fn(passthroughCapturedTracks);
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      sizeBytes: 456,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      pickMergeFile: vi.fn(async () => handle),
      normalizeCapturedTracks,
      remuxCapturedBlobs,
    });
    runtime.start({ sessionId: 'change-type-sequence', title: 'ChangeType' });
    const firstHalf = { bufferedRanges: [[0, 5]], duration: 10 };
    const secondHalf = { bufferedRanges: [[5, 10]], duration: 10 };
    runtime.handleMainMessage(
      chunk(
        'change-type-sequence',
        arrayBuffer('video-first'),
        1,
        'video/mp4',
        'video-before-change',
        'main-source',
        firstHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'change-type-sequence',
        arrayBuffer('audio-first'),
        2,
        'audio/mp4',
        'audio-before-change',
        'main-source',
        firstHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'change-type-sequence',
        arrayBuffer('video-second'),
        3,
        'video/mp4',
        'video-after-change',
        'main-source',
        secondHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'change-type-sequence',
        arrayBuffer('audio-second'),
        4,
        'audio/mp4',
        'audio-after-change',
        'main-source',
        secondHalf,
      ),
    );

    await vi.waitFor(() => expect(runtime.getSnapshot().canMerge).toBe(true));
    await expect(runtime.downloadCaptured(true)).resolves.toEqual(['ChangeType.mp4']);
    expect(normalizeCapturedTracks).toHaveBeenCalledOnce();
    const [videoParts, audioParts] = normalizeCapturedTracks.mock.calls[0]!;
    expect(videoParts.map((part) => [part.id, part.firstSequence])).toEqual([
      ['video-before-change', 1],
      ['video-after-change', 3],
    ]);
    expect(audioParts.map((part) => [part.id, part.firstSequence])).toEqual([
      ['audio-before-change', 2],
      ['audio-after-change', 4],
    ]);
    expect(remuxCapturedBlobs).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('submits each same-kind changeType sequence as one standard cache output', async () => {
    const createStandardTrackOutput = standardTrackOutputFactory();
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      createStandardTrackOutput,
    });
    runtime.start({
      sessionId: 'separate-change-type',
      title: 'Separate ChangeType',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    const firstHalf = { bufferedRanges: [[0, 5]], duration: 10 };
    const secondHalf = { bufferedRanges: [[5, 10]], duration: 10 };
    runtime.handleMainMessage(
      chunk(
        'separate-change-type',
        arrayBuffer('video-first'),
        1,
        'video/mp4',
        'video-before-change',
        'main-source',
        firstHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'separate-change-type',
        arrayBuffer('audio-first'),
        2,
        'audio/mp4',
        'audio-before-change',
        'main-source',
        firstHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'separate-change-type',
        arrayBuffer('video-second'),
        3,
        'video/mp4',
        'video-after-change',
        'main-source',
        secondHalf,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'separate-change-type',
        arrayBuffer('audio-second'),
        4,
        'audio/mp4',
        'audio-after-change',
        'main-source',
        secondHalf,
      ),
    );

    await expect(runtime.downloadCaptured(false)).resolves.toEqual([
      'Separate ChangeType.mp4',
      'Separate ChangeType.mp3',
    ]);
    expect(createStandardTrackOutput).toHaveBeenCalledTimes(2);
    expect(
      createStandardTrackOutput.mock.calls.map((call) => ({
        kind: call[3],
        ids: call[1].map((part) => part.trackId),
      })),
    ).toEqual([
      {
        kind: 'video',
        ids: ['video-before-change', 'video-after-change'],
      },
      {
        kind: 'audio',
        ids: ['audio-before-change', 'audio-after-change'],
      },
    ]);
    runtime.destroy();
  });

  it('prefers a complete mergeable group over a larger incomplete group', async () => {
    const handle = { name: 'Complete.mp4' } as FileSystemFileHandleLike;
    const remuxCapturedBlobs = vi.fn(async () => ({
      status: 'completed' as const,
      sizeBytes: 123,
    })) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      pickMergeFile: vi.fn(async () => handle),
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
    });
    runtime.start({ sessionId: 'complete-priority', title: 'Complete' });
    runtime.markStartedAtBeginning();
    const completeCoverage = { bufferedRanges: [[0.1, 10]], duration: 10 };
    const incompleteCoverage = { bufferedRanges: [[5, 10]], duration: 10 };
    const completeVideo = arrayBuffer('small-video');
    const completeAudio = arrayBuffer('small-audio');
    runtime.handleMainMessage(
      chunk(
        'complete-priority',
        completeVideo,
        1,
        'video/mp4',
        'complete-video',
        'complete-group',
        completeCoverage,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'complete-priority',
        completeAudio,
        2,
        'audio/mp4',
        'complete-audio',
        'complete-group',
        completeCoverage,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'complete-priority',
        arrayBuffer('much-larger-incomplete-video-track'),
        3,
        'video/mp4',
        'incomplete-video',
        'incomplete-group',
        incompleteCoverage,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'complete-priority',
        arrayBuffer('much-larger-incomplete-audio-track'),
        4,
        'audio/mp4',
        'incomplete-audio',
        'incomplete-group',
        incompleteCoverage,
      ),
    );

    expect(runtime.getSnapshot()).toMatchObject({
      isComplete: true,
      completeGroupIds: ['complete-group'],
    });
    await runtime.downloadCaptured(true);
    const [video, audio] = (remuxCapturedBlobs as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(video).toMatchObject({ size: completeVideo.byteLength });
    expect(audio).toMatchObject({ size: completeAudio.byteLength });
    runtime.destroy();
  });

  it('never silently falls back to separate files when merge was requested', async () => {
    const saveBlob = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      saveBlob,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('video'), 1, 'video/mp4', 'video', 'source-video'),
    );
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'source-audio'),
    );

    expect(runtime.getSnapshot().canMerge).toBe(false);
    await expect(runtime.downloadCaptured(true)).rejects.toThrow(/同一媒体源/u);
    expect(saveBlob).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().message).toContain('无法安全合并');
    runtime.destroy();
  });

  it('does not let one MediaSource end stop the global capture', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    runtime.handleMainMessage(chunk('capture-1', arrayBuffer('....ftyp....soun....mp4a'), 1));
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'media-source-1',
    });

    expect(runtime.getSnapshot().status).toBe('capturing');
    expect(runtime.getSnapshot().message).toContain('其他播放器或轨道仍可能继续');
    runtime.destroy();
  });

  it('marks only the best main group complete using common video/audio coverage', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    const coverage = {
      bufferedRanges: [[0.1, 30]],
      bufferedStart: 0.1,
      bufferedEnd: 30,
      duration: 30,
    };
    runtime.handleMainMessage(
      chunk(
        'capture-1',
        arrayBuffer('main-video-is-much-larger'),
        1,
        'video/mp4',
        'main-video',
        'main-source',
        coverage,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'capture-1',
        arrayBuffer('main-audio'),
        2,
        'audio/mp4',
        'main-audio',
        'main-source',
        coverage,
      ),
    );
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('ad'), 3, 'video/mp4', 'ad-video', 'ad-source', {
        bufferedRanges: [[12, 15]],
        duration: 15,
      }),
    );
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'ad-source',
    });

    expect(runtime.getSnapshot()).toMatchObject({ isComplete: false, startedAtBeginning: false });
    runtime.markStartedAtBeginning();
    expect(runtime.getSnapshot()).toMatchObject({
      isComplete: true,
      completeGroupIds: ['main-source'],
      cachedSeconds: 30,
      totalSeconds: 30,
      progressRatio: 1,
      storageKind: 'memory',
    });
    expect(runtime.getSnapshot().capacityBytes).toBeUndefined();
    expect(runtime.getSnapshot().groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'main-source',
          startSeconds: 0.1,
          endSeconds: 30,
          complete: true,
        }),
        expect.objectContaining({ id: 'ad-source', complete: false }),
      ]),
    );
    runtime.destroy();
  });

  it('does not mark a group complete when one paired track misses the beginning', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    runtime.markStartedAtBeginning();
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main', {
        bufferedRanges: [[0, 20]],
        duration: 20,
      }),
    );
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main', {
        bufferedRanges: [[0.5, 20]],
        duration: 20,
      }),
    );
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'main',
    });

    expect(runtime.getSnapshot()).toMatchObject({ isComplete: false, completeGroupIds: [] });
    expect(runtime.getSnapshot().groups[0]).toMatchObject({
      startSeconds: 0.5,
      endSeconds: 20,
      sourceEnded: true,
      complete: false,
    });
    runtime.destroy();
  });

  it('does not count an uncaptured existing 0-15 range toward captured completeness', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'capture-1', title: 'Late capture' });
    runtime.markStartedAtBeginning();
    const capturedOnlyAfterFifteen = {
      bufferedRanges: [[15, 20]],
      bufferedStart: 15,
      bufferedEnd: 20,
      duration: 20,
    };
    runtime.handleMainMessage(
      chunk(
        'capture-1',
        arrayBuffer('late-video'),
        1,
        'video/mp4',
        'video',
        'main',
        capturedOnlyAfterFifteen,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'capture-1',
        arrayBuffer('late-audio'),
        2,
        'audio/mp4',
        'audio',
        'main',
        capturedOnlyAfterFifteen,
      ),
    );
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'main',
    });

    expect(runtime.getSnapshot()).toMatchObject({
      startedAtBeginning: true,
      isComplete: false,
      completeGroupIds: [],
    });
    expect(runtime.getSnapshot().groups[0]).toMatchObject({
      startSeconds: 15,
      endSeconds: 20,
      sourceEnded: true,
      complete: false,
    });
    runtime.destroy();
  });

  it('pauses, downloads, and resumes the same capture session without discarding data', async () => {
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    let finishSave: (() => void) | undefined;
    const standardDownload = vi.fn(
      (_filename: string) =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      createStandardTrackOutput: standardTrackOutputFactory((filename) =>
        standardDownload(filename),
      ),
    });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    const first = arrayBuffer('first');
    runtime.handleMainMessage(chunk('capture-1', first, 1, 'video/mp4'));
    runtime.pause();
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'paused',
      capturedBytes: first.byteLength,
    });
    expect(
      runtime.handleMainMessage(chunk('capture-1', arrayBuffer('ignored'), 2, 'video/mp4')),
    ).toBe(false);
    const download = runtime.downloadCaptured(false);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'paused', downloading: true });
    await vi.waitFor(() => expect(standardDownload).toHaveBeenCalledOnce());
    finishSave?.();
    await download;
    expect(runtime.getSnapshot()).toMatchObject({ status: 'paused', downloading: false });
    runtime.resume();
    runtime.handleMainMessage(chunk('capture-1', arrayBuffer('second'), 2, 'video/mp4'));
    expect(runtime.getSnapshot()).toMatchObject({ status: 'capturing', trackCount: 1 });
    expect(runtime.getSnapshot().capturedBytes).toBe(
      first.byteLength + arrayBuffer('second').byteLength,
    );
    const controls = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
    expect(controls).toContainEqual(
      expect.objectContaining({ command: 'pause', sessionId: 'capture-1' }),
    );
    expect(controls).toContainEqual(
      expect.objectContaining({ command: 'resume', sessionId: 'capture-1' }),
    );
    runtime.destroy();
  });

  it('keeps a user pause made while a merge is still running', async () => {
    let finishRemux: ((value: { status: 'completed'; sizeBytes: number }) => void) | undefined;
    const remuxCapturedBlobs = vi.fn(
      () =>
        new Promise<{ status: 'completed'; sizeBytes: number }>((resolve) => {
          finishRemux = resolve;
        }),
    ) as unknown as typeof remuxCapturedBlobsToFile;
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      pickMergeFile: vi.fn(async () => ({ name: 'Paused.mp4' }) as FileSystemFileHandleLike),
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
    });
    runtime.start({ sessionId: 'capture-pause-merge', title: 'Paused' });
    runtime.handleMainMessage(
      chunk('capture-pause-merge', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main'),
    );
    runtime.handleMainMessage(
      chunk('capture-pause-merge', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main'),
    );
    const download = runtime.downloadCaptured(true);
    await vi.waitFor(() => expect(remuxCapturedBlobs).toHaveBeenCalledOnce());
    runtime.pause();
    expect(runtime.getSnapshot()).toMatchObject({ status: 'paused', downloading: true });
    finishRemux?.({ status: 'completed', sizeBytes: 42 });
    await download;
    expect(runtime.getSnapshot()).toMatchObject({ status: 'paused', downloading: false });
    runtime.resume();
    expect(runtime.getSnapshot().status).toBe('capturing');
    runtime.destroy();
  });

  it('keeps captured bytes after an extension-host standard separate save', async () => {
    const createStandardTrackOutput = standardTrackOutputFactory();
    const runtime = new MseCacheCaptureRuntime(document, {
      createStandardTrackOutput,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    runtime.setFilename('我的视频');
    runtime.setClearAfterDownload(true);
    runtime.handleMainMessage(
      chunk('capture-1', arrayBuffer('....ftyp....vide....avc1'), 1, 'video/mp4'),
    );

    await expect(runtime.downloadCaptured()).resolves.toEqual(['我的视频.mp4']);
    expect(runtime.getSnapshot()).toMatchObject({
      capturedBytes: arrayBuffer('....ftyp....vide....avc1').byteLength,
      filename: '我的视频',
      clearAfterDownload: true,
    });
    expect(runtime.getSnapshot().message).toContain('缓存已保留');
    runtime.destroy();
  });

  it('blocks DRM, ignores old encrypted events, and times out instead of capturing forever', async () => {
    vi.useFakeTimers();
    expect(detectMseDrmSignal(new Uint8Array(arrayBuffer('....pssh....')))).toBe('pssh');
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 100 });
    document.dispatchEvent(new Event('encrypted'));
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    expect(runtime.getSnapshot().status).toBe('starting');

    runtime.handleMainMessage(chunk('capture-1', arrayBuffer('....pssh....')));
    expect(runtime.getSnapshot()).toMatchObject({ status: 'blocked_drm', capturedBytes: 0 });
    await expect(runtime.downloadCaptured()).rejects.toThrow(/DRM/u);

    runtime.start({ sessionId: 'capture-2', title: 'Demo' });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'capture-2',
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'error' });
    expect(runtime.getSnapshot().message).toContain('没有收到新的媒体数据');
    runtime.destroy();
  });

  it('stops and resets before binding a different capture session', () => {
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'capture-1', title: 'One' });
    runtime.handleMainMessage(chunk('capture-1', arrayBuffer('first')));
    runtime.start({ sessionId: 'capture-2', title: 'Two' });

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'starting',
      capturedBytes: 0,
      trackCount: 0,
    });
    const controls = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
    expect(controls).toContainEqual(
      expect.objectContaining({ command: 'stop', sessionId: 'capture-1' }),
    );
    expect(controls).toContainEqual(
      expect.objectContaining({ command: 'start', sessionId: 'capture-2' }),
    );
    runtime.destroy();
  });

  it('invalidates the MAIN replay archive when an SPA changes media routes', () => {
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'old-route', title: '旧视频' });
    runtime.handleMainMessage(chunk('old-route', arrayBuffer('old-route-data')));

    runtime.resetForNavigation();

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'idle',
      capturedBytes: 0,
      trackCount: 0,
    });
    const controls = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
    expect(controls).toContainEqual(
      expect.objectContaining({ command: 'stop', sessionId: 'old-route' }),
    );
    expect(controls).toContainEqual(expect.objectContaining({ command: 'reset-route' }));
    runtime.destroy();
  });

  it('caps tracks and exposes clear, minimize, reset, auto-download, and close state', async () => {
    const onUiRequest = vi.fn();
    const onRequestStart = vi.fn(async () => undefined);
    const onRequestResetAndReload = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      onUiRequest,
      onRequestStart,
      onRequestResetAndReload,
    });
    await runtime.requestStart();
    expect(onRequestStart).toHaveBeenCalledOnce();
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    for (let index = 0; index < 9; index += 1) {
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'track',
        sessionId: 'capture-1',
        trackId: `track-${index}`,
        groupId: `source-${index}`,
        mime: 'video/mp4',
      });
    }
    expect(runtime.getSnapshot()).toMatchObject({ status: 'error', trackCount: 8 });

    runtime.start({ sessionId: 'capture-2', title: 'Demo' });
    runtime.handleMainMessage(chunk('capture-2', arrayBuffer('....ftyp....vide....avc1')));
    runtime.hide();
    expect(runtime.getSnapshot().minimized).toBe(true);
    expect(onUiRequest).toHaveBeenLastCalledWith('launcher');
    runtime.show();
    expect(runtime.getSnapshot().minimized).toBe(false);
    expect(onUiRequest).toHaveBeenLastCalledWith('cache');
    runtime.setAutoDownload(true);
    expect(runtime.getSnapshot().autoDownload).toBe(true);
    runtime.setFilename('Custom cache');
    runtime.setClearAfterDownload(true);
    expect(runtime.getSnapshot()).toMatchObject({
      filename: 'Custom cache',
      clearAfterDownload: true,
    });
    runtime.clear();
    expect(runtime.getSnapshot().capturedBytes).toBe(0);
    await runtime.requestResetAndReload();
    expect(onRequestResetAndReload).toHaveBeenCalledOnce();
    runtime.close();
    expect(runtime.getSnapshot().status).toBe('idle');
    runtime.destroy();
  });

  it('auto-downloads only after the captured source ends and the selected media is near its end', async () => {
    let selectedMediaIsNearEnd = false;
    const createStandardTrackOutput = standardTrackOutputFactory();
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      createStandardTrackOutput,
      shouldAutoDownload: () => selectedMediaIsNearEnd,
    });
    runtime.start({ sessionId: 'capture-1', title: 'Demo' });
    runtime.markStartedAtBeginning();
    runtime.setAutoDownload(true);
    runtime.handleMainMessage(
      chunk(
        'capture-1',
        arrayBuffer('....ftyp....vide....avc1'),
        1,
        'video/mp4',
        'track-1',
        'media-source-1',
        { bufferedRanges: [[0, 9.8]], duration: 10 },
      ),
    );

    document.dispatchEvent(new Event('ended', { bubbles: true }));
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'media-source-1',
    });
    await Promise.resolve();
    expect(createStandardTrackOutput).not.toHaveBeenCalled();

    selectedMediaIsNearEnd = true;
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'unrelated-media-source',
    });
    await Promise.resolve();
    expect(createStandardTrackOutput).not.toHaveBeenCalled();

    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'capture-1',
      groupId: 'media-source-1',
    });
    // v0.14.22 must not silently save a single track when a complete pair is unavailable.
    await vi.waitFor(() => expect(runtime.getSnapshot().error).toBeTruthy());
    expect(createStandardTrackOutput).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it('waits for a versioned MAIN acknowledgement and exposes target binding state', async () => {
    vi.useFakeTimers();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const pageUrl = 'https://www.youtube.com/watch?v=ZV-DAQGwK_o';
    const routeKey = mseCacheRouteKeyForUrl(pageUrl);
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      startAckTimeoutMs: 50,
    });
    runtime.start({
      sessionId: 'target-session',
      title: 'Target',
      pageUrl,
      targetSourceUrl: 'blob:https://www.youtube.com/player-target',
      mediaIdentity: { sourceUrl: 'blob:https://www.youtube.com/player-target', mediaEpoch: 4 },
    });

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'starting',
      routeKey,
      waitingForTarget: true,
    });
    expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({
        command: 'start',
        sessionId: 'target-session',
        pageUrl,
        routeKey,
        targetSourceUrl: 'blob:https://www.youtube.com/player-target',
      }),
    );

    expect(
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'started',
        sessionId: 'target-session',
        routeKey,
        hookGeneration: 7,
        waiting: true,
      }),
    ).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'starting',
      hookGeneration: 7,
      waitingForTarget: true,
    });
    expect(
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'binding',
        sessionId: 'target-session',
        routeKey,
        hookGeneration: 7,
        boundGroupId: 'media-source-9',
        waiting: false,
      }),
    ).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      boundGroupId: 'media-source-9',
      waitingForTarget: false,
    });
    await vi.advanceTimersByTimeAsync(51);
    expect(runtime.getSnapshot().status).toBe('capturing');
    runtime.destroy();
  });

  it('requests one controlled reload when a selected blob target cannot be bound', async () => {
    vi.useFakeTimers();
    const onRequestResetAndReload = vi.fn(async () => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      targetBindTimeoutMs: 40,
      onRequestResetAndReload,
    });
    const pageUrl = 'https://www.youtube.com/watch?v=ZV-DAQGwK_o';
    const routeKey = mseCacheRouteKeyForUrl(pageUrl);
    runtime.start({
      sessionId: 'unbound-target',
      title: 'Unbound',
      pageUrl,
      targetSourceUrl: 'blob:https://www.youtube.com/missed-before-hook',
    });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      protocolVersion: 3,
      hookBuildId: 'foxfetch-mse-hook-v3',
      type: 'started',
      sessionId: 'unbound-target',
      routeKey,
      hookGeneration: 2,
      waiting: true,
    });

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'starting',
      waitingForTarget: true,
    });
    await vi.advanceTimersByTimeAsync(41);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'reload_required',
      capturedBytes: 0,
      waitingForTarget: true,
    });
    expect(runtime.getSnapshot().message).toContain('正在刷新页面');
    expect(onRequestResetAndReload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onRequestResetAndReload).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('turns an invalidated extension context into a one-time page recovery', async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    const error = new Error('Extension context invalidated.');
    expect(isExtensionContextInvalidatedError(error)).toBe(true);
    const runtime = new MseCacheCaptureRuntime(document, {
      onRequestStart: vi.fn(async () => {
        throw error;
      }),
      reloadPage,
    });

    await expect(runtime.requestStart()).rejects.toThrow('Extension context invalidated');
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'reload_required',
      capturedBytes: 0,
    });
    expect(runtime.getSnapshot().message).toContain('插件已更新');
    await vi.advanceTimersByTimeAsync(121);
    expect(reloadPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reloadPage).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('fails a start that receives no MAIN acknowledgement', async () => {
    vi.useFakeTimers();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      startAckTimeoutMs: 40,
    });
    runtime.start({ sessionId: 'never-acked', title: 'No hook' });
    expect(runtime.getSnapshot().status).toBe('starting');

    await vi.advanceTimersByTimeAsync(41);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'error' });
    expect(runtime.getSnapshot().message).toContain('未在限定时间内确认启动');
    expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ command: 'stop', sessionId: 'never-acked' }),
    );
    runtime.destroy();
  });

  it('invalidates a route-bound session and rejects late messages from older generations', () => {
    const firstPage = 'https://www.bilibili.com/video/BV1d2tW6NEdK/';
    const secondPage = 'https://www.bilibili.com/video/BV1FJtizWEva';
    const firstRoute = mseCacheRouteKeyForUrl(firstPage);
    const secondRoute = mseCacheRouteKeyForUrl(secondPage);
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'first', title: 'First', pageUrl: firstPage });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'route-reset',
      routeKey: firstRoute,
      hookGeneration: 3,
    });
    expect(runtime.getSnapshot()).toMatchObject({ status: 'starting', hookGeneration: 3 });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'first',
      routeKey: firstRoute,
      hookGeneration: 3,
      waiting: false,
    });
    runtime.handleMainMessage({
      ...chunk('first', arrayBuffer('first-data')),
      routeKey: firstRoute,
      hookGeneration: 3,
    });

    expect(
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'route-reset',
        sessionId: 'first',
        previousRouteKey: firstRoute,
        routeKey: secondRoute,
        hookGeneration: 4,
      }),
    ).toBe(true);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'idle',
      capturedBytes: 0,
      trackCount: 0,
    });

    runtime.start({ sessionId: 'second', title: 'Second', pageUrl: secondPage });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'second',
      routeKey: secondRoute,
      hookGeneration: 4,
      waiting: false,
    });
    expect(
      runtime.handleMainMessage({
        ...chunk('second', arrayBuffer('second-data')),
        routeKey: secondRoute,
        hookGeneration: 4,
      }),
    ).toBe(true);
    expect(
      runtime.handleMainMessage({
        ...chunk('first', arrayBuffer('late-first-data'), 2),
        routeKey: firstRoute,
        hookGeneration: 3,
      }),
    ).toBe(false);
    expect(
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'route-reset',
        sessionId: 'first',
        routeKey: firstRoute,
        hookGeneration: 3,
      }),
    ).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'capturing',
      capturedBytes: arrayBuffer('second-data').byteLength,
      routeKey: secondRoute,
      hookGeneration: 4,
    });
    runtime.destroy();
  });

  it('isolates an old remux completion from a newly selected media session', async () => {
    let finishOldRemux: ((value: { status: 'completed'; sizeBytes: number }) => void) | undefined;
    const remuxCapturedBlobs = vi.fn(
      () =>
        new Promise<{ status: 'completed'; sizeBytes: number }>((resolve) => {
          finishOldRemux = resolve;
        }),
    ) as unknown as typeof remuxCapturedBlobsToFile;
    const handle = {
      name: 'Old.mp4',
      createWritable: vi.fn(),
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandleLike;
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const runtime = new MseCacheCaptureRuntime(document, {
      captureTimeoutMs: 60_000,
      pickMergeFile: vi.fn(async () => handle),
      remuxCapturedBlobs,
      normalizeCapturedTracks: passthroughCapturedTracks,
    });
    runtime.start({ sessionId: 'old', title: 'Old' });
    runtime.handleMainMessage(
      chunk('old', arrayBuffer('old-video'), 1, 'video/mp4', 'old-video', 'old-group'),
    );
    runtime.handleMainMessage(
      chunk('old', arrayBuffer('old-audio'), 2, 'audio/mp4', 'old-audio', 'old-group'),
    );
    runtime.setClearAfterDownload(true);
    const oldDownload = runtime.downloadCaptured(true);
    await vi.waitFor(() => expect(remuxCapturedBlobs).toHaveBeenCalledOnce());

    runtime.resetForMediaChange({
      pageUrl: document.URL,
      sourceUrl: 'blob:https://player.test/new',
      elementId: 'video-2',
      mediaEpoch: 2,
    });
    runtime.start({ sessionId: 'new', title: 'New' });
    const newBytes = arrayBuffer('new-session-only');
    runtime.handleMainMessage(chunk('new', newBytes, 1, 'video/mp4', 'new-video', 'new-group'));
    finishOldRemux?.({ status: 'completed', sizeBytes: 999 });
    await expect(oldDownload).resolves.toEqual(['Old.mp4']);

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'capturing',
      capturedBytes: newBytes.byteLength,
      filename: 'New',
      downloading: false,
    });
    expect(runtime.getSnapshot().tracks).toEqual([
      expect.objectContaining({ id: 'new-video', groupId: 'new-group' }),
    ]);
    expect(runtime.getSnapshot().message).not.toContain('Old.mp4');
    expect(postMessage.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({ command: 'reset-route', force: true }),
    );
    runtime.destroy();
  });

  it('counts bytes and coverage only after the disk store acknowledges persistence', async () => {
    let acknowledge: ((result: MseCacheAppendResult) => void) | undefined;
    const stored: ArrayBuffer[] = [];
    const store: MseCacheChunkStore = {
      kind: 'opfs',
      append: vi.fn(
        (_sessionId: string, _trackId: string, bytes: ArrayBuffer) =>
          new Promise<MseCacheAppendResult>((resolve) => {
            stored.push(bytes);
            acknowledge = resolve;
          }),
      ),
      getBlob: vi.fn(
        async (_sessionId: string, _trackId: string, mime: string, maxBytes?: number) => {
          const blob = new Blob(stored, { type: mime });
          return maxBytes == null ? blob : blob.slice(0, maxBytes, mime);
        },
      ),
      clearSession: vi.fn(async () => undefined),
    };
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'disk-ack', title: 'Disk ack' });
    const media = arrayBuffer('....ftyp....moov....video');
    runtime.handleMainMessage(
      chunk('disk-ack', media, 1, 'video/mp4', 'video', 'main', {
        bufferedRanges: [[0, 10]],
        duration: 10,
      }),
    );

    expect(runtime.getSnapshot()).toMatchObject({
      capturedBytes: 0,
      pendingBytes: media.byteLength,
      cachedSeconds: 0,
    });
    await vi.waitFor(() => expect(store.append).toHaveBeenCalledOnce());
    acknowledge?.({ persistedBytes: media.byteLength });
    await vi.waitFor(() =>
      expect(runtime.getSnapshot()).toMatchObject({
        capturedBytes: media.byteLength,
        pendingBytes: 0,
        cachedSeconds: 10,
      }),
    );
    runtime.destroy();
  });

  it('waits for the final OPFS append before snapshotting a standard separate output', async () => {
    let acknowledge: ((result: MseCacheAppendResult) => void) | undefined;
    const createStandardTrackOutput = standardTrackOutputFactory();
    const store: MseCacheChunkStore = {
      kind: 'opfs',
      append: vi.fn(
        () =>
          new Promise<MseCacheAppendResult>((resolve) => {
            acknowledge = resolve;
          }),
      ),
      getBlob: vi.fn(async () => new Blob()),
      clearSession: vi.fn(async () => undefined),
      createStandardTrackOutput,
    };
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'tail-barrier',
      title: 'Tail barrier',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    const finalChunk = arrayBuffer('....ftyp....moov....final-video-chunk');
    runtime.handleMainMessage(chunk('tail-barrier', finalChunk, 1, 'video/mp4', 'video', 'main'));

    const download = runtime.downloadCaptured(false);
    await vi.waitFor(() => expect(store.append).toHaveBeenCalledOnce());
    expect(createStandardTrackOutput).not.toHaveBeenCalled();
    acknowledge?.({ persistedBytes: finalChunk.byteLength });

    await expect(download).resolves.toEqual(['Tail barrier.mp4']);
    expect(createStandardTrackOutput).toHaveBeenCalledWith(
      'tail-barrier',
      [
        {
          trackId: 'video',
          mime: 'video/mp4',
          maxBytes: finalChunk.byteLength,
          firstSequence: 1,
        },
      ],
      expect.stringMatching(/^standard-\d+-video-/u),
      'video',
    );
    runtime.destroy();
  });

  it('submits verified standard cache outputs through the extension host directory', async () => {
    const standardDownload = vi.fn(async (_filename: string) => undefined);
    const createStandardTrackOutput = standardTrackOutputFactory((filename) =>
      standardDownload(filename),
    );
    const saveBlob = vi.fn(async () => undefined);
    const store: MseCacheChunkStore = {
      kind: 'opfs',
      append: (_sessionId, _trackId, bytes) => ({ persistedBytes: bytes.byteLength }),
      getBlob: vi.fn(async () => new Blob()),
      clearSession: vi.fn(async () => undefined),
      createStandardTrackOutput,
    };
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      saveBlob,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'host-download',
      title: '测试视频_哔哩哔哩_bilibili-cache',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    const media = arrayBuffer('....ftyp....moov....video');
    runtime.handleMainMessage(chunk('host-download', media, 1, 'video/mp4', 'video', 'main'));
    await vi.waitFor(() => expect(runtime.getSnapshot().capturedBytes).toBe(media.byteLength));

    await expect(runtime.downloadCaptured(false)).resolves.toEqual(['测试视频.mp4']);
    expect(createStandardTrackOutput).toHaveBeenCalledWith(
      'host-download',
      [
        {
          trackId: 'video',
          mime: 'video/mp4',
          maxBytes: media.byteLength,
          firstSequence: 1,
        },
      ],
      expect.stringMatching(/^standard-\d+-video-/u),
      'video',
    );
    expect(standardDownload).toHaveBeenCalledWith('FoxFetch/Bilibili/测试视频.mp4');
    expect(saveBlob).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it('keeps a verified MP4 when the sibling MP3 conversion fails', async () => {
    const videoDownload = vi.fn(async () => undefined);
    const createStandardTrackOutput = vi.fn(
      async (
        _sessionId: string,
        _parts: readonly {
          trackId: string;
          mime: string;
          maxBytes: number;
          firstSequence: number;
        }[],
        _outputId: string,
        kind: 'video' | 'audio',
      ) => {
        if (kind === 'audio') throw new Error('AAC decoder unavailable');
        return completedStandardTrackOutput('video', videoDownload);
      },
    );
    const runtime = new MseCacheCaptureRuntime(document, {
      createStandardTrackOutput,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'partial-standard',
      title: 'Partial',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    runtime.handleMainMessage(
      chunk('partial-standard', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main'),
    );
    runtime.handleMainMessage(
      chunk('partial-standard', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main'),
    );

    await expect(runtime.downloadCaptured(false)).resolves.toEqual(['Partial.mp4']);
    expect(videoDownload).toHaveBeenCalledWith('FoxFetch/Bilibili/Partial.mp4');
    const snapshot = runtime.getSnapshot();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.message).toMatch(/音频 MP3.*AAC decoder unavailable/u);
    runtime.destroy();
  });

  it('fences a late write failure from data cleared in the same session', async () => {
    const writes: Array<{
      bytes: ArrayBuffer;
      resolve: (result: MseCacheAppendResult) => void;
      reject: (error: Error) => void;
    }> = [];
    const clearSession = vi.fn(async () => undefined);
    const store: MseCacheChunkStore = {
      kind: 'opfs',
      append: vi.fn(
        (_sessionId: string, _trackId: string, bytes: ArrayBuffer) =>
          new Promise<MseCacheAppendResult>((resolve, reject) => {
            writes.push({ bytes, resolve, reject });
          }),
      ),
      getBlob: vi.fn(async () => new Blob()),
      clearSession,
    };
    const runtime = new MseCacheCaptureRuntime(document, {
      chunkStore: store,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'same-session', title: 'Generation fence' });
    runtime.handleMainMessage(chunk('same-session', arrayBuffer('old'), 1));
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    runtime.clear();
    runtime.handleMainMessage(chunk('same-session', arrayBuffer('fresh'), 2));
    writes[0]!.reject(new Error('late stale failure'));
    await vi.waitFor(() => expect(clearSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.resolve({ persistedBytes: writes[1]!.bytes.byteLength });

    await vi.waitFor(() =>
      expect(runtime.getSnapshot()).toMatchObject({
        status: 'capturing',
        capturedBytes: arrayBuffer('fresh').byteLength,
        pendingBytes: 0,
      }),
    );
    expect(runtime.getSnapshot().error).toBeUndefined();
    runtime.destroy();
  });

  it('requires a persisted initialization segment before declaring a group complete', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'requires-init', title: 'Requires init' });
    runtime.markStartedAtBeginning();
    const fullCoverage = {
      initialization: false,
      bufferedRanges: [[0, 10]],
      duration: 10,
    };
    runtime.handleMainMessage(
      chunk(
        'requires-init',
        arrayBuffer('video-media'),
        1,
        'video/mp4',
        'video',
        'main',
        fullCoverage,
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'requires-init',
        arrayBuffer('audio-media'),
        2,
        'audio/mp4',
        'audio',
        'main',
        fullCoverage,
      ),
    );
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'requires-init',
      groupId: 'main',
    });

    expect(runtime.getSnapshot()).toMatchObject({
      isComplete: false,
      completeGroupIds: [],
      tracks: [
        expect.objectContaining({ initPresent: false }),
        expect.objectContaining({ initPresent: false }),
      ],
    });
    runtime.destroy();
  });

  it('uses the player-bound MediaSource for progress even when another source is larger', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({
      sessionId: 'bound-source',
      title: 'Bound source',
      targetSourceUrl: 'blob:https://example.test/player',
    });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'bound-source',
      boundGroupId: 'selected',
      waiting: false,
    });
    runtime.handleMainMessage(
      chunk('bound-source', arrayBuffer('selected'), 1, 'video/mp4', 'selected-video', 'selected', {
        bufferedRanges: [[0, 5]],
        duration: 10,
        unsafeTimelineReason: 'timestamp-offset',
      }),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-source',
        arrayBuffer('selected-audio'),
        2,
        'audio/mp4',
        'selected-audio',
        'selected',
        { bufferedRanges: [[0, 5]], duration: 10 },
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-source',
        arrayBuffer('a-much-larger-unrelated-source'),
        3,
        'video/mp4',
        'other-video',
        'other',
        { bufferedRanges: [[0, 30]], duration: 30 },
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-source',
        arrayBuffer('a-much-larger-unrelated-audio-source'),
        4,
        'audio/mp4',
        'other-audio',
        'other',
        { bufferedRanges: [[0, 30]], duration: 30 },
      ),
    );

    expect(runtime.getSnapshot()).toMatchObject({
      boundGroupId: 'selected',
      progressGroupId: 'selected',
      cachedSeconds: 5,
      totalSeconds: 10,
      canMerge: false,
      mergeBlockReason: expect.stringMatching(/timestamp-offset|时间线/u),
    });
    runtime.destroy();
  });

  it('exports only the player-bound source when unrelated cache groups are present', async () => {
    const createStandardTrackOutput = standardTrackOutputFactory();
    const runtime = new MseCacheCaptureRuntime(document, {
      createStandardTrackOutput,
      captureTimeoutMs: 60_000,
    });
    runtime.start({
      sessionId: 'bound-export',
      title: 'Bound export',
      targetSourceUrl: 'blob:https://example.test/player',
      pageUrl: 'https://www.bilibili.com/video/BV1test',
    });
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'started',
      sessionId: 'bound-export',
      boundGroupId: 'selected',
      waiting: false,
    });
    runtime.handleMainMessage(
      chunk(
        'bound-export',
        arrayBuffer('selected-video'),
        1,
        'video/mp4',
        'selected-video',
        'selected',
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-export',
        arrayBuffer('selected-audio'),
        2,
        'audio/mp4',
        'selected-audio',
        'selected',
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-export',
        arrayBuffer('larger-unrelated-video'),
        3,
        'video/mp4',
        'other-video',
        'other',
      ),
    );
    runtime.handleMainMessage(
      chunk(
        'bound-export',
        arrayBuffer('larger-unrelated-audio'),
        4,
        'audio/mp4',
        'other-audio',
        'other',
      ),
    );

    await expect(runtime.downloadCaptured(false)).resolves.toEqual([
      'Bound export.mp4',
      'Bound export.mp3',
    ]);
    expect(createStandardTrackOutput).toHaveBeenCalledTimes(2);
    expect(
      createStandardTrackOutput.mock.calls.map((call) => call[1].map((part) => part.trackId)),
    ).toEqual([['selected-video'], ['selected-audio']]);
    runtime.destroy();
  });

  it('blocks automatic merging after a timeline-event but keeps separate saves available', async () => {
    const createStandardTrackOutput = standardTrackOutputFactory();
    const runtime = new MseCacheCaptureRuntime(document, {
      createStandardTrackOutput,
      normalizeCapturedTracks: passthroughCapturedTracks,
      captureTimeoutMs: 60_000,
    });
    runtime.start({ sessionId: 'unsafe-event', title: 'Unsafe event' });
    runtime.handleMainMessage(
      chunk('unsafe-event', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main'),
    );
    runtime.handleMainMessage(
      chunk('unsafe-event', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main'),
    );
    expect(runtime.getSnapshot().canMerge).toBe(true);

    expect(
      runtime.handleMainMessage({
        channel: 'foxfetch:mse-cache:v1',
        direction: 'main-to-agent',
        type: 'timeline-event',
        sessionId: 'unsafe-event',
        trackId: 'video',
        groupId: 'main',
        mime: 'video/mp4',
        unsafeTimelineReason: 'remove',
      }),
    ).toBe(true);

    expect(runtime.getSnapshot()).toMatchObject({
      canMerge: false,
      mergeBlockReason: expect.stringMatching(/remove|时间线/u),
      groups: [expect.objectContaining({ unsafeTimelineReasons: ['remove'] })],
      tracks: expect.arrayContaining([
        expect.objectContaining({ id: 'video', unsafeTimelineReasons: ['remove'] }),
        expect.objectContaining({ id: 'audio', unsafeTimelineReasons: ['remove'] }),
      ]),
    });
    await expect(runtime.downloadCaptured(true)).rejects.toThrow(/时间线|错位/u);
    await expect(runtime.downloadCaptured(false)).resolves.toEqual([
      'Unsafe event.mp4',
      'Unsafe event.mp3',
    ]);
    expect(createStandardTrackOutput).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  it('propagates source-ended timeline failures to every track in the group', () => {
    const runtime = new MseCacheCaptureRuntime(document, { captureTimeoutMs: 60_000 });
    runtime.start({ sessionId: 'unsafe-ended', title: 'Unsafe ended' });
    runtime.handleMainMessage(
      chunk('unsafe-ended', arrayBuffer('video'), 1, 'video/mp4', 'video', 'main'),
    );
    runtime.handleMainMessage(
      chunk('unsafe-ended', arrayBuffer('audio'), 2, 'audio/mp4', 'audio', 'main'),
    );
    runtime.handleMainMessage({
      channel: 'foxfetch:mse-cache:v1',
      direction: 'main-to-agent',
      type: 'source-ended',
      sessionId: 'unsafe-ended',
      groupId: 'main',
      unsafeTimelineReasons: ['end-of-stream-error'],
    });

    expect(runtime.getSnapshot()).toMatchObject({
      canMerge: false,
      groups: [
        expect.objectContaining({
          sourceEnded: true,
          unsafeTimelineReasons: ['end-of-stream-error'],
        }),
      ],
      tracks: [
        expect.objectContaining({ unsafeTimelineReasons: ['end-of-stream-error'] }),
        expect.objectContaining({ unsafeTimelineReasons: ['end-of-stream-error'] }),
      ],
    });
    runtime.destroy();
  });
});
