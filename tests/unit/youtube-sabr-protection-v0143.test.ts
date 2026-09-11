// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { acquireSabrTracks } from '../../src/modules/youtube/sources/sabr';

it('stops actual protocol processing after required attestation, without retrying or publishing', async () => {
  const video = {
    itag: 299,
    lastModified: '123',
    bitrate: 2000,
    approxDurationMs: 1000,
    mimeType: 'video/mp4; codecs="avc1.64002a"',
    width: 1920,
    height: 1080,
  };
  const audio = {
    itag: 140,
    lastModified: '124',
    bitrate: 1000,
    approxDurationMs: 1000,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  };
  // UMP part 58 with StreamProtectionStatus { status: 3 }. The real library
  // and parser run here; only the network response is a local fixture.
  const network = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response(new Uint8Array([58, 2, 8, 3]), {
          headers: { 'content-type': 'application/vnd.yt-ump' },
        }),
    );
  const videoAbort = vi.fn();
  const audioAbort = vi.fn();
  const write = vi.fn();
  const destinationVideo = new WritableStream<Uint8Array>({ write, abort: videoAbort });
  const destinationAudio = new WritableStream<Uint8Array>({ write, abort: audioAbort });
  await expect(
    acquireSabrTracks(
      {
        serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?sig=private-fixture',
        videoPlaybackUstreamerConfig: 'dGVzdA==',
        clientInfo: { clientName: 1, clientVersion: 'test' },
        formats: [video, audio],
        video,
        audio,
        durationMs: 1000,
      },
      {
        video: destinationVideo,
        audio: destinationAudio,
        signal: new AbortController().signal,
        fetch: network,
      },
    ),
  ).rejects.toThrow('SESSION_ATTESTATION_REQUIRED');
  expect(network).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  expect(videoAbort).toHaveBeenCalledTimes(1);
  expect(audioAbort).toHaveBeenCalledTimes(1);
  expect(destinationVideo.locked).toBe(false);
  expect(destinationAudio.locked).toBe(false);
});
