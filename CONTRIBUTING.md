# Contributing to FoxFetch

English | [简体中文](CONTRIBUTING.zh-CN.md)

## Before you start

Search existing issues before reporting a defect. For substantial features or architecture changes, open an issue first to agree on scope. Security vulnerabilities belong in [private reporting](SECURITY.md), not public issues.

Contributions must be your own work or material you are entitled to submit. FoxFetch contributions are accepted under GPL-3.0-only; preserve the original terms and notices of third-party code. No separate contributor license agreement is required by this guide.

## Development workflow

1. Fork the repository and create a focused branch.
2. Install the Node.js and pnpm versions declared in `package.json`.
3. Run `pnpm install --frozen-lockfile`.
4. Use `pnpm dev`, or run `pnpm build` and load `.output/chrome-mv3` in Chrome.
5. Keep changes limited to the issue being addressed.

Run these checks before submitting:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Use the repository's Prettier and ESLint configuration for changed files. Do not reformat unrelated files. Commit lockfile changes when dependencies change. Maintain dependency patches in `patches/`; do not edit `node_modules` as the submitted fix.

## Interface and download changes

- Update both English and Simplified Chinese strings. Do not translate source-provided media titles.
- Check narrow layouts and light/dark themes. Include screenshots without private browsing or account information.
- Add regression tests for the changed behavior.
- For download changes, report the actual resolution, codec/container combination, outcome, and local playback checks. Unit tests alone do not establish real-site compatibility.
- Do not introduce DRM bypass, authentication bypass, remote executable code, or unnecessary permissions.
- Do not commit credentials, cookies, signed media URLs, browser profiles, generated packages, or private diagnostic logs.

## Pull requests

Describe the problem, the change, how it was tested, and any remaining limitations. Link the related issue. Use the pull request checklist and identify any checks you could not run. Do not report unperformed tests as passed.

Maintainers review changes before merging. The Beta release tag is not moved for documentation or maintenance changes.
