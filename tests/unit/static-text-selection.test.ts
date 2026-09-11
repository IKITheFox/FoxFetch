import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installStaticTextSelectionGuard,
  installShadowStaticTextSelectionGuard,
} from '../../src/modules/ui/static-text-selection';

let dispose: () => void;

function pointer(target: Element, type: string, x = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x }));
}

function select(target: Element): void {
  const range = document.createRange();
  range.selectNodeContents(target);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

function click(target: Element, detail = 1): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML =
    '<main class="app-shell" contenteditable="false"><button><span>下载视频</span></button><label><span>选项说明</span><input type="checkbox"></label><input type="search"></main><div class="custom-select__listbox--portal"><button><span>杜比视界</span></button></div><button id="outside">网页文字</button>';
  dispose = installStaticTextSelectionGuard(document);
});

afterEach(() => {
  dispose();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('static text selection without accidental activation', () => {
  it('protects the explicit static directory-dialog scope', () => {
    const dialog = document.createElement('main');
    dialog.dataset.staticUi = '';
    dialog.innerHTML = '<button><span>选择自定义目录</span></button>';
    document.body.append(dialog);
    const text = dialog.querySelector('span')!;
    pointer(text, 'pointerdown');
    pointer(text, 'pointerup', 20);
    select(text);
    expect(click(text).defaultPrevented).toBe(true);
  });

  it.each(['.app-shell button', '.custom-select__listbox--portal button', '.app-shell label'])(
    'suppresses only the click completing a text drag in %s',
    (selector) => {
      const button = document.querySelector(selector)!;
      const text = button.querySelector('span')!;
      const action = vi.fn();
      button.addEventListener('click', action);
      pointer(text, 'pointerdown');
      pointer(text, 'pointermove', 20);
      select(text);
      pointer(text, 'pointerup', 20);
      expect(click(text).defaultPrevented).toBe(true);
      expect(action).not.toHaveBeenCalled();
      expect(document.getSelection()?.toString()).toBe(text.textContent);
      const copy = new Event('copy', { bubbles: true, cancelable: true });
      text.dispatchEvent(copy);
      expect(copy.defaultPrevented).toBe(false);
    },
  );

  it('preserves normal and keyboard activation when text was already selected', () => {
    const button = document.querySelector('.app-shell button')!;
    select(button);
    pointer(button, 'pointerdown');
    expect(click(button).defaultPrevented).toBe(false);
    pointer(button, 'pointerdown');
    expect(click(button, 0).defaultPrevented).toBe(false);
  });

  it('does not cancel a pointer drag with no selection', () => {
    const button = document.querySelector('.app-shell button')!;
    pointer(button, 'pointerdown');
    pointer(button, 'pointerup', 20);
    expect(click(button).defaultPrevented).toBe(false);
  });

  it('suppresses dragging over the same already-selected label again', () => {
    const text = document.querySelector('.app-shell button span')!;
    select(text);
    pointer(text, 'pointerdown');
    pointer(text, 'pointerup', 20);
    select(text);
    expect(click(text).defaultPrevented).toBe(true);
  });

  it('protects double-click text selection without blocking a first ordinary click', () => {
    const button = document.querySelector('.app-shell button')!;
    pointer(button, 'pointerdown');
    expect(click(button).defaultPrevented).toBe(false);
    pointer(button, 'pointerdown');
    select(button);
    expect(click(button, 2).defaultPrevented).toBe(true);
  });

  it('never intercepts real inputs or outside page content', () => {
    for (const selector of ['input[type="search"]', '#outside']) {
      const target = document.querySelector(selector)!;
      pointer(target, 'pointerdown');
      pointer(target, 'pointerup', 20);
      select(document.querySelector('.app-shell button')!);
      expect(click(target).defaultPrevented).toBe(false);
    }
  });

  it.each(['pointercancel', 'blur', 'dispose'])('clears stale gesture state on %s', (end) => {
    const button = document.querySelector('.app-shell button')!;
    pointer(button, 'pointerdown');
    pointer(button, 'pointerup', 20);
    select(button);
    if (end === 'dispose') dispose();
    else if (end === 'blur') window.dispatchEvent(new Event('blur'));
    else pointer(button, end);
    expect(click(button).defaultPrevented).toBe(false);
  });
});

describe('shadow static text selection boundary', () => {
  it.each(['button', 'summary'])(
    'uses the shadow selection to suppress an accidental %s activation',
    (tag) => {
      const host = document.createElement('div');
      document.body.append(host);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<${tag}><span>可复制的静态文字</span></${tag}>`;
      const text = shadow.querySelector('span')!;
      let selected = false;
      // jsdom does not implement Chrome's shadow selection API. Exercise the
      // boundary with its API shape; actual drag/copy belongs in browser E2E.
      Object.defineProperty(shadow, 'getSelection', {
        value: () =>
          selected
            ? {
                isCollapsed: false,
                anchorNode: text.firstChild,
                anchorOffset: 0,
                focusNode: text.firstChild,
                focusOffset: text.textContent!.length,
                toString: () => text.textContent,
              }
            : null,
      });
      const disposeShadow = installShadowStaticTextSelectionGuard(shadow);
      const action = vi.fn();
      text.parentElement!.addEventListener('click', action);
      pointer(text, 'pointerdown');
      pointer(text, 'pointerup', 20);
      selected = true;
      expect(click(text).defaultPrevented).toBe(true);
      expect(action).not.toHaveBeenCalled();
      pointer(text, 'pointerdown');
      expect(click(text).defaultPrevented).toBe(false);
      pointer(text, 'pointerdown');
      expect(click(text, 0).defaultPrevented).toBe(false);
      expect(action).toHaveBeenCalledTimes(2);
      disposeShadow();
    },
  );
});
