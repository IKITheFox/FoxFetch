import type { ApiResponse, UiRequest } from '../../shared/types';
import type { YouTubeTaskSnapshot } from './background-task';
import type { PermissionRequestApi } from '../permissions/permission-request';
import { runYouTubeSourcePermission } from './source-permissions';

export type YouTubeStartMessage = Extract<UiRequest, { selection: unknown; jobId: string }>;

/** Extension UI only. Invoke directly from the click, before any asynchronous work. */
export async function startYouTubeDownloadWithPermission(
  message: YouTubeStartMessage,
  send: (message: UiRequest) => Promise<ApiResponse<unknown>>,
  permissionsApi?: PermissionRequestApi,
): Promise<ApiResponse<YouTubeTaskSnapshot | null>> {
  const frozen = structuredClone(message);
  const tab = frozen.tabId === undefined ? {} : { tabId: frozen.tabId };
  let denied = false;
  let cancelled = false;
  let staged: Promise<void> = Promise.resolve();
  const api = permissionsApi ?? chrome.permissions;
  try {
    const result = await runYouTubeSourcePermission(
      { id: frozen.jobId, createdAt: Date.now(), action: frozen },
      {
        stage: () => {
          staged = send({ ...frozen, type: 'STAGE_YOUTUBE_DOWNLOAD_PERMISSION' }).then(
            (response) => {
              if (!response.ok) throw new Error(response.error);
              if (response.data !== frozen.jobId) throw new Error('授权任务确认不一致。');
            },
          );
          return staged;
        },
        commit: async (jobId) => {
          const response = await send({
            type: 'COMMIT_YOUTUBE_DOWNLOAD_PERMISSION',
            jobId,
            ...tab,
          });
          if (!response.ok) throw new Error(response.error);
          return response.data as YouTubeTaskSnapshot | null;
        },
        cancel: async (jobId) => {
          // A rejected request can settle before staging; never leave a late pending intent.
          await staged.catch(() => undefined);
          const response = await send({
            type: 'CANCEL_YOUTUBE_DOWNLOAD_PERMISSION',
            jobId,
            ...tab,
          });
          if (!response.ok) throw new Error(response.error);
          cancelled = true;
        },
      },
      {
        request: (permissions) =>
          api.request(permissions).then((allowed) => {
            denied = !allowed;
            return allowed;
          }),
      },
    );
    return { ok: true, data: result };
  } catch (error) {
    // Only a confirmed denial AND durable cancellation permit a fresh job.
    // Transport/commit uncertainty must remain attached to the existing job ID.
    if (denied && cancelled)
      return { ok: false, error: '未允许访问 YouTube 视频来源，下载未开始。' };
    throw error;
  }
}
