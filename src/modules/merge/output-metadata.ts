import type {
  MergeCoverMimeType,
  MergeMediaMetadataRequest,
  ResolvedMergeMediaMetadata,
} from './types';
import { createTimedMergeFetch } from './runtime-control';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_BYTES = 1024 * 1024;
const MAX_EDGE = 1280;
const MAX_TITLE_LENGTH = 512;

interface MetadataResolveDependencies {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  createImageBitmap?: typeof globalThis.createImageBitmap;
  createCanvas?: (width: number, height: number) => OffscreenCanvas;
}

function cleanTitle(value: string | undefined): string | undefined {
  const title = value
    ?.replaceAll('\u0000', ' ')
    .replace(/[\r\n]+/gu, ' ')
    .trim();
  return title ? title.slice(0, MAX_TITLE_LENGTH) : undefined;
}

function normalizedHttpUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 16_384) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function imageMimeFromBytes(bytes: Uint8Array): MergeCoverMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return undefined;
}

function isConvertibleImage(bytes: Uint8Array): boolean {
  const webp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  const brand = bytes.length >= 12 ? String.fromCharCode(...bytes.subarray(4, 12)) : '';
  return webp || brand.startsWith('ftypavif') || brand.startsWith('ftypavis');
}

async function readBoundedResponse(response: Response): Promise<Uint8Array | undefined> {
  if (!response.ok || response.type === 'opaque') return undefined;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) return undefined;

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= MAX_SOURCE_BYTES ? bytes : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function convertToJpeg(
  bytes: Uint8Array,
  responseMimeType: string,
  dependencies: MetadataResolveDependencies,
): Promise<Uint8Array | undefined> {
  const createBitmap = dependencies.createImageBitmap ?? globalThis.createImageBitmap;
  const Canvas = globalThis.OffscreenCanvas;
  const createCanvas =
    dependencies.createCanvas ??
    (Canvas ? (width: number, height: number) => new Canvas(width, height) : undefined);
  if (!createBitmap || !createCanvas) return undefined;

  const bitmapBytes = new Uint8Array(bytes.byteLength);
  bitmapBytes.set(bytes);
  const bitmap = await createBitmap(
    new Blob([bitmapBytes.buffer], { type: responseMimeType || 'image/webp' }),
  );
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.86, 0.76, 0.66]) {
      const converted = new Uint8Array(
        await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer(),
      );
      if (converted.byteLength <= MAX_EMBEDDED_BYTES) return converted;
    }
    return undefined;
  } finally {
    bitmap.close();
  }
}

/**
 * Resolves optional cover art without credentials and fails soft. Media output
 * remains downloadable when a poster is unavailable, oversized, or malformed.
 */
export async function resolveMergeMediaMetadata(
  request: MergeMediaMetadataRequest | undefined,
  dependencies: MetadataResolveDependencies = {},
): Promise<ResolvedMergeMediaMetadata | undefined> {
  const title = cleanTitle(request?.title);
  const coverUrl = normalizedHttpUrl(request?.coverUrl);
  if (!coverUrl) return title ? { title } : undefined;

  try {
    const fetchImpl = createTimedMergeFetch(
      dependencies.fetch ?? globalThis.fetch,
      dependencies.signal,
    );
    const response = await fetchImpl(coverUrl, {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });
    const finalUrl = normalizedHttpUrl(response.url || coverUrl);
    if (!finalUrl) return title ? { title } : undefined;
    const bytes = await readBoundedResponse(response);
    if (!bytes || bytes.byteLength === 0) return title ? { title } : undefined;

    const nativeMimeType = imageMimeFromBytes(bytes);
    if (nativeMimeType && bytes.byteLength <= MAX_EMBEDDED_BYTES) {
      return { ...(title ? { title } : {}), cover: { data: bytes, mimeType: nativeMimeType } };
    }

    const responseMimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (nativeMimeType || isConvertibleImage(bytes)) {
      const jpeg = await convertToJpeg(bytes, responseMimeType, dependencies);
      if (jpeg) {
        return { ...(title ? { title } : {}), cover: { data: jpeg, mimeType: 'image/jpeg' } };
      }
    }
  } catch {
    // Cover art is useful metadata, but must never invalidate a verified media output.
  }
  return title ? { title } : undefined;
}
