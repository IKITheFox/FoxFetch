import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FloatingPlaybackController,
  type FloatingResourceSnapshot,
} from '../../src/modules/playback/floating-controller';
import { PlaybackManager } from '../../src/modules/playback/playback-manager';
import { siteMediaRouteKey } from '../../src/modules/detector/site-media';

type Quality = NonNullable<FloatingResourceSnapshot['products'][number]['qualities']>[number];
const sdr = (revision = 1): Quality => ({
  id: 'representation-4k-avc',
  token: `sdr-grant-${revision}`,
  label: '4K · AVC',
  detail: '3840×2160 · SDR',
  completeAvailable: true,
  videoOnlyAvailable: true,
});
const dv = (revision = 1): Quality => ({
  id: 'representation-dv-hevc',
  token: `dv-grant-${revision}`,
  label: '杜比视界 · HEVC',
  detail: '3840×2160 · Dolby Vision',
  dynamicRange: 'Dolby Vision',
  completeAvailable: true,
  videoOnlyAvailable: true,
});

let controller: FloatingPlaybackController;
let manager: PlaybackManager;
const download = vi.fn(async () => undefined);

function mount() {
  download.mockClear();
  manager = new PlaybackManager(document);
  manager.start();
  controller = new FloatingPlaybackController(document, manager, {
    playback: { showController: true },
    onResourceProductDownload: download,
  });
}

function snapshot(
  revision: number,
  qualities: readonly Quality[] = [sdr(revision), dv(revision)],
  overrides: Partial<FloatingResourceSnapshot> = {},
): FloatingResourceSnapshot {
  return {
    status: 'ready',
    pageIdentity: siteMediaRouteKey(document.URL),
    navigationEpoch: 1,
    mediaEpoch: 1,
    sequence: revision,
    products: [
      {
        id: 'media-bvid-cid-p-1',
        renderKey: 'media-bvid-cid-p-1',
        grantToken: `product-grant-${revision}`,
        title: '当前视频',
        domain: 'bilibili.com',
        qualities,
        options: [{ mode: 'complete' }, { mode: 'video' }, { mode: 'audio' }],
      },
    ],
    ...overrides,
  };
}

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = controller.shadowRoot.querySelector<T>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}

function selectResolution(label: string) {
  element<HTMLButtonElement>('[data-role="product-resolution"] [role="combobox"]').click();
  const option = [
    ...controller.shadowRoot.querySelectorAll<HTMLButtonElement>(
      '[data-role="product-resolution"] [role="option"]',
    ),
  ].find((candidate) => candidate.textContent === label);
  expect(option, label).toBeDefined();
  option!.click();
}

function expectDv() {
  expect(element('[data-role="product-resolution"] .dock-variant-value').textContent).toBe(
    '杜比视界',
  );
  expect(element('[data-role="product-quality"] .dock-variant-value').textContent).toBe('HEVC');
}

function clickVideo() {
  element<HTMLButtonElement>('.dock-product-trigger').click();
  element<HTMLButtonElement>('[data-download-mode="video"]').click();
}

