import { StreamerContext, VideoPlaybackAbrRequest } from 'googlevideo/protos';
import type { YouTubePageSession } from './page-session';

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const equal = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export type RequestContextFailure =
  | 'SESSION_REQUEST_BODY_UNAVAILABLE'
  | 'SESSION_SOURCE_MISMATCH'
  | 'SESSION_CONFIG_MISMATCH'
  | 'SESSION_FORMAT_MISMATCH'
  | 'SESSION_CLIENT_MISMATCH'
  | 'SESSION_REQUEST_DECODE_FAILED';

/** Private normal-player request only. No token generation, persistent storage,
 * page mutation or copying another video's source configuration.
 */
export function bindYouTubeRequestContext(
  session: YouTubePageSession,
  bytes: Uint8Array,
  observedUrl?: string,
  rejected?: (reason: RequestContextFailure) => void,
): YouTubePageSession | undefined {
  const reject = (reason: RequestContextFailure) => {
    rejected?.(reason);
    return undefined;
  };
  if (!bytes.length || bytes.length > 100_000) return reject('SESSION_REQUEST_BODY_UNAVAILABLE');
  try {
    let currentUrl = session.serverAbrStreamingUrl;
    if (observedUrl !== undefined) {
      const source = new URL(session.serverAbrStreamingUrl);
      const observed = new URL(observedUrl);
      const identity = source.searchParams.get('id');
      if (
        !identity ||
        observed.searchParams.get('id') !== identity ||
        observed.protocol !== 'https:' ||
        !observed.hostname.endsWith('.googlevideo.com') ||
        observed.pathname !== '/videoplayback' ||
        observed.username ||
        observed.password ||
        observed.port
      )
        return reject('SESSION_SOURCE_MISMATCH');
      currentUrl = observed.href;
    }
    const request = VideoPlaybackAbrRequest.decode(bytes);
    const expected = Uint8Array.from(
      atob(session.videoPlaybackUstreamerConfig.replace(/-/gu, '+').replace(/_/gu, '/')),
      (c) => c.charCodeAt(0),
    );
    if (
      !request.videoPlaybackUstreamerConfig ||
      !equal(request.videoPlaybackUstreamerConfig, expected)
    )
      return reject('SESSION_CONFIG_MISMATCH');
    const ids = [
      ...request.selectedFormatIds,
      ...request.preferredVideoFormatIds,
      ...request.preferredAudioFormatIds,
    ];
    if (!ids.length || ids.length > 200) return reject('SESSION_FORMAT_MISMATCH');
    let video = false;
    let audio = false;
    for (const id of ids) {
      const matches = session.formats.filter(
        (f) =>
          f.itag === id.itag &&
          f.lastModified === id.lastModified &&
          (f.xtags ?? '') === (id.xtags ?? ''),
      );
      if (matches.length !== 1) return reject('SESSION_FORMAT_MISMATCH');
      video ||= matches[0]!.mimeType?.startsWith('video/') === true;
      audio ||= matches[0]!.mimeType?.startsWith('audio/') === true;
    }
    const context = request.streamerContext;
    const client = context?.clientInfo;
    if (
      !video ||
      !audio ||
      !context ||
      !client ||
      client.clientName !== session.clientInfo.clientName ||
      client.clientVersion !== session.clientInfo.clientVersion
    )
      return reject('SESSION_CLIENT_MISMATCH');
    // The new acquisition owns its own playback position/cookie. Preserve only
    // context fields already understood by the transport, without replaying it.
    const { playbackCookie: _cookie, ...initial } = context;
    void _cookie;
    return {
      ...session,
      serverAbrStreamingUrl: currentUrl,
      clientInfo: {
        ...client,
        clientName: session.clientInfo.clientName,
        clientVersion: session.clientInfo.clientVersion,
      },
      initialStreamerContext: base64(StreamerContext.encode(initial).finish()),
      ...(context.poToken?.length ? { poToken: base64(context.poToken) } : {}),
    };
  } catch {
    return reject('SESSION_REQUEST_DECODE_FAILED');
  }
}

export type PlayerRequestObservation = Pick<
  chrome.webRequest.OnBeforeRequestDetails,
  'tabId' | 'frameId' | 'url' | 'method' | 'requestBody'
> & { documentId?: string; initiator?: string };

