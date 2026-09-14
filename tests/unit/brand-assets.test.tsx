import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Brand } from '../../src/components/Brand';
import { APP_NAME, APP_NAME_EN } from '../../src/shared/constants';

const projectRoot = process.cwd();
const iconDirectory = resolve(projectRoot, 'public', 'icons');

const runtimeAssets = [
  ['foxfetch-dark.svg', '356e1d5e982044797d5e05821ff1817253ae0e87b7e9478daf86b74671d58524'],
  ['foxfetch.svg', '5f4c3aa9c477367769d92a6821f240e5fc517841db8bf89a74fd43e2cb1530dc'],
  ['icon-128.png', '3a425cc43e2f6fe8139e5f4ab29e20bac57b7bb97548a83d29f654c267b47a06'],
  ['icon-16.png', '26ea74f72125680b1940e1f3edde015390cffd81c9df76a24a235840c02cbce2'],
  ['icon-32.png', 'c47f07248b00d56d2fcff62ef047203b54f1f057570688d756a80e51a358f018'],
  ['icon-48.png', '3c5a606fdffbacce84ce9deec09741c532e0004ee84403ea46a4a87d9a83aa1b'],
] as const;

function readAsset(name: string): Buffer {
  return readFileSync(resolve(iconDirectory, name));
}

function assetHash(name: string, bytes: Buffer): string {
  // Git may check out SVG text with CRLF on Windows; binary assets stay byte-exact.
  const content = name.endsWith('.svg') ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
  return createHash('sha256').update(content).digest('hex');
}

describe('FoxFetch 26 V2 runtime brand assets', () => {
  it('ships only the audited runtime whitelist at its recorded hashes', () => {
    expect(readdirSync(iconDirectory).sort()).toEqual(runtimeAssets.map(([name]) => name).sort());

    for (const [name, expectedHash] of runtimeAssets) {
      expect(assetHash(name, readAsset(name)), name).toBe(expectedHash);
    }
  });

  it.each(['foxfetch.svg', 'foxfetch-dark.svg'])(
    '%s has the same audited hash with LF or CRLF',
    (name) => {
      const lf = readAsset(name).toString('utf8').replace(/\r\n/g, '\n');
      const expectedHash = runtimeAssets.find(([asset]) => asset === name)![1];
      expect(assetHash(name, Buffer.from(lf))).toBe(expectedHash);
      expect(assetHash(name, Buffer.from(lf.replace(/\n/g, '\r\n')))).toBe(expectedHash);
      expect(
        assetHash(name, Buffer.from(lf.replace('<svg', '<svg data-modified="true"'))),
      ).not.toBe(expectedHash);
    },
  );

  it.each([
    ['icon-16.png', 16],
    ['icon-32.png', 32],
    ['icon-48.png', 48],
    ['icon-128.png', 128],
  ])('keeps %s as a square RGBA PNG at the manifest size', (name, size) => {
    const png = readAsset(name);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(6);
  });

  it.each(['foxfetch.svg', 'foxfetch-dark.svg'])('%s is a passive, self-contained mark', (name) => {
    const svg = readAsset(name).toString('utf8');
    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).not.toMatch(
      /<script\b|on\w+\s*=|javascript:|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/)/i,
    );
  });

  it('uses one English product name in constants, metadata and the Brand component', () => {
    const zhLocale = JSON.parse(
      readFileSync(resolve(projectRoot, 'public', '_locales', 'zh_CN', 'messages.json'), 'utf8'),
    ) as { extensionName: { message: string } };
    const packageMetadata = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { version: string; description: string };
    const brand = renderToStaticMarkup(<Brand compact />);

    expect(APP_NAME).toBe('FoxFetch');
    expect(APP_NAME_EN).toBe(APP_NAME);
    expect(zhLocale.extensionName.message).toBe(APP_NAME);
    expect(packageMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(resolve(projectRoot, 'wxt.config.ts'), 'utf8')).toContain(
      `version_name: '${packageMetadata.version} Beta'`,
    );
    expect(packageMetadata.description).toMatch(/^FoxFetch\b/);
    expect(brand).toContain('aria-label="FoxFetch"');
    expect(brand).toContain('class="brand__fox"');
    expect(brand).toContain('class="brand__fetch"');
    expect(brand).toContain('/icons/foxfetch.svg');
    expect(brand).toContain('/icons/foxfetch-dark.svg');
    expect(brand).not.toContain('狐觅');
  });

  it('uses the audited wordmark palette in light and dark themes', () => {
    const css = readFileSync(resolve(projectRoot, 'src', 'styles', 'ui.css'), 'utf8');
    expect(css).toMatch(/\.brand__fox\s*\{[^}]*color:\s*#ff5a1f;/u);
    expect(css).toMatch(/\.brand__fetch\s*\{[^}]*color:\s*#141414;/u);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s+\.brand__fetch\s*\{[^}]*color:\s*#fff;/u);
  });
});
