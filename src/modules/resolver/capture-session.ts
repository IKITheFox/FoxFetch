export const BLOB_CAPTURE_SESSION_STATES = [
  'permission_required',
  'reload_required',
  'waiting_for_playback',
  'capturing',
  'analyzing',
  'resolved',
  'failed',
  'cancelled',
] as const;

export type BlobCaptureSessionState = (typeof BLOB_CAPTURE_SESSION_STATES)[number];

export type BlobCaptureInitialState = Extract<
  BlobCaptureSessionState,
  'permission_required' | 'reload_required' | 'waiting_for_playback'
>;

export interface BlobCaptureBinding {
  tabId: number;
  blobAssetId: string;
  frameId: number;
  elementId?: string;
}

export type BlobCaptureObservationKind =
  'manifest' | 'video' | 'audio' | 'segment' | 'request' | 'other';

export interface BlobCaptureObservation {
  id: string;
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
  observedAt: number;
  elementId?: string;
  requestId?: string;
  assetId?: string;
  origin?: string;
  initiator?: string;
  resourceType?: string;
  mime?: string;
  kind?: BlobCaptureObservationKind;
  status?: number;
  size?: number;
  range?: {
    start: number;
    end: number;
    total?: number;
  };
  redirect?: {
    fromUrl: string;
    toUrl: string;
    status: number;
    time: number;
  };
  requestHeaders?: MediaRequestHeaders;
}

export interface BlobCaptureFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BlobCaptureSession {
  id: string;
  binding: BlobCaptureBinding;
  state: BlobCaptureSessionState;
  documentId?: string;
  documentEpoch: number;
  documentBoundAt?: number;
  retiredDocumentIds: string[];
  candidateOrigins: string[];
  observations: BlobCaptureObservation[];
  resolvedAssetIds: string[];
  droppedObservationCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  failure?: BlobCaptureFailure;
}

export interface BlobCaptureSessionLimits {
  maxSessions: number;
  maxObservationsPerSession: number;
  maxCandidateOrigins: number;
  maxResolvedAssetIds: number;
  maxRetiredDocumentIds: number;
  observationMaxAgeMs: number;
  futureObservationToleranceMs: number;
  sessionIdleTtlMs: number;
}

export const DEFAULT_BLOB_CAPTURE_SESSION_LIMITS: Readonly<BlobCaptureSessionLimits> = {
  maxSessions: 8,
  maxObservationsPerSession: 256,
  maxCandidateOrigins: 32,
  maxResolvedAssetIds: 64,
  maxRetiredDocumentIds: 8,
  observationMaxAgeMs: 2 * 60_000,
  futureObservationToleranceMs: 5_000,
  sessionIdleTtlMs: 15 * 60_000,
};

export interface CreateBlobCaptureSessionInput extends BlobCaptureBinding {
  id: string;
  initialState?: BlobCaptureInitialState;
  documentId?: string;
  candidateOrigins?: readonly string[];
}

export interface BlobCaptureTransitionPatch {
  candidateOrigins?: readonly string[];
  resolvedAssetIds?: readonly string[];
  failure?: BlobCaptureFailure;
}

export type BlobCaptureDocumentRejectionReason =
  | 'session_not_found'
  | 'session_expired'
  | 'session_terminal'
  | 'invalid_document_id'
  | 'retired_document'
  | 'document_history_limit';

export type AdoptBlobCaptureDocumentResult =
  | {
      accepted: true;
      session: BlobCaptureSession;
      replacedDocumentId?: string;
    }
  | {
      accepted: false;
      reason: BlobCaptureDocumentRejectionReason;
      session?: BlobCaptureSession;
    };

export type BlobCaptureObservationRejectionReason =
  | 'session_not_found'
  | 'session_expired'
  | 'session_terminal'
  | 'session_not_capturing'
  | 'binding_mismatch'
  | 'document_not_bound'
  | 'document_not_adopted'
  | 'retired_document'
  | 'stale_observation'
  | 'expired_observation'
  | 'future_observation'
  | 'invalid_observation'
  | 'duplicate_observation';

