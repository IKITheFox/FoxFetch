import { budgetedSessionStorage } from '../storage/session-budget';
import type {
  MediaRequestHeaders,
  MergeJobSeed,
  MergeJobSourceContext,
  MergeJobSourceLocation,
} from '../../shared/types';
import type { MergeContainerPreference } from '../merge';
import type { MergeJob } from './types';
import { assertMergeJobWriteAllowed } from './cancellation';

export const MERGE_JOB_STORAGE_PREFIX = 'foxfetch:merge-job:';
export const MERGE_JOB_CONTEXT_STORAGE_PREFIX = 'foxfetch:merge-context:';
export const MERGE_JOB_SOURCE_TTL_MS = 6 * 60 * 60 * 1_000;
export const MERGE_JOB_FAILED_SOURCE_TTL_MS = 30 * 60 * 1_000;
export const MERGE_JOB_REDACTED_SOURCE_URL = 'https://redacted.invalid/';

// Concurrent first reads of one legacy record must assign the same random
// presentation identity before its migration has reached persistent storage.
const legacyViewKeys = new Map<string, string>();
function legacyViewKey(seed: Pick<MergeJobSeed, 'id' | 'createdAt'>): string {
  const key = `${seed.id}:${seed.createdAt}`;
  const existing = legacyViewKeys.get(key);
  if (existing) return existing;
  const issued = crypto.randomUUID();
  legacyViewKeys.set(key, issued);
  return issued;
}

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface MergeJobStore {
  get(id: string): Promise<MergeJob | undefined>;
  save(job: MergeJob): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<MergeJob[]>;
}

function storageKey(id: string): string {
  return `${MERGE_JOB_STORAGE_PREFIX}${id}`;
}

