import type {
  CompletedRemux,
  MergeCapability,
  MergeFailureDetail,
  RemuxProgress,
  SeparateTrackMergeRequest,
} from '../merge';
import type { CompletedStandardSeparateExport, StandardSeparateOutputKind } from '../exports';

export type CustomDirectoryOutputKind = 'merge' | StandardSeparateOutputKind;

export type CustomDirectorySaveOutcome =
  | {
      status: 'completed';
      kind: CustomDirectoryOutputKind;
      fileName: string;
      sizeBytes: number;
    }
  | {
      status: 'failed';
      kind: CustomDirectoryOutputKind;
      failure: MergeFailureDetail;
    };

export const MERGE_OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

interface OffscreenEnvelope {
  channel: 'foxfetch-merge-offscreen-v1';
  jobId: string;
}

export type MergeOffscreenCommand =
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'PREFLIGHT';
      request: SeparateTrackMergeRequest;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'START';
      request: SeparateTrackMergeRequest;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'START_SEPARATE';
      request: SeparateTrackMergeRequest;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'SAVE_CUSTOM';
      handleId: string;
      fileNames: Partial<Record<CustomDirectoryOutputKind, string>>;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'PAGE_STAGE_BEGIN';
      stageId: string;
      request: SeparateTrackMergeRequest;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'PAGE_STAGE_CHUNK';
      stageId: string;
      track: 'video' | 'audio';
      offset: number;
      totalBytes: number;
      byteLength: number;
      bytesBase64: string;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'PAGE_STAGE_COMMIT';
      stageId: string;
    })
  | (OffscreenEnvelope & {
      target: 'offscreen';
      type: 'PAGE_STAGE_ABORT';
      stageId: string;
    })
  | (OffscreenEnvelope & { target: 'offscreen'; type: 'STATUS' })
  | (OffscreenEnvelope & { target: 'offscreen'; type: 'CANCEL' })
  | (OffscreenEnvelope & { target: 'offscreen'; type: 'CLEANUP' });

export type MergeOffscreenCancelResponse =
  | { ok: true; settled: true; forced: boolean }
  | { ok: false; settled: false; error: 'STOP_TIMEOUT' | 'CLEANUP_FAILED' };

export type MergeOffscreenStatusResponse =
  | { ok: true; state: 'idle' | 'queued' | 'preflighting' | 'running' | 'staging' }
  | { ok: true; state: 'completed'; result: CompletedRemux; blobUrl: string }
  | {
      ok: true;
      state: 'separate-completed';
      result: CompletedStandardSeparateExport;
      blobUrls: Partial<Record<StandardSeparateOutputKind, string>>;
    };

export type MergeOffscreenEvent =
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'CAPABILITY';
      capability: MergeCapability;
    })
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'PROGRESS';
      progress: RemuxProgress;
    })
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'COMPLETED';
      result: CompletedRemux;
      blobUrl: string;
    })
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'SEPARATE_COMPLETED';
      result: CompletedStandardSeparateExport;
      blobUrls: Partial<Record<StandardSeparateOutputKind, string>>;
    })
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'CUSTOM_SAVED';
      outcomes: CustomDirectorySaveOutcome[];
    })
  | (OffscreenEnvelope & {
      target: 'background';
      type: 'FAILED';
      failure: MergeFailureDetail;
    });

export function isMergeOffscreenCommand(value: unknown): value is MergeOffscreenCommand {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<MergeOffscreenCommand>;
  return (
    message.channel === 'foxfetch-merge-offscreen-v1' &&
    message.target === 'offscreen' &&
    typeof message.jobId === 'string' &&
    (message.type === 'PREFLIGHT' ||
      message.type === 'START' ||
      message.type === 'START_SEPARATE' ||
      message.type === 'SAVE_CUSTOM' ||
      message.type === 'PAGE_STAGE_BEGIN' ||
      message.type === 'PAGE_STAGE_CHUNK' ||
      message.type === 'PAGE_STAGE_COMMIT' ||
      message.type === 'PAGE_STAGE_ABORT' ||
      message.type === 'STATUS' ||
      message.type === 'CANCEL' ||
      message.type === 'CLEANUP') &&
    (message.type !== 'PAGE_STAGE_BEGIN' ||
      (typeof message.stageId === 'string' &&
        /^[0-9a-z-]{20,128}$/iu.test(message.stageId) &&
        message.request != null &&
        typeof message.request === 'object')) &&
    (message.type !== 'PAGE_STAGE_CHUNK' ||
      (typeof message.stageId === 'string' &&
        /^[0-9a-z-]{20,128}$/iu.test(message.stageId) &&
        (message.track === 'video' || message.track === 'audio') &&
        Number.isSafeInteger(message.offset) &&
        Number(message.offset) >= 0 &&
        Number.isSafeInteger(message.totalBytes) &&
        Number(message.totalBytes) > 0 &&
        Number.isSafeInteger(message.byteLength) &&
        Number(message.byteLength) > 0 &&
        Number(message.byteLength) <= 1 * 1024 * 1024 &&
        typeof message.bytesBase64 === 'string' &&
        message.bytesBase64.length > 0 &&
        message.bytesBase64.length <= 1_398_104)) &&
    ((message.type !== 'PAGE_STAGE_COMMIT' && message.type !== 'PAGE_STAGE_ABORT') ||
      (typeof message.stageId === 'string' && /^[0-9a-z-]{20,128}$/iu.test(message.stageId)))
  );
}

export function isMergeOffscreenEvent(value: unknown): value is MergeOffscreenEvent {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<MergeOffscreenEvent>;
  return (
    message.channel === 'foxfetch-merge-offscreen-v1' &&
    message.target === 'background' &&
    typeof message.jobId === 'string' &&
    (message.type === 'CAPABILITY' ||
      message.type === 'PROGRESS' ||
      message.type === 'COMPLETED' ||
      message.type === 'SEPARATE_COMPLETED' ||
      message.type === 'CUSTOM_SAVED' ||
      message.type === 'FAILED')
  );
}

interface MergeOffscreenMessageSender {
  id?: string;
  tab?: unknown;
  url?: string;
  origin?: string;
}

/** Reject commands relayed directly by a page/content script. */
export function isTrustedMergeOffscreenSender(
  sender: MergeOffscreenMessageSender,
  extensionId: string,
  extensionRoot: string,
): boolean {
  if (sender.id !== extensionId || sender.tab != null) return false;
  const rootUrl = new URL(extensionRoot);
  const extensionOrigin = `${rootUrl.protocol}//${rootUrl.host}`;
  return sender.url?.startsWith(extensionRoot) === true || sender.origin === extensionOrigin;
}
