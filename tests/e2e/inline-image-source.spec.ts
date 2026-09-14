import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

for (const scheme of ['https', 'http']) {
  test(`${scheme}: real canvas preview and original integrity with multi-megabyte inline image`, async ({
    page,
  }) => {
    const digestModule = ts.transpileModule(
      readFileSync('src/modules/detector/inline-image-digest.ts', 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
    ).outputText;
    const source = ts
      .transpileModule(readFileSync('src/modules/detector/inline-images.ts', 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      })
      .outputText.replace(
        './inline-image-digest',
        'data:text/javascript;base64,' + Buffer.from(digestModule).toString('base64'),
      );
    // Local browser fixture, not the user's extension profile or authenticated media.
    await page.route(`${scheme}://inline-image.test/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Inline image fixture</title>',
      }),
    );
    await page.goto(`${scheme}://inline-image.test/`);
    const result = await page.evaluate(async (moduleSource) => {
      const lib = await import(
        'data:text/javascript;charset=utf-8,' + encodeURIComponent(moduleSource)
      );
      const canvas = document.createElement('canvas');
      canvas.width = 1400;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 7;
      for (let i = 0; i < pixels.data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
      }
      ctx.putImageData(pixels, 0, 0);
      const url = canvas.toDataURL('image/png');
      const raw = {
        id: 'large',
        url,
        kind: 'image',
        frameId: 0,
        pageUrl: document.URL,
        downloadable: true,
      };
      const light = lib.referenceInlineImage(raw, document);
      const restored = await lib.readInlineImage(
        document,
        light.inlineImage.token,
        document.URL,
        false,
        () => [raw],
      );
      const preview = await lib.readInlineImage(
        document,
        light.inlineImage.token,
        document.URL,
        true,
        () => [raw],
      );
      const img = new Image();
      img.src = preview;
      await img.decode();
      return {
        originalLength: url.length,
        snapshotLength: JSON.stringify(light).length,
        exact: restored === url,
        previewLength: preview.length,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    }, source);
    expect(result.originalLength).toBeGreaterThan(4_000_000);
    expect(result.snapshotLength).toBeLessThan(1000);
    expect(result.exact).toBe(true);
    expect(result.previewLength).toBeLessThanOrEqual(128 * 1024);
    expect(Math.max(result.width, result.height)).toBe(320);
  });
}
