# Changelog / 更新日志

## v1.0.2 Beta — 2026-09-14

Published on GitHub and marked **Latest**; the Beta version name is retained.

### Fixes / 修复

- Replace inline image bodies in session resource lists with lightweight, page-bound references; generate thumbnails and retrieve original images on demand.
- Keep inline image bodies out of download history and migrate legacy records to metadata that requires rescanning, preserving audio/video and capture state.
- Add conservative session-storage capacity protection and clearer quota-exhaustion messages.
- Improve settings floating-window sizing and scrolling for constrained viewports and unsaved-change controls.

- 会话资源列表以页面绑定的轻量引用替代内嵌图片正文，按需生成缩略图并读取原图下载。
- 下载历史不再保存内嵌图片正文；旧记录迁移为需重新扫描的轻量信息，保留音视频和捕获状态。
- 增加保守的会话存储容量保护，明确显示容量不足错误。
- 改善受限视口下设置浮窗的尺寸、滚动及未保存更改操作区域布局。

### Verification and known limitations / 验证与已知限制

- 1,900 unit tests (183 files), four isolated browser tests, type checking, and production build passed. These checks do not establish real logged-in download or merged-output acceptance on the affected installation.
- The empty settings footer after Save/Cancel remains a known follow-up issue. Pending-network queue deduplication and independent periodic cleanup are not included.
- Finish downloads, captures, and merges before updating; reload the extension and refresh source pages. A low storage reading immediately after reload alone is not proof of the fix.

- 1900 项单元测试（183 个文件）、4 项隔离浏览器测试、类型检查及生产构建通过；问题设备上真实登录网站下载及合并输出仍待验收。
- 保存／取消设置后底部空白仍保留，已记录为下一批需求。本版不包含待确认网络队列去重及独立周期清理。
- 更新前等待下载、捕获和合并结束；更新后重载扩展并刷新来源页面，不能只以重载后存储占用降低判断修复成功。

[Release notes and downloads / 发布说明与下载](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.2-Beta)

### Repository maintenance included / 随版本纳入的仓库维护

- Adopt GPL-3.0-only for FoxFetch's own code, with third-party licenses preserved.
- Make English the default README and provide a separate Simplified Chinese guide.
- Add contribution and security policies, issue and pull request templates, and CI.
- Clarify installation, permissions, release assets, and source licensing.

同时纳入以下仓库维护更新：

- 自有代码采用 GPL-3.0-only，保留第三方许可。
- 默认首页改为英文，并提供独立简体中文说明。
- 补充贡献指南、安全政策、Issue／Pull Request 模板及自动检查。
- 完善安装、权限、发布附件和源码许可说明。

The v1.0.0-Beta tag and its existing assets remain unchanged. / v1.0.0-Beta 标签及已有附件保持不变。

## v1.0.0 Beta — 2026-09-11

Initial public Beta release.

- Media resource sidebar with search and type filters.
- Floating playback controls and settings.
- Bilibili and YouTube download workflows.
- YouTube resolution selection and Compatibility, Quality, and Size preferences.
- Local media processing, task diagnostics, English and Simplified Chinese, and theme selection.

首次公开 Beta 发布，提供媒体资源侧边栏与搜索筛选、浮动播放控制与设置、Bilibili／YouTube 下载、YouTube 分辨率与兼容／画质／体积偏好、本地媒体处理、任务诊断、中英文界面和主题选择。

[Release notes and downloads / 发布说明与下载](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.0-Beta)
