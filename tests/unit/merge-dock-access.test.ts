import { describe, expect, it } from 'vitest';
import { mergeError, normalizeMergeError } from '../../src/modules/merge/errors';

import {
  MergeDockGrantBroker,
  claimMergeDockPermissionFromMessage,
  getMergeDownloadPathPolicy,
  mergeJobFromSeed,
  presentMergeDockJob,
  presentMergeDownloadPath,
  saveMergeDownloadPathPolicy,
  transitionMergeJob,
  updateMergeJobProgress,
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

function ownedJob() {
  return mergeJobFromSeed({
    id: 'private-job-id',
    videoUrl: 'https://cdn.example.test/private-video.m4s?token=video-secret',
    audioUrl: 'https://cdn.example.test/private-audio.m4s?token=audio-secret',
    videoContext: {
      pageUrl: 'https://watch.example.test/video/42',
      requestHeaders: { authorization: 'Bearer private-header' },
    },
    audioContext: { pageUrl: 'https://watch.example.test/video/42' },
    ownerTabId: 42,
    ownerPageUrl: 'https://watch.example.test/video/42',
    ownerMediaEpoch: 7,
    title: '示例视频',
    createdAt: 100,
  });
}

describe('merge Dock capabilities', () => {
  it('propagates sanitized source timeline evidence from an error without mislabelling all failures as complex edits', () => {
    const sourceTimeline = {
      issue: 'open-ended-offset' as const,
      box: 'elst' as const,
      sourceKind: 'audio' as const,
      version: 1 as const,
      entryCount: 1,
      entryIndex: 0,
      movieTimescale: 1000,
      mediaTimescale: 48000,
      duration: 0,
      mediaTime: 1024,
      rate: 65536,
      url: 'https://private.test/?token=source-secret',
      payload: new Uint8Array([1]),
      path: 'C:/private/source.mp4',
      privateJobId: 'private-job-id',
    };
    const failure = normalizeMergeError(
      mergeError('TIMELINE_MISMATCH', 'private worker detail', {
        reason: 'SOURCE_EDIT_LIST_UNSUPPORTED',
        stage: 'media-metadata',
        sourceTimeline,
      }),
    ).detail;
    expect(failure.sourceTimeline).toBe(sourceTimeline);
    const job = transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'failed', {
      failure,
    });
    const tokens = { actionToken: 'action', pathToken: 'path' };
    const path = { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' as const };
    const view = presentMergeDockJob(job, tokens, path);
    expect(view.diagnostics?.sourceTimeline).toEqual({
      issue: 'open-ended-offset',
      box: 'elst',
      sourceKind: 'audio',
      version: 1,
      entryCount: 1,
      entryIndex: 0,
      movieTimescale: 1000,
      mediaTimescale: 48000,
      duration: 0,
      mediaTime: 1024,
      rate: 65536,
    });
    expect(view.diagnostics?.reason).toBe('来源时间轴结构暂无法验证，请查看具体原因。');
    expect(JSON.stringify(view.diagnostics)).not.toMatch(
      /source-secret|https:|private|payload|C:\//,
    );
    expect(
      presentMergeDockJob({ ...job, state: 'cancelled' }, tokens, path).diagnostics,
    ).not.toHaveProperty('sourceTimeline');
    expect(
      presentMergeDockJob({ ...job, cancellationRequestedAt: 101 }, tokens, path).diagnostics,
    ).not.toHaveProperty('sourceTimeline');
  });
  it('labels HDR output metadata failure independently from Dolby Vision failure', () => {
    const failed = transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'failed', {
      failure: {
        code: 'DYNAMIC_RANGE_UNVERIFIED',
        reason: 'HDR_METADATA_MISMATCH',
        stage: 'verify-output',
        message: 'private worker message',
        retryable: false,
        canDownloadSeparately: true,
      },
    });
    const view = presentMergeDockJob(
      failed,
      { actionToken: 'action', pathToken: 'path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );
    expect(view.diagnostics).toMatchObject({
      reasonCode: 'HDR_METADATA_MISMATCH',
      reason: '生成文件的 HDR 信息未通过检查，未生成完整视频。',
    });
    expect(view.diagnostics?.reason).not.toContain('杜比');
  });
  it('publishes actual DV configuration fields while rebuilding away private injected fields', () => {
    const failure = {
      code: 'DYNAMIC_RANGE_UNVERIFIED' as const,
      message: 'private https://cdn.example.test/?token=secret',
      retryable: false,
      canDownloadSeparately: true,
      reason: 'DV_METADATA_MISMATCH' as const,
      stage: 'verify-output' as const,
      configuration: {
        source: {
          sampleEntryType: 'hvc1' as const,
          profile: 8,
          level: 6,
          rpuPresent: true,
          baseLayerPresent: true,
          enhancementLayerPresent: false,
          bitDepthLuma: 10,
          bitDepthChroma: 10,
          chromaFormatIdc: 1,
          parameterSetsComplete: true,
          parameterSetsConflict: false,
          colourSource: 'sps-vui' as const,
          colourPrimaries: 9,
          transferCharacteristics: 16,
          matrixCoefficients: 9,
          fullRange: false,
          url: 'https://cdn.example.test/?token=secret',
          payloadSha256: 'private-hash',
          authorization: 'Bearer private-header',
          raw: new Uint8Array([1, 2, 3]),
        },
        output: { sampleEntryType: 'hvc1' as const, bitDepthLuma: 10 },
      },
    };
    const failed = transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'failed', {
      failure,
    });
    const view = presentMergeDockJob(
      failed,
      { actionToken: 'action', pathToken: 'path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );
    expect(view.diagnostics?.configuration).toEqual({
      source: {
        sampleEntryType: 'hvc1',
        profile: 8,
        level: 6,
        rpuPresent: true,
        baseLayerPresent: true,
        enhancementLayerPresent: false,
        bitDepthLuma: 10,
        bitDepthChroma: 10,
        chromaFormatIdc: 1,
        parameterSetsComplete: true,
        parameterSetsConflict: false,
        colourSource: 'sps-vui',
        colourPrimaries: 9,
        transferCharacteristics: 16,
        matrixCoefficients: 9,
        fullRange: false,
      },
      output: { sampleEntryType: 'hvc1', bitDepthLuma: 10 },
    });
    for (const secret of [
      'cdn.example.test',
      'private-hash',
      'private-header',
      'payloadSha256',
      'authorization',
    ])
      expect(JSON.stringify(view)).not.toContain(secret);
  });
  it('never opens a host-permission prompt for a cancel action', async () => {
    const broker = new MergeDockGrantBroker(new FakeStorage());
    const source = { ...ownedJob(), state: 'ready' as const };
    const tokens = await broker.getOrIssue(source);
    const claim = claimMergeDockPermissionFromMessage(
      { type: 'RUN_MERGE_DOCK_ACTION', action: 'cancel', token: tokens.actionToken },
      { tab: { id: 42, url: source.ownerPageUrl }, frameId: 0 },
      broker,
    );
    expect(claim).toBeUndefined();
    await expect(
      broker.authorize({
        token: tokens.actionToken,
        scope: 'action',
        tabId: 42,
        pageUrl: source.ownerPageUrl!,
      }),
    ).resolves.toMatchObject({ jobId: source.id });
  });

  it('places the concrete transfer or mux detail below one global percentage', () => {
    let downloading = transitionMergeJob(ownedJob(), 'resolving');
    downloading = transitionMergeJob(downloading, 'ready');
    downloading = transitionMergeJob(downloading, 'fetching');
    downloading = updateMergeJobProgress(downloading, {
      phase: 'fetching',
      ratio: 0.46,
      readBytes: 52.3 * 1024 * 1024,
      totalBytes: 113.7 * 1024 * 1024,
      message: 'private worker detail',
    });
    const downloadView = presentMergeDockJob(
      downloading,
      { actionToken: 'action', pathToken: 'path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );
    expect(downloadView.progress).toBeCloseTo(0.322);
    expect(downloadView.status).toBe('已下载 52.3 MB / 113.7 MB');
    expect(downloadView.status).not.toContain('并行');

    let muxing = transitionMergeJob(downloading, 'muxing');
    muxing = updateMergeJobProgress(muxing, {
      phase: 'muxing',
      ratio: 0.4,
      readBytes: 113.7 * 1024 * 1024,
      totalBytes: 113.7 * 1024 * 1024,
      message: 'private mux detail',
    });
    const muxView = presentMergeDockJob(
      muxing,
      { actionToken: 'action', pathToken: 'path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );
    expect(muxView.progress).toBeCloseTo(0.796);
    expect(muxView.status).toBe('合并中 · 已处理 40%');
  });

  it('issues opaque, scoped tokens bound to the source tab and page', async () => {
    const storage = new FakeStorage();
    let tokenIndex = 0;
    const broker = new MergeDockGrantBroker(
      storage,
      () => 1_000,
      () => `opaque-${++tokenIndex}`,
    );
    const tokens = await broker.getOrIssue(ownedJob());

    expect(tokens).toEqual({ actionToken: 'opaque-1', pathToken: 'opaque-2' });
    await expect(
      broker.authorize({
        token: tokens.actionToken,
        scope: 'action',
        tabId: 42,
        pageUrl: 'https://watch.example.test/video/42',
      }),
    ).resolves.toMatchObject({ jobId: 'private-job-id', mediaEpoch: 7 });
    await expect(
      broker.authorize({
        token: tokens.actionToken,
        scope: 'path',
        tabId: 42,
        pageUrl: 'https://watch.example.test/video/42',
      }),
    ).rejects.toThrow(/不匹配/u);
    await expect(
      broker.authorize({
        token: tokens.actionToken,
        scope: 'action',
        tabId: 43,
        pageUrl: 'https://watch.example.test/video/42',
      }),
    ).rejects.toThrow(/不匹配/u);
  });

  it('only lets a live, active action capability claim a permission prompt', async () => {
    const storage = new FakeStorage();
    let now = 1_000;
    let tokenIndex = 0;
    const broker = new MergeDockGrantBroker(
      storage,
      () => now,
      () => `opaque-${++tokenIndex}`,
    );
    const ready = transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'ready');
    const tokens = await broker.getOrIssue(ready);
    const sender = {
      tab: { id: 42, url: 'https://watch.example.test/video/42' },
      frameId: 0,
    };

    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: 'attacker-controlled', action: 'merge' },
        sender,
        broker,
      ),
    ).toBeUndefined();
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.pathToken, action: 'merge' },
        sender,
        broker,
      ),
    ).toBeUndefined();
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'merge' },
        { ...sender, frameId: 2 },
        broker,
      ),
    ).toBeUndefined();
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'merge' },
        sender,
        broker,
      ),
    ).toBe(tokens.actionToken);
    // A synthetic replay cannot open a second concurrent browser prompt.
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'merge' },
        sender,
        broker,
      ),
    ).toBeUndefined();

    broker.releasePermissionClaim(tokens.actionToken);
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'separate' },
        sender,
        broker,
      ),
    ).toBe(tokens.actionToken);
    broker.releasePermissionClaim(tokens.actionToken);

    await broker.getOrIssue({ ...ready, state: 'completed', outputSizeBytes: 123 });
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'merge' },
        sender,
        broker,
      ),
    ).toBeUndefined();

    now += 6 * 60 * 60 * 1_000 + 1;
    expect(
      claimMergeDockPermissionFromMessage(
        { type: 'RUN_MERGE_DOCK_ACTION', token: tokens.actionToken, action: 'merge' },
        sender,
        broker,
      ),
    ).toBeUndefined();
  });

  it('invalidates synchronous permission claims when another SPA media job becomes active', async () => {
    const storage = new FakeStorage();
    let tokenIndex = 0;
    const broker = new MergeDockGrantBroker(
      storage,
      () => 2_000,
      () => `opaque-${++tokenIndex}`,
    );
    const first = await broker.getOrIssue(
      transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'ready'),
    );
    const next = mergeJobFromSeed({
      ...ownedJob(),
      id: 'next-job',
      ownerMediaEpoch: 8,
      createdAt: 200,
    });
    await broker.getOrIssue(next);

    expect(
      broker.claimPermissionRequest(first.actionToken, {
        tabId: 42,
        pageUrl: 'https://watch.example.test/video/42',
      }),
    ).toBe(false);
  });

  it.each([
    ['RANGE_RESPONSE_INVALID', '异常的 Range 数据'],
    ['TIMELINE_MISMATCH', '时间线或媒体身份不匹配'],
    ['SOURCE_FORMAT_UNSUPPORTED', '媒体文件格式无法安全读取'],
    ['OUTPUT_PARSE_FAILED', '无法读取生成的文件'],
    ['OUTPUT_TRACK_MISMATCH', '音视频轨不完整'],
    ['OUTPUT_TIMELINE_MISMATCH', '播放时间信息异常'],
    ['OUTPUT_AV_OFFSET_MISMATCH', '音画同步检查未通过'],
    ['OUTPUT_DURATION_MISMATCH', '输出时长与来源不一致'],
    ['OUTPUT_SIZE_MISMATCH', '文件大小校验失败'],
    ['OUTPUT_SIGNATURE_MISMATCH', '文件格式校验失败'],
  ] as const)('maps %s to a safe public reason', (code, publicReason) => {
    const failed = transitionMergeJob(transitionMergeJob(ownedJob(), 'resolving'), 'failed', {
      failure: {
        code,
        message: 'private https://cdn.example.test/file?token=secret',
        retryable: false,
        canDownloadSeparately: true,
      },
    });
    const view = presentMergeDockJob(
      failed,
      { actionToken: 'opaque-action', pathToken: 'opaque-path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );

    expect(view.error).toContain(publicReason);
    expect(JSON.stringify(view)).not.toContain('cdn.example.test');
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('never exposes source URLs, headers, job ids, asset ids, or DNR ids in a view', () => {
    const resolving = transitionMergeJob(ownedJob(), 'resolving');
    const failed = transitionMergeJob(resolving, 'failed', {
      requestRuleIds: [1_900_000_042],
      failure: {
        code: 'NETWORK_FAILED',
        message:
          'fetch https://cdn.example.test/private-video.m4s?token=video-secret Authorization: Bearer private-header asset-123',
        retryable: true,
        canDownloadSeparately: true,
      },
    });
    const view = presentMergeDockJob(
      failed,
      { actionToken: 'opaque-action', pathToken: 'opaque-path' },
      { savePath: 'Downloads/FoxFetch/web', pathMode: 'automatic' },
    );
    const serialized = JSON.stringify(view);

    expect(view).toMatchObject({
      title: '示例视频',
      state: 'failed',
      separateEnabled: true,
      mergeEnabled: true,
    });
    for (const secret of [
      'cdn.example.test',
      'video-secret',
      'private-header',
      'private-job-id',
      'asset-123',
      '1900000042',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('merge Dock path policy', () => {
  it('shows the logical Downloads path by default and persists ask mode per platform', async () => {
    const storage = new FakeStorage();
    const pageUrl = 'https://www.bilibili.com/video/BV1test';

    await expect(getMergeDownloadPathPolicy(pageUrl, storage)).resolves.toEqual({
      mode: 'automatic',
    });
    expect(presentMergeDownloadPath(pageUrl, { mode: 'automatic' })).toEqual({
      savePath: 'Downloads/FoxFetch/Bilibili',
      pathMode: 'automatic',
    });

    await saveMergeDownloadPathPolicy(pageUrl, 'ask', storage);
    await expect(
      getMergeDownloadPathPolicy('https://space.bilibili.com/42', storage),
    ).resolves.toEqual({ mode: 'ask' });
    expect(presentMergeDownloadPath(pageUrl, { mode: 'ask' })).toEqual({
      savePath: '下载时由系统选择保存位置',
      pathMode: 'ask',
    });
  });

  it('persists only non-sensitive custom-directory metadata per platform', async () => {
    const storage = new FakeStorage();
    const pageUrl = 'https://www.bilibili.com/video/BV1custom';
    const directory = {
      handleId: 'merge-bilibili',
      name: '我的视频',
      selectedAt: 456,
    };

    await expect(
      saveMergeDownloadPathPolicy(pageUrl, { mode: 'custom', directory }, storage),
    ).rejects.toThrow('已停用');
    await storage.set({ 'foxfetch:merge-path-policy:bilibili': { mode: 'custom', directory } });
    await expect(
      getMergeDownloadPathPolicy('https://space.bilibili.com/42', storage),
    ).resolves.toEqual({ mode: 'custom', directory });
    expect(presentMergeDownloadPath(pageUrl, { mode: 'custom', directory })).toEqual({
      savePath: '我的视频',
      pathMode: 'custom',
    });
    await expect(saveMergeDownloadPathPolicy(pageUrl, 'custom', storage)).rejects.toThrow(
      '缺少目录信息',
    );
  });
});
