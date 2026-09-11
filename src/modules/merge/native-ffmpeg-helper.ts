export const FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION = 1 as const;

export type NativeFfmpegHelperUnavailableReason =
  'not-configured' | 'host-not-found' | 'protocol-mismatch' | 'capability-missing';

export interface NativeFfmpegHelperCapability {
  protocolVersion: typeof FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION;
  available: boolean;
  implementation: 'optional-native-ffmpeg-helper';
  ffmpegVersion?: string;
  operations: {
    hdrStreamCopy: boolean;
    dolbyVisionStreamCopy: boolean;
    verifiesIsoBmffMetadata: boolean;
    verifiesPacketContent: boolean;
  };
  unavailableReason?: NativeFfmpegHelperUnavailableReason;
}

export interface NativeFfmpegHelloRequest {
  protocolVersion: typeof FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION;
  type: 'hello';
  client: 'FoxFetch';
}

export interface NativeFfmpegMergeRequest {
  protocolVersion: typeof FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION;
  type: 'merge-local-tracks';
  requestId: string;
  dynamicRange: 'HDR' | 'Dolby Vision';
  videoPath: string;
  audioPath: string;
  outputPath: string;
  mode: 'stream-copy';
  verify: {
    packetContent: true;
    isoBmffDynamicRangeMetadata: true;
  };
}

export type NativeFfmpegRequest = NativeFfmpegHelloRequest | NativeFfmpegMergeRequest;

export interface NativeFfmpegHelloResponse {
  protocolVersion: typeof FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION;
  type: 'capabilities';
  capability: NativeFfmpegHelperCapability;
}

export interface NativeFfmpegMergeResponse {
  protocolVersion: typeof FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION;
  type: 'merge-result';
  requestId: string;
  ok: boolean;
  outputSizeBytes?: number;
  outputSha256?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type NativeFfmpegResponse = NativeFfmpegHelloResponse | NativeFfmpegMergeResponse;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_TOKEN_PATTERN = /^[0-9a-z_-]{1,128}$/iu;

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The extension ships no native binary and this module never invokes one. It
 * defines and validates the narrow contract an optional, separately installed
 * helper may implement in a later integration.
 */
export function unavailableNativeFfmpegHelper(
  reason: NativeFfmpegHelperUnavailableReason = 'not-configured',
): NativeFfmpegHelperCapability {
  return {
    protocolVersion: FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION,
    available: false,
    implementation: 'optional-native-ffmpeg-helper',
    operations: {
      hdrStreamCopy: false,
      dolbyVisionStreamCopy: false,
      verifiesIsoBmffMetadata: false,
      verifiesPacketContent: false,
    },
    unavailableReason: reason,
  };
}

export type NativeFfmpegCapabilityTransport = (
  request: NativeFfmpegHelloRequest,
) => Promise<unknown>;

/**
 * Capability probe with an injected transport. Production remains
 * `not-configured` until an explicit native-messaging integration supplies the
 * transport; importing this module can never launch an external executable.
 */
export async function detectNativeFfmpegHelper(
  transport?: NativeFfmpegCapabilityTransport,
): Promise<NativeFfmpegHelperCapability> {
  if (!transport) return unavailableNativeFfmpegHelper('not-configured');
  try {
    const response = await transport({
      protocolVersion: FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION,
      type: 'hello',
      client: 'FoxFetch',
    });
    if (!isNativeFfmpegResponse(response) || response.type !== 'capabilities') {
      return unavailableNativeFfmpegHelper('protocol-mismatch');
    }
    return response.capability;
  } catch {
    return unavailableNativeFfmpegHelper('host-not-found');
  }
}

export function isNativeFfmpegHelperCapability(
  value: unknown,
): value is NativeFfmpegHelperCapability {
  if (!object(value) || !object(value.operations)) return false;
  return (
    value.protocolVersion === FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION &&
    typeof value.available === 'boolean' &&
    value.implementation === 'optional-native-ffmpeg-helper' &&
    typeof value.operations.hdrStreamCopy === 'boolean' &&
    typeof value.operations.dolbyVisionStreamCopy === 'boolean' &&
    typeof value.operations.verifiesIsoBmffMetadata === 'boolean' &&
    typeof value.operations.verifiesPacketContent === 'boolean' &&
    (value.ffmpegVersion === undefined ||
      (typeof value.ffmpegVersion === 'string' && value.ffmpegVersion.length <= 128)) &&
    (value.unavailableReason === undefined ||
      value.unavailableReason === 'not-configured' ||
      value.unavailableReason === 'host-not-found' ||
      value.unavailableReason === 'protocol-mismatch' ||
      value.unavailableReason === 'capability-missing')
  );
}

export function isNativeFfmpegResponse(value: unknown): value is NativeFfmpegResponse {
  if (!object(value) || value.protocolVersion !== FOXFETCH_NATIVE_FFMPEG_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === 'capabilities') return isNativeFfmpegHelperCapability(value.capability);
  if (value.type !== 'merge-result') return false;
  return (
    typeof value.requestId === 'string' &&
    SAFE_TOKEN_PATTERN.test(value.requestId) &&
    typeof value.ok === 'boolean' &&
    (value.outputSizeBytes === undefined ||
      (Number.isSafeInteger(value.outputSizeBytes) && Number(value.outputSizeBytes) > 0)) &&
    (value.outputSha256 === undefined ||
      (typeof value.outputSha256 === 'string' && SHA256_PATTERN.test(value.outputSha256))) &&
    (value.errorCode === undefined ||
      (typeof value.errorCode === 'string' && SAFE_TOKEN_PATTERN.test(value.errorCode))) &&
    (value.errorMessage === undefined ||
      (typeof value.errorMessage === 'string' && value.errorMessage.length <= 512))
  );
}

export function helperCanSafelyMerge(
  capability: NativeFfmpegHelperCapability,
  range: 'HDR' | 'Dolby Vision',
): boolean {
  return (
    capability.available &&
    capability.operations.verifiesIsoBmffMetadata &&
    capability.operations.verifiesPacketContent &&
    (range === 'HDR'
      ? capability.operations.hdrStreamCopy
      : capability.operations.dolbyVisionStreamCopy)
  );
}
