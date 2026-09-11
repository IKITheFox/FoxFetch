import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomSelect } from '../../src/components/CustomSelect';
import { MediaCard } from '../../src/components/MediaCard';
import { SegmentedTrack } from '../../src/components/SegmentedTrack';
import { StatusDot } from '../../src/components/StatusDot';
import { ThemeCycleButton } from '../../src/components/ThemeSwitch';

const mountedRoots = new Set<Root>();

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  const root = createRoot(container);
  document.body.append(container);
  mountedRoots.add(root);
  act(() => root.render(node));
  return container;
}

function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function keydown(element: Element, key: string): void {
  act(() => element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })));
}

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
    mountedRoots.clear();
    document.body.replaceChildren();
  });
  vi.restoreAllMocks();
});

describe('shared UI controls', () => {
  it('uses an accessible custom listbox instead of a native select', async () => {
    const onChange = vi.fn();
    const container = mount(
      <CustomSelect
        value="avc"
        label="视频编码"
        onChange={onChange}
        options={[
          { value: 'avc', label: 'AVC' },
          { value: 'av1', label: 'AV1', disabled: true },
          { value: 'hevc', label: 'HEVC' },
        ]}
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="视频编码"]')!;
    expect(container.querySelector('select')).toBeNull();
    keydown(trigger, 'ArrowDown');
    await act(async () => Promise.resolve());

    const enabled = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
    ];
    expect(document.activeElement).toBe(enabled[0]);
    keydown(enabled[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(enabled[1]);
    keydown(enabled[1]!, 'Enter');
    expect(onChange).toHaveBeenCalledWith('hevc');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('preserves an open listbox, non-selected focus and scroll across equivalent option refreshes', async () => {
    const initialOptions = [
      { value: 'avc', label: 'AVC' },
      { value: 'av1', label: 'AV1', disabled: true },
      { value: 'hevc', label: 'HEVC' },
      { value: 'vp9', label: 'VP9' },
    ];
    function Harness() {
      const [options, setOptions] = useState(initialOptions);
      return (
        <>
          <button
            type="button"
            data-testid="refresh"
            onClick={() => setOptions(options.map((o) => ({ ...o })))}
          >
            刷新
          </button>
          <CustomSelect value="avc" label="视频编码" onChange={() => undefined} options={options} />
        </>
      );
    }

    const container = mount(<Harness />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="视频编码"]')!;
    keydown(trigger, 'ArrowDown');
    await act(async () => Promise.resolve());
    const selectedOption = document.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    )!;
    expect(selectedOption.closest('[role="listbox"]')?.parentElement).toBe(document.body);
    expect(selectedOption.closest('[role="listbox"]')).not.toBe(container);
    keydown(selectedOption, 'ArrowDown');

    const focusedBefore = document.activeElement as HTMLButtonElement;
    const listbox = document.querySelector<HTMLDivElement>('[role="listbox"]')!;
    expect(focusedBefore.textContent).toContain('HEVC');
    listbox.scrollTop = 73;

    click(container.querySelector('[data-testid="refresh"]')!);
    await act(async () => Promise.resolve());

    const focusedAfter = document.activeElement as HTMLButtonElement;
    expect(container.querySelector('.custom-select')?.getAttribute('data-open')).toBe('true');
    expect(focusedAfter).toBe(focusedBefore);
    expect(focusedAfter.textContent).toContain('HEVC');
    expect(focusedAfter.tabIndex).toBe(0);
    expect(listbox.scrollTop).toBe(73);
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      'AVC',
    );
  });

  it('reconciles focus and the effective selection when options become unavailable', async () => {
    function Harness() {
      const [options, setOptions] = useState([
        { value: 'a', label: '选项 A' },
        { value: 'b', label: '选项 B' },
        { value: 'c', label: '选项 C' },
      ]);
      return (
        <>
          <button
            type="button"
            data-testid="disable-c"
            onClick={() =>
              setOptions((current) =>
                current.map((option) =>
                  option.value === 'c' ? { ...option, disabled: true } : option,
                ),
              )
            }
          >
            禁用 C
          </button>
          <button
            type="button"
            data-testid="remove-b"
            onClick={() =>
              setOptions((current) => current.filter((option) => option.value !== 'b'))
            }
          >
            删除 B
          </button>
          <CustomSelect value="b" label="动态选项" onChange={() => undefined} options={options} />
        </>
      );
    }

    const container = mount(<Harness />);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="动态选项"]')!;
    keydown(trigger, 'ArrowDown');
    await act(async () => Promise.resolve());
    const selectedOption = document.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    )!;
    expect(selectedOption.textContent).toContain('选项 B');
    keydown(selectedOption, 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('选项 C');

    click(container.querySelector('[data-testid="disable-c"]')!);
    await act(async () => Promise.resolve());
    expect(document.activeElement?.textContent).toContain('选项 B');
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);

    click(container.querySelector('[data-testid="remove-b"]')!);
    await act(async () => Promise.resolve());
    expect(document.activeElement?.textContent).toContain('选项 A');
    expect(trigger.textContent).toContain('选项 A');
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      '选项 A',
    );
  });

  it('opens a custom listbox upward when the lower viewport has insufficient room', () => {
    const container = mount(
      <CustomSelect
        value="avc"
        label="视频编码"
        onChange={() => undefined}
        options={[
          { value: 'avc', label: 'AVC' },
          { value: 'av1', label: 'AV1' },
          { value: 'hevc', label: 'HEVC' },
        ]}
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('.custom-select__trigger')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 700,
      top: 700,
      right: 160,
      bottom: 738,
      left: 0,
      width: 160,
      height: 38,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 160,
        bottom: this.classList.contains('custom-select__listbox') ? 180 : 0,
        left: 0,
        width: 160,
        height: this.classList.contains('custom-select__listbox') ? 180 : 0,
        toJSON: () => ({}),
      };
    });

    click(trigger);
    expect(container.querySelector('.custom-select')?.getAttribute('data-placement')).toBe('top');
  });

  it('cycles one theme button through system, light and dark', () => {
    const onChange = vi.fn();
    const container = mount(<ThemeCycleButton value="auto" onChange={onChange} />);
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(button.getAttribute('aria-label')).toBe('当前主题：跟随系统');
    click(button);
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('renders one moving thumb and supports arrow-key tab selection', () => {
    const onChange = vi.fn();
    const container = mount(
      <SegmentedTrack
        value="all"
        label="媒体类型"
        onChange={onChange}
        options={[
          { value: 'all', label: '全部' },
          { value: 'video', label: '视频' },
          { value: 'image', label: '图片' },
          { value: 'audio', label: '音频' },
        ]}
      />,
    );
    expect(container.querySelectorAll('.segmented-track__thumb')).toHaveLength(1);
    const selected = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]',
    )!;
    keydown(selected, 'ArrowRight');
    expect(onChange).toHaveBeenCalledWith('video');
  });

  it('exposes status meaning independently from color', () => {
    const container = mount(<StatusDot tone="error" label="更新失败" />);
    const status = container.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-label')).toBe('更新失败');
    expect(status.classList.contains('status-dot--error')).toBe(true);
  });

  it('keeps an icon-only semantic status accessible without visible copy', () => {
    const container = mount(<StatusDot tone="ready" label="识别成功" iconOnly />);
    const status = container.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-label')).toBe('识别成功');
    expect(status.textContent).toBe('');
    expect(status.classList.contains('status-dot--icon-only')).toBe(true);
  });

  it('keeps ordinary media cards compact and exposes source details on demand', () => {
    const container = mount(
      <MediaCard
        compact
        asset={{
          id: 'image-1',
          kind: 'image',
          url: 'https://i.example.test/assets/cover.png',
          pageUrl: 'https://example.test/watch',
          pageTitle: '示例页面',
          filename: 'cover.png',
          extension: 'png',
          width: 640,
          height: 360,
          size: 24_576,
          downloadable: true,
          detectedBy: ['dom'],
          discoveredAt: 1,
          frameId: 0,
        }}
      />,
    );

    expect(container.querySelector('.media-card__host')).toBeNull();
    expect(container.querySelector('.media-card__meta')).toBeNull();
    expect(container.querySelector('.media-card__type')?.textContent).toBe('PNG');
    const info = container.querySelector<HTMLButtonElement>('.media-card__info')!;
    expect(info.getAttribute('aria-describedby')).toBeTruthy();
    act(() => info.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      '来源 i.example.test · PNG · 640×360 · 24.0 KB',
    );
  });
});
