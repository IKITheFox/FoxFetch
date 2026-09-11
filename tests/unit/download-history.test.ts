import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearDownloadHistory,
  getDownloadHistory,
  upsertDownloadRecord,
} from '../../src/modules/downloads/history';
import type { DownloadRecord } from '../../src/shared/types';

const values: Record<string, unknown> = {};

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: values[key] };
        },
        async set(items: Record<string, unknown>) {
          Object.assign(values, structuredClone(items));
        },
        async remove(key: string) {
          delete values[key];
        },
      },
    },
  },
});

function record(index: number): DownloadRecord {
  return {
    id: `download-${index}`,
    assetId: `asset-${index}`,
    filename: `file-${index}.mp4`,
    url: `https://media.example/file-${index}.mp4`,
    kind: 'video',
    state: 'queued',
    createdAt: index,
    updatedAt: index,
  };
}

describe('download history', () => {
  beforeEach(async () => {
    for (const key of Object.keys(values)) delete values[key];
    await clearDownloadHistory();
  });

  it('does not lose records during concurrent batch startup', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => upsertDownloadRecord(record(index))),
    );
    const history = await getDownloadHistory();
    expect(history).toHaveLength(12);
    expect(new Set(history.map((item) => item.id)).size).toBe(12);
  });

  it.each([
    ['complete', 'queued'],
    ['complete', 'downloading'],
    ['interrupted', 'queued'],
    ['interrupted', 'downloading'],
  ] as const)('preserves %s against stale %s only when requested', async (terminal, active) => {
    const saved: DownloadRecord = {
      ...record(1),
      state: terminal,
      updatedAt: 10,
      ...(terminal === 'interrupted' ? { error: 'USER_CANCELED' } : {}),
    };
    await upsertDownloadRecord(saved);
    const stored = await upsertDownloadRecord(
      { ...record(1), state: active, updatedAt: 20 },
      { preserveTerminal: true },
    );
    expect(stored).toEqual([saved]);
    expect(await getDownloadHistory()).toEqual([saved]);
  });

  it('does not change default publication updates or block a new download UUID', async () => {
    await upsertDownloadRecord({ ...record(1), state: 'complete' });
    const newTask = record(2);
    await upsertDownloadRecord(newTask, { preserveTerminal: true });
    expect((await getDownloadHistory()).find((item) => item.id === newTask.id)).toEqual(newTask);
    const replacement = { ...record(1), updatedAt: 30 };
    await upsertDownloadRecord(replacement);
    expect((await getDownloadHistory()).find((item) => item.id === replacement.id)).toEqual(
      replacement,
    );
  });
});
