import type { StreamTargetChunk } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import { createDeferredCommitFileTarget } from '../../src/modules/merge/deferred-file-target';
import type { FileSystemWritableLike } from '../../src/modules/merge/types';

function fakeWritable(options: { closeError?: Error } = {}) {
  const write = vi.fn(async (_chunk: StreamTargetChunk) => undefined);
  const close = options.closeError
    ? vi.fn(async () => Promise.reject(options.closeError))
    : vi.fn(async () => undefined);
  const abort = vi.fn(async (_reason?: unknown) => undefined);
  return {
    writable: { write, close, abort } as unknown as FileSystemWritableLike,
    write,
    close,
    abort,
  };
}

const chunk: StreamTargetChunk = {
  type: 'write',
  data: new Uint8Array([1, 2, 3]),
  position: 12,
};

describe('deferred file target', () => {
  it('does not commit when the media target closes', async () => {
    const file = fakeWritable();
    const target = createDeferredCommitFileTarget(file.writable);
    const writer = target.stream.getWriter();

    await writer.write(chunk);
    await writer.close();

    expect(file.write).toHaveBeenCalledWith(chunk);
    expect(file.close).not.toHaveBeenCalled();
    expect(file.abort).not.toHaveBeenCalled();

    await target.commit();
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.abort).not.toHaveBeenCalled();
  });

  it('aborts instead of committing a target closed by cancellation', async () => {
    const file = fakeWritable();
    const target = createDeferredCommitFileTarget(file.writable);
    const writer = target.stream.getWriter();
    const reason = new DOMException('cancelled', 'AbortError');

    await writer.write(chunk);
    await writer.close();
    await target.abort(reason);
    await target.abort(reason);

    expect(file.close).not.toHaveBeenCalled();
    expect(file.abort).toHaveBeenCalledOnce();
    expect(file.abort).toHaveBeenCalledWith(reason);
    await expect(target.commit()).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('best-effort aborts when the final commit fails', async () => {
    const failure = new Error('disk full');
    const file = fakeWritable({ closeError: failure });
    const target = createDeferredCommitFileTarget(file.writable);
    await target.stream.close();

    await expect(target.commit()).rejects.toBe(failure);
    await expect(target.abort(failure)).resolves.toBeUndefined();
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.abort).toHaveBeenCalledOnce();
    expect(file.abort).toHaveBeenCalledWith(failure);
  });

  it('refuses to publish before the media target finishes', async () => {
    const file = fakeWritable();
    const target = createDeferredCommitFileTarget(file.writable);

    await expect(target.commit()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(file.close).not.toHaveBeenCalled();
  });
});
