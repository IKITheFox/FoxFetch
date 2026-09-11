// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  automaticYouTubePlans,
  canTryAnotherFormat,
} from '../../src/modules/youtube/automatic-selection';
import type { YouTubeInspection } from '../../src/modules/youtube/inspection';
import {
  YouTubeBackgroundTasks,
  type YouTubeTaskRequest,
} from '../../src/modules/youtube/background-task';
import { YouTubeOffscreenExecutor } from '../../src/modules/youtube/offscreen-executor';
import type { prepareYouTubeDownload } from '../../src/modules/youtube/prepare-download';
const view: YouTubeInspection = {
  version: 1,
  videoId: 'abcdefghijk',
  pageType: 'watch',
  status: 'identified',
  transports: ['sabr'],
  completeDownloadVerified: false,
  candidates: [
    {
      id: 'avc',
      kind: 'video',
      composition: 'separate',
      mime: 'video/mp4; codecs="avc1.640028"',
      width: 1920,
      height: 1080,
      fps: 60,
      size: 1000,
      source: 'unavailable',
      dynamicRange: 'unknown',
    },
    {
      id: 'av1',
      kind: 'video',
      composition: 'separate',
      mime: 'video/mp4; codecs="av01.0.08M.08"',
      width: 1920,
      height: 1080,
      fps: 60,
      size: 500,
      source: 'unavailable',
      dynamicRange: 'unknown',
    },
    {
      id: 'aac',
      kind: 'audio',
      composition: 'separate',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      size: 100,
      language: 'en',
      defaultAudio: true,
      source: 'unavailable',
      dynamicRange: 'unknown',
    },
    {
      id: 'opus',
      kind: 'audio',
      composition: 'separate',
      mime: 'audio/webm; codecs="opus"',
      size: 80,
      language: 'en',
      source: 'unavailable',
      dynamicRange: 'unknown',
    },
    {
      id: 'ja',
      kind: 'audio',
      composition: 'separate',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      size: 1,
      language: 'ja',
      source: 'unavailable',
      dynamicRange: 'unknown',
    },
  ],
};
const plans = () => automaticYouTubePlans(view, '1920×1080 · 60 fps', 'compatibility');
it('uses compatibility or known combined size without changing resolution or language', () => {
  expect(plans()[0]!.video.id).toBe('avc');
  const small = automaticYouTubePlans(view, '1920×1080 · 60 fps', 'size')[0]!;
  expect(small.video.id).toBe('av1');
  expect(small.audio!.id).toBe('opus');
  expect(plans().some((p) => p.audio?.id === 'ja')).toBe(false);
  expect(automaticYouTubePlans(view, '1280×720 · 60 fps', 'size')).toEqual([]);
  expect(plans().map((p) => [p.video.id, p.audio?.id])).toEqual(
    automaticYouTubePlans(
      { ...view, candidates: [...view.candidates].reverse() },
      '1920×1080 · 60 fps',
      'compatibility',
    ).map((p) => [p.video.id, p.audio?.id]),
  );
});
it.each([
  'SABR_BUFFER_LIMIT',
  'SABR_NO_MEDIA',
  'SESSION_ATTESTATION_REQUIRED',
  'SOURCE_PERMISSION_REQUIRED',
  'DOWNLOAD_CANCELED',
  'OUTPUT_WRITE_FAILED',
  'SABR_NETWORK_FAILED',
])('does not mask %s by changing format', (code) => expect(canTryAnotherFormat(code)).toBe(false));
it('caps replacement to three attempts and rejects a lower-resolution plan', async () => {
  const prepare = vi
    .fn<typeof prepareYouTubeDownload>()
    .mockRejectedValue(new Error('CONTAINER_INCOMPATIBLE'));
  const executor = new YouTubeOffscreenExecutor({ prepare });
  const p = plans();
  const jobId = '11111111-1111-4111-8111-111111111111';
  const request = { jobId, plan: p[0]!, session: {} as never };
  executor.start(request);
  await vi.waitFor(() => expect(executor.status(jobId)?.state).toBe('failed'));
  await expect(
    executor.nextFormat({ ...request, plan: { ...p[1]!, video: { ...p[1]!.video, height: 720 } } }),
  ).rejects.toThrow('FORMAT_RETRY_SCOPE_CHANGED');
  await executor.nextFormat({ ...request, plan: p[1]! });
  await vi.waitFor(() => expect(executor.status(jobId)?.state).toBe('failed'));
  await executor.nextFormat({ ...request, plan: p[2]! });
  await vi.waitFor(() => expect(executor.status(jobId)?.state).toBe('failed'));
  await expect(executor.nextFormat(request)).rejects.toThrow('FORMAT_RETRY_UNAVAILABLE');
  expect(prepare).toHaveBeenCalledTimes(3);
});
it('background resets attempt progress and publishes only the successful alternative', async () => {
  const p = plans(),
    job: YouTubeTaskRequest = {
      jobId: '11111111-1111-4111-8111-111111111111',
      owner: {
        tabId: 1,
        documentId: 'doc',
        pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        navigationEpoch: 1,
        mediaEpoch: 1,
      },
      selection: {
        videoId: 'abcdefghijk',
        videoTrackId: 'avc',
        audioTrackId: 'aac',
        container: 'auto',
        mode: 'merge',
        preference: 'compatibility',
      },
    };
  const download = vi.fn(async () => 42);
  const commands: string[] = [];
  const tasks = new YouTubeBackgroundTasks({
    extensionOrigin: 'chrome-extension://example',
    plan: async () => p[0]!,
    alternatives: async () => p,
    session: async () => ({}) as never,
    download,
    search: async () => ({ state: 'complete', bytesReceived: 8, fileSize: 8 }),
    cancelDownload: async () => {},
    command: async (c) => {
      commands.push(c.type);
      return {
        jobId: job.jobId,
        publicationCommitted: false,
        readBytes: c.type === 'START' ? 100 : 8,
        state: c.type === 'START' ? 'failed' : c.type === 'RELEASE' ? 'released' : 'ready',
        ...(c.type === 'START' ? { error: 'CONTAINER_INCOMPATIBLE' } : {}),
        files:
          c.type === 'START'
            ? []
            : [
                {
                  kind: 'merged',
                  size: 8,
                  name: 'video.mp4',
                  mime: 'video/mp4',
                  url: 'blob:chrome-extension://example/file',
                },
              ],
      };
    },
  });
  tasks.start(job);
  await vi.waitFor(() => expect(tasks.status(job.jobId, job.owner)?.state).toBe('complete'));
  expect(download).toHaveBeenCalledTimes(1);
  expect(commands.filter((c) => c === 'NEXT_FORMAT')).toHaveLength(1);
  expect(tasks.status(job.jobId, job.owner)).toMatchObject({
    formatAttempt: 2,
    readBytes: 8,
    requestedSelection: { videoTrackId: 'avc' },
    selection: { videoTrackId: 'av1' },
  });
});
