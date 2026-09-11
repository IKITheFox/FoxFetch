import {
  BILIBILI_MANIFEST_HOOK_VERSION,
  installBilibiliManifestCaptureMainWorld,
  type BilibiliManifestHookStatusDetail,
} from '../modules/detector/bilibili-manifest-capture-main';
import {
  BILIBILI_MANIFEST_HOOK_CHECK_EVENT,
  BILIBILI_MANIFEST_HOOK_STATUS_EVENT,
} from '../modules/playback/manifest-ready';

const MAIN_BOOTSTRAP_STATE_KEY = '__foxfetchBilibiliManifestMainBootstrapV1__';

interface MainBootstrapState {
  version: typeof BILIBILI_MANIFEST_HOOK_VERSION;
  ensureInstalled: EventListener;
}

/**
 * Observe the player manifest before Bilibili removes it from page globals.
 * The hook clones only playurl responses and stores a bounded, sanitized media
 * summary; it never consumes or changes the response seen by the site.
 */
export default defineContentScript({
  matches: ['https://bilibili.com/*', 'https://*.bilibili.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const scope = window as Window & { [MAIN_BOOTSTRAP_STATE_KEY]?: MainBootstrapState };
    const previous = scope[MAIN_BOOTSTRAP_STATE_KEY];
    if (
      previous?.version === BILIBILI_MANIFEST_HOOK_VERSION &&
      typeof previous.ensureInstalled === 'function'
    ) {
      // Dynamic reinjection is the old-tab recovery path. Rebind the existing
      // listener without stacking a second bootstrap closure.
      window.removeEventListener(BILIBILI_MANIFEST_HOOK_CHECK_EVENT, previous.ensureInstalled);
      window.addEventListener(BILIBILI_MANIFEST_HOOK_CHECK_EVENT, previous.ensureInstalled);
      previous.ensureInstalled(new Event(BILIBILI_MANIFEST_HOOK_CHECK_EVENT));
      return;
    }
    if (previous?.ensureInstalled) {
      window.removeEventListener(BILIBILI_MANIFEST_HOOK_CHECK_EVENT, previous.ensureInstalled);
    }

    const ensureCaptureInstalled: EventListener = (): void => {
      const result = installBilibiliManifestCaptureMainWorld();
      const detail: BilibiliManifestHookStatusDetail = Object.freeze({
        version: result.version,
        checkRevision: result.checkRevision,
        captureRevision: result.captureRevision,
        fetch: result.fetch,
        xhr: result.xhr,
        routeBridgeBound: result.routeBridgeBound,
      });
      window.dispatchEvent(new CustomEvent(BILIBILI_MANIFEST_HOOK_STATUS_EVENT, { detail }));
    };
    try {
      Object.defineProperty(scope, MAIN_BOOTSTRAP_STATE_KEY, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: { version: BILIBILI_MANIFEST_HOOK_VERSION, ensureInstalled: ensureCaptureInstalled },
      });
    } catch {
      scope[MAIN_BOOTSTRAP_STATE_KEY] = {
        version: BILIBILI_MANIFEST_HOOK_VERSION,
        ensureInstalled: ensureCaptureInstalled,
      };
    }
    window.addEventListener(BILIBILI_MANIFEST_HOOK_CHECK_EVENT, ensureCaptureInstalled);
    ensureCaptureInstalled(new Event(BILIBILI_MANIFEST_HOOK_CHECK_EVENT));
  },
});
