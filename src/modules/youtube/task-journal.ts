import { readYouTubeDraft } from './selection-preferences';
import type { YouTubeTaskRequest, YouTubeTaskSnapshot } from './background-task';

/** Private ownership record, not a playback/permission proof. No source or blob URLs. */
export interface YouTubeRecoveryRecord {
  request: YouTubeTaskRequest;
  state: YouTubeTaskSnapshot['state'];
  dispatched: boolean;
  cleanupPending: boolean;
  /** Persist before calling downloads.download; clear only after its ID is persisted. */
  savePending: boolean;
  saveAttempt?: number;
  pendingFile?: number;
  cancelRequested?: boolean;
  files: Array<{
    kind: 'merged' | 'video' | 'audio';
    size: number;
    downloadId: number | null;
  }>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TASK_JOURNAL_INVALID');
  return value as Record<string, unknown>;
};
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function readYouTubeRecoveryRecord(value: unknown): YouTubeRecoveryRecord {
  const r = object(value),
    request = object(r.request),
    owner = object(request.owner);
  const selection = object(request.selection);
  const draft = readYouTubeDraft({
    videoId: selection.videoId,
    quality: '',
    codec: selection.videoTrackId,
    audio: selection.audioTrackId ?? '',
    container: selection.container,
    mode: selection.mode ?? 'merge',
  });
  if (
    !draft ||
    !draft.codec ||
    typeof request.jobId !== 'string' ||
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(request.jobId) ||
    !integer(owner.tabId) ||
    typeof owner.documentId !== 'string' ||
    !/^[\w-]{1,128}$/u.test(owner.documentId) ||
    !integer(owner.navigationEpoch) ||
    !integer(owner.mediaEpoch) ||
    typeof r.state !== 'string' ||
    !['resolving', 'preparing', 'saving', 'canceling', 'canceled', 'complete', 'failed'].includes(
      r.state,
    ) ||
    typeof r.dispatched !== 'boolean' ||
    typeof r.cleanupPending !== 'boolean' ||
    typeof r.savePending !== 'boolean' ||
    (r.saveAttempt !== undefined && (!integer(r.saveAttempt) || r.saveAttempt > 1000)) ||
    !Array.isArray(r.files) ||
    r.files.length > 2 ||
    (request.saveLocation !== undefined &&
      !['browser-default', 'ask', 'custom'].includes(String(request.saveLocation)))
  )
    throw new Error('TASK_JOURNAL_INVALID');
  let directoryTarget: { handleId: string } | undefined;
  if (request.saveLocation === 'custom') {
    const target = object(request.directoryTarget);
    if (
      typeof target.handleId !== 'string' ||
      !/^youtube-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        target.handleId,
      )
    )
      throw new Error('TASK_JOURNAL_INVALID');
    directoryTarget = { handleId: target.handleId };
  } else if (request.directoryTarget !== undefined) {
    throw new Error('TASK_JOURNAL_INVALID');
  }
  const files = r.files.map((raw) => {
    const file = object(raw);
    if (
      !['merged', 'video', 'audio'].includes(String(file.kind)) ||
      !integer(file.size) ||
      file.size === 0 ||
      (file.downloadId !== null && !integer(file.downloadId))
    )
      throw new Error('TASK_JOURNAL_INVALID');
    return {
      kind: file.kind as 'merged' | 'video' | 'audio',
      size: file.size,
      downloadId: file.downloadId as number | null,
    };
  });
  const kinds = draft.mode === 'merge' ? ['merged'] : ['video', 'audio'];
  if (
    directoryTarget &&
    (files.some((file) => file.downloadId !== null) || r.pendingFile !== undefined)
  )
    throw new Error('TASK_JOURNAL_INVALID');
  if (r.cancelRequested !== undefined && typeof r.cancelRequested !== 'boolean')
    throw new Error('TASK_JOURNAL_INVALID');
  if (
    r.pendingFile !== undefined &&
    (!r.savePending || !integer(r.pendingFile) || r.pendingFile >= files.length)
  )
    throw new Error('TASK_JOURNAL_INVALID');
  const ids = files.flatMap((file) => (file.downloadId === null ? [] : [file.downloadId]));
  if (
    new Set(files.map((file) => file.kind)).size !== files.length ||
    new Set(ids).size !== ids.length ||
    files.some((file) => !kinds.includes(file.kind)) ||
    (files.length > 0 && (!r.dispatched || files.length !== kinds.length)) ||
    (r.savePending && files.length === 0)
  )
    throw new Error('TASK_JOURNAL_INVALID');
  return {
    request: {
      jobId: request.jobId,
      owner: {
        tabId: owner.tabId,
        documentId: owner.documentId,
        pageUrl: `https://www.youtube.com/watch?v=${draft.videoId}`,
        navigationEpoch: owner.navigationEpoch,
        mediaEpoch: owner.mediaEpoch,
      },
      selection: {
        videoId: draft.videoId,
        videoTrackId: draft.codec,
        ...(draft.audio ? { audioTrackId: draft.audio } : {}),
        container: draft.container,
        mode: draft.mode,
      },
      saveLocation: directoryTarget
        ? 'custom'
        : request.saveLocation === 'ask'
          ? 'ask'
          : 'browser-default',
      ...(directoryTarget ? { directoryTarget } : {}),
    },
    state: r.state as YouTubeTaskSnapshot['state'],
    dispatched: r.dispatched,
    cleanupPending: r.cleanupPending,
    savePending: r.savePending,
    ...(r.saveAttempt === undefined ? {} : { saveAttempt: r.saveAttempt as number }),
    cancelRequested:
      r.cancelRequested === true || r.state === 'canceling' || r.state === 'canceled',
    ...(r.pendingFile === undefined ? {} : { pendingFile: r.pendingFile as number }),
    files,
  };
}

