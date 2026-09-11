import type { CompletedStandardSeparateOutput, StandardSeparateOutputKind } from '../exports';
import type { MergeFailureDetail } from '../merge';

export const MSE_CACHE_HOST_PROTOCOL_VERSION = 2 as const;
export const MSE_CACHE_HOST_REGISTER = 'FOXFETCH_REGISTER_MSE_CACHE_HOST' as const;
export const MSE_CACHE_HOST_CONNECT = 'foxfetch:mse-cache-host:connect' as const;
export const MSE_CACHE_HOST_AUTH_PORT_PREFIX = 'foxfetch:mse-cache-host:auth' as const;

export interface MseCacheHostRegistrationMessage {
  type: typeof MSE_CACHE_HOST_REGISTER;
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  nonce: string;
}

export interface MseCacheHostRegistrationResponse {
  ok: true;
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  nonce: string;
}

export interface MseCacheHostConnectMessage {
  type: typeof MSE_CACHE_HOST_CONNECT;
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  nonce: string;
}

interface MseCacheHostRequestBase {
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  requestId: string;
}

export type MseCacheHostRequest =
  | (MseCacheHostRequestBase & {
      operation: 'append';
      sessionId: string;
      trackId: string;
      bytes: ArrayBuffer;
    })
  | (MseCacheHostRequestBase & {
      operation: 'get-blob';
      sessionId: string;
      trackId: string;
      mime: string;
      maxBytes?: number;
    })
  | (MseCacheHostRequestBase & {
      operation: 'clear-session';
      sessionId: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'download-track';
      sessionId: string;
      trackId: string;
      mime: string;
      maxBytes?: number;
      filename: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'export-standard-track';
      sessionId: string;
      parts: Array<{
        trackId: string;
        mime: string;
        maxBytes: number;
        firstSequence: number;
      }>;
      outputId: string;
      kind: StandardSeparateOutputKind;
    })
  | (MseCacheHostRequestBase & {
      operation: 'create-output';
      sessionId: string;
      outputId: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'write-output';
      sessionId: string;
      outputId: string;
      position: number;
      bytes: ArrayBuffer;
    })
  | (MseCacheHostRequestBase & {
      operation: 'close-output';
      sessionId: string;
      outputId: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'get-output';
      sessionId: string;
      outputId: string;
      mime: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'delete-output';
      sessionId: string;
      outputId: string;
    })
  | (MseCacheHostRequestBase & {
      operation: 'download-output';
      sessionId: string;
      outputId: string;
      mime: string;
      filename: string;
      pageUrl?: string;
      saveAs?: boolean;
      standardOutput?: CompletedStandardSeparateOutput;
    })
  | (MseCacheHostRequestBase & {
      operation: 'dispose';
    });

export interface MseCacheHostSuccessResponse {
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  persistedBytes?: number;
  availableBytes?: number;
  sizeBytes?: number;
  blob?: Blob;
  downloadId?: number;
  customSaved?: true;
  standardOutput?: CompletedStandardSeparateOutput;
}

export interface MseCacheHostErrorResponse {
  protocolVersion: typeof MSE_CACHE_HOST_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: string;
  code?: 'QUOTA_EXCEEDED' | 'INVALID_REQUEST' | 'STORAGE_FAILED' | 'DOWNLOAD_FAILED';
  failure?: MergeFailureDetail;
}

export type MseCacheHostResponse = MseCacheHostSuccessResponse | MseCacheHostErrorResponse;

export function isMseCacheHostRequest(value: unknown): value is MseCacheHostRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MseCacheHostRequest>;
  if (!(
    candidate.protocolVersion === MSE_CACHE_HOST_PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    typeof candidate.operation === 'string'
  )) {
    return false;
  }
  const record = candidate as unknown as Record<string, unknown>;
  const identifier = (entry: unknown): entry is string =>
    typeof entry === 'string' && entry.length > 0;
  const optionalNumber = (entry: unknown): entry is number | undefined =>
    entry == null || typeof entry === 'number';
  const outputIdentity = (): boolean => identifier(record.sessionId) && identifier(record.outputId);
  switch (candidate.operation) {
    case 'append':
      return (
        identifier(record.sessionId) &&
        identifier(record.trackId) &&
        record.bytes instanceof ArrayBuffer
      );
    case 'get-blob':
      return (
        identifier(record.sessionId) &&
        identifier(record.trackId) &&
        typeof record.mime === 'string' &&
        optionalNumber(record.maxBytes)
      );
    case 'clear-session':
      return identifier(record.sessionId);
    case 'download-track':
      return (
        identifier(record.sessionId) &&
        identifier(record.trackId) &&
        typeof record.mime === 'string' &&
        typeof record.filename === 'string' &&
        optionalNumber(record.maxBytes)
      );
    case 'export-standard-track':
      return (
        outputIdentity() &&
        Array.isArray(record.parts) &&
        record.parts.length > 0 &&
        record.parts.length <= 64 &&
        record.parts.every((part) => {
          if (!part || typeof part !== 'object') return false;
          const candidatePart = part as Record<string, unknown>;
          return (
            identifier(candidatePart.trackId) &&
            typeof candidatePart.mime === 'string' &&
            Number.isSafeInteger(candidatePart.maxBytes) &&
            Number(candidatePart.maxBytes) > 0 &&
            Number.isSafeInteger(candidatePart.firstSequence) &&
            Number(candidatePart.firstSequence) >= 0
          );
        }) &&
        (record.kind === 'video' || record.kind === 'audio')
      );
    case 'create-output':
    case 'close-output':
    case 'delete-output':
      return outputIdentity();
    case 'write-output':
      return (
        outputIdentity() &&
        Number.isSafeInteger(record.position) &&
        Number(record.position) >= 0 &&
        record.bytes instanceof ArrayBuffer &&
        Number.isSafeInteger(Number(record.position) + record.bytes.byteLength)
      );
    case 'get-output':
      return outputIdentity() && typeof record.mime === 'string';
    case 'download-output':
      return (
        outputIdentity() &&
        typeof record.mime === 'string' &&
        typeof record.filename === 'string' &&
        (record.pageUrl == null ||
          (typeof record.pageUrl === 'string' && record.pageUrl.length <= 4_096)) &&
        (record.saveAs == null || typeof record.saveAs === 'boolean') &&
        (record.standardOutput == null || typeof record.standardOutput === 'object')
      );
    case 'dispose':
      return true;
    default:
      return false;
  }
}

export function isMseCacheHostResponse(value: unknown): value is MseCacheHostResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MseCacheHostResponse>;
  return (
    candidate.protocolVersion === MSE_CACHE_HOST_PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.ok === 'boolean'
  );
}
