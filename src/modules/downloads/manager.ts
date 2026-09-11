import type {
  AppSettings,
  DownloadActivityOwner,
  DownloadRecord,
  MediaAsset,
} from '../../shared/types';
import { normalizeMediaTitle } from '../../shared/media-title';
import {
  basenameFromPath,
  extensionFromMime,
  extensionFromUrl,
  filenameFromUrl,
  sanitizeFilename,
} from '../../shared/utils';
import { upsertDownloadRecord } from './history';
import {
  installMediaRequestContext,
  mediaRequestContextRequired,
  releaseMediaRequestContext,
} from './request-context';
import { buildDownloadDirectory } from './download-path';

const DOCUMENT_EXTENSIONS = new Set(['htm', 'html', 'xhtml']);
const DOCUMENT_MIMES = new Set(['text/html', 'application/xhtml+xml']);
const REQUEST_CONTEXT_ERROR = '无法建立媒体请求上下文，下载已中止。';

export function directDownloadValidationError(asset: MediaAsset): string | undefined {
  if (!asset.downloadable || asset.url.startsWith('blob:')) {
    return 'Blob 媒体需要先解析真实来源，不能直接下载。';
  }

  const mime = asset.mime?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime && DOCUMENT_MIMES.has(mime)) {
    return '检测到的是网页文档而不是媒体文件，请重新扫描或解析真实来源。';
  }

  const strongMediaMime = Boolean(
    mime &&
    (mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      mime.startsWith('audio/') ||
      mime.includes('mpegurl') ||
      mime.includes('dash+xml')),
  );
  const extension =
    extensionFromMime(mime) ?? asset.extension?.toLowerCase() ?? extensionFromUrl(asset.url);
  if (!strongMediaMime && extension && DOCUMENT_EXTENSIONS.has(extension)) {
    return '检测到的是网页文档而不是媒体文件，请重新扫描或解析真实来源。';
  }
  return undefined;
}

function appendSourceExtension(filename: string, asset: MediaAsset): string {
  const extension = asset.extension ?? extensionFromFilename(asset.filename);
  if (!extension || filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) return filename;
  return `${filename}.${extension}`;
}

function extensionFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot > -1 && dot < filename.length - 1 ? filename.slice(dot + 1) : undefined;
}

export function buildDownloadFilename(
  asset: MediaAsset,
  pageTitle: string,
  index: number,
  _legacyTemplate?: string,
): string {
  const fallback = `${asset.kind}-${index + 1}`;
  const sourceFilename = asset.filename || filenameFromUrl(asset.url, fallback);
  const safePageTitle = sanitizeFilename(
    normalizeMediaTitle(pageTitle, asset.pageUrl),
    'Current page',
  );
  const rendered = safePageTitle;
  const requestedName = rendered.trim() ? sanitizeFilename(rendered, fallback) : sourceFilename;
  const filename = appendSourceExtension(requestedName, asset);
  return `${buildDownloadDirectory(asset.pageUrl, asset.kind)}/${sanitizeFilename(filename, fallback)}`;
}

async function persistDirectDownloadRecord(record: DownloadRecord): Promise<DownloadRecord> {
  const history = await upsertDownloadRecord(record, { preserveTerminal: true });
  return history.find((item) => item.id === record.id) ?? record;
}

export async function startAssetDownload(
  asset: MediaAsset,
  pageTitle: string,
  index: number,
  settings: AppSettings,
  owner?: DownloadActivityOwner,
): Promise<DownloadRecord> {
  const validationError = directDownloadValidationError(asset);
  if (validationError) throw new Error(validationError);

  const now = Date.now();
  const record: DownloadRecord = {
    id: crypto.randomUUID(),
    assetId: asset.id,
    filename: buildDownloadFilename(asset, pageTitle, index),
    url: asset.url,
    kind: asset.kind,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(owner ? { owner: { ...owner } } : {}),
  };
  await persistDirectDownloadRecord(record);

  let requestRuleId: number | undefined;
  if (mediaRequestContextRequired(asset)) {
    requestRuleId = await installMediaRequestContext(asset).catch(() => undefined);
    if (requestRuleId == null) {
      const failed: DownloadRecord = {
        ...record,
        state: 'interrupted',
        error: REQUEST_CONTEXT_ERROR,
        updatedAt: Date.now(),
      };
      delete failed.requestRuleId;
      return persistDirectDownloadRecord(failed);
    }
  }
  const prepared = requestRuleId == null ? record : { ...record, requestRuleId };

  try {
    if (requestRuleId != null) await persistDirectDownloadRecord(prepared);
    const chromeDownloadId = await chrome.downloads.download({
      url: asset.url,
      filename: record.filename,
      saveAs: settings.download.saveAs,
      conflictAction: 'uniquify',
    });
    const started: DownloadRecord = {
      ...prepared,
      chromeDownloadId,
      state: 'downloading',
      updatedAt: Date.now(),
    };
    await persistDirectDownloadRecord(started);

    // A very small file can finish before onChanged observes the ID mapping. Reconcile
    // immediately, and keep only the basename so local download paths never enter history.
    try {
      const item = (await chrome.downloads.search({ id: chromeDownloadId }))[0];
      if (item) {
        const reconciled: DownloadRecord = {
          ...started,
          ...(item.filename ? { filename: basenameFromPath(item.filename) } : {}),
          state:
            item.state === 'complete'
              ? 'complete'
              : item.state === 'interrupted'
                ? 'interrupted'
                : 'downloading',
          ...(item.error ? { error: item.error } : {}),
          updatedAt: Date.now(),
        };
        if (reconciled.state === 'complete' || reconciled.state === 'interrupted') {
          await releaseMediaRequestContext(requestRuleId).catch(() => undefined);
          delete reconciled.requestRuleId;
        }
        return await persistDirectDownloadRecord(reconciled);
      }
    } catch {
      // Download search may be unavailable in lightweight tests; onChanged remains authoritative.
    }
    // Even an empty or rejected search must not return the pre-event startup snapshot.
    return await persistDirectDownloadRecord(started);
  } catch (error) {
    await releaseMediaRequestContext(requestRuleId).catch(() => undefined);
    const failed: DownloadRecord = {
      ...prepared,
      state: 'interrupted',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    };
    delete failed.requestRuleId;
    return persistDirectDownloadRecord(failed);
  }
}

export async function startBatchDownloads(
  assets: MediaAsset[],
  pageTitle: string,
  settings: AppSettings,
  owner?: DownloadActivityOwner,
): Promise<DownloadRecord[]> {
  const results: DownloadRecord[] = [];
  const limit = Math.max(1, Math.min(8, settings.download.concurrentDownloads));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < assets.length) {
      const index = nextIndex;
      nextIndex += 1;
      const asset = assets[index];
      if (!asset) continue;
      results[index] = await startAssetDownload(asset, pageTitle, index, settings, owner);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, assets.length) }, () => worker()));
  return results.filter((record): record is DownloadRecord => record != null);
}