export type RecordBlobCaptureObservationResult =
  | {
      accepted: true;
      session: BlobCaptureSession;
      observation: BlobCaptureObservation;
      evictedObservationIds: string[];
    }
  | {
      accepted: false;
      reason: BlobCaptureObservationRejectionReason;
      session?: BlobCaptureSession;
    };

const TERMINAL_STATES = new Set<BlobCaptureSessionState>(['resolved', 'failed', 'cancelled']);

const TRANSITIONS: Readonly<Record<BlobCaptureSessionState, readonly BlobCaptureSessionState[]>> = {
  permission_required: ['reload_required', 'waiting_for_playback', 'failed', 'cancelled'],
  reload_required: ['permission_required', 'waiting_for_playback', 'failed', 'cancelled'],
  waiting_for_playback: [
    'permission_required',
    'reload_required',
    'capturing',
    'failed',
    'cancelled',
  ],
  capturing: ['reload_required', 'waiting_for_playback', 'analyzing', 'failed', 'cancelled'],
  analyzing: [
    'reload_required',
    'waiting_for_playback',
    'capturing',
    'resolved',
    'failed',
    'cancelled',
  ],
  resolved: [],
  failed: [],
  cancelled: [],
};

export class BlobCaptureSessionLimitError extends Error {
  constructor(limit: number) {
    super(`Blob capture session limit reached (${limit})`);
    this.name = 'BlobCaptureSessionLimitError';
  }
}

export class InvalidBlobCaptureTransitionError extends Error {
  constructor(from: BlobCaptureSessionState, to: BlobCaptureSessionState, detail?: string) {
    super(`Invalid Blob capture transition: ${from} -> ${to}${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidBlobCaptureTransitionError';
  }
}

export class BlobCaptureSessionExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Blob capture session expired: ${sessionId}`);
    this.name = 'BlobCaptureSessionExpiredError';
  }
}

export class InvalidBlobCaptureSessionError extends Error {
  constructor(detail: string) {
    super(`Invalid Blob capture session snapshot: ${detail}`);
    this.name = 'InvalidBlobCaptureSessionError';
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function finiteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite duration`);
  }
}

function assertPositiveDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite duration`);
  }
}

function normalizeLimits(input: Partial<BlobCaptureSessionLimits> = {}): BlobCaptureSessionLimits {
  const limits = { ...DEFAULT_BLOB_CAPTURE_SESSION_LIMITS, ...input };
  assertPositiveInteger('maxSessions', limits.maxSessions);
  assertPositiveInteger('maxObservationsPerSession', limits.maxObservationsPerSession);
  assertPositiveInteger('maxCandidateOrigins', limits.maxCandidateOrigins);
  assertPositiveInteger('maxResolvedAssetIds', limits.maxResolvedAssetIds);
  assertPositiveInteger('maxRetiredDocumentIds', limits.maxRetiredDocumentIds);
  assertPositiveDuration('observationMaxAgeMs', limits.observationMaxAgeMs);
  assertNonNegativeDuration('futureObservationToleranceMs', limits.futureObservationToleranceMs);
  assertPositiveDuration('sessionIdleTtlMs', limits.sessionIdleTtlMs);
  return limits;
}

function uniqueNonEmpty(values: readonly string[], maximum: number): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique.slice(-maximum);
}

function mergeBoundedStrings(
  current: readonly string[],
  incoming: readonly string[],
  maximum: number,
): string[] {
  return uniqueNonEmpty([...current, ...incoming], maximum);
}

function cloneObservation(observation: BlobCaptureObservation): BlobCaptureObservation {
  return {
    ...observation,
    ...(observation.requestHeaders ? { requestHeaders: { ...observation.requestHeaders } } : {}),
    ...(observation.range ? { range: { ...observation.range } } : {}),
    ...(observation.redirect ? { redirect: { ...observation.redirect } } : {}),
  };
}

function cloneSession(session: BlobCaptureSession): BlobCaptureSession {
  return {
    ...session,
    binding: { ...session.binding },
    retiredDocumentIds: [...session.retiredDocumentIds],
    candidateOrigins: [...session.candidateOrigins],
    observations: session.observations.map(cloneObservation),
    resolvedAssetIds: [...session.resolvedAssetIds],
    ...(session.failure ? { failure: { ...session.failure } } : {}),
  };
}

