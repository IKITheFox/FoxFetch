import { describe, expect, it } from 'vitest';
import {
  ChromeMergeJobStore,
  MERGE_JOB_FAILED_SOURCE_TTL_MS,
  MERGE_JOB_CONTEXT_STORAGE_PREFIX,
  MERGE_JOB_REDACTED_SOURCE_URL,
  MERGE_JOB_STORAGE_PREFIX,
  hasRetainedMergeJobSources,
  mergeJobFromSeed,
  type StorageAreaLike,
} from '../../src/modules/jobs';

class FakeStorage implements StorageAreaLike {
  readonly values = new Map<string, unknown>();

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return Object.fromEntries(this.values);
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(requested.map((key) => [key, this.values.get(key)]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

class DelayedFirstSetStorage extends FakeStorage {
  private releaseFirstSet!: () => void;
  private markFirstSetStarted!: () => void;
  private firstSet = true;
  readonly firstSetStarted = new Promise<void>((resolve) => {
    this.markFirstSetStarted = resolve;
  });

  release(): void {
    this.releaseFirstSet();
  }

  override async set(items: Record<string, unknown>): Promise<void> {
    if (this.firstSet) {
      this.firstSet = false;
      this.markFirstSetStarted();
      await new Promise<void>((resolve) => {
        this.releaseFirstSet = resolve;
      });
    }
    await super.set(items);
  }
}

describe('merge job persistence and query loading', () => {
  it('migrates legacy presentation identity once, including concurrent first reads', async () => {
    const storage = new FakeStorage();
    const context = new FakeStorage();
    const legacy = mergeJobFromSeed({
      id: 'legacy-view',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      createdAt: 300,
    });
    delete legacy.viewKey;
    delete legacy.revision;
    storage.values.set(`${MERGE_JOB_STORAGE_PREFIX}legacy-view`, legacy);
    const store = new ChromeMergeJobStore(storage, context);
    const [first, second] = await Promise.all([store.get('legacy-view'), store.get('legacy-view')]);
    expect(first?.viewKey).toBeTruthy();
    expect(first?.viewKey).toBe(second?.viewKey);
    expect(first?.revision).toBe(0);
    const reloaded = await new ChromeMergeJobStore(storage, context).get('legacy-view');
    expect(reloaded?.viewKey).toBe(first?.viewKey);
    expect(JSON.stringify({ taskKey: reloaded?.viewKey })).not.toContain('legacy-view');
  });
  it('upgrades the background MergeJobSeed contract in storage.local', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    storage.values.set(`${MERGE_JOB_STORAGE_PREFIX}seed-1`, {
      id: 'seed-1',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: {
          referer: 'https://page.example/watch',
          authorization: 'Bearer video-token',
        },
      },
      audioContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { origin: 'https://page.example' },
      },
      title: 'Seed title',
      createdAt: 100,
    });
    const store = new ChromeMergeJobStore(storage, contextStorage);

    const loaded = await store.get('seed-1');
    expect(loaded).toMatchObject({
      schemaVersion: 1,
      id: 'seed-1',
      state: 'queued',
      preferredContainer: 'auto',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { authorization: 'Bearer video-token' },
      },
      audioContext: {
        requestHeaders: { origin: 'https://page.example' },
      },
    });
    expect(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}seed-1`)).toMatchObject({
      schemaVersion: 1,
      videoUrl: MERGE_JOB_REDACTED_SOURCE_URL,
      audioUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    });
    expect(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}seed-1`)).not.toHaveProperty(
      'videoContext',
    );
    expect(contextStorage.values.get(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}seed-1`)).toMatchObject({
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: {
          referer: 'https://page.example/watch',
          authorization: 'Bearer video-token',
        },
      },
      audioContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { origin: 'https://page.example' },
      },
    });
  });

  it('keeps captured authorization in storage.session and hydrates it on read', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    const store = new ChromeMergeJobStore(storage, contextStorage);
    const job = mergeJobFromSeed({
      id: 'session-context',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { authorization: 'Bearer short-lived' },
      },
      createdAt: 100,
    });
    job.requestRuleIds = [1_900_010_001];

    await store.save(job);

    expect(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}session-context`)).not.toHaveProperty(
      'videoContext',
    );
    expect(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}session-context`)).not.toHaveProperty(
      'requestRuleIds',
    );
    expect(
      contextStorage.values.get(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}session-context`),
    ).toMatchObject({
      videoContext: { requestHeaders: { authorization: 'Bearer short-lived' } },
      requestRuleIds: [1_900_010_001],
    });
    await expect(store.get('session-context')).resolves.toMatchObject({
      videoContext: { requestHeaders: { authorization: 'Bearer short-lived' } },
      requestRuleIds: [1_900_010_001],
    });

    await store.remove('session-context');
    expect(storage.values.has(`${MERGE_JOB_STORAGE_PREFIX}session-context`)).toBe(false);
    expect(contextStorage.values.has(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}session-context`)).toBe(
      false,
    );
  });

  it('keeps the epoch-bound cover URL in session storage only', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    const store = new ChromeMergeJobStore(storage, contextStorage);
    const job = mergeJobFromSeed({
      id: 'cover-session-only',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      coverUrl: 'https://i.example/cover.jpg?signature=private',
      createdAt: 100,
    });

    await store.save(job);

    expect(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}${job.id}`)).not.toHaveProperty(
      'coverUrl',
    );
    expect(contextStorage.values.get(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}${job.id}`)).toMatchObject(
      { coverUrl: job.coverUrl },
    );
    await expect(store.get(job.id)).resolves.toMatchObject({ coverUrl: job.coverUrl });
  });

  it('serializes saves so a ready-state release cannot restore stale session rule ids', async () => {
    const storage = new FakeStorage();
    const contextStorage = new DelayedFirstSetStorage();
    const store = new ChromeMergeJobStore(storage, contextStorage);
    const protectedJob = mergeJobFromSeed({
      id: 'save-order',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: { pageUrl: 'https://page.example/watch' },
      createdAt: 100,
    });
    protectedJob.requestRuleIds = [1_900_010_002];
    const cleaned = { ...protectedJob };
    delete cleaned.requestRuleIds;

    const savingProtected = store.save(protectedJob);
    await contextStorage.firstSetStarted;
    const savingCleaned = store.save(cleaned);
    contextStorage.release();
    await Promise.all([savingProtected, savingCleaned]);

    expect(
      contextStorage.values.get(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}save-order`),
    ).toMatchObject({
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: { pageUrl: 'https://page.example/watch' },
    });
    await expect(store.get('save-order')).resolves.not.toHaveProperty('requestRuleIds');
  });

  it('deep-clones per-track request context when upgrading a seed', () => {
    const seed = {
      id: 'context-seed',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoSources: [
        {
          url: 'https://backup.example/video.mp4',
          declaredMimeType: 'video/mp4; codecs="avc1.640028"',
        },
      ],
      videoStreamIdentity: 'bilibili:41533243594-1',
      audioStreamIdentity: 'bilibili:41533243594-1',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { authorization: 'Bearer original' },
      },
      createdAt: 100,
    };
    const job = mergeJobFromSeed(seed);

    seed.videoContext.requestHeaders.authorization = 'Bearer mutated';
    seed.videoSources[0]!.url = 'https://evil.example/replaced.mp4';
    expect(job.videoContext?.requestHeaders?.authorization).toBe('Bearer original');
    expect(job.videoSources?.[0]?.url).toBe('https://backup.example/video.mp4');
    expect(job.videoStreamIdentity).toBe(job.audioStreamIdentity);
  });

  it('retains the fail-closed Bilibili dynamic-range constraint on a merge job', () => {
    const job = mergeJobFromSeed({
      id: 'dolby-vision-policy',
      videoUrl: 'https://media.example/video.m4s',
      audioUrl: 'https://media.example/audio.m4s',
      videoDynamicRange: 'Dolby Vision',
      videoDynamicRangeRemuxable: 'unsupported',
      createdAt: 100,
    });

    expect(job).toMatchObject({
      videoDynamicRange: 'Dolby Vision',
      videoDynamicRangeRemuxable: 'unsupported',
    });
  });

  it('rejects unbounded or non-http persisted mirror locations', async () => {
    const storage = new FakeStorage();
    storage.values.set(`${MERGE_JOB_STORAGE_PREFIX}bad-mirror`, {
      id: 'bad-mirror',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoSources: [{ url: 'file:///private/video.mp4' }],
      createdAt: 100,
    });

    await expect(
      new ChromeMergeJobStore(storage, new FakeStorage()).get('bad-mirror'),
    ).resolves.toBeUndefined();
  });

  it('rejects persisted contexts containing Cookie or malformed origins', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    storage.values.set(`${MERGE_JOB_STORAGE_PREFIX}bad-context`, {
      id: 'bad-context',
      videoUrl: 'https://media.example/video.mp4',
      audioUrl: 'https://media.example/audio.m4a',
      videoContext: {
        pageUrl: 'https://page.example/watch',
        requestHeaders: { cookie: 'session=private' },
      },
      createdAt: 100,
    });

    await expect(
      new ChromeMergeJobStore(storage, contextStorage).get('bad-context'),
    ).resolves.toBeUndefined();
  });

  it('keeps signed primaries and mirrors out of persistent storage and expires failed sources', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    let now = 10_000;
    const store = new ChromeMergeJobStore(storage, contextStorage, () => now);
    const job = mergeJobFromSeed({
      id: 'signed-session-only',
      videoUrl: 'https://video-cdn.example/v.m4s?expires=99&sig=video-secret',
      audioUrl: 'https://audio-cdn.example/a.m4s?expires=99&sig=audio-secret',
      videoSources: [{ url: 'https://video-mirror.example/v.m4s?token=mirror-video-secret' }],
      audioSources: [{ url: 'https://audio-mirror.example/a.m4s?token=mirror-audio-secret' }],
      createdAt: 1,
    });
    job.plan = {
      mode: 'packet-copy',
      container: 'mp4',
      extension: '.mp4',
      mimeType: 'video/mp4',
      video: {
        url: job.videoUrl,
        kind: 'video',
        formatName: 'mp4',
        mimeType: 'video/mp4',
        codec: 'avc',
        codecParameterString: 'avc1.640028',
        internalCodecId: 'avc1',
        durationSeconds: 60,
        firstTimestampSeconds: 0,
        sizeBytes: 1_000,
        live: false,
      },
      audio: {
        url: job.audioUrl,
        kind: 'audio',
        formatName: 'mp4',
        mimeType: 'audio/mp4',
        codec: 'aac',
        codecParameterString: 'mp4a.40.2',
        internalCodecId: 'mp4a',
        durationSeconds: 60,
        firstTimestampSeconds: 0,
        sizeBytes: 100,
        live: false,
      },
      estimatedInputBytes: 1_100,
      estimatedDurationSeconds: 60,
      warnings: [],
    };

    await store.save(job);
    const persistent = storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}signed-session-only`);
    expect(persistent).toMatchObject({
      videoUrl: MERGE_JOB_REDACTED_SOURCE_URL,
      audioUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    });
    expect(JSON.stringify(persistent)).not.toContain('video-secret');
    expect(JSON.stringify(persistent)).not.toContain('audio-secret');
    expect(JSON.stringify(persistent)).not.toContain('mirror-');
    await expect(store.get(job.id)).resolves.toMatchObject({
      videoUrl: job.videoUrl,
      audioUrl: job.audioUrl,
      videoSources: job.videoSources,
      audioSources: job.audioSources,
    });

    const failed = {
      ...job,
      state: 'failed' as const,
      updatedAt: now,
      failure: {
        code: 'NETWORK_FAILED' as const,
        message: `temporary failure at ${job.videoUrl}`,
        retryable: true,
        canDownloadSeparately: true,
      },
    };
    await store.save(failed);
    expect(
      JSON.stringify(storage.values.get(`${MERGE_JOB_STORAGE_PREFIX}${job.id}`)),
    ).not.toContain('video-secret');
    const retained = await store.get(job.id);
    expect(hasRetainedMergeJobSources(retained!)).toBe(true);

    now += MERGE_JOB_FAILED_SOURCE_TTL_MS + 1;
    const expired = await store.get(job.id);
    expect(expired).toMatchObject({
      videoUrl: MERGE_JOB_REDACTED_SOURCE_URL,
      audioUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    });
    expect(hasRetainedMergeJobSources(expired!)).toBe(false);
    expect(contextStorage.values.has(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}${job.id}`)).toBe(false);
  });

  it('removes session source data immediately when a job reaches a non-retry terminal state', async () => {
    const storage = new FakeStorage();
    const contextStorage = new FakeStorage();
    const store = new ChromeMergeJobStore(storage, contextStorage, () => 20_000);
    const job = mergeJobFromSeed({
      id: 'completed-cleanup',
      videoUrl: 'https://media.example/video.m4s?sig=private-video',
      audioUrl: 'https://media.example/audio.m4s?sig=private-audio',
      createdAt: 1,
    });
    await store.save(job);
    await store.save({ ...job, state: 'completed', outputSizeBytes: 123, updatedAt: 20_001 });

    expect(contextStorage.values.has(`${MERGE_JOB_CONTEXT_STORAGE_PREFIX}${job.id}`)).toBe(false);
    const loaded = await store.get(job.id);
    expect(loaded).toMatchObject({
      state: 'completed',
      videoUrl: MERGE_JOB_REDACTED_SOURCE_URL,
      audioUrl: MERGE_JOB_REDACTED_SOURCE_URL,
    });
  });
});
