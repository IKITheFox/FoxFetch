import { expect, it } from 'vitest';
import { buildYouTubeOutputFilename } from '../../src/modules/youtube/output-filename';
const id = 'abcdefghijk';
it('uses the title and actual extension, distinguishing separately saved tracks', () => {
  expect(buildYouTubeOutputFilename(id, 'video.webm', 'merged', '我的视频.mp4')).toBe(
    `FoxFetch/YouTube/我的视频.mp4.webm`,
  );
  expect(buildYouTubeOutputFilename(id, 'video.mp4', 'video', '视频标题')).toBe(
    `FoxFetch/YouTube/视频标题-视频.mp4`,
  );
  expect(buildYouTubeOutputFilename(id, 'audio.m4a', 'audio', '视频标题')).toBe(
    `FoxFetch/YouTube/视频标题-音频.m4a`,
  );
});
it.each(['CON', 'con.txt', 'LPT1', 'COM¹', 'aux'])('avoids reserved Windows names: %s', (title) => {
  expect(buildYouTubeOutputFilename(id, 'video.mp4', 'merged', title).split('/').at(-1)).toMatch(
    /^_/u,
  );
});
it('keeps traversal, controls and misleading direction marks out of the path', () => {
  const name = buildYouTubeOutputFilename(
    id,
    'video.webm',
    'merged',
    '../../evil\\..\u202e\u0000 : * ?. ',
  );
  expect(name.split('/')).toHaveLength(3);
  expect(name.split('/').at(-1)).not.toMatch(/[\\<>:"|?*\p{Cc}\p{Cf}]/u);
  expect(() => buildYouTubeOutputFilename('../escape', 'video.mp4', 'merged', 'title')).toThrow();
  expect(() => buildYouTubeOutputFilename(id, '../video.mp4', 'merged', 'title')).toThrow();
});
it('limits Unicode size without breaking emoji and uses stable fallbacks', () => {
  const name = buildYouTubeOutputFilename(id, 'video.webm', 'video', '🦊'.repeat(200))
    .split('/')
    .at(-1)!;
  expect(new TextEncoder().encode(name).length).toBeLessThan(210);
  expect(name).not.toContain('\ufffd');
  expect(buildYouTubeOutputFilename(id, 'video.mp4', 'merged', '...')).toContain(
    `FoxFetch-${id}.mp4`,
  );
  expect(buildYouTubeOutputFilename(id, 'audio.m4a', 'audio')).toBe(
    `FoxFetch/YouTube/${id}-audio.m4a`,
  );
});
