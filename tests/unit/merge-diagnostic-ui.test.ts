import { describe, expect, it } from 'vitest';
import { mergeDiagnosticLines } from '../../src/modules/playback/merge-diagnostic-ui';
import type { MergeDockView } from '../../src/shared/types';

describe('v0.13.0 explicit diagnostic presentation', () => {
  it('explains bounded source edit-list evidence without exposing raw metadata', () => {
    const diagnostics = {
      stage: '正在读取视频信息',
      readBytes: 10,
      totalBytes: 10,
      startedAt: 1,
      lastProgressAt: 2,
      sourceTimeline: {
        issue: 'open-ended-offset',
        sourceKind: 'audio',
        box: 'elst',
        version: 1,
        entryCount: 1,
        entryIndex: 0,
        duration: 0,
        mediaTime: 1024,
        rate: 65536,
        movieTimescale: 1000,
        mediaTimescale: 48000,
        secret: 'Cookie: hidden',
        url: 'https://private.example/token',
      },
    } as NonNullable<MergeDockView['diagnostics']>;
    const text = mergeDiagnosticLines(diagnostics, undefined, String).join('\n');
    expect(text).toContain('来源轨道：音频');
    expect(text).toContain('时间轴结构：elst');
    expect(text).toContain('结构原因：开放时长编辑的偏移尚未验证');
    expect(text).toContain('编辑区间刻度：0');
    expect(text).toContain('编辑起点刻度：1024');
    expect(text).not.toMatch(/Cookie|hidden|private|https:|token/u);
  });
  it('reports actual source/output decoder configuration without treating missing fields as zero or false', () => {
    const diagnostics = {
      stage: '正在验证输出',
      readBytes: 1,
      totalBytes: 1,
      startedAt: 1,
      lastProgressAt: 1,
      configuration: {
        source: {
          sampleEntryType: 'dvh1',
          profile: 8,
          level: 7,
          rpuPresent: true,
          baseLayerPresent: true,
          enhancementLayerPresent: false,
          bitDepthLuma: 10,
          bitDepthChroma: 10,
          chromaFormatIdc: 1,
          parameterSetsComplete: true,
          parameterSetsConflict: false,
          colourSource: 'colr+sps-vui',
          colourPrimaries: 9,
          transferCharacteristics: 16,
          matrixCoefficients: 9,
          secret: 'Cookie: fixture-private',
        },
        output: { sampleEntryType: 'hvc1', bitDepthLuma: 900, url: 'https://private.example/' },
      },
    } as NonNullable<MergeDockView['diagnostics']>;
    const text = mergeDiagnosticLines(diagnostics, undefined, String).join('\n');
    expect(text).toContain('源编码配置：入口 dvh1 · 位深 Y/C 10/10');
    expect(text).toContain('源杜比配置：Profile 8 · Level 7 · RPU 是 · BL 是 · EL 否');
    expect(text).toContain('源色彩配置：来源 colr+sps-vui · P/T/M 9/16/9 · 全范围 未知');
    expect(text).toContain('输出编码配置：入口 hvc1 · 位深 Y/C 未知/未知');
    expect(text).toContain('输出杜比配置：Profile 未知 · Level 未知 · RPU 未知');
    expect(text).not.toMatch(/Cookie|private|https:|900/u);
  });
  it('prints one cause plus subcode and explicit network/timing evidence, not unknown fields', () => {
    const diagnostics = {
      stage: '正在验证视频',
      readBytes: 1024,
      totalBytes: 2048,
      startedAt: 1,
      lastProgressAt: 2,
      errorCode: 'OUTPUT_TIMELINE_MISMATCH',
      reasonCode: 'PACKET_TIMELINE_MISMATCH',
      reason: '视频包时间戳不一致。',
      taskReference: 'public-view-reference',
      network: {
        readMode: 'sequential',
        fallback: 'range-unavailable',
        responseStatus: 200,
        url: 'https://secret.example/token',
      },
      timeline: {
        track: 'video',
        packetIndex: 42,
        mismatch: 'timestamp',
        sourceTimestampSeconds: 10.032,
        normalizedSourceTimestampSeconds: 0.032,
        outputTimestampSeconds: 0.04,
        originSeconds: 10,
        timestampDeltaSeconds: 0.008,
        timestampToleranceSeconds: 0.0001,
        sourceTimescale: 90000,
        secret: 'Cookie: hidden',
      },
    } as NonNullable<MergeDockView['diagnostics']>;
    const text = mergeDiagnosticLines(
      diagnostics,
      'OUTPUT_TIMELINE_MISMATCH：视频包时间戳不一致。',
      String,
    ).join('\n');
    expect(text.match(/视频包时间戳不一致。/gu)).toHaveLength(1);
    expect(text).toContain('原因子码：PACKET_TIMELINE_MISMATCH');
    expect(text).toContain('共同时间原点：10 s');
    expect(text).toContain('源时间戳：10.032 s');
    expect(text).toContain('时间戳差值：0.008 s');
    expect(text).toContain('源时间基：1/90000');
    expect(text).toContain('读取模式：顺序读取');
    expect(text).toContain('HTTP 状态：200');
    expect(text).not.toMatch(/secret|Cookie|https:/u);
  });

  it('does not print non-finite numeric values or private action strings', () => {
    const text = mergeDiagnosticLines(
      {
        stage: '校验中',
        readBytes: 0,
        totalBytes: null,
        startedAt: 1,
        lastProgressAt: 2,
        reason: '公共原因',
        timeline: {
          track: 'audio',
          packetIndex: 0,
          mismatch: 'non-finite',
          sourceTimestampSeconds: NaN,
          outputTimestampSeconds: Infinity,
        },
      },
      'https://secret.example/?token=secret',
      String,
    ).join('\n');
    expect(text).toContain('公共原因');
    expect(text).toContain('包序号（从 0 开始）：0');
    expect(text).not.toMatch(/NaN|Infinity|token|secret/u);
  });
});
