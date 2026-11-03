#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webDir = join(__dirname, '..');
const repoRoot = join(webDir, '..');
const publicDir = join(webDir, 'public', 'icons');
const sourcePath = join(repoRoot, 'assets', 'miniclaw-icon.svg');

const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];

async function generateIcons() {
  console.log(`Using source: ${sourcePath}`);
  const sourceBuffer = readFileSync(sourcePath);
  const revision = createHash('sha256')
    .update(sourceBuffer)
    .digest('hex')
    .slice(0, 12);
  writeFileSync(join(webDir, 'public', 'opendot-robot.svg'), sourceBuffer);
  writeFileSync(join(webDir, 'public', 'favicon.svg'), sourceBuffer);

  const htmlPath = join(webDir, 'index.html');
  writeFileSync(
    htmlPath,
    readFileSync(htmlPath, 'utf8').replace(
      /(href="%BASE_URL%(?:opendot-robot\.svg|icons\/apple-touch-icon-180\.png))(?:\?v=[^"]*)?"/g,
      `$1?v=${revision}"`,
    ),
  );
  const manifestPath = join(webDir, 'public', 'manifest.webmanifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const icon of manifest.icons)
    icon.src = `${icon.src.split('?')[0]}?v=${revision}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const size of sizes) {
    const pngPath = join(publicDir, `icon-${size}.png`);
    await sharp(sourceBuffer).resize(size, size).png().toFile(pngPath);
    console.log(`✓ Generated ${pngPath}`);
  }

  // Browsers and link previews may request /favicon.ico even with rel=icon.
  // Wrap the same approved 48px PNG in an ICO directory; keep one artwork source.
  const faviconPng = readFileSync(join(publicDir, 'icon-48.png'));
  const faviconHeader = Buffer.alloc(22);
  faviconHeader.writeUInt16LE(1, 2); // ICO image type
  faviconHeader.writeUInt16LE(1, 4); // One image
  faviconHeader[6] = 48;
  faviconHeader[7] = 48;
  faviconHeader.writeUInt16LE(1, 10); // Color planes
  faviconHeader.writeUInt16LE(32, 12); // RGBA
  faviconHeader.writeUInt32LE(faviconPng.length, 14);
  faviconHeader.writeUInt32LE(faviconHeader.length, 18);
  writeFileSync(
    join(webDir, 'public', 'favicon.ico'),
    Buffer.concat([faviconHeader, faviconPng]),
  );

  // Keep a high-resolution PNG export for stores/docs that expect a raster source.
  const logo1024Path = join(publicDir, 'logo-1024.png');
  await sharp(sourceBuffer).resize(1024, 1024).png().toFile(logo1024Path);
  console.log(`✓ Generated ${logo1024Path}`);

  // BrowserWindow and native packagers consume raster/native formats, not SVG.
  const desktopDir = join(repoRoot, 'electron', 'assets');
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(
    join(desktopDir, 'miniclaw-icon.png'),
    readFileSync(logo1024Path),
  );
  const nativeSizes = {
    icp4: 16,
    icp5: 32,
    icp6: 64,
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
  };
  const chunks = [];
  for (const [type, size] of Object.entries(nativeSizes)) {
    const png = await sharp(sourceBuffer).resize(size, size).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(Buffer.concat([header, png]));
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  writeFileSync(
    join(desktopDir, 'miniclaw.icns'),
    Buffer.concat([header, body]),
  );
  console.log('✓ Generated Electron PNG and macOS ICNS');

  // Android maskable icons must not expose transparent corners.
  const maskablePath = join(publicDir, 'icon-512-maskable.png');
  await sharp(sourceBuffer)
    .resize(512, 512)
    .flatten({ background: '#0b1020' })
    .png()
    .toFile(maskablePath);
  console.log(`✓ Generated ${maskablePath}`);

  const appleTouchIconPath = join(publicDir, 'apple-touch-icon-180.png');
  await sharp(sourceBuffer)
    .resize(180, 180)
    .flatten({ background: '#0b1020' })
    .png()
    .toFile(appleTouchIconPath);
  console.log(`✓ Generated ${appleTouchIconPath}`);

  console.log('\n✅ All Miniclaw icons generated successfully!');
}

generateIcons().catch((error) => {
  console.error('❌ Error generating icons:', error);
  process.exit(1);
});
