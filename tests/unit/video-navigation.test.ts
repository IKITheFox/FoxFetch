import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectVideoNavigation, navigateVideo } from '../../src/modules/playback/video-navigation';

const originalUrl = Object.getOwnPropertyDescriptor(document, 'URL');
const CURRENT = 'https://www.bilibili.com/video/BV1CURRENT1/';
const NEXT = 'https://www.bilibili.com/video/BV1NEXTVIDEO2/';

function setUrl(url: string): void {
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
}

function visible(element: HTMLElement): HTMLElement {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 40,
    bottom: 40,
    width: 40,
    height: 40,
    toJSON: () => ({}),
  });
  return element;
}

function nativeControl(direction: 'prev' | 'next'): HTMLElement {
  const player = document.createElement('div');
  player.id = 'bilibili-player';
  const button = document.createElement('button');
  button.className = `bpx-player-ctrl-${direction}`;
  player.append(button);
  document.body.append(player);
  return visible(button);
}

function observedPod(activeIndex = 1): HTMLElement[] {
  document.body.innerHTML = `<div class="video-pod"><div class="video-pod__list section">${[0, 1, 2]
    .map(
      (index) =>
        `<div class="pod-item video-pod__item simple"><div class="single-p"><div class="simple-base-item normal${index === activeIndex ? ' active' : ''}"><div class="title">episode</div></div></div></div>`,
    )
    .join('')}</div></div>`;
  visible(document.querySelector('.video-pod__list')! as HTMLElement);
  const player = document.createElement('div');
  player.id = 'bilibili-player';
  const video = visible(document.createElement('video')) as HTMLVideoElement;
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
  Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
  player.append(video);
  document.body.append(player);
  return [...document.querySelectorAll<HTMLElement>('.simple-base-item')].map(visible);
}

