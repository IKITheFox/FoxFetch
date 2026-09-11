export interface MseCaptureHookInstallResult {
  version: 3;
  supported: boolean;
  protocolVersion: 3;
  buildId: 'foxfetch-mse-hook-v3';
  health: 'ready' | 'reload-required' | 'unsupported';
  installedNow: boolean;
}

/**
 * Additive v3 protocol metadata. All values deliberately survive structured
 * cloning and JSON serialization; Infinity is represented by the string
 * `infinity` rather than a non-JSON number.
 */
export interface MseTimelineState {
  readable: boolean;
  mode: 'segments' | 'sequence' | 'unknown';
  timestampOffset: number | null;
  appendWindowStart: number | null;
  appendWindowEnd: number | 'infinity' | null;
}

export type MseTimelineUnsafeReason =
  | 'source-buffer-state-unreadable'
  | 'sequence-mode'
  | 'timestamp-offset'
  | 'append-window'
  | 'change-type'
  | 'remove'
  | 'abort'
  | 'end-of-stream-error'
  | 'timeline-event-overflow';

export interface MseTimelineEvent {
  eventSequence: number;
  kind: 'change-type' | 'remove' | 'abort' | 'end-of-stream';
  changeTypeGeneration: number;
  stateBefore?: MseTimelineState;
  stateAfter?: MseTimelineState;
  mime?: string;
  start?: number;
  end?: number;
  outcome?: 'completed' | 'aborted' | 'error';
  endOfStreamError?: 'network' | 'decode';
  unsafeTimelineReason?: MseTimelineUnsafeReason;
}

export interface MseAppendTimelineSidecar {
  schemaVersion: 1;
  appendOrdinal: number;
  changeTypeGeneration: number;
  stateBefore: MseTimelineState;
  stateAfter: MseTimelineState;
  eventsBeforeAppend: MseTimelineEvent[];
  unsafeTimelineReason?: MseTimelineUnsafeReason;
  unsafeTimelineReasons?: MseTimelineUnsafeReason[];
}

/** Optional fields carried by `chunk`, `track`, `timeline-event`, and `source-ended`. */
export interface MseCaptureTimelineEnvelope {
  timeline?: MseAppendTimelineSidecar;
  timelineEvent?: MseTimelineEvent;
  changeTypeGeneration?: number;
  unsafeTimelineReason?: MseTimelineUnsafeReason;
  unsafeTimelineReasons?: MseTimelineUnsafeReason[];
}

/**
 * Installed with chrome.scripting.executeScript({ world: 'MAIN' }). Keep this
 * function completely self-contained: Chrome serializes only its body.
 *
 * The hook never fetches or decrypts media. It forwards a copy only after the
 * page successfully appends that exact BufferSource to an MSE SourceBuffer.
 */
