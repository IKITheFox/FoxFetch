import * as z from 'zod/mini';

export const themeModeSchema = z.enum(['auto', 'light', 'dark']);

export const appSettingsSchema = z.object({
  uiLanguage: z.optional(z.enum(['zh-CN', 'en'])),
  youtubeEnabled: z.optional(z.boolean()),
  themeMode: themeModeSchema,
  playback: z.object({
    defaultRate: z.number().check(z.minimum(0.0625), z.maximum(16)),
    lockRate: z.boolean(),
    preservesPitch: z.boolean(),
    seekStep: z.number().check(z.minimum(1), z.maximum(120)),
    showController: z.boolean(),
  }),
  download: z.object({
    preference: z.optional(z.enum(['compatibility', 'quality', 'size'])),
    saveAs: z.boolean(),
    concurrentDownloads: z.int().check(z.minimum(1), z.maximum(8)),
    filenameTemplate: z.string().check(z.minLength(1), z.maxLength(120)),
  }),
  autoScanGrantedSites: z.boolean(),
  showAdvancedMedia: z.boolean(),
});