afterEach(() => {
  controller?.destroy();
  manager?.stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('floating resource quality selection intent', () => {
  it.each(['title', 'detail'] as const)(
    'retains an explicit representation through a %s refresh',
    async (change) => {
      mount();
      controller.setResourceSnapshot(snapshot(1));
      selectResolution('杜比视界');
      expectDv();
      const updated = snapshot(2, [
        sdr(2),
        {
          ...dv(2),
          ...(change === 'detail' ? { detail: '3840×2160 · 29.970 fps · Dolby Vision' } : {}),
        },
      ]);
      if (change === 'title') updated.products[0]!.title = '标题补全后仍是同一媒体';
      controller.setResourceSnapshot(updated);
      expectDv();
      clickVideo();
      await vi.waitFor(() =>
        expect(download).toHaveBeenCalledExactlyOnceWith('product-grant-2', 'video', 'dv-grant-2'),
      );
    },
  );

  it.each(['partial', 'empty', 'unavailable'] as const)(
    'retains unavailable intent without reusing a grant during a %s scan, then restores it',
    async (scan) => {
      mount();
      controller.setResourceSnapshot(snapshot(1));
      selectResolution('杜比视界');
      const before = element('.dock-product');
      const updated = snapshot(
        2,
        scan === 'unavailable'
          ? [sdr(2), { ...dv(2), completeAvailable: false, videoOnlyAvailable: false }]
          : [sdr(2)],
        { status: 'loading', ...(scan === 'empty' ? { products: [] } : {}) },
      );
      controller.setResourceSnapshot(updated);
      expectDv();
      if (scan === 'empty') expect(element('.dock-product')).toBe(before);
      expect(element('[data-role="product-quality-detail"]').textContent).toContain('暂不可用');
      const blockedChoice = element<HTMLButtonElement>(
        '[data-role="product-quality"] [role="option"][aria-selected="true"]',
      );
      expect(blockedChoice.disabled).toBe(true);
      blockedChoice.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      for (const mode of ['complete', 'video']) {
        const button = element<HTMLButtonElement>(`[data-download-mode="${mode}"]`);
        expect(button.disabled).toBe(true);
        expect(button.dataset.qualityToken).toBeUndefined();
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      }
      expect(download).not.toHaveBeenCalled();
      controller.setResourceSnapshot(snapshot(3));
      expectDv();
      expect(element<HTMLButtonElement>('[data-download-mode="video"]').disabled).toBe(false);
      clickVideo();
      await vi.waitFor(() =>
        expect(download).toHaveBeenCalledExactlyOnceWith('product-grant-3', 'video', 'dv-grant-3'),
      );
    },
  );

  it('lets an explicit replacement override unavailable intent', () => {
    mount();
    controller.setResourceSnapshot(snapshot(1));
    selectResolution('杜比视界');
    controller.setResourceSnapshot(snapshot(2, [sdr(2)], { status: 'loading' }));
    expectDv();
    selectResolution('4K');
    controller.setResourceSnapshot(snapshot(3));
    expect(element('[data-role="product-resolution"] .dock-variant-value').textContent).toBe('4K');
    expect(element('[data-role="product-quality"] .dock-variant-value').textContent).toBe('AVC');
  });

  it('explains unavailable selection once without hiding an actual fidelity failure', () => {
    mount();
    controller.setResourceSnapshot(snapshot(1));
    selectResolution('杜比视界');
    controller.setResourceSnapshot(snapshot(2, [sdr(2)]));
    const unavailable = element('[data-role="product-quality-detail"]').textContent;
    expect(unavailable).toContain('所选画质暂不可用');
    expect(element('[data-role="product-fidelity-error"]').hidden).toBe(true);
    expect(element('[data-role="product-fidelity-error"]').textContent).toBe('');
    expect(element('[data-role="product-fidelity"]').getAttribute('aria-label')).toBe(
      '所选画质暂不可用',
    );
    for (const mode of ['complete', 'video']) {
      const button = element<HTMLButtonElement>(`[data-download-mode="${mode}"]`);
      expect(button.disabled).toBe(true);
      expect(button.querySelector('small')?.textContent).toBe(unavailable);
      expect(button.textContent).not.toContain('没有独立画面轨道');
    }
    const reason = 'Dolby Vision 原轨保真校验未通过；可分别保存原轨。';
    controller.setResourceSnapshot(
      snapshot(3, [
        sdr(3),
        {
          ...dv(3),
          completeAvailable: false,
          videoOnlyAvailable: true,
          fidelityState: 'blocked',
          mergeBlockedReason: reason,
        },
      ]),
    );
    expectDv();
    expect(element('[data-role="product-fidelity-error"]').hidden).toBe(false);
    expect(element('[data-role="product-fidelity-error"]').textContent).toBe(reason);
    expect(element('[data-role="product-fidelity"]').getAttribute('aria-label')).toBe(
      '完整视频不可安全合并',
    );
    expect(element<HTMLButtonElement>('[data-download-mode="complete"]').disabled).toBe(true);
    expect(element<HTMLButtonElement>('[data-download-mode="video"]').disabled).toBe(false);
  });

  it('retains a fresh explicitly blocked quality and its real reason when both video capabilities are denied', () => {
    mount();
    controller.setResourceSnapshot(snapshot(1));
    selectResolution('杜比视界');
    const reason = 'Dolby Vision 配置校验失败：原始轨道的配置元数据不完整。';
    controller.setResourceSnapshot(
      snapshot(2, [
        sdr(2),
        {
          ...dv(2),
          completeAvailable: false,
          videoOnlyAvailable: false,
          fidelityState: 'blocked',
          mergeBlockedReason: reason,
        },
      ]),
    );
    expectDv();
    expect(element('[data-role="product-quality-detail"]').textContent).toBe(dv(2).detail);
    expect(element('[data-role="product-fidelity-error"]').hidden).toBe(false);
    expect(element('[data-role="product-fidelity-error"]').textContent).toBe(reason);
    expect(element('[data-role="product-fidelity"]').getAttribute('aria-label')).toBe(
      '完整视频不可安全合并',
    );
    for (const role of ['product-resolution', 'product-quality']) {
      const option = element<HTMLButtonElement>(
        `[data-role="${role}"] [role="option"][aria-selected="true"]`,
      );
      expect(option.disabled).toBe(true);
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
    for (const mode of ['complete', 'video']) {
      const button = element<HTMLButtonElement>(`[data-download-mode="${mode}"]`);
      expect(button.disabled).toBe(true);
      expect(button.dataset.qualityToken).toBe('dv-grant-2');
      expect(button.querySelector('small')?.textContent).toBe(reason);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
    expect(download).not.toHaveBeenCalled();
    expect(element('[data-role="product-fidelity-error"]').textContent).toBe(reason);
  });

  it.each(['fresh', 'missing', 'empty'] as const)(
    'uses only %s current audio capability while DV is absent',
    async (capability) => {
      mount();
      controller.setResourceSnapshot(snapshot(1));
      selectResolution('杜比视界');
      const updated = snapshot(2, [sdr(2)], { status: 'loading' });
      if (capability === 'missing')
        updated.products[0]!.options = [{ mode: 'complete' }, { mode: 'video' }];
      if (capability === 'empty') updated.products = [];
      controller.setResourceSnapshot(updated);
      expectDv();
      element<HTMLButtonElement>('.dock-product-trigger').click();
      const button = element<HTMLButtonElement>('[data-download-mode="audio"]');
      expect(button.disabled).toBe(capability !== 'fresh');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      if (capability === 'fresh') {
        await vi.waitFor(() =>
          expect(download).toHaveBeenCalledExactlyOnceWith('product-grant-2', 'audio'),
        );
      } else {
        expect(download).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps an explicit same-resolution HEVC choice unavailable until that representation returns', async () => {
    const hevc = (revision: number): Quality => ({
      ...sdr(revision),
      id: 'representation-4k-hevc',
      label: '4K · HEVC',
      token: `hevc-grant-${revision}`,
    });
    mount();
    controller.setResourceSnapshot(snapshot(1, [sdr(1), hevc(1)]));
    element<HTMLButtonElement>('[data-role="product-quality"] [role="combobox"]').click();
    const option = [
      ...controller.shadowRoot.querySelectorAll<HTMLButtonElement>(
        '[data-role="product-quality"] [role="option"]',
      ),
    ].find((candidate) => candidate.textContent === 'HEVC');
    expect(option).toBeDefined();
    option!.click();
    controller.setResourceSnapshot(snapshot(2, [sdr(2)]));
    expect(element('[data-role="product-quality"] .dock-variant-value').textContent).toBe('HEVC');
    expect(element<HTMLButtonElement>('[data-download-mode="complete"]').disabled).toBe(true);
    expect(element<HTMLButtonElement>('[data-download-mode="video"]').disabled).toBe(true);
    controller.setResourceSnapshot(
      snapshot(3, [sdr(3), { ...hevc(3), detail: '3840×2160 · 60 fps · SDR' }]),
    );
    expect(element('[data-role="product-quality"] .dock-variant-value').textContent).toBe('HEVC');
    clickVideo();
    await vi.waitFor(() =>
      expect(download).toHaveBeenCalledExactlyOnceWith('product-grant-3', 'video', 'hevc-grant-3'),
    );
  });

  it('can keyboard-select an available replacement without focusing the disabled retained choice', async () => {
    mount();
    controller.setResourceSnapshot(snapshot(1));
    selectResolution('杜比视界');
    controller.setResourceSnapshot(snapshot(2, [sdr(2)]));
    const trigger = element<HTMLButtonElement>(
      '[data-role="product-resolution"] [role="combobox"]',
    );
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true }),
    );
    await vi.waitFor(() => expect(controller.shadowRoot.activeElement?.textContent).toBe('4K'));
    controller.shadowRoot.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
    );
    expect(element('[data-role="product-resolution"] .dock-variant-value').textContent).toBe('4K');
  });

  it.each([
    ['BVID', 'https://www.bilibili.com/video/BV1nutz6mEgY/?p=1&cid=123'],
    ['CID', 'https://www.bilibili.com/video/BV1tz7e6xEQq/?p=1&cid=456'],
    ['part', 'https://www.bilibili.com/video/BV1tz7e6xEQq/?p=2&cid=123'],
  ])('clears intent when the actual %s route changes', (_identity, nextUrl) => {
    const url = vi
      .spyOn(document, 'URL', 'get')
      .mockReturnValue('https://www.bilibili.com/video/BV1tz7e6xEQq/?p=1&cid=123');
    mount();
    controller.setResourceSnapshot(snapshot(1));
    selectResolution('杜比视界');
    url.mockReturnValue(nextUrl!);
    controller.clearResourceSnapshotForNavigation({
      pageIdentity: siteMediaRouteKey(nextUrl!),
      navigationEpoch: 2,
      mediaEpoch: 2,
    });
    controller.setResourceSnapshot(snapshot(2, undefined, { navigationEpoch: 2, mediaEpoch: 2 }));
    expect(element('[data-role="product-resolution"] .dock-variant-value').textContent).toBe('4K');
  });

  it.each(['mediaEpoch', 'navigationEpoch', 'productIdentity'] as const)(
    'does not carry intent across a new %s',
    (change) => {
      mount();
      controller.setResourceSnapshot(snapshot(1));
      selectResolution('杜比视界');
      const updated = snapshot(2);
      if (changeIsEpoch(change)) updated[change] = 2;
      else {
        updated.products[0]!.id = 'different-bvid-cid-p';
        updated.products[0]!.renderKey = 'different-bvid-cid-p';
      }
      controller.setResourceSnapshot(updated);
      expect(element('[data-role="product-resolution"] .dock-variant-value').textContent).toBe(
        '4K',
      );
    },
  );
});

function changeIsEpoch(change: string): change is 'mediaEpoch' | 'navigationEpoch' {
  return change === 'mediaEpoch' || change === 'navigationEpoch';
}
