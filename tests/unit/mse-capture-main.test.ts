import { afterEach, describe, expect, it, vi } from 'vitest';

import { installMseCaptureMainWorld } from '../../src/modules/resolver/mse-capture-main';

class FakeSourceBuffer extends EventTarget {
  private ranges: Array<[number, number]> = [];
  mode: 'segments' | 'sequence' = 'segments';
  timestampOffset = 0;
  appendWindowStart = 0;
  appendWindowEnd = Number.POSITIVE_INFINITY;

  get buffered(): TimeRanges {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start: (index: number) => ranges[index]![0],
      end: (index: number) => ranges[index]![1],
    } as TimeRanges;
  }

  setBufferedRanges(ranges: Array<[number, number]>): void {
    this.ranges = ranges.map(([start, end]) => [start, end]);
  }

  appendBuffer(_source: BufferSource): void {}
  changeType(_mime: string): void {}
  remove(_start: number, _end: number): void {}
  abort(): void {}
}

class FakeMediaSource {
  readonly buffers: FakeSourceBuffer[] = [];
  duration = 10;

  addSourceBuffer(_mime: string): SourceBuffer {
    const buffer = new FakeSourceBuffer();
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }

  endOfStream(_error?: EndOfStreamError): void {}
}

class TimelineSourceBuffer extends EventTarget {
  private ranges: Array<[number, number]> = [];
  mode: 'segments' | 'sequence' = 'segments';
  timestampOffset = 0;
  appendWindowStart = 0;
  appendWindowEnd = Number.POSITIVE_INFINITY;

  get buffered(): TimeRanges {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start: (index: number) => ranges[index]![0],
      end: (index: number) => ranges[index]![1],
    } as TimeRanges;
  }

  setBufferedRanges(ranges: Array<[number, number]>): void {
    this.ranges = ranges.map(([start, end]) => [start, end]);
  }

  appendBuffer(_source: BufferSource): void {}
  changeType(_mime: string): void {}
  remove(_start: number, _end: number): void {}
  abort(): void {}
}

class TimelineMediaSource {
  readonly buffers: TimelineSourceBuffer[] = [];
  duration = 120;

  addSourceBuffer(_mime: string): SourceBuffer {
    const buffer = new TimelineSourceBuffer();
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }

  endOfStream(_error?: EndOfStreamError): void {}
}

