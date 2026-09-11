import { describe, expect, it } from 'vitest';
import {
  basenameFromPath,
  clampRate,
  classifyMedia,
  extensionFromMime,
  extensionFromUrl,
  filenameFromUrl,
  formatBytes,
  mergeMediaAssets,
  sanitizeFilename,
  stableId,
} from '../../src/shared/utils';
import type { MediaAsset } from '../../src/shared/types';

describe('shared media utilities', () => {
  it('classifies common URLs and manifest MIME types', () => {
    expect(classifyMedia('https://cdn.example/video.mp4?token=abc')).toBe('video');
    expect(classifyMedia('https://cdn.example/audio.opus')).toBe('audio');
    expect(classifyMedia('https://cdn.example/image.avif')).toBe('image');
    expect(classifyMedia('https://cdn.example/master', 'application/vnd.apple.mpegurl')).toBe(
      'playlist',
    );
  });

  it('keeps signed query parameters out of extension parsing', () => {
    expect(extensionFromUrl('https://cdn.example/path/movie.webm?x=.mp4&token=1')).toBe('webm');
  });

  it('derives extensions from MIME types and strips local download paths', () => {
    expect(extensionFromMime('audio/mp4; charset=binary')).toBe('m4a');
    expect(extensionFromMime('audio/webm')).toBe('webm');
    expect(extensionFromMime('application/vnd.apple.mpegurl')).toBe('m3u8');
    expect(extensionFromMime('application/octet-stream')).toBeUndefined();
    expect(basenameFromPath('C:\\Users\\Alice\\Downloads\\clip (1).mp4')).toBe('clip (1).mp4');
    expect(basenameFromPath('/home/alice/clip.webm')).toBe('clip.webm');
  });

  it('keeps MIME-derived extensions when a later URL suffix is less reliable', () => {
    const base: MediaAsset = {
      id: 'audio',
      url: 'https://cdn.example/track.bin',
      pageUrl: 'https://example.com/watch',
      pageTitle: 'Watch',
      frameId: 0,
      kind: 'audio',
      detectedBy: ['network'],
      mime: 'audio/aac',
      extension: 'aac',
      downloadable: true,
      discoveredAt: 2,
      lastObservedAt: 20,
    };
    const merged = mergeMediaAssets(base, {
      id: base.id,
      url: base.url,
      pageUrl: base.pageUrl,
      pageTitle: base.pageTitle,
      frameId: base.frameId,
      kind: base.kind,
      detectedBy: ['dom'],
      extension: 'bin',
      downloadable: true,
      discoveredAt: 3,
      lastObservedAt: 30,
    });

    expect(merged).toMatchObject({
      mime: 'audio/aac',
      extension: 'aac',
      detectedBy: ['network', 'dom'],
      discoveredAt: 2,
      lastObservedAt: 30,
    });
  });

  it('sanitizes Windows-incompatible filenames', () => {
    expect(sanitizeFilename(' A<B>:C/?.mp4 ')).toBe('A-B--C--.mp4');
    expect(filenameFromUrl('https://cdn.example/My%20Video.mp4?token=1', 'video')).toBe(
      'My Video.mp4',
    );
  });

  it('produces deterministic ids and clamps rates', () => {
    expect(stableId('same')).toBe(stableId('same'));
    expect(stableId('same')).not.toBe(stableId('different'));
    expect(clampRate(99)).toBe(16);
    expect(clampRate(0)).toBe(0.0625);
    expect(clampRate(1.256)).toBe(1.26);
  });

  it('formats file sizes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(undefined)).toBe('大小未知');
  });
});
