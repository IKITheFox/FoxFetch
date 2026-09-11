import type { YouTubeExecutionRequest, YouTubeExecutionStatus } from './offscreen-executor';
import type { YouTubeSelection, YouTubeSelectionPlan } from './selection';
import { canTryAnotherFormat } from './automatic-selection';
import { youtubePreparationStages, type YouTubePreparationStage } from './preparation-stage';
import { buildYouTubeOutputFilename } from './output-filename';
import {
  readFreshYouTubeSession,
  youTubeSessionAddress,
  isYouTubeAddressRejection,
} from './sources/fresh-session';
import { readYouTubeRecoveryRecord, type YouTubeRecoveryRecord } from './task-journal';
import { validateDownloadFilename } from '../downloads/download-target';
import { reliableTaskTotal } from '../../shared/task-bytes';

export interface YouTubeTaskOwner {
  tabId: number;
  documentId: string;
  pageUrl: string;
  navigationEpoch: number;
  mediaEpoch: number;
}
export interface YouTubeTaskRequest {
  jobId: string;
  owner: YouTubeTaskOwner;
  selection: YouTubeSelection;
  saveLocation?: 'browser-default' | 'ask' | 'custom';
  /** Private fixed target, copied from the background's confirmed picker grant. */
  directoryTarget?: { handleId: string };
}
export interface YouTubeTaskSnapshot {
  requestedSelection?: YouTubeSelection;
  bufferPeaks?: Record<string, number>;
  formatAttempt?: number;
  formatTotal?: number;
  formatAttempts?: Array<{ videoTrackId: string; audioTrackId?: string; error: string }>;
  jobId: string;
  videoId: string;
  /** Public, immutable track identifiers only; never source addresses. */
  selection?: YouTubeSelection;
  state: 'resolving' | 'preparing' | 'saving' | 'canceling' | 'canceled' | 'complete' | 'failed';
  readBytes: number;
  readSpeed?: number | null;
  network?: import('./sources/sabr-transport').SabrNetworkEvent[];
  primaryError?: string;
  totalBytes?: number | null;
  segments?: import('./sources/segment-progress').SegmentProgress | null;
  preparationStage?: YouTubePreparationStage;
  files: Array<{
    kind: 'merged' | 'video' | 'audio';
    size: number;
    savedBytes?: number | undefined;
    state: 'saving' | 'complete' | 'interrupted';
  }>;
  error?: string;
  cleanupPending: boolean;
  retryAvailable?: boolean;
  saveAttempt?: number;
  saveLocation?: 'browser-default' | 'ask' | 'custom';
}
type Command =
  | { type: 'SAVE_DIRECTORY'; jobId: string; handleId: string; filenames: string[] }
  | { type: 'RETRY_DIRECTORY'; jobId: string; attempt: number }
  | ({ type: 'START' | 'REFRESH' | 'NEXT_FORMAT' } & YouTubeExecutionRequest)
  | {
      type: 'STATUS' | 'CANCEL' | 'RELEASE' | 'RECHECK_DIRECTORY' | 'CANCEL_DIRECTORY';
      jobId: string;
    };
export interface YouTubeTaskDependencies {
  alternatives?: (
    request: YouTubeTaskRequest,
    signal: AbortSignal,
  ) => Promise<YouTubeSelectionPlan[]>;
  /** Trusted background checks the fixed grant/target, current owner and permission. */
  authorizeDirectory?: (request: YouTubeTaskRequest, signal: AbortSignal) => Promise<void>;
  plan: (request: YouTubeTaskRequest, signal: AbortSignal) => Promise<YouTubeSelectionPlan>;
  session: (
    plan: YouTubeSelectionPlan,
    owner: YouTubeTaskOwner,
    signal: AbortSignal,
  ) => Promise<YouTubeExecutionRequest['session']>;
  command: (command: Command) => Promise<YouTubeExecutionStatus | null>;
  download: (options: {
    url: string;
    filename: string;
    conflictAction: 'uniquify';
    saveAs?: boolean;
  }) => Promise<number>;
  search: (
    id: number,
  ) => Promise<
    | { state: 'in_progress' | 'complete' | 'interrupted'; bytesReceived: number; fileSize: number }
    | undefined
  >;
  cancelDownload: (id: number) => Promise<void>;
  extensionOrigin: string;
  pause?: () => Promise<void>;
  /** Awaited ownership checkpoint. Production enables this with restart recovery. */
  checkpoint?: (record: YouTubeRecoveryRecord) => Promise<void>;
  findDownloads?: (
    url: string,
  ) => Promise<Array<{ id: number; url: string; byExtensionId?: string }>>;
}
interface Entry {
  request: YouTubeTaskRequest;
  key: string;
  controller: AbortController;
  snapshot: YouTubeTaskSnapshot;
  ids: number[];
  dispatched: boolean;
  done: Promise<void>;
  reconciling?: Promise<void>;
  outputs?: YouTubeExecutionStatus['files'];
  outputTitle?: string;
  discardRequested?: boolean;
  savePending?: boolean;
  pendingFile?: number;
  recovered?: boolean;
  recoveryChecked?: boolean;
  recoveredRetained?: boolean;
  directoryRecheckStarted?: boolean;
}

