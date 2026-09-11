import { afterEach, expect, it, vi } from 'vitest';
import { renderYouTubeInspection } from '../../src/modules/youtube/presentation';
import { youtubeUiState } from '../fixtures/youtube-v01417';
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it('updates a late thumbnail in place without losing the task, details or selection DOM', () => {
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true, data: null }) },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const view = youtubeUiState().youtube!;
  const first = { ...view };
  delete first.thumbnail;
  renderYouTubeInspection(
    host,
    first,
    { downloads: true },
    { resourceHeader: false, sharedControls: true },
  );
  const task = host.querySelector('[data-youtube-task]')!;
  const details = host.querySelector<HTMLDetailsElement>('[data-youtube-task-details]')!;
  details.open = true;
  renderYouTubeInspection(
    host,
    view,
    { downloads: true },
    { resourceHeader: false, sharedControls: true },
  );
  expect(host.querySelector('[data-youtube-task]')).toBe(task);
  expect(details.open).toBe(true);
  const preview = host.querySelector('.merge-summary-preview')!;
  const image = preview.querySelector('img')!;
  expect(image.src).toBe(view.thumbnail);
  renderYouTubeInspection(
    host,
    { ...view, thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg' },
    { downloads: true },
    { resourceHeader: false, sharedControls: true },
  );
  image.dispatchEvent(new Event('error'));
  expect(preview.querySelector('img')!.src).toContain('mqdefault');
});
