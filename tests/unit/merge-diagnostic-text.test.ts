import { describe, expect, it } from 'vitest';

import { sanitizeMergeDiagnosticText } from '../../src/shared/merge-diagnostic-text';

describe('merge diagnostic exception privacy', () => {
  it.each([
    'fetch https://cdn.example/video.m4s?upsig=private-signature',
    'fetch https%3A%2F%2Fcdn.example%2Fvideo?upsig%3Dprivate-signature',
    '//cdn.example/video.m4s?deadline=123&upsig=private-signature',
    'Authorization: Bearer private-access-token',
    'Proxy-Authorization:\r\n Basic\r\n private-encoded-value',
    'Cookie:\n SESSDATA=private-session; bili_jct=private-csrf',
    '{"headers":{"authorization":"private-access-token","Cookie":"private-session"}}',
    'Set-Cookie: private-session',
    'access_token=private-access-token',
    'refreshToken: private-refresh-token',
    'upsig=private-signature',
    'token%3Dprivate-access-token',
    '{"token":"fixture-secret"}',
    '{"upsig":"fixture-secret"}',
    '{"signature":"fixture-secret"}',
    '{"deadline":"fixture-secret"}',
    "{'token': 'fixture-secret'}",
    '{\\"token\\":\\"fixture-secret\\"}',
    '%22token%22%3A%22fixture-secret%22',
    'X-Api-Key: fixture-secret',
    'x_api_key=fixture-secret',
    '{"apiKey":"fixture-secret"}',
    'api-key: fixture-secret',
    "'API_KEY' = 'fixture-secret'",
  ])('hides the complete opaque request exception: %s', (input) => {
    expect(sanitizeMergeDiagnosticText(input)).toBe('操作失败，包含来源或凭据的错误详情已隐藏。');
  });

  it.each([
    undefined,
    '',
    '正在检查编码配置',
    'DYNAMIC_RANGE_UNVERIFIED',
    'DV_CONFIG_MISSING',
    'NETWORK_TIMEOUT',
    'HTTP 403：来源拒绝访问',
    'HTTP 412：来源访问受限',
    '来源缺少杜比视界配置，无法确认完整保真输出。',
    '无法确认初始化已停止',
    '当前合并任务尚不能开始',
  ])('preserves safe public detail: %s', (input) => {
    expect(sanitizeMergeDiagnosticText(input)).toBe(input);
  });
});
