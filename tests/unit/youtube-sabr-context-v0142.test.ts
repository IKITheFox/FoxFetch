// @vitest-environment node
import { expect, it } from 'vitest';
import { SabrStream } from 'googlevideo/sabr-stream';
import { SabrContextSendingPolicy, SabrContextUpdate } from 'googlevideo/protos';

/** White-box protocol-state test, not session authentication or network evidence. */
it('lets server stop, replace and discard seeded contexts without replaying stale values', () => {
  const stream = new SabrStream();
  const seed = new Uint8Array([1]);
  stream.seedSabrContexts([
    { type: 7, value: seed },
    { type: 8, value: new Uint8Array([8]) },
  ]);
  seed[0] = 99;
  const internal = stream as unknown as {
    prepareSabrContexts(): {
      sabrContexts: Array<{ type: number; value: Uint8Array }>;
      unsentSabrContexts: number[];
    };
    handleSabrContextSendingPolicy(part: { data: { chunks: Uint8Array[] } }): void;
    handleSabrContextUpdate(part: { data: { chunks: Uint8Array[] } }): void;
  };
  expect(internal.prepareSabrContexts().sabrContexts[0]?.value[0]).toBe(1);
  expect(() => stream.seedSabrContexts([{ type: 9, value: seed }])).toThrow(
    'SABR_CONTEXT_ALREADY_INITIALIZED',
  );
  const policy = (startPolicy: number[], stopPolicy: number[], discardPolicy: number[]) =>
    internal.handleSabrContextSendingPolicy({
      data: {
        chunks: [
          SabrContextSendingPolicy.encode({ startPolicy, stopPolicy, discardPolicy }).finish(),
        ],
      },
    });
  policy([], [7], [8]);
  expect(internal.prepareSabrContexts()).toEqual({ sabrContexts: [], unsentSabrContexts: [7] });
  internal.handleSabrContextUpdate({
    data: { chunks: [SabrContextUpdate.encode({ type: 7, value: new Uint8Array([2]) }).finish()] },
  });
  policy([7], [], []);
  expect(internal.prepareSabrContexts().sabrContexts).toMatchObject([
    { type: 7, value: new Uint8Array([2]) },
  ]);
  policy([], [], [7]);
  expect(internal.prepareSabrContexts()).toEqual({ sabrContexts: [], unsentSabrContexts: [] });
  stream.abort();
});
