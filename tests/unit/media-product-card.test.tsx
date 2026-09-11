import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MediaProductCard,
  type MediaProductCardProps,
  type MediaProductDownloadOption,
} from '../../src/components/MediaProductCard';

const options: MediaProductDownloadOption[] = [
  { mode: 'complete' },
  { mode: 'video' },
  { mode: 'audio' },
];

interface RenderedCard {
  container: HTMLDivElement;
  root: Root;
  onDownload: ReturnType<typeof vi.fn<NonNullable<MediaProductCardProps['onDownload']>>>;
  onQualityChange: ReturnType<typeof vi.fn<NonNullable<MediaProductCardProps['onQualityChange']>>>;
}

const mountedRoots = new Set<Root>();

function renderCard(overrides: Partial<MediaProductCardProps> = {}): RenderedCard {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onDownload = vi.fn<NonNullable<MediaProductCardProps['onDownload']>>();
  const onQualityChange = vi.fn<NonNullable<MediaProductCardProps['onQualityChange']>>();

  document.body.append(container);
  mountedRoots.add(root);
  act(() => {
    root.render(
      <MediaProductCard
        title="测试视频"
        domain="bilibili.com"
        duration={96}
        selectedQuality="1080P"
        options={options}
        onQualityChange={onQualityChange}
        onDownload={onDownload}
        {...overrides}
      />,
    );
  });

  return { container, root, onDownload, onQualityChange };
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keydown(element: Element, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.clear();
    document.body.replaceChildren();
  });
});

