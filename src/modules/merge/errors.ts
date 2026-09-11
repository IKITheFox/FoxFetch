import type { MergeFailureCode, MergeFailureDetail } from './types';

export class MergeError extends Error {
  readonly detail: MergeFailureDetail;

  constructor(detail: MergeFailureDetail, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = 'MergeError';
    this.detail = detail;
  }
}

export function mergeError(
  code: MergeFailureCode,
  message: string,
  options: {
    retryable?: boolean;
    canDownloadSeparately?: boolean;
    cause?: unknown;
    drmSignals?: MergeFailureDetail['drmSignals'];
    httpStatus?: number;
    dynamicRangeCapability?: MergeFailureDetail['dynamicRangeCapability'];
    reason?: MergeFailureDetail['reason'];
    stage?: MergeFailureDetail['stage'];
    timeline?: MergeFailureDetail['timeline'];
    sourceTimeline?: MergeFailureDetail['sourceTimeline'];
    network?: MergeFailureDetail['network'];
    configuration?: MergeFailureDetail['configuration'];
  } = {},
): MergeError {
  const detail: MergeFailureDetail = {
    code,
    message,
    retryable: options.retryable ?? false,
    canDownloadSeparately: options.canDownloadSeparately ?? true,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.timeline ? { timeline: options.timeline } : {}),
    ...(options.sourceTimeline ? { sourceTimeline: options.sourceTimeline } : {}),
    ...(options.network ? { network: options.network } : {}),
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.drmSignals ? { drmSignals: options.drmSignals } : {}),
    ...(options.httpStatus == null ? {} : { httpStatus: options.httpStatus }),
    ...(options.dynamicRangeCapability
      ? { dynamicRangeCapability: options.dynamicRangeCapability }
      : {}),
  };
  return new MergeError(detail, options.cause === undefined ? undefined : { cause: options.cause });
}

export function normalizeMergeError(error: unknown): MergeError {
  if (error instanceof MergeError) return error;
  // Abort/OPFS errors may cross Window, Worker or test DOM realms.
  const exceptionName =
    error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (exceptionName === 'AbortError') {
    return mergeError('CANCELLED', '任务已取消，未生成完成文件。', {
      cause: error,
      canDownloadSeparately: true,
    });
  }

  if (exceptionName === 'QuotaExceededError') {
    return mergeError('OUTPUT_WRITE_FAILED', '浏览器临时存储空间不足，请释放空间后重试。', {
      reason: 'STORAGE_QUOTA',
      stage: 'storage',
      retryable: true,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('cors') ||
    lower.includes('http')
  ) {
    return mergeError('NETWORK_FAILED', `无法读取媒体直链：${message}`, {
      cause: error,
      retryable: true,
      canDownloadSeparately: true,
    });
  }

  return mergeError('INTERNAL_ERROR', `媒体处理失败：${message}`, {
    cause: error,
    canDownloadSeparately: true,
  });
}
