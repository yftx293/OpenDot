import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import {
  DeviceScreenshotOutput,
  normalizeScreenshotImage,
} from '../src/personal-agent/device-screenshot.js';
import { DeviceMcpGrantSchema } from '../src/personal-agent/device-protocol.js';
import { randomUUID } from 'node:crypto';
const { PNG } = createRequire(import.meta.url)('pngjs') as {
  PNG: {
    sync: {
      write(input: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
};

test('only a previously issued, bounded PNG can be read from the private output root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-screenshot-'));
  fs.chmodSync(root, 0o700);
  try {
    const output = new DeviceScreenshotOutput(fs.realpathSync(root));
    const png = PNG.sync.write({
      width: 20,
      height: 10,
      data: Buffer.alloc(20 * 10 * 4, 255),
    });
    const expected = output.allocate();
    fs.writeFileSync(expected, png, { mode: 0o600 });
    expect(() =>
      output.read(expected, path.join(root, 'other.png'), () => {}),
    ).toThrow();
    expect(() => output.read(expected, expected, () => {})).toThrow();
    expect(fs.existsSync(expected)).toBe(false);
    const next = output.allocate();
    fs.writeFileSync(next, png, { mode: 0o600 });
    const image = output.read(next, next, () => {});
    expect(image.width).toBe(20);
    expect(image.height).toBe(10);
    expect(image.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(next)).toBe(false);
    const corrupted = output.allocate();
    fs.writeFileSync(corrupted, png.subarray(0, 33), { mode: 0o600 });
    expect(() => output.read(corrupted, corrupted, () => {})).toThrow();
    expect(fs.existsSync(corrupted)).toBe(false);
    const outside = path.join(root, 'other.png');
    fs.writeFileSync(outside, png, { mode: 0o600 });
    const symlink = output.allocate();
    fs.symlinkSync(outside, symlink);
    expect(() => output.read(symlink, symlink, () => {})).toThrow();
    expect(fs.existsSync(outside)).toBe(true);
    const abandoned = output.allocate();
    fs.writeFileSync(abandoned, png, { mode: 0o600 });
    output.abandon(abandoned);
    expect(fs.existsSync(abandoned)).toBe(false);
    const revoked = output.allocate();
    fs.writeFileSync(revoked, png, { mode: 0o600 });
    expect(() =>
      output.read(revoked, revoked, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(fs.existsSync(revoked)).toBe(false);
    expect(() => output.read(revoked, revoked, () => {})).toThrow();
    output.abandon(outside);
    expect(fs.existsSync(outside)).toBe(true);
    const oversized = output.allocate();
    png.writeUInt32BE(5000, 16);
    fs.writeFileSync(oversized, png, { mode: 0o600 });
    expect(() => output.read(oversized, oversized, () => {})).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup never removes a replacement for an open screenshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-screenshot-swap-'));
  fs.chmodSync(root, 0o700);
  try {
    const output = new DeviceScreenshotOutput(fs.realpathSync(root));
    const png = PNG.sync.write({
      width: 2,
      height: 2,
      data: Buffer.alloc(16, 255),
    });
    const target = output.allocate();
    const moved = path.join(root, 'moved.png');
    fs.writeFileSync(target, png, { mode: 0o600 });
    let checks = 0;
    try {
      output.read(target, target, () => {
        if (++checks === 2) {
          fs.renameSync(target, moved);
          fs.writeFileSync(target, 'replacement', { mode: 0o600 });
        }
      });
    } catch {
      // A changed timestamp may also reject the screenshot; either way the
      // replacement is not the file opened by the operation.
    }
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP image grants require an explicit opt-in and preserve legacy default', () => {
  const grant = {
    confirmed: true,
    expected_revision: 1,
    workspace_jid: 'web:test',
    session_id: randomUUID(),
    dot_id: randomUUID(),
    server_id: 'browser',
    declaration_digest: 'a'.repeat(64),
    tools: ['screenshot'],
    ttl_seconds: 900,
  };
  expect(DeviceMcpGrantSchema.parse(grant).allow_images).toBe(false);
  expect(
    DeviceMcpGrantSchema.parse({ ...grant, allow_images: true }).allow_images,
  ).toBe(true);
});

test('normalizes bounded JPEG screenshots to metadata-free PNG', () => {
  const jpeg = createRequire(import.meta.url)('jpeg-js') as {
    encode(
      input: { width: number; height: number; data: Buffer },
      quality: number,
    ): { data: Buffer };
  };
  const image = jpeg.encode(
    { width: 2, height: 2, data: Buffer.alloc(16, 127) },
    70,
  ).data;
  const metadata = Buffer.from('synthetic-private-metadata');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(metadata.length + 2);
  const withMetadata = Buffer.concat([
    image.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    length,
    metadata,
    image.subarray(2),
  ]);
  const output = normalizeScreenshotImage(withMetadata, 'image/jpeg');
  expect(output.mimeType).toBe('image/png');
  expect([output.width, output.height]).toEqual([2, 2]);
  expect(output.bytes.includes(metadata)).toBe(false);
  expect(() =>
    normalizeScreenshotImage(image.subarray(0, -2), 'image/jpeg'),
  ).toThrow();
  expect(() => normalizeScreenshotImage(image, 'image/png')).toThrow();
  expect(() => normalizeScreenshotImage(image, 'image/webp')).toThrow();
  expect(() =>
    normalizeScreenshotImage(Buffer.alloc(4 * 1024 * 1024 + 1), 'image/jpeg'),
  ).toThrow();
});
