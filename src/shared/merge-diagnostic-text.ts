const PRIVATE_REQUEST_LOCATION = /(?:https?|blob|data|file)(?::|%3a)|\/\//iu;
const PRIVATE_CREDENTIAL_HEADER =
  /authorization|cookie|sessdata|bili_jct|(?:access|refresh)[_-]?token|\b(?:bearer|basic)\s/iu;
// Account for plain, JSON-quoted, escaped-JSON and percent-encoded keys without
// decoding or retaining their values. A bare safe HTTP status is not a URL.
const PRIVATE_KEY_VALUE =
  /(?:\b|%22|%27)(?:(?:x[-_]?)?api[-_]?key|upsig|token|signature|deadline)(?:[\s"'\\]|%22|%27|%5c)*(?:[=:]|%3[ad])/iu;

/**
 * Job stages, codes and reasons already come from the background's public
 * whitelist. Action/transport exceptions do not: never retain fragments of a
 * request dump, including folded or serialized credentials, in visible or
 * copied diagnostics. Keep the separate public fields intact instead.
 */
export function sanitizeMergeDiagnosticText(value: string | undefined): string | undefined {
  if (
    !value ||
    ![PRIVATE_REQUEST_LOCATION, PRIVATE_CREDENTIAL_HEADER, PRIVATE_KEY_VALUE].some((pattern) =>
      pattern.test(value),
    )
  )
    return value;
  return '操作失败，包含来源或凭据的错误详情已隐藏。';
}
