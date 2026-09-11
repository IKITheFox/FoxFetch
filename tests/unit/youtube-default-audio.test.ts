import { afterEach, expect, it, vi } from 'vitest';
import {
  renderYouTubeInspection,
  disposeYouTubeInspection,
} from '../../src/modules/youtube/presentation';
import { matchYouTubeAudio } from '../../src/modules/youtube/default-audio';
import type { YouTubeCandidate } from '../../src/modules/youtube/inspection';
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const audio = (id: string, mime = 'audio/mp4; codecs="mp4a.40.2"'): YouTubeCandidate => ({
  id,
  kind: 'audio',
  composition: 'separate',
  mime,
  source: 'unavailable',
  dynamicRange: 'unknown',
});
const video = (codec: string): YouTubeCandidate => ({
  ...audio('video'),
  kind: 'video',
  mime: `video/mp4; codecs="${codec}"`,
});
it('matches AAC for AVC and Opus for VP9 without changing the default language group', () => {
  const aac = { ...audio('aac'), language: 'ja', audioTrackId: 'ja.1', defaultAudio: true };
  const opus = {
    ...audio('opus', 'audio/webm; codecs="opus"'),
    language: 'ja',
    audioTrackId: 'ja.1',
  };
  const english = { ...audio('en'), language: 'en', audioTrackId: 'en.1' };
  expect(matchYouTubeAudio([english, aac, opus], video('avc1.640028'))).toBe(aac);
  expect(matchYouTubeAudio([english, aac, opus], video('vp9'))).toBe(opus);
});
it('does not change language for compatibility, including a protected default', () => {
  const defaultOpus = {
    ...audio('ja', 'audio/webm; codecs="opus"'),
    language: 'ja',
    defaultAudio: true,
  };
  const english = { ...audio('en'), language: 'en' };
  expect(matchYouTubeAudio([defaultOpus, english], video('avc1.640028'))).toBe(defaultOpus);
  expect(
    matchYouTubeAudio([{ ...defaultOpus, source: 'drm' }, english], video('vp9')),
  ).toBeUndefined();
});
it('uses source order for unknown defaults, prefers measured quality within a group, keeps roles separate', () => {
  const low = { ...audio('low'), size: 100, duration: 10, audioTrackId: 'ja.1' };
  const high = { ...low, id: 'high', size: 200 };
  const otherRole = { ...high, id: 'other', size: 300, audioTrackId: 'ja.2' };
  expect(matchYouTubeAudio([low, high, otherRole], video('av01.0.08M.08'))).toBe(high);
  expect(matchYouTubeAudio([audio('first'), audio('second')], video('avc1'))?.id).toBe('first');
  expect(matchYouTubeAudio([low], { ...video('avc1'), composition: 'muxed' })).toBeUndefined();
});

it('submits the default AAC exact ID from the shared two-button UI without an audio selector', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_message: { type: string; selection?: unknown }) => ({
    ok: true,
    data: null,
  }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  const host = document.createElement('div');
  document.body.append(host);
  renderYouTubeInspection(
    host,
    {
      version: 1,
      videoId: 'autoaactest1',
      status: 'identified',
      pageType: 'watch',
      transports: ['sabr'],
      completeDownloadVerified: false,
      candidates: [
        {
          id: 'video-299',
          kind: 'video',
          composition: 'separate',
          mime: 'video/mp4; codecs="avc1.640028"',
          width: 1920,
          height: 1080,
          fps: 60,
          source: 'unavailable',
          dynamicRange: 'unknown',
        },
        audio('aac-first'),
        { ...audio('aac-default'), defaultAudio: true },
        audio('opus', 'audio/webm; codecs="opus"'),
      ],
    },
    { downloads: true, tabId: 778 },
    { sharedControls: 'dock' },
  );
  await vi.advanceTimersByTimeAsync(0);
  for (const [label, value] of [
    ['分辨率', '1920×1080 · 60 fps'],
    ['下载偏好', 'compatibility'],
  ]) {
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    host
      .querySelector<HTMLButtonElement>(
        `[role="listbox"][aria-label="${label}"] [data-value="${value}"]`,
      )!
      .click();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(2);
  expect(host.querySelector('button[aria-label="音轨"]')).toBeNull();
  expect(host.textContent).not.toContain('独立视频');
  expect(host.textContent).not.toContain('查看媒体候选');
  expect(host.querySelector<HTMLElement>('[data-youtube-task-details]')!.hidden).toBe(false);
  expect(host.querySelector('.merge-meter')!.getAttribute('aria-valuenow')).toBe('0');
  expect(host.querySelector('[data-youtube-task-details]')!.textContent).toContain('当前选择');
  expect(send.mock.calls.some(([m]) => m.type.includes('START'))).toBe(false);
  host.querySelector<HTMLButtonElement>('[data-youtube-download-start]')!.click();
  expect(send.mock.calls.find(([m]) => m.type === 'START_YOUTUBE_DOWNLOAD')?.[0]).toMatchObject({
    selection: {
      videoTrackId: 'video-299',
      audioTrackId: 'aac-default',
      mode: 'merge',
      container: 'auto',
    },
  });
  disposeYouTubeInspection(host);
});
