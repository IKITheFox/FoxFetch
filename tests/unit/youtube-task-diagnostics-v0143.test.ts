import { expect, it } from 'vitest';
import { formatYouTubeTaskDiagnostics } from '../../src/modules/youtube/task-diagnostics';
import type { YouTubeTaskSnapshot } from '../../src/modules/youtube/background-task';

it('copies only public task fields and omits accidental private properties', () => {
  const snapshot = {
    jobId: '11111111-1111-4111-8111-111111111111',
    videoId: 'ZV-DAQGwK_o',
    state: 'failed',
    readBytes: 123,
    cleanupPending: true,
    retryAvailable: true,
    saveAttempt: 2,
    error: 'SAVE_INCOMPLETE',
    files: [
      { kind: 'audio', size: 12, state: 'interrupted', url: 'blob:secret', path: 'C:/private' },
    ],
    endpoint: 'https://private/?token=secret',
    cookie: 'secret-cookie',
  } as unknown as YouTubeTaskSnapshot;
  const result = formatYouTubeTaskDiagnostics(snapshot);
  expect(result).toContain('SAVE_INCOMPLETE');
  expect(result).toContain('保存次数：2');
  expect(result).toContain('音频：未完整保存');
  expect(result).not.toMatch(/https:|blob:|secret|C:\/private/u);
});

it('rejects unstructured error text, invalid identities and invalid byte counts', () => {
  const result = formatYouTubeTaskDiagnostics({
    jobId: 'secret-cookie',
    videoId: 'https://secret',
    state: 'failed',
    readBytes: Infinity,
    cleanupPending: false,
    error: 'Error https://secret?token=hidden',
    files: [{ kind: 'video', size: -1, state: 'interrupted' }],
  });
  expect(result).not.toMatch(/secret|hidden|Infinity|-1/u);
  expect(result).toContain('未提供可公开的错误码');
});
