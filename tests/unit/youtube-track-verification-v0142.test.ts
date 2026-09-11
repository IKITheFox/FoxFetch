// @vitest-environment node
import { expect, it } from 'vitest';
import {
  BufferTarget,
  Output,
  WebMOutputFormat,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
} from 'mediabunny';
import { verifyYouTubeTrackParameters } from '../../src/modules/youtube/track-verification';
import type { YouTubeSelectionPlan } from '../../src/modules/youtube/selection';
import { prepareYouTubeSeparateOutputs } from '../../src/modules/youtube/separate-output';
import type { StagedYouTubeSelection } from '../../src/modules/youtube/sources/staged-selection';

/** Container-metadata fixtures only, deliberately not claimed to be decodable videos. */
async function blobs() {
  const videoTarget = new BufferTarget();
  const videoOutput = new Output({ format: new WebMOutputFormat(), target: videoTarget });
  const videoSource = new EncodedVideoPacketSource('vp9');
  videoOutput.addVideoTrack(videoSource, { frameRate: 1 });
  await videoOutput.start();
  await videoSource.add(new EncodedPacket(new Uint8Array([0x82, 0x49, 0x83, 0x42]), 'key', 0, 1), {
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 320, codedHeight: 180 },
  });
  await videoOutput.finalize();
  const audioTarget = new BufferTarget();
  const audioOutput = new Output({ format: new WebMOutputFormat(), target: audioTarget });
  const audioSource = new EncodedAudioPacketSource('opus');
  audioOutput.addAudioTrack(audioSource);
  await audioOutput.start();
  await audioSource.add(new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), 'key', 0, 0.02), {
    decoderConfig: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
  });
  await audioOutput.finalize();
  return [new Blob([videoTarget.buffer!]), new Blob([audioTarget.buffer!])] as const;
}
const plan = {
  mode: 'merge',
  container: 'webm',
  videoCodec: 'vp9',
  audioCodec: 'opus',
  video: { width: 320, height: 180 },
} as YouTubeSelectionPlan;
it('separate outputs preserve all bytes and use their actual WebM container', async () => {
  const [video, audio] = await blobs();
  const staged = { plan, video, audio } as StagedYouTubeSelection;
  const output = await prepareYouTubeSeparateOutputs(staged, new AbortController().signal);
  expect(output.video.name).toBe('video.webm');
  expect(output.audio.name).toBe('audio.webm');
  expect(output.video.type).toBe('video/webm');
  expect(output.audio.type).toBe('audio/webm');
  expect(new Uint8Array(await output.video.arrayBuffer())).toEqual(
    new Uint8Array(await video.arrayBuffer()),
  );
  expect(new Uint8Array(await output.audio.arrayBuffer())).toEqual(
    new Uint8Array(await audio.arrayBuffer()),
  );
});
it('reads actual container parameters without claiming playback verification', async () => {
  const [video, audio] = await blobs();
  expect(
    await verifyYouTubeTrackParameters(plan, video, audio, new AbortController().signal),
  ).toMatchObject({
    videoCodec: 'vp9',
    audioCodec: 'opus',
    width: 320,
    height: 180,
    videoPacketCount: 1,
    averageVideoFrameRate: 1,
    completePlaybackVerified: false,
  });
});
it('rejects wrong dimensions and codec despite matching file extensions', async () => {
  const [video, audio] = await blobs();
  await expect(
    verifyYouTubeTrackParameters(
      { ...plan, video: { ...plan.video, width: 1920 } },
      video,
      audio,
      new AbortController().signal,
    ),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
  await expect(
    verifyYouTubeTrackParameters(
      { ...plan, videoCodec: 'avc' },
      video,
      audio,
      new AbortController().signal,
    ),
  ).rejects.toThrow('OUTPUT_SELECTION_MISMATCH');
});
it('rejects swapped tracks and canceled verification', async () => {
  const [video, audio] = await blobs();
  await expect(
    verifyYouTubeTrackParameters(plan, audio, video, new AbortController().signal),
  ).rejects.toThrow('TRACK_IDENTITY_MISMATCH');
  const controller = new AbortController();
  controller.abort();
  await expect(
    verifyYouTubeTrackParameters(plan, video, audio, controller.signal),
  ).rejects.toThrow();
});

it('cannot certify two separate files as one merged result', async () => {
  const [video, audio] = await blobs();
  await expect(
    verifyYouTubeTrackParameters(
      { ...plan, container: 'webm' },
      video,
      audio,
      new AbortController().signal,
      'merged',
    ),
  ).rejects.toThrow('TRACK_IDENTITY_MISMATCH');
});

it('rejects a video-only file presented as a merged output', async () => {
  const [video] = await blobs();
  await expect(
    verifyYouTubeTrackParameters(
      { ...plan, container: 'webm' },
      video,
      video,
      new AbortController().signal,
      'merged',
    ),
  ).rejects.toThrow('TRACK_IDENTITY_MISMATCH');
});
