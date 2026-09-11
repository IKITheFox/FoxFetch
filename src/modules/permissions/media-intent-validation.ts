import { sameActiveMediaIdentity } from '../playback/playback-manager';
import type {
  MediaAsset,
  PermissionGatedMediaAction,
  PermissionGatedMediaIntent,
  TabMediaState,
} from '../../shared/types';
import { FULL_MEDIA_ACCESS_PERMISSIONS } from './media-access';
import { permissionOriginsForUrls } from './permission-request';

function normalized(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function samePermissionBundle(
  left: chrome.permissions.Permissions | undefined,
  right: chrome.permissions.Permissions,
): boolean {
  return (
    JSON.stringify(normalized(left?.permissions)) ===
      JSON.stringify(normalized(right.permissions)) &&
    JSON.stringify(normalized(left?.origins)) === JSON.stringify(normalized(right.origins))
  );
}

/** Recheck the route and player generation immediately before any side effect. */
export function assertPermissionMediaContext(
  state: TabMediaState | undefined,
  currentPageUrl: string,
  action: PermissionGatedMediaAction,
): asserts state is TabMediaState {
  if (!state || state.pageUrl !== currentPageUrl) {
    throw new Error('页面已切换，已取消过期的媒体操作');
  }
  if (!action.expectedPageUrl || action.expectedPageUrl !== state.pageUrl) {
    throw new Error('页面已切换，已取消过期的媒体操作');
  }
  if (action.expectedMediaEpoch == null || action.expectedMediaEpoch !== (state.mediaEpoch ?? 0)) {
    throw new Error('播放器已切换，已取消过期的媒体操作');
  }
  if (
    action.expectedMedia &&
    !sameActiveMediaIdentity(action.expectedMedia, state.activeMedia, true)
  ) {
    throw new Error('播放器已切换，已取消过期的媒体操作');
  }
}

function exactAssets(
  state: TabMediaState,
  assetIds: readonly string[],
  requireDownloadable: boolean,
): MediaAsset[] {
  const uniqueIds = [...new Set(assetIds)];
  if (uniqueIds.length === 0 || uniqueIds.length !== assetIds.length) {
    throw new Error('所选媒体资源无效，请刷新列表后重试');
  }
  const selected = uniqueIds.map((assetId) => state.assets.find((asset) => asset.id === assetId));
  if (
    selected.some(
      (asset) =>
        !asset || asset.pageUrl !== state.pageUrl || (requireDownloadable && !asset.downloadable),
    )
  ) {
    throw new Error('所选媒体已变化，请刷新列表后重试');
  }
  return selected as MediaAsset[];
}

export function validatePermissionActionAssets(
  state: TabMediaState,
  action: PermissionGatedMediaAction,
): MediaAsset[] {
  if (action.kind === 'download-assets') {
    return exactAssets(state, action.assetIds, true);
  }
  if (action.kind === 'capture-source') {
    const [asset] = exactAssets(state, [action.blobAssetId], false);
    if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) {
      throw new Error('真实源媒体已变化，请刷新列表后重试');
    }
    return [asset];
  }
  return [];
}

export interface PermissionContainsApi {
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>;
}

/**
 * Direct background download messages are a compatibility path for callers
 * that already hold the exact source grants. Keep them fail-closed instead of
 * allowing a caller to skip the durable permission-intent protocol.
 */
export function assertDirectMediaDownloadContext(
  state: TabMediaState | undefined,
  currentPageUrl: string,
  action: PermissionGatedMediaAction,
): asserts state is TabMediaState {
  if (!action.expectedPageUrl || action.expectedMediaEpoch == null) {
    throw new Error('下载请求缺少页面或播放器校验信息，请重新点击下载');
  }
  assertPermissionMediaContext(state, currentPageUrl, action);
}

/** Require exact grants only for network sources; local/non-network inputs keep their safe path. */
export async function assertDirectMediaAssetPermissions(
  assets: readonly MediaAsset[],
  permissionsApi: PermissionContainsApi = chrome.permissions,
): Promise<void> {
  const networkAssets = assets.filter((asset) => /^https?:\/\//iu.test(asset.url));
  if (networkAssets.length === 0) return;
  const required = narrowMediaPermissions(networkAssets);
  const granted = await permissionsApi.contains(required).catch(() => false);
  if (!granted) {
    throw new Error('需要先授予所选媒体来源权限，请重新点击下载');
  }
}

export function narrowMediaPermissions(
  assets: readonly MediaAsset[],
): chrome.permissions.Permissions {
  return { origins: permissionOriginsForUrls(assets.map((asset) => asset.url)) };
}

export function requiredPermissionBundle(
  action: PermissionGatedMediaAction,
  selectedAssets: readonly MediaAsset[],
): chrome.permissions.Permissions {
  return action.kind === 'capture-source'
    ? FULL_MEDIA_ACCESS_PERMISSIONS
    : narrowMediaPermissions(selectedAssets);
}

export function assertPermissionIntentBundle(
  intent: PermissionGatedMediaIntent,
  required: chrome.permissions.Permissions,
): void {
  if (!samePermissionBundle(intent.permissions, required)) {
    throw new Error('媒体权限范围与当前所选资源不一致，请重新点击下载');
  }
}
