import { validateDownloadFilename } from '../downloads/download-target';

export interface YouTubeDirectoryWriteRecord {
  jobId: string;
  kind: 'merged' | 'video' | 'audio';
  handleId: string;
  requestedName: string;
  actualName?: string;
  size: number;
  /** Missing means the original attempt, for existing version-1 records. */
  attempt?: number;
  phase: 'intent' | 'allocated' | 'verified' | 'unknown' | 'removed';
}

function readRecord(value: unknown): YouTubeDirectoryWriteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('DIRECTORY_JOURNAL_INVALID');
  const r = value as Record<string, unknown>;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  if (
    typeof r.jobId !== 'string' ||
    !new RegExp(`^${uuid}$`, 'iu').test(r.jobId) ||
    typeof r.handleId !== 'string' ||
    !new RegExp(`^youtube-${uuid}$`, 'iu').test(r.handleId) ||
    typeof r.kind !== 'string' ||
    !['merged', 'video', 'audio'].includes(r.kind) ||
    typeof r.phase !== 'string' ||
    !['intent', 'allocated', 'verified', 'unknown', 'removed'].includes(r.phase) ||
    !Number.isSafeInteger(r.size) ||
    Number(r.size) <= 0 ||
    (r.attempt !== undefined &&
      (!Number.isSafeInteger(r.attempt) || Number(r.attempt) < 0 || Number(r.attempt) > 1000)) ||
    typeof r.requestedName !== 'string' ||
    validateDownloadFilename(r.requestedName) !== r.requestedName ||
    (r.actualName !== undefined &&
      (typeof r.actualName !== 'string' ||
        validateDownloadFilename(r.actualName) !== r.actualName)) ||
    (['allocated', 'verified'].includes(String(r.phase)) && !r.actualName) ||
    (r.phase === 'intent' && r.actualName !== undefined)
  )
    throw new Error('DIRECTORY_JOURNAL_INVALID');
  return {
    jobId: r.jobId,
    kind: r.kind as YouTubeDirectoryWriteRecord['kind'],
    handleId: r.handleId,
    requestedName: r.requestedName,
    ...(r.actualName === undefined ? {} : { actualName: r.actualName as string }),
    size: r.size as number,
    ...(r.attempt === undefined ? {} : { attempt: r.attempt as number }),
    phase: r.phase as YouTubeDirectoryWriteRecord['phase'],
  };
}
const key = (r: YouTubeDirectoryWriteRecord) => `${r.jobId}:${r.kind}`;
function readRecords(value: unknown): YouTubeDirectoryWriteRecord[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object') throw new Error('DIRECTORY_JOURNAL_INVALID');
  const v = value as { version?: unknown; records?: unknown };
  if (v.version !== 1 || !Array.isArray(v.records) || v.records.length > 256)
    throw new Error('DIRECTORY_JOURNAL_INVALID');
  const records = v.records.map(readRecord);
  if (new Set(records.map(key)).size !== records.length)
    throw new Error('DIRECTORY_JOURNAL_INVALID');
  for (const r of records)
    for (const other of records) {
      if (r === other) continue;
      if (
        r.jobId === other.jobId &&
        (r.handleId !== other.handleId || r.kind === 'merged' || other.kind === 'merged')
      )
        throw new Error('DIRECTORY_JOURNAL_INVALID');
      if (
        r.actualName &&
        r.handleId === other.handleId &&
        r.actualName === other.actualName &&
        r.phase !== 'removed' &&
        other.phase !== 'removed'
      )
        throw new Error('DIRECTORY_JOURNAL_INVALID');
    }
  return records;
}

/** Private allocation ownership, not a file-success proof or permission grant.
 * The caller must establish real file state before recording verified/removed. */
