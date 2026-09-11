import { describe, expect, it, vi } from 'vitest';
import {
  createGuardedFetchInspector,
  detectIsoBmffDrm,
  detectManifestDrm,
  preflightSeparateTracks,
  recommendContainer,
  signalsFromInternalCodecId,
} from '../../src/modules/merge';

describe('merge container policy', () => {
  it('selects MP4 for AVC and AAC', () => {
    expect(recommendContainer('avc', 'aac')).toMatchObject({
      supported: true,
      container: 'mp4',
      compatibility: 'broad',
    });
  });

  it('selects WebM for VP9 and Opus', () => {
    expect(recommendContainer('vp9', 'opus')).toMatchObject({
      supported: true,
      container: 'webm',
      extension: '.webm',
    });
  });

  it('rejects a requested incompatible container instead of transcoding', () => {
    expect(recommendContainer('vp9', 'opus', 'mp4')).toMatchObject({
      supported: false,
      compatibility: 'unsupported',
    });
  });

  it('rejects codecs that the V1 MKV writer cannot packet-copy', () => {
    expect(recommendContainer('avc', 'alaw')).toMatchObject({
      supported: false,
      compatibility: 'unsupported',
    });
  });
});

describe('DRM gate', () => {
  it('returns a large cloned media response without waiting on the untouched branch', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
    });
    const inspector = createGuardedFetchInspector({
      fetchFn: vi.fn(async () =>
        Promise.resolve(
          new Response(stream, {
            headers: { 'content-type': 'video/mp4' },
          }),
        ),
      ),
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('guarded fetch deadlocked')), 250);
    });
    const response = await Promise.race([
      inspector.fetch('https://media.example/large.mp4'),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));

    expect(response.ok).toBe(true);
    await response.body?.cancel();
  });

  it('blocks encrypted HLS while allowing METHOD=NONE', () => {
    expect(detectManifestDrm('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"')).toContain(
      'hls-key',
    );
    expect(detectManifestDrm('#EXTM3U\n#EXT-X-KEY:METHOD=NONE')).toEqual([]);
  });

  it('detects DASH ContentProtection, PSSH and default_KID', () => {
    const signals = detectManifestDrm(`
      <MPD xmlns:cenc="urn:mpeg:cenc:2013">
        <ContentProtection cenc:default_KID="abc"><cenc:pssh>AA==</cenc:pssh></ContentProtection>
      </MPD>
    `);
    expect(signals).toEqual(
      expect.arrayContaining(['dash-content-protection', 'dash-default-kid', 'dash-pssh']),
    );
  });

  it('detects encrypted MP4 sample entry IDs', () => {
    expect(signalsFromInternalCodecId('encv')).toEqual(['mp4-encrypted-video-entry']);
    expect(signalsFromInternalCodecId('enca')).toEqual(['mp4-encrypted-audio-entry']);
  });

  it('uses MP4Box to detect a parsed pssh box', async () => {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 32);
    bytes.set(new TextEncoder().encode('pssh'), 4);
    // version/flags + 16-byte system ID are zeroed; data_size is also zero.
    view.setUint32(28, 0);

    await expect(detectIsoBmffDrm([{ bytes: bytes.buffer, fileStart: 0 }])).resolves.toContain(
      'mp4-pssh',
    );
  });

  it('rejects declared DRM before performing a network request', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const capability = await preflightSeparateTracks(
      {
        video: { url: 'https://media.example/video.mp4' },
        audio: { url: 'https://media.example/audio.m4a' },
        drmSignals: ['eme'],
      },
      { fetchFn },
    );

    expect(capability).toMatchObject({
      status: 'blocked',
      canMerge: false,
      canDownloadSeparately: false,
      failure: { code: 'DRM_PROTECTED' },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
