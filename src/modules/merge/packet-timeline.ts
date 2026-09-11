import type { MergePacketTimelineDiagnostic } from './types';

interface PacketTime {
  timestamp: number;
  duration: number;
}
export interface PacketTimeContext {
  track: 'video' | 'audio';
  packetIndex: number;
  originSeconds: number;
  sourceTimescale: number;
  outputTimescale: number;
  outputMovieTimescale?: number;
  outputUsesEditList: boolean;
}

/** A bounded proof based on the actual muxer's integer clock, not a free tolerance knob. */
export function packetTimelineMismatch(
  source: PacketTime,
  output: PacketTime,
  context: PacketTimeContext,
): MergePacketTimelineDiagnostic | undefined {
  const normalized = source.timestamp - context.originSeconds;
  const validTimebase =
    [context.sourceTimescale, context.outputTimescale].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) &&
    (!context.outputUsesEditList ||
      (Number.isSafeInteger(context.outputMovieTimescale) &&
        Number(context.outputMovieTimescale) > 0));
  const finite = [
    source.timestamp,
    output.timestamp,
    source.duration,
    output.duration,
    context.originSeconds,
    normalized,
  ].every(Number.isFinite);
  // The muxer rounds DTS and (for video) composition offsets separately. An
  // edit's movie-clock duration is then rounded to the track clock by the
  // demuxer. Duration is the difference of adjacent presentation timestamps;
  // the common edit offset cancels. No per-track rebase or accumulated drift
  // allowance is introduced here.
  const tick = validTimebase ? 1 / context.outputTimescale : 0;
  const editError =
    context.outputUsesEditList && validTimebase
      ? 0.5 / context.outputMovieTimescale! + 0.5 * tick
      : 0;
  const timestampError = (context.track === 'video' ? 1 : 0.5) * tick + editError;
  const durationError = (context.track === 'video' ? 2 : 1) * tick;
  // A coarse clock cannot justify a material fraction of an encoded frame.
  // This safety cap only tightens the derived bound; it cannot enlarge it.
  const frameBound = Math.min(source.duration, output.duration) / 8;
  const magnitude = Math.max(
    1,
    Math.abs(normalized),
    Math.abs(output.timestamp),
    Math.abs(source.duration),
    Math.abs(output.duration),
  );
  const floatingError = 32 * Number.EPSILON * magnitude;
  const timestampTolerance = Math.min(timestampError, frameBound, 0.001) + floatingError;
  const durationTolerance = Math.min(durationError, frameBound, 0.001) + floatingError;
  const timestampDelta = output.timestamp - normalized;
  const durationDelta = output.duration - source.duration;
  const mismatch = !validTimebase
    ? 'timebase'
    : !finite || source.duration < 0 || output.duration < 0
      ? 'non-finite'
      : Math.abs(timestampDelta) > timestampTolerance
        ? 'timestamp'
        : Math.abs(durationDelta) > durationTolerance
          ? 'duration'
          : undefined;
  if (!mismatch) return undefined;
  const numeric = {
    sourceTimestampSeconds: source.timestamp,
    normalizedSourceTimestampSeconds: normalized,
    outputTimestampSeconds: output.timestamp,
    sourceDurationSeconds: source.duration,
    outputDurationSeconds: output.duration,
    originSeconds: context.originSeconds,
    sourceTimescale: context.sourceTimescale,
    outputTimescale: context.outputTimescale,
    timestampDeltaSeconds: timestampDelta,
    durationDeltaSeconds: durationDelta,
    timestampToleranceSeconds: timestampTolerance,
    durationToleranceSeconds: durationTolerance,
  };
  return {
    track: context.track,
    packetIndex: context.packetIndex,
    mismatch,
    ...Object.fromEntries(Object.entries(numeric).filter(([, value]) => Number.isFinite(value))),
  };
}
