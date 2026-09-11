<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/icons/foxfetch-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/icons/foxfetch.svg">
    <img src="public/icons/foxfetch.svg" width="88" alt="FoxFetch">
  </picture>
</p>

# FoxFetch

适用于 Chrome 的网页媒体识别、播放控制与下载扩展。

[English](README.md) | 简体中文

[下载 v1.0.0 Beta](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.0-Beta) · [反馈问题](https://github.com/IKITheFox/FoxFetch/issues/new/choose) · [更新日志](CHANGELOG.md)

FoxFetch 基于 Manifest V3，将媒体资源侧边栏与浮动播放控制器整合在一起，用于识别受支持页面中的视频、音频和图片，并保存你拥有或获准下载的内容。

**当前状态：** v1.0.0 Beta。此版本通过 GitHub 分发，需要手动安装，尚未上架 Chrome 应用商店。

## 功能

- **资源中心：** 查看当前页面的媒体资源，按名称搜索、按资源类型筛选。
- **播放控制器：** 播放与暂停、调整倍速、恢复默认速度、静音与解除静音；受支持的网站可切换上一或下一视频。
- **Bilibili 与 YouTube 下载：** 提供专用媒体识别和下载处理，实际可用资源取决于来源及账号权限。
- **YouTube 下载偏好：** 选择分辨率，并按兼容、画质或体积排序。发生适用的错误时，有限尝试其他格式组合，不静默降低所选分辨率。
- **本地媒体处理：** 在浏览器中合并受支持的音视频组合，通过临时存储处理较大的响应，无需额外安装桌面下载软件。
- **下载诊断：** 查看任务阶段、传输信息、保存结果和错误码。
- **界面设置：** 支持英文与简体中文、浅色／深色／跟随系统主题，以及可拖动的设置浮窗；关闭前提示保存未保存的更改。

## 安装

需要 **Chrome 120 或更高版本**，建议及时更新浏览器。其他 Chromium 浏览器可能无法支持 FoxFetch 使用的全部扩展接口。

1. 打开 [v1.0.0 Beta 发布页](https://github.com/IKITheFox/FoxFetch/releases/tag/v1.0.0-Beta)，下载 **`FoxFetch-v1.0.0-Beta-chrome.zip`**。
2. 将 ZIP 解压到固定目录，安装后不要删除或移动该目录。
3. 打开 `chrome://extensions/`，启用**开发者模式**。
4. 选择**加载已解压的扩展程序**，指定包含 `manifest.json` 的目录。
5. 将 FoxFetch 固定到工具栏，然后刷新媒体页面。

项目源码包与第三方源码包供开发者使用，不是安装包。GitHub 自动生成的 **Source code** 下载也不能直接作为扩展加载。

### 更新

完成或取消正在运行的下载任务，备份安装目录，再用新版文件替换目录内容。在 Chrome 扩展管理页点击**重新加载**，随后刷新媒体页面。请仅启用一份 FoxFetch。

GitHub 发布新版本后，手动加载的扩展不会自动更新。

## 使用

1. 打开媒体页面，从工具栏选择 FoxFetch。
2. 在**资源中心**查看资源，或打开**控制器**操作当前播放器。
3. 选择可用的下载选项与保存位置，开始下载。
4. 等待文件保存成功的确认。下载进度不等于文件已经保存成功。

在功能需要时授予对应的网站访问权限。可拖动 Chrome 侧边栏边界调整宽度。

## 支持范围与限制

- 仅下载你拥有或已获授权下载的内容，并遵守适用法律、平台条款及内容许可。
- FoxFetch 不绕过 DRM、付费访问限制或服务端会话验证。能够播放不代表一定能够下载。
- 可用性取决于网站、媒体格式和浏览器，并非所有直播或编码／封装组合均受支持。
- 画质与体积偏好根据来源提供的元数据排序，不保证特定画质或最终文件大小。
- 高码率下载仍受可用磁盘空间、浏览器资源及服务端限制，不能仅凭分辨率判断下载是否能够完成。
- YouTube 要求会话验证时，任务会停止并显示错误，不会把不完整文件标记为下载成功。

## 隐私与权限

媒体在本机处理。资源识别和下载仍会与原网站或其媒体服务器通信。

FoxFetch 使用网站访问权限识别媒体、下载权限保存文件，并通过浏览器存储保存设置和任务状态。浏览器的账号同步服务可能同步受支持的设置。详见[隐私与权限说明](docs/PRIVACY.zh-CN.md)。

诊断信息可能包含媒体标题、来源信息及任务详情。分享前请移除私人信息，不要在公开 Issue 中提交 Cookie、访问令牌、带签名的媒体链接或私人视频。

## 开发

使用 `package.json` 声明的 **Node.js 24.15 及以上的 24.x 版本**与 **pnpm 11.19 及以上的 11.x 版本**。

```sh
git clone https://github.com/IKITheFox/FoxFetch.git
cd FoxFetch
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

构建后将 `.output/chrome-mv3` 加载为已解压的扩展程序。开发模式使用 `pnpm dev`。依赖补丁保存在 `patches/` 中，安装时自动应用。

自动检查包含类型检查、单元测试及生产构建，不能替代真实媒体页面上的下载与播放测试。

## 贡献与支持

- 提交 Pull Request 前请阅读[贡献指南](CONTRIBUTING.zh-CN.md)。
- 使用 [Issue 模板](https://github.com/IKITheFox/FoxFetch/issues/new/choose)反馈缺陷或提出功能建议。
- 安全漏洞请通过[安全政策](SECURITY.zh-CN.md)中的非公开渠道报告。
- 版本记录见[更新日志](CHANGELOG.md)。

## 许可证

Copyright © IKITheFox

FoxFetch 自有代码采用 **GNU GPL 仅第 3 版（`GPL-3.0-only`）**，详见 [LICENSE](LICENSE) 和[许可适用范围](COPYRIGHT.md)。

第三方组件保留各自版权与许可声明，详见[第三方说明](THIRD_PARTY_NOTICES.md)及[源码与构建说明](THIRD_PARTY_SOURCES.md)。原始 Beta 标签与发布附件保持不变，后续许可授权记录在 [COPYRIGHT.md](COPYRIGHT.md) 中。

FoxFetch 与 Google、YouTube、Bilibili 等提及的平台提供方无隶属或背书关系。
