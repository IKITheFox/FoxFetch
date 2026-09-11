/* global console */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDirectory = path.join(root, 'public', 'icons');

const expectedAssets = new Map([
  ['foxfetch.svg', 'dbec9a74467bf7ff71fb6283acffcba323338456fa0f4a560b116a7a8f70ea03'],
  ['foxfetch-dark.svg', '2c69da8541fe215ee4af5e7dea8cf2091c5a05a2ecf7df62d211503b8256d570'],
  ['icon-16.png', '26ea74f72125680b1940e1f3edde015390cffd81c9df76a24a235840c02cbce2'],
  ['icon-32.png', 'c47f07248b00d56d2fcff62ef047203b54f1f057570688d756a80e51a358f018'],
  ['icon-48.png', '3c5a606fdffbacce84ce9deec09741c532e0004ee84403ea46a4a87d9a83aa1b'],
  ['icon-128.png', '3a425cc43e2f6fe8139e5f4ab29e20bac57b7bb97548a83d29f654c267b47a06'],
]);

for (const [name, expectedHash] of expectedAssets) {
  const asset = await readFile(path.join(iconDirectory, name));
  const actualHash = createHash('sha256').update(asset).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(`FoxFetch 26 V2 asset hash mismatch: ${name}`);
  }

  const match = /^icon-(\d+)\.png$/.exec(name);
  if (!match) continue;
  const size = Number(match[1]);
  const metadata = await sharp(asset).metadata();
  if (
    metadata.format !== 'png' ||
    metadata.width !== size ||
    metadata.height !== size ||
    !metadata.hasAlpha
  ) {
    throw new Error(`FoxFetch manifest icon is not a ${size}x${size} RGBA PNG: ${name}`);
  }
}

console.log('Validated FoxFetch 26 V2 runtime assets and manifest icons.');
