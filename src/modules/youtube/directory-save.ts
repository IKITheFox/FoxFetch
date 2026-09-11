import {
  saveYouTubeDirectoryOutput,
  verifyYouTubeDirectoryOutput,
  type YouTubeDirectoryAllocation,
} from './directory-output';
import { YouTubeDirectoryJournal, type YouTubeDirectoryWriteRecord } from './directory-journal';

/** The owner must first wait for its writer to settle. This checks an existing
 * allocation only; missing records/files never authorize replacement writes. */
export async function recheckJournaledYouTubeDirectoryOutput(
  request: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[0],
  verifiedFile: Blob,
  options: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[2],
): Promise<YouTubeDirectoryAllocation> {
  const expected = { ...request };
  options.signal.throwIfAborted();
  const record = (await options.journal.read()).find(
    (item) => item.jobId === expected.jobId && item.kind === expected.kind,
  );
  if (!record) throw new Error('DIRECTORY_RECORD_UNAVAILABLE');
  if (
    record.handleId !== expected.handleId ||
    record.requestedName !== expected.requestedName ||
    record.size !== expected.size
  )
    throw new Error('DIRECTORY_JOURNAL_IDENTITY_CHANGED');
  if (!record.actualName || record.phase === 'intent' || record.phase === 'removed')
    throw new Error('DIRECTORY_ALLOCATION_UNCONFIRMED');
  const allocation = {
    handleId: record.handleId,
    fileName: record.actualName,
    size: record.size,
  };
  try {
    await verifyYouTubeDirectoryOutput(allocation, verifiedFile, {
      signal: options.signal,
      ...(options.store ? { store: options.store } : {}),
    });
    options.signal.throwIfAborted();
    await options.journal.put({ ...record, phase: 'verified' });
    return allocation;
  } catch (error) {
    // A previous verified checkpoint is not proof that the file still matches.
    await options.journal.put({ ...record, phase: 'unknown' });
    throw error;
  }
}

/** Internal task adapter. Existing records must be reconciled, never blindly retried. */
export async function saveJournaledYouTubeDirectoryOutput(
  request: Pick<
    YouTubeDirectoryWriteRecord,
    'jobId' | 'kind' | 'handleId' | 'requestedName' | 'size'
  >,
  verifiedFile: Blob,
  options: {
    journal: YouTubeDirectoryJournal;
    signal: AbortSignal;
    store?: Parameters<typeof saveYouTubeDirectoryOutput>[4]['store'];
  },
): Promise<YouTubeDirectoryAllocation> {
  const intent: YouTubeDirectoryWriteRecord = { ...request, phase: 'intent' };
  options.signal.throwIfAborted();
  if (!(verifiedFile instanceof Blob) || verifiedFile.size !== intent.size)
    throw new Error('DIRECTORY_SOURCE_SIZE_INVALID');
  // Atomic within the journal's queue: only one caller may reserve this output.
  await options.journal.put(intent, { createOnly: true });
  return writeReservedDirectoryOutput(intent, verifiedFile, options);
}

/** Explicit retry of an already reconciled removal, never an automatic fallback
 * from uncertain saving. The atomic reservation fences every old callback. */
export async function retryJournaledYouTubeDirectoryOutput(
  previous: YouTubeDirectoryWriteRecord,
  verifiedFile: Blob,
  options: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[2],
): Promise<YouTubeDirectoryAllocation> {
  options.signal.throwIfAborted();
  if (!(verifiedFile instanceof Blob) || verifiedFile.size !== previous.size)
    throw new Error('DIRECTORY_SOURCE_SIZE_INVALID');
  const intent = await options.journal.reserveRetry(previous);
  return writeReservedDirectoryOutput(intent, verifiedFile, options);
}

async function writeReservedDirectoryOutput(
  intent: YouTubeDirectoryWriteRecord,
  verifiedFile: Blob,
  options: Parameters<typeof saveJournaledYouTubeDirectoryOutput>[2],
): Promise<YouTubeDirectoryAllocation> {
  let current = intent;
  try {
    const result = await saveYouTubeDirectoryOutput(
      { handleId: intent.handleId },
      intent.requestedName,
      verifiedFile,
      intent.size,
      {
        signal: options.signal,
        ...(options.store ? { store: options.store } : {}),
        recordAllocation: async (allocation) => {
          current = { ...intent, actualName: allocation.fileName, phase: 'allocated' };
          await options.journal.put(current);
        },
        recordRemoval: async (allocation) => {
          const removed: YouTubeDirectoryWriteRecord = {
            ...intent,
            actualName: allocation.fileName,
            phase: 'removed',
          };
          await options.journal.put(removed);
          current = removed;
        },
      },
    );
    current = { ...current, phase: 'verified' };
    await options.journal.put(current);
    return result;
  } catch (error) {
    // Failure or cancellation alone does not prove removal. Preserve even an
    // uncertain allocation for the owner's later read-only reconciliation.
    if (current.phase !== 'removed') await options.journal.put({ ...current, phase: 'unknown' });
    throw error;
  }
}