function touchSession(
  session: BlobCaptureSession,
  now: number,
  limits: BlobCaptureSessionLimits,
): BlobCaptureSession {
  return {
    ...session,
    updatedAt: now,
    expiresAt: now + limits.sessionIdleTtlMs,
  };
}

function isHttpOrigin(value: URL): boolean {
  return value.protocol === 'http:' || value.protocol === 'https:';
}

export function normalizeBlobCaptureOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (isHttpOrigin(parsed)) return parsed.origin;
    if (parsed.protocol !== 'blob:' || parsed.origin === 'null') return undefined;
    const embeddedOrigin = new URL(parsed.origin);
    return isHttpOrigin(embeddedOrigin) ? embeddedOrigin.origin : undefined;
  } catch {
    return undefined;
  }
}

function originsFromValues(values: readonly string[], maximum: number): string[] {
  return uniqueNonEmpty(
    values.flatMap((value) => {
      const origin = normalizeBlobCaptureOrigin(value);
      return origin ? [origin] : [];
    }),
    maximum,
  );
}

export function isTerminalBlobCaptureState(state: BlobCaptureSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionBlobCaptureSession(
  from: BlobCaptureSessionState,
  to: BlobCaptureSessionState,
): boolean {
  return (from === to && !isTerminalBlobCaptureState(from)) || TRANSITIONS[from].includes(to);
}

function validateObservation(observation: BlobCaptureObservation): boolean {
  if (!nonEmpty(observation.id) || !nonEmpty(observation.documentId)) return false;
  if (!nonEmpty(observation.url) || !finiteTimestamp(observation.observedAt)) return false;
  if (
    !Number.isInteger(observation.tabId) ||
    observation.tabId < 0 ||
    !Number.isInteger(observation.frameId) ||
    observation.frameId < 0
  ) {
    return false;
  }
  if (observation.requestHeaders != null) {
    if (typeof observation.requestHeaders !== 'object') return false;
    const allowed = new Set(['referer', 'origin', 'authorization', 'accept']);
    if (Object.keys(observation.requestHeaders).some((key) => !allowed.has(key))) return false;
    for (const value of Object.values(observation.requestHeaders)) {
      if (
        typeof value !== 'string' ||
        !nonEmpty(value) ||
        value.length > 16_384 ||
        /[\r\n]/u.test(value)
      ) {
        return false;
      }
    }
    if (
      (observation.requestHeaders.referer != null &&
        !isHttpUrl(observation.requestHeaders.referer)) ||
      (observation.requestHeaders.origin != null &&
        normalizeBlobCaptureOrigin(observation.requestHeaders.origin) !==
          observation.requestHeaders.origin)
    ) {
      return false;
    }
  }
  for (const optionalText of [
    observation.elementId,
    observation.requestId,
    observation.assetId,
    observation.initiator,
    observation.resourceType,
    observation.mime,
  ]) {
    if (optionalText != null && !nonEmpty(optionalText)) return false;
  }
  if (
    observation.origin != null &&
    normalizeBlobCaptureOrigin(observation.origin) !== observation.origin
  ) {
    return false;
  }
  if (
    observation.kind != null &&
    !(['manifest', 'video', 'audio', 'segment', 'request', 'other'] as const).includes(
      observation.kind,
    )
  ) {
    return false;
  }
  if (
    observation.status != null &&
    (!Number.isInteger(observation.status) || observation.status < 100 || observation.status > 599)
  ) {
    return false;
  }
  if (observation.size != null && (!Number.isInteger(observation.size) || observation.size < 0)) {
    return false;
  }
  if (observation.range != null) {
    const { start, end, total } = observation.range;
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(end) ||
      end < start ||
      (total != null && (!Number.isInteger(total) || total <= end))
    ) {
      return false;
    }
  }
  if (observation.redirect != null) {
    const { fromUrl, toUrl, status, time } = observation.redirect;
    if (
      !isHttpUrl(fromUrl) ||
      !isHttpUrl(toUrl) ||
      !Number.isInteger(status) ||
      status < 300 ||
      status > 399 ||
      !finiteTimestamp(time)
    ) {
      return false;
    }
  }
  try {
    const parsed = new URL(observation.url);
    return ['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    return isHttpOrigin(new URL(value));
  } catch {
    return false;
  }
}

function hasUniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    values.every((value) => typeof value === 'string' && nonEmpty(value)) &&
    new Set(values).size === values.length
  );
}

