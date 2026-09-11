// @vitest-environment node
import { expect, it } from 'vitest';
import { CompositeBuffer, UmpReader, UmpWriter } from 'googlevideo/ump';
import { SabrStream } from 'googlevideo/sabr-stream';

it('retains a split UMP header until the next network read', () => {
  const buffer = new CompositeBuffer();
  new UmpWriter(buffer).write(999, new Uint8Array([1, 2, 3]));
  const all = Uint8Array.from(buffer.chunks.flatMap((c) => [...c]));
  const first = new UmpReader(new CompositeBuffer([all.slice(0, 1)])).read(() => {
    throw Error('EARLY_PART');
  });
  expect(first).toBeDefined();
  first!.data.append(all.slice(1));
  const types: number[] = [];
  expect(new UmpReader(first!.data).read((p) => types.push(p.type))).toBeUndefined();
  expect(types).toEqual([999]);
});
it('rejects an oversized declared UMP part without allocating its payload', () => {
  // Five-byte unsigned varint for 64 MiB + 1, following MEDIA type 21.
  const bytes = new Uint8Array([21, 240, 1, 0, 0, 4]);
  expect(() => new UmpReader(new CompositeBuffer([bytes])).read(() => undefined)).toThrow(
    'SABR_PART_TOO_LARGE',
  );
});
it('does not silently accept a response ending in a truncated part', async () => {
  const stream = new SabrStream();
  const internal = stream as unknown as { processStreamingResponse(r: Response): Promise<unknown> };
  await expect(
    internal.processStreamingResponse(
      new Response(new Uint8Array([21, 10, 1]), {
        headers: { 'content-type': 'application/vnd.yt-ump' },
      }),
    ),
  ).rejects.toThrow('SEGMENT_MISSING');
  stream.abort();
});
