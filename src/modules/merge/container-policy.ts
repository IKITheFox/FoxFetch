import type { AudioCodec, VideoCodec } from 'mediabunny';
import type { ContainerRecommendation, MergeContainer, MergeContainerPreference } from './types';

const WEBM_VIDEO = new Set<VideoCodec>(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set<AudioCodec>(['opus', 'vorbis']);
const MP4_BROAD_VIDEO = new Set<VideoCodec>(['avc']);
const MP4_BROAD_AUDIO = new Set<AudioCodec>(['aac']);
const MP4_CONDITIONAL_VIDEO = new Set<VideoCodec>(['hevc', 'av1']);
const MP4_CONDITIONAL_AUDIO = new Set<AudioCodec>(['aac', 'eac3']);
const MKV_VIDEO = new Set<VideoCodec>(['avc', 'hevc', 'vp9', 'av1', 'vp8', 'prores']);
const MKV_AUDIO = new Set<AudioCodec>([
  'aac',
  'opus',
  'mp3',
  'vorbis',
  'flac',
  'ac3',
  'eac3',
  'dts',
  'pcm-s16',
  'pcm-s16be',
  'pcm-s24',
  'pcm-s24be',
  'pcm-s32',
  'pcm-s32be',
  'pcm-f32',
  'pcm-f64',
  'pcm-u8',
]);

const EXTENSIONS: Record<MergeContainer, '.mp4' | '.webm' | '.mkv'> = {
  mp4: '.mp4',
  webm: '.webm',
  mkv: '.mkv',
};

const MIME_TYPES: Record<MergeContainer, 'video/mp4' | 'video/webm' | 'video/x-matroska'> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

function result(
  container: MergeContainer,
  compatibility: ContainerRecommendation['compatibility'],
  reason: string,
  warnings: string[] = [],
): ContainerRecommendation {
  return {
    supported: true,
    container,
    extension: EXTENSIONS[container],
    mimeType: MIME_TYPES[container],
    compatibility,
    reason,
    warnings,
  };
}

function supportsMp4(video: VideoCodec, audio: AudioCodec): boolean {
  return (
    (MP4_BROAD_VIDEO.has(video) && MP4_BROAD_AUDIO.has(audio)) ||
    (MP4_CONDITIONAL_VIDEO.has(video) && MP4_CONDITIONAL_AUDIO.has(audio))
  );
}

function supportsWebM(video: VideoCodec, audio: AudioCodec): boolean {
  return WEBM_VIDEO.has(video) && WEBM_AUDIO.has(audio);
}

function requestedContainerResult(
  video: VideoCodec,
  audio: AudioCodec,
  requested: MergeContainer,
): ContainerRecommendation {
  if (requested === 'mp4' && supportsMp4(video, audio)) {
    const conditional = !MP4_BROAD_VIDEO.has(video) || !MP4_BROAD_AUDIO.has(audio);
    return result(
      'mp4',
      conditional ? 'conditional' : 'broad',
      conditional
        ? `${video.toUpperCase()} + ${audio.toUpperCase()} 可无损封装为 MP4，但设备兼容性需要验证。`
        : 'H.264/AVC + AAC 是首版兼容性最好的 MP4 无损封装组合。',
      conditional ? ['部分系统播放器可能不支持该 MP4 编码组合。'] : [],
    );
  }

  if (requested === 'webm' && supportsWebM(video, audio)) {
    return result(
      'webm',
      'broad',
      `${video.toUpperCase()} + ${audio.toUpperCase()} 可无损封装为 WebM。`,
    );
  }

  if (requested === 'mkv' && MKV_VIDEO.has(video) && MKV_AUDIO.has(audio)) {
    return result(
      'mkv',
      'limited',
      `${video.toUpperCase()} + ${audio.toUpperCase()} 可尝试无损封装为 Matroska。`,
      ['MKV 的浏览器与系统播放器兼容性低于 MP4/WebM。'],
    );
  }

  return {
    supported: false,
    compatibility: 'unsupported',
    reason: `${video.toUpperCase()} + ${audio.toUpperCase()} 不适合所选 ${requested.toUpperCase()} 容器。`,
    warnings: ['请选择推荐容器，或分别下载视频轨与音频轨。'],
  };
}

/**
 * Conservative, deterministic V1 container policy. It intentionally favors a truthful
 * "download separately" result over silently transcoding or producing a dubious file.
 */
export function recommendContainer(
  video: VideoCodec,
  audio: AudioCodec,
  preferred: MergeContainerPreference = 'auto',
): ContainerRecommendation {
  if (preferred !== 'auto') return requestedContainerResult(video, audio, preferred);

  if (video === 'avc' && audio === 'aac') {
    return result('mp4', 'broad', 'H.264/AVC + AAC：推荐无损封装为 MP4。');
  }

  if ((video === 'vp8' || video === 'vp9' || video === 'av1') && WEBM_AUDIO.has(audio)) {
    return result(
      'webm',
      'broad',
      `${video.toUpperCase()} + ${audio.toUpperCase()}：推荐无损封装为 WebM。`,
    );
  }

  if (video === 'hevc' && (audio === 'aac' || audio === 'eac3')) {
    return result('mp4', 'conditional', `HEVC + ${audio.toUpperCase()}：可无损封装为 MP4。`, [
      '输出依赖设备的 HEVC/E-AC3 解码支持。',
    ]);
  }

  if (video === 'av1' && audio === 'aac') {
    return result('mp4', 'conditional', 'AV1 + AAC：可无损封装为 MP4。', [
      '旧版系统播放器可能无法播放 AV1 MP4。',
    ]);
  }

  if (MKV_VIDEO.has(video) && MKV_AUDIO.has(audio)) {
    return result(
      'mkv',
      'limited',
      `${video.toUpperCase()} + ${audio.toUpperCase()} 没有首选网页容器；可在确认播放器兼容性后封装为 MKV。`,
      ['建议优先分别下载；MKV 仅作为高级兼容容器。'],
    );
  }

  return {
    supported: false,
    compatibility: 'unsupported',
    reason: `${video.toUpperCase()} 与 ${audio.toUpperCase()} 需要转码后才能合并，目前不支持此操作。`,
    warnings: ['请分别下载两条轨道。'],
  };
}

export function extensionForContainer(container: MergeContainer): '.mp4' | '.webm' | '.mkv' {
  return EXTENSIONS[container];
}
