# FoxFetch v1.0.2 Beta

## Fixes

- Keep inline image bodies out of extension session storage by publishing lightweight, page-bound references.
- Generate bounded thumbnails on demand and retrieve original image data for downloads with content identity verification. Do not copy inline image bodies into download history.
- Migrate legacy inline image records to rescan-required metadata while preserving audio/video and capture state.
- Add conservative session-storage quota recovery, bounded observation history, and explicit storage-exhaustion messages.
- Include the settings floating-window layout fixes for constrained viewports and dirty-state footer changes.

## Install / update

Download `FoxFetch-v1.0.2-Beta-chrome.zip`, extract it into a permanent folder, and load that folder as an unpacked Chrome extension. For an existing unpacked installation, finish all downloads/captures/merges, back up and replace the old loaded folder contents, reload FoxFetch in `chrome://extensions/`, and refresh affected pages. Confirm version **1.0.2**.

The ZIP is the same tested local package previously delivered, with SHA-256:

`0A40226D7E6595D0F33E08CCD11961135F111CDEC0F13A7EE31D75394C3AA190`

## Verification and limitations

- Type checking and production build passed. Four isolated browser tests cover HTTP/HTTPS large-image decode/thumbnail/original integrity and dark/light settings layout.
- All 1,900 unit tests passed across 183 test files. The obsolete fixed-version unit assertion was updated to check package/manifest version consistency.
- This is a **prerelease**. Logged-in image/video download and merged-output acceptance on the affected installation remains outstanding. Reloading may clear session storage; test fresh visits to large-image pages rather than relying on a low post-reload usage reading alone.
- Pending-network queue deduplication and independent periodic cleanup are not included in this release.

## 简体中文

本版修复内嵌图片正文占满会话存储的问题：资源列表改用页面绑定的轻量引用，按需生成缩略图、读取原图下载，并处理旧记录。包含存储容量保护和此前的设置浮窗修复。

更新前请等待下载、捕获和合并结束；解压后完整替换原加载目录，重新加载扩展并刷新相关网页。此版本为 Beta 预发布，尚需本机真实下载及音视频输出验收；不包含待确认网络队列去重及独立周期清理的后续修复。
