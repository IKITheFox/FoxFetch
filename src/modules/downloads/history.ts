import { DOWNLOADS_KEY, MAX_DOWNLOAD_HISTORY } from '../../shared/constants';
import type { DownloadRecord } from '../../shared/types';

let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persistDownloadHistory(records: DownloadRecord[]): Promise<DownloadRecord[]> {
  const trimmed = [...records]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DOWNLOAD_HISTORY);
  await chrome.storage.local.set({ [DOWNLOADS_KEY]: trimmed });
  return trimmed;
}

export async function getDownloadHistory(): Promise<DownloadRecord[]> {
  const stored = await chrome.storage.local.get(DOWNLOADS_KEY);
  const records = stored[DOWNLOADS_KEY];
  return Array.isArray(records) ? (records as DownloadRecord[]) : [];
}

export async function saveDownloadHistory(records: DownloadRecord[]): Promise<DownloadRecord[]> {
  return serializeMutation(() => persistDownloadHistory(records));
}

export async function upsertDownloadRecord(
  record: DownloadRecord,
  options: { preserveTerminal?: boolean } = {},
): Promise<DownloadRecord[]> {
  return serializeMutation(async () => {
    const current = await getDownloadHistory();
    const index = current.findIndex((item) => item.id === record.id);
    const previous = current[index];
    // A direct download's search snapshot can arrive after its onChanged terminal event.
    // Opt in only for that reconciliation path; publication workflows retain their updates.
    if (
      options.preserveTerminal &&
      (record.state === 'queued' || record.state === 'downloading') &&
      (previous?.state === 'complete' || previous?.state === 'interrupted')
    ) {
      return current;
    }
    if (index >= 0) current[index] = record;
    else current.unshift(record);
    return persistDownloadHistory(current);
  });
}

export async function updateDownloadByChromeId(
  chromeDownloadId: number,
  patch: Partial<DownloadRecord>,
): Promise<DownloadRecord[]> {
  return serializeMutation(async () => {
    const current = await getDownloadHistory();
    const index = current.findIndex((item) => item.chromeDownloadId === chromeDownloadId);
    if (index < 0) return current;
    const previous = current[index];
    if (!previous) return current;
    current[index] = { ...previous, ...patch, updatedAt: Date.now() };
    return persistDownloadHistory(current);
  });
}

export async function clearDownloadHistory(): Promise<void> {
  await serializeMutation(() => chrome.storage.local.remove(DOWNLOADS_KEY));
}
