import { describe, expect, it } from 'vitest';

import {
  createCustomDownloadDirectoryMetadata,
  resolveChromeDownloadTarget,
  resolveDownloadTarget,
  validateDownloadRelativePath,
} from '../../src/modules/downloads/download-target';

const PAGE_URL = 'https://www.bilibili.com/video/BV1';

describe('download target policy', () => {
  it('resolves the default browser Downloads hierarchy', () => {
    expect(resolveDownloadTarget({ mode: 'downloads' }, PAGE_URL, 'video')).toEqual({
      mode: 'downloads',
      relativeDirectory: 'FoxFetch/Bilibili',
      displayPath: 'Downloads/FoxFetch/Bilibili',
      saveAs: false,
    });
    expect(
      resolveChromeDownloadTarget({ mode: 'downloads' }, PAGE_URL, 'video', 'demo.mp4'),
    ).toEqual({ filename: 'FoxFetch/Bilibili/demo.mp4', saveAs: false });
  });

  it('models ask-every-time without pretending it grants an arbitrary directory', () => {
    expect(resolveDownloadTarget({ mode: 'prompt' }, PAGE_URL, 'audio')).toMatchObject({
      mode: 'prompt',
      relativeDirectory: 'FoxFetch/Bilibili',
      displayPath: '每次询问（建议 Downloads/FoxFetch/Bilibili）',
      saveAs: true,
    });
  });

  it('shows only the custom handle name and a validated logical relative path', () => {
    const directory = createCustomDownloadDirectoryMetadata('media-root', '我的视频', 123);
    expect(
      resolveDownloadTarget(
        { mode: 'custom-directory', directory, relativeDirectory: 'FoxFetch/Bilibili/video' },
        PAGE_URL,
        'video',
      ),
    ).toEqual({
      mode: 'custom-directory',
      relativeDirectory: 'FoxFetch/Bilibili/video',
      displayPath: '我的视频/FoxFetch/Bilibili/video',
      saveAs: false,
      directory,
    });
  });

  it.each([
    '',
    '/absolute/path',
    'C:/absolute/path',
    '../escape',
    'safe/../escape',
    'safe\\ambiguous',
    'safe//empty',
    'safe/CON',
    'safe/trailing.',
    ' safe/path',
  ])('rejects unsafe relative path %j', (value) => {
    expect(() => validateDownloadRelativePath(value)).toThrow('无效的下载相对路径');
  });
});
