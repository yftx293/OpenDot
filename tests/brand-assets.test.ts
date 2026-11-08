import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// Sharp belongs to the existing Web workspace; no additional dependency.
const sharp = createRequire(new URL('../web/package.json', import.meta.url))(
  'sharp',
);
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'assets/miniclaw-icon.svg'));
const digest = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');
async function pixels(input: Buffer, size: number, flatten = false) {
  let image = sharp(input).resize(size, size);
  if (flatten) image = image.flatten({ background: '#0b1020' });
  return digest(await image.ensureAlpha().raw().toBuffer());
}

test('all committed Web/PWA/Electron PNGs are current raster exports of the approved SVG', async () => {
  const outputs: [string, number, boolean?][] = [
    ...[48, 72, 96, 128, 144, 152, 192, 384, 512].map(
      (size): [string, number] => [`web/public/icons/icon-${size}.png`, size],
    ),
    ['web/public/icons/logo-1024.png', 1024],
    ['web/public/icons/apple-touch-icon-180.png', 180, true],
    ['web/public/icons/icon-512-maskable.png', 512, true],
    ['electron/assets/miniclaw-icon.png', 1024],
  ];
  for (const [path, size, flatten] of outputs) {
    const buffer = readFileSync(resolve(root, path));
    const metadata = await sharp(buffer).metadata();
    expect(metadata.width, path).toBe(size);
    expect(metadata.height, path).toBe(size);
    expect(metadata.format, path).toBe('png');
    expect(await pixels(buffer, size), path).toBe(
      await pixels(source, size, flatten),
    );
    if (flatten) expect(metadata.hasAlpha, path).toBe(false);
  }
});

test('macOS ICNS contains the same approved image at every supported native size', async () => {
  const buffer = readFileSync(resolve(root, 'electron/assets/miniclaw.icns'));
  expect(buffer.subarray(0, 4).toString()).toBe('icns');
  expect(buffer.readUInt32BE(4)).toBe(buffer.length);
  const sizes = {
    icp4: 16,
    icp5: 32,
    icp6: 64,
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
  };
  const seen: string[] = [];
  for (let offset = 8; offset < buffer.length; ) {
    const type = buffer
      .subarray(offset, offset + 4)
      .toString() as keyof typeof sizes;
    const length = buffer.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThan(8);
    expect(offset + length).toBeLessThanOrEqual(buffer.length);
    expect(sizes[type]).toBeDefined();
    const png = buffer.subarray(offset + 8, offset + length);
    const metadata = await sharp(png).metadata();
    expect(metadata.width).toBe(sizes[type]);
    expect(metadata.height).toBe(sizes[type]);
    expect(await pixels(png, sizes[type]), type).toBe(
      await pixels(source, sizes[type]),
    );
    seen.push(type);
    offset += length;
  }
  expect(seen.sort()).toEqual(Object.keys(sizes).sort());
});