/** Unlike optional preferences, malformed task records cannot be silently dropped:
 * they may own browser saves or temporary files. Fail closed and retain storage. */
export class YouTubeTaskJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: {
      read: () => Promise<unknown>;
      write: (value: unknown) => Promise<void>;
    },
  ) {}
  access(value?: YouTubeRecoveryRecord): Promise<YouTubeRecoveryRecord[]> {
    // Capture the checkpoint now, before queued asynchronous work can observe mutation.
    let incoming: YouTubeRecoveryRecord | undefined;
    try {
      if (value !== undefined) incoming = readYouTubeRecoveryRecord(value);
    } catch {
      return Promise.reject(new Error('TASK_JOURNAL_INVALID'));
    }
    const action = this.queue.then(async () => {
      const raw = await this.storage.read();
      let records: YouTubeRecoveryRecord[] = [];
      if (raw !== undefined) {
        const stored = object(raw);
        if (stored.version !== 1 || !Array.isArray(stored.records) || stored.records.length > 128)
          throw new Error('TASK_JOURNAL_INVALID');
        records = stored.records.map(readYouTubeRecoveryRecord);
        if (new Set(records.map((r) => r.request.jobId)).size !== records.length)
          throw new Error('TASK_JOURNAL_INVALID');
      }
      const existingIds = records.flatMap((r) =>
        r.files.flatMap((file) => (file.downloadId === null ? [] : [file.downloadId])),
      );
      if (new Set(existingIds).size !== existingIds.length) throw new Error('TASK_JOURNAL_INVALID');
      if (!incoming) return records;
      const previous = records.find((r) => r.request.jobId === incoming.request.jobId);
      if (previous && JSON.stringify(previous.request) !== JSON.stringify(incoming.request))
        throw new Error('TASK_JOURNAL_OWNER_CHANGED');
      records = records.filter((r) => r.request.jobId !== incoming.request.jobId);
      records.push(incoming);
      const downloadIds = records.flatMap((r) =>
        r.files.flatMap((file) => (file.downloadId === null ? [] : [file.downloadId])),
      );
      if (new Set(downloadIds).size !== downloadIds.length) throw new Error('TASK_JOURNAL_INVALID');
      if (records.length > 128) throw new Error('TASK_JOURNAL_CAPACITY');
      await this.storage.write({ version: 1, records });
      return structuredClone(records);
    });
    this.queue = action.catch(() => undefined);
    return action;
  }
}
