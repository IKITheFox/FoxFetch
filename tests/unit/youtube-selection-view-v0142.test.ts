import { afterEach, expect, it, vi } from 'vitest';
import {
  renderYouTubeInspection,
  disposeYouTubeInspection,
} from '../../src/modules/youtube/presentation';
import type { YouTubeInspection } from '../../src/modules/youtube/inspection';
const hosts: HTMLElement[] = [];
afterEach(() => {
  hosts.splice(0).forEach(disposeYouTubeInspection);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function view(): YouTubeInspection {
  return {
    version: 1,
    pageType: 'watch',
    videoId: 'abcdefghijk',
    status: 'identified',
    transports: ['sabr'],
    completeDownloadVerified: false,
    candidates: [
      {
        id: 'video',
        kind: 'video',
        composition: 'separate',
        mime: 'video/mp4; codecs="avc1.640028"',
        width: 1920,
        height: 1080,
        fps: 60,
        source: 'unavailable',
        dynamicRange: 'unknown',
      },
      {
        id: 'audio',
        kind: 'audio',
        composition: 'separate',
        mime: 'audio/mp4; codecs="mp4a.40.2"',
        language: 'en',
        defaultAudio: true,
        source: 'unavailable',
        dynamicRange: 'unknown',
      },
    ],
  };
}
function host() {
  const h = document.createElement('div');
  document.body.append(h);
  hosts.push(h);
  return h;
}
function source(h: HTMLElement, index: number) {
  return h.querySelectorAll<HTMLSelectElement>('fieldset select')[index]!;
}
function choose(h: HTMLElement, index: number, value: string) {
  const s = source(h, index);
  s.value = value;
  s.dispatchEvent(new Event('change'));
}
function stub() {
  let shared: unknown = null;
  const send = vi.fn(async (m: { type: string; draft?: unknown }) => {
    if (m.type === 'SET_YOUTUBE_SELECTION') shared = structuredClone(m.draft);
    return { ok: true, data: m.type === 'GET_YOUTUBE_SELECTION' ? shared : null };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  return send;
}
it('exposes resolution and preference only and keeps exact automatic IDs', async () => {
  const h = host();
  renderYouTubeInspection(h, view());
  await vi.waitFor(() =>
    expect(h.querySelectorAll('button[aria-haspopup="listbox"]')).toHaveLength(2),
  );
  expect([...source(h, 1).options].filter((o) => o.value).map((o) => o.textContent)).toEqual([
    '兼容',
    '画质',
    '体积',
  ]);
  for (const label of [...h.querySelectorAll('fieldset > label')].slice(2))
    expect((label as HTMLElement).hidden).toBe(true);
  expect(source(h, 2).value).toBe('video');
  expect(source(h, 3).value).toBe('audio');
});
it('keeps resolution and preference after refresh but binds only current IDs', () => {
  const h = host(),
    v = view();
  renderYouTubeInspection(h, v);
  choose(h, 1, 'size');
  v.candidates[0]!.id = 'new-video';
  renderYouTubeInspection(h, v);
  expect(source(h, 1).value).toBe('size');
  expect(source(h, 2).value).toBe('new-video');
  renderYouTubeInspection(h, { ...v, videoId: 'zyxwvutsrqp' });
  expect(source(h, 1).value).toBe('compatibility');
});
it('synchronizes panels without starting downloads and stops after removal', async () => {
  vi.useFakeTimers();
  const send = stub(),
    a = host(),
    b = host();
  renderYouTubeInspection(a, view(), { downloads: true, tabId: 77 });
  renderYouTubeInspection(b, view(), { downloads: true, tabId: 77 });
  await vi.advanceTimersByTimeAsync(0);
  choose(a, 1, 'size');
  await vi.advanceTimersByTimeAsync(2000);
  expect(source(b, 1).value).toBe('size');
  expect(send.mock.calls.some(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toBe(false);
  a.remove();
  b.remove();
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(send.mock.calls).toHaveLength(count);
});
it('retains the local preference after a failed save', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (m: { type: string }) => ({
        ok: m.type !== 'SET_YOUTUBE_SELECTION',
        data: null,
      })),
    },
  });
  const h = host();
  renderYouTubeInspection(h, view(), { downloads: true, tabId: 78 });
  await vi.advanceTimersByTimeAsync(0);
  choose(h, 1, 'size');
  await vi.advanceTimersByTimeAsync(6000);
  expect(source(h, 1).value).toBe('size');
  expect(h.textContent).toContain('无法保存选择');
});
it('does not apply a stale response over a newer local preference', async () => {
  vi.useFakeTimers();
  let reads = 0;
  let resolve!: (v: unknown) => void;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (m: { type: string }) =>
        m.type === 'GET_YOUTUBE_SELECTION' && ++reads > 1
          ? new Promise((r) => {
              resolve = r;
            })
          : { ok: true, data: null },
      ),
    },
  });
  const h = host();
  renderYouTubeInspection(h, view(), { downloads: true, tabId: 79 });
  await vi.advanceTimersByTimeAsync(2000);
  choose(h, 1, 'size');
  await vi.advanceTimersByTimeAsync(0);
  resolve({
    ok: true,
    data: {
      videoId: 'abcdefghijk',
      quality: '1920×1080 · 60 fps',
      codec: 'video',
      audio: 'audio',
      container: 'auto',
      mode: 'merge',
      preference: 'quality',
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(source(h, 1).value).toBe('size');
});
it('migrates obsolete manual codec and audio without starting a task', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (m: { type: string }) => ({
    ok: true,
    data:
      m.type === 'GET_YOUTUBE_SELECTION'
        ? {
            videoId: 'abcdefghijk',
            quality: '1920×1080 · 60 fps',
            codec: 'obsolete',
            audio: 'other-language',
            container: 'webm',
            mode: 'separate',
          }
        : null,
  }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  const h = host();
  renderYouTubeInspection(h, view(), { downloads: true, tabId: 80 });
  await vi.advanceTimersByTimeAsync(0);
  expect(source(h, 2).value).toBe('video');
  expect(source(h, 3).value).toBe('audio');
  expect(source(h, 5).value).toBe('auto');
  expect(send.mock.calls.some(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')).toBe(false);
});
it('rejects unsupported combinations without changing resolution or exposing split outputs', () => {
  const h = host(),
    v = view();
  v.candidates[0]!.mime = 'video/webm; codecs="vp9"';
  renderYouTubeInspection(h, v);
  expect(source(h, 0).value).toBe('1920×1080 · 60 fps');
  expect(source(h, 2).value).toBe('');
  expect(h.querySelector('[data-youtube-download-separate]')).toBeNull();
});
it('orders resolutions numerically with higher frame rates first', () => {
  const h = host(),
    v = view();
  v.candidates.push({ ...v.candidates[0]!, id: '720', width: 1280, height: 720 });
  v.candidates.push({ ...v.candidates[0]!, id: '1080-30', fps: 30 });
  renderYouTubeInspection(h, v);
  expect([...source(h, 0).options].map((o) => o.value)).toEqual([
    '',
    '1920×1080 · 60 fps',
    '1920×1080 · 30 fps',
    '1280×720 · 60 fps',
  ]);
});
it('matches Opus for VP9 with compatible same-language audio', () => {
  const h = host(),
    v = view();
  v.candidates[0]!.mime = 'video/webm; codecs="vp9"';
  v.candidates[1]!.mime = 'audio/webm; codecs="opus"';
  renderYouTubeInspection(h, v);
  expect(source(h, 3).value).toBe('audio');
  expect(h.textContent).toContain('OPUS · WEBM');
});
it('permits direct muxed sources without offering splitting', async () => {
  vi.useFakeTimers();
  stub();
  const h = host(),
    v = view();
  v.candidates = [
    {
      ...v.candidates[0]!,
      composition: 'muxed',
      source: 'direct-candidate',
      mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    },
  ];
  v.transports = ['direct'];
  renderYouTubeInspection(h, v, { downloads: true, tabId: 81 });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!.disabled).toBe(false);
  expect([...source(h, 4).options].map((o) => o.value)).not.toContain('separate');
});
