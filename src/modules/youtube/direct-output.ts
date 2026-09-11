import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import type { YouTubeSelectionPlan } from './selection';
import type { YouTubeDirectSession } from './sources/direct-session';
import { acquireYouTubeDirectFile } from './sources/direct-file';
import { verifyYouTubeTrackParameters } from './track-verification';
import type { YouTubePreparationStage } from './preparation-stage';

/** Scan actual packet payloads through the end of both tracks. This is not a
 * decoder or a perceptual playback/sync test, which still needs real acceptance.
 */
export async function verifyYouTubeDirectTimeline(
  file: Blob,
  duration: number,
  signal: AbortSignal,
) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('SOURCE_DURATION_INVALID');
  signal.throwIfAborted();
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }),
  });
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const video = await input.getVideoTracks();
    const audio = await input.getAudioTracks();
    if (video.length !== 1 || audio.length !== 1) throw new Error('TRACK_IDENTITY_MISMATCH');
    const timelines: Array<{ packets: number; start: number; end: number }> = [];
    for (const track of [video[0]!, audio[0]!]) {
      let packets = 0,
        start = Infinity,
        end = -Infinity;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        signal.throwIfAborted();
        if (
          !packet.data.byteLength ||
          packet.data.byteLength !== packet.byteLength ||
          !Number.isFinite(packet.timestamp) ||
          !Number.isFinite(packet.duration) ||
          packet.duration < 0
        )
          throw new Error('SOURCE_PACKET_INCOMPLETE');
        packets++;
        start = Math.min(start, packet.timestamp);
        end = Math.max(end, packet.timestamp + packet.duration);
      }
      if (!packets || Math.abs(start) > 0.5 || Math.abs(end - duration) > 0.5)
        throw new Error('SOURCE_TIMELINE_INCOMPLETE');
      timelines.push({ packets, start, end });
    }
    if (
      Math.abs(timelines[0]!.start - timelines[1]!.start) > 0.25 ||
      Math.abs(timelines[0]!.end - timelines[1]!.end) > 0.25
    )
      throw new Error('TIMELINE_MISMATCH');
    signal.throwIfAborted();
    return timelines;
  } finally {
    signal.removeEventListener('abort', abort);
    input.dispose();
  }
}

/** Muxed sources retain their complete original file; they are never split. */
export async function prepareYouTubeDirectOutput(
  plan: YouTubeSelectionPlan,
  session: YouTubeDirectSession,
  options: {
    signal: AbortSignal;
    root?: FileSystemDirectoryHandle;
    fetch?: typeof fetch;
    onProgress?: (bytes: number) => void;
    onTotal?: (bytes: number | null) => void;
    onStage?: (stage: YouTubePreparationStage) => void;
  },
) {
  options.signal.throwIfAborted();
  if (plan.mode !== 'merge' || !plan.container) throw new Error('OUTPUT_MODE_MISMATCH');
  const sourceContainer = /^video\/(mp4|webm)(?:;|$)/u.exec(plan.video.mime)?.[1] as
    'mp4' | 'webm' | undefined;
  if (!sourceContainer || (plan.mode === 'merge' && sourceContainer !== plan.container))
    throw new Error('OUTPUT_SELECTION_MISMATCH');
  if (
    plan.video.composition !== 'muxed' ||
    plan.video.source !== 'direct-candidate' ||
    plan.video.dynamicRange !== 'unknown' ||
    plan.audio ||
    session.kind !== 'direct-file' ||
    session.videoId !== plan.videoId ||
    session.candidateId !== plan.video.id ||
    (plan.video.size !== undefined && session.expectedBytes !== plan.video.size) ||
    (plan.video.duration !== undefined && session.duration !== plan.video.duration)
  )
    throw new Error('SELECTION_CHANGED');
  const root = options.root ?? (await navigator.storage.getDirectory());
  const name = `youtube-direct-${crypto.randomUUID()}`;
  const directory = await root.getDirectoryHandle(name, { create: true });
  let disposed = false;
  const dispose = async () => {
    if (!disposed) {
      await root.removeEntry(name, { recursive: true });
      disposed = true;
    }
  };
  let stream: FileSystemWritableFileStream | undefined;
  try {
    const handle = await directory.getFileHandle(`source.${sourceContainer}`, { create: true });
    stream = await handle.createWritable();
    options.signal.throwIfAborted();
    options.onStage?.('downloading');
    const evidence = await acquireYouTubeDirectFile(session.address, {
      destination: stream,
      signal: options.signal,
      ...(session.expectedBytes === undefined ? {} : { expectedBytes: session.expectedBytes }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.onTotal ? { onTotal: options.onTotal } : {}),
    });
    options.signal.throwIfAborted();
    const file = await handle.getFile();
    if (file.size !== evidence.bytes) throw new Error('SOURCE_SIZE_MISMATCH');
    options.onStage?.('verifying-output');
    const parameters = await verifyYouTubeTrackParameters(
      { ...plan, mode: 'merge', container: sourceContainer },
      file,
      file,
      options.signal,
      'merged',
    );
    const timelines = await verifyYouTubeDirectTimeline(file, session.duration, options.signal);
    options.signal.throwIfAborted();
    return {
      mode: 'merge' as const,
      files: [file],
      parameters,
      timelines,
      publicationCommitted: false as const,
      dispose,
    };
  } catch (error) {
    await stream?.abort().catch(() => undefined);
    await dispose();
    throw error;
  }
}
