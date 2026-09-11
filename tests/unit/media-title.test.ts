import { describe, expect, it } from 'vitest';

import { normalizeMediaTitle } from '../../src/shared/media-title';

describe('media title normalization', () => {
  it('removes Bilibili browser chrome and its legacy cache marker', () => {
    expect(
      normalizeMediaTitle(
        '公司10个月不发工资你能撑多久不离职-网友硬撑10个月!!!终于熬不住了!_哔哩哔哩_bilibili-cache',
        'https://www.bilibili.com/video/BV1Example',
      ),
    ).toBe('公司10个月不发工资你能撑多久不离职-网友硬撑10个月!!!终于熬不住了!');
    expect(
      normalizeMediaTitle('演示视频 · 哔哩哔哩', 'https://www.bilibili.com/video/BV1Example'),
    ).toBe('演示视频');
  });

  it('removes YouTube and YouTube Music browser-title suffixes', () => {
    expect(
      normalizeMediaTitle('A finished video - YouTube', 'https://www.youtube.com/watch?v=abc'),
    ).toBe('A finished video');
    expect(
      normalizeMediaTitle(
        'A finished song — YouTube Music-cache',
        'https://music.youtube.com/watch?v=abc',
      ),
    ).toBe('A finished song');
  });

  it('does not remove title text without a matching platform and separator', () => {
    expect(
      normalizeMediaTitle('为什么我仍在使用 Bilibili', 'https://www.bilibili.com/video/BV1Example'),
    ).toBe('为什么我仍在使用 Bilibili');
    expect(
      normalizeMediaTitle('Understanding YouTube', 'https://www.youtube.com/watch?v=abc'),
    ).toBe('Understanding YouTube');
    expect(normalizeMediaTitle('CPU-cache', 'https://www.bilibili.com/video/BV1Example')).toBe(
      'CPU-cache',
    );
    expect(normalizeMediaTitle('Demo - YouTube', 'https://videos.example/watch')).toBe(
      'Demo - YouTube',
    );
  });

  it('fails closed for malformed URLs', () => {
    expect(normalizeMediaTitle('Demo - YouTube', 'not a URL')).toBe('Demo - YouTube');
  });
});
