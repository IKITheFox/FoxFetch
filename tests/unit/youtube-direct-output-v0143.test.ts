// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import {
  prepareYouTubeDirectOutput,
  verifyYouTubeDirectTimeline,
} from '../../src/modules/youtube/direct-output';
import type { YouTubeSelectionPlan } from '../../src/modules/youtube/selection';
import type { YouTubeDirectSession } from '../../src/modules/youtube/sources/direct-session';
import { verifyYouTubeTrackParameters } from '../../src/modules/youtube/track-verification';
const state = vi.hoisted(() => ({ audioEnd: 2, incomplete: false }));
vi.mock('../../src/modules/youtube/track-verification', () => ({
  verifyYouTubeTrackParameters: vi.fn(),
}));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    async getVideoTracks() {
      return [{ kind: 'video' }];
    }
    async getAudioTracks() {
      return [{ kind: 'audio' }];
    }
    dispose() {}
  },
  EncodedPacketSink: class {
    constructor(private track: { kind: string }) {}
    async *packets() {
      yield {
        timestamp: 0,
        duration: this.track.kind === 'audio' ? state.audioEnd : 2,
        data: new Uint8Array([1]),
        byteLength: state.incomplete ? 2 : 1,
      };
    }
  },
}));
const plan = {
  videoId: 'abcdefghijk',
  mode: 'merge',
  container: 'mp4',
  videoCodec: 'avc',
  audioCodec: 'aac',
  video: {
    id: '18::muxed',
    kind: 'video',
    composition: 'muxed',
    mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
    source: 'direct-candidate',
    dynamicRange: 'unknown',
    size: 3,
    duration: 2,
  },
} as YouTubeSelectionPlan;
const session: YouTubeDirectSession = {
  kind: 'direct-file',
  videoId: plan.videoId,
  candidateId: plan.video.id,
  address: 'https://r1.googlevideo.com/videoplayback',
  duration: 2,
  expectedBytes: 3,
};
function storage() {
  const file = new File(['abc'], 'video.mp4');
  const root = {
    getDirectoryHandle: vi.fn(async () => ({
      getFileHandle: async () => ({
        createWritable: async () => new WritableStream<Uint8Array>(),
        getFile: async () => file,
      }),
    })),
    removeEntry: vi.fn(async () => {}),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('abc', { headers: { 'content-length': '3' } }));
  return {
    root,
    options: {
      signal: new AbortController().signal,
      root: root as unknown as FileSystemDirectoryHandle,
      fetch: fetcher,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.audioEnd = 2;
  state.incomplete = false;
  vi.mocked(verifyYouTubeTrackParameters).mockResolvedValue({
    completePlaybackVerified: false,
  } as never);
});
it('keeps a fully checked private file until explicit disposal without claiming browser save success', async () => {
  const s = storage();
  const result = await prepareYouTubeDirectOutput(plan, session, s.options);
  expect(result.files[0]!.size).toBe(3);
  expect(result.publicationCommitted).toBe(false);
  expect(verifyYouTubeTrackParameters).toHaveBeenCalledWith(
    plan,
    result.files[0],
    result.files[0],
    s.options.signal,
    'merged',
  );
  expect(s.root.removeEntry).not.toHaveBeenCalled();
  await result.dispose();
  await result.dispose();
  expect(s.root.removeEntry).toHaveBeenCalledTimes(1);
});
it('rejects a changed identity or mode before allocating storage or fetching', async () => {
  const s = storage();
  await expect(
    prepareYouTubeDirectOutput(plan, { ...session, candidateId: 'different' }, s.options),
  ).rejects.toThrow('SELECTION_CHANGED');
  await expect(
    prepareYouTubeDirectOutput({ ...plan, mode: 'separate' }, session, s.options),
  ).rejects.toThrow('OUTPUT_MODE_MISMATCH');
  expect(s.root.getDirectoryHandle).not.toHaveBeenCalled();
  expect(s.options.fetch).not.toHaveBeenCalled();
});
it('removes private data when actual media parameters do not match', async () => {
  const s = storage();
  vi.mocked(verifyYouTubeTrackParameters).mockRejectedValueOnce(
    new Error('OUTPUT_SELECTION_MISMATCH'),
  );
  await expect(prepareYouTubeDirectOutput(plan, session, s.options)).rejects.toThrow(
    'OUTPUT_SELECTION_MISMATCH',
  );
  expect(s.root.removeEntry).toHaveBeenCalledTimes(1);
});
it.each([1, 1.7])('rejects a truncated or mismatched audio timeline: %s', async (end) => {
  state.audioEnd = end;
  const s = storage();
  await expect(prepareYouTubeDirectOutput(plan, session, s.options)).rejects.toThrow(
    end === 1 ? 'SOURCE_TIMELINE_INCOMPLETE' : 'TIMELINE_MISMATCH',
  );
  expect(s.root.removeEntry).toHaveBeenCalledTimes(1);
});
it('rejects missing payload bytes even if all timestamps look complete', async () => {
  state.incomplete = true;
  await expect(
    verifyYouTubeDirectTimeline(new Blob(['abc']), 2, new AbortController().signal),
  ).rejects.toThrow('SOURCE_PACKET_INCOMPLETE');
});
