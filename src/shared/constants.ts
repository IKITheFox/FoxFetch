import type { AppSettings } from './types';

export const APP_NAME = 'FoxFetch';
export const APP_NAME_EN = APP_NAME;
export const AGENT_SCRIPT_PATH = 'media-agent.js';
export const SETTINGS_KEY = 'foxfetch:settings';
export const DOWNLOADS_KEY = 'foxfetch:downloads';
export const TAB_STATE_PREFIX = 'foxfetch:tab:';
export const CACHE_RESTART_PREFIX = 'foxfetch:cache-restart:';
export const FLOATING_POSITION_KEY = 'foxfetch:floating-position:v1';
export const MAX_ASSETS_PER_TAB = 1_000;
export const MAX_DOWNLOAD_HISTORY = 200;

export const DEFAULT_SETTINGS: AppSettings = {
  uiLanguage: 'zh-CN',
  themeMode: 'auto',
  playback: {
    defaultRate: 1,
    lockRate: false,
    preservesPitch: true,
    seekStep: 10,
    showController: true,
  },
  download: {
    preference: 'compatibility',
    saveAs: false,
    concurrentDownloads: 3,
    filenameTemplate: '{title}',
  },
  autoScanGrantedSites: false,
  showAdvancedMedia: true,
};

export const MEDIA_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', 'ts', 'm2ts', 'flv'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'],
  playlist: ['m3u8', 'mpd'],
} as const;
