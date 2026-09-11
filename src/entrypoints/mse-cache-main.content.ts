import { bootstrapMseCaptureMainWorld } from '../modules/resolver/mse-hook-bootstrap';

/**
 * Install the inert MSE hook before Bilibili's player creates its
 * SourceBuffers. Bytes are forwarded only after the user starts cache capture.
 */
export default defineContentScript({
  matches: ['https://bilibili.com/*', 'https://*.bilibili.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    bootstrapMseCaptureMainWorld();
  },
});
