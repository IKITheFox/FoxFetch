import { expect, it } from 'vitest';
import {
  readYouTubeDraft,
  YouTubeSelectionPreferences,
} from '../../src/modules/youtube/selection-preferences';

const draft = {
  videoId: 'abcdefghijk',
  quality: '1920×1080 · 59.94 fps',
  codec: '248::separate:123:',
  audio: '251:en.1:separate:456:',
  container: 'auto',
  mode: 'merge',
};
function setup() {
  let data: unknown = [];
  const storage = {
    read: async () => structuredClone(data),
    write: async (value: unknown) => {
      data = structuredClone(value);
    },
  };
  return { storage, store: new YouTubeSelectionPreferences(storage) };
}
it('persists drafts across coordinator recreation without sharing tabs or videos', async () => {
  const s = setup();
  await s.store.access(1, draft.videoId, draft);
  expect(await new YouTubeSelectionPreferences(s.storage).access(1, draft.videoId)).toEqual(draft);
  expect(await s.store.access(2, draft.videoId)).toBeNull();
  expect(await s.store.access(1, 'zyxwvutsrqp')).toBeNull();
});
it('serializes writes and does not lose another tab draft', async () => {
  const s = setup();
  await Promise.all([
    s.store.access(1, draft.videoId, draft),
    s.store.access(2, draft.videoId, { ...draft, mode: 'separate' }),
  ]);
  expect(await s.store.access(1, draft.videoId)).toEqual(draft);
  expect(await s.store.access(2, draft.videoId)).toMatchObject({ mode: 'separate' });
});
it('copies only public fields and rejects malformed scope or private addresses', async () => {
  const s = setup();
  await s.store.access(1, draft.videoId, {
    ...draft,
    token: 'secret',
    url: 'https://example.com/private',
  });
  expect(JSON.stringify(await s.storage.read())).not.toMatch(/secret|https:|token/u);
  for (const bad of [
    { ...draft, codec: 'https://example.com' },
    { ...draft, container: ['auto'] },
    { ...draft, quality: '<script>' },
  ])
    expect(readYouTubeDraft(bad)).toBeNull();
  await expect(s.store.access(1, 'zyxwvutsrqp', draft)).rejects.toThrow('SELECTION_DRAFT_INVALID');
  expect(await s.store.access(1, draft.videoId)).toEqual(draft);
});
it('bounds storage to the latest 64 tab/video drafts', async () => {
  const s = setup();
  for (let tab = 0; tab < 65; tab++) await s.store.access(tab, draft.videoId, draft);
  expect(await s.store.access(0, draft.videoId)).toBeNull();
  expect(await s.store.access(64, draft.videoId)).toEqual(draft);
  expect(await s.storage.read()).toHaveLength(64);
});
