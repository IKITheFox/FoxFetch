import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackRateSlider } from '../../src/components/PlaybackRateSlider';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('PlaybackRateSlider', () => {
  it('retains a historical low value without writing it back or adding preset controls', () => {
    const onChange = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<PlaybackRateSlider id="rate" value={0.0625} onChange={onChange} />));
    expect(host.querySelector('output')?.textContent).toBe('0.0625×');
    expect(host.querySelector('input')?.getAttribute('aria-valuetext')).toBe('0.0625 倍速');
    expect(host.querySelectorAll('button,input[type="number"]')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    act(() => root!.render(<PlaybackRateSlider id="rate" value={1.25} onChange={onChange} />));
    expect(host.querySelector('output')?.textContent).toBe('1.25×');
    expect(host.querySelector('input')?.value).toBe('1.25');
    expect(onChange).not.toHaveBeenCalled();
  });
});
