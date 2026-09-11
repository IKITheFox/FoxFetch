/** Private segment files are owned by the parent staging directory and never published. */
export function createSabrSegmentStores(directory: FileSystemDirectoryHandle, signal: AbortSignal) {
  const active = new Set<{ dispose(): Promise<void> }>();
  return {
    async create() {
      signal.throwIfAborted();
      const name = `segment-${crypto.randomUUID()}`;
      const handle = await directory.getFileHandle(name, { create: true });
      let writable: FileSystemWritableFileStream | undefined = await handle.createWritable();
      let removed = false;
      const store = {
        async write(chunk: Uint8Array) {
          signal.throwIfAborted();
          if (!writable) throw new Error('SEGMENT_MISSING');
          // Copy just the current view, not the whole retained network backing buffer.
          try {
            await writable.write(new Uint8Array(chunk));
          } catch (error) {
            // No source URLs or browser error messages enter user diagnostics.
            if (error instanceof DOMException && error.name === 'QuotaExceededError') {
              // eslint-disable-next-line preserve-caught-error
              throw new Error('SABR_STORAGE_FULL');
            }
            throw error;
          }
          signal.throwIfAborted();
        },
        async drain(emit: (chunk: Uint8Array) => Promise<void>) {
          signal.throwIfAborted();
          await writable!.close();
          writable = undefined;
          const file = await handle.getFile();
          for (let offset = 0; offset < file.size; offset += 256 * 1024) {
            signal.throwIfAborted();
            const bytes = new Uint8Array(
              await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
            );
            await emit(bytes);
          }
          await store.dispose();
        },
        async dispose() {
          if (removed) return;
          if (writable) {
            await writable.abort();
            writable = undefined;
          }
          await directory.removeEntry(name);
          removed = true;
          active.delete(store);
        },
      };
      active.add(store);
      return store;
    },
    async dispose() {
      const results = await Promise.allSettled([...active].map((store) => store.dispose()));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}
