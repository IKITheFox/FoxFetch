import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { appSettingsSchema } from '../../src/shared/schemas';

describe('application settings schema', () => {
  it('accepts the versioned defaults', () => {
    expect(appSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('rejects unsafe playback and download limits', () => {
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        playback: { ...DEFAULT_SETTINGS.playback, defaultRate: 99 },
      }).success,
    ).toBe(false);
    expect(
      appSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        download: { ...DEFAULT_SETTINGS.download, concurrentDownloads: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('strips unknown persisted fields', () => {
    const parsed = appSettingsSchema.parse({ ...DEFAULT_SETTINGS, unexpected: 'ignored' });
    expect(parsed).not.toHaveProperty('unexpected');
  });
});