/** Capture only during explicit download setup; never persist request secrets. */
export function observeYouTubeSetupRequests(owner: { tabId: number; documentId: string }) {
  const pending: PlayerRequestObservation[] = [];
  let consumer: ((event: PlayerRequestObservation) => void) | undefined;
  let closed = false;
  const erase = (event: PlayerRequestObservation) => {
    for (const chunk of event.requestBody?.raw ?? [])
      if (chunk.bytes) new Uint8Array(chunk.bytes).fill(0);
  };
  const receive = (event: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    if (
      closed ||
      event.tabId !== owner.tabId ||
      event.documentId !== owner.documentId ||
      event.frameId !== 0 ||
      event.method !== 'POST'
    )
      return;
    if (consumer) {
      consumer(event);
      return;
    }
    const raw = event.requestBody?.raw;
    if (
      raw &&
      (raw.length > 16 || raw.reduce((n, c) => n + (c.bytes?.byteLength ?? 0), 0) > 100_000)
    )
      return;
    // Own copies so cleanup never changes the browser's request buffers.
    pending.push({
      tabId: event.tabId,
      ...(event.documentId ? { documentId: event.documentId } : {}),
      frameId: event.frameId,
      method: event.method,
      url: event.url,
      ...(event.initiator ? { initiator: event.initiator } : {}),
      requestBody: {
        ...(event.requestBody?.error ? { error: event.requestBody.error } : {}),
        ...(raw
          ? { raw: raw.map((c) => ({ ...c, ...(c.bytes ? { bytes: c.bytes.slice(0) } : {}) })) }
          : {}),
      },
    });
    if (pending.length > 8) erase(pending.shift()!);
  };
  chrome.webRequest.onBeforeRequest.addListener(
    receive,
    { urls: ['https://*.googlevideo.com/videoplayback*'] },
    ['requestBody'],
  );
  const close = () => {
    if (closed) return;
    closed = true;
    chrome.webRequest.onBeforeRequest.removeListener(receive);
    pending.splice(0).forEach(erase);
    consumer = undefined;
  };
  return {
    close,
    listen(callback: (event: PlayerRequestObservation) => void) {
      if (closed) throw new Error('SESSION_OBSERVATION_UNAVAILABLE');
      consumer = callback;
      for (const event of pending.splice(0)) {
        try {
          callback(event);
        } finally {
          erase(event);
        }
      }
      return close;
    },
  };
}

/** A short-lived listener only exists during the user's explicit download start.
 * The caller supplies the navigation check again after this read completes.
 */
export async function waitForYouTubeRequestContext(
  session: YouTubePageSession,
  owner: { tabId: number; documentId: string },
  options: {
    signal: AbortSignal;
    assertCurrent: () => Promise<void>;
    listen?: (listener: (event: PlayerRequestObservation) => void) => () => void;
  },
): Promise<YouTubePageSession> {
  options.signal.throwIfAborted();
  await options.assertCurrent();
  options.signal.throwIfAborted();
  const result = await new Promise<YouTubePageSession>((resolve, reject) => {
    let remove: (() => void) | undefined;
    let settled = false;
    let lastFailure: RequestContextFailure | undefined;
    const hardDeadline = Date.now() + 180_000;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(lastFailure ?? 'SESSION_CONTEXT_UNAVAILABLE'),
        Math.max(0, Math.min(milliseconds, hardDeadline - Date.now())),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      remove?.();
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(code));
    };
    const abort = () => fail('DOWNLOAD_CANCELED');
    // Give buffered/paused players time to issue another request. Relevant
    // traffic extends the observation window, never the absolute deadline.
    schedule(60_000);
    options.signal.addEventListener('abort', abort, { once: true });
    const listener = (event: PlayerRequestObservation) => {
      if (
        settled ||
        options.signal.aborted ||
        event.tabId !== owner.tabId ||
        event.documentId !== owner.documentId ||
        event.frameId !== 0 ||
        event.method !== 'POST'
      )
        return;
      try {
        const url = new URL(event.url);
        const initiator = new URL(event.initiator ?? '');
        if (
          url.protocol !== 'https:' ||
          !url.hostname.endsWith('.googlevideo.com') ||
          url.pathname !== '/videoplayback' ||
          url.port ||
          url.username ||
          url.password ||
          initiator.protocol !== 'https:' ||
          !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(initiator.hostname)
        )
          return;
        schedule(60_000);
        const chunks = event.requestBody?.raw;
        if (
          event.requestBody?.error ||
          !chunks?.length ||
          chunks.length > 16 ||
          chunks.some((chunk) => !chunk.bytes || chunk.file)
        ) {
          lastFailure = 'SESSION_REQUEST_BODY_UNAVAILABLE';
          return;
        }
        const size = chunks.reduce((sum, chunk) => sum + chunk.bytes!.byteLength, 0);
        if (size < 1 || size > 100_000) {
          lastFailure = 'SESSION_REQUEST_BODY_UNAVAILABLE';
          return;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(new Uint8Array(chunk.bytes!), offset);
          offset += chunk.bytes!.byteLength;
        }
        let bound: YouTubePageSession | undefined;
        try {
          bound = bindYouTubeRequestContext(session, bytes, event.url, (reason) => {
            lastFailure = reason;
          });
        } finally {
          bytes.fill(0);
        }
        if (!bound) return;
        settled = true;
        cleanup();
        resolve(bound);
      } catch {
        /* Irrelevant or malformed page traffic is not an execution error. */
      }
    };
    try {
      remove = (
        options.listen ??
        ((callback) => {
          const receive = (event: chrome.webRequest.OnBeforeRequestDetails) => {
            callback(event);
            return undefined;
          };
          chrome.webRequest.onBeforeRequest.addListener(
            receive,
            { urls: ['https://*.googlevideo.com/videoplayback*'] },
            ['requestBody'],
          );
          return () => chrome.webRequest.onBeforeRequest.removeListener(receive);
        })
      )(listener);
      if (settled) remove();
    } catch {
      fail('SESSION_OBSERVATION_UNAVAILABLE');
    }
  });
  options.signal.throwIfAborted();
  await options.assertCurrent();
  options.signal.throwIfAborted();
  return result;
}
