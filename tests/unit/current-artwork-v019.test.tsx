import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { CurrentVideoArtwork } from '../../src/components/CurrentVideoArtwork';
import { youtubeUiState } from '../fixtures/youtube-v01417';
import { cacheFailureMessage } from '../../src/modules/resolver/cache-failure-message';

it('updates late YouTube artwork, isolates failures and rejects a different route', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const state = youtubeUiState();
  const thumbnail = state.youtube!.thumbnail!;
  const paint = async () =>
    act(async () => root.render(<CurrentVideoArtwork state={state} source={state.pageUrl} />));
  delete state.youtube!.thumbnail;
  await paint();
  expect(host.querySelector('img.current-video-artwork__image')).toBeNull();
  state.youtube!.thumbnail = thumbnail;
  await paint();
  const old = host.querySelector('img')!;
  expect(old.getAttribute('src')).toBe(thumbnail);
  state.youtube!.thumbnail = 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg';
  await paint();
  await act(async () => old.dispatchEvent(new Event('error')));
  expect(host.querySelector('img')!.getAttribute('src')).toContain('mqdefault');
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  await paint();
  expect(host.querySelector('.current-video-artwork__image')).toBeNull();
  state.pageUrl = 'https://www.youtube.com/watch?v=12345678901';
  await paint();
  expect(host.querySelector('.current-video-artwork__image')).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

it('does not promise saving for empty or unverified retained cache', () => {
  expect(cacheFailureMessage('后台缓存程序授权超时。', 0)).toBe(
    '后台缓存程序授权超时。 暂无可下载的缓存。',
  );
  expect(cacheFailureMessage('写入失败', 1024)).toContain('1 KB');
  expect(cacheFailureMessage('写入失败', 1024)).not.toContain('仍可');
  expect(cacheFailureMessage('写入失败', NaN)).toContain('暂无可下载');
});
