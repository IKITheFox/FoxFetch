import type { PermissionIntent } from '../permissions/pending-intents';
import {
  runPermissionIntent,
  type PermissionIntentClient,
  type PermissionRequestApi,
} from '../permissions/permission-request';

/** YouTube media transport, not arbitrary websites. The caller must validate its page-bound intent. */
export const YOUTUBE_SOURCE_PERMISSIONS: chrome.permissions.Permissions = {
  origins: ['https://*.googlevideo.com/*'],
  permissions: ['webRequest'],
};

/** Shares the Bilibili permission-intent execution path; invoke only from an extension UI click. */
export function runYouTubeSourcePermission<TIntent extends PermissionIntent, TResult>(
  intent: TIntent,
  client: PermissionIntentClient<TIntent, TResult>,
  permissionsApi?: PermissionRequestApi,
): Promise<TResult> {
  return runPermissionIntent(intent, YOUTUBE_SOURCE_PERMISSIONS, client, {
    deniedMessage: '未允许访问 YouTube 视频来源，下载未开始。',
    ...(permissionsApi ? { permissionsApi } : {}),
  });
}
