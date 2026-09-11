import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  permissionSummary,
  mergeSettingsDraft,
  settingsValidation,
} from '../../src/modules/storage/settings-ui';
import {
  writtenSegmentProgress,
  segmentProgressRatio,
} from '../../src/modules/youtube/sources/segment-progress';
import { isUnresolvedVideoPlaceholder } from '../../src/shared/resource-visibility';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { MediaAsset } from '../../src/shared/types';
import { openSettingsPage } from '../../src/modules/settings-entry';
import { ReadSpeedWindow } from '../../src/shared/read-speed';
import { getSettings, saveSettings } from '../../src/modules/storage/settings';
afterEach(() => vi.unstubAllGlobals());

it('calculates speed only with enough samples and resets on retry', () => {
  const speed = new ReadSpeedWindow();
  expect(speed.sample(0, 0)).toBeNull();
  expect(speed.sample(1024, 1000)).toBe(1024);
  expect(speed.sample(0, 1100)).toBeNull();
  expect(speed.sample(100, 2100)).toBe(100);
});
it('uses a shared saved location and keeps old explicit recognition disabled', async () => {
  const sync: Record<string, unknown> = {
    'foxfetch:settings': { ...structuredClone(DEFAULT_SETTINGS), youtubeEnabled: false },
  };
  const local: Record<string, unknown> = { 'foxfetch:video-save-policy': { mode: 'ask' } };
  const area = (values: Record<string, unknown>) => ({
    get: async () => ({ ...values }),
    set: async (v: Record<string, unknown>) => {
      Object.assign(values, v);
    },
  });
  vi.stubGlobal('chrome', { storage: { sync: area(sync), local: area(local) } });
  const old = await getSettings();
  expect(old.download.saveAs).toBe(true);
  expect(old.youtubeEnabled).toBe(false);
  await saveSettings({ download: { ...old.download, saveAs: false } });
  expect((await getSettings()).download.saveAs).toBe(false);
  expect((await getSettings()).youtubeEnabled).toBe(false);
});

describe('v0.14.20 unified preferences', () => {
  it.each([
    [[], '尚未授权网站'],
    [
      ['https://youtube.com/*', 'https://*.googlevideo.com/*', 'https://*.youtube-nocookie.com/*'],
      '已授权 1 个网站',
    ],
    [['https://*.youtube.com/*', 'https://*.bilibili.com/*'], '已授权 2 个网站'],
    [['https://*/*', 'http://*/*'], '已允许访问所有网站'],
    [['https://example.com/*'], '已设置部分网站访问权限'],
    [['https://*/*'], '已设置部分网站访问权限'],
  ])('summarizes %j', (origins, expected) => expect(permissionSummary(origins)).toBe(expected));
  it('merges independent nested edits', () => {
    const b = structuredClone(DEFAULT_SETTINGS),
      d = structuredClone(b),
      c = structuredClone(b);
    d.playback.defaultRate = 2;
    c.playback.seekStep = 30;
    expect(mergeSettingsDraft(b, d, c).playback).toMatchObject({ defaultRate: 2, seekStep: 30 });
  });
  it('rejects simultaneous conflicting edits', () => {
    const b = structuredClone(DEFAULT_SETTINGS),
      d = structuredClone(b),
      c = structuredClone(b);
    d.playback.defaultRate = 2;
    c.playback.defaultRate = 3;
    expect(() => mergeSettingsDraft(b, d, c)).toThrow('其他页面');
  });
  it.each(['', '../video', '{unknown}', '{title', 'video/name', 'x'.repeat(121)])(
    'rejects invalid template %s',
    (template) => {
      const s = structuredClone(DEFAULT_SETTINGS);
      s.download.filenameTemplate = template;
      // v0.14.22 no longer validates or applies this retired field.
      expect(settingsValidation(s).template).toBeUndefined();
    },
  );
  it('validates ranges without mutating the input', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.playback.defaultRate = NaN;
    s.playback.seekStep = 121;
    s.download.concurrentDownloads = 1.5;
    expect(Object.keys(settingsValidation(s))).toEqual(['rate', 'seek', 'count']);
    expect(s.download.concurrentDownloads).toBe(1.5);
  });
  it('keeps valid defaults', () => expect(settingsValidation(DEFAULT_SETTINGS)).toEqual({}));
  it('does not open an independent settings tab without a page target (v0.14.21)', async () => {
    const update = vi.fn().mockResolvedValue({}),
      create = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { getURL: () => 'chrome-extension://test/options.html' },
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([
            { id: 7, windowId: 3, url: 'chrome-extension://test/options.html#permissions' },
          ]),
        update,
        create,
      },
      windows: { update: vi.fn().mockResolvedValue({}) },
    });
    await Promise.all([openSettingsPage(), openSettingsPage()]);
    // v0.14.21 no longer reuses or creates an independent options tab.
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('written SABR segment progress', () => {
  const format = () => ({
    formatInitializationMetadata: { endSegmentNumber: '2' },
    downloadedSegments: new Map(
      [0, 1, 2].map((i) => [i, { segmentNumber: i, mediaHeader: { contentLength: '100' } }]),
    ),
  });
  it.each([
    [0, 0],
    [99, 0],
    [100, 1],
    [199, 1],
    [300, 3],
  ])('counts only complete written ranges at %i bytes', (bytes, completed) => {
    expect(writtenSegmentProgress(format(), bytes)).toEqual({ completed, total: 3 });
  });
  it('does not equate queued segments with written segments', () =>
    expect(writtenSegmentProgress(format(), 1)?.completed).toBe(0));
  it('rejects out-of-order, missing and invalid metadata', () => {
    const f = format();
    f.downloadedSegments.delete(1);
    expect(writtenSegmentProgress(f, 100)).toBeNull();
    expect(writtenSegmentProgress(undefined, 100)).toBeNull();
    expect(writtenSegmentProgress(format(), 301)).toBeNull();
    expect(
      writtenSegmentProgress({ ...format(), formatInitializationMetadata: {} }, 100),
    ).toBeNull();
  });
  it('uses the slower selected track', () => {
    expect(
      segmentProgressRatio({
        video: { completed: 1, total: 4 },
        audio: { completed: 9, total: 10 },
      }),
    ).toBe(0.25);
    expect(
      segmentProgressRatio({
        video: { completed: 8, total: 4 },
        audio: { completed: 9, total: 10 },
      }),
    ).toBeNull();
    expect(segmentProgressRatio(null)).toBeNull();
  });
});

describe('unresolved resource presentation', () => {
  const asset = {
    kind: 'video',
    url: 'blob:https://example.com/1',
    downloadable: false,
    detectedBy: ['dom'],
    filename: '待解析视频',
  } as MediaAsset;
  it('hides unresolved DOM records independent of title', () => {
    expect(isUnresolvedVideoPlaceholder(asset)).toBe(true);
    expect(isUnresolvedVideoPlaceholder({ ...asset, filename: 'Other' })).toBe(true);
    expect(
      isUnresolvedVideoPlaceholder({
        ...asset,
        mime: 'video/mp4',
        presentationRole: 'unresolved-video',
      }),
    ).toBe(true);
  });
  it('preserves same-name actual files and downloadable blobs', () => {
    expect(isUnresolvedVideoPlaceholder({ ...asset, downloadable: true })).toBe(false);
    expect(
      isUnresolvedVideoPlaceholder({
        ...asset,
        url: 'https://example.com/video.mp4',
        downloadable: true,
      }),
    ).toBe(false);
    expect(isUnresolvedVideoPlaceholder({ ...asset, detectedBy: ['network'] })).toBe(false);
  });
});
