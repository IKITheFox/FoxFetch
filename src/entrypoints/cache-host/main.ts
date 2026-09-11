import {
  isMseCacheHostRequest,
  isMseCacheHostResponse,
  MSE_CACHE_HOST_AUTH_PORT_PREFIX,
  MSE_CACHE_HOST_CONNECT,
  MSE_CACHE_HOST_PROTOCOL_VERSION,
  type MseCacheHostErrorResponse,
  type MseCacheHostRequest,
  type MseCacheHostResponse,
} from '../../modules/resolver/mse-cache-host-protocol';
import { prepareVerifiedStandardSeparateBlob } from '../../modules/exports';
import { exportBlobToStoredDirectory } from '../../modules/downloads/custom-directory-export';
import { getMergeDownloadPathPolicy } from '../../modules/jobs/path-policy';
import { MergeError } from '../../modules/merge';

const REGISTRATION_TTL_MS = 10_000;
const DOWNLOAD_URL_TTL_MS = 30 * 60 * 1_000;
const WORKER_REQUEST_TIMEOUT_MS = 120_000;
const READY_REQUEST_ID = '__foxfetch_cache_host_ready__';
const registrations = new Map<string, number>();
const downloadUrls = new Map<
  number,
  { url: string; timer: number; cleanup?: () => void | Promise<void> }
>();
const expectedFrameNonce = (() => {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return '';
  }
})();

chrome.runtime.onConnect.addListener((port) => {
  const prefix = `${MSE_CACHE_HOST_AUTH_PORT_PREFIX}:`;
  if (!port.name.startsWith(prefix)) return;
  const nonce = port.name.slice(prefix.length);
  if (nonce !== expectedFrameNonce || !/^[0-9a-z-]{20,128}$/iu.test(nonce)) {
    port.disconnect();
    return;
  }
  const now = Date.now();
  for (const [candidate, expiresAt] of registrations) {
    if (expiresAt <= now) registrations.delete(candidate);
  }
  registrations.set(nonce, now + REGISTRATION_TTL_MS);
  port.postMessage({
    ok: true,
    protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
    nonce,
  });
});

function safeDownloadPath(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    return undefined;
  }
  const segments = value.split('/');
  const platform = segments[1] ?? '';
  const filename = segments[2] ?? '';
  if (
    segments.length !== 3 ||
    segments[0] !== 'FoxFetch' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u.test(platform) ||
    !filename ||
    filename !== filename.trim() ||
    filename.endsWith('.') ||
    /[<>:"|?*]/u.test(filename) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)
  ) {
    return undefined;
  }
  return value;
}

function releaseDownloadUrl(downloadId: number): void {
  const record = downloadUrls.get(downloadId);
  if (!record) return;
  window.clearTimeout(record.timer);
  URL.revokeObjectURL(record.url);
  downloadUrls.delete(downloadId);
  void record.cleanup?.();
}

async function releaseDownloadUrlIfTerminal(downloadId: number): Promise<void> {
  const record = downloadUrls.get(downloadId);
  if (!record) return;
  try {
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (!download || download.state === 'in_progress') return;
  } catch {
    return;
  }
  releaseDownloadUrl(downloadId);
}

function armDownloadUrlExpiry(downloadId: number): number {
  return window.setTimeout(() => {
    void (async () => {
      const record = downloadUrls.get(downloadId);
      if (!record) return;
      try {
        const [download] = await chrome.downloads.search({ id: downloadId });
        if (download?.state === 'in_progress') {
          record.timer = armDownloadUrlExpiry(downloadId);
          return;
        }
      } catch {
        // Fall through and release stale resources when Chrome no longer knows the task.
      }
      releaseDownloadUrl(downloadId);
    })();
  }, DOWNLOAD_URL_TTL_MS);
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
    releaseDownloadUrl(delta.id);
  }
});

function hostError(
  requestId: string,
  error: unknown,
  code: MseCacheHostErrorResponse['code'] = 'DOWNLOAD_FAILED',
): MseCacheHostErrorResponse {
  return {
    protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code,
    ...(error instanceof MergeError ? { failure: error.detail } : {}),
  };
}

