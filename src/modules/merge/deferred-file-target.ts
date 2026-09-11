import type { StreamTargetChunk } from 'mediabunny';
import type { FileSystemWritableLike } from './types';

export interface DeferredCommitFileTarget {
  stream: WritableStream<StreamTargetChunk>;
  commit(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

type TargetState =
  'writing' | 'target-closed' | 'committing' | 'committed' | 'aborting' | 'aborted';

/**
 * Keeps File System Access API writes uncommitted while Mediabunny owns its target stream.
 *
 * StreamTarget closes the stream passed to it from both finalize() and cancel(). Passing the
 * FileSystemWritableFileStream directly would therefore publish a partial file on cancellation.
 * This bridge consumes that close locally; the caller must explicitly commit or abort the real
 * file stream after Mediabunny has released it.
 */
export function createDeferredCommitFileTarget(
  writable: FileSystemWritableLike,
): DeferredCommitFileTarget {
  let state: TargetState = 'writing';
  let commitPromise: Promise<void> | null = null;
  let abortPromise: Promise<void> | null = null;

  const stream = new WritableStream<StreamTargetChunk>({
    write: (chunk) => {
      if (state !== 'writing') {
        throw new DOMException(
          'Cannot write after the media target has closed.',
          'InvalidStateError',
        );
      }
      return writable.write(chunk);
    },
    close: () => {
      if (state === 'writing') state = 'target-closed';
    },
  });

  const abort = (reason?: unknown): Promise<void> => {
    if (state === 'committed') return Promise.resolve();
    if (state === 'aborted') return Promise.resolve();
    if (state === 'aborting') return abortPromise ?? Promise.resolve();
    if (state === 'committing') {
      return Promise.reject(
        new DOMException('The output file is already being committed.', 'InvalidStateError'),
      );
    }

    state = 'aborting';
    abortPromise = writable
      .abort(reason)
      .catch(() => undefined)
      .then(() => {
        state = 'aborted';
      });
    return abortPromise;
  };

  const commit = (): Promise<void> => {
    if (state === 'committed') return Promise.resolve();
    if (state === 'committing') return commitPromise ?? Promise.resolve();
    if (state === 'aborted' || state === 'aborting') {
      return Promise.reject(
        new DOMException('Cannot commit an aborted output file.', 'InvalidStateError'),
      );
    }
    if (state !== 'target-closed') {
      return Promise.reject(
        new DOMException(
          'The media target must finish before the output can be committed.',
          'InvalidStateError',
        ),
      );
    }

    state = 'committing';
    commitPromise = writable.close().then(
      () => {
        state = 'committed';
      },
      async (error: unknown) => {
        state = 'aborting';
        abortPromise = writable.abort(error).catch(() => undefined);
        await abortPromise;
        state = 'aborted';
        throw error;
      },
    );
    return commitPromise;
  };

  return { stream, commit, abort };
}
