import {
  YouTubeOffscreenExecutor,
  type YouTubeExecutionRequest,
} from '../../modules/youtube/offscreen-executor';

/** Separate channel: Bilibili's executor, grants and eager preflight stay unchanged. */
export function installYouTubeOffscreenExecutor(): void {
  const executor = new YouTubeOffscreenExecutor();
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!message || typeof message !== 'object') return false;
    const command = message as Record<string, unknown>;
    if (command.channel !== 'foxfetch-youtube-execution-v1' || command.target !== 'offscreen')
      return false;
    // Offscreen exposes only a subset of runtime; getManifest is unavailable.
    // WXT's built MV3 entry is background.js (also checked by browser integration).
    const worker = 'background.js';
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab != null ||
      sender.url !== chrome.runtime.getURL(worker)
    ) {
      respond({ ok: false, error: 'UNTRUSTED_EXECUTION_SENDER' });
      return false;
    }
    if (typeof command.jobId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(command.jobId)) {
      respond({ ok: false, error: 'JOB_ID_INVALID' });
      return false;
    }
    const id = command.jobId;
    const run = async () => {
      switch (command.type) {
        case 'START':
          return executor.start({
            jobId: id,
            plan: command.plan,
            session: command.session,
          } as YouTubeExecutionRequest);
        case 'STATUS':
          return executor.status(id);
        case 'REFRESH':
          return executor.refresh({
            jobId: id,
            plan: command.plan,
            session: command.session,
          } as YouTubeExecutionRequest);
        case 'NEXT_FORMAT':
          return executor.nextFormat({
            jobId: id,
            plan: command.plan,
            session: command.session,
          } as YouTubeExecutionRequest);
        case 'CANCEL':
          return executor.cancel(id);
        case 'SAVE_DIRECTORY':
          return executor.saveDirectory(
            id,
            command.handleId as string,
            command.filenames as string[],
          );
        case 'CANCEL_DIRECTORY':
          return executor.cancelDirectory(id);
        case 'RETRY_DIRECTORY':
          return executor.retryDirectory(id, command.attempt as number);
        case 'RECHECK_DIRECTORY':
          return executor.recheckDirectory(id);
        case 'RELEASE':
          return executor.release(id);
        default:
          throw new Error('EXECUTION_COMMAND_INVALID');
      }
    };
    void run().then(
      (status) => respond({ ok: true, status: status ?? null }),
      () => respond({ ok: false, error: 'YOUTUBE_EXECUTION_REJECTED' }),
    );
    return true;
  });
}