function invalidSession(detail: string): never {
  throw new InvalidBlobCaptureSessionError(detail);
}

function validateSessionSnapshot(
  session: BlobCaptureSession,
  limits: Readonly<BlobCaptureSessionLimits>,
): void {
  if (!session || typeof session !== 'object') invalidSession('snapshot must be an object');
  if (!nonEmpty(session.id)) invalidSession('id must not be empty');
  if (!session.binding || typeof session.binding !== 'object')
    invalidSession('binding is required');
  if (!Number.isInteger(session.binding.tabId) || session.binding.tabId < 0) {
    invalidSession('binding.tabId must be a non-negative integer');
  }
  if (!Number.isInteger(session.binding.frameId) || session.binding.frameId < 0) {
    invalidSession('binding.frameId must be a non-negative integer');
  }
  if (!nonEmpty(session.binding.blobAssetId)) invalidSession('binding.blobAssetId is required');
  if (session.binding.elementId != null && !nonEmpty(session.binding.elementId)) {
    invalidSession('binding.elementId must not be empty');
  }
  if (!(BLOB_CAPTURE_SESSION_STATES as readonly string[]).includes(session.state)) {
    invalidSession('state is unknown');
  }
  if (!Number.isInteger(session.documentEpoch) || session.documentEpoch < 0) {
    invalidSession('documentEpoch must be a non-negative integer');
  }

  const hasDocument = session.documentId != null;
  if (hasDocument && !nonEmpty(session.documentId ?? '')) {
    invalidSession('documentId must not be empty');
  }
  if (hasDocument !== (session.documentBoundAt != null)) {
    invalidSession('documentId and documentBoundAt must be present together');
  }
  if ((!hasDocument && session.documentEpoch !== 0) || (hasDocument && session.documentEpoch < 1)) {
    invalidSession('documentEpoch does not match the current document');
  }

  for (const [name, value] of [
    ['createdAt', session.createdAt],
    ['updatedAt', session.updatedAt],
    ['expiresAt', session.expiresAt],
  ] as const) {
    if (!finiteTimestamp(value)) invalidSession(`${name} must be finite and non-negative`);
  }
  if (session.createdAt > session.updatedAt || session.updatedAt > session.expiresAt) {
    invalidSession('timestamps are out of order');
  }
  if (
    session.documentBoundAt != null &&
    (!finiteTimestamp(session.documentBoundAt) ||
      session.documentBoundAt < session.createdAt ||
      session.documentBoundAt > session.updatedAt)
  ) {
    invalidSession('documentBoundAt is outside the session lifetime');
  }

  if (
    !Array.isArray(session.retiredDocumentIds) ||
    session.retiredDocumentIds.length > limits.maxRetiredDocumentIds ||
    !hasUniqueNonEmptyStrings(session.retiredDocumentIds) ||
    (session.documentId != null && session.retiredDocumentIds.includes(session.documentId))
  ) {
    invalidSession('retiredDocumentIds is invalid');
  }
  if (
    !Array.isArray(session.candidateOrigins) ||
    session.candidateOrigins.length > limits.maxCandidateOrigins ||
    !hasUniqueNonEmptyStrings(session.candidateOrigins) ||
    session.candidateOrigins.some((origin) => normalizeBlobCaptureOrigin(origin) !== origin)
  ) {
    invalidSession('candidateOrigins is invalid');
  }
  if (
    !Array.isArray(session.resolvedAssetIds) ||
    session.resolvedAssetIds.length > limits.maxResolvedAssetIds ||
    !hasUniqueNonEmptyStrings(session.resolvedAssetIds)
  ) {
    invalidSession('resolvedAssetIds is invalid');
  }
  if (session.state === 'resolved' && session.resolvedAssetIds.length === 0) {
    invalidSession('resolved state requires resolvedAssetIds');
  }
  if (!Number.isInteger(session.droppedObservationCount) || session.droppedObservationCount < 0) {
    invalidSession('droppedObservationCount must be a non-negative integer');
  }
  if (
    !Array.isArray(session.observations) ||
    session.observations.length > limits.maxObservationsPerSession
  ) {
    invalidSession('observations exceeds its limit');
  }
  const observationIds = new Set<string>();
  for (const observation of session.observations) {
    if (!validateObservation(observation)) invalidSession('observation is invalid');
    if (observationIds.has(observation.id)) invalidSession('observation ids must be unique');
    observationIds.add(observation.id);
    if (
      observation.tabId !== session.binding.tabId ||
      observation.frameId !== session.binding.frameId ||
      (session.binding.elementId != null &&
        observation.elementId != null &&
        observation.elementId !== session.binding.elementId)
    ) {
      invalidSession('observation binding does not match the session');
    }
  }

  if (session.state === 'failed') {
    if (
      !session.failure ||
      !nonEmpty(session.failure.code) ||
      !nonEmpty(session.failure.message) ||
      typeof session.failure.retryable !== 'boolean'
    ) {
      invalidSession('failed state requires a valid failure');
    }
  } else if (session.failure != null) {
    invalidSession('failure is only valid for failed state');
  }
}