export function installMseCaptureMainWorld(): MseCaptureHookInstallResult {
  const channel = 'foxfetch:mse-cache:v1';
  type HookWindow = Window &
    typeof globalThis & {
      __foxfetchMseCaptureHookV1__?: Partial<MseCaptureHookInstallResult>;
    };
  const scope = window as HookWindow;
  const existing = scope.__foxfetchMseCaptureHookV1__;
  const protocolVersion = 3 as const;
  const buildId = 'foxfetch-mse-hook-v3' as const;
  if (existing) {
    if (
      existing.version === 3 &&
      existing.protocolVersion === protocolVersion &&
      existing.buildId === buildId &&
      existing.health === 'ready'
    ) {
      return {
        version: 3,
        supported: true,
        protocolVersion,
        buildId,
        health: 'ready',
        installedNow: false,
      };
    }
    if (
      existing.version === 3 &&
      existing.protocolVersion === protocolVersion &&
      existing.buildId === buildId &&
      existing.health === 'unsupported'
    ) {
      return {
        version: 3,
        supported: false,
        protocolVersion,
        buildId,
        health: 'unsupported',
        installedNow: false,
      };
    }
    // Prototype wrappers cannot be safely stacked or replaced in a live page.
    // A controlled reload lets document_start install this build before the
    // player creates its MediaSources.
    return {
      version: 3,
      supported: false,
      protocolVersion,
      buildId,
      health: 'reload-required',
      installedNow: false,
    };
  }

  const MediaSourceConstructor = scope.MediaSource;
  const SourceBufferConstructor = scope.SourceBuffer;
  const mediaSourcePrototype = MediaSourceConstructor?.prototype;
  const sourceBufferPrototype = SourceBufferConstructor?.prototype;
  if (
    !MediaSourceConstructor ||
    !SourceBufferConstructor ||
    !mediaSourcePrototype ||
    !sourceBufferPrototype ||
    typeof mediaSourcePrototype.addSourceBuffer !== 'function' ||
    typeof mediaSourcePrototype.endOfStream !== 'function' ||
    typeof sourceBufferPrototype.appendBuffer !== 'function' ||
    typeof sourceBufferPrototype.remove !== 'function' ||
    typeof sourceBufferPrototype.abort !== 'function'
  ) {
    // At Chromium document_start these constructors can be exposed a little
    // later than the first page-world script. Do not poison the page with a
    // permanent unsupported marker: the content script and the user-triggered
    // background injection must be able to retry once the Window is ready.
    return {
      version: 3,
      supported: false,
      protocolVersion,
      buildId,
      health: 'unsupported',
      installedNow: false,
    } as const;
  }

  let activeSessionId: string | undefined;
  let activeTargetSourceUrl: string | undefined;
  let activeBoundGroupId: string | undefined;
  let capturePaused = false;
  let beginningReplayPending = false;
  const endedWhilePaused = new Map<string, MseTimelineEvent>();
  let sourceSequence = 0;
  let mediaSourceSequence = 0;
  let chunkSequence = 0;
  let timelineEventSequence = 0;
  let routeGeneration = 0;
  let archivedBeginningBytes = 0;
  // Keep enough successful early appends to survive a late capture start or a
  // post-seek clear. The archive is page-local, bounded, and only retains the
  // continuous prefix that grows from time zero; watch-history ranges are not
  // eligible for replay.
  const maxArchivedBeginningBytes = 64 * 1024 * 1024;
  const maxArchivedBeginningBytesPerTrack = 48 * 1024 * 1024;
  const maxArchivedBeginningSeconds = 30;
  const beginningGapToleranceSeconds = 1;
  const routeKeyFor = (rawUrl: string): string => {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase();
      const isYouTube =
        hostname === 'youtube.com' ||
        hostname.endsWith('.youtube.com') ||
        hostname === 'youtube-nocookie.com' ||
        hostname.endsWith('.youtube-nocookie.com');
      if (isYouTube) {
        const candidate =
          url.pathname === '/watch'
            ? url.searchParams.get('v')
            : /^\/(?:embed|live|shorts)\/([0-9A-Za-z_-]+)/u.exec(url.pathname)?.[1];
        if (candidate && /^[0-9A-Za-z_-]{6,32}$/u.test(candidate)) {
          return `youtube:${candidate}`;
        }
      }
      const isBilibili = hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
      if (isBilibili) {
        const bvid = /\/video\/(BV[0-9A-Za-z]+)/u.exec(url.pathname)?.[1]?.toUpperCase();
        if (bvid) {
          const numeric = (value: string | null): string =>
            value && /^\d+$/u.test(value) ? value.replace(/^0+(?=\d)/u, '') : '';
          return `bilibili:${bvid}:p=${numeric(url.searchParams.get('p')) || '1'}:cid=${numeric(url.searchParams.get('cid'))}`;
        }
      }
      return `${url.origin}${url.pathname}${url.search}${url.hash}`;
    } catch {
      return rawUrl;
    }
  };
  let activeRouteKey = routeKeyFor(scope.location.href);
  type BufferedRange = [number, number];
  type ArchivedBeginningChunk = {
    bytes: ArrayBuffer;
    coverageRanges: BufferedRange[];
    initialization: boolean;
    timeline: MseAppendTimelineSidecar;
  };
  type BufferMetadata = {
    id: string;
    groupId: string;
    routeGeneration: number;
    mime: string;
    source?: MediaSource;
    announcedFor?: string;
    archivedBeginningChunks: ArchivedBeginningChunk[];
    archivedBeginningBytes: number;
    beginningCoverageEnd: number;
    sawMediaCoverage: boolean;
    forwardedFor?: string;
    forwardedRanges: BufferedRange[];
    appendOrdinal: number;
    changeTypeGeneration: number;
    pendingTimelineEvents: MseTimelineEvent[];
    unsafeTimelineReasons: Set<MseTimelineUnsafeReason>;
  };
  const metadata = new WeakMap<SourceBuffer, BufferMetadata>();
  const knownMetadata = new Set<BufferMetadata>();
  const mediaSourceGroups = new WeakMap<MediaSource, string>();
  const mediaSourceGenerations = new WeakMap<MediaSource, number>();
  const endedMediaSources = new WeakSet<MediaSource>();
  type BlobMediaSourceRecord = {
    sourceRef: WeakRef<MediaSource>;
    groupId: string;
    routeGeneration: number;
    revoked: boolean;
  };
  const maxRememberedBlobUrls = 32;
  const mediaSourcesByBlobUrl = new Map<string, BlobMediaSourceRecord>();

  const send = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    const payload = {
      channel,
      direction: 'main-to-agent',
      protocolVersion,
      hookBuildId: buildId,
      hookHealth: 'ready',
      ...message,
    };
    try {
      scope.postMessage(payload, '*', transfer);
    } catch {
      // Some Chromium channels reject the legacy third-argument Transferable
      // overload across extension worlds even though ordinary postMessage
      // succeeds. Fall back to structured cloning so a valid append is not
      // silently lost; the downstream store still enforces chunk, quota, and
      // pending-write safety limits.
      if (transfer.length === 0) return;
      try {
        scope.postMessage(payload, '*');
      } catch {
        // Capture must never interfere with playback.
      }
    }
  };

  const groupFor = (source: MediaSource): string => {
    let groupId = mediaSourceGroups.get(source);
    if (!groupId) {
      mediaSourceSequence += 1;
      groupId = `media-source-${mediaSourceSequence}`;
      mediaSourceGroups.set(source, groupId);
      mediaSourceGenerations.set(source, routeGeneration);
    }
    return groupId;
  };

  const currentGroupFor = (source: MediaSource): string => {
    if (mediaSourceGenerations.get(source) === routeGeneration) return groupFor(source);
    mediaSourceSequence += 1;
    const groupId = `media-source-${mediaSourceSequence}`;
    mediaSourceGroups.set(source, groupId);
    mediaSourceGenerations.set(source, routeGeneration);
    const targetRecord = activeTargetSourceUrl
      ? mediaSourcesByBlobUrl.get(activeTargetSourceUrl)
      : undefined;
    if (targetRecord?.sourceRef.deref() === source) {
      const previousBoundGroupId = activeBoundGroupId;
      activeBoundGroupId = groupId;
      targetRecord.groupId = groupId;
      targetRecord.routeGeneration = routeGeneration;
      if (activeSessionId && previousBoundGroupId !== groupId) {
        send({
          type: 'binding',
          sessionId: activeSessionId,
          routeKey: activeRouteKey,
          hookGeneration: routeGeneration,
          boundGroupId: groupId,
          waiting: false,
        });
      }
    }
    return groupId;
  };

  const acceptsGroup = (groupId: string): boolean =>
    activeTargetSourceUrl == null || activeBoundGroupId === groupId;

  const bindTargetSource = (notify = false): void => {
    if (!activeTargetSourceUrl) {
      activeBoundGroupId = undefined;
      return;
    }
    const previousGroupId = activeBoundGroupId;
    const record = mediaSourcesByBlobUrl.get(activeTargetSourceUrl);
    const source = record?.sourceRef.deref();
    if (record && record.routeGeneration === routeGeneration) {
      // Touch the entry so insertion order also acts as a small route-local LRU.
      mediaSourcesByBlobUrl.delete(activeTargetSourceUrl);
      mediaSourcesByBlobUrl.set(activeTargetSourceUrl, record);
    }
    activeBoundGroupId =
      record && record.routeGeneration === routeGeneration
        ? source
          ? currentGroupFor(source)
          : record.groupId
        : undefined;
    if (notify && activeSessionId && previousGroupId !== activeBoundGroupId) {
      send({
        type: 'binding',
        sessionId: activeSessionId,
        routeKey: activeRouteKey,
        hookGeneration: routeGeneration,
        ...(activeBoundGroupId ? { boundGroupId: activeBoundGroupId } : {}),
        waiting: activeBoundGroupId == null,
      });
      if (activeBoundGroupId && !capturePaused) replayBeginningArchive();
    }
  };

  const metadataFor = (
    buffer: SourceBuffer,
    mime = 'application/octet-stream',
    explicitGroupId?: string,
    explicitSource?: MediaSource,
  ): BufferMetadata => {
    let value = metadata.get(buffer);
    if (!value) {
      sourceSequence += 1;
      value = {
        id: `source-${sourceSequence}`,
        groupId: explicitGroupId ?? `orphan-source-${sourceSequence}`,
        routeGeneration:
          (explicitSource && mediaSourceGenerations.get(explicitSource)) ?? routeGeneration,
        mime,
        archivedBeginningChunks: [],
        archivedBeginningBytes: 0,
        beginningCoverageEnd: 0,
        sawMediaCoverage: false,
        forwardedRanges: [],
        appendOrdinal: 0,
        changeTypeGeneration: 0,
        pendingTimelineEvents: [],
        unsafeTimelineReasons: new Set<MseTimelineUnsafeReason>(),
        ...(explicitSource ? { source: explicitSource } : {}),
      };
      metadata.set(buffer, value);
      knownMetadata.add(value);
    } else if (mime !== 'application/octet-stream') {
      value.mime = mime;
    }
    if (explicitSource) value.source = explicitSource;
    return value;
  };

  const forkMetadataForCurrentRoute = (
    buffer: SourceBuffer,
    previous: BufferMetadata,
  ): BufferMetadata => {
    sourceSequence += 1;
    const value: BufferMetadata = {
      id: `source-${sourceSequence}`,
      groupId: previous.source
        ? currentGroupFor(previous.source)
        : `orphan-source-${sourceSequence}`,
      routeGeneration,
      mime: previous.mime,
      ...(previous.source ? { source: previous.source } : {}),
      archivedBeginningChunks: [],
      archivedBeginningBytes: 0,
      beginningCoverageEnd: 0,
      sawMediaCoverage: false,
      forwardedRanges: [],
      appendOrdinal: 0,
      changeTypeGeneration: 0,
      pendingTimelineEvents: [],
      unsafeTimelineReasons: new Set(previous.unsafeTimelineReasons),
    };
    metadata.set(buffer, value);
    knownMetadata.add(value);
    return value;
  };

  const unreadableTimelineState = (): MseTimelineState => ({
    readable: false,
    mode: 'unknown',
    timestampOffset: null,
    appendWindowStart: null,
    appendWindowEnd: null,
  });

  const readTimelineState = (buffer: SourceBuffer): MseTimelineState => {
    try {
      const mode = buffer.mode;
      const timestampOffset = buffer.timestampOffset;
      const appendWindowStart = buffer.appendWindowStart;
      const appendWindowEnd = buffer.appendWindowEnd;
      if (
        (mode !== 'segments' && mode !== 'sequence') ||
        !Number.isFinite(timestampOffset) ||
        !Number.isFinite(appendWindowStart) ||
        (!Number.isFinite(appendWindowEnd) && appendWindowEnd !== Number.POSITIVE_INFINITY)
      ) {
        return unreadableTimelineState();
      }
      return {
        readable: true,
        mode,
        timestampOffset: Object.is(timestampOffset, -0) ? 0 : timestampOffset,
        appendWindowStart: Object.is(appendWindowStart, -0) ? 0 : appendWindowStart,
        appendWindowEnd:
          appendWindowEnd === Number.POSITIVE_INFINITY
            ? 'infinity'
            : Object.is(appendWindowEnd, -0)
              ? 0
              : appendWindowEnd,
      };
    } catch {
      return unreadableTimelineState();
    }
  };

  const timelineReasonsForState = (state: MseTimelineState): MseTimelineUnsafeReason[] => {
    if (!state.readable) return ['source-buffer-state-unreadable'];
    const reasons: MseTimelineUnsafeReason[] = [];
    if (state.mode === 'sequence') reasons.push('sequence-mode');
    if (state.timestampOffset !== 0) reasons.push('timestamp-offset');
    if (state.appendWindowStart !== 0 || state.appendWindowEnd !== 'infinity') {
      reasons.push('append-window');
    }
    return reasons;
  };

  const noteUnsafe = (
    value: BufferMetadata,
    ...reasons: Array<MseTimelineUnsafeReason | undefined>
  ): void => {
    for (const reason of reasons) {
      if (reason) value.unsafeTimelineReasons.add(reason);
    }
  };

  const unsafeEnvelopeFor = (
    value: BufferMetadata,
  ): Pick<MseCaptureTimelineEnvelope, 'unsafeTimelineReason' | 'unsafeTimelineReasons'> => {
    const unsafeTimelineReasons = [...value.unsafeTimelineReasons];
    return unsafeTimelineReasons.length > 0
      ? {
          unsafeTimelineReason: unsafeTimelineReasons[0]!,
          unsafeTimelineReasons,
        }
      : {};
  };

  const unsafeEnvelopeForGroup = (
    groupId: string,
    extra: readonly MseTimelineUnsafeReason[] = [],
  ): Pick<MseCaptureTimelineEnvelope, 'unsafeTimelineReason' | 'unsafeTimelineReasons'> => {
    const unsafeTimelineReasons = [
      ...new Set([
        ...extra,
        ...[...knownMetadata]
          .filter((value) => value.routeGeneration === routeGeneration && value.groupId === groupId)
          .flatMap((value) => [...value.unsafeTimelineReasons]),
      ]),
    ];
    return unsafeTimelineReasons.length > 0
      ? {
          unsafeTimelineReason: unsafeTimelineReasons[0]!,
          unsafeTimelineReasons,
        }
      : {};
  };

  const sendTimelineEvent = (value: BufferMetadata, event: MseTimelineEvent): void => {
    if (
      !activeSessionId ||
      capturePaused ||
      value.routeGeneration !== routeGeneration ||
      !acceptsGroup(value.groupId)
    ) {
      return;
    }
    announce(value);
    send({
      type: 'timeline-event',
      sessionId: activeSessionId,
      routeKey: activeRouteKey,
      hookGeneration: routeGeneration,
      trackId: value.id,
      groupId: value.groupId,
      mime: value.mime,
      changeTypeGeneration: value.changeTypeGeneration,
      timelineEvent: event,
      ...unsafeEnvelopeFor(value),
    });
  };

  const recordTimelineEvent = (
    value: BufferMetadata,
    event: Omit<MseTimelineEvent, 'eventSequence'>,
  ): MseTimelineEvent => {
    timelineEventSequence += 1;
    const recorded: MseTimelineEvent = { eventSequence: timelineEventSequence, ...event };
    noteUnsafe(value, recorded.unsafeTimelineReason);
    if (value.pendingTimelineEvents.length >= 32) {
      value.pendingTimelineEvents.shift();
      noteUnsafe(value, 'timeline-event-overflow');
    }
    value.pendingTimelineEvents.push(recorded);
    sendTimelineEvent(value, recorded);
    return recorded;
  };

  const appendTimelineFor = (
    value: BufferMetadata,
    stateBefore: MseTimelineState,
    stateAfter: MseTimelineState,
  ): MseAppendTimelineSidecar => {
    value.appendOrdinal += 1;
    noteUnsafe(
      value,
      ...timelineReasonsForState(stateBefore),
      ...timelineReasonsForState(stateAfter),
    );
    const eventsBeforeAppend = value.pendingTimelineEvents.splice(0);
    const unsafeTimelineReasons = [...value.unsafeTimelineReasons];
    return {
      schemaVersion: 1,
      appendOrdinal: value.appendOrdinal,
      changeTypeGeneration: value.changeTypeGeneration,
      stateBefore,
      stateAfter,
      eventsBeforeAppend,
      ...(unsafeTimelineReasons.length > 0
        ? {
            unsafeTimelineReason: unsafeTimelineReasons[0]!,
            unsafeTimelineReasons,
          }
        : {}),
    };
  };

  const announce = (value: BufferMetadata): void => {
    if (
      !activeSessionId ||
      value.routeGeneration !== routeGeneration ||
      !acceptsGroup(value.groupId) ||
      value.announcedFor === activeSessionId
    ) {
      return;
    }
    value.announcedFor = activeSessionId;
    send({
      type: 'track',
      sessionId: activeSessionId,
      routeKey: activeRouteKey,
      hookGeneration: routeGeneration,
      trackId: value.id,
      groupId: value.groupId,
      mime: value.mime,
      changeTypeGeneration: value.changeTypeGeneration,
      ...unsafeEnvelopeFor(value),
    });
  };

  const replayBeginningArchive = (): void => {
    if (!activeSessionId || capturePaused) return;
    for (const value of knownMetadata) {
      if (value.routeGeneration !== routeGeneration) continue;
      if (!acceptsGroup(value.groupId)) continue;
      if (value.archivedBeginningChunks.length === 0) continue;
      announce(value);
      value.forwardedFor = activeSessionId;
      value.forwardedRanges = [];
      for (const archived of value.archivedBeginningChunks) {
        const replay = archived.bytes.slice(0);
        const timeline = {
          ...archived.timeline,
          ...unsafeEnvelopeFor(value),
        } satisfies MseAppendTimelineSidecar;
        value.forwardedRanges = mergeBufferedRanges([
          ...value.forwardedRanges,
          ...archived.coverageRanges,
        ]);
        chunkSequence += 1;
        send(
          {
            type: 'chunk',
            sessionId: activeSessionId,
            routeKey: activeRouteKey,
            hookGeneration: routeGeneration,
            trackId: value.id,
            groupId: value.groupId,
            mime: value.mime,
            sequence: chunkSequence,
            bytes: replay,
            initialization: archived.initialization,
            bootstrap: true,
            beginningArchive: true,
            timeline,
            changeTypeGeneration: value.changeTypeGeneration,
            ...unsafeEnvelopeFor(value),
            ...timingForRanges(value.source, value.forwardedRanges),
          },
          [replay],
        );
      }
    }
  };

  const readBufferedRanges = (buffer: SourceBuffer): BufferedRange[] => {
    try {
      const ranges: BufferedRange[] = [];
      const buffered = buffer.buffered;
      for (let index = 0; index < Math.min(buffered.length, 64); index += 1) {
        const start = buffered.start(index);
        const end = buffered.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start) {
          ranges.push([start, end]);
        }
      }
      return ranges;
    } catch {
      return [];
    }
  };

  const subtractBufferedRanges = (
    after: readonly BufferedRange[],
    before: readonly BufferedRange[],
  ): BufferedRange[] => {
    const additions: BufferedRange[] = [];
    for (const [afterStart, afterEnd] of after) {
      let pieces: BufferedRange[] = [[afterStart, afterEnd]];
      for (const [beforeStart, beforeEnd] of before) {
        const next: BufferedRange[] = [];
        for (const [pieceStart, pieceEnd] of pieces) {
          if (beforeEnd <= pieceStart || beforeStart >= pieceEnd) {
            next.push([pieceStart, pieceEnd]);
            continue;
          }
          if (beforeStart > pieceStart) next.push([pieceStart, Math.min(beforeStart, pieceEnd)]);
          if (beforeEnd < pieceEnd) next.push([Math.max(beforeEnd, pieceStart), pieceEnd]);
        }
        pieces = next;
        if (pieces.length === 0) break;
      }
      additions.push(...pieces.filter(([start, end]) => end - start > 0.001));
    }
    return additions;
  };

  function mergeBufferedRanges(ranges: readonly BufferedRange[]): BufferedRange[] {
    const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged: BufferedRange[] = [];
    for (const [start, end] of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1] + 0.001) {
        previous[1] = Math.max(previous[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  }

  const addForwardedCoverage = (
    value: BufferMetadata,
    sessionId: string,
    additions: readonly BufferedRange[],
  ): BufferedRange[] => {
    if (value.forwardedFor !== sessionId) {
      value.forwardedFor = sessionId;
      value.forwardedRanges = [];
    }
    value.forwardedRanges = mergeBufferedRanges([...value.forwardedRanges, ...additions]);
    return value.forwardedRanges;
  };

  const timingForRanges = (
    source: MediaSource | undefined,
    ranges: readonly BufferedRange[],
  ): Record<string, unknown> => {
    const duration = source?.duration;
    return {
      ...(ranges.length > 0
        ? {
            bufferedStart: ranges[0]![0],
            bufferedEnd: ranges[ranges.length - 1]![1],
            bufferedRanges: ranges,
          }
        : {}),
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? { duration }
        : {}),
    };
  };

  const archiveBeginningChunk = (
    value: BufferMetadata,
    bytes: ArrayBuffer,
    additions: readonly BufferedRange[],
    timeline: MseAppendTimelineSidecar,
  ): void => {
    if (value.routeGeneration !== routeGeneration) return;
    const sortedAdditions = [...additions].sort((left, right) => left[0] - right[0]);
    const wasBeforeFirstMediaRange = !value.sawMediaCoverage;
    if (sortedAdditions.length > 0) value.sawMediaCoverage = true;

    const acceptedAdditions: BufferedRange[] = [];
    let candidateEnd = value.beginningCoverageEnd;
    let hasDisconnectedAddition = false;
    for (const [start, end] of sortedAdditions) {
      if (
        start < maxArchivedBeginningSeconds &&
        start <= candidateEnd + beginningGapToleranceSeconds
      ) {
        acceptedAdditions.push([start, end]);
        candidateEnd = Math.max(candidateEnd, end);
      } else {
        hasDisconnectedAddition = true;
      }
    }

    // Successful no-range appends before the first media range are MSE
    // initialization/configuration data. Once media coverage exists, a
    // no-range append is not guessed to be part of the beginning.
    const initializationChunk = wasBeforeFirstMediaRange && sortedAdditions.length === 0;
    if (!initializationChunk && acceptedAdditions.length === 0) return;
    // A single append that introduces both a beginning and a disconnected
    // watch-history range cannot be split safely, so do not archive it.
    if (hasDisconnectedAddition) return;
    if (
      archivedBeginningBytes + bytes.byteLength > maxArchivedBeginningBytes ||
      value.archivedBeginningBytes + bytes.byteLength > maxArchivedBeginningBytesPerTrack
    ) {
      return;
    }

    const owned = bytes.slice(0);
    if (acceptedAdditions.length > 0) value.beginningCoverageEnd = candidateEnd;
    value.archivedBeginningChunks.push({
      bytes: owned,
      coverageRanges: mergeBufferedRanges(acceptedAdditions),
      initialization: initializationChunk,
      timeline,
    });
    value.archivedBeginningBytes += owned.byteLength;
    archivedBeginningBytes += owned.byteLength;
  };

  const resetRoute = (nextRouteKey: string, force = false, selectedSourceUrl?: string): boolean => {
    if (!nextRouteKey || (!force && nextRouteKey === activeRouteKey)) return false;
    const previousRouteKey = activeRouteKey;
    const previousSessionId = activeSessionId;
    const previousGeneration = routeGeneration;
    const selectedRecord =
      force && nextRouteKey === activeRouteKey && selectedSourceUrl
        ? mediaSourcesByBlobUrl.get(selectedSourceUrl)
        : undefined;
    const selectedSource =
      selectedRecord?.routeGeneration === previousGeneration
        ? selectedRecord.sourceRef.deref()
        : undefined;
    const preservedMetadata = selectedSource
      ? [...knownMetadata].filter(
          (value) =>
            value.source === selectedSource && value.routeGeneration === previousGeneration,
        )
      : [];
    activeRouteKey = nextRouteKey;
    activeSessionId = undefined;
    activeTargetSourceUrl = undefined;
    activeBoundGroupId = undefined;
    capturePaused = false;
    beginningReplayPending = false;
    endedWhilePaused.clear();
    archivedBeginningBytes = 0;
    routeGeneration += 1;
    let promotedGroupId: string | undefined;
    if (selectedRecord && selectedSource) {
      // The isolated Agent can observe a new player only after the page has
      // already created and attached its MediaSource. Promote that exact,
      // explicitly selected source into the fresh generation rather than
      // stranding its blob mapping in the previous generation. A new group ID
      // still fences late append callbacks from the retired lifecycle.
      mediaSourceSequence += 1;
      promotedGroupId = `media-source-${mediaSourceSequence}`;
      mediaSourceGroups.set(selectedSource, promotedGroupId);
      mediaSourceGenerations.set(selectedSource, routeGeneration);
      selectedRecord.groupId = promotedGroupId;
      selectedRecord.routeGeneration = routeGeneration;
      mediaSourcesByBlobUrl.delete(selectedSourceUrl!);
      mediaSourcesByBlobUrl.set(selectedSourceUrl!, selectedRecord);
    }
    // Keep only weak, stale route records. They cannot bind this route unless
    // the page proves it deliberately reused the same MediaSource, at which
    // point currentGroupFor advances the record and announces a fresh binding.
    for (const [url, record] of mediaSourcesByBlobUrl) {
      if (!record.sourceRef.deref()) mediaSourcesByBlobUrl.delete(url);
    }
    const preservedSet = new Set(preservedMetadata);
    for (const value of knownMetadata) {
      if (promotedGroupId && preservedSet.has(value)) {
        value.groupId = promotedGroupId;
        value.routeGeneration = routeGeneration;
        value.forwardedRanges = [];
        delete value.announcedFor;
        delete value.forwardedFor;
        archivedBeginningBytes += value.archivedBeginningBytes;
        continue;
      }
      // Route ownership is immutable. Old SourceBuffers stay old and are
      // ignored unless a later append proves the site deliberately reused one
      // for a fresh timeline. No bytes (including init segments) cross a route
      // boundary; a reused buffer must rebuild its archive from new appends.
      if (value.routeGeneration !== routeGeneration) {
        value.archivedBeginningChunks = [];
        value.archivedBeginningBytes = 0;
        value.beginningCoverageEnd = 0;
        value.sawMediaCoverage = false;
        value.appendOrdinal = 0;
        value.changeTypeGeneration = 0;
        value.pendingTimelineEvents = [];
        value.unsafeTimelineReasons.clear();
      }
      value.forwardedRanges = [];
      delete value.announcedFor;
      delete value.forwardedFor;
    }
    // The WeakMap keeps SourceBuffer identity without preventing collection,
    // while this strong set exists only for the current route's replay scan.
    // Releasing it here prevents a long-lived SPA from permanently hitting the
    // 64-track archive guard after many consecutive videos. A deliberately
    // reused buffer is added back when its first fresh append forks metadata.
    knownMetadata.clear();
    for (const value of preservedMetadata) knownMetadata.add(value);
    send({
      type: 'route-reset',
      ...(previousSessionId ? { sessionId: previousSessionId } : {}),
      previousRouteKey,
      routeKey: activeRouteKey,
      hookGeneration: routeGeneration,
    });
    return true;
  };

  const handleControl = (event: MessageEvent): void => {
    const message = event.data as Record<string, unknown> | null;
    if (
      !message ||
      message.channel !== channel ||
      message.direction !== 'agent-to-main' ||
      typeof message.command !== 'string'
    ) {
      return;
    }
    const controlMatchesActiveRoute = (): boolean => {
      if (typeof message.routeKey === 'string' && message.routeKey !== activeRouteKey) {
        return false;
      }
      if (
        typeof message.hookGeneration === 'number' &&
        message.hookGeneration !== routeGeneration
      ) {
        return false;
      }
      return true;
    };
    if (message.command === 'start' && typeof message.sessionId === 'string') {
      if (
        (message.protocolVersion != null && message.protocolVersion !== protocolVersion) ||
        (message.hookBuildId != null && message.hookBuildId !== buildId)
      ) {
        send({
          type: 'health',
          sessionId: message.sessionId,
          health: 'reload-required',
          routeKey: activeRouteKey,
          hookGeneration: routeGeneration,
        });
        return;
      }
      const requestedPageUrl =
        typeof message.pageUrl === 'string' ? message.pageUrl : scope.location.href;
      resetRoute(routeKeyFor(requestedPageUrl));
      activeTargetSourceUrl =
        typeof message.targetSourceUrl === 'string' && message.targetSourceUrl.length > 0
          ? message.targetSourceUrl
          : undefined;
      bindTargetSource();
      if (activeSessionId === message.sessionId) {
        capturePaused = false;
        send({
          type: 'started',
          sessionId: activeSessionId,
          resumed: true,
          routeKey: activeRouteKey,
          hookGeneration: routeGeneration,
          ...(activeBoundGroupId ? { boundGroupId: activeBoundGroupId } : {}),
          waiting: activeTargetSourceUrl != null && activeBoundGroupId == null,
        });
        if (beginningReplayPending) {
          beginningReplayPending = false;
          replayBeginningArchive();
        }
        return;
      }
      activeSessionId = message.sessionId;
      capturePaused = false;
      beginningReplayPending = false;
      endedWhilePaused.clear();
      chunkSequence = 0;
      for (const value of knownMetadata) {
        value.forwardedFor = activeSessionId;
        value.forwardedRanges = [];
      }
      send({
        type: 'started',
        sessionId: activeSessionId,
        routeKey: activeRouteKey,
        hookGeneration: routeGeneration,
        ...(activeBoundGroupId ? { boundGroupId: activeBoundGroupId } : {}),
        waiting: activeTargetSourceUrl != null && activeBoundGroupId == null,
      });
      replayBeginningArchive();
      return;
    }
    if (message.command === 'pause') {
      if (
        controlMatchesActiveRoute() &&
        (message.sessionId == null || message.sessionId === activeSessionId)
      ) {
        capturePaused = true;
      }
      return;
    }
    if (message.command === 'resume') {
      if (
        controlMatchesActiveRoute() &&
        typeof message.sessionId === 'string' &&
        message.sessionId === activeSessionId
      ) {
        capturePaused = false;
        send({
          type: 'resumed',
          sessionId: activeSessionId,
          routeKey: activeRouteKey,
          hookGeneration: routeGeneration,
          ...(activeBoundGroupId ? { boundGroupId: activeBoundGroupId } : {}),
          waiting: activeTargetSourceUrl != null && activeBoundGroupId == null,
        });
        if (beginningReplayPending) {
          beginningReplayPending = false;
          replayBeginningArchive();
        }
        for (const [groupId, timelineEvent] of endedWhilePaused) {
          send({
            type: 'source-ended',
            sessionId: activeSessionId,
            groupId,
            routeKey: activeRouteKey,
            hookGeneration: routeGeneration,
            timelineEvent,
            ...(timelineEvent.unsafeTimelineReason
              ? { unsafeTimelineReason: timelineEvent.unsafeTimelineReason }
              : {}),
            ...unsafeEnvelopeForGroup(groupId),
          });
        }
        endedWhilePaused.clear();
      }
      return;
    }
    if (message.command === 'stop') {
      if (
        controlMatchesActiveRoute() &&
        (message.sessionId == null || message.sessionId === activeSessionId)
      ) {
        activeSessionId = undefined;
        activeTargetSourceUrl = undefined;
        activeBoundGroupId = undefined;
        capturePaused = false;
        beginningReplayPending = false;
        endedWhilePaused.clear();
      }
      return;
    }
    if (message.command === 'reset-route') {
      const pageUrl = typeof message.pageUrl === 'string' ? message.pageUrl : scope.location.href;
      const mediaIdentity =
        message.mediaIdentity != null && typeof message.mediaIdentity === 'object'
          ? (message.mediaIdentity as Record<string, unknown>)
          : undefined;
      const selectedSourceUrl =
        typeof mediaIdentity?.sourceUrl === 'string' && mediaIdentity.sourceUrl.length > 0
          ? mediaIdentity.sourceUrl
          : undefined;
      resetRoute(routeKeyFor(pageUrl), message.force === true, selectedSourceUrl);
      return;
    }
    if (message.command === 'clear' && activeSessionId && controlMatchesActiveRoute()) {
      send({
        type: 'cleared',
        sessionId: activeSessionId,
        routeKey: activeRouteKey,
        hookGeneration: routeGeneration,
      });
      for (const value of knownMetadata) {
        delete value.announcedFor;
        value.forwardedFor = activeSessionId;
        value.forwardedRanges = [];
      }
      if (capturePaused) beginningReplayPending = true;
      else replayBeginningArchive();
    }
  };
  scope.addEventListener('message', handleControl);

  const handlePageRouteSignal = (): void => {
    resetRoute(routeKeyFor(scope.location.href));
    // Some site lifecycle events fire just before History is committed.
    scope.setTimeout(() => resetRoute(routeKeyFor(scope.location.href)), 0);
  };
  scope.addEventListener('popstate', handlePageRouteSignal);
  scope.addEventListener('hashchange', handlePageRouteSignal);
  for (const eventName of [
    'yt-navigate-finish',
    'yt-page-data-updated',
    'bili-page-change',
    'bili-video-switched',
  ]) {
    scope.document.addEventListener(eventName, handlePageRouteSignal);
  }
  try {
    const historyTarget = scope.history;
    const originalPushState = historyTarget.pushState;
    historyTarget.pushState = function (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      originalPushState.call(historyTarget, data, unused, url);
      handlePageRouteSignal();
    };
    const originalReplaceState = historyTarget.replaceState;
    historyTarget.replaceState = function (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      originalReplaceState.call(historyTarget, data, unused, url);
      handlePageRouteSignal();
    };
  } catch {
    // URL polling and the isolated Agent remain available if History is locked.
  }

  const originalAddSourceBuffer = mediaSourcePrototype.addSourceBuffer;
  const originalAppendBuffer = sourceBufferPrototype.appendBuffer;
  const originalEndOfStream = mediaSourcePrototype.endOfStream;
  const originalChangeType = sourceBufferPrototype.changeType;
  const originalRemove = sourceBufferPrototype.remove;
  const originalAbort = sourceBufferPrototype.abort;

  // A player element exposes only its blob URL. Preserve the native URL API
  // while retaining a page-local association to the MediaSource group so a
  // capture session can bind to exactly the selected player on multi-player
  // pages. Revocation keeps a bounded route-local lookup because an already
  // attached media element may continue playing that URL.
  try {
    const urlConstructor = scope.URL;
    const originalCreateObjectUrl = urlConstructor.createObjectURL;
    const originalRevokeObjectUrl = urlConstructor.revokeObjectURL;
    if (typeof originalCreateObjectUrl === 'function') {
      urlConstructor.createObjectURL = function (object: Blob | MediaSource): string {
        const url = Reflect.apply(originalCreateObjectUrl, urlConstructor, [object]) as string;
        if (object instanceof MediaSourceConstructor) {
          const record: BlobMediaSourceRecord = {
            sourceRef: new WeakRef(object),
            groupId: currentGroupFor(object),
            routeGeneration,
            revoked: false,
          };
          mediaSourcesByBlobUrl.delete(url);
          mediaSourcesByBlobUrl.set(url, record);
          while (mediaSourcesByBlobUrl.size > maxRememberedBlobUrls) {
            const oldest = mediaSourcesByBlobUrl.keys().next().value as string | undefined;
            if (!oldest) break;
            if (oldest === activeTargetSourceUrl && mediaSourcesByBlobUrl.size > 1) {
              const active = mediaSourcesByBlobUrl.get(oldest);
              mediaSourcesByBlobUrl.delete(oldest);
              if (active) mediaSourcesByBlobUrl.set(oldest, active);
              continue;
            }
            mediaSourcesByBlobUrl.delete(oldest);
          }
          if (url === activeTargetSourceUrl) bindTargetSource(true);
        }
        return url;
      };
    }
    if (typeof originalRevokeObjectUrl === 'function') {
      urlConstructor.revokeObjectURL = function (url: string): void {
        const normalizedUrl = String(url);
        const record = mediaSourcesByBlobUrl.get(normalizedUrl);
        if (record && record.routeGeneration === routeGeneration) {
          // Revoking an object URL prevents future consumers, but an already
          // attached media element can keep playing it. Retain the association
          // until the route changes so a user can begin capture afterwards.
          record.revoked = true;
          mediaSourcesByBlobUrl.delete(normalizedUrl);
          mediaSourcesByBlobUrl.set(normalizedUrl, record);
        }
        Reflect.apply(originalRevokeObjectUrl, urlConstructor, [url]);
      };
    }
  } catch {
    // Some pages lock URL statics. Capture-all remains available in that case.
  }

  try {
    mediaSourcePrototype.addSourceBuffer = function (mime: string): SourceBuffer {
      const buffer = Reflect.apply(originalAddSourceBuffer, this, [mime]) as SourceBuffer;
      metadataFor(buffer, mime, currentGroupFor(this), this);
      return buffer;
    };

    sourceBufferPrototype.appendBuffer = function (source: BufferSource): void {
      const appendRouteGeneration = routeGeneration;
      const canArchiveBeginning =
        archivedBeginningBytes < maxArchivedBeginningBytes && knownMetadata.size < 64;
      let copy: ArrayBuffer | undefined;
      let beforeRanges: BufferedRange[] = [];
      let stateBefore = unreadableTimelineState();
      if ((activeSessionId && !capturePaused) || canArchiveBeginning) {
        try {
          beforeRanges = readBufferedRanges(this);
          stateBefore = readTimelineState(this);
          const sourceView = ArrayBuffer.isView(source)
            ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
            : new Uint8Array(source);
          const owned = new Uint8Array(sourceView.byteLength);
          owned.set(sourceView);
          copy = owned.buffer;
        } catch {
          copy = undefined;
        }
      }

      Reflect.apply(originalAppendBuffer, this, [source]);
      if (!copy) return;
      const cleanup = (): void => {
        this.removeEventListener('updateend', commit);
        this.removeEventListener('error', discard);
        this.removeEventListener('abort', discard);
      };
      const discard = (): void => cleanup();
      const commit = (): void => {
        cleanup();
        if (!copy) return;
        let value = metadataFor(this);
        if (appendRouteGeneration !== routeGeneration) {
          copy = undefined;
          return;
        }
        const afterRanges = readBufferedRanges(this);
        const additions = subtractBufferedRanges(afterRanges, beforeRanges);
        if (value.routeGeneration !== routeGeneration) {
          const startsFreshTimeline =
            beforeRanges.length === 0 &&
            (additions.length === 0 ||
              additions.some(([start]) => start <= beginningGapToleranceSeconds));
          // A page listener registered before this wrapper may call
          // endOfStream() from the same updateend event before our commit
          // listener runs. The append still belongs to this generation; the
          // immutable appendRouteGeneration check above is the stale in-flight
          // guard, while a fresh timeline proves intentional SourceBuffer reuse.
          if (!startsFreshTimeline) {
            copy = undefined;
            return;
          }
          value = forkMetadataForCurrentRoute(this, value);
        }
        const initialization = !value.sawMediaCoverage && additions.length === 0;
        const timeline = appendTimelineFor(value, stateBefore, readTimelineState(this));
        archiveBeginningChunk(value, copy, additions, timeline);
        const sessionId = activeSessionId;
        if (sessionId && !capturePaused && acceptsGroup(value.groupId)) {
          const forwardedRanges = addForwardedCoverage(value, sessionId, additions);
          announce(value);
          chunkSequence += 1;
          send(
            {
              type: 'chunk',
              sessionId,
              routeKey: activeRouteKey,
              hookGeneration: routeGeneration,
              trackId: value.id,
              groupId: value.groupId,
              mime: value.mime,
              sequence: chunkSequence,
              bytes: copy,
              initialization,
              timeline,
              changeTypeGeneration: value.changeTypeGeneration,
              ...unsafeEnvelopeFor(value),
              ...timingForRanges(value.source, forwardedRanges),
            },
            [copy],
          );
        }
        copy = undefined;
      };
      this.addEventListener('updateend', commit);
      this.addEventListener('error', discard);
      this.addEventListener('abort', discard);
    };

    if (typeof originalRemove === 'function') {
      sourceBufferPrototype.remove = function (start: number, end: number): void {
        const operationRouteGeneration = routeGeneration;
        const value = metadataFor(this);
        const stateBefore = readTimelineState(this);
        Reflect.apply(originalRemove, this, [start, end]);
        let settled = false;
        const cleanup = (): void => {
          this.removeEventListener('updateend', completed);
          this.removeEventListener('error', failed);
          this.removeEventListener('abort', aborted);
        };
        const settle = (outcome: 'completed' | 'aborted' | 'error'): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (
            operationRouteGeneration !== routeGeneration ||
            value.routeGeneration !== routeGeneration
          ) {
            return;
          }
          recordTimelineEvent(value, {
            kind: 'remove',
            changeTypeGeneration: value.changeTypeGeneration,
            stateBefore,
            stateAfter: readTimelineState(this),
            start,
            end,
            outcome,
            unsafeTimelineReason: 'remove',
          });
        };
        const completed = (): void => settle('completed');
        const failed = (): void => settle('error');
        const aborted = (): void => settle('aborted');
        this.addEventListener('updateend', completed);
        this.addEventListener('error', failed);
        this.addEventListener('abort', aborted);
      };
    }

    if (typeof originalAbort === 'function') {
      sourceBufferPrototype.abort = function (): void {
        const operationRouteGeneration = routeGeneration;
        const value = metadataFor(this);
        const stateBefore = readTimelineState(this);
        Reflect.apply(originalAbort, this, []);
        if (
          operationRouteGeneration !== routeGeneration ||
          value.routeGeneration !== routeGeneration
        ) {
          return;
        }
        recordTimelineEvent(value, {
          kind: 'abort',
          changeTypeGeneration: value.changeTypeGeneration,
          stateBefore,
          stateAfter: readTimelineState(this),
          outcome: 'completed',
          unsafeTimelineReason: 'abort',
        });
      };
    }

    if (typeof originalChangeType === 'function') {
      sourceBufferPrototype.changeType = function (mime: string): void {
        const stateBefore = readTimelineState(this);
        Reflect.apply(originalChangeType, this, [mime]);
        let previous = metadataFor(this);
        if (
          previous.routeGeneration !== routeGeneration &&
          !(previous.source && endedMediaSources.has(previous.source))
        ) {
          previous = forkMetadataForCurrentRoute(this, previous);
        }
        sourceSequence += 1;
        const value: BufferMetadata = {
          id: `source-${sourceSequence}`,
          groupId: previous.groupId,
          routeGeneration,
          mime,
          ...(previous.source ? { source: previous.source } : {}),
          archivedBeginningChunks: [],
          archivedBeginningBytes: 0,
          beginningCoverageEnd: 0,
          sawMediaCoverage: false,
          forwardedRanges: [],
          appendOrdinal: 0,
          changeTypeGeneration: previous.changeTypeGeneration + 1,
          pendingTimelineEvents: [],
          unsafeTimelineReasons: new Set(previous.unsafeTimelineReasons),
        };
        metadata.set(this, value);
        knownMetadata.add(value);
        recordTimelineEvent(value, {
          kind: 'change-type',
          changeTypeGeneration: value.changeTypeGeneration,
          stateBefore,
          stateAfter: readTimelineState(this),
          mime,
          outcome: 'completed',
          unsafeTimelineReason: 'change-type',
        });
      };
    }

    mediaSourcePrototype.endOfStream = function (error?: EndOfStreamError): void {
      Reflect.apply(originalEndOfStream, this, error == null ? [] : [error]);
      endedMediaSources.add(this);
      if (mediaSourceGenerations.get(this) !== routeGeneration) return;
      const groupId = groupFor(this);
      const values = [...knownMetadata].filter(
        (value) => value.routeGeneration === routeGeneration && value.groupId === groupId,
      );
      if (error != null) {
        for (const value of values) noteUnsafe(value, 'end-of-stream-error');
      }
      timelineEventSequence += 1;
      const timelineEvent: MseTimelineEvent = {
        eventSequence: timelineEventSequence,
        kind: 'end-of-stream',
        changeTypeGeneration: Math.max(0, ...values.map((value) => value.changeTypeGeneration)),
        outcome: 'completed',
        ...(error != null
          ? {
              endOfStreamError: error,
              unsafeTimelineReason: 'end-of-stream-error' as const,
            }
          : {}),
      };
      if (!acceptsGroup(groupId)) return;
      if (activeSessionId && !capturePaused) {
        send({
          type: 'source-ended',
          sessionId: activeSessionId,
          groupId,
          routeKey: activeRouteKey,
          hookGeneration: routeGeneration,
          timelineEvent,
          ...unsafeEnvelopeForGroup(groupId, error != null ? ['end-of-stream-error'] : []),
        });
      } else if (activeSessionId && capturePaused) {
        endedWhilePaused.set(groupId, timelineEvent);
      }
    };
  } catch {
    scope.removeEventListener('message', handleControl);
    const unsupported = {
      version: 3,
      supported: false,
      protocolVersion,
      buildId,
      health: 'unsupported',
      installedNow: true,
    } as const;
    scope.__foxfetchMseCaptureHookV1__ = unsupported;
    return unsupported;
  }

  const installed = {
    version: 3,
    supported: true,
    protocolVersion,
    buildId,
    health: 'ready',
    installedNow: true,
  } as const;
  scope.__foxfetchMseCaptureHookV1__ = installed;
  return installed;
}
