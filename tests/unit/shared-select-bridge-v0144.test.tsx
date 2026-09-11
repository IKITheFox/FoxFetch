import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomSelect } from '../../src/components/CustomSelect';
import { mountCustomSelect } from '../../src/components/mountCustomSelect';
import {
  disposeYouTubeInspection,
  renderYouTubeInspection,
} from '../../src/modules/youtube/presentation';

const cleanups: Array<() => void> = [];
afterEach(() => {
  act(() => cleanups.splice(0).forEach((dispose) => dispose()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('persists shared YouTube choices without acquiring media and preserves an open selector on identical refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const send = vi.fn(async () => ({ ok: true, data: null }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  const host = document.createElement('div');
  document.body.append(host);
  cleanups.push(() => disposeYouTubeInspection(host));
  const view = {
    version: 1 as const,
    videoId: 'abcdefghijk',
    pageType: 'watch' as const,
    status: 'identified' as const,
    transports: ['sabr' as const],
    completeDownloadVerified: false as const,
    candidates: [
      {
        id: '248::separate',
        kind: 'video' as const,
        composition: 'separate' as const,
        mime: 'video/webm; codecs="vp9"',
        width: 1920,
        height: 1080,
        fps: 59.94,
        source: 'unavailable' as const,
        dynamicRange: 'unknown' as const,
      },
    ],
  };
  await act(async () => {
    renderYouTubeInspection(host, view, { downloads: true, tabId: 81 }, { sharedControls: true });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.querySelectorAll('.custom-select')).toHaveLength(2);
  expect(host.querySelector('button[aria-label="音轨"]')).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="分辨率"]')!;
  await act(async () => trigger.click());
  const list = document.querySelector('[role=listbox]');
  act(() =>
    renderYouTubeInspection(
      host,
      { ...view },
      { downloads: true, tabId: 81 },
      { sharedControls: true },
    ),
  );
  expect(document.querySelector('[role=listbox]')).toBe(list);
  await act(async () => {
    const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(
      (node) => node.textContent === '1920×1080 · 59.94 fps',
    )!;
    option.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const messages = send.mock.calls as unknown as Array<
    [{ type: string; draft?: { quality: string } }]
  >;
  expect(
    messages.some(
      ([message]) =>
        message.type === 'SET_YOUTUBE_SELECTION' &&
        message.draft?.quality === '1920×1080 · 59.94 fps',
    ),
  ).toBe(true);
  expect(messages.some(([message]) => message.type.includes('START'))).toBe(false);
  act(() => disposeYouTubeInspection(host));
  expect(host.querySelector('.custom-select')).toBeNull();
});

it('keeps unavailable explicit values instead of displaying the first available codec', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => root.unmount());
  const change = vi.fn();
  act(() =>
    root.render(
      <CustomSelect
        preserveMissingValue
        value="av1-gone"
        options={[{ value: 'avc', label: 'AVC' }]}
        label="编码"
        onChange={change}
      />,
    ),
  );
  expect(host.textContent).toContain('原选项已不可用');
  expect(change).not.toHaveBeenCalled();
  act(() =>
    root.render(
      <CustomSelect
        value="av1-gone"
        options={[{ value: 'avc', label: 'AVC' }]}
        label="编码"
        onChange={change}
      />,
    ),
  );
  expect(host.querySelector('.custom-select__value')?.textContent).toBe('AVC');
});

it('shares controls while retaining exact values, disabled state and cleanup', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const source = document.createElement('select');
  source.setAttribute('aria-label', '视频编码／来源');
  for (const value of ['299:separate:v1', '399:separate:v2']) {
    const option = document.createElement('option');
    option.value = value;
    option.text = value.startsWith('299') ? 'AVC' : 'AV1';
    source.append(option);
  }
  document.body.append(source);
  const changed = vi.fn();
  source.addEventListener('change', changed);
  let dispose!: () => void;
  await act(async () => {
    dispose = mountCustomSelect(source);
  });
  cleanups.push(() => dispose());
  expect(source.hidden).toBe(true);
  const trigger = document.querySelector<HTMLButtonElement>('.custom-select__trigger')!;
  expect(trigger.getAttribute('aria-label')).toBe('视频编码／来源');
  await act(async () => trigger.click());
  await act(async () => document.querySelectorAll<HTMLButtonElement>('[role=option]')[1]!.click());
  expect(source.value).toBe('399:separate:v2');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(trigger.textContent).toContain('AV1');
  await act(async () => {
    source.disabled = true;
  });
  expect(trigger.disabled).toBe(true);
  await act(async () => {
    source.disabled = false;
    source.options[1]!.text = 'AV1 新名称';
  });
  expect(trigger.disabled).toBe(false);
  expect(trigger.textContent).toContain('AV1 新名称');
  act(() => dispose());
  expect(document.querySelector('.custom-select')).toBeNull();
  expect(source.hidden).toBe(false);
  expect(source.getAttribute('aria-label')).toBe('视频编码／来源');
  expect(changed).toHaveBeenCalledTimes(1);
});