describe('MediaProductCard', () => {
  it('normalizes own cover URLs and retries one failed URL only for a fresh artwork generation', () => {
    const poster = 'http://i0.hdslb.com/bfs/archive/fixture.jpg@272w?x=1';
    const { container, root, onDownload } = renderCard({ poster, artworkKey: 'epoch-1' });
    const image = container.querySelector<HTMLImageElement>('.media-product-card__poster')!;
    expect(image.getAttribute('src')).toBe(poster.replace('http:', 'https:'));
    act(() => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('.media-product-card__poster')).toBeNull();
    const renderGeneration = (artworkKey: string) =>
      act(() =>
        root.render(
          <MediaProductCard
            title="测试视频"
            domain="bilibili.com"
            poster={poster}
            artworkKey={artworkKey}
            options={options}
            onDownload={onDownload}
          />,
        ),
      );
    renderGeneration('epoch-1');
    expect(container.querySelector('.media-product-card__poster')).toBeNull();
    renderGeneration('epoch-2');
    expect(container.querySelector('.media-product-card__poster')).not.toBeNull();
    expect(poster.startsWith('http:')).toBe(true);
  });
  it('labels a delivered Dolby candidate as awaiting output proof, not verified success', () => {
    const { container } = renderCard({
      selectedQualityId: 'dv',
      qualityOptions: [
        {
          id: 'dv',
          label: '杜比视界 · HEVC',
          dynamicRange: 'Dolby Vision',
          completeAvailable: true,
          videoOnlyAvailable: true,
          completeCheckRequired: true,
        },
      ],
    });
    const status = container.querySelector('.media-product-card__title-row [role="status"]')!;
    expect(status.getAttribute('aria-label')).toBe('已找到媒体地址，尚未验证下载后的文件。');
    expect(status.classList.contains('status-dot--ready')).toBe(false);
  });
  it('keeps selected dimensions and fps below accessible, unlabelled selectors', () => {
    const { container } = renderCard({
      selectedQualityId: 'q80',
      qualityOptions: [
        {
          id: 'q80',
          label: '1080P · HEVC',
          detail: '1920×1080 · 30.000 fps',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
      ],
    });
    expect(container.querySelector('.media-product-card__meta')?.textContent?.trim()).toBe(
      '1920×1080 · 30.000 fps',
    );
    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(2);
    expect(container.querySelectorAll('label')).toHaveLength(0);
    expect(container.querySelector('[aria-label="测试视频 的清晰度"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="测试视频 的视频编码"]')).not.toBeNull();
  });
  it('shows one finished product and exposes the three download choices', () => {
    const { container } = renderCard();

    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(container.textContent).toContain('测试视频');
    expect(container.textContent).toContain('1080P');
    expect(container.querySelector('.media-product-card__duration')?.textContent).toBe('1:36');
    expect(container.textContent).not.toContain('bilibili.com');
    expect(container.textContent).not.toContain('成品');
    expect(container.textContent).not.toContain('音画已匹配');
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      '音画已匹配',
    );
    expect(container.querySelector('[aria-label="哔哩哔哩 平台"]')).not.toBeNull();
    expect(container.querySelector('.media-product-card__platform')?.textContent).toBe('哔哩哔哩');

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    expect(trigger).not.toBeNull();
    click(trigger!);

    const menu = container.querySelector('[role="menu"]');
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(menu?.getAttribute('aria-labelledby')).toBe(trigger?.id);
    expect(items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '完整视频自动合并视频与音频推荐',
      '无音频视频只保存当前清晰度画面',
      '仅音频只保存匹配的音轨',
    ]);
  });

  it('shows the current video poster and falls back to the platform mark when it fails', () => {
    const poster = 'https://i0.hdslb.com/current-cover.jpg?signed=private';
    const { container } = renderCard({ poster });
    const image = container.querySelector<HTMLImageElement>('.media-product-card__poster')!;

    expect(image.src).toBe(poster);
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(container.querySelector('.media-product-card__platform')?.textContent).toBe('哔哩哔哩');
    expect(container.querySelector('.media-product-card__duration')?.textContent).toBe('1:36');

    act(() => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('.media-product-card__poster')).toBeNull();
    expect(container.querySelector('[aria-label="哔哩哔哩 平台"]')).not.toBeNull();
  });

  it('returns the selected mode and closes the menu', () => {
    const { container, onDownload } = renderCard();
    click(container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!);
    click(
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes('无音频视频'),
      )!,
    );

    expect(onDownload).toHaveBeenCalledOnce();
    expect(onDownload).toHaveBeenCalledWith('video');
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('renders linked clarity and codec listboxes and reports the exact quality id', () => {
    const { container, onQualityChange } = renderCard({
      selectedQualityId: 'quality-1080-avc',
      qualityOptions: [
        {
          id: 'quality-1080-avc',
          label: '1080P · AVC',
          detail: '1920×1080',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
        {
          id: 'quality-1080-hevc',
          label: '1080P · HEVC',
          detail: '1920×1080',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
        {
          id: 'quality-720-hevc',
          label: '720P · HEVC',
          detail: '1280×720',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
      ],
    });
    const clarity = container.querySelector<HTMLButtonElement>(
      'button[aria-label="测试视频 的清晰度"]',
    )!;
    const codec = container.querySelector<HTMLButtonElement>(
      'button[aria-label="测试视频 的视频编码"]',
    )!;
    expect(container.textContent).not.toContain('清晰度');
    expect(container.textContent).not.toContain('编码');
    expect(clarity.textContent).toContain('1080P');
    expect(codec.textContent).toContain('AVC');
    expect(container.querySelector('select')).toBeNull();

    click(clarity);
    const clarityOptions = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(
      clarityOptions.map(
        (option) => option.querySelector('.custom-select__option-copy strong')?.textContent,
      ),
    ).toEqual(['1080P', '720P']);
    click(clarityOptions[1]!);
    expect(onQualityChange).toHaveBeenCalledWith('quality-720-hevc');

    click(codec);
    const codecOptions = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(codecOptions.map((option) => option.textContent?.trim())).toEqual(['AVC', 'HEVC']);
    click(codecOptions[1]!);
    expect(onQualityChange).toHaveBeenCalledWith('quality-1080-hevc');
  });

  it('keeps an open selector mounted while a scan temporarily reports one choice', () => {
    const { container, root, onDownload, onQualityChange } = renderCard({
      selectedQualityId: 'quality-1080-avc',
      qualityOptions: [
        {
          id: 'quality-1080-avc',
          label: '1080P · AVC',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
        {
          id: 'quality-720-avc',
          label: '720P · AVC',
          completeAvailable: true,
          videoOnlyAvailable: true,
        },
      ],
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="测试视频 的清晰度"]')!;
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      root.render(
        <MediaProductCard
          title="测试视频"
          domain="bilibili.com"
          duration={96}
          selectedQuality="1080P"
          selectedQualityId="quality-1080-avc"
          qualityOptions={[
            {
              id: 'quality-1080-avc',
              label: '1080P · AVC',
              completeAvailable: true,
              videoOnlyAvailable: true,
            },
          ]}
          options={options}
          onQualityChange={onQualityChange}
          onDownload={onDownload}
        />,
      );
    });

    const currentTrigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="测试视频 的清晰度"]',
    )!;
    expect(currentTrigger).toBe(trigger);
    expect(currentTrigger.disabled).toBe(false);
    expect(currentTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('supports keyboard navigation, skips unavailable choices, and restores trigger focus', () => {
    const { container } = renderCard({
      options: [{ mode: 'complete' }, { mode: 'video', available: false }, { mode: 'audio' }],
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;

    trigger.focus();
    keydown(trigger, 'ArrowDown');
    const enabledItems = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    ];
    const disabledItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]:disabled');
    expect(document.activeElement).toBe(enabledItems[0]);
    expect(disabledItem?.textContent).toContain('当前资源暂不可用');

    keydown(enabledItems[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(enabledItems[1]);
    keydown(enabledItems[1]!, 'Escape');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside pointer input and locks the trigger while loading', () => {
    const { container, root } = renderCard();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    click(trigger);
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      root.render(
        <MediaProductCard
          title="测试视频"
          domain="bilibili.com"
          options={options}
          loading
          onDownload={vi.fn()}
        />,
      );
    });
    const loadingTrigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(loadingTrigger.disabled).toBe(true);
    expect(loadingTrigger.getAttribute('aria-label')).toContain('正在准备');
  });

  it('keeps composed inside input open and resolves keyboard focus inside a ShadowRoot', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.append(container);
    document.body.append(host);
    const root = createRoot(container);
    mountedRoots.add(root);
    act(() => {
      root.render(
        <MediaProductCard
          title="Shadow 视频"
          domain="youtube.com"
          options={options}
          onDownload={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    keydown(trigger, 'ArrowDown');
    const firstItem = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(shadow.activeElement).toBe(firstItem);
    expect(document.activeElement).toBe(host);

    act(() => {
      container
        .querySelector('.media-product-card__body')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
