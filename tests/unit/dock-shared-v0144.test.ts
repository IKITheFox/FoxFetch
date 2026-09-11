import { afterEach, expect, it } from 'vitest';
import { createDockMediaCard } from '../../src/shared/dock-media-card';
import { mountDockVariantControl } from '../../src/shared/dock-variant-control';
import {
  disposeYouTubeInspection,
  renderYouTubeInspection,
} from '../../src/modules/youtube/presentation';
import type { YouTubeInspection } from '../../src/modules/youtube/inspection';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  document.body.replaceChildren();
});

it('shares the dock skeleton and renders untrusted titles as text', () => {
  const view = createDockMediaCard(document, '<img onerror=alert(1)>', 'title-id');
  expect(view.card.querySelector('img')).toBeNull();
  expect(view.card.getAttribute('aria-labelledby')).toBe('title-id');
  expect(Array.from(view.card.children, (node) => node.className)).toEqual([
    'dock-product-preview',
    'dock-product-copy',
    'dock-product-actions',
  ]);
});

it('keeps exact source values, supports keyboard dismissal, and releases listeners', async () => {
  const source = document.createElement('select');
  source.setAttribute('aria-label', '编码');
  source.style.display = 'block';
  for (const [id, label] of [
    ['old-vp9', '原选择已不可用，请重新选择'],
    ['new-av1', 'AV1'],
  ]) {
    const option = document.createElement('option');
    option.value = id!;
    option.text = label!;
    source.append(option);
  }
  document.body.append(source);
  const dispose = mountDockVariantControl(source);
  cleanup.push(dispose);
  const root = source.nextElementSibling!;
  const trigger = root.querySelector<HTMLButtonElement>('[role=combobox]')!;
  const list = root.querySelector<HTMLElement>('[role=listbox]')!;
  const delegated = () => {
    list.hidden = true;
  };
  document.body.addEventListener('click', delegated);
  cleanup.push(() => document.body.removeEventListener('click', delegated));
  expect(source.hidden).toBe(true);
  expect(source.style.getPropertyValue('display')).toBe('none');
  expect(source.style.getPropertyPriority('display')).toBe('important');
  expect(trigger.textContent).toContain('原选择已不可用');
  trigger.click();
  expect(list.hidden).toBe(false);
  const options = root.querySelectorAll<HTMLButtonElement>('[role=option]');
  options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(options[1]);
  options[1]!.click();
  expect(source.value).toBe('new-av1');
  expect(list.hidden).toBe(true);
  trigger.click();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(list.hidden).toBe(true);
  source.disabled = true;
  await Promise.resolve();
  expect(trigger.disabled).toBe(true);
  dispose();
  expect(source.nextElementSibling).toBeNull();
  expect(source.hidden).toBe(false);
  expect(source.style.display).toBe('block');
});

it('places resolution and codec inside the shared card and preserves it on equivalent refresh', () => {
  const host = document.createElement('div');
  document.body.append(host);
  cleanup.push(() => disposeYouTubeInspection(host));
  const view: YouTubeInspection = {
    version: 1,
    videoId: 'abcdefghijk',
    title: '样本',
    status: 'identified',
    pageType: 'watch',
    completeDownloadVerified: false,
    transports: ['sabr'],
    candidates: [
      {
        id: '248::separate',
        kind: 'video',
        composition: 'separate',
        mime: 'video/webm; codecs="vp9"',
        width: 1920,
        height: 1080,
        fps: 59.94,
        source: 'unavailable',
        dynamicRange: 'unknown',
      },
    ],
  };
  let previews = 0;
  const layout = {
    sharedControls: 'dock' as const,
    dockPreview: () => {
      previews++;
    },
  };
  renderYouTubeInspection(host, view, undefined, layout);
  const card = host.querySelector('.dock-product')!;
  expect(card.querySelectorAll('[role=combobox]')).toHaveLength(2);
  expect(host.querySelectorAll('[role=combobox]')).toHaveLength(2);
  renderYouTubeInspection(host, { ...view }, undefined, layout);
  expect(host.querySelector('.dock-product')).toBe(card);
  expect(previews).toBe(2);
  renderYouTubeInspection(
    host,
    { ...view, videoId: 'zyxwvutsrqp', title: '下一条' },
    undefined,
    layout,
  );
  expect(host.querySelectorAll('[role=combobox]')).toHaveLength(2);
  expect(host.querySelector('.dock-product strong')?.textContent).toBe('下一条');
});
