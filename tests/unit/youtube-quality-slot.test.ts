import { afterEach, expect, it } from 'vitest';
import {
  disposeYouTubeInspection,
  renderYouTubeInspection,
} from '../../src/modules/youtube/presentation';
import type { YouTubeInspection } from '../../src/modules/youtube/inspection';

afterEach(() => document.body.replaceChildren());

it('moves only resolution and preference to the card slot, preserves the same render, and clears stale fields', () => {
  const host = document.createElement('div');
  const slot = document.createElement('div');
  const retained = document.createElement('span');
  slot.append(retained);
  document.body.append(slot, host);
  const view: YouTubeInspection = {
    version: 1,
    pageType: 'watch',
    videoId: 'abcdefghijk',
    status: 'identified',
    transports: ['sabr'],
    completeDownloadVerified: false,
    candidates: [
      {
        id: 'full-vp9-track-id',
        kind: 'video',
        composition: 'separate',
        mime: 'video/webm; codecs="vp9"',
        width: 1920,
        height: 1080,
        fps: 60,
        dynamicRange: 'unknown',
        source: 'unavailable',
      },
    ],
  };
  const layout = { resourceHeader: false, qualityHost: slot };
  renderYouTubeInspection(host, view, undefined, layout);
  expect(slot.querySelectorAll('select')).toHaveLength(2);
  expect(host.querySelectorAll('fieldset > label')).toHaveLength(4);
  const quality = slot.querySelector<HTMLSelectElement>('select')!;
  quality.value = '1920×1080 · 60 fps';
  quality.dispatchEvent(new Event('change'));
  const codec = slot.querySelectorAll('select')[1]!;
  codec.value = 'size';
  codec.dispatchEvent(new Event('change'));
  renderYouTubeInspection(host, view, undefined, layout);
  expect(slot.querySelector('select')).toBe(quality);
  expect(codec.value).toBe('size');
  renderYouTubeInspection(
    host,
    { ...view, status: 'advertisement', candidates: [] },
    undefined,
    layout,
  );
  expect(slot.querySelectorAll('select')).toHaveLength(0);
  expect(slot.firstElementChild).toBe(retained);
  renderYouTubeInspection(host, { ...view, videoId: 'zyxwvutsrqp' }, undefined, layout);
  expect(slot.querySelector<HTMLSelectElement>('select')!.value).toBe('1920×1080 · 60 fps');
  disposeYouTubeInspection(host);
  expect(slot.children).toHaveLength(1);
  expect(slot.firstElementChild).toBe(retained);
});
