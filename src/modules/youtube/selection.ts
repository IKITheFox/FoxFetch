import type { YouTubeCandidate, YouTubeInspection } from './inspection';

export type YouTubeVideoCodec = 'avc' | 'vp9' | 'av1';
export type YouTubeAudioCodec = 'aac' | 'opus';
export type YouTubeContainer = 'mp4' | 'webm';
export type YouTubeOutputMode = 'merge' | 'separate';
export interface YouTubeSelection {
  preference?: 'compatibility' | 'quality' | 'size';
  videoId: string;
  videoTrackId: string;
  audioTrackId?: string;
  container: 'auto' | YouTubeContainer;
  /** Omitted by older callers: keep their explicit merge policy. */
  mode?: YouTubeOutputMode;
}
export interface YouTubeSelectionPlan {
  readonly videoId: string;
  /** Display-only filename seed, captured when the plan is created. */
  readonly title?: string;
  readonly video: Readonly<YouTubeCandidate>;
  readonly audio?: Readonly<YouTubeCandidate>;
  readonly videoCodec: YouTubeVideoCodec;
  readonly audioCodec: YouTubeAudioCodec;
  readonly mode: YouTubeOutputMode;
  /** Separate outputs retain each source container; they have no shared container. */
  readonly container: YouTubeContainer | null;
  /** A selection is not evidence of acquisition or permission to publish a file. */
  readonly completeDownloadVerified: false;
}
export type YouTubePlanResult =
  { ok: true; plan: Readonly<YouTubeSelectionPlan> } | { ok: false; reason: string };

/** Parse declared codecs, never infer from itag, title or filename. */
export function youTubeCodecs(mime: string): {
  video?: YouTubeVideoCodec;
  audio?: YouTubeAudioCodec;
} {
  const tokens =
    /codecs="([^"]+)"/iu
      .exec(mime)?.[1]
      ?.split(',')
      .map((s) => s.trim().toLowerCase()) ?? [];
  const result: { video?: YouTubeVideoCodec; audio?: YouTubeAudioCodec } = {};
  for (const token of tokens) {
    if (/^avc[13](?:\.|$)/u.test(token)) result.video = 'avc';
    else if (/^(?:vp9|vp09)(?:\.|$)/u.test(token)) result.video = 'vp9';
    else if (/^av01(?:\.|$)/u.test(token)) result.video = 'av1';
    else if (/^mp4a\.40\.(?:2|5|29)$/u.test(token)) result.audio = 'aac';
    else if (token === 'opus') result.audio = 'opus';
  }
  return result;
}

/** YouTube policy only: do not change the shared Bilibili container policy. */
export function youTubeContainer(
  video: YouTubeVideoCodec,
  audio: YouTubeAudioCodec,
): YouTubeContainer | undefined {
  if ((video === 'avc' || video === 'av1') && audio === 'aac') return 'mp4';
  if ((video === 'vp9' || video === 'av1') && audio === 'opus') return 'webm';
  return undefined;
}

export function createYouTubeSelectionPlan(
  view: YouTubeInspection,
  selection: YouTubeSelection,
): YouTubePlanResult {
  const fail = (reason: string): YouTubePlanResult => ({ ok: false, reason });
  const mode = selection.mode ?? 'merge';
  if (mode !== 'merge' && mode !== 'separate') return fail('保存方式无效，请重新选择。');
  if (!['auto', 'mp4', 'webm'].includes(selection.container))
    return fail('保存格式无效，请重新选择。');
  if (
    view.status !== 'identified' ||
    view.pageType !== 'watch' ||
    !view.videoId ||
    view.videoId !== selection.videoId
  )
    return fail('视频已切换，请重新选择。');
  const matches = view.candidates.filter((c) => c.id === selection.videoTrackId);
  if (matches.length !== 1 || matches[0]?.kind !== 'video')
    return fail('所选视频轨道已失效，请重新选择。');
  const video = matches[0];
  if (video.source === 'drm') return fail('受保护的视频不支持下载。');
  if (video.dynamicRange === 'HDR-declared') return fail('尚未确认当前来源下载后能否保留 HDR。');
  const videoCodec = youTubeCodecs(video.mime).video;
  if (!videoCodec || !video.width || !video.height) return fail('视频编码或分辨率尚未确认。');
  let audio: YouTubeCandidate | undefined;
  let audioCodec: YouTubeAudioCodec | undefined;
  if (video.composition === 'muxed') {
    if (mode === 'separate') return fail('此来源已包含音频，请使用完整下载。');
    if (selection.audioTrackId) return fail('音视频一体来源不能直接替换音轨，请选择独立视频轨道。');
    audioCodec = youTubeCodecs(video.mime).audio;
  } else {
    const audioMatches = view.candidates.filter((c) => c.id === selection.audioTrackId);
    if (
      audioMatches.length !== 1 ||
      audioMatches[0]?.kind !== 'audio' ||
      audioMatches[0].composition !== 'separate'
    )
      return fail('请选择一条独立音轨。');
    audio = audioMatches[0];
    if (audio.source === 'drm') return fail('受保护的音轨不支持下载。');
    audioCodec = youTubeCodecs(audio.mime).audio;
  }
  if (!audioCodec) return fail('音频编码尚未确认。');
  const mergedContainer = youTubeContainer(videoCodec, audioCodec);
  if (mode === 'merge' && !mergedContainer)
    return fail('该编码组合暂未验证合并保存，请重新选择可无损保存的编码。');
  if (mode === 'separate' && selection.container !== 'auto')
    return fail('分别下载会保留各轨道的原始格式，请选择自动格式。');
  if (mode === 'merge' && selection.container !== 'auto' && selection.container !== mergedContainer)
    return fail(`该组合建议保存为 ${mergedContainer!.toUpperCase()}，不会自动更换编码或音轨。`);
  return {
    ok: true,
    plan: Object.freeze({
      videoId: view.videoId,
      ...(typeof view.title === 'string' ? { title: view.title.slice(0, 512) } : {}),
      video: Object.freeze({ ...video }),
      ...(audio ? { audio: Object.freeze({ ...audio }) } : {}),
      videoCodec,
      audioCodec,
      mode,
      container: mode === 'merge' ? mergedContainer! : null,
      completeDownloadVerified: false as const,
    }),
  };
}

/** Refresh may replace a URL, not the selected media or declared properties. */
export function matchesYouTubeSelection(
  plan: YouTubeSelectionPlan,
  view: YouTubeInspection,
): boolean {
  if (view.videoId !== plan.videoId || view.status !== 'identified') return false;
  const same = (expected: Readonly<YouTubeCandidate>) => {
    const candidates = view.candidates.filter((c) => c.id === expected.id);
    if (candidates.length !== 1) return false;
    const actual = candidates[0]!;
    return (
      (
        [
          'kind',
          'composition',
          'mime',
          'width',
          'height',
          'fps',
          'language',
          'audioTrackId',
          'sourceVersion',
          'sourceTags',
          'dynamicRange',
          'duration',
          'size',
        ] as const
      ).every((key) => actual[key] === expected[key]) && actual.source !== 'drm'
    );
  };
  return same(plan.video) && (!plan.audio || same(plan.audio));
}
