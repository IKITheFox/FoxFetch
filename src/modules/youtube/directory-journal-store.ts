import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { assertExtensionDirectoryHandleContext } from '../downloads/directory-handle-store';
import { YouTubeDirectoryJournal } from './directory-journal';

interface DirectoryJournalDatabase extends DBSchema {
  state: { key: string; value: unknown };
}

/** Extension-owned store. A read/write transaction serializes competing saves
 * even when their JavaScript coordinators live in different contexts. */
export class YouTubeDirectoryJournalStore {
  private database?: Promise<IDBPDatabase<DirectoryJournalDatabase>>;
  private closed = false;
  constructor(
    private readonly options: { dbName?: string; enforceExtensionOrigin?: boolean } = {},
  ) {
    if (options.enforceExtensionOrigin !== false) assertExtensionDirectoryHandleContext();
  }
  private db() {
    if (this.closed) throw new Error('DIRECTORY_JOURNAL_CLOSED');
    this.database ??= openDB<DirectoryJournalDatabase>(
      this.options.dbName ?? 'foxfetch-youtube-directory-journal',
      1,
      {
        upgrade(database) {
          database.createObjectStore('state');
        },
      },
    );
    return this.database;
  }
  async read(): Promise<unknown> {
    return (await this.db()).get('state', 'journal');
  }
  async write(value: unknown): Promise<void> {
    await this.update(() => value);
  }
  async update(change: (value: unknown) => unknown): Promise<void> {
    const tx = (await this.db()).transaction('state', 'readwrite');
    try {
      const current = await tx.store.get('journal');
      const next = change(current);
      await tx.store.put(next, 'journal');
      await tx.done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Transaction may already have aborted. */
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    (await this.database)?.close();
  }
}

export function createPersistentYouTubeDirectoryJournal() {
  const store = new YouTubeDirectoryJournalStore();
  return { journal: new YouTubeDirectoryJournal(store), close: () => store.close() };
}