/** Background owns browser saves; offscreen owns private sources and temporary files.
 * Snapshots deliberately omit source URLs, output blob URLs and browser download IDs.
 * Persisted ownership can be restored and reconciled against actual browser saves;
 * restoration never automatically restarts acquisition or creates another download.
 */
export class YouTubeBackgroundTasks {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly deps: YouTubeTaskDependencies) {}

  /** Import ownership only. Never restart acquisition or browser downloads. */
  restore(records: readonly YouTubeRecoveryRecord[]): void {
    if (this.entries.size || records.length > 128) throw new Error('TASK_RESTORE_INVALID');
    const checked = records.map(readYouTubeRecoveryRecord);
    if (new Set(checked.map((r) => r.request.jobId)).size !== checked.length)
      throw new Error('TASK_RESTORE_INVALID');
    const ids = checked.flatMap((r) =>
      r.files.flatMap((f) => (f.downloadId === null ? [] : [f.downloadId])),
    );
    if (new Set(ids).size !== ids.length) throw new Error('TASK_RESTORE_INVALID');
    for (const record of checked) {
      const controller = new AbortController();
      if (record.cancelRequested || record.state === 'canceling' || record.state === 'canceled')
        controller.abort();
      const entry: Entry = {
        request: record.request,
        key: JSON.stringify(record.request),
        controller,
        ids: [],
        dispatched: record.dispatched,
        done: Promise.resolve(),
        savePending: record.savePending,
        ...(record.pendingFile === undefined ? {} : { pendingFile: record.pendingFile }),
        recovered: true,
        recoveredRetained: record.cleanupPending,
        snapshot: {
          jobId: record.request.jobId,
          videoId: record.request.selection.videoId,
          selection: record.request.selection,
          state: 'failed',
          error: 'TASK_RECOVERY_PENDING',
          readBytes: 0,
          cleanupPending: true,
          files: record.files.map((file) => ({
            kind: file.kind,
            size: file.size,
            state: 'interrupted',
          })),
          saveLocation: record.request.saveLocation ?? 'browser-default',
          ...(record.saveAttempt === undefined ? {} : { saveAttempt: record.saveAttempt }),
        },
      };
      record.files.forEach((file, index) => {
        if (file.downloadId !== null) entry.ids[index] = file.downloadId;
      });
      this.entries.set(record.request.jobId, entry);
    }
  }

  /** One bounded observation per record; callers may poll again. */
  async refreshRecovered(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter(
          (entry) => entry.recovered && (!entry.recoveryChecked || entry.snapshot.cleanupPending),
        )
        .map((entry) => this.observeRecovered(entry)),
    );
  }

  private async observeRecovered(entry: Entry): Promise<void> {
    if (entry.reconciling) return entry.reconciling;
    entry.reconciling = (async () => {
      entry.recoveryChecked = true;
      try {
        // Directory records have no Chrome download IDs. Never interpret null
        // IDs as proof of cancellation, or release their retained source using
        // the browser-download recovery path.
        if (entry.request.saveLocation === 'custom') {
          await this.observeRecoveredDirectory(entry);
          return;
        }
        if (entry.savePending && !(await this.recoverPendingSave(entry))) {
          entry.snapshot.error = 'SAVE_STATUS_UNAVAILABLE';
          return;
        }
        const results = await Promise.all(
          entry.snapshot.files.map(async (_, index) => {
            const id = entry.ids[index];
            if (id === undefined) return null; // Persisted before any call, not a lost ID.
            if (entry.controller.signal.aborted) {
              const before = await this.deps.search(id);
              if (before?.state === 'in_progress') await this.deps.cancelDownload(id);
            }
            return this.deps.search(id);
          }),
        );
        if (results.some((result) => result === undefined))
          throw new Error('SAVE_STATUS_UNAVAILABLE');
        let saving = false;
        results.forEach((result, index) => {
          const file = entry.snapshot.files[index]!;
          if (result === null) {
            file.state = 'interrupted';
            return;
          }
          if (!result) return;
          file.savedBytes =
            Number.isSafeInteger(result.bytesReceived) && result.bytesReceived >= 0
              ? Math.min(result.bytesReceived, file.size)
              : undefined;
          file.state =
            result.state === 'in_progress'
              ? 'saving'
              : result.state === 'complete' &&
                  result.bytesReceived === file.size &&
                  result.fileSize === file.size
                ? 'complete'
                : 'interrupted';
          saving ||= file.state === 'saving';
        });
        if (saving) {
          entry.snapshot.state = entry.controller.signal.aborted ? 'canceling' : 'saving';
          delete entry.snapshot.error;
          return;
        }
        const complete =
          entry.snapshot.files.length > 0 &&
          entry.snapshot.files.every((f) => f.state === 'complete');
        entry.snapshot.state = complete
          ? 'complete'
          : entry.controller.signal.aborted
            ? 'canceled'
            : 'failed';
        if (complete) delete entry.snapshot.error;
        else
          entry.snapshot.error = entry.controller.signal.aborted
            ? 'DOWNLOAD_CANCELED'
            : 'TASK_INTERRUPTED';
        if (entry.recoveredRetained) {
          const released = await this.deps.command({ type: 'RELEASE', jobId: entry.request.jobId });
          if (released?.jobId !== entry.request.jobId || released.state !== 'released')
            throw new Error('RELEASE_UNCONFIRMED');
          entry.recoveredRetained = false;
        }
        entry.snapshot.cleanupPending = false;
        await this.checkpoint(entry);
      } catch {
        entry.snapshot.cleanupPending = true;
        if (entry.snapshot.state !== 'complete') {
          entry.snapshot.state = 'failed';
          entry.snapshot.error = 'TASK_RECOVERY_PENDING';
        }
      }
    })().finally(() => {
      delete entry.reconciling;
    });
    return entry.reconciling;
  }

  private async recoverPendingSave(entry: Entry): Promise<boolean> {
    const index = entry.pendingFile;
    if (index === undefined || !this.deps.findDownloads || !entry.recoveredRetained) return false;
    const expected = entry.snapshot.files[index];
    if (!expected) return false;
    const status = await this.deps.command({ type: 'STATUS', jobId: entry.request.jobId });
    if (status?.jobId !== entry.request.jobId || status.state !== 'ready') return false;
    const matches = status.files.filter(
      (file) => file.kind === expected.kind && file.size === expected.size,
    );
    if (matches.length !== 1) return false;
    const file = matches[0]!;
    if (!file.url.startsWith(`blob:${this.deps.extensionOrigin}/`)) return false;
    const downloads = await this.deps.findDownloads(file.url);
    if (downloads.length >= 10) return false; // A bounded query may have omitted other matches.
    const knownIds = new Set([...this.entries.values()].flatMap((other) => other.ids));
    const extensionId = new URL(this.deps.extensionOrigin).hostname;
    const candidates = downloads.filter(
      (download) =>
        download.url === file.url &&
        download.byExtensionId === extensionId &&
        Number.isSafeInteger(download.id) &&
        download.id >= 0 &&
        !knownIds.has(download.id),
    );
    if (candidates.length !== 1) return false;
    const previous = entry.ids[index];
    entry.ids[index] = candidates[0]!.id;
    entry.savePending = false;
    delete entry.pendingFile;
    try {
      await this.checkpoint(entry);
    } catch (error) {
      if (previous === undefined) delete entry.ids[index];
      else entry.ids[index] = previous;
      entry.savePending = true;
      entry.pendingFile = index;
      throw error;
    }
    return true;
  }

  private async observeRecoveredDirectory(entry: Entry): Promise<void> {
    const jobId = entry.request.jobId;
    const unconfirmed = () => {
      entry.snapshot.state = 'failed';
      entry.snapshot.error = 'DIRECTORY_RECOVERY_PENDING';
    };
    entry.snapshot.cleanupPending = true;
    let status = await this.deps.command({ type: 'STATUS', jobId });
    if (status?.jobId !== jobId || status.state !== 'ready' || !status.directory)
      return unconfirmed();
    const requestedAttempt = entry.snapshot.saveAttempt ?? 0;
    if (
      requestedAttempt > 0 &&
      status.directory.state === 'stopped' &&
      (status.directory.attempt ?? 0) === requestedAttempt - 1 &&
      !entry.controller.signal.aborted &&
      !entry.discardRequested
    ) {
      // The persisted retry intent may predate command delivery. Re-send the
      // same attempt, which the executor deduplicates, after current permission.
      if (!this.deps.authorizeDirectory) return unconfirmed();
      await this.deps.authorizeDirectory(structuredClone(entry.request), entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      status = await this.deps.command({
        type: 'RETRY_DIRECTORY',
        jobId,
        attempt: requestedAttempt,
      });
      if (status?.jobId !== jobId || status.state !== 'ready' || !status.directory)
        return unconfirmed();
    }
    if (
      entry.controller.signal.aborted &&
      ['saving', 'checking'].includes(status.directory.state)
    ) {
      status = await this.deps.command({ type: 'CANCEL_DIRECTORY', jobId });
    } else if (
      !entry.directoryRecheckStarted &&
      !entry.controller.signal.aborted &&
      ['unknown', 'verified'].includes(status.directory.state)
    ) {
      entry.directoryRecheckStarted = true;
      status = await this.deps.command({ type: 'RECHECK_DIRECTORY', jobId });
    }
    if (status?.jobId !== jobId || status.state !== 'ready' || !status.directory)
      return unconfirmed();
    const directory = status.directory;
    const canceledBeforeDispatch =
      directory.state === 'stopped' &&
      requestedAttempt > 0 &&
      (directory.attempt ?? 0) === requestedAttempt - 1 &&
      (entry.controller.signal.aborted || entry.discardRequested);
    if ((directory.attempt ?? 0) !== requestedAttempt && !canceledBeforeDispatch)
      return unconfirmed();
    const expected = entry.snapshot.files;
    if (
      !expected.length ||
      directory.files.length > expected.length ||
      new Set(directory.files.map((file) => file.kind)).size !== directory.files.length ||
      directory.files.some(
        (file) =>
          file.handleId !== entry.request.directoryTarget?.handleId ||
          validateDownloadFilename(file.fileName) !== file.fileName ||
          !expected.some((row) => row.kind === file.kind && row.size === file.size),
      )
    )
      return unconfirmed();
    for (const row of expected) {
      const confirmed = directory.files.some(
        (file) => file.kind === row.kind && file.size === row.size,
      );
      row.state = confirmed ? 'complete' : 'interrupted';
      row.savedBytes = confirmed ? row.size : 0;
    }
    if (['saving', 'checking'].includes(directory.state)) {
      entry.snapshot.state = entry.controller.signal.aborted ? 'canceling' : 'saving';
      delete entry.snapshot.error;
      return;
    }
    const stopped = directory.state === 'stopped';
    if (stopped) {
      const removed = directory.removed ?? [],
        unstarted = directory.unstarted ?? [];
      const roles = [
        ...directory.files.map((file) => file.kind),
        ...removed.map((file) => file.kind),
        ...unstarted,
      ];
      if (
        roles.length !== expected.length ||
        new Set(roles).size !== roles.length ||
        roles.some((kind) => !expected.some((row) => row.kind === kind)) ||
        removed.some(
          (file) =>
            file.handleId !== entry.request.directoryTarget?.handleId ||
            validateDownloadFilename(file.fileName) !== file.fileName ||
            !expected.some((row) => row.kind === file.kind && row.size === file.size),
        )
      )
        return unconfirmed();
    } else if (directory.state !== 'verified' || directory.files.length !== expected.length)
      return unconfirmed();
    // Record proof before releasing the only source usable for content checks.
    entry.savePending = false;
    delete entry.pendingFile;
    entry.snapshot.state = stopped
      ? entry.controller.signal.aborted
        ? 'canceled'
        : 'failed'
      : 'complete';
    if (stopped)
      entry.snapshot.error = entry.controller.signal.aborted
        ? 'DOWNLOAD_CANCELED'
        : 'DIRECTORY_SAVE_FAILED';
    else delete entry.snapshot.error;
    entry.snapshot.retryAvailable =
      stopped && !entry.controller.signal.aborted && !entry.discardRequested;
    await this.checkpoint(entry);
    if (entry.snapshot.retryAvailable) return;
    const released = await this.deps.command({ type: 'RELEASE', jobId });
    if (released?.jobId !== jobId || released.state !== 'released') return;
    entry.snapshot.cleanupPending = false;
    entry.recoveredRetained = false;
    await this.checkpoint(entry);
  }

  start(request: YouTubeTaskRequest): YouTubeTaskSnapshot {
    if (request.saveLocation === 'custom') {
      if (
        !this.deps.authorizeDirectory ||
        !request.directoryTarget ||
        !/^youtube-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          request.directoryTarget.handleId,
        )
      )
        throw new Error('DIRECTORY_TARGET_UNAVAILABLE');
    } else if (request.directoryTarget !== undefined) throw new Error('SAVE_LOCATION_INVALID');
    if (
      request.saveLocation !== undefined &&
      !['browser-default', 'ask', 'custom'].includes(request.saveLocation)
    )
      throw new Error('SAVE_LOCATION_INVALID');
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(request.jobId))
      throw new Error('JOB_ID_INVALID');
    const copied = structuredClone(request);
    const key = JSON.stringify(copied);
    const existing = this.entries.get(request.jobId);
    if (existing) {
      if (key !== existing.key) throw new Error('JOB_SELECTION_CHANGED');
      return this.snapshot(existing);
    }
    const current = this.current(copied.owner, copied.selection.videoId);
    if (
      current &&
      (!['complete', 'failed', 'canceled'].includes(current.state) || current.cleanupPending)
    )
      throw new Error('JOB_BUSY');
    if (this.entries.size >= 128) throw new Error('JOB_CAPACITY_REACHED');
    if (
      [...this.entries.values()].filter(
        (e) =>
          ['resolving', 'preparing', 'saving', 'canceling'].includes(e.snapshot.state) ||
          e.snapshot.cleanupPending,
      ).length >= 2
    )
      throw new Error('JOB_BUSY');
    const entry: Entry = {
      request: copied,
      key,
      controller: new AbortController(),
      ids: [],
      dispatched: false,
      snapshot: {
        jobId: copied.jobId,
        requestedSelection: structuredClone(copied.selection),
        videoId: copied.selection.videoId,
        selection: {
          videoId: copied.selection.videoId,
          videoTrackId: copied.selection.videoTrackId,
          ...(copied.selection.audioTrackId ? { audioTrackId: copied.selection.audioTrackId } : {}),
          container: copied.selection.container,
          mode: copied.selection.mode ?? 'merge',
        },
        state: 'resolving',
        readBytes: 0,
        files: [],
        cleanupPending: false,
        saveAttempt: 0,
        saveLocation: copied.saveLocation ?? 'browser-default',
      },
      done: Promise.resolve(),
    };
    this.entries.set(copied.jobId, entry);
    entry.done = Promise.resolve().then(() => this.run(entry));
    return this.snapshot(entry);
  }

  status(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): YouTubeTaskSnapshot | null {
    const entry = this.owned(jobId, owner);
    return entry ? this.snapshot(entry) : null;
  }

  current(
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
    videoId: string,
  ): YouTubeTaskSnapshot | null {
    const matches = [...this.entries.values()].filter(
      (entry) =>
        entry.request.owner.tabId === owner.tabId &&
        entry.request.owner.documentId === owner.documentId &&
        entry.request.selection.videoId === videoId,
    );
    const active = matches.filter(
      (entry) =>
        !['complete', 'failed', 'canceled'].includes(entry.snapshot.state) ||
        entry.snapshot.cleanupPending,
    );
    const entry = active.at(-1) ?? matches.at(-1);
    return entry ? this.snapshot(entry) : null;
  }

  cancel(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): YouTubeTaskSnapshot | null {
    const entry = this.owned(jobId, owner);
    if (!entry) return null;
    if (
      !['complete', 'failed', 'canceled'].includes(entry.snapshot.state) ||
      (entry.recovered && entry.snapshot.cleanupPending && entry.snapshot.state !== 'complete')
    ) {
      entry.snapshot.state = 'canceling';
      entry.controller.abort();
    }
    return this.snapshot(entry);
  }

  async cancelAndRecord(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): Promise<YouTubeTaskSnapshot | null> {
    this.cancel(jobId, owner);
    const entry = this.owned(jobId, owner);
    if (!entry) return null;
    // Cancellation remains active even if storage fails; never report it as durable.
    try {
      await this.checkpoint(entry);
    } finally {
      // Failure to persist must not suppress the user's actual cancellation.
      if (entry.recovered) await this.observeRecovered(entry);
    }
    return this.snapshot(entry);
  }

  async recheck(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): Promise<YouTubeTaskSnapshot | null> {
    const entry = this.owned(jobId, owner);
    if (!entry) return null;
    if (entry.recovered) {
      if (
        entry.request.saveLocation === 'custom' &&
        !entry.reconciling &&
        entry.snapshot.state === 'failed'
      )
        entry.directoryRecheckStarted = false;
      await this.observeRecovered(entry);
      return this.snapshot(entry);
    }
    if (entry.snapshot.retryAvailable) return this.snapshot(entry);
    if (entry.savePending) return this.snapshot(entry);
    if (
      !['complete', 'failed', 'canceled'].includes(entry.snapshot.state) ||
      !entry.snapshot.cleanupPending
    )
      return this.snapshot(entry);
    if (!entry.reconciling) {
      entry.reconciling = (async () => {
        // Finish the original cleanup attempt first; never race two releases.
        await entry.done;
        if (!entry.snapshot.cleanupPending) return;
        try {
          const files = await Promise.all(entry.ids.map((id) => this.deps.search(id)));
          if (files.some((file) => !file || file.state === 'in_progress')) return;
          files.forEach((file, index) => {
            const expected = entry.snapshot.files[index]!;
            expected.savedBytes =
              Number.isSafeInteger(file!.bytesReceived) && file!.bytesReceived >= 0
                ? Math.min(file!.bytesReceived, expected.size)
                : undefined;
            expected.state =
              file!.state === 'complete' &&
              file!.bytesReceived === expected.size &&
              file!.fileSize === expected.size
                ? 'complete'
                : 'interrupted';
          });
          if (this.allFilesSaved(entry)) {
            entry.snapshot.state = 'complete';
            delete entry.snapshot.error;
          } else if (entry.outputs && entry.snapshot.files.length) {
            entry.snapshot.state = entry.controller.signal.aborted ? 'canceled' : 'failed';
            entry.snapshot.error = entry.controller.signal.aborted
              ? 'DOWNLOAD_CANCELED'
              : 'SAVE_INCOMPLETE';
            if (!entry.controller.signal.aborted && !entry.discardRequested) {
              entry.snapshot.retryAvailable = true;
              return;
            }
          }
          const released = await this.deps.command({ type: 'RELEASE', jobId });
          if (released?.jobId === jobId && released.state === 'released') {
            entry.snapshot.cleanupPending = false;
            delete entry.outputs;
          }
        } catch {
          /* Keep ownership when browser status or release is unconfirmed. */
        }
      })().finally(() => {
        delete entry.reconciling;
      });
    }
    await entry.reconciling;
    return this.snapshot(entry);
  }

  retry(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): YouTubeTaskSnapshot | null {
    const entry = this.owned(jobId, owner);
    if (!entry) return null;
    if (!entry.snapshot.retryAvailable || entry.reconciling) return this.snapshot(entry);
    const previous = entry.done;
    entry.snapshot.retryAvailable = false;
    entry.snapshot.state = 'saving';
    entry.snapshot.saveAttempt = (entry.snapshot.saveAttempt ?? 0) + 1;
    delete entry.snapshot.error;
    entry.controller = new AbortController();
    if (entry.request.saveLocation === 'custom') {
      entry.directoryRecheckStarted = false;
      entry.done = previous.then(async () => {
        try {
          await this.deps.authorizeDirectory!(
            structuredClone(entry.request),
            entry.controller.signal,
          );
          entry.controller.signal.throwIfAborted();
          await this.checkpoint(entry);
          entry.controller.signal.throwIfAborted();
          await this.deps.command({
            type: 'RETRY_DIRECTORY',
            jobId,
            attempt: entry.snapshot.saveAttempt!,
          });
          for (;;) {
            await this.observeRecoveredDirectory(entry);
            if (!['saving', 'canceling'].includes(entry.snapshot.state)) break;
            await this.pause();
          }
        } catch {
          entry.snapshot.state = 'failed';
          entry.snapshot.error = 'DIRECTORY_RECOVERY_PENDING';
          entry.snapshot.cleanupPending = true;
        } finally {
          try {
            await this.checkpoint(entry);
          } catch {
            entry.snapshot.error = 'TASK_CHECKPOINT_FAILED';
            entry.snapshot.retryAvailable = false;
            entry.snapshot.cleanupPending = true;
          }
        }
      });
      entry.reconciling = entry.done.finally(() => {
        delete entry.reconciling;
      });
    } else entry.done = previous.then(() => this.run(entry));
    return this.snapshot(entry);
  }

  async discard(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): Promise<YouTubeTaskSnapshot | null> {
    const entry = this.owned(jobId, owner);
    if (!entry) return null;
    if (!entry.snapshot.retryAvailable) return this.snapshot(entry);
    entry.discardRequested = true;
    entry.snapshot.retryAvailable = false;
    return this.recheck(jobId, owner);
  }

  private owned(
    jobId: string,
    owner: Pick<YouTubeTaskOwner, 'tabId' | 'documentId'>,
  ): Entry | undefined {
    const entry = this.entries.get(jobId);
    if (
      entry &&
      (entry.request.owner.tabId !== owner.tabId ||
        entry.request.owner.documentId !== owner.documentId)
    )
      throw new Error('JOB_OWNER_CHANGED');
    return entry;
  }
  private snapshot(entry: Entry): YouTubeTaskSnapshot {
    return structuredClone(entry.snapshot);
  }
  private allFilesSaved(entry: Entry): boolean {
    return (
      !!entry.outputs?.length &&
      entry.outputs.length === entry.snapshot.files.length &&
      entry.snapshot.files.every((file) => file.state === 'complete')
    );
  }
  private pause(): Promise<void> {
    return this.deps.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 500));
  }

  private async settleFiles(entry: Entry, cancel: boolean): Promise<void> {
    // A pending downloads.download call is awaited before reaching this method,
    // so its late ID is also canceled. Never release an output still being read.
    // Promise.all rejects before its other queries finish. Fence this invocation
    // so those late readers cannot mutate cleanup or a subsequent save attempt.
    let stopped = false;
    try {
      await Promise.all(
        entry.ids.map(async (id, index) => {
          if (cancel) await this.deps.cancelDownload(id).catch(() => undefined);
          while (!stopped) {
            const file = await this.deps.search(id);
            if (stopped) return;
            if (!file) throw new Error('SAVE_STATUS_UNAVAILABLE');
            const row = entry.snapshot.files[index]!;
            row.savedBytes =
              Number.isSafeInteger(file.bytesReceived) && file.bytesReceived >= 0
                ? Math.min(file.bytesReceived, row.size)
                : undefined;
            if (file.state !== 'in_progress') {
              const expected = entry.snapshot.files[index]!;
              expected.state =
                file.state === 'complete' &&
                file.bytesReceived === expected.size &&
                file.fileSize === expected.size
                  ? 'complete'
                  : 'interrupted';
              return;
            }
            if (entry.controller.signal.aborted)
              await this.deps.cancelDownload(id).catch(() => undefined);
            await this.pause();
          }
        }),
      );
    } finally {
      stopped = true;
    }
  }

  private async checkpoint(entry: Entry): Promise<void> {
    if (!this.deps.checkpoint) return;
    try {
      await this.deps.checkpoint(
        readYouTubeRecoveryRecord({
          request: entry.request,
          state: entry.snapshot.state,
          dispatched: entry.dispatched,
          cleanupPending: entry.snapshot.cleanupPending,
          savePending: entry.savePending ?? false,
          ...(entry.snapshot.saveAttempt === undefined
            ? {}
            : { saveAttempt: entry.snapshot.saveAttempt }),
          cancelRequested: entry.controller.signal.aborted,
          ...(entry.savePending && entry.pendingFile !== undefined
            ? { pendingFile: entry.pendingFile }
            : {}),
          files: entry.snapshot.files.map((file, index) => ({
            kind: file.kind,
            size: file.size,
            downloadId: entry.ids[index] ?? null,
          })),
        }),
      );
    } catch {
      throw new Error('TASK_CHECKPOINT_FAILED');
    }
  }

  private async run(entry: Entry): Promise<void> {
    try {
      await this.runAttempt(entry);
    } finally {
      try {
        await this.checkpoint(entry);
      } catch {
        entry.snapshot.error = 'TASK_CHECKPOINT_FAILED';
        entry.snapshot.cleanupPending = true;
        entry.snapshot.retryAvailable = false;
        if (entry.snapshot.state !== 'complete') entry.snapshot.state = 'failed';
      }
    }
  }

  private async runAttempt(entry: Entry): Promise<void> {
    const { signal } = entry.controller;
    const jobId = entry.request.jobId;
    try {
      signal.throwIfAborted();
      if (entry.request.saveLocation === 'custom') {
        await this.deps.authorizeDirectory!(structuredClone(entry.request), signal);
        signal.throwIfAborted();
      }
      await this.checkpoint(entry);
      signal.throwIfAborted();
      if (!entry.outputs) {
        let plan = await this.deps.plan(entry.request, signal);
        const alternatives =
          entry.request.selection.preference && this.deps.alternatives
            ? (await this.deps.alternatives(entry.request, signal))
                .filter((p) => p.video.id !== plan.video.id || p.audio?.id !== plan.audio?.id)
                .slice(0, 2)
            : [];
        entry.snapshot.formatAttempt = 1;
        entry.snapshot.formatTotal = alternatives.length + 1;
        if (plan.title !== undefined) entry.outputTitle = plan.title;
        signal.throwIfAborted();
        let session = await readFreshYouTubeSession(
          () => this.deps.session(plan, entry.request.owner, signal),
          signal,
        );
        signal.throwIfAborted();
        entry.snapshot.state = 'preparing';
        // Mark before sending: an ambiguous acknowledgement must retain ownership.
        entry.dispatched = true;
        entry.snapshot.cleanupPending = true;
        try {
          await this.checkpoint(entry);
          signal.throwIfAborted();
        } catch (error) {
          entry.dispatched = false;
          entry.snapshot.cleanupPending = false;
          throw error;
        }
        let status = await this.deps.command({ type: 'START', jobId, plan, session });
        let refreshed = false;
        for (;;) {
          signal.throwIfAborted();
          if (!status || status.jobId !== jobId) throw new Error('EXECUTION_STATUS_UNAVAILABLE');
          if (!Number.isSafeInteger(status.readBytes) || status.readBytes < 0)
            throw new Error('EXECUTION_STATUS_INVALID');
          // A refreshed acquisition starts a new byte counter, not a cumulative retry.
          entry.snapshot.readBytes = status.readBytes;
          entry.snapshot.readSpeed =
            Number.isSafeInteger(status.readSpeed) && status.readSpeed! >= 0
              ? status.readSpeed!
              : null;
          entry.snapshot.segments = status.segments ?? null;
          entry.snapshot.network = status.network ?? [];
          entry.snapshot.bufferPeaks = Object.fromEntries(
            Object.entries(status.bufferPeaks ?? {}).filter(
              ([key, value]) =>
                ['RESPONSE_BYTES', 'RETAINED_BYTES', 'WRITING_BYTES'].includes(key) &&
                Number.isSafeInteger(value) &&
                value >= 0,
            ),
          );
          if (status.primaryError) entry.snapshot.primaryError = status.primaryError;
          else delete entry.snapshot.primaryError;
          entry.snapshot.totalBytes = reliableTaskTotal(
            entry.snapshot.readBytes,
            status.totalBytes,
          );
          if (
            status.preparationStage &&
            Object.hasOwn(youtubePreparationStages, status.preparationStage)
          )
            entry.snapshot.preparationStage = status.preparationStage;
          if (status.state === 'ready') break;
          if (status.state === 'failed') {
            if (canTryAnotherFormat(status.error) && !status.files.length && alternatives.length) {
              const next = alternatives.shift()!;
              (entry.snapshot.formatAttempts ??= []).push({
                videoTrackId: plan.video.id,
                ...(plan.audio ? { audioTrackId: plan.audio.id } : {}),
                error: status.error!,
              });
              session = await readFreshYouTubeSession(
                () => this.deps.session(next, entry.request.owner, signal),
                signal,
              );
              signal.throwIfAborted();
              plan = next;
              entry.request.selection = {
                ...entry.request.selection,
                videoTrackId: plan.video.id,
                ...(plan.audio ? { audioTrackId: plan.audio.id } : {}),
                container: 'auto',
              };
              if (!plan.audio) delete entry.request.selection.audioTrackId;
              entry.snapshot.selection = structuredClone(entry.request.selection);
              entry.snapshot.formatAttempt = (entry.snapshot.formatAttempt ?? 1) + 1;
              entry.snapshot.readBytes = 0;
              entry.snapshot.totalBytes = null;
              entry.snapshot.segments = null;
              await this.checkpoint(entry);
              signal.throwIfAborted();
              status = await this.deps.command({ type: 'NEXT_FORMAT', jobId, plan, session });
              continue;
            }
            if (!refreshed && isYouTubeAddressRejection(status.error) && !status.files.length) {
              refreshed = true;
              entry.snapshot.preparationStage = 'refreshing-source';
              const fresh = await readFreshYouTubeSession(
                () => this.deps.session(plan, entry.request.owner, signal),
                signal,
              );
              signal.throwIfAborted();
              const oldAddress = youTubeSessionAddress(session);
              const newAddress = youTubeSessionAddress(fresh);
              if (oldAddress && newAddress && oldAddress !== newAddress) {
                await this.checkpoint(entry);
                signal.throwIfAborted();
                entry.snapshot.preparationStage = 'downloading';
                status = await this.deps.command({ type: 'REFRESH', jobId, plan, session: fresh });
                continue;
              }
            }
            throw new Error(status.error ?? 'PREPARATION_FAILED');
          }
          if (status.state !== 'preparing') throw new Error('PREPARATION_INTERRUPTED');
          await this.pause();
          signal.throwIfAborted();
          status = await this.deps.command({ type: 'STATUS', jobId });
        }
        const kinds = plan.mode === 'merge' ? ['merged'] : ['video', 'audio'];
        if (
          status.files.length !== kinds.length ||
          kinds.some((kind) => status!.files.filter((f) => f.kind === kind).length !== 1)
        )
          throw new Error('OUTPUT_INVALID');
        for (const file of status.files) {
          if (
            !file.url.startsWith(`blob:${this.deps.extensionOrigin}/`) ||
            !Number.isSafeInteger(file.size) ||
            file.size <= 0 ||
            !/^(?:video|audio)\.(?:mp4|m4a|webm)$/u.test(file.name)
          )
            throw new Error('OUTPUT_INVALID');
        }
        entry.outputs = structuredClone(status.files);
        // Register every expected output before opening any browser save dialog.
        // A rejected second dialog must still leave a visible failed audio row.
        entry.snapshot.files = status.files.map((file) => ({
          kind: file.kind,
          size: file.size,
          state: 'interrupted',
        }));
      }
      entry.snapshot.state = 'saving';
      if (entry.request.saveLocation === 'custom') {
        await this.deps.authorizeDirectory!(structuredClone(entry.request), signal);
        signal.throwIfAborted();
        const saving = this.saveDirectory(entry);
        entry.reconciling = saving;
        try {
          await saving;
        } finally {
          delete entry.reconciling;
        }
        return;
      }
      for (const [index, file] of entry.outputs.entries()) {
        signal.throwIfAborted();
        if (entry.snapshot.files[index]!.state === 'complete') continue;
        entry.savePending = true;
        entry.pendingFile = index;
        try {
          await this.checkpoint(entry);
          signal.throwIfAborted();
        } catch (error) {
          entry.savePending = false;
          delete entry.pendingFile;
          throw error;
        }
        const id = await this.deps
          .download({
            url: file.url,
            filename: buildYouTubeOutputFilename(
              entry.request.selection.videoId,
              file.name,
              file.kind,
              entry.outputTitle,
            ),
            conflictAction: 'uniquify',
            ...(entry.request.saveLocation === 'ask' ? { saveAs: true } : {}),
          })
          .catch(() => {
            entry.savePending = false;
            delete entry.pendingFile;
            throw new Error('SAVE_START_FAILED');
          });
        if (!Number.isSafeInteger(id) || id < 0) throw new Error('SAVE_START_FAILED');
        entry.ids[index] = id;
        entry.savePending = false;
        delete entry.pendingFile;
        entry.snapshot.files[index]!.state = 'saving';
        entry.snapshot.files[index]!.savedBytes = 0;
        await this.checkpoint(entry);
      }
      await this.settleFiles(entry, signal.aborted);
      signal.throwIfAborted();
      if (entry.snapshot.files.some((f) => f.state !== 'complete'))
        throw new Error('SAVE_INCOMPLETE');
      entry.snapshot.state = 'complete';
      await this.checkpoint(entry);
    } catch (error) {
      // Stop both file saves and source acquisition. A complete file is never erased.
      let confirmed = false;
      try {
        await this.settleFiles(entry, true);
        confirmed = !entry.savePending;
      } catch {
        /* Retain output; do not guess Chrome stopped. */
      }
      entry.snapshot.state = signal.aborted && confirmed ? 'canceled' : 'failed';
      const code = error instanceof Error ? error.message : '';
      entry.snapshot.error = signal.aborted
        ? 'DOWNLOAD_CANCELED'
        : /^[A-Z][A-Z_0-9]{1,80}$/u.test(code)
          ? code
          : 'DOWNLOAD_FAILED';
      if (!confirmed) return;
      if (this.allFilesSaved(entry)) {
        entry.snapshot.state = 'complete';
        delete entry.snapshot.error;
      }
      if (
        !signal.aborted &&
        entry.outputs &&
        entry.snapshot.files.some((file) => file.state !== 'complete')
      ) {
        entry.snapshot.retryAvailable = true;
        return;
      }
    }
    if (entry.dispatched) {
      try {
        // RELEASE also aborts preparation, but only after all Chrome readers settled.
        const released = await this.deps.command({ type: 'RELEASE', jobId });
        if (released?.jobId !== jobId || released.state !== 'released')
          throw new Error('RELEASE_UNCONFIRMED');
        entry.snapshot.cleanupPending = false;
        delete entry.outputs;
      } catch {
        entry.snapshot.cleanupPending = true;
      }
    }
  }

  /** Uses the existing private executor and recovery path, never downloads.download. */
  private async saveDirectory(entry: Entry): Promise<void> {
    const jobId = entry.request.jobId;
    entry.savePending = true;
    try {
      await this.checkpoint(entry);
      entry.controller.signal.throwIfAborted();
      const filenames = entry.outputs!.map((file) =>
        buildYouTubeOutputFilename(
          entry.request.selection.videoId,
          file.name,
          file.kind,
          entry.outputTitle,
        )
          .split('/')
          .at(-1)!,
      );
      await this.deps.command({
        type: 'SAVE_DIRECTORY',
        jobId,
        handleId: entry.request.directoryTarget!.handleId,
        filenames,
      });
      // Keep recovery available after lost replies or background interruption.
      entry.recovered = true;
      entry.recoveredRetained = true;
      for (;;) {
        await this.observeRecoveredDirectory(entry);
        if (!['saving', 'canceling'].includes(entry.snapshot.state)) return;
        await this.pause();
      }
    } catch (error) {
      entry.recovered = true;
      entry.recoveredRetained = true;
      entry.snapshot.cleanupPending = true;
      entry.snapshot.state = 'failed';
      const message = error instanceof Error ? error.message : '';
      entry.snapshot.error = /^[A-Z][A-Z_0-9]{1,80}$/u.test(message)
        ? message
        : 'DIRECTORY_RECOVERY_PENDING';
      // A rejected acknowledgement does not prove that no file was created.
      // Do not fall into the native-save retry, cancellation or release path.
    }
  }
}
