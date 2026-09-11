/**
 * Wake the isolated media agent on the two first-class v0.4 sites. The MAIN
 * world MSE hook is installed separately at document_start; this lightweight
 * bridge only asks the service worker to mount detection and the unified Dock.
 */
export default defineContentScript({
  matches: [
    'https://bilibili.com/*',
    'https://*.bilibili.com/*',
    'https://youtube.com/*',
    'https://*.youtube.com/*',
    'https://youtube-nocookie.com/*',
    'https://*.youtube-nocookie.com/*',
  ],
  runAt: 'document_start',
  main() {
    if (window.top !== window) return;
    let recoveryReloadRequested = false;
    const isInvalidated = (error: unknown): boolean =>
      /extension context invalidated|context invalidated/iu.test(
        error instanceof Error ? error.message : String(error ?? ''),
      );
    const wake = async (): Promise<void> => {
      try {
        await chrome.runtime.sendMessage({
          type: 'AUTO_ACTIVATE_AGENT',
          agentProtocolVersion: 5,
          agentBuildId: 'foxfetch-media-agent-v5',
        });
      } catch (error) {
        if (!isInvalidated(error) || recoveryReloadRequested) return;
        // Extension updates invalidate content-script APIs in already-open
        // tabs. A single document reload is the only safe way to reinstall the
        // MAIN hook before the site's player creates its MediaSource.
        recoveryReloadRequested = true;
        window.setTimeout(() => window.location.reload(), 120);
      }
    };

    void wake();
    window.addEventListener('pageshow', () => void wake());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void wake();
    });
  },
});
