import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISCLOSURE_ICON,
  FloatingDisclosureAnimator,
} from '../../src/modules/playback/floating-disclosure';

let details: HTMLDetailsElement;
let summary: HTMLElement;
let body: HTMLElement;
let animator: FloatingDisclosureAnimator;
let layout: ReturnType<typeof vi.fn<() => void>>;
let visualHeight: number | undefined;
const animations: Array<{
  cancel: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: () => void;
  frames: Keyframe[];
}> = [];

function installAnimation() {
  Object.defineProperty(body, 'animate', {
    configurable: true,
    value: vi.fn((frames: Keyframe[]) => {
      let resolve!: () => void;
      let reject!: () => void;
      const finished = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = () => no(new DOMException('cancelled', 'AbortError'));
      });
      const cancel = vi.fn(() => {
        visualHeight = undefined;
        reject();
      });
      animations.push({ cancel, resolve, reject, frames });
      return { finished, cancel } as unknown as Animation;
    }),
  });
}

beforeEach(() => {
  document.body.innerHTML = '<details><summary>更多选项</summary><div>实际内容</div></details>';
  details = document.querySelector('details')!;
  summary = details.querySelector('summary')!;
  body = details.querySelector('div')!;
  visualHeight = undefined;
  animations.length = 0;
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => ({
    width: 300,
    height: visualHeight ?? (body.style.height ? Number.parseFloat(body.style.height) : 100),
    x: 0,
    y: 0,
    top: 0,
    bottom: 100,
    left: 0,
    right: 300,
    toJSON: () => ({}),
  }));
  layout = vi.fn();
  animator = new FloatingDisclosureAnimator(window, layout);
});
afterEach(async () => {
  animator.finish();
  await Promise.resolve();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('floating disclosure animation state and cleanup', () => {
  it('uses fixed-endpoint arrow geometry instead of a rotated character', () => {
    summary.innerHTML = DISCLOSURE_ICON;
    expect(summary.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(summary.querySelector('path')?.getAttribute('d')).toBe('M5 12 L12 18 L19 12');
    expect(summary.textContent).toBe('');
  });

  it('reverses twice from the rendered intermediate height and ignores a stale completion', async () => {
    installAnimation();
    animator.toggle(details);
    expect(animations[0]!.frames).toEqual([{ height: '0px' }, { height: '100px' }]);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    visualHeight = 42;
    animations[0]!.resolve();
    animator.toggle(details);
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(animations[1]!.frames).toEqual([{ height: '42px' }, { height: '0px' }]);
    await Promise.resolve();
    expect(details.open).toBe(true);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    visualHeight = 17;
    animator.toggle(details);
    expect(animations[1]!.cancel).toHaveBeenCalledOnce();
    expect(animations[2]!.frames).toEqual([{ height: '17px' }, { height: '100px' }]);
    animations[2]!.resolve();
    await Promise.resolve();
    expect(details.open).toBe(true);
    expect(details.dataset.expanded).toBe('true');
    expect(body.style.height).toBe('');
    expect(body.style.overflow).toBe('');
  });

  it('finishes an active close at its intended terminal state and clears temporary geometry once', async () => {
    installAnimation();
    details.open = true;
    animator.toggle(details);
    expect(details.open).toBe(true);
    expect(body.style.overflow).toBe('clip');
    animator.finish();
    expect(details.open).toBe(false);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(body.style.height).toBe('');
    expect(body.style.overflow).toBe('');
    const layoutCalls = layout.mock.calls.length;
    animator.finish();
    animations[0]!.resolve();
    await Promise.resolve();
    expect(layout).toHaveBeenCalledTimes(layoutCalls);
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it('settles immediately without animation under reduced motion', () => {
    installAnimation();
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    animator.toggle(details);
    expect(details.open).toBe(true);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(body.animate).not.toHaveBeenCalled();
    animator.toggle(details);
    expect(details.open).toBe(false);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(body.style.height).toBe('');
    expect(body.style.overflow).toBe('');
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('retains working native details state when Web Animations is unavailable', () => {
    animator.toggle(details);
    expect(details.open).toBe(true);
    animator.toggle(details);
    expect(details.open).toBe(false);
    expect(layout).toHaveBeenCalledTimes(2);
  });

  it('does not fabricate expansion when a disclosure has no content body', () => {
    body.remove();
    animator.toggle(details);
    expect(details.open).toBe(false);
    expect(layout).not.toHaveBeenCalled();
  });
});