function contextStorageKey(id: string): string {
  return `${MERGE_JOB_CONTEXT_STORAGE_PREFIX}${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isMediaRequestHeaders(value: unknown): value is MediaRequestHeaders {
  if (!isRecord(value)) return false;
  const allowed = new Set(['referer', 'origin', 'authorization', 'accept']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const header of Object.values(value)) {
    if (
      typeof header !== 'string' ||
      !header.trim() ||
      header.length > 16_384 ||
      /[\r\n]/u.test(header)
    ) {
      return false;
    }
  }
  if (value.referer != null && (typeof value.referer !== 'string' || !isHttpUrl(value.referer))) {
    return false;
  }
  if (value.origin != null) {
    if (typeof value.origin !== 'string' || !isHttpUrl(value.origin)) return false;
    if (new URL(value.origin).origin !== value.origin) return false;
  }
  return true;
}

function isSourceContext(value: unknown): value is MergeJobSourceContext {
  return (
    isRecord(value) &&
    typeof value.pageUrl === 'string' &&
    isHttpUrl(value.pageUrl) &&
    (value.requestHeaders === undefined || isMediaRequestHeaders(value.requestHeaders))
  );
}

function isSourceLocation(value: unknown): value is MergeJobSourceLocation {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    isHttpUrl(value.url) &&
    (value.declaredMimeType === undefined ||
      (typeof value.declaredMimeType === 'string' &&
        value.declaredMimeType.length <= 512 &&
        !/[\r\n]/u.test(value.declaredMimeType)))
  );
}

function isSourceLocations(value: unknown): value is MergeJobSourceLocation[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((location) => isSourceLocation(location))
  );
}

function isOptionalBoundedString(value: unknown, maxLength = 512): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= maxLength && !/[\r\n]/u.test(value))
  );
}

function isOptionalDynamicRange(value: unknown): boolean {
  return (
    value === undefined ||
    value === 'SDR' ||
    value === 'HDR' ||
    value === 'Dolby Vision' ||
    value === 'unknown'
  );
}

function isOptionalCapabilitySupport(value: unknown): boolean {
  return (
    value === undefined || value === 'supported' || value === 'unsupported' || value === 'unknown'
  );
}

function cloneSourceContext(context: MergeJobSourceContext): MergeJobSourceContext {
  return {
    pageUrl: context.pageUrl,
    ...(context.requestHeaders ? { requestHeaders: { ...context.requestHeaders } } : {}),
  };
}

interface MergeJobSessionData {
  videoUrl?: string;
  audioUrl?: string;
  videoSources?: MergeJobSourceLocation[];
  audioSources?: MergeJobSourceLocation[];
  videoContext?: MergeJobSourceContext;
  audioContext?: MergeJobSourceContext;
  coverUrl?: string;
  requestRuleIds?: number[];
  sourceExpiresAt?: number;
}

function parseSessionData(value: unknown): MergeJobSessionData {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.videoUrl === 'string' && isHttpUrl(value.videoUrl)
      ? { videoUrl: value.videoUrl }
      : {}),
    ...(typeof value.audioUrl === 'string' && isHttpUrl(value.audioUrl)
      ? { audioUrl: value.audioUrl }
      : {}),
    ...(isSourceLocations(value.videoSources)
      ? { videoSources: value.videoSources.map((location) => ({ ...location })) }
      : {}),
    ...(isSourceLocations(value.audioSources)
      ? { audioSources: value.audioSources.map((location) => ({ ...location })) }
      : {}),
    ...(isSourceContext(value.videoContext)
      ? { videoContext: cloneSourceContext(value.videoContext) }
      : {}),
    ...(isSourceContext(value.audioContext)
      ? { audioContext: cloneSourceContext(value.audioContext) }
      : {}),
    ...(typeof value.coverUrl === 'string' && isHttpUrl(value.coverUrl)
      ? { coverUrl: value.coverUrl }
      : {}),
    ...(Array.isArray(value.requestRuleIds) &&
    value.requestRuleIds.every((id) => Number.isInteger(id) && id > 0)
      ? { requestRuleIds: [...value.requestRuleIds] as number[] }
      : {}),
    ...(typeof value.sourceExpiresAt === 'number' && Number.isFinite(value.sourceExpiresAt)
      ? { sourceExpiresAt: value.sourceExpiresAt }
      : {}),
  };
}

function isTerminalWithoutRetrySources(state: MergeJob['state']): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'blocked_drm';
}

export function hasRetainedMergeJobSources(job: Pick<MergeJob, 'videoUrl' | 'audioUrl'>): boolean {
  return (
    job.videoUrl !== MERGE_JOB_REDACTED_SOURCE_URL && job.audioUrl !== MERGE_JOB_REDACTED_SOURCE_URL
  );
}

function sessionDataFromJob(job: MergeJob, sourceExpiresAt: number): MergeJobSessionData {
  return {
    videoUrl: job.videoUrl,
    audioUrl: job.audioUrl,
    ...(job.videoSources
      ? { videoSources: job.videoSources.map((location) => ({ ...location })) }
      : {}),
    ...(job.audioSources
      ? { audioSources: job.audioSources.map((location) => ({ ...location })) }
      : {}),
    ...(job.videoContext ? { videoContext: cloneSourceContext(job.videoContext) } : {}),
    ...(job.audioContext ? { audioContext: cloneSourceContext(job.audioContext) } : {}),
    ...(job.coverUrl ? { coverUrl: job.coverUrl } : {}),
    ...(job.requestRuleIds ? { requestRuleIds: [...job.requestRuleIds] } : {}),
    sourceExpiresAt,
  };
}

function redactMessage(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/giu, '[media-source]');
}

function withoutSensitiveData(job: MergeJob): MergeJob {
  const publicJob = {
    ...job,
    videoUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    audioUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    progress: { ...job.progress, message: redactMessage(job.progress.message) },
    ...(job.plan
      ? {
          plan: {
            ...job.plan,
            video: { ...job.plan.video, url: MERGE_JOB_REDACTED_SOURCE_URL },
            audio: { ...job.plan.audio, url: MERGE_JOB_REDACTED_SOURCE_URL },
          },
        }
      : {}),
    ...(job.failure
      ? { failure: { ...job.failure, message: redactMessage(job.failure.message) } }
      : {}),
  };
  delete publicJob.videoSources;
  delete publicJob.audioSources;
  delete publicJob.videoContext;
  delete publicJob.audioContext;
  delete publicJob.coverUrl;
  delete publicJob.requestRuleIds;
  return publicJob;
}

function hydrateSensitiveData(job: MergeJob, sessionData: MergeJobSessionData): MergeJob {
  const legacyData = parseSessionData(job);
  const publicJob = withoutSensitiveData(job);
  const videoUrl = sessionData.videoUrl ?? legacyData.videoUrl ?? publicJob.videoUrl;
  const audioUrl = sessionData.audioUrl ?? legacyData.audioUrl ?? publicJob.audioUrl;
  const videoSources = sessionData.videoSources ?? legacyData.videoSources;
  const audioSources = sessionData.audioSources ?? legacyData.audioSources;
  const videoContext = sessionData.videoContext ?? legacyData.videoContext;
  const audioContext = sessionData.audioContext ?? legacyData.audioContext;
  const coverUrl = sessionData.coverUrl ?? legacyData.coverUrl;
  const requestRuleIds = sessionData.requestRuleIds ?? legacyData.requestRuleIds;
  return {
    ...publicJob,
    videoUrl,
    audioUrl,
    ...(videoSources ? { videoSources: videoSources.map((location) => ({ ...location })) } : {}),
    ...(audioSources ? { audioSources: audioSources.map((location) => ({ ...location })) } : {}),
    ...(videoContext ? { videoContext: cloneSourceContext(videoContext) } : {}),
    ...(audioContext ? { audioContext: cloneSourceContext(audioContext) } : {}),
    ...(coverUrl ? { coverUrl } : {}),
    ...(requestRuleIds ? { requestRuleIds: [...requestRuleIds] } : {}),
  };
}

function hasPersistentSensitiveData(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const plan = isRecord(value.plan) ? value.plan : undefined;
  const planVideo = plan && isRecord(plan.video) ? plan.video : undefined;
  const planAudio = plan && isRecord(plan.audio) ? plan.audio : undefined;
  return (
    value.videoUrl !== MERGE_JOB_REDACTED_SOURCE_URL ||
    value.audioUrl !== MERGE_JOB_REDACTED_SOURCE_URL ||
    value.videoSources !== undefined ||
    value.audioSources !== undefined ||
    value.videoContext !== undefined ||
    value.audioContext !== undefined ||
    value.coverUrl !== undefined ||
    value.requestRuleIds !== undefined ||
    (typeof planVideo?.url === 'string' && planVideo.url !== MERGE_JOB_REDACTED_SOURCE_URL) ||
    (typeof planAudio?.url === 'string' && planAudio.url !== MERGE_JOB_REDACTED_SOURCE_URL)
  );
}

function isSeed(value: unknown): value is MergeJobSeed {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.videoUrl === 'string' &&
    isHttpUrl(value.videoUrl) &&
    typeof value.audioUrl === 'string' &&
    isHttpUrl(value.audioUrl) &&
    (value.videoSources === undefined || isSourceLocations(value.videoSources)) &&
    (value.audioSources === undefined || isSourceLocations(value.audioSources)) &&
    isOptionalBoundedString(value.videoStreamIdentity) &&
    isOptionalBoundedString(value.audioStreamIdentity) &&
    (value.repeatSelection === undefined ||
      (isRecord(value.repeatSelection) &&
        typeof value.repeatSelection.videoTrackId === 'string' &&
        /^track-[\w-]{1,128}$/u.test(value.repeatSelection.videoTrackId) &&
        typeof value.repeatSelection.audioTrackId === 'string' &&
        /^track-[\w-]{1,128}$/u.test(value.repeatSelection.audioTrackId))) &&
    isOptionalBoundedString(value.videoMimeType) &&
    isOptionalBoundedString(value.audioMimeType) &&
    isOptionalDynamicRange(value.videoDynamicRange) &&
    isOptionalCapabilitySupport(value.videoDynamicRangeRemuxable) &&
    (value.coverUrl === undefined ||
      (typeof value.coverUrl === 'string' && isHttpUrl(value.coverUrl))) &&
    typeof value.createdAt === 'number' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.ownerTabId === undefined ||
      (Number.isInteger(value.ownerTabId) && Number(value.ownerTabId) > 0)) &&
    (value.ownerPageUrl === undefined ||
      (typeof value.ownerPageUrl === 'string' && isHttpUrl(value.ownerPageUrl))) &&
    (value.ownerMediaEpoch === undefined ||
      (typeof value.ownerMediaEpoch === 'number' &&
        Number.isInteger(value.ownerMediaEpoch) &&
        value.ownerMediaEpoch >= 0)) &&
    (value.videoContext === undefined || isSourceContext(value.videoContext)) &&
    (value.audioContext === undefined || isSourceContext(value.audioContext))
  );
}

function isContainerPreference(value: unknown): value is MergeContainerPreference {
  return value === 'auto' || value === 'mp4' || value === 'webm' || value === 'mkv';
}

export function mergeJobFromSeed(
  seed: MergeJobSeed,
  options: { preferredContainer?: MergeContainerPreference; fileName?: string } = {},
): MergeJob {
  const now = Date.now();
  return {
    schemaVersion: 1,
    viewKey: crypto.randomUUID(),
    revision: 0,
    id: seed.id,
    videoUrl: seed.videoUrl,
    audioUrl: seed.audioUrl,
    ...(seed.videoSources
      ? { videoSources: seed.videoSources.map((location) => ({ ...location })) }
      : {}),
    ...(seed.audioSources
      ? { audioSources: seed.audioSources.map((location) => ({ ...location })) }
      : {}),
    ...(seed.videoStreamIdentity ? { videoStreamIdentity: seed.videoStreamIdentity } : {}),
    ...(seed.audioStreamIdentity ? { audioStreamIdentity: seed.audioStreamIdentity } : {}),
    ...(seed.repeatSelection ? { repeatSelection: { ...seed.repeatSelection } } : {}),
    ...(seed.videoMimeType ? { videoMimeType: seed.videoMimeType } : {}),
    ...(seed.audioMimeType ? { audioMimeType: seed.audioMimeType } : {}),
    ...(seed.videoDynamicRange ? { videoDynamicRange: seed.videoDynamicRange } : {}),
    ...(seed.videoDynamicRangeRemuxable
      ? { videoDynamicRangeRemuxable: seed.videoDynamicRangeRemuxable }
      : {}),
    ...(seed.coverUrl ? { coverUrl: seed.coverUrl } : {}),
    ...(seed.videoContext ? { videoContext: cloneSourceContext(seed.videoContext) } : {}),
    ...(seed.audioContext ? { audioContext: cloneSourceContext(seed.audioContext) } : {}),
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.ownerTabId == null ? {} : { ownerTabId: seed.ownerTabId }),
    ...(seed.ownerPageUrl ? { ownerPageUrl: seed.ownerPageUrl } : {}),
    ...(seed.ownerMediaEpoch == null ? {} : { ownerMediaEpoch: seed.ownerMediaEpoch }),
    createdAt: seed.createdAt,
    updatedAt: now,
    state: 'queued',
    preferredContainer: options.preferredContainer ?? 'auto',
    fileName: options.fileName ?? seed.title ?? 'FoxFetch-media',
    progress: {
      phase: 'idle',
      ratio: null,
      readBytes: 0,
      totalBytes: null,
      message: '等待预检',
    },
  };
}

function parseStoredJob(value: unknown): MergeJob | undefined {
  if (!isSeed(value)) return undefined;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return { ...mergeJobFromSeed(value), viewKey: legacyViewKey(value) };
  }
  if (
    typeof value.updatedAt !== 'number' ||
    typeof value.state !== 'string' ||
    !isContainerPreference(value.preferredContainer) ||
    typeof value.fileName !== 'string' ||
    !isRecord(value.progress) ||
    (value.requestRuleIds !== undefined &&
      (!Array.isArray(value.requestRuleIds) ||
        value.requestRuleIds.some((id) => !Number.isInteger(id) || id <= 0)))
  ) {
    return mergeJobFromSeed(value);
  }
  const job = value as unknown as MergeJob;
  return {
    ...job,
    viewKey:
      typeof job.viewKey === 'string' && /^[\w-]{1,128}$/u.test(job.viewKey)
        ? job.viewKey
        : legacyViewKey(job),
    revision: Number.isSafeInteger(job.revision) && (job.revision ?? -1) >= 0 ? job.revision! : 0,
  };
}

export class ChromeMergeJobStore implements MergeJobStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageAreaLike = chrome.storage.local,
    private readonly contextStorage: StorageAreaLike = budgetedSessionStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async get(id: string): Promise<MergeJob | undefined> {
    const key = storageKey(id);
    const sensitiveKey = contextStorageKey(id);
    const [stored, storedContexts] = await Promise.all([
      this.storage.get(key),
      this.contextStorage.get(sensitiveKey),
    ]);
    const storedValue = stored[key];
    const parsed = parseStoredJob(storedValue);
    if (!parsed) return undefined;
    const parsedSession = parseSessionData(storedContexts[sensitiveKey]);
    const sessionExpired =
      parsedSession.sourceExpiresAt != null && parsedSession.sourceExpiresAt <= this.now();
    if (sessionExpired) await this.contextStorage.remove(sensitiveKey);
    const job = hydrateSensitiveData(parsed, sessionExpired ? {} : parsedSession);
    if (
      !isRecord(storedValue) ||
      storedValue.schemaVersion !== 1 ||
      storedValue.viewKey !== parsed.viewKey ||
      storedValue.revision !== parsed.revision ||
      hasPersistentSensitiveData(storedValue) ||
      (!sessionExpired &&
        parsedSession.sourceExpiresAt === undefined &&
        Object.keys(parsedSession).length > 0)
    ) {
      // Upgrade old seeds and scrub legacy signed URLs, mirrors, and request
      // headers from persistent local storage.
      await this.save(job);
    }
    return job;
  }

  async save(job: MergeJob): Promise<void> {
    await this.serializeMutation(async () => {
      const previous = parseStoredJob(
        (await this.storage.get(storageKey(job.id)))[storageKey(job.id)],
      );
      assertMergeJobWriteAllowed(previous, job);
      const sensitiveKey = contextStorageKey(job.id);
      const currentTime = this.now();
      const existing = parseSessionData(
        (await this.contextStorage.get(sensitiveKey))[sensitiveKey],
      );
      const existingExpiry =
        existing.sourceExpiresAt != null && existing.sourceExpiresAt > currentTime
          ? existing.sourceExpiresAt
          : undefined;
      const baseExpiry = existingExpiry ?? currentTime + MERGE_JOB_SOURCE_TTL_MS;
      const sourceExpiresAt =
        job.state === 'failed'
          ? Math.min(baseExpiry, currentTime + MERGE_JOB_FAILED_SOURCE_TTL_MS)
          : baseExpiry;
      const retainSensitive =
        !isTerminalWithoutRetrySources(job.state) && hasRetainedMergeJobSources(job);

      // Persist the redacted job first. If session storage is unavailable, the
      // task fails closed without leaving signed CDN URLs or auth data on disk.
      await this.storage.set({ [storageKey(job.id)]: withoutSensitiveData(job) });
      if (retainSensitive) {
        await this.contextStorage.set({
          [sensitiveKey]: sessionDataFromJob(job, sourceExpiresAt),
        });
      } else {
        await this.contextStorage.remove(sensitiveKey);
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.serializeMutation(async () => {
      await Promise.all([
        this.storage.remove(storageKey(id)),
        this.contextStorage.remove(contextStorageKey(id)),
      ]);
    });
  }

  async list(): Promise<MergeJob[]> {
    const [stored, storedContexts] = await Promise.all([
      this.storage.get(null),
      this.contextStorage.get(null),
    ]);
    const expiredSensitiveKeys: string[] = [];
    const migrations: MergeJob[] = [];
    const jobs = Object.entries(stored)
      .filter(([key]) => key.startsWith(MERGE_JOB_STORAGE_PREFIX))
      .map(([key, value]) => {
        const job = parseStoredJob(value);
        if (!job) return undefined;
        const id = key.slice(MERGE_JOB_STORAGE_PREFIX.length);
        const sensitiveKey = contextStorageKey(id);
        const parsedSession = parseSessionData(storedContexts[sensitiveKey]);
        const sessionExpired =
          parsedSession.sourceExpiresAt != null && parsedSession.sourceExpiresAt <= this.now();
        if (sessionExpired) expiredSensitiveKeys.push(sensitiveKey);
        const hydrated = hydrateSensitiveData(job, sessionExpired ? {} : parsedSession);
        if (
          !isRecord(value) ||
          value.viewKey !== job.viewKey ||
          value.revision !== job.revision ||
          hasPersistentSensitiveData(value) ||
          (!sessionExpired &&
            parsedSession.sourceExpiresAt === undefined &&
            Object.keys(parsedSession).length > 0)
        ) {
          migrations.push(hydrated);
        }
        return hydrated;
      })
      .filter((job): job is MergeJob => job !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (expiredSensitiveKeys.length > 0) await this.contextStorage.remove(expiredSensitiveKeys);
    for (const job of migrations) await this.save(job);
    return jobs;
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Persist a seed without ever placing captured request headers in storage.local. */
export async function saveMergeJobSeed(
  seed: MergeJobSeed,
  storage: StorageAreaLike = chrome.storage.local,
  contextStorage: StorageAreaLike = budgetedSessionStorage,
): Promise<MergeJob> {
  const job = mergeJobFromSeed(seed);
  const store = new ChromeMergeJobStore(storage, contextStorage);
  await store.save(job);
  return job;
}

export class MemoryMergeJobStore implements MergeJobStore {
  private readonly jobs = new Map<string, MergeJob>();

  constructor(initial: MergeJob[] = []) {
    for (const job of initial) this.jobs.set(job.id, structuredClone(job));
  }

  async get(id: string): Promise<MergeJob | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async save(job: MergeJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async list(): Promise<MergeJob[]> {
    return [...this.jobs.values()]
      .map((job) => structuredClone(job))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