function attachParentPort(parentPort: MessagePort): void {
  const worker = new Worker(new URL('./cache.worker.ts', import.meta.url), { type: 'module' });
  const workerChannel = new MessageChannel();
  const workerPort = workerChannel.port1;
  let internalSequence = 0;
  const pendingInternal = new Map<
    string,
    {
      resolve: (response: MseCacheHostResponse) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();

  const closeWorker = (): void => {
    workerPort.close();
    worker.terminate();
  };

  worker.postMessage({ type: 'attach-port' }, [workerChannel.port2]);
  workerPort.onmessage = (event: MessageEvent<unknown>) => {
    if (!isMseCacheHostResponse(event.data)) return;
    const response = event.data;
    const pending = pendingInternal.get(response.requestId);
    if (pending) {
      pendingInternal.delete(response.requestId);
      window.clearTimeout(pending.timer);
      pending.resolve(response);
      return;
    }
    parentPort.postMessage(response);
  };
  workerPort.onmessageerror = () => {
    for (const pending of pendingInternal.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('缓存工作线程通信失败。'));
    }
    pendingInternal.clear();
  };
  workerPort.start();

  const workerRequest = (request: MseCacheHostRequest): Promise<MseCacheHostResponse> =>
    new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingInternal.delete(request.requestId);
        reject(new Error('缓存工作线程响应超时。'));
      }, WORKER_REQUEST_TIMEOUT_MS);
      pendingInternal.set(request.requestId, { resolve, reject, timer });
      try {
        if (request.operation === 'append' || request.operation === 'write-output') {
          workerPort.postMessage(request, [request.bytes]);
        } else workerPort.postMessage(request);
      } catch (error) {
        pendingInternal.delete(request.requestId);
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  parentPort.onmessage = (event: MessageEvent<unknown>) => {
    const request = event.data;
    if (!isMseCacheHostRequest(request)) return;
    if (request.operation === 'dispose') {
      void workerRequest(request)
        .then((response) => {
          try {
            parentPort.postMessage(response);
          } catch {
            // The parent intentionally closes its end immediately on dispose.
          }
        })
        .catch(() => undefined)
        .finally(() => {
          closeWorker();
          parentPort.close();
        });
      return;
    }
    if (request.operation !== 'download-track' && request.operation !== 'download-output') {
      try {
        if (request.operation === 'append' || request.operation === 'write-output') {
          workerPort.postMessage(request, [request.bytes]);
        } else workerPort.postMessage(request);
      } catch (error) {
        parentPort.postMessage(hostError(request.requestId, error, 'STORAGE_FAILED'));
      }
      return;
    }

    void (async () => {
      const filename = safeDownloadPath(request.filename);
      if (!filename) {
        parentPort.postMessage(hostError(request.requestId, '下载路径无效。', 'INVALID_REQUEST'));
        return;
      }
      const internalId = `download-${++internalSequence}-${request.requestId}`;
      let responseToParent: MseCacheHostResponse;
      let outputDownloadStarted = false;
      const cleanupOutput = async (): Promise<void> => {
        if (request.operation !== 'download-output') return;
        const cleanupRequest: MseCacheHostRequest = {
          protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
          requestId: `cleanup-${++internalSequence}-${request.requestId}`,
          operation: 'delete-output',
          sessionId: request.sessionId,
          outputId: request.outputId,
        };
        await workerRequest(cleanupRequest).catch(() => undefined);
      };
      try {
        const blobRequest: MseCacheHostRequest =
          request.operation === 'download-track'
            ? {
                protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
                requestId: internalId,
                operation: 'get-blob',
                sessionId: request.sessionId,
                trackId: request.trackId,
                mime: request.mime,
                ...(request.maxBytes == null ? {} : { maxBytes: request.maxBytes }),
              }
            : {
                protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
                requestId: internalId,
                operation: 'get-output',
                sessionId: request.sessionId,
                outputId: request.outputId,
                mime: request.mime,
              };
        const blobResponse = await workerRequest(blobRequest);
        if (!blobResponse.ok) {
          responseToParent = { ...blobResponse, requestId: request.requestId };
        } else if (!(blobResponse.blob instanceof Blob) || blobResponse.blob.size === 0) {
          throw new Error('没有可下载的缓存。');
        } else {
          let downloadBlob = blobResponse.blob;
          if (request.operation === 'download-output' && request.standardOutput) {
            if (!filename.toLowerCase().endsWith(request.standardOutput.extension)) {
              throw new Error('标准缓存输出的下载扩展名不匹配。');
            }
            downloadBlob = await prepareVerifiedStandardSeparateBlob(
              downloadBlob,
              request.standardOutput,
            );
          }
          const policy =
            request.operation === 'download-output' && request.pageUrl
              ? await getMergeDownloadPathPolicy(request.pageUrl)
              : { mode: 'automatic' as const };
          if (request.operation === 'download-output' && policy.mode === 'custom') {
            const fileName = filename.split('/').at(-1)!;
            await exportBlobToStoredDirectory(
              policy.directory.handleId,
              fileName,
              downloadBlob,
              downloadBlob.size,
            );
            await cleanupOutput();
            outputDownloadStarted = true;
            responseToParent = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              customSaved: true,
            };
          } else {
            const url = URL.createObjectURL(downloadBlob);
            let downloadId: number;
            try {
              downloadId = await chrome.downloads.download({
                url,
                filename,
                saveAs:
                  request.operation === 'download-output' &&
                  (policy.mode === 'ask' || request.saveAs === true),
                conflictAction: 'uniquify',
              });
            } catch (error) {
              URL.revokeObjectURL(url);
              throw error;
            }
            const timer = armDownloadUrlExpiry(downloadId);
            downloadUrls.set(downloadId, {
              url,
              timer,
              ...(request.operation === 'download-output' ? { cleanup: cleanupOutput } : {}),
            });
            // A tiny local download can finish before onChanged observes the map entry.
            void releaseDownloadUrlIfTerminal(downloadId);
            outputDownloadStarted = request.operation === 'download-output';
            responseToParent = {
              protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              downloadId,
            };
          }
        }
      } catch (error) {
        responseToParent = hostError(request.requestId, error);
      } finally {
        if (request.operation === 'download-output' && !outputDownloadStarted)
          await cleanupOutput();
      }
      parentPort.postMessage(responseToParent);
    })();
  };
  parentPort.onmessageerror = () => {
    closeWorker();
    parentPort.close();
  };
  parentPort.start();
  parentPort.postMessage({
    protocolVersion: MSE_CACHE_HOST_PROTOCOL_VERSION,
    requestId: READY_REQUEST_ID,
    ok: true,
  } satisfies MseCacheHostResponse);
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data as { type?: unknown; protocolVersion?: unknown; nonce?: unknown };
  if (
    message.type !== MSE_CACHE_HOST_CONNECT ||
    message.protocolVersion !== MSE_CACHE_HOST_PROTOCOL_VERSION ||
    typeof message.nonce !== 'string'
  ) {
    return;
  }
  const expiresAt = registrations.get(message.nonce);
  registrations.delete(message.nonce);
  const port = event.ports[0];
  if (!port || expiresAt == null || expiresAt <= Date.now()) return;
  attachParentPort(port);
});
