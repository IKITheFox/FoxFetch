import {
  writtenSegmentProgress,
  createSegmentProgressTracker,
  type SegmentProgress,
} from './segment-progress';
import { waitForSabrOutput } from './output-backpressure';
import { createSabrSegmentStores } from './segment-store';
import { SabrStream, type InitializedFormat } from 'googlevideo/sabr-stream';
import type { SabrFormat } from 'googlevideo/shared-types';
import { StreamerContext, VideoPlaybackAbrRequest } from 'googlevideo/protos';

export interface SabrAcquisitionRequest {
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  clientInfo: { clientName: number; clientVersion: string };
  formats: SabrFormat[];
  video: SabrFormat;
  audio: SabrFormat;
  durationMs: number;
  poToken?: string;
  /** Current player's normal session context, private and never persisted. */
  initialStreamerContext?: string;
}

export interface SabrTrackEvidence {
  itag: number;
  segments: number;
  endSegment: number;
  durationUnits: string;
  durationTimescale: string;
  bytes: number;
}

/** Only incoming bytes, retained parser/media bytes and active writes consume this budget. */
export function assertSabrBufferBudget(
  incomingBytes: number,
  retainedMedia: number,
  writing: number,
): void {
  if (![incomingBytes, retainedMedia, writing].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error('SABR_BUFFER_LIMIT');
  if (incomingBytes + retainedMedia + writing > 64 * 1024 * 1024)
    throw new Error('SABR_BUFFER_LIMIT');
}

/** Private transport boundary: URLs and session configuration never become UI state. */
export function validateSabrEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith('.googlevideo.com') ||
    url.pathname !== '/videoplayback'
  ) {
    throw new Error('SOURCE_NOT_ALLOWED');
  }
  return url;
}

function sameFormat(left: SabrFormat, right: SabrFormat): boolean {
  return (
    left.itag === right.itag &&
    left.lastModified === right.lastModified &&
    (left.xtags ?? '') === (right.xtags ?? '') &&
    (left.audioTrackId ?? '') === (right.audioTrackId ?? '')
  );
}

/** The protocol key must uniquely identify the chosen track, including language variants. */
export function validateSabrSelection(formats: SabrFormat[], expected: SabrFormat): void {
  const matches = formats.filter(
    (f) => f.itag === expected.itag && (f.xtags ?? '') === (expected.xtags ?? ''),
  );
  if (matches.length !== 1 || !sameFormat(matches[0]!, expected))
    throw new Error('TRACK_IDENTITY_MISMATCH');
}

function matchesInitialization(format: InitializedFormat, expected: SabrFormat): boolean {
  const id = format.formatInitializationMetadata.formatId;
  return (
    !!id &&
    id.itag === expected.itag &&
    id.lastModified === expected.lastModified &&
    (id.xtags ?? '') === (expected.xtags ?? '')
  );
}

/** Completion is checked independently of the library's `finish` event. */
export function validateSabrTrack(
  format: InitializedFormat,
  expected: SabrFormat,
  bytes: number,
): SabrTrackEvidence {
  const metadata = format.formatInitializationMetadata;
  if (!matchesInitialization(format, expected)) throw new Error('TRACK_IDENTITY_MISMATCH');
  const end = Number(metadata.endSegmentNumber);
  const units = Number(metadata.durationUnits);
  const scale = Number(metadata.durationTimescale);
  if (
    !Number.isSafeInteger(end) ||
    end < 1 ||
    end > 1_000_000 ||
    !Number.isSafeInteger(units) ||
    units <= 0 ||
    !Number.isSafeInteger(scale) ||
    scale <= 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    throw new Error('SEGMENT_MISSING');
  }
  if (format.downloadedSegments.size !== end + 1) throw new Error('SEGMENT_MISSING');
  let expectedBytes = 0;
  for (let number = 0; number <= end; number++) {
    const segment = format.downloadedSegments.get(number);
    const length = Number(segment?.mediaHeader.contentLength);
    if (
      !segment ||
      segment.segmentNumber !== number ||
      !Number.isSafeInteger(length) ||
      length <= 0
    ) {
      throw new Error('SEGMENT_MISSING');
    }
    expectedBytes += length;
    if (!Number.isSafeInteger(expectedBytes)) throw new Error('SEGMENT_MISSING');
  }
  if (expectedBytes !== bytes) throw new Error('SEGMENT_MISSING');
  return {
    itag: expected.itag,
    segments: end + 1,
    endSegment: end,
    durationUnits: String(metadata.durationUnits),
    durationTimescale: String(metadata.durationTimescale),
    bytes,
  };
}

