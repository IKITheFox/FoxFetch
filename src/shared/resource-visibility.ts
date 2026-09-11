import type { MediaAsset } from './types';

/** Unresolved detector records remain available internally, never as download cards. */
export function isUnresolvedVideoPlaceholder(asset: MediaAsset): boolean {
  return (
    asset.kind === 'video' &&
    !asset.downloadable &&
    asset.url.startsWith('blob:') &&
    asset.detectedBy.includes('dom') &&
    (asset.presentationRole === 'unresolved-video' || (!asset.mime && !asset.extension))
  );
}
