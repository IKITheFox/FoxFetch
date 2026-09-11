import { describe, expect, it } from 'vitest';
import {
  floatingMediaPlatform,
  groupFloatingDockQualities,
} from '../../src/modules/playback/floating-product-ui';

describe('floating product UI', () => {
  it('groups only usable URL-free qualities by resolution and codec', () => {
    const groups = groupFloatingDockQualities([
      {
        token: '1080-avc',
        label: '1080P · AVC',
        detail: '1920×1080',
        completeAvailable: true,
        videoOnlyAvailable: true,
      },
      {
        token: '1080-hevc',
        label: '1080P · HEVC',
        detail: '1920×1080',
        completeAvailable: false,
        videoOnlyAvailable: true,
      },
      {
        token: '720-av1',
        label: '720P · AV1 · 60帧',
        detail: '1280×720 · 60 fps',
        completeAvailable: true,
        videoOnlyAvailable: true,
      },
      {
        token: 'stale',
        label: '480P · AVC',
        completeAvailable: false,
        videoOnlyAvailable: false,
      },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['1080P', '720P · 60帧']);
    expect(groups[0]?.choices.map((choice) => choice.codecLabel)).toEqual(['AVC', 'HEVC']);
    expect(groups.flatMap((group) => group.choices.map((choice) => choice.quality.token))).toEqual([
      '1080-avc',
      '1080-hevc',
      '720-av1',
    ]);
  });

  it('recognizes supported platforms without exposing the domain as card copy', () => {
    expect(floatingMediaPlatform('www.bilibili.com')).toEqual({
      kind: 'bilibili',
      label: '哔哩哔哩',
    });
    expect(floatingMediaPlatform('youtu.be')).toEqual({ kind: 'youtube', label: 'YouTube' });
    expect(floatingMediaPlatform('upos-sz-mirrorcos.bilivideo.com')).toEqual({
      kind: 'bilibili',
      label: '哔哩哔哩',
    });
    expect(floatingMediaPlatform('r1.googlevideo.com')).toEqual({
      kind: 'youtube',
      label: 'YouTube',
    });
    expect(floatingMediaPlatform('www.douyin.com')).toEqual({
      kind: 'douyin',
      label: '抖音',
    });
    expect(floatingMediaPlatform('v.qq.com')).toEqual({
      kind: 'tencent',
      label: '腾讯视频',
    });
    expect(floatingMediaPlatform('media.example.com')).toEqual({
      kind: 'generic',
      label: '当前平台',
    });
  });
});
