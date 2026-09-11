import { describe, expect, it } from 'vitest';
import { buildMediaProducts } from '../../src/modules/media-products';
import { canRepeatMergeDownload, selectRepeatTracks } from '../../src/modules/jobs/repeat-download';
import {
  ChromeMergeJobStore,
  mergeJobFromSeed,
  MERGE_JOB_CONTEXT_STORAGE_PREFIX,
  MERGE_JOB_REDACTED_SOURCE_URL,
} from '../../src/modules/jobs/store';
import { presentMergeDockJob, MergeDockGrantBroker } from '../../src/modules/jobs/dock-access';
import { canTransitionMergeJob } from '../../src/modules/jobs/state-machine';
import type { MediaAsset } from '../../src/shared/types';
import type { MergeJob } from '../../src/modules/jobs/types';

const pageUrl = 'https://www.bilibili.com/video/BV1CURRENT1/';
function assets(): MediaAsset[] {
  return (['video', 'audio'] as const).map((kind, i) => ({
    id: kind,
    kind,
    url: `https://cdn.test/41482390218-1-${i ? '30280' : '30112'}.m4s?token=old`,
    pageUrl,
    pageTitle: '当前视频',
    frameId: 0,
    detectedBy: ['manifest'],
    mime: `${kind}/mp4`,
    duration: 36,
    downloadable: true,
    discoveredAt: 100,
    ...(kind === 'video' ? { width: 1920, height: 1080 } : {}),
  }));
}
function fixture() {
  const input = assets();
  const products = buildMediaProducts(input, { pageUrl });
  const v = products[0]!.videoTracks[0]!;
  const a = products[0]!.audioTracks[0]!;
  const job: MergeJob = {
    ...mergeJobFromSeed({
      id: 'old',
      createdAt: 1,
      videoUrl: input[0]!.url,
      audioUrl: input[1]!.url,
      ownerTabId: 7,
      ownerPageUrl: pageUrl,
      ownerMediaEpoch: 4,
      videoStreamIdentity: v.streamIdentity!,
      audioStreamIdentity: a.streamIdentity!,
      repeatSelection: { videoTrackId: v.id, audioTrackId: a.id },
    }),
    state: 'completed',
    outputSizeBytes: 1024,
    publicationCommitted: true,
  };
  return { input, products, job };
}
class Storage {
  values: Record<string, unknown> = {};
  async get(key?: string | string[] | null) {
    return key == null
      ? { ...this.values }
      : Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, this.values[k]]));
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.values, items);
  }
  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.values[key];
  }
}
describe('v0.13.2 repeat download', () => {
  it('allows a settled cancellation to seed a new task but never revives the cancelled record', async () => {
    const { job, products } = fixture();
    const cancelled: MergeJob = {
      ...job,
      state: 'cancelled',
      cancellationRequestedAt: 123,
      publicationPending: false,
    };
    expect(canRepeatMergeDownload(cancelled)).toBe(true);
    expect(selectRepeatTracks(cancelled, products).videoTrack.id).toBe(
      job.repeatSelection!.videoTrackId,
    );
    expect(canTransitionMergeJob('cancelled', 'fetching')).toBe(false);
    for (const patch of [
      { cancellationFailure: 'STOP_TIMEOUT' as const },
      { publicationPending: true },
      { repeatedByJobId: 'new' },
      { state: 'fetching' as const },
    ])
      expect(canRepeatMergeDownload({ ...cancelled, ...patch })).toBe(false);
    expect(() => selectRepeatTracks(cancelled, [...products, ...products])).toThrow();
    const broker = new MergeDockGrantBroker(new Storage());
    const tokens = await broker.getOrIssue(cancelled);
    expect(broker.claimPermissionRequest(tokens.actionToken, { tabId: 7, pageUrl })).toBe(true);
    expect(
      presentMergeDockJob(cancelled, tokens, {
        savePath: 'Downloads/FoxFetch/Bilibili',
        pathMode: 'automatic',
      }).mergeEnabled,
    ).toBe(true);
  });
  it('enables both actions only after completion, without reviving the terminal state', () => {
    const { job } = fixture();
    const view = presentMergeDockJob(
      job,
      { actionToken: 'a', pathToken: 'p' },
      { savePath: 'Downloads/FoxFetch', pathMode: 'automatic' },
    );
    expect(view).toMatchObject({
      state: 'completed',
      mergeEnabled: true,
      separateEnabled: true,
      busy: false,
      progress: 1,
    });
    expect(canTransitionMergeJob('completed', 'fetching')).toBe(false);
    for (const state of [
      'fetching',
      'muxing',
      'saving',
      'verifying',
      'cancelled',
      'blocked_drm',
    ] as const)
      expect(canRepeatMergeDownload({ ...job, state })).toBe(false);
    expect(canRepeatMergeDownload({ ...job, repeatedByJobId: 'new' })).toBe(false);
    const legacy = { ...job };
    delete legacy.repeatSelection;
    expect(canRepeatMergeDownload(legacy)).toBe(false);
  });
  it('reacquires the same tracks after signed URLs rotate, never switches to another quality/audio', () => {
    const { job, input } = fixture();
    const refreshed = buildMediaProducts(
      input.map((a) => ({ ...a, url: a.url.replace('token=old', 'token=fresh') })),
      { pageUrl },
    );
    expect(selectRepeatTracks(job, refreshed).videoTrack.asset.url).toContain('token=fresh');
    expect(() => selectRepeatTracks(job, [])).toThrow('原来选择的画质或音轨暂不可用');
    expect(() =>
      selectRepeatTracks(
        { ...job, repeatSelection: { ...job.repeatSelection!, audioTrackId: 'track-other' } },
        refreshed,
      ),
    ).not.toThrow();
    expect(() =>
      selectRepeatTracks({ ...job, videoStreamIdentity: 'other-media' }, refreshed),
    ).toThrow();
  });
  it('keeps only track identifiers after completion and retains separate completion records', async () => {
    const { job } = fixture();
    const local = new Storage();
    const session = new Storage();
    const store = new ChromeMergeJobStore(local, session);
    await store.save({ ...job, state: 'ready' });
    expect(session.values[MERGE_JOB_CONTEXT_STORAGE_PREFIX + job.id]).toBeDefined();
    await store.save(job);
    const saved = (await store.get(job.id))!;
    expect(saved.videoUrl).toBe(MERGE_JOB_REDACTED_SOURCE_URL);
    expect(saved.repeatSelection).toEqual(job.repeatSelection);
    expect(session.values[MERGE_JOB_CONTEXT_STORAGE_PREFIX + job.id]).toBeUndefined();
    await store.save({ ...saved, repeatedByJobId: 'new' });
    expect((await store.get(job.id))!.state).toBe('completed');
  });
  it('issues repeat permission capabilities but revokes them when the new task replaces the old one', async () => {
    const { job } = fixture();
    const storage = new Storage();
    const broker = new MergeDockGrantBroker(storage);
    const tokens = await broker.getOrIssue(job);
    expect(broker.claimPermissionRequest(tokens.actionToken, { tabId: 7, pageUrl })).toBe(true);
    broker.releasePermissionClaim(tokens.actionToken);
    await broker.getOrIssue({ ...job, id: 'new', state: 'queued' });
    await broker.clearJob(job.id);
    await expect(
      broker.authorize({ token: tokens.actionToken, scope: 'action', tabId: 7, pageUrl }),
    ).rejects.toThrow();
  });
});
