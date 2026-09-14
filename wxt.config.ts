import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    // Chrome cannot reliably reuse extension preloads across execution worlds.
    // Keep normal module imports, but omit HTML and dynamic-import preload hints.
    build: { modulePreload: false },
  }),
  manifest: {
    version_name: '1.0.2 Beta',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'zh_CN',
    minimum_chrome_version: '120',
    incognito: 'not_allowed',
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
    permissions: [
      'activeTab',
      'tabs',
      'scripting',
      'storage',
      'downloads',
      'offscreen',
      'unlimitedStorage',
      'sidePanel',
      'declarativeNetRequestWithHostAccess',
    ],
    host_permissions: [
      'https://bilibili.com/*',
      'https://*.bilibili.com/*',
      'https://youtube.com/*',
      'https://*.youtube.com/*',
      'https://youtube-nocookie.com/*',
      'https://*.youtube-nocookie.com/*',
    ],
    optional_permissions: ['webRequest'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    web_accessible_resources: [
      {
        resources: [
          'cache-host.html',
          'settings-float.html',
          'icons/icon-48.png',
          'icons/foxfetch.svg',
          'icons/foxfetch-dark.svg',
        ],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    action: {
      default_title: '__MSG_extensionName__',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
      },
    },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    commands: {
      'increase-rate': {
        suggested_key: { default: 'Alt+Shift+Period' },
        description: '__MSG_commandIncreaseRate__',
      },
      'decrease-rate': {
        suggested_key: { default: 'Alt+Shift+Comma' },
        description: '__MSG_commandDecreaseRate__',
      },
      'reset-rate': {
        suggested_key: { default: 'Alt+Shift+0' },
        description: '__MSG_commandResetRate__',
      },
      'toggle-controller': {
        suggested_key: { default: 'Alt+Shift+M' },
        description: '__MSG_commandToggleController__',
      },
    },
  },
});
