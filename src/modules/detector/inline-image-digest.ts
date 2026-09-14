/** SHA-256 fallback for HTTP page contexts without SubtleCrypto. No image storage. */
export async function inlineImageDigest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) {
    if (!primes.some((p) => p * p <= n && n % p === 0)) primes.push(n);
  }
  const fraction = (n: number) => ((n - Math.floor(n)) * 0x100000000) >>> 0;
  const constants = primes.map((p) => fraction(Math.cbrt(p)));
  const hash = primes.slice(0, 8).map((p) => fraction(Math.sqrt(p)));
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const words = new Uint32Array(64);
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!,
        y = words[i - 2]!;
      words[i] =
        words[i - 16]! +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[i - 7]! +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        h +
        (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) +
        constants[i]! +
        words[i]!;
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = (hash[i]! + value) >>> 0;
    });
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((value, i) => outputView.setUint32(i * 4, value));
  return hex(output);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