/** Initial browser transport implementation; not exposed as a download grant. */
export async function acquireSabrTracks(
  request: SabrAcquisitionRequest,
  options: {
    video: WritableStream<Uint8Array>;
    audio: WritableStream<Uint8Array>;
    signal: AbortSignal;
    segmentDirectory?: FileSystemDirectoryHandle;
    fetch?: typeof fetch;
    onProgress?: (bytes: number) => void;
    onSegments?: (progress: SegmentProgress | null) => void;
    onDiagnostic?: (code: string, value: number) => void;
    onNetwork?: (event: import('./sabr-transport').SabrNetworkEvent) => void;
  },
): Promise<{ video: SabrTrackEvidence; audio: SabrTrackEvidence }> {
  validateSabrEndpoint(request.serverAbrStreamingUrl);
  validateSabrSelection(request.formats, request.video);
  validateSabrSelection(request.formats, request.audio);
  if (
    !request.formats.some((f) => sameFormat(f, request.video)) ||
    !request.formats.some((f) => sameFormat(f, request.audio)) ||
    !request.video.mimeType?.startsWith('video/') ||
    !request.audio.mimeType?.startsWith('audio/') ||
    !request.videoPlaybackUstreamerConfig ||
    !Number.isFinite(request.durationMs) ||
    request.durationMs <= 0
  ) {
    throw new Error('TRACK_IDENTITY_MISMATCH');
  }
  options.signal.throwIfAborted();
  if (request.initialStreamerContext && request.initialStreamerContext.length > 100_000)
    throw new Error('SESSION_INVALID');
  const initialContext = request.initialStreamerContext
    ? StreamerContext.decode(
        Uint8Array.from(atob(request.initialStreamerContext), (value) => value.charCodeAt(0)),
      )
    : undefined;
  const failureController = new AbortController();
  const signal = AbortSignal.any([options.signal, failureController.signal]);
  const consumers: Promise<number>[] = [];
  const initialized: InitializedFormat[] = [];
  let total = 0;
  let writingBytes = 0;
  let attestationRequired = false;
  const network = options.fetch ?? fetch;
  const { fetchSabrResponse } = await import('./sabr-transport');
  let requestNumber = 0;
  const stream = new SabrStream({
    ...request,
    fetch: async (input, init) => {
      const url = validateSabrEndpoint(String(input));
      let body = init?.body;
      if (initialContext && body instanceof Uint8Array) {
        const message = VideoPlaybackAbrRequest.decode(body);
        const current = message.streamerContext;
        if (current) {
          message.streamerContext = {
            ...current,
            field4: initialContext.field4,
            field7: initialContext.field7,
            field8: initialContext.field8,
          };
          body = new Uint8Array(VideoPlaybackAbrRequest.encode(message).finish());
        }
      }
      const response = await fetchSabrResponse(
        url.href,
        {
          ...init,
          ...(body ? { body } : {}),
        },
        {
          signal,
          request: ++requestNumber,
          fetch: network,
          checkPermission: () =>
            chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] }),
          ...(options.onNetwork ? { onEvent: options.onNetwork } : {}),
        },
      );
      options.onDiagnostic?.('HTTP_STATUS', response.status);
      if (!response.ok || !response.body) throw new Error(`SOURCE_HTTP_${response.status}`);
      // Response totals are diagnostics only, never a memory budget.
      let received = 0;
      const bounded = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            await waitForSabrOutput(() => stream.getQueuedByteLength() + writingBytes, signal);
            received += chunk.byteLength;
            options.onDiagnostic?.('RESPONSE_BYTES', received);
            options.onDiagnostic?.('RETAINED_BYTES', stream.getBufferedByteLength());
            options.onDiagnostic?.('WRITING_BYTES', writingBytes);
            assertSabrBufferBudget(chunk.byteLength, stream.getBufferedByteLength(), writingBytes);
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(bounded, { status: response.status, headers: response.headers });
    },
  });
  const segmentStores = options.segmentDirectory
    ? createSabrSegmentStores(options.segmentDirectory, signal)
    : undefined;
  if (segmentStores)
    stream.configureBuffering({
      createSegmentStore: () => segmentStores.create(),
      waitForOutput: () =>
        waitForSabrOutput(() => stream.getQueuedByteLength() + writingBytes, signal),
    });
  if (initialContext) stream.seedSabrContexts(initialContext.sabrContexts);
  let identityFailure = false;
  stream.on('formatInitialization', (format) => {
    if (
      !matchesInitialization(format, request.video) &&
      !matchesInitialization(format, request.audio)
    ) {
      identityFailure = true;
      stream.abort();
      return;
    }
    // Reinitialization would reset the library's segment map while the output
    // already contains earlier bytes. It must not be silently concatenated.
    if (
      initialized.some(
        (previous) =>
          previous.formatInitializationMetadata.formatId?.itag ===
            format.formatInitializationMetadata.formatId?.itag &&
          (previous.formatInitializationMetadata.formatId?.xtags ?? '') ===
            (format.formatInitializationMetadata.formatId?.xtags ?? ''),
      )
    ) {
      identityFailure = true;
      stream.abort();
      return;
    }
    initialized.push(format);
  });
  stream.on('streamProtectionStatusUpdate', (status) => {
    options.onDiagnostic?.('PROTECTION_STATUS', status.status ?? 0);
    if (status.status === 3) {
      attestationRequired = true;
      // Let the library finish its current status handler before resetState.
      // A verification requirement is not a transient network error to retry.
      queueMicrotask(() => failureController.abort());
    }
  });
  const abort = () => stream.abort();
  signal.addEventListener('abort', abort, { once: true });
  const written = { video: 0, audio: 0 };
  const stableProgress = createSegmentProgressTracker();
  const publishSegments = () => {
    const video = writtenSegmentProgress(
      initialized.find((f) => matchesInitialization(f, request.video)),
      written.video,
    );
    const audio = writtenSegmentProgress(
      initialized.find((f) => matchesInitialization(f, request.audio)),
      written.audio,
    );
    options.onSegments?.(stableProgress(video && audio ? { video, audio } : null));
  };
  let lastProgressTime = 0;
  async function consume(
    source: ReadableStream<Uint8Array>,
    destination: WritableStream<Uint8Array>,
    kind: 'video' | 'audio',
  ) {
    let bytes = 0;
    const writer = destination.getWriter();
    try {
      await source.pipeTo(
        new WritableStream<Uint8Array>({
          async write(chunk) {
            writingBytes += chunk.byteLength;
            try {
              await writer.write(chunk);
            } finally {
              writingBytes -= chunk.byteLength;
            }
            bytes += chunk.byteLength;
            total += chunk.byteLength;
            options.onProgress?.(total);
            written[kind] = bytes;
            if (Date.now() - lastProgressTime < 250) return;
            lastProgressTime = Date.now();
            publishSegments();
          },
          close: () => writer.close(),
          abort: (reason) => writer.abort(reason),
        }),
        { signal },
      );
    } finally {
      writer.releaseLock();
    }
    return bytes;
  }
  try {
    const result = await stream.start({
      videoFormat: request.video,
      audioFormat: request.audio,
      // Transport owns four attempts; protocol/body failures must not replay written data.
      maxRetries: 0,
      stallDetectionMs: 10_000,
    });
    consumers.push(
      consume(result.videoStream, options.video, 'video'),
      consume(result.audioStream, options.audio, 'audio'),
    );
    const [videoBytes, audioBytes] = await Promise.all(consumers);
    publishSegments();
    if (identityFailure) throw new Error('TRACK_IDENTITY_MISMATCH');
    const video = initialized.find((f) => matchesInitialization(f, request.video));
    const audio = initialized.find((f) => matchesInitialization(f, request.audio));
    if (!video || !audio) throw new Error('SEGMENT_MISSING');
    return {
      video: validateSabrTrack(video, request.video, videoBytes!),
      audio: validateSabrTrack(audio, request.audio, audioBytes!),
    };
  } catch (error) {
    failureController.abort();
    stream.abort();
    // Let both destinations release their locks before the caller removes staging files.
    await Promise.allSettled(consumers);
    // Never serialize a protocol error containing a signed URL.
    // eslint-disable-next-line preserve-caught-error
    if (attestationRequired) throw new Error('SESSION_ATTESTATION_REQUIRED');
    // eslint-disable-next-line preserve-caught-error
    if (identityFailure) throw new Error('TRACK_IDENTITY_MISMATCH');
    const message = error instanceof Error ? error.message : '';
    if (/^[A-Z_0-9]+$/.test(message)) throw error;
    const reasons: Array<[RegExp, string]> = [
      [/Unexpected content type/, 'SABR_CONTENT_TYPE'],
      [/No valid parts/, 'SABR_NO_PARTS'],
      [/No media parts/, 'SABR_NO_MEDIA'],
      [/empty response/, 'SABR_EMPTY_RESPONSE'],
      [/Missing segments/, 'SEGMENT_MISSING'],
      [/Failed to fetch/, 'SABR_NETWORK_FAILED'],
      [/reload|Reload/, 'SESSION_REQUIRED'],
      [/attestation required/, 'SESSION_ATTESTATION_REQUIRED'],
      [/aborted|abort/i, 'SABR_ABORTED'],
    ];
    // Library errors may contain signed URLs or attestation parameters. Do not
    // attach the original error to a serializable diagnostic cause chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      reasons.find(([pattern]) => pattern.test(message))?.[1] ?? 'SABR_ACQUISITION_FAILED',
    );
  } finally {
    signal.removeEventListener('abort', abort);
    await segmentStores?.dispose();
  }
}
