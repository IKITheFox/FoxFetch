import type { MediaKind } from '../../shared/types';
import { buildDownloadDirectory } from './download-path';

export type DownloadTargetMode = 'downloads' | 'prompt' | 'custom-directory';

export interface CustomDownloadDirectoryMetadata {
  /** Stable application key for the FileSystemDirectoryHandle stored in IndexedDB. */
  handleId: string;
  /** The only path information exposed by File System Access. Never an absolute path. */
  name: string;
  selectedAt: number;
}

interface DownloadTargetPolicyBase {
  mode: DownloadTargetMode;
  /** Optional directory below Downloads or the selected custom-directory root. */
  relativeDirectory?: string;
}

export interface BrowserDownloadsTargetPolicy extends DownloadTargetPolicyBase {
  mode: 'downloads';
}

export interface PromptDownloadTargetPolicy extends DownloadTargetPolicyBase {
  mode: 'prompt';
}

export interface CustomDirectoryTargetPolicy extends DownloadTargetPolicyBase {
  mode: 'custom-directory';
  directory: CustomDownloadDirectoryMetadata;
}

export type DownloadTargetPolicy =
  BrowserDownloadsTargetPolicy | PromptDownloadTargetPolicy | CustomDirectoryTargetPolicy;

export const DEFAULT_DOWNLOAD_TARGET_POLICY: BrowserDownloadsTargetPolicy = {
  mode: 'downloads',
};

export interface ResolvedDownloadTarget {
  mode: DownloadTargetMode;
  relativeDirectory: string;
  displayPath: string;
  saveAs: boolean;
  directory?: CustomDownloadDirectoryMetadata;
}

export interface ChromeDownloadTarget {
  filename: string;
  saveAs: boolean;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const FORBIDDEN_SEGMENT_CHARACTER = /[<>:"|?*]/u;
const HANDLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const MAX_RELATIVE_PATH_LENGTH = 240;
const MAX_SEGMENT_LENGTH = 120;

function invalidPath(reason: string): never {
  throw new TypeError(`无效的下载相对路径：${reason}`);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validatePathSegment(segment: string): string {
  if (!segment) return invalidPath('不能包含空目录名');
  if (segment === '.' || segment === '..') return invalidPath('不能包含 . 或 ..');
  if (segment !== segment.trim()) return invalidPath('目录名首尾不能是空格');
  if (segment.endsWith('.')) return invalidPath('目录名不能以句点结尾');
  if (segment.length > MAX_SEGMENT_LENGTH) return invalidPath('单级目录名过长');
  if (FORBIDDEN_SEGMENT_CHARACTER.test(segment) || hasControlCharacters(segment)) {
    return invalidPath('包含系统保留字符');
  }
  if (WINDOWS_RESERVED_NAME.test(segment)) return invalidPath('包含系统保留名称');
  return segment;
}

/**
 * Validate and canonicalize an application-controlled path below an already
 * authorized root. Absolute paths, backtracking and platform-ambiguous names
 * are rejected rather than repaired silently.
 */
export function validateDownloadRelativePath(value: string): string {
  if (typeof value !== 'string') return invalidPath('必须是字符串');
  if (!value) return invalidPath('不能为空');
  if (value.length > MAX_RELATIVE_PATH_LENGTH) return invalidPath('路径过长');
  if (value.includes('\\')) return invalidPath('请使用 / 作为目录分隔符');
  if (value.startsWith('/') || /^[a-z]:/iu.test(value) || value.startsWith('//')) {
    return invalidPath('不能使用绝对路径');
  }
  if (value.endsWith('/')) return invalidPath('不能以目录分隔符结尾');

  const segments = value.split('/').map(validatePathSegment);
  const normalized = segments.join('/');
  if (normalized.length > MAX_RELATIVE_PATH_LENGTH) return invalidPath('路径过长');
  return normalized;
}

export function validateDownloadFilename(value: string): string {
  if (value.includes('/') || value.includes('\\')) return invalidPath('文件名不能包含目录分隔符');
  return validatePathSegment(value);
}

export function createCustomDownloadDirectoryMetadata(
  handleId: string,
  name: string,
  selectedAt = Date.now(),
): CustomDownloadDirectoryMetadata {
  if (!HANDLE_ID.test(handleId)) throw new TypeError('目录句柄 ID 格式无效');
  if (!name || name !== name.trim() || hasControlCharacters(name)) {
    throw new TypeError('目录显示名称无效');
  }
  if (!Number.isFinite(selectedAt) || selectedAt < 0) {
    throw new TypeError('目录选择时间无效');
  }
  return { handleId, name, selectedAt };
}

export function resolveDownloadTarget(
  policy: DownloadTargetPolicy,
  pageUrl: string,
  kind: MediaKind,
): ResolvedDownloadTarget {
  const relativeDirectory = validateDownloadRelativePath(
    policy.relativeDirectory ?? buildDownloadDirectory(pageUrl, kind),
  );

  if (policy.mode === 'custom-directory') {
    return {
      mode: policy.mode,
      relativeDirectory,
      displayPath: `${policy.directory.name}/${relativeDirectory}`,
      saveAs: false,
      directory: policy.directory,
    };
  }

  return {
    mode: policy.mode,
    relativeDirectory,
    displayPath:
      policy.mode === 'prompt'
        ? `每次询问（建议 Downloads/${relativeDirectory}）`
        : `Downloads/${relativeDirectory}`,
    saveAs: policy.mode === 'prompt',
  };
}

/** Build the only path shape accepted by chrome.downloads: below Downloads. */
export function resolveChromeDownloadTarget(
  policy: DownloadTargetPolicy,
  pageUrl: string,
  kind: MediaKind,
  filename: string,
): ChromeDownloadTarget {
  if (policy.mode === 'custom-directory') {
    throw new TypeError('自定义目录必须通过 File System Access 写入，不能交给 chrome.downloads');
  }
  const target = resolveDownloadTarget(policy, pageUrl, kind);
  return {
    filename: `${target.relativeDirectory}/${validateDownloadFilename(filename)}`,
    saveAs: target.saveAs,
  };
}
