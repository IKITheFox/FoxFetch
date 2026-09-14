import { defineConfig } from '@playwright/test';
import { acceptanceCaseMs, acceptanceStepMs } from './tests/e2e/acceptance-wait';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: acceptanceCaseMs,
  expect: { timeout: acceptanceStepMs },
  // Every extension suite owns a persistent Chromium profile. Windows can
  // reject simultaneous persistent-context launches with spawn UNKNOWN, so
  // keep this release gate deterministic across files as well as within them.
  workers: 1,
  use: {
    actionTimeout: acceptanceStepMs,
    navigationTimeout: acceptanceStepMs,
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
