import { describe, expect, it } from 'vitest';

import {
  isMergeOffscreenCommand,
  isMergeOffscreenEvent,
  isTrustedMergeOffscreenSender,
} from '../../src/modules/jobs/offscreen-protocol';
import { isCurrentJobWorkerAttempt } from '../../src/entrypoints/job/worker-protocol';

describe('merge offscreen protocol boundary', () => {
  it('rejects delayed worker events from an earlier attempt', () => {
    const current = { jobId: 'job-1', attemptId: 'attempt-new' };
    expect(isCurrentJobWorkerAttempt({ jobId: 'job-1', attemptId: 'attempt-old' }, current)).toBe(
      false,
    );
    expect(isCurrentJobWorkerAttempt(current, current)).toBe(true);
  });

  const extensionId = 'abcdefghijklmnop';
  const extensionRoot = `chrome-extension://${extensionId}/`;

  it('accepts only typed commands on the private offscreen channel', () => {
    expect(
      isMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'STATUS',
        jobId: 'job-1',
      }),
    ).toBe(true);
    expect(
      isMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'background',
        type: 'STATUS',
        jobId: 'job-1',
      }),
    ).toBe(false);
  });

  it('accepts the standard separate export command and completion event', () => {
    expect(
      isMergeOffscreenCommand({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'offscreen',
        type: 'START_SEPARATE',
        jobId: 'job-separate',
        request: {},
      }),
    ).toBe(true);
    expect(
      isMergeOffscreenEvent({
        channel: 'foxfetch-merge-offscreen-v1',
        target: 'background',
        type: 'SEPARATE_COMPLETED',
        jobId: 'job-separate',
        result: {},
        blobUrls: { video: 'blob:video', audio: 'blob:audio' },
      }),
    ).toBe(true);
  });

  it('accepts only bounded page-staging chunks with a capability-shaped stage id', () => {
    const base = {
      channel: 'foxfetch-merge-offscreen-v1',
      target: 'offscreen',
      type: 'PAGE_STAGE_CHUNK',
      jobId: 'job-page-stage',
      stageId: '01234567-89ab-cdef-0123-456789abcdef',
      track: 'video',
      offset: 0,
      totalBytes: 1,
      byteLength: 1,
      bytesBase64: 'AQ==',
    } as const;
    expect(isMergeOffscreenCommand(base)).toBe(true);
    expect(isMergeOffscreenCommand({ ...base, byteLength: 1_048_577 })).toBe(false);
    expect(isMergeOffscreenCommand({ ...base, offset: -1 })).toBe(false);
    expect(isMergeOffscreenCommand({ ...base, stageId: 'guessable' })).toBe(false);
  });

  it('rejects content-script commands even when they use the right channel', () => {
    expect(
      isTrustedMergeOffscreenSender(
        {
          id: extensionId,
          tab: { id: 42 },
          url: 'https://www.bilibili.com/video/BV1test',
          origin: 'https://www.bilibili.com',
        },
        extensionId,
        extensionRoot,
      ),
    ).toBe(false);
  });

  it('accepts a no-tab sender from this extension origin only', () => {
    expect(
      isTrustedMergeOffscreenSender(
        { id: extensionId, url: `${extensionRoot}background.js` },
        extensionId,
        extensionRoot,
      ),
    ).toBe(true);
    expect(
      isTrustedMergeOffscreenSender(
        { id: 'different-extension', url: 'chrome-extension://different-extension/background.js' },
        extensionId,
        extensionRoot,
      ),
    ).toBe(false);
    expect(
      isTrustedMergeOffscreenSender(
        { id: extensionId, url: 'https://example.test/fake-background.js' },
        extensionId,
        extensionRoot,
      ),
    ).toBe(false);
  });
});
