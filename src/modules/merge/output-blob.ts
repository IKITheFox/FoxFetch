import { mergeError } from './errors';
import type { CompletedRemux, MergeContainer } from './types';

const CONTAINER_METADATA = {
  mp4: { extension: '.mp4', mimeType: 'video/mp4' },
  webm: { extension: '.webm', mimeType: 'video/webm' },
  mkv: { extension: '.mkv', mimeType: 'video/x-matroska' },
} as const satisfies Record<
  MergeContainer,
  { extension: CompletedRemux['plan']['extension']; mimeType: CompletedRemux['plan']['mimeType'] }
>;

function hasMp4Signature(header: Uint8Array): boolean {
  return (
    header.byteLength >= 8 &&
    header[4] === 0x66 &&
    header[5] === 0x74 &&
    header[6] === 0x79 &&
    header[7] === 0x70
  );
}

function hasEbmlSignature(header: Uint8Array): boolean {
  return (
    header.byteLength >= 4 &&
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3
  );
}

/**
 * Re-establish the verified container MIME at the native-download boundary.
 *
 * OPFS derives a File's type from its private temporary filename. The merge
 * host intentionally uses a `.partial` name, which Chromium can expose as
 * `text/plain`; passing that File directly to createObjectURL makes Chrome
 * replace a requested `.mp4` filename with `.txt`. Blob.slice changes only
 * metadata and keeps the OPFS-backed bytes without rebuilding the media in
 * memory.
 */
export async function prepareVerifiedMergeDownloadBlob(
  file: Blob,
  result: CompletedRemux,
): Promise<Blob> {
  const metadata = CONTAINER_METADATA[result.plan.container];
  if (
    !metadata ||
    result.plan.extension !== metadata.extension ||
    result.plan.mimeType !== metadata.mimeType
  ) {
    throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '合并结果的容器、扩展名与 MIME 类型不一致。');
  }

  if (
    !Number.isSafeInteger(result.verification.sizeBytes) ||
    result.verification.sizeBytes <= 0 ||
    file.size !== result.verification.sizeBytes
  ) {
    throw mergeError('OUTPUT_SIZE_MISMATCH', '合并输出大小与验证结果不一致。');
  }

  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const validSignature =
    result.plan.container === 'mp4' ? hasMp4Signature(header) : hasEbmlSignature(header);
  if (!validSignature) {
    throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '合并输出的文件头与目标容器不一致。');
  }

  const typed = file.slice(0, file.size, metadata.mimeType);
  if (typed.size !== file.size || typed.type !== metadata.mimeType) {
    throw mergeError('OUTPUT_SIGNATURE_MISMATCH', '无法为已验证媒体建立正确的下载 MIME 类型。');
  }
  return typed;
}
