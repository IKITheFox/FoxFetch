import { describe, it, expect } from 'vitest';
import {
  referenceInlineImage,
  readInlineImage,
  stripPersistedImageBody,
} from '../../src/modules/detector/inline-images';
import { scanDocument } from '../../src/modules/detector/media-detector';
import type { MediaAsset } from '../../src/shared/types';

function asset(url: string): MediaAsset {
  return {
    id: 'image-one',
    kind: 'image',
    url,
    pageUrl: document.URL,
    pageTitle: 'test',
    frameId: 0,
    discoveredAt: 1,
    detectedBy: ['dom'],
    downloadable: true,
  };
}

describe('page-local inline images', () => {
  it('keeps multi-megabyte bodies out of snapshots and retrieves the exact original', async () => {
    const doc = document.implementation.createHTMLDocument('large');
    const raw = asset('data:image/png;base64,' + 'A'.repeat(5_521_750));
    const light = referenceInlineImage(raw, doc);
    expect(light.url).toBe('');
    expect(JSON.stringify(light).length).toBeLessThan(1000);
    expect(referenceInlineImage(raw, doc).inlineImage).toEqual(light.inlineImage);
    expect(await readInlineImage(doc, light.inlineImage!.token, doc.URL, false, () => [raw])).toBe(
      raw.url,
    );
  });

  it('rejects missing, changed and cross-document source content', async () => {
    const doc = document.implementation.createHTMLDocument('owner');
    const raw = asset('data:image/png;base64,AAAA');
    const ref = referenceInlineImage(raw, doc).inlineImage!;
    await expect(readInlineImage(doc, ref.token, doc.URL, false, () => [])).rejects.toThrow();
    await expect(
      readInlineImage(doc, ref.token, doc.URL, false, () => [
        { ...raw, url: 'data:image/png;base64,BBBB' },
      ]),
    ).rejects.toThrow();
    await expect(
      readInlineImage(document, ref.token, document.URL, false, () => [raw]),
    ).rejects.toThrow();
  });

  it('migrates legacy image bodies without touching video credentials or capture data', () => {
    const old = asset('data:image/png;base64,AAAA');
    expect(stripPersistedImageBody(old)).toMatchObject({
      url: '',
      downloadable: false,
      inlineImage: { token: '' },
    });
    expect(old.url).toContain('AAAA');
    const video: MediaAsset = {
      ...old,
      kind: 'video',
      url: 'https://cdn.test/?signature=secret',
      requestHeaders: { authorization: 'secret' },
    };
    expect(stripPersistedImageBody(video)).toBe(video);
  });

  it('publishes lightweight scan results but permits explicit internal original reads', () => {
    const doc = document.implementation.createHTMLDocument('scan');
    doc.body.innerHTML = '<img src="data:image/png;base64,AAAA">';
    const published = scanDocument(doc);
    expect(published[0]?.inlineImage?.token).toBeTruthy();
    expect(published[0]?.url).toBe('');
    expect(scanDocument(doc, { inlineImageBodies: true })[0]?.url).toContain('AAAA');
  });
});
