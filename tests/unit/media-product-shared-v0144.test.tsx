import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MediaProductArtwork } from '../../src/components/MediaProductArtwork';
import { MediaProductLayout } from '../../src/components/MediaProductLayout';
import { YouTubeInspectionCard } from '../../src/components/YouTubeInspectionCard';
import type { YouTubeInspection } from '../../src/modules/youtube/inspection';

const roots: Root[] = [];
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
}

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('shared resource presentation v0.14.4', () => {
  it('cleans up mounted React selectors on video changes and panel closure without React errors', async () => {
    const { host, root } = mount();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true, data: null })) },
    });
    const errors = vi.spyOn(console, 'error');
    const view: YouTubeInspection = {
      version: 1,
      pageType: 'watch',
      videoId: 'abcdefghijk',
      status: 'identified',
      transports: ['sabr'],
      completeDownloadVerified: false,
      candidates: [
        {
          id: 'vp9-track',
          kind: 'video',
          composition: 'separate',
          mime: 'video/webm; codecs="vp9"',
          width: 1920,
          height: 1080,
          fps: 60,
          dynamicRange: 'unknown',
          source: 'unavailable',
        },
      ],
    };
    try {
      await act(async () => root.render(<YouTubeInspectionCard view={view} tabId={88} />));
      expect(
        host.querySelectorAll('.media-product-card__quality-grid [aria-haspopup="listbox"]'),
      ).toHaveLength(2);
      await act(async () =>
        root.render(
          <YouTubeInspectionCard view={{ ...view, videoId: 'zyxwvutsrqp' }} tabId={88} />,
        ),
      );
      expect(
        host.querySelectorAll('.media-product-card__quality-grid [aria-haspopup="listbox"]'),
      ).toHaveLength(2);
      await act(async () => root.render(null));
      expect(host.childElementCount).toBe(0);
      expect(errors.mock.calls).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps layout slots, card ref and menu as direct children without owning selection', () => {
    const { host, root } = mount();
    let card: HTMLElement | null = null;
    const choose = vi.fn();
    act(() =>
      root.render(
        <MediaProductLayout
          cardRef={(node) => {
            card = node;
          }}
          titleId="fixture-title"
          busy
          menuOpen
          hasQualityPicker
          artwork={<div data-slot="artwork" />}
          actions={<button onClick={choose}>下载</button>}
          menu={<div role="menu" />}
        >
          <strong id="fixture-title">资源标题</strong>
          <select defaultValue="vp9" aria-label="编码">
            <option value="avc">AVC</option>
            <option value="vp9">VP9</option>
          </select>
        </MediaProductLayout>,
      ),
    );
    const article = host.querySelector('article')!;
    expect(card).toBe(article);
    expect(article.getAttribute('aria-busy')).toBe('true');
    expect(article.classList.contains('is-menu-open')).toBe(true);
    expect(article.classList.contains('has-quality-picker')).toBe(true);
    expect(
      Array.from(article.children).map(
        (child) =>
          child.getAttribute('class') ??
          child.getAttribute('data-slot') ??
          child.getAttribute('role'),
      ),
    ).toEqual(['artwork', 'media-product-card__body', 'media-product-card__actions', 'menu']);
    expect(host.querySelector('select')!.value).toBe('vp9');
    act(() => host.querySelector('button')!.click());
    expect(choose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('select')!.value).toBe('vp9');
  });

  it.each(['youtube', 'bilibili'])(
    'keeps %s artwork fallback and retries only a new generation',
    (source) => {
      const { host, root } = mount();
      const render = (artworkKey: string, duration: number | string = 96) =>
        act(() =>
          root.render(
            <MediaProductArtwork
              source={source}
              poster="https://example.test/cover.jpg"
              artworkKey={artworkKey}
              duration={duration}
            />,
          ),
        );
      render('first');
      const image = host.querySelector('img')!;
      expect(host.querySelector('.media-product-card__duration')?.textContent).toBe('1:36');
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
      act(() => image.dispatchEvent(new Event('error')));
      render('first');
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('.platform-logo')).not.toBeNull();
      render('second', ' 2:00 ');
      expect(host.querySelector('img')).not.toBeNull();
      expect(host.querySelector('.media-product-card__duration')?.textContent).toBe('2:00');
      render('second', NaN);
      expect(host.querySelector('.media-product-card__duration')).toBeNull();
    },
  );

  it('uses shared artwork/title without duplicating the legacy header or implying verified output', () => {
    const { host, root } = mount();
    const view: YouTubeInspection = {
      version: 1,
      pageType: 'watch',
      videoId: 'abcdefghijk',
      title: '<img src=x onerror=alert(1)>',
      thumbnail: 'https://example.test/cover.jpg',
      duration: 96,
      status: 'identified',
      transports: ['sabr'],
      candidates: [],
      completeDownloadVerified: false,
    };
    act(() => root.render(<YouTubeInspectionCard view={view} tabId={77} />));
    expect(host.querySelectorAll('.media-product-card__preview')).toHaveLength(1);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('h3')).toBeNull();
    expect(host.querySelector('.media-product-card__title-row strong')?.textContent).toBe(
      view.title,
    );
    expect(host.querySelector('.status-dot--partial')).not.toBeNull();
    expect(host.querySelector('.status-dot--ready')).toBeNull();
    act(() =>
      root.render(
        <YouTubeInspectionCard
          view={{ ...view, videoId: 'zyxwvutsrqp', title: '下一个视频' }}
          tabId={77}
        />,
      ),
    );
    expect(host.querySelector('.media-product-card__title-row strong')?.textContent).toBe(
      '下一个视频',
    );
    expect(host.textContent).not.toContain('abcdefghijk');
  });
});