beforeEach(() => {
  setUrl(CURRENT);
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
});
afterEach(() => {
  document.body.replaceChildren();
  if (originalUrl) Object.defineProperty(document, 'URL', originalUrl);
  else Reflect.deleteProperty(document, 'URL');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('verified Bilibili video navigation', () => {
  it('distinguishes no ordered queue, page initialization and an unrecognized list', () => {
    document.body.innerHTML = `<div class="recommend-list"><a href="${NEXT}">recommended</a></div>`;
    expect(inspectVideoNavigation(document, 'next')).toMatchObject({
      available: false,
      code: 'no-ordered-list',
    });
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    expect(inspectVideoNavigation(document, 'next').code).toBe('initializing');
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    document.body.innerHTML = '<div class="video-pod"><div class="new-layout">unknown</div></div>';
    expect(inspectVideoNavigation(document, 'next').code).toBe('unrecognized-structure');
  });

  it('rejects competing native players instead of choosing the first control', async () => {
    const first = nativeControl('next');
    const second = nativeControl('next');
    const clicks = [vi.spyOn(first, 'click'), vi.spyOn(second, 'click')];
    expect((await navigateVideo(document, 'next')).code).toBe('unrecognized-structure');
    for (const click of clicks) expect(click).not.toHaveBeenCalled();
  });

  it('does not mistake a nested player root for two native controls', async () => {
    const button = nativeControl('next');
    const nested = document.createElement('div');
    nested.className = 'bpx-player-container';
    button.parentElement!.append(nested);
    nested.append(button);
    button.addEventListener('click', () => setUrl(NEXT));
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
  });

  it('refuses native-looking controls in recommendations and transparent preload players', () => {
    const button = nativeControl('next');
    button.parentElement!.classList.add('recommend-list');
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    button.parentElement!.classList.remove('recommend-list');
    button.parentElement!.style.opacity = '0';
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
  });

  it('rejects duplicate matching link lists, even when both target the same video', async () => {
    const list = `<div class="video-pod__list"><div class="video-pod__item active"><a href="${CURRENT}">current</a></div><div class="video-pod__item"><a href="${NEXT}">next</a></div></div>`;
    document.body.innerHTML = list + list;
    const targets = [...document.querySelectorAll<HTMLAnchorElement>('a')].map(visible);
    const clicks = targets.map((target) => vi.spyOn(target, 'click'));
    expect((await navigateVideo(document, 'next')).code).toBe('unrecognized-structure');
    for (const click of clicks) expect(click).not.toHaveBeenCalled();
  });

  it('selects the adjacent inner part instead of skipping to the next collection episode', async () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><a href="${CURRENT}">episode</a><div class="multi-p"><ol><li class="active"><a href="${CURRENT}?p=1">P1</a></li><li><a href="${CURRENT}?p=2">P2</a></li></ol></div></div><div class="video-pod__item"><a href="${NEXT}">next episode</a></div></div>`;
    const target = visible(document.querySelectorAll<HTMLAnchorElement>('ol a')[1]!);
    const outer = vi.spyOn(
      document.querySelector<HTMLAnchorElement>(`a[href="${NEXT}"]`)!,
      'click',
    );
    target.addEventListener('click', (event) => {
      event.preventDefault();
      setUrl(`${CURRENT}?p=2`);
    });
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
    expect(outer).not.toHaveBeenCalled();
    expect((await navigateVideo(document, 'next')).code).toBe('unrecognized-structure');
  });

  it('keeps the inner part boundary instead of falling through to another episode', async () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><div class="multi-p"><ul><li class="active"><a href="${CURRENT}">P1</a></li></ul></div></div><div class="video-pod__item"><a href="${NEXT}">next episode</a></div></div>`;
    visible(document.querySelector<HTMLAnchorElement>(`a[href="${NEXT}"]`)!);
    expect((await navigateVideo(document, 'next')).code).toBe('boundary');
  });

  it('refuses an inner part queue with gaps or foreign video identities', async () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><div class="multi-p"><ol><li class="active"><a href="${CURRENT}">P1</a></li><li><a href="${CURRENT}?p=3">P3</a></li></ol></div></div></div>`;
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('ol a')[1]!);
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    next.setAttribute('href', NEXT);
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
  });

  it('re-resolves replaced DOM and active identity on every gesture', async () => {
    const original = nativeControl('next');
    const oldClick = vi.spyOn(original, 'click');
    expect(inspectVideoNavigation(document, 'next').available).toBe(true);
    original.remove();
    const fresh = nativeControl('next');
    fresh.addEventListener('click', () => setUrl(NEXT));
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
    expect(oldClick).not.toHaveBeenCalled();
  });

  it('reports a not-yet-ready main video as initialization, without queuing a later click', () => {
    document.body.innerHTML = '<div id="bilibili-player"><video></video></div>';
    const main = visible(document.querySelector('video')!);
    expect(inspectVideoNavigation(document, 'next').code).toBe('initializing');
    Object.defineProperty(main, 'readyState', { configurable: true, value: 4 });
    expect(inspectVideoNavigation(document, 'next').code).toBe('no-ordered-list');
  });

  it('rejects a link whose ordered row is disabled and accepts a freshly enabled row', () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><a href="${CURRENT}">current</a></div><div class="video-pod__item" aria-disabled="true"><a href="${NEXT}">next</a></div></div>`;
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('a')[1]!);
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    next.parentElement!.removeAttribute('aria-disabled');
    expect(inspectVideoNavigation(document, 'next').available).toBe(true);
  });

  it('uses an enabled native next button and verifies route identity changed', async () => {
    const button = nativeControl('next');
    button.addEventListener('click', () => setUrl(NEXT));
    expect(inspectVideoNavigation(document, 'next')).toEqual({ available: true });
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
  });

  it('supports the native previous button without cycling media elements', async () => {
    const button = nativeControl('prev');
    document.body.append(document.createElement('video'), document.createElement('video'));
    button.addEventListener('click', () => setUrl(NEXT));
    expect(await navigateVideo(document, 'previous')).toEqual({ applied: true });
  });

  it('refuses disabled, hidden and unrelated controls', async () => {
    const button = nativeControl('next');
    button.setAttribute('aria-disabled', 'true');
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    button.removeAttribute('aria-disabled');
    button.style.display = 'none';
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    button.parentElement!.remove();
    document.body.append(button);
    button.style.display = '';
    expect((await navigateVideo(document, 'next')).applied).toBe(false);
  });

  it('selects only the adjacent part in an explicit ordered multipart list', async () => {
    document.body.innerHTML =
      '<div class="multi-page"><ul class="cur-list"><li class="on"><a href="/video/BV1CURRENT1/?p=1">P1</a></li><li><a href="/video/BV1CURRENT1/?p=2">P2</a></li></ul></div>';
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('a')[1]!);
    next.addEventListener('click', (event) => {
      event.preventDefault();
      setUrl(`${CURRENT}?p=2`);
    });
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
  });

  it('supports a verified adjacent collection item', async () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><a href="${CURRENT}">current</a></div><div class="video-pod__item"><a href="${NEXT}">next</a></div></div>`;
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('a')[1]!);
    next.addEventListener('click', (event) => {
      event.preventDefault();
      setUrl(NEXT);
    });
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
  });

  it.each(['next', 'previous'] as const)(
    'uses the observed div collection %s action with its nested active marker',
    async (direction) => {
      const actions = observedPod();
      const adjacent = actions[direction === 'next' ? 2 : 0]!;
      const currentClick = vi.spyOn(actions[1]!, 'click');
      adjacent.addEventListener('click', () => setUrl(NEXT));
      expect(inspectVideoNavigation(document, direction)).toEqual({ available: true });
      expect(await navigateVideo(document, direction)).toEqual({ applied: true });
      expect(currentClick).not.toHaveBeenCalled();
    },
  );

  it('does not treat a div collection click without a changed video identity as success', async () => {
    vi.useFakeTimers();
    const actions = observedPod();
    const click = vi.fn(() => setUrl(`${CURRENT}?cid=222&spm_id_from=changed`));
    actions[2]!.addEventListener('click', click);
    const pending = navigateVideo(document, 'next');
    await vi.advanceTimersByTimeAsync(2_050);
    expect((await pending).applied).toBe(false);
    expect(click).toHaveBeenCalledOnce();
  });

  it('requires one visible explicit pod and a unique active row', async () => {
    const actions = observedPod();
    actions[0]!.classList.add('active');
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    actions[0]!.classList.remove('active');
    const duplicate = document.querySelector('.video-pod')!.cloneNode(true) as HTMLElement;
    document.body.append(duplicate);
    visible(duplicate.querySelector('.video-pod__list')! as HTMLElement);
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    duplicate.remove();
    document.querySelector<HTMLElement>('.video-pod__list')!.hidden = true;
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
  });

  it('refuses div-shaped recommendations, disabled targets and multipart expansion headers', async () => {
    const actions = observedPod();
    actions[2]!.setAttribute('aria-disabled', 'true');
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    actions[2]!.removeAttribute('aria-disabled');
    actions[2]!.parentElement!.className = 'multi-p';
    actions[2]!.className = 'simple-base-item head';
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
    actions[2]!.parentElement!.className = 'single-p';
    actions[2]!.className = 'simple-base-item normal';
    document.querySelector('.video-pod')!.className = 'recommend-list';
    expect(inspectVideoNavigation(document, 'next').available).toBe(false);
  });

  it('reports the observed collection boundary without wrapping', async () => {
    observedPod(2);
    const result = await navigateVideo(document, 'next');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('最后');
  });

  it('does not dispatch or queue a div action before the document and main media are ready', async () => {
    const actions = observedPod();
    const click = vi.spyOn(actions[2]!, 'click');
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive');
    expect((await navigateVideo(document, 'next')).reason).toContain('初始化');
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'readyState', { configurable: true, value: 0 });
    expect((await navigateVideo(document, 'next')).reason).toContain('初始化');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    Object.defineProperty(video, 'duration', { configurable: true, value: Number.NaN });
    expect((await navigateVideo(document, 'next')).reason).toContain('初始化');
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 });
    expect(inspectVideoNavigation(document, 'next').available).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'transparent', 'outside-player'] as const)(
    'does not use a %s preload video to unlock an SSR div collection',
    async (mode) => {
      observedPod();
      const video = document.querySelector('video')!;
      if (mode === 'hidden') video.hidden = true;
      if (mode === 'transparent') video.parentElement!.style.opacity = '0';
      if (mode === 'outside-player') video.parentElement!.removeAttribute('id');
      expect((await navigateVideo(document, 'next')).reason).toContain('初始化');
    },
  );

  it('matches multipart links that omit CID against a current URL that includes it', async () => {
    setUrl(`${CURRENT}?cid=111`);
    document.body.innerHTML = `<div class="multi-page"><ul class="cur-list"><li class="on"><a href="${CURRENT}?p=1">P1</a></li><li><a href="${CURRENT}?p=2">P2</a></li></ul></div>`;
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('a')[1]!);
    next.addEventListener('click', (event) => {
      event.preventDefault();
      setUrl(`${CURRENT}?p=2&cid=222`);
    });
    expect(await navigateVideo(document, 'next')).toEqual({ applied: true });
  });

  it('reports an unexpected destination instead of claiming the adjacent item was opened', async () => {
    document.body.innerHTML = `<div class="video-pod__list"><div class="video-pod__item active"><a href="${CURRENT}">current</a></div><div class="video-pod__item"><a href="${NEXT}">next</a></div></div>`;
    const next = visible(document.querySelectorAll<HTMLAnchorElement>('a')[1]!);
    next.addEventListener('click', (event) => {
      event.preventDefault();
      setUrl('https://www.bilibili.com/video/BV1UNEXPECTED3/');
    });
    expect((await navigateVideo(document, 'next')).reason).toContain('其他视频');
  });

  it('reports the list boundary and does not guess an arbitrary recommendation', async () => {
    document.body.innerHTML = `<div class="multi-page"><ul class="cur-list"><li class="on"><a href="${CURRENT}">only part</a></li></ul></div><div class="recommend-list"><a href="${NEXT}">recommended</a></div>`;
    const recommendation = visible(document.querySelector('.recommend-list a')! as HTMLElement);
    const click = vi.spyOn(recommendation, 'click');
    const result = await navigateVideo(document, 'next');
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('最后');
    expect(click).not.toHaveBeenCalled();
  });

  it('rejects ambiguous/stale active lists and foreign-site links', async () => {
    document.body.innerHTML = `<div class="multi-page"><ul class="cur-list"><li class="on"><a href="${NEXT}">stale</a></li><li><a href="https://example.com/video/BV1OTHER">other</a></li></ul></div>`;
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a')) visible(link);
    expect((await navigateVideo(document, 'next')).applied).toBe(false);
    document.querySelector<HTMLAnchorElement>('a')!.href = CURRENT;
    expect((await navigateVideo(document, 'next')).applied).toBe(false);
  });

  it('does not report success for a tracking-query change, and prevents concurrent dispatch', async () => {
    vi.useFakeTimers();
    const button = nativeControl('next');
    const click = vi.fn(() => setUrl(`${CURRENT}?spm_id_from=changed`));
    button.addEventListener('click', click);
    const pending = navigateVideo(document, 'next');
    expect((await navigateVideo(document, 'next')).reason).toContain('正在切换');
    await vi.advanceTimersByTimeAsync(2_050);
    expect((await pending).applied).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('waits for delayed site navigation', async () => {
    vi.useFakeTimers();
    const button = nativeControl('next');
    button.addEventListener('click', () => {
      window.setTimeout(() => setUrl(NEXT), 150);
    });
    const result = navigateVideo(document, 'next');
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual({ applied: true });
  });

  it('does not claim generic or impersonating hosts are supported', async () => {
    nativeControl('next');
    setUrl('https://bilibili.com.example.org/video/BV1CURRENT1/');
    expect((await navigateVideo(document, 'next')).reason).toContain('此站点');
    setUrl('https://www.bilibili.com/');
    expect((await navigateVideo(document, 'next')).applied).toBe(false);
  });
});
