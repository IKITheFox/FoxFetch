# FoxFetch

**Discover web media, control playback, and save files in one extension.**

[简体中文](README.md) | English

FoxFetch is a Manifest V3 extension for Chrome. It brings a page resource list, floating playback controls, and download tasks together, helping you find video, audio, and images and save content you own or are authorized to download.

**Current version: v1.0.0 Beta · Beta release · Full GitHub edition**

## Features

- **Resource center:** browse page resources in a side panel, with type filters, search, and thumbnails.
- **Floating controls:** play/pause, playback speed, reset speed, and mute/unmute. Previous/next navigation is available on supported pages.
- **Site integrations:** dedicated media discovery and download workflows for Bilibili and YouTube. Available resources depend on the page, account permissions, and server responses.
- **Download preferences:** choose a resolution and Compatibility, Quality, or Size for YouTube. Eligible format failures trigger a limited number of alternative attempts without silently lowering your chosen resolution.
- **Local processing:** read media, handle large segments through private temporary files, and merge supported audio/video combinations inside the browser. No separate desktop download helper is required.
- **Task status:** follow download, processing, saving, and error states, and copy diagnostics for troubleshooting.
- **Consistent interface:** Chinese and English, light/dark/system themes, and floating settings with an unsaved-changes prompt.

## Install

These instructions are for the full GitHub edition, not a Chrome Web Store installation.

1. Download `FoxFetch-v1.0.0-Beta-chrome.zip` from this repository's **Releases** page. GitHub's automatic “Source code” archives are not installable extension packages.
2. Extract it to a permanent folder and keep that folder after installation.
3. Open `chrome://extensions/` and enable **Developer mode**.
4. Select **Load unpacked**, then choose the folder containing `manifest.json`.
5. Pin FoxFetch to the toolbar and refresh the media page.

The declared minimum is Chrome 120; the current stable Chrome release is recommended. Compatibility with other Chromium browsers depends on their extension APIs and is not guaranteed to match Chrome.

### Update

Finish or cancel active downloads, back up the old folder, replace its files with the new version, and reload the extension. Refresh media pages afterward. Do not enable two copies of FoxFetch at once. Unpacked installations do not automatically update when a GitHub release is published.

## Use

1. Open a page containing media and select FoxFetch.
2. Use **Resource center** to inspect resources or **Controller** to control the current player.
3. Choose the available download options and destination, then start the task.
4. Wait for the final successful save status. A download percentage or byte count alone does not mean the file has been saved successfully.

Grant site access only when needed. Chrome manages the native side panel width; drag its boundary to resize it.

## Limits and responsible use

- Download only content you own or are authorized to download, and respect applicable rules, platform terms, and content licenses.
- FoxFetch does not bypass DRM, paid-access restrictions, or website session verification. Being able to play a video does not guarantee that the extension can download it.
- Not every site, live stream, codec, or container is supported. Previous/next navigation also depends on the website.
- Quality and Size are selection preferences based on available metadata, not guarantees of comparative visual quality or final file size.
- Chunked processing does not remove disk, browser, or server limits. Support for every 8K/16K source or local playback configuration is not promised.
- YouTube may require session verification. FoxFetch does not bypass it or label incomplete files as successful.

## Data and permissions

Media processing takes place on your device. Downloads still make network requests to the originating websites or media servers. The extension uses site permissions for discovery, download permissions to save files, and browser storage for settings and task state. Synced settings may be synchronized by the browser through its account sync service.

Diagnostics and feedback may include media titles, source information, and task status. Review them before sharing. Never publish cookies, access tokens, or signed download URLs.

## Report an issue

Use this repository's Issues page and include the extension version, browser version, reproduction steps, error code, and a screenshot that is safe to share. Do not disclose private media or account information.

## Build from source

For developers with the project source; not required for installation.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Use the Node.js 24 and pnpm 11 toolchain declared by the project. The unpacked output is `.output/chrome-mv3`. Dependency changes are maintained in `patches/`; do not edit installed packages directly.

## Copyright and third-party software

Copyright © IKITheFox

No separate open-source license has been assigned to FoxFetch's own code. Public distribution should not be treated as a grant of unrestricted relicensing rights. Third-party components retain their respective licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md). Keep the third-party license files supplied with the package.

FoxFetch is not affiliated with or endorsed by the media websites or browser vendors mentioned here.