const originalMediaSource = Object.getOwnPropertyDescriptor(window, 'MediaSource');
const originalSourceBuffer = Object.getOwnPropertyDescriptor(window, 'SourceBuffer');
const originalPushState = window.history.pushState;
const originalReplaceState = window.history.replaceState;
const originalLocationHref = window.location.href;
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(window.URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(window.URL, 'revokeObjectURL');
const originalFakeAddSourceBuffer = FakeMediaSource.prototype.addSourceBuffer;
const originalFakeEndOfStream = FakeMediaSource.prototype.endOfStream;
const originalFakeAppendBuffer = FakeSourceBuffer.prototype.appendBuffer;
const originalFakeChangeType = FakeSourceBuffer.prototype.changeType;
const originalFakeRemove = FakeSourceBuffer.prototype.remove;
const originalFakeAbort = FakeSourceBuffer.prototype.abort;
const originalTimelineAddSourceBuffer = TimelineMediaSource.prototype.addSourceBuffer;
const originalTimelineEndOfStream = TimelineMediaSource.prototype.endOfStream;
const originalTimelineAppendBuffer = TimelineSourceBuffer.prototype.appendBuffer;
const originalTimelineChangeType = TimelineSourceBuffer.prototype.changeType;
const originalTimelineRemove = TimelineSourceBuffer.prototype.remove;
const originalTimelineAbort = TimelineSourceBuffer.prototype.abort;

function arrayBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

afterEach(() => {
  if (originalMediaSource) Object.defineProperty(window, 'MediaSource', originalMediaSource);
  else Reflect.deleteProperty(window, 'MediaSource');
  if (originalSourceBuffer) Object.defineProperty(window, 'SourceBuffer', originalSourceBuffer);
  else Reflect.deleteProperty(window, 'SourceBuffer');
  Reflect.deleteProperty(window, '__foxfetchMseCaptureHookV1__');
  window.history.pushState = originalPushState;
  window.history.replaceState = originalReplaceState;
  originalReplaceState.call(window.history, {}, '', originalLocationHref);
  FakeMediaSource.prototype.addSourceBuffer = originalFakeAddSourceBuffer;
  FakeMediaSource.prototype.endOfStream = originalFakeEndOfStream;
  FakeSourceBuffer.prototype.appendBuffer = originalFakeAppendBuffer;
  FakeSourceBuffer.prototype.changeType = originalFakeChangeType;
  FakeSourceBuffer.prototype.remove = originalFakeRemove;
  FakeSourceBuffer.prototype.abort = originalFakeAbort;
  TimelineMediaSource.prototype.addSourceBuffer = originalTimelineAddSourceBuffer;
  TimelineMediaSource.prototype.endOfStream = originalTimelineEndOfStream;
  TimelineSourceBuffer.prototype.appendBuffer = originalTimelineAppendBuffer;
  TimelineSourceBuffer.prototype.changeType = originalTimelineChangeType;
  TimelineSourceBuffer.prototype.remove = originalTimelineRemove;
  TimelineSourceBuffer.prototype.abort = originalTimelineAbort;
  if (originalCreateObjectUrl) {
    Object.defineProperty(window.URL, 'createObjectURL', originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(window.URL, 'createObjectURL');
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(window.URL, 'revokeObjectURL', originalRevokeObjectUrl);
  } else {
    Reflect.deleteProperty(window.URL, 'revokeObjectURL');
  }
  vi.restoreAllMocks();
});

describe('page-world MSE capture hook', () => {
  it('can retry after Chromium exposes MSE constructors later in document_start', () => {
    class DeferredMediaSource {}
    class DeferredSourceBuffer {}
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: DeferredMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: DeferredSourceBuffer,
    });

    expect(installMseCaptureMainWorld()).toEqual({
      version: 3,
      supported: false,
      protocolVersion: 3,
      buildId: 'foxfetch-mse-hook-v3',
      health: 'unsupported',
      installedNow: false,
    });
    expect(
      (window as Window & { __foxfetchMseCaptureHookV1__?: unknown }).__foxfetchMseCaptureHookV1__,
    ).toBeUndefined();

    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: FakeSourceBuffer,
    });

    expect(installMseCaptureMainWorld()).toMatchObject({
      health: 'ready',
      supported: true,
      installedNow: true,
    });
  });

  it('keeps a bounded bootstrap and commits active appends only after updateend', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: FakeSourceBuffer,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);

    expect(installMseCaptureMainWorld()).toMatchObject({
      version: 3,
      protocolVersion: 3,
      buildId: 'foxfetch-mse-hook-v3',
      health: 'ready',
      supported: true,
      installedNow: true,
    });
    const source = new FakeMediaSource();
    const buffer = source.addSourceBuffer(
      'video/mp4; codecs="avc1.640028"',
    ) as unknown as FakeSourceBuffer;

    buffer.appendBuffer(arrayBuffer('....ftyp....moov....vide....avc1'));
    expect(postMessage).not.toHaveBeenCalled();
    buffer.dispatchEvent(new Event('updateend'));
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'start',
          sessionId: 'capture-1',
        },
      }),
    );
    const bootstrap = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.type === 'chunk');
    expect(bootstrap).toMatchObject({
      sessionId: 'capture-1',
      groupId: 'media-source-1',
      mime: 'video/mp4; codecs="avc1.640028"',
      bootstrap: true,
      changeTypeGeneration: 0,
      timeline: {
        schemaVersion: 1,
        appendOrdinal: 1,
        changeTypeGeneration: 0,
        stateBefore: {
          readable: true,
          mode: 'segments',
          timestampOffset: 0,
          appendWindowStart: 0,
          appendWindowEnd: 'infinity',
        },
        stateAfter: {
          readable: true,
          mode: 'segments',
          timestampOffset: 0,
          appendWindowStart: 0,
          appendWindowEnd: 'infinity',
        },
        eventsBeforeAppend: [],
      },
    });
    expect(bootstrap).not.toHaveProperty('unsafeTimelineReason');

    postMessage.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'clear',
          sessionId: 'capture-1',
        },
      }),
    );
    const replayedBootstrap = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.type === 'chunk' && message.bootstrap === true);
    expect(replayedBootstrap).toMatchObject({
      sessionId: 'capture-1',
      groupId: 'media-source-1',
      sequence: 2,
    });
    expect((replayedBootstrap?.bytes as ArrayBuffer).byteLength).toBeGreaterThan(0);

    postMessage.mockClear();
    buffer.appendBuffer(arrayBuffer('media-fragment-that-will-abort'));
    expect(postMessage).not.toHaveBeenCalled();
    buffer.dispatchEvent(new Event('abort'));
    expect(postMessage).not.toHaveBeenCalled();

    buffer.appendBuffer(arrayBuffer('media-fragment-ok'));
    expect(postMessage).not.toHaveBeenCalled();
    buffer.setBufferedRanges([[0.1, 10]]);
    buffer.dispatchEvent(new Event('updateend'));
    const capturedChunks = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'chunk');
    expect(capturedChunks).toHaveLength(1);
    expect(capturedChunks[0]).toMatchObject({
      bufferedStart: 0.1,
      bufferedEnd: 10,
      bufferedRanges: [[0.1, 10]],
      duration: 10,
    });

    postMessage.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'pause',
          sessionId: 'capture-1',
        },
      }),
    );
    buffer.appendBuffer(arrayBuffer('fragment-while-paused'));
    buffer.dispatchEvent(new Event('updateend'));
    expect(
      postMessage.mock.calls.filter(([message]) => {
        const value = message as Record<string, unknown>;
        return value.type === 'chunk' && value.mime === 'video/mp4; codecs="avc1.route"';
      }),
    ).toHaveLength(0);

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'resume',
          sessionId: 'capture-1',
        },
      }),
    );
    expect(
      postMessage.mock.calls.filter(
        ([message]) => (message as Record<string, unknown>).type === 'chunk',
      ),
    ).toHaveLength(0);
    buffer.appendBuffer(arrayBuffer('fragment-after-resume'));
    buffer.dispatchEvent(new Event('updateend'));
    const resumedChunks = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'chunk');
    expect(resumedChunks).toHaveLength(1);
    expect(resumedChunks[0]?.sequence).toBe(4);

    const secondSource = new FakeMediaSource();
    const secondBuffer = secondSource.addSourceBuffer(
      'audio/mp4; codecs="mp4a.40.2"',
    ) as unknown as FakeSourceBuffer;
    secondBuffer.appendBuffer(arrayBuffer('....ftyp....moov....soun....mp4a'));
    secondBuffer.dispatchEvent(new Event('updateend'));
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message.type === 'chunk' && message.groupId === 'media-source-2'),
    ).toBeDefined();

    buffer.changeType('video/webm; codecs="vp9"');
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message.type === 'track' && message.mime === 'video/webm; codecs="vp9"'),
    ).toBeDefined();

    source.endOfStream();
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message.type === 'source-ended'),
    ).toMatchObject({ groupId: 'media-source-1' });
  });

  it('serializes replay-affecting SourceBuffer state and emits conservative unsafe events', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: TimelineMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: TimelineSourceBuffer,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const messages = (): Record<string, unknown>[] =>
      postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);

    installMseCaptureMainWorld();
    const source = new TimelineMediaSource();
    const buffer = source.addSourceBuffer(
      'video/mp4; codecs="avc1.timeline"',
    ) as unknown as TimelineSourceBuffer;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'start',
          sessionId: 'timeline-session',
        },
      }),
    );

    postMessage.mockClear();
    buffer.mode = 'sequence';
    buffer.timestampOffset = 4;
    buffer.appendWindowStart = 1;
    buffer.appendWindowEnd = 9;
    buffer.appendBuffer(arrayBuffer('timeline-fragment'));
    buffer.timestampOffset = 5;
    buffer.dispatchEvent(new Event('updateend'));

    const chunk = messages().find((message) => message.type === 'chunk');
    expect(chunk).toMatchObject({
      changeTypeGeneration: 0,
      unsafeTimelineReason: 'sequence-mode',
      timeline: {
        schemaVersion: 1,
        appendOrdinal: 1,
        changeTypeGeneration: 0,
        stateBefore: {
          readable: true,
          mode: 'sequence',
          timestampOffset: 4,
          appendWindowStart: 1,
          appendWindowEnd: 9,
        },
        stateAfter: {
          readable: true,
          mode: 'sequence',
          timestampOffset: 5,
          appendWindowStart: 1,
          appendWindowEnd: 9,
        },
      },
    });
    expect((chunk?.unsafeTimelineReasons as string[]) ?? []).toEqual(
      expect.arrayContaining(['sequence-mode', 'timestamp-offset', 'append-window']),
    );

    postMessage.mockClear();
    buffer.remove(1, 2);
    expect(messages().filter((message) => message.type === 'timeline-event')).toHaveLength(0);
    buffer.dispatchEvent(new Event('updateend'));
    expect(messages().find((message) => message.type === 'timeline-event')).toMatchObject({
      trackId: 'source-1',
      timelineEvent: {
        eventSequence: 1,
        kind: 'remove',
        start: 1,
        end: 2,
        outcome: 'completed',
        unsafeTimelineReason: 'remove',
      },
    });

    postMessage.mockClear();
    buffer.abort();
    expect(messages().find((message) => message.type === 'timeline-event')).toMatchObject({
      trackId: 'source-1',
      timelineEvent: {
        eventSequence: 2,
        kind: 'abort',
        outcome: 'completed',
        unsafeTimelineReason: 'abort',
      },
    });

    postMessage.mockClear();
    buffer.changeType('video/webm; codecs="vp9"');
    expect(messages().find((message) => message.type === 'track')).toMatchObject({
      trackId: 'source-2',
      changeTypeGeneration: 1,
    });
    expect(messages().find((message) => message.type === 'timeline-event')).toMatchObject({
      trackId: 'source-2',
      changeTypeGeneration: 1,
      timelineEvent: {
        eventSequence: 3,
        kind: 'change-type',
        changeTypeGeneration: 1,
        mime: 'video/webm; codecs="vp9"',
        unsafeTimelineReason: 'change-type',
      },
    });

    postMessage.mockClear();
    buffer.mode = 'segments';
    buffer.timestampOffset = 0;
    buffer.appendWindowStart = 0;
    buffer.appendWindowEnd = Number.POSITIVE_INFINITY;
    buffer.appendBuffer(arrayBuffer('new-codec-fragment'));
    buffer.dispatchEvent(new Event('updateend'));
    expect(messages().find((message) => message.type === 'chunk')).toMatchObject({
      trackId: 'source-2',
      changeTypeGeneration: 1,
      unsafeTimelineReasons: expect.arrayContaining(['change-type']),
      timeline: {
        appendOrdinal: 1,
        changeTypeGeneration: 1,
        eventsBeforeAppend: [expect.objectContaining({ eventSequence: 3, kind: 'change-type' })],
      },
    });

    postMessage.mockClear();
    const unreadable = source.addSourceBuffer('audio/mp4') as unknown as TimelineSourceBuffer;
    Object.defineProperty(unreadable, 'mode', {
      configurable: true,
      get: () => {
        throw new DOMException('state is unavailable', 'InvalidStateError');
      },
    });
    unreadable.appendBuffer(arrayBuffer('unreadable-state-fragment'));
    unreadable.dispatchEvent(new Event('updateend'));
    expect(messages().find((message) => message.type === 'chunk')).toMatchObject({
      trackId: 'source-3',
      unsafeTimelineReason: 'source-buffer-state-unreadable',
      timeline: {
        stateBefore: { readable: false, mode: 'unknown' },
        stateAfter: { readable: false, mode: 'unknown' },
      },
    });

    postMessage.mockClear();
    source.endOfStream('decode');
    expect(messages().find((message) => message.type === 'source-ended')).toMatchObject({
      groupId: 'media-source-1',
      unsafeTimelineReasons: expect.arrayContaining(['end-of-stream-error']),
      timelineEvent: {
        eventSequence: 4,
        kind: 'end-of-stream',
        endOfStreamError: 'decode',
        unsafeTimelineReason: 'end-of-stream-error',
      },
    });
  });

  it('replays an already-buffered beginning and excludes watch-history ranges after clear', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: TimelineMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: TimelineSourceBuffer,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const decode = (message: Record<string, unknown>): string =>
      new TextDecoder().decode(message.bytes as ArrayBuffer);
    const append = (
      buffer: TimelineSourceBuffer,
      text: string,
      ranges: Array<[number, number]>,
    ): void => {
      buffer.appendBuffer(arrayBuffer(text));
      buffer.setBufferedRanges(ranges);
      buffer.dispatchEvent(new Event('updateend'));
    };
    const control = (command: 'start' | 'clear'): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: {
            channel: 'foxfetch:mse-cache:v1',
            direction: 'agent-to-main',
            command,
            sessionId: 'capture-early',
          },
        }),
      );
    };

    expect(installMseCaptureMainWorld()).toMatchObject({
      version: 3,
      protocolVersion: 3,
      health: 'ready',
      supported: true,
    });

    // The page has already buffered its initialization segment and first 15
    // seconds before the user starts cache capture. A later seek-range must
    // not become part of the replayable beginning.
    const prebufferedSource = new TimelineMediaSource();
    const prebuffered = prebufferedSource.addSourceBuffer(
      'video/mp4; codecs="avc1.earlytest"',
    ) as unknown as TimelineSourceBuffer;
    append(prebuffered, 'pre-init', []);
    append(prebuffered, 'pre-zero-to-five', [[0.05, 5]]);
    append(prebuffered, 'pre-five-to-fifteen', [[0.05, 15]]);
    append(prebuffered, 'pre-watch-history-sixty', [
      [0.05, 15],
      [60, 65],
    ]);

    control('start');
    const startupReplay = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === 'chunk' &&
          message.groupId === 'media-source-1' &&
          message.mime === 'video/mp4; codecs="avc1.earlytest"' &&
          message.beginningArchive === true,
      );
    expect(startupReplay.map(decode)).toEqual([
      'pre-init',
      'pre-zero-to-five',
      'pre-five-to-fifteen',
    ]);
    expect(startupReplay.map(decode)).not.toContain('pre-watch-history-sixty');
    expect(startupReplay.at(-1)?.bufferedRanges).toEqual([[0.05, 15]]);

    // Reproduce the reset race: capture starts at watch history, the seek to
    // zero buffers 0-15 seconds during the stabilization window, then the site
    // briefly restores another middle range. clear() must retain only init and
    // the continuous beginning so the player need not append 0-15 again.
    const resetSource = new TimelineMediaSource();
    const reset = resetSource.addSourceBuffer(
      'video/mp4; codecs="avc1.earlytest"',
    ) as unknown as TimelineSourceBuffer;
    append(reset, 'reset-init', []);
    append(reset, 'reset-watch-history-twenty', [[20, 25]]);
    append(reset, 'reset-zero-to-five', [
      [0.05, 5],
      [20, 25],
    ]);
    append(reset, 'reset-five-to-fifteen', [
      [0.05, 15],
      [20, 25],
    ]);
    append(reset, 'reset-watch-history-eighty-seven', [
      [0.05, 15],
      [20, 25],
      [87, 92],
    ]);

    postMessage.mockClear();
    control('clear');
    const resetReplay = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === 'chunk' &&
          message.groupId === 'media-source-2' &&
          message.mime === 'video/mp4; codecs="avc1.earlytest"' &&
          message.beginningArchive === true,
      );
    expect(resetReplay.map(decode)).toEqual([
      'reset-init',
      'reset-zero-to-five',
      'reset-five-to-fifteen',
    ]);
    expect(resetReplay.map(decode)).not.toEqual(
      expect.arrayContaining(['reset-watch-history-twenty', 'reset-watch-history-eighty-seven']),
    );
    expect(resetReplay.at(-1)?.bufferedRanges).toEqual([[0.05, 15]]);

    // If the hook discovers a SourceBuffer that already contains 0-15 but it
    // never retained those bytes, a newly captured 15-20 append must report
    // only 15-20. Reporting the SourceBuffer's full 0-20 range here would let
    // the agent incorrectly label an incomplete file as complete.
    const lateSource = new TimelineMediaSource();
    const late = lateSource.addSourceBuffer(
      'video/mp4; codecs="avc1.earlytest"',
    ) as unknown as TimelineSourceBuffer;
    late.setBufferedRanges([[0, 15]]);
    postMessage.mockClear();
    append(late, 'late-fifteen-to-twenty', [[0, 20]]);
    const lateChunk = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(
        (message) =>
          message.type === 'chunk' &&
          message.groupId === 'media-source-3' &&
          message.mime === 'video/mp4; codecs="avc1.earlytest"' &&
          message.beginningArchive !== true,
      );
    expect(lateChunk).toMatchObject({
      bufferedStart: 15,
      bufferedEnd: 20,
      bufferedRanges: [[15, 20]],
    });
  });

  it('drops the previous SPA route archive while continuing on a reused SourceBuffer', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: TimelineMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: TimelineSourceBuffer,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const decode = (message: Record<string, unknown>): string =>
      new TextDecoder().decode(message.bytes as ArrayBuffer);
    const control = (command: string, sessionId?: string, pageUrl?: string): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: {
            channel: 'foxfetch:mse-cache:v1',
            direction: 'agent-to-main',
            command,
            ...(sessionId ? { sessionId } : {}),
            ...(pageUrl ? { pageUrl } : {}),
          },
        }),
      );
    };

    installMseCaptureMainWorld();
    const source = new TimelineMediaSource();
    const buffer = source.addSourceBuffer(
      'video/mp4; codecs="avc1.route"',
    ) as unknown as TimelineSourceBuffer;

    buffer.appendBuffer(arrayBuffer('old-route-init'));
    buffer.setBufferedRanges([[0, 15]]);
    buffer.dispatchEvent(new Event('updateend'));
    // This append began on the old route but finishes after the route reset. It
    // must not leak into the new route even though the site reuses the buffer.
    buffer.appendBuffer(arrayBuffer('old-route-in-flight'));
    const nextPageUrl = new URL('/next-video', location.href).href;
    history.pushState({}, '', nextPageUrl);
    buffer.dispatchEvent(new Event('updateend'));

    postMessage.mockClear();
    control('start', 'new-route-session');
    expect(
      postMessage.mock.calls.filter(([message]) => {
        const value = message as Record<string, unknown>;
        return value.type === 'chunk' && value.mime === 'video/mp4; codecs="avc1.route"';
      }),
    ).toHaveLength(0);

    buffer.setBufferedRanges([]);
    // Real players may register updateend first and call endOfStream before
    // the hook's commit listener runs. This successful append still belongs
    // to the new route and must not be discarded merely because the source is
    // now marked ended later in the same event dispatch.
    buffer.addEventListener('updateend', () => source.endOfStream(), { once: true });
    buffer.appendBuffer(arrayBuffer('new-route-init'));
    buffer.dispatchEvent(new Event('updateend'));
    const liveChunks = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter(
        (message) => message.type === 'chunk' && message.mime === 'video/mp4; codecs="avc1.route"',
      );
    expect(liveChunks.length).toBeGreaterThan(0);
    expect(new Set(liveChunks.map(decode))).toEqual(new Set(['new-route-init']));

    // The isolated Agent reports the same route later. This must be idempotent,
    // otherwise it would erase the new video's beginning archive.
    control('reset-route', undefined, nextPageUrl);
    postMessage.mockClear();
    control('clear', 'new-route-session');
    const replayed = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter(
        (message) =>
          message.type === 'chunk' &&
          message.beginningArchive === true &&
          message.mime === 'video/mp4; codecs="avc1.route"',
      );
    expect(replayed.length).toBeGreaterThan(0);
    expect(new Set(replayed.map(decode))).toEqual(new Set(['new-route-init']));
    expect(replayed.map(decode)).not.toContain('old-route-init');
    expect(replayed.map(decode)).not.toContain('old-route-in-flight');
  });

  it('binds a session to the selected player blob URL on a multi-MediaSource page', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: FakeSourceBuffer,
    });
    const nativeCreate = vi
      .fn<(object: Blob | MediaSource) => string>()
      .mockReturnValueOnce('blob:https://player.test/one')
      .mockReturnValueOnce('blob:https://player.test/two');
    const nativeRevoke = vi.fn<(url: string) => void>();
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: nativeCreate,
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: nativeRevoke,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const control = (sessionId: string, targetSourceUrl: string): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: {
            channel: 'foxfetch:mse-cache:v1',
            direction: 'agent-to-main',
            command: 'start',
            sessionId,
            pageUrl: window.location.href,
            targetSourceUrl,
          },
        }),
      );
    };
    const append = (buffer: FakeSourceBuffer, text: string, end: number): void => {
      buffer.appendBuffer(arrayBuffer(text));
      buffer.setBufferedRanges([[0, end]]);
      buffer.dispatchEvent(new Event('updateend'));
    };

    installMseCaptureMainWorld();
    const firstSource = new FakeMediaSource();
    const secondSource = new FakeMediaSource();
    const firstUrl = window.URL.createObjectURL(firstSource as unknown as MediaSource);
    const secondUrl = window.URL.createObjectURL(secondSource as unknown as MediaSource);
    const firstBuffer = firstSource.addSourceBuffer('video/mp4') as unknown as FakeSourceBuffer;
    const secondBuffer = secondSource.addSourceBuffer('video/mp4') as unknown as FakeSourceBuffer;

    control('target-two', secondUrl);
    const firstAck = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'started' && message.sessionId === 'target-two')
      .at(-1);
    expect(firstAck).toMatchObject({
      boundGroupId: 'media-source-2',
      waiting: false,
      hookGeneration: 0,
    });
    expect(firstAck?.routeKey).toBeTruthy();

    postMessage.mockClear();
    append(firstBuffer, 'first-player-data', 1);
    append(secondBuffer, 'second-player-data', 1);
    const firstSessionChunks = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'chunk');
    expect(firstSessionChunks).toHaveLength(1);
    expect(firstSessionChunks[0]).toMatchObject({
      sessionId: 'target-two',
      groupId: 'media-source-2',
    });

    postMessage.mockClear();
    control('target-one', firstUrl);
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((message) => message.type === 'started' && message.sessionId === 'target-one')
        .at(-1),
    ).toMatchObject({ boundGroupId: 'media-source-1', waiting: false });
    postMessage.mockClear();
    append(firstBuffer, 'first-player-new-data', 2);
    append(secondBuffer, 'second-player-new-data', 2);
    const secondSessionChunks = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === 'chunk');
    expect(secondSessionChunks).toHaveLength(1);
    expect(secondSessionChunks[0]).toMatchObject({
      sessionId: 'target-one',
      groupId: 'media-source-1',
    });

    window.URL.revokeObjectURL(secondUrl);
    expect(nativeRevoke).toHaveBeenCalledWith(secondUrl);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'reset-route',
          pageUrl: window.location.href,
          force: true,
          mediaIdentity: { sourceUrl: secondUrl, mediaEpoch: 2 },
        },
      }),
    );
    postMessage.mockClear();
    control('revoked-target', secondUrl);
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((message) => message.type === 'started')
        .at(-1),
    ).toMatchObject({
      sessionId: 'revoked-target',
      boundGroupId: 'media-source-3',
      waiting: false,
      hookGeneration: 1,
    });

    const nextPageUrl = new URL('/video/second-route', window.location.href).href;
    history.pushState({}, '', nextPageUrl);
    postMessage.mockClear();
    control('second-route-old-blob', secondUrl);
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .filter((message) => message.type === 'started')
        .at(-1),
    ).toMatchObject({ sessionId: 'second-route-old-blob', waiting: true });

    postMessage.mockClear();
    secondBuffer.setBufferedRanges([]);
    append(secondBuffer, 'second-player-reused-on-new-route', 3);
    const reusedRouteMessages = postMessage.mock.calls.map(
      ([message]) => message as Record<string, unknown>,
    );
    expect(reusedRouteMessages.find((message) => message.type === 'binding')).toMatchObject({
      sessionId: 'second-route-old-blob',
      boundGroupId: 'media-source-4',
      waiting: false,
    });
    expect(reusedRouteMessages.find((message) => message.type === 'chunk')).toMatchObject({
      sessionId: 'second-route-old-blob',
      groupId: 'media-source-4',
    });
  });

  it('reports a legacy live-page hook as requiring a controlled reload', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: FakeSourceBuffer,
    });
    Object.defineProperty(window, '__foxfetchMseCaptureHookV1__', {
      configurable: true,
      value: { version: 2, supported: true },
    });

    expect(installMseCaptureMainWorld()).toEqual({
      version: 3,
      supported: false,
      protocolVersion: 3,
      buildId: 'foxfetch-mse-hook-v3',
      health: 'reload-required',
      installedNow: false,
    });
    expect(FakeMediaSource.prototype.addSourceBuffer).toBe(originalFakeAddSourceBuffer);
  });

  it('announces a delayed blob binding and ignores late append/end from an old route', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: TimelineMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: TimelineSourceBuffer,
    });
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:https://player.test/delayed'),
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    installMseCaptureMainWorld();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'start',
          sessionId: 'waiting-session',
          targetSourceUrl: 'blob:https://player.test/delayed',
        },
      }),
    );
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message.type === 'started'),
    ).toMatchObject({ waiting: true });

    const delayedSource = new TimelineMediaSource();
    window.URL.createObjectURL(delayedSource as unknown as MediaSource);
    expect(
      postMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message.type === 'binding'),
    ).toMatchObject({ boundGroupId: 'media-source-1', waiting: false });

    const oldBuffer = delayedSource.addSourceBuffer('video/mp4') as unknown as TimelineSourceBuffer;
    oldBuffer.appendBuffer(arrayBuffer('old-in-flight'));
    const nextPageUrl = new URL('/route-after-delayed', location.href).href;
    history.pushState({}, '', nextPageUrl);

    const newSource = new TimelineMediaSource();
    const newBuffer = newSource.addSourceBuffer('video/mp4') as unknown as TimelineSourceBuffer;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'start',
          sessionId: 'new-route-session',
          pageUrl: nextPageUrl,
        },
      }),
    );
    postMessage.mockClear();
    oldBuffer.setBufferedRanges([[0, 1]]);
    oldBuffer.dispatchEvent(new Event('updateend'));
    delayedSource.endOfStream();
    newBuffer.appendBuffer(arrayBuffer('new-route-data'));
    newBuffer.setBufferedRanges([[0, 1]]);
    newBuffer.dispatchEvent(new Event('updateend'));

    const messages = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
    const chunks = messages.filter((message) => message.type === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0]?.bytes as ArrayBuffer)).toBe('new-route-data');
    expect(messages.filter((message) => message.type === 'source-ended')).toHaveLength(0);
    expect(chunks[0]).toMatchObject({
      sessionId: 'new-route-session',
      hookGeneration: 1,
    });
  });

  it('releases the route metadata cap so later SPA videos still archive their beginning', () => {
    Object.defineProperty(window, 'MediaSource', {
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(window, 'SourceBuffer', {
      configurable: true,
      value: FakeSourceBuffer,
    });
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    installMseCaptureMainWorld();

    for (let index = 0; index < 64; index += 1) {
      new FakeMediaSource().addSourceBuffer(`video/mp4; codecs="avc1.old${index}"`);
    }
    const nextPageUrl = new URL('/after-many-sources', location.href).href;
    history.pushState({}, '', nextPageUrl);

    const freshSource = new FakeMediaSource();
    const freshBuffer = freshSource.addSourceBuffer(
      'video/mp4; codecs="avc1.fresh"',
    ) as unknown as FakeSourceBuffer;
    freshBuffer.appendBuffer(arrayBuffer('fresh-route-init'));
    freshBuffer.dispatchEvent(new Event('updateend'));

    postMessage.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: 'foxfetch:mse-cache:v1',
          direction: 'agent-to-main',
          command: 'start',
          sessionId: 'fresh-after-cap',
          pageUrl: nextPageUrl,
        },
      }),
    );
    const replay = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find(
        (message) =>
          message.type === 'chunk' &&
          message.sessionId === 'fresh-after-cap' &&
          message.beginningArchive === true,
      );
    expect(new TextDecoder().decode(replay?.bytes as ArrayBuffer)).toBe('fresh-route-init');
  });
});
