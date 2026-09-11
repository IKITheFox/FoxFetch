import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SourceCapturePanel } from '../../src/components/SourceCapturePanel';
import type { SourceCaptureView } from '../../src/shared/types';

function capture(overrides: Partial<SourceCaptureView> = {}): SourceCaptureView {
  return {
    id: 'capture-1',
    tabId: 7,
    blobAssetId: 'blob-1',
    status: 'waiting_for_playback',
    startedAt: 1,
    updatedAt: 2,
    observationCount: 0,
    candidateCount: 0,
    ...overrides,
  };
}

function renderPanel(value: SourceCaptureView, busy: boolean): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <SourceCapturePanel
      capture={value}
      busy={busy}
      onReload={vi.fn()}
      onDownload={vi.fn()}
      onCancel={vi.fn()}
      onRestart={vi.fn()}
    />,
  );
  return container;
}

describe('SourceCapturePanel', () => {
  it('locks reload and cancel together while a capture action is in flight', () => {
    const container = renderPanel(capture(), true);
    const buttons = [...container.querySelectorAll('button')];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      '无结果时刷新重试',
      '取消',
    ]);
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it('keeps both waiting-state actions available when no request is in flight', () => {
    const container = renderPanel(capture(), false);
    const buttons = [...container.querySelectorAll('button')];

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it('keeps refresh available as a fallback during no-reload live capture', () => {
    const container = renderPanel(capture({ status: 'capturing' }), false);

    expect(container.textContent).toContain('正在寻找真实媒体源');
    expect(container.textContent).toContain('无结果时刷新重试');
  });

  it('labels a resolved split-track result as a merge download', () => {
    const container = renderPanel(
      capture({
        status: 'resolved',
        videoAssetId: 'video-1',
        audioAssetId: 'audio-1',
        observationCount: 2,
        candidateCount: 2,
      }),
      false,
    );

    expect(container.textContent).toContain('合并下载');
    expect(container.textContent).toContain('视频与音频已配对');
  });
});