export class YouTubeDirectoryJournal {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: {
      read(): Promise<unknown>;
      write(value: unknown): Promise<void>;
      /** Production stores must atomically read, validate and update across contexts. */
      update?(change: (value: unknown) => unknown): Promise<void>;
    },
  ) {}

  read(): Promise<YouTubeDirectoryWriteRecord[]> {
    return this.enqueue(async () => readRecords(await this.storage.read()));
  }

  /** Explicit retry reservation. Atomically replace only the exact, confirmed
   * removed attempt. No filesystem operation occurs here; unknown outputs must
   * be reconciled instead. Old callbacks remain fenced by the attempt number. */
  async reserveRetry(value: YouTubeDirectoryWriteRecord): Promise<YouTubeDirectoryWriteRecord> {
    const expected = readRecord(value);
    if (expected.phase !== 'removed' || !expected.actualName || (expected.attempt ?? 0) >= 1000)
      throw new Error('DIRECTORY_RETRY_REJECTED');
    const next: YouTubeDirectoryWriteRecord = {
      jobId: expected.jobId,
      kind: expected.kind,
      handleId: expected.handleId,
      requestedName: expected.requestedName,
      size: expected.size,
      attempt: (expected.attempt ?? 0) + 1,
      phase: 'intent',
    };
    await this.enqueue(async () => {
      const change = (value: unknown) => {
        const records = readRecords(value);
        const index = records.findIndex((record) => key(record) === key(expected));
        const previous = records[index];
        if (
          !previous ||
          previous.phase !== 'removed' ||
          previous.handleId !== expected.handleId ||
          previous.requestedName !== expected.requestedName ||
          previous.size !== expected.size ||
          previous.actualName !== expected.actualName ||
          (previous.attempt ?? 0) !== (expected.attempt ?? 0)
        )
          throw new Error('DIRECTORY_RETRY_REJECTED');
        records[index] = next;
        const payload = { version: 1, records };
        readRecords(payload);
        return payload;
      };
      if (this.storage.update) await this.storage.update(change);
      else await this.storage.write(change(await this.storage.read()));
    });
    return { ...next };
  }

  async put(
    value: YouTubeDirectoryWriteRecord,
    options: { createOnly?: boolean } = {},
  ): Promise<void> {
    const incoming = readRecord(value); // Snapshot before waiting for another write.
    const createOnly = options.createOnly === true;
    return this.enqueue(async () => {
      const change = (value: unknown) => {
        const records = readRecords(value);
        const index = records.findIndex((r) => key(r) === key(incoming));
        if (createOnly && index !== -1) throw new Error('DIRECTORY_SAVE_ALREADY_REGISTERED');
        if (index === -1) {
          if (incoming.phase !== 'intent' || (incoming.attempt ?? 0) !== 0 || records.length >= 256)
            throw new Error('DIRECTORY_JOURNAL_START_REJECTED');
          records.push(incoming);
        } else {
          const previous = records[index]!;
          if (
            previous.handleId !== incoming.handleId ||
            previous.requestedName !== incoming.requestedName ||
            previous.size !== incoming.size ||
            (previous.attempt ?? 0) !== (incoming.attempt ?? 0) ||
            (previous.actualName !== undefined && previous.actualName !== incoming.actualName)
          )
            throw new Error('DIRECTORY_JOURNAL_IDENTITY_CHANGED');
          const next = {
            intent: ['intent', 'allocated', 'unknown', 'removed'],
            allocated: ['allocated', 'verified', 'unknown', 'removed'],
            verified: ['verified', 'unknown'],
            unknown: ['unknown', 'verified', 'removed'],
            removed: ['removed'],
          }[previous.phase];
          if (!next.includes(incoming.phase))
            throw new Error('DIRECTORY_JOURNAL_TRANSITION_REJECTED');
          records[index] = incoming;
        }
        const payload = { version: 1, records };
        readRecords(payload);
        return payload;
      };
      if (this.storage.update) await this.storage.update(change);
      else await this.storage.write(change(await this.storage.read()));
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
