import { formatTaskBytes } from '../../shared/task-bytes';

/** Written bytes alone do not prove that a complete, downloadable file exists. */
export function cacheFailureMessage(reason: string, bytes: number): string {
  const detail =
    Number.isSafeInteger(bytes) && bytes > 0
      ? `已写入 ${formatTaskBytes(bytes)} 缓存，尚未确认能否生成完整文件。`
      : '暂无可下载的缓存。';
  return `${reason.trim()}${/[。！？.!?]$/.test(reason.trim()) ? '' : '。'} ${detail}`;
}
