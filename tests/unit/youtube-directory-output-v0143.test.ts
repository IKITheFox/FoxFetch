// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  saveYouTubeDirectoryOutput,
  verifyYouTubeDirectoryOutput,
  assertYouTubeDirectoryAccess,
} from '../../src/modules/youtube/directory-output';
import type { StoredDirectoryHandle } from '../../src/modules/downloads/directory-handle-store';
import { YouTubeDirectoryJournal } from '../../src/modules/youtube/directory-journal';
import {
  saveJournaledYouTubeDirectoryOutput,
  recheckJournaledYouTubeDirectoryOutput,
  retryJournaledYouTubeDirectoryOutput,
} from '../../src/modules/youtube/directory-save';

const handleId = 'youtube-11111111-1111-4111-8111-111111111111';
function journal() {
  let value: unknown;
  return new YouTubeDirectoryJournal({
    read: async () => structuredClone(value),
    write: async (v) => {
      value = structuredClone(v);
    },
  });
}
const directoryRequest = {
  jobId: '22222222-2222-4222-8222-222222222222',
  kind: 'merged' as const,
  handleId,
  requestedName: 'video.mp4',
  size: 1,
};
it('writes a reserved retry once and keeps the new attempt in allocation and verification records', async () => {
  const s = setup(),
    j = journal();
  await j.put({ ...directoryRequest, phase: 'intent' });
  const previous = { ...directoryRequest, phase: 'removed' as const, actualName: 'video.mp4' };
  await j.put(previous);
  const options = { ...s.options, journal: j };
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      retryJournaledYouTubeDirectoryOutput(previous, new Blob(['a']), options),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(await j.read()).toEqual([{ ...previous, phase: 'verified', attempt: 1 }]);
  await expect(j.put(previous)).rejects.toThrow('DIRECTORY_JOURNAL_IDENTITY_CHANGED');
});
it('does not touch the directory when a retry reservation is rejected or not durably acknowledged', async () => {
  const s = setup(),
    j = journal();
  const previous = { ...directoryRequest, phase: 'removed' as const, actualName: 'video.mp4' };
  const options = { ...s.options, journal: j };
  await expect(
    retryJournaledYouTubeDirectoryOutput(previous, new Blob(['a']), options),
  ).rejects.toThrow('DIRECTORY_RETRY_REJECTED');
  vi.spyOn(j, 'reserveRetry').mockRejectedValueOnce(
    new Error('storage acknowledgement unavailable'),
  );
  await expect(
    retryJournaledYouTubeDirectoryOutput(previous, new Blob(['a']), options),
  ).rejects.toThrow('storage acknowledgement unavailable');
  expect(s.store.get).not.toHaveBeenCalled();
  expect(s.write).not.toHaveBeenCalled();
});
it('rechecks an uncertain allocation without writing, and detects later content changes', async () => {
  const s = setup();
  const j = journal();
  const file = new Blob(['a']);
  const options = { ...s.options, journal: j };
  await saveJournaledYouTubeDirectoryOutput(directoryRequest, file, options);
  await j.put({ ...(await j.read())[0]!, phase: 'unknown' });
  s.write.mockClear();
  await expect(
    recheckJournaledYouTubeDirectoryOutput(directoryRequest, file, options),
  ).resolves.toEqual({ handleId, fileName: 'video.mp4', size: 1 });
  expect((await j.read())[0]!.phase).toBe('verified');
  s.parts.splice(0, s.parts.length, new Blob(['b']));
  await expect(
    recheckJournaledYouTubeDirectoryOutput(directoryRequest, file, options),
  ).rejects.toThrow('DIRECTORY_OUTPUT_MISMATCH');
  expect((await j.read())[0]!.phase).toBe('unknown');
  expect(s.write).not.toHaveBeenCalled();
  expect(s.record.handle.removeEntry).not.toHaveBeenCalled();
});
it('does not guess filenames or create missing allocations during reconciliation', async () => {
  const s = setup();
  const j = journal();
  const options = { ...s.options, journal: j };
  const recheck = () =>
    recheckJournaledYouTubeDirectoryOutput(directoryRequest, new Blob(['a']), options);
  await expect(recheck()).rejects.toThrow('DIRECTORY_RECORD_UNAVAILABLE');
  await j.put({ ...directoryRequest, phase: 'intent' });
  await j.put({ ...directoryRequest, phase: 'unknown' });
  await expect(recheck()).rejects.toThrow('DIRECTORY_ALLOCATION_UNCONFIRMED');
  await expect(
    recheckJournaledYouTubeDirectoryOutput(
      { ...directoryRequest, requestedName: 'changed.mp4' },
      new Blob(['a']),
      options,
    ),
  ).rejects.toThrow('DIRECTORY_JOURNAL_IDENTITY_CHANGED');
  expect(s.store.get).not.toHaveBeenCalled();
  expect(s.write).not.toHaveBeenCalled();
});
function setup() {
  const parts: Blob[] = [];
  let created = false;
  const write = vi.fn(async (blob: Blob) => {
    parts.push(blob);
  });
  const close = vi.fn(async () => {});
  const requestPermission = vi.fn(async () => 'granted' as const);
  const record: StoredDirectoryHandle = {
    metadata: { handleId, name: 'Selected', selectedAt: 1 },
    handle: {
      kind: 'directory',
      name: 'Selected',
      queryPermission: vi.fn(async () => 'granted' as const),
      requestPermission,
      getDirectoryHandle: vi.fn(),
      removeEntry: vi.fn(async () => {}),
      getFileHandle: vi.fn(async (_name, options) => {
        if (!options?.create && !created) throw new DOMException('missing', 'NotFoundError');
        created = true;
        return {
          name: 'video.mp4',
          createWritable: async () => ({ write, close, abort: async () => {} }),
          getFile: async () => new File(parts, 'video.mp4', { lastModified: 1 }),
        };
      }),
    },
  };
  const store = { get: vi.fn(async () => record as StoredDirectoryHandle | undefined) };
  const recordAllocation = vi.fn(async () => {});
  const options = { store, recordAllocation, signal: new AbortController().signal };
  return { record, store, parts, recordAllocation, options, write, close, requestPermission };
}
it('checks task ownership around actual permission lookup without touching files', async () => {
  const s = setup();
  const assertCurrent = vi.fn(async () => {});
  await assertYouTubeDirectoryAccess({ handleId }, { ...s.options, assertCurrent });
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  expect(s.requestPermission).not.toHaveBeenCalled();
  expect(s.record.handle.getFileHandle).not.toHaveBeenCalled();
  expect(s.record.handle.removeEntry).not.toHaveBeenCalled();
});
it('rejects a changed source page or revoked permission before directory use', async () => {
  const s = setup();
  const assertCurrent = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('PAGE_IDENTITY_CHANGED'));
  await expect(
    assertYouTubeDirectoryAccess({ handleId }, { ...s.options, assertCurrent }),
  ).rejects.toThrow('PAGE_IDENTITY_CHANGED');
  vi.mocked(s.record.handle.queryPermission!).mockResolvedValue('denied');
  await expect(
    assertYouTubeDirectoryAccess({ handleId }, { ...s.options, assertCurrent: async () => {} }),
  ).rejects.toThrow('DIRECTORY_PERMISSION_REQUIRED');
  expect(s.requestPermission).not.toHaveBeenCalled();
  expect(s.write).not.toHaveBeenCalled();
});
it('stops a canceled access check before even looking up the target', async () => {
  const s = setup(),
    controller = new AbortController();
  await expect(
    assertYouTubeDirectoryAccess(
      { handleId },
      {
        ...s.options,
        signal: controller.signal,
        assertCurrent: async () => {
          controller.abort();
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(s.store.get).not.toHaveBeenCalled();
});
it('records a single verified save despite concurrent duplicate task calls', async () => {
  const s = setup();
  const j = journal();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      saveJournaledYouTubeDirectoryOutput(directoryRequest, new Blob(['a']), {
        ...s.options,
        journal: j,
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(await j.read()).toEqual([
    { ...directoryRequest, phase: 'verified', actualName: 'video.mp4' },
  ]);
});
it('records confirmed removal after write failure and still refuses an automatic second save', async () => {
  const s = setup();
  const j = journal();
  s.write.mockRejectedValue(new Error('write failed'));
  const save = () =>
    saveJournaledYouTubeDirectoryOutput(directoryRequest, new Blob(['a']), {
      ...s.options,
      journal: j,
    });
  await expect(save()).rejects.toThrow('write failed');
  expect(await j.read()).toEqual([
    { ...directoryRequest, phase: 'removed', actualName: 'video.mp4' },
  ]);
  await expect(save()).rejects.toThrow('DIRECTORY_SAVE_ALREADY_REGISTERED');
  expect(s.write).toHaveBeenCalledTimes(1);
});
it('keeps unknown when removal fails instead of claiming that cancellation cleaned up', async () => {
  const s = setup(),
    j = journal();
  s.write.mockRejectedValue(new Error('write failed'));
  vi.mocked(s.record.handle.removeEntry!).mockRejectedValue(new Error('permission lost'));
  await expect(
    saveJournaledYouTubeDirectoryOutput(directoryRequest, new Blob(['a']), {
      ...s.options,
      journal: j,
    }),
  ).rejects.toThrow('DIRECTORY_CLEANUP_FAILED');
  expect((await j.read())[0]!.phase).toBe('unknown');
});
it('detects same-size content replacement without overwriting or deleting it', async () => {
  const s = setup();
  const original = new Blob(['data']);
  const allocation = await saveYouTubeDirectoryOutput(
    { handleId },
    'video.mp4',
    original,
    4,
    s.options,
  );
  s.parts.splice(0, s.parts.length, new Blob(['else']));
  await expect(verifyYouTubeDirectoryOutput(allocation, original, s.options)).rejects.toThrow(
    'DIRECTORY_OUTPUT_MISMATCH',
  );
  expect(s.record.handle.removeEntry).not.toHaveBeenCalled();
  expect(s.write).toHaveBeenCalledTimes(1);
  expect(vi.mocked(s.record.handle.getFileHandle!).mock.calls.slice(-1)[0]).toEqual(['video.mp4']);
});
it('does not recreate a missing allocation during verification', async () => {
  const s = setup();
  await expect(
    verifyYouTubeDirectoryOutput(
      { handleId, fileName: 'missing.mp4', size: 1 },
      new Blob(['a']),
      s.options,
    ),
  ).rejects.toMatchObject({ name: 'NotFoundError' });
  expect(s.record.handle.getFileHandle).toHaveBeenCalledWith('missing.mp4');
  expect(s.write).not.toHaveBeenCalled();
});
it('rejects escaping filenames before looking up storage', async () => {
  const s = setup();
  await expect(
    verifyYouTubeDirectoryOutput(
      { handleId, fileName: '../video.mp4', size: 1 },
      new Blob(['a']),
      s.options,
    ),
  ).rejects.toThrow();
  expect(s.store.get).not.toHaveBeenCalled();
});
it('finishes verifying an already committed output despite a late cancellation', async () => {
  const s = setup();
  const controller = new AbortController();
  s.close.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(
    saveYouTubeDirectoryOutput({ handleId }, 'video.mp4', new Blob(['a']), 1, {
      ...s.options,
      signal: controller.signal,
    }),
  ).resolves.toMatchObject({ size: 1 });
  expect(s.record.handle.removeEntry).not.toHaveBeenCalled();
});
it('writes through the recorded exact directory and records allocation before data', async () => {
  const s = setup();
  const result = await saveYouTubeDirectoryOutput(
    { handleId },
    'video.mp4',
    new Blob(['data']),
    4,
    s.options,
  );
  expect(result).toEqual({ handleId, fileName: 'video.mp4', size: 4 });
  expect(s.recordAllocation).toHaveBeenCalledWith(result);
  expect(s.recordAllocation.mock.invocationCallOrder[0]).toBeLessThan(
    s.write.mock.invocationCallOrder[0]!,
  );
  expect(s.requestPermission).not.toHaveBeenCalled();
});
it('rejects Bilibili keys and size mismatches before touching directory storage', async () => {
  const s = setup();
  await expect(
    saveYouTubeDirectoryOutput(
      { handleId: 'merge-bilibili' },
      'video.mp4',
      new Blob(['a']),
      1,
      s.options,
    ),
  ).rejects.toThrow('DIRECTORY_TARGET_INVALID');
  await expect(
    saveYouTubeDirectoryOutput({ handleId }, 'video.mp4', new Blob(['a']), 2, s.options),
  ).rejects.toThrow('DIRECTORY_SOURCE_SIZE_INVALID');
  expect(s.store.get).not.toHaveBeenCalled();
});
it('does not prompt or write when a remembered grant is revoked', async () => {
  const s = setup();
  s.record.handle.queryPermission = async () => 'prompt';
  await expect(
    saveYouTubeDirectoryOutput({ handleId }, 'video.mp4', new Blob(['a']), 1, s.options),
  ).rejects.toThrow('DIRECTORY_PERMISSION_REQUIRED');
  expect(s.requestPermission).not.toHaveBeenCalled();
  expect(s.record.handle.getFileHandle).not.toHaveBeenCalled();
});
it('keeps the target fixed while storage lookup is pending', async () => {
  const s = setup();
  const target = { handleId };
  s.store.get.mockImplementationOnce(async () => {
    target.handleId = 'youtube-22222222-2222-4222-8222-222222222222';
    return s.record;
  });
  await expect(
    saveYouTubeDirectoryOutput(target, 'video.mp4', new Blob(['a']), 1, s.options),
  ).resolves.toMatchObject({ handleId });
  expect(s.recordAllocation).toHaveBeenCalledWith({ handleId, fileName: 'video.mp4', size: 1 });
});
it('does not write when allocation persistence fails', async () => {
  const s = setup();
  s.recordAllocation.mockRejectedValue(new Error('storage failure'));
  await expect(
    saveYouTubeDirectoryOutput({ handleId }, 'video.mp4', new Blob(['a']), 1, s.options),
  ).rejects.toThrow('DIRECTORY_CHECKPOINT_FAILED');
  expect(s.write).not.toHaveBeenCalled();
});