export class BlobCaptureSessionRegistry {
  private readonly sessions = new Map<string, BlobCaptureSession>();
  readonly limits: Readonly<BlobCaptureSessionLimits>;

  constructor(
    limits: Partial<BlobCaptureSessionLimits> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = normalizeLimits(limits);
  }

  get size(): number {
    return this.sessions.size;
  }

  create(input: CreateBlobCaptureSessionInput): BlobCaptureSession {
    const now = this.now();
    if (!nonEmpty(input.id)) throw new TypeError('Capture session id must not be empty');
    if (!nonEmpty(input.blobAssetId)) throw new TypeError('Blob asset id must not be empty');
    if (!Number.isInteger(input.tabId) || input.tabId < 0) {
      throw new TypeError('tabId must be a non-negative integer');
    }
    if (!Number.isInteger(input.frameId) || input.frameId < 0) {
      throw new TypeError('frameId must be a non-negative integer');
    }
    if (input.elementId != null && !nonEmpty(input.elementId)) {
      throw new TypeError('elementId must not be empty');
    }
    if (input.documentId != null && !nonEmpty(input.documentId)) {
      throw new TypeError('documentId must not be empty');
    }
    if (this.sessions.has(input.id)) throw new Error(`Capture session already exists: ${input.id}`);

    this.pruneExpired(now);
    this.makeRoomForSession();

    const binding: BlobCaptureBinding = {
      tabId: input.tabId,
      blobAssetId: input.blobAssetId,
      frameId: input.frameId,
      ...(input.elementId == null ? {} : { elementId: input.elementId }),
    };
    const documentId = input.documentId?.trim();
    const session: BlobCaptureSession = {
      id: input.id.trim(),
      binding,
      state: input.initialState ?? 'waiting_for_playback',
      ...(documentId ? { documentId, documentBoundAt: now } : {}),
      documentEpoch: documentId ? 1 : 0,
      retiredDocumentIds: [],
      candidateOrigins: originsFromValues(
        input.candidateOrigins ?? [],
        this.limits.maxCandidateOrigins,
      ),
      observations: [],
      resolvedAssetIds: [],
      droppedObservationCount: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.limits.sessionIdleTtlMs,
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  get(sessionId: string): BlobCaptureSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  restore(session: BlobCaptureSession): BlobCaptureSession {
    validateSessionSnapshot(session, this.limits);
    const restored = cloneSession(session);
    if (!this.sessions.has(restored.id)) this.makeRoomForSession();
    this.sessions.set(restored.id, restored);
    return cloneSession(restored);
  }

  list(): BlobCaptureSession[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .map(cloneSession);
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  transition(
    sessionId: string,
    nextState: BlobCaptureSessionState,
    patch: BlobCaptureTransitionPatch = {},
  ): BlobCaptureSession {
    const now = this.now();
    const session = this.requireLiveSession(sessionId, now);
    if (!canTransitionBlobCaptureSession(session.state, nextState)) {
      throw new InvalidBlobCaptureTransitionError(session.state, nextState);
    }

    const candidateOrigins = mergeBoundedStrings(
      session.candidateOrigins,
      originsFromValues(patch.candidateOrigins ?? [], this.limits.maxCandidateOrigins),
      this.limits.maxCandidateOrigins,
    );
    const resolvedAssetIds = mergeBoundedStrings(
      session.resolvedAssetIds,
      patch.resolvedAssetIds ?? [],
      this.limits.maxResolvedAssetIds,
    );

    if (nextState === 'resolved' && resolvedAssetIds.length === 0) {
      throw new InvalidBlobCaptureTransitionError(
        session.state,
        nextState,
        'resolvedAssetIds is required',
      );
    }
    if (nextState === 'failed' && !patch.failure) {
      throw new InvalidBlobCaptureTransitionError(session.state, nextState, 'failure is required');
    }
    if (patch.failure && nextState !== 'failed') {
      throw new InvalidBlobCaptureTransitionError(
        session.state,
        nextState,
        'failure is only valid for failed state',
      );
    }

    const next: BlobCaptureSession = touchSession(
      {
        ...session,
        state: nextState,
        candidateOrigins,
        resolvedAssetIds,
        ...(nextState === 'failed' && patch.failure ? { failure: { ...patch.failure } } : {}),
      },
      now,
      this.limits,
    );
    this.sessions.set(sessionId, next);
    return cloneSession(next);
  }

  addCandidateOrigins(sessionId: string, values: readonly string[]): BlobCaptureSession {
    const now = this.now();
    const session = this.requireLiveSession(sessionId, now);
    if (isTerminalBlobCaptureState(session.state)) {
      throw new InvalidBlobCaptureTransitionError(session.state, session.state, 'terminal session');
    }
    const next = touchSession(
      {
        ...session,
        candidateOrigins: mergeBoundedStrings(
          session.candidateOrigins,
          originsFromValues(values, this.limits.maxCandidateOrigins),
          this.limits.maxCandidateOrigins,
        ),
      },
      now,
      this.limits,
    );
    this.sessions.set(sessionId, next);
    return cloneSession(next);
  }

  adoptDocument(sessionId: string, rawDocumentId: string): AdoptBlobCaptureDocumentResult {
    const now = this.now();
    const session = this.sessions.get(sessionId);
    if (!session) return { accepted: false, reason: 'session_not_found' };
    if (session.expiresAt <= now) {
      return { accepted: false, reason: 'session_expired', session: cloneSession(session) };
    }
    if (isTerminalBlobCaptureState(session.state)) {
      return { accepted: false, reason: 'session_terminal', session: cloneSession(session) };
    }
    const documentId = rawDocumentId.trim();
    if (!documentId) {
      return { accepted: false, reason: 'invalid_document_id', session: cloneSession(session) };
    }
    if (session.documentId === documentId) {
      return { accepted: true, session: cloneSession(session) };
    }
    if (session.retiredDocumentIds.includes(documentId)) {
      return { accepted: false, reason: 'retired_document', session: cloneSession(session) };
    }

    const replacedDocumentId = session.documentId;
    if (
      replacedDocumentId &&
      session.retiredDocumentIds.length >= this.limits.maxRetiredDocumentIds
    ) {
      return { accepted: false, reason: 'document_history_limit', session: cloneSession(session) };
    }
    const retiredDocumentIds = replacedDocumentId
      ? [...session.retiredDocumentIds, replacedDocumentId]
      : [...session.retiredDocumentIds];
    const next = touchSession(
      {
        ...session,
        state:
          session.state === 'permission_required' ? 'permission_required' : 'waiting_for_playback',
        documentId,
        documentEpoch: session.documentEpoch + 1,
        documentBoundAt: now,
        retiredDocumentIds,
      },
      now,
      this.limits,
    );
    this.sessions.set(sessionId, next);
    return {
      accepted: true,
      session: cloneSession(next),
      ...(replacedDocumentId ? { replacedDocumentId } : {}),
    };
  }

  recordObservation(
    sessionId: string,
    observationInput: BlobCaptureObservation,
  ): RecordBlobCaptureObservationResult {
    const now = this.now();
    const session = this.sessions.get(sessionId);
    if (!session) return { accepted: false, reason: 'session_not_found' };
    if (session.expiresAt <= now) {
      return { accepted: false, reason: 'session_expired', session: cloneSession(session) };
    }
    if (isTerminalBlobCaptureState(session.state)) {
      return { accepted: false, reason: 'session_terminal', session: cloneSession(session) };
    }
    if (session.state !== 'capturing' && session.state !== 'analyzing') {
      return { accepted: false, reason: 'session_not_capturing', session: cloneSession(session) };
    }
    if (!validateObservation(observationInput)) {
      return { accepted: false, reason: 'invalid_observation', session: cloneSession(session) };
    }
    if (
      observationInput.tabId !== session.binding.tabId ||
      observationInput.frameId !== session.binding.frameId ||
      (session.binding.elementId != null &&
        observationInput.elementId != null &&
        observationInput.elementId !== session.binding.elementId)
    ) {
      return { accepted: false, reason: 'binding_mismatch', session: cloneSession(session) };
    }
    if (!session.documentId || session.documentBoundAt == null) {
      return { accepted: false, reason: 'document_not_bound', session: cloneSession(session) };
    }
    if (observationInput.documentId !== session.documentId) {
      const reason = session.retiredDocumentIds.includes(observationInput.documentId)
        ? 'retired_document'
        : 'document_not_adopted';
      return { accepted: false, reason, session: cloneSession(session) };
    }
    if (observationInput.observedAt < session.documentBoundAt) {
      return { accepted: false, reason: 'stale_observation', session: cloneSession(session) };
    }
    if (now - observationInput.observedAt > this.limits.observationMaxAgeMs) {
      return { accepted: false, reason: 'expired_observation', session: cloneSession(session) };
    }
    if (observationInput.observedAt - now > this.limits.futureObservationToleranceMs) {
      return { accepted: false, reason: 'future_observation', session: cloneSession(session) };
    }
    if (session.observations.some((observation) => observation.id === observationInput.id)) {
      return { accepted: false, reason: 'duplicate_observation', session: cloneSession(session) };
    }

    const observation = cloneObservation(observationInput);
    const allObservations = [...session.observations, observation];
    const overflow = Math.max(0, allObservations.length - this.limits.maxObservationsPerSession);
    const evicted = allObservations.slice(0, overflow);
    const observations = allObservations.slice(overflow);
    const observationOrigin = normalizeBlobCaptureOrigin(observation.origin ?? observation.url);
    const candidateOrigins = observationOrigin
      ? mergeBoundedStrings(
          session.candidateOrigins,
          [observationOrigin],
          this.limits.maxCandidateOrigins,
        )
      : [...session.candidateOrigins];
    const next = touchSession(
      {
        ...session,
        observations,
        candidateOrigins,
        droppedObservationCount: session.droppedObservationCount + overflow,
      },
      now,
      this.limits,
    );
    this.sessions.set(sessionId, next);
    return {
      accepted: true,
      session: cloneSession(next),
      observation: cloneObservation(observation),
      evictedObservationIds: evicted.map((item) => item.id),
    };
  }

  pruneExpired(at: number = this.now()): string[] {
    if (!finiteTimestamp(at))
      throw new RangeError('Prune timestamp must be finite and non-negative');
    const removed: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > at) continue;
      this.sessions.delete(id);
      removed.push(id);
    }
    return removed;
  }

  private now(): number {
    const value = this.clock();
    if (!finiteTimestamp(value))
      throw new RangeError('Clock must return a finite non-negative time');
    return value;
  }

  private requireLiveSession(sessionId: string, now: number): BlobCaptureSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Capture session not found: ${sessionId}`);
    if (session.expiresAt <= now) throw new BlobCaptureSessionExpiredError(sessionId);
    return session;
  }

  private makeRoomForSession(): void {
    if (this.sessions.size < this.limits.maxSessions) return;
    const terminal = [...this.sessions.values()]
      .filter((session) => isTerminalBlobCaptureState(session.state))
      .sort(
        (left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id),
      )[0];
    if (terminal) {
      this.sessions.delete(terminal.id);
      return;
    }
    throw new BlobCaptureSessionLimitError(this.limits.maxSessions);
  }
}
import type { MediaRequestHeaders } from '../../shared/types';
