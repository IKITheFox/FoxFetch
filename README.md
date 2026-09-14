<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/icons/foxfetch-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/icons/foxfetch.svg">
    <img src="public/icons/foxfetch.svg" width="88" alt="FoxFetch">
  </picture>
</p>

# FoxFetch

Web media discovery, playback controls, and downloads for Chrome, with YouTube and Bilibili support.

English | [简体中文](README.zh-CN.md)

[Download v1.0.2 Beta](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.2-Beta) · [Report an issue](https://github.com/IKITheFox/FoxFetch/issues/new/choose) · [Changelog](CHANGELOG.md)

FoxFetch is a Manifest V3 extension that combines a media resource sidebar with a floating playback controller. It detects video, audio, and image resources on supported pages and saves content you own or have permission to download.

**Status:** v1.0.2 Beta, marked Latest on GitHub. This release is distributed through GitHub and requires manual installation. The Beta version name is retained; Latest does not imply completed real-site acceptance testing.

## What's new in v1.0.2 Beta

- Keep large inline image bodies out of session resource lists and download history, leaving room for media detection and download state.
- Generate thumbnails and retrieve original inline images on demand through page-bound references. Refresh or rescan the source page if an image is no longer available.
- Migrate legacy inline image records and add session-storage capacity protection.
- Include settings floating-window layout fixes for constrained viewports. The blank footer remaining after Save/Cancel is a known follow-up issue, not fixed in this version.

Validation: 1,900 unit tests and four isolated browser tests passed, along with type checking and the production build. Real logged-in downloads and merged-output acceptance on the affected installation remain outstanding. See the [changelog](CHANGELOG.md) for details and limitations.

## Features

- **Resource center:** browse media found on the current page, search by name, and filter by resource type.
- **Playback controller:** play and pause, adjust playback speed, reset speed, and mute or unmute. Previous/next navigation is available on supported sites.
- **Bilibili and YouTube downloads:** dedicated media detection and download handling, subject to source availability and account permissions.
- **YouTube download preferences:** select a resolution and prioritize Compatibility, Quality, or Size. Eligible failures trigger bounded attempts with alternative formats without silently reducing the selected resolution.
- **Local media processing:** merge supported audio/video combinations in the browser. Large responses use temporary storage; no separate desktop download application is required.
- **Download diagnostics:** view task stages, transfer information, save results, and error codes.
- **Interface settings:** English and Simplified Chinese, light/dark/system themes, and draggable settings with an unsaved-changes prompt.

## Installation

Requires **Chrome 120 or later**. Use an up-to-date Chrome release. Other Chromium browsers may not support every extension API used by FoxFetch.

### Option 1: Drag and drop the ZIP

1. Open the [v1.0.2 Beta release](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.2-Beta) and download **`FoxFetch-v1.0.2-Beta-chrome.zip`**. The release also includes installation notes and `SHA256SUMS.txt` for integrity checking.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Drag the ZIP from your file manager onto the extensions page. Chrome extracts the package automatically; no manual extraction is required.
4. Wait for FoxFetch to appear in the extension list, then pin it to the toolbar and refresh the media page.

Drop the ZIP onto the extensions page, not onto a regular web page. If drag-and-drop installation is unavailable or fails, use Option 2.

### Option 2: Extract and load unpacked

1. Extract the installation ZIP into a permanent folder.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder containing `manifest.json`.
4. Pin FoxFetch to the toolbar and refresh the media page.

**Keep the extracted folder in place while the extension is installed.** This requirement applies to Option 2, not to the original ZIP used for Option 1.

The project-source and third-party-source archives are for developers, not installation. GitHub's automatic **Source code** downloads are also not ready-to-load extensions.

### Updating

Finish active downloads, captures, and merges before updating. Record any settings you want to retain. Reloading interrupts background work and may clear session data.

- **ZIP installation:** download the new installation ZIP and drag it onto `chrome://extensions/` with Developer mode enabled. If Chrome adds a separate copy, disable the old copy before using the new one. Do not assume settings will transfer between copies.
- **Extracted-folder installation:** back up the installed folder, replace its contents with the extracted new package, and select **Reload** on Chrome's extensions page. Keep the folder path unchanged.

Refresh media pages afterward and keep only one copy enabled. These manual installations do not update automatically when a new GitHub release is published.

## Usage

1. Open a media page and select FoxFetch from the toolbar.
2. Browse **Resource center** or open **Controller** to operate the current player.
3. Choose the available download options and save location, then start the download.
4. Wait for confirmation that the file was saved. Download progress alone does not confirm a successful save.

Grant site access when the requested feature needs it. Drag Chrome's side-panel boundary to adjust its width.

## Supported use and limitations

- Download only content you own or are authorized to download, in accordance with applicable laws, platform terms, and content licenses.
- FoxFetch does not bypass DRM, paid-access restrictions, or server-side session verification. Playback access does not guarantee download availability.
- Support varies by website, media format, and browser. Not all live streams or codec/container combinations are supported.
- Quality and Size preferences rank the metadata supplied by the source; they do not guarantee a particular visual quality or file size.
- High-bitrate downloads remain subject to available disk space, browser resources, and server limits. Resolution alone does not determine whether a download will succeed.
- If YouTube requires session verification, the task stops with an error rather than treating an incomplete file as a successful download.

## Privacy and permissions

Media processing takes place on your device. Detection and downloads still communicate with the source website or its media servers.

Settings may use browser synchronization. Review [Privacy and permissions](docs/PRIVACY.md) for storage, site access, and diagnostic details. Remove private information before sharing diagnostics.

## Development

Use **Node.js 24.15 or later within the 24.x series** and **pnpm 11.19 or later within the 11.x series**, as specified in `package.json`.

```sh
git clone https://github.com/IKITheFox/FoxFetch.git
cd FoxFetch
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Load `.output/chrome-mv3` as an unpacked extension. Use `pnpm dev` for development. Dependency patches are tracked in `patches/` and applied during installation.

CI runs type checks, unit tests, and a production build. These checks do not replace testing downloads and playback on real media pages.

## Contributing and support

- Read the [contribution guide](CONTRIBUTING.md) before opening a pull request.
- Use the [issue templates](https://github.com/IKITheFox/FoxFetch/issues/new/choose) for defects and feature requests.
- Report vulnerabilities privately through the channel in [SECURITY.md](SECURITY.md).
- See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

Copyright © IKITheFox

Licensed under **GPL-3.0-only**. See [LICENSE](LICENSE) and [Copyright and licensing scope](COPYRIGHT.md).

Third-party components retain their original licenses. See [Third-party notices](THIRD_PARTY_NOTICES.md) and [Source and rebuild instructions](THIRD_PARTY_SOURCES.md).

FoxFetch is not affiliated with or endorsed by Google, YouTube, Bilibili, or other referenced platform providers.
