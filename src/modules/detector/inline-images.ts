import type { MediaAsset } from '../../shared/types';
import { inlineImageDigest } from './inline-image-digest';

const pools = new WeakMap<
  Document,
  { pageUrl: string; entries: Map<string, { length: number; id: string; digest: Promise<string> }> }
>();

async function digest(url: string): Promise<string> {
  return inlineImageDigest(url);
}

function pool(doc: Document) {
  let value = pools.get(doc);
  if (!value || value.pageUrl !== doc.URL) {
    value = { pageUrl: doc.URL, entries: new Map() };
    pools.set(doc, value);
  }
  return value;
}

/** Bodies stay in the originating content script, never in resource snapshots. */
export function referenceInlineImage(asset: MediaAsset, doc: Document): MediaAsset {
  if (asset.kind !== 'image' || !/^data:image\//i.test(asset.url))
    return stripPersistedImageBody(asset);
  const value = pool(doc);
  let token = [...value.entries].find(
    ([, entry]) => entry.id === asset.id && entry.length === asset.url.length,
  )?.[0];
  if (!token) {
    if (value.entries.size >= 1000) value.entries.delete(value.entries.keys().next().value!);
    token = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    // Only the digest survives. The original body is rediscovered in the page on demand.
    value.entries.set(token, {
      id: asset.id,
      length: asset.url.length,
      digest: digest(asset.url).catch(() => ''),
    });
  }
  const result = {
    ...asset,
    url: '',
    inlineImage: { token, pageUrl: doc.URL },
    downloadable: true,
  };
  delete result.poster;
  return result;
}

export async function readInlineImage(
  doc: Document,
  token: string,
  pageUrl: string,
  preview: boolean,
  scan: () => MediaAsset[],
): Promise<string> {
  const entry = pool(doc).entries.get(token);
  if (pageUrl !== doc.URL || !entry) throw new Error('图片引用已失效，请重新扫描原页面。');
  const original = scan().find(
    (asset) => asset.id === entry.id && asset.kind === 'image' && asset.url.length === entry.length,
  );
  if (
    !original ||
    !/^data:image\//i.test(original.url) ||
    (await digest(original.url)) !== (await entry.digest) ||
    pageUrl !== doc.URL
  ) {
    throw new Error('原图片已变化或不在页面中，请重新扫描。');
  }
  if (!preview) return original.url;
  const img = new Image();
  img.src = original.url;
  await img.decode();
  const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const thumbnail = canvas.toDataURL('image/webp', 0.8);
  if (thumbnail.length > 128 * 1024) throw new Error('缩略图过大，仍可下载原图。');
  return thumbnail;
}

/** Legacy bodies cannot be rebound without the originating document. Fail closed until rescan. */
export function stripPersistedImageBody(asset: MediaAsset): MediaAsset {
  let next = asset;
  if (asset.kind === 'image' && /^data:image\//i.test(asset.url)) {
    next = {
      ...asset,
      url: '',
      inlineImage: { token: '', pageUrl: asset.pageUrl },
      downloadable: false,
    };
  }
  if (next.poster?.startsWith('data:')) {
    next = { ...next };
    delete next.poster;
  }
  return next;
}
