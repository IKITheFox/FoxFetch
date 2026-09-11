# Privacy and permissions

English | [简体中文](PRIVACY.zh-CN.md)

This document describes the GitHub edition of FoxFetch v1.0.0 Beta.

## Data handling

FoxFetch processes detected media and merges supported streams locally in the browser. Resource detection and downloads make requests to the original website and its media servers. Those services handle requests under their own policies; local processing does not mean offline operation.

Media titles, URLs, format metadata, and task state are used to display resources and manage downloads. Settings are stored through Chrome storage; supported settings use browser sync when available. Local/session storage and temporary browser files support task processing. Saved downloads remain in the destination you choose.

Selected-site downloads may use the website's existing browser session. FoxFetch does not ask you to paste account passwords or cookies into the extension.

## Permissions

| Permission                                  | Purpose                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| activeTab, tabs, scripting                  | Identify the active page, discover supported media, and attach playback controls.                       |
| storage                                     | Store settings and task-related state.                                                                  |
| downloads                                   | Save files and track browser download outcomes.                                                         |
| offscreen                                   | Run media processing outside the visible interface.                                                     |
| unlimitedStorage                            | Support temporary media storage; available device space is still finite.                                |
| sidePanel                                   | Display the resource center in Chrome's side panel.                                                     |
| declarativeNetRequestWithHostAccess         | Apply scoped request rules for supported media workflows.                                               |
| Bilibili / YouTube host access              | Enable the dedicated site integrations declared in the manifest.                                        |
| Optional webRequest and HTTP(S) site access | Observe permitted media requests and support discovery on additional sites after permission is granted. |

Review or revoke site access in Chrome's extension settings. Revoking a permission can disable related detection or downloads.

## Data control and reports

Use Chrome's extension controls to disable or remove FoxFetch and manage its storage. Removing the extension does not remove files already saved to your Downloads folder or another chosen destination. Browser synchronization settings are managed in Chrome.

Diagnostics you choose to copy can contain titles, source information, task identifiers, and errors. Review them before posting. Never share authentication data or signed download URLs. Public GitHub issues are visible to others; use [private reporting](../SECURITY.md) for vulnerabilities.

For questions about this document, open an issue without private account or browsing information.
