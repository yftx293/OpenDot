import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  createDeviceReader,
  openDeviceState,
  prepareDeviceIdentity,
  cachedDeviceRead,
} from '../src/personal-agent/device-local.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-files-'));
  roots.push(root);
  const files = path.join(root, 'files');
  fs.mkdirSync(files);
  const state = openDeviceState(path.join(root, 'private/node.sqlite'));
  return { root, files, state };
}
test('local read cache survives reopen and returns original bytes after file changes', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.files, 'evidence.txt'), 'ORIGINAL');
  const reader = createDeviceReader(
    f.files,
    ['evidence.txt'],
    f.state.filename,
  );
  const identity = prepareDeviceIdentity(
    f.state.database,
    'https://gateway.invalid',
    reader.manifest,
    'a'.repeat(64),
  );
  const command = {
    id: randomUUID(),
    params_digest: 'b'.repeat(64),
    path: 'evidence.txt',
  };
  expect(
    cachedDeviceRead(f.state.database, command, reader.read),
  ).toMatchObject({ ok: true, content: 'ORIGINAL' });
  f.state.database.close();
  fs.writeFileSync(path.join(f.files, 'evidence.txt'), 'CHANGED');
  const next = openDeviceState(f.state.filename);
  expect(
    prepareDeviceIdentity(
      next.database,
      'https://gateway.invalid',
      reader.manifest,
    ).token,
  ).toBe(identity.token);
  expect(cachedDeviceRead(next.database, command, reader.read)).toMatchObject({
    ok: true,
    content: 'ORIGINAL',
  });
  expect(() =>
    cachedDeviceRead(
      next.database,
      { ...command, params_digest: 'c'.repeat(64) },
      reader.read,
    ),
  ).toThrow('identity conflict');
  next.database.close();
});
test('path scope denies traversal, undeclared files, symlinks, hardlinks and FIFO without blocking', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.files, 'real.txt'), 'SAFE');
  fs.symlinkSync('real.txt', path.join(f.files, 'link.txt'));
  fs.linkSync(path.join(f.files, 'real.txt'), path.join(f.files, 'hard.txt'));
  execFileSync('mkfifo', [path.join(f.files, 'pipe')]);
  const reader = createDeviceReader(
    f.files,
    ['link.txt', 'hard.txt', 'pipe'],
    f.state.filename,
  );
  for (const relative of [
    '../outside',
    'real.txt',
    '/etc/passwd',
    'link.txt',
    'hard.txt',
    'pipe',
  ])
    expect(reader.read(relative).ok).toBe(false);
  expect(() =>
    createDeviceReader('/', ['etc/passwd'], f.state.filename),
  ).toThrow();
  f.state.database.close();
});
test('private database, WAL and state inode cannot be exposed even when declared', () => {
  const f = fixture();
  const reader = createDeviceReader(
    f.root,
    ['private/node.sqlite', 'private/node.sqlite-wal'],
    f.state.filename,
  );
  expect(reader.read('private/node.sqlite').ok).toBe(false);
  expect(reader.read('private/node.sqlite-wal').ok).toBe(false);
  f.state.database.close();
});
test('strict bounded UTF8 preserves BOM and refuses invalid, oversized and replaced-root files', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.files, 'bom.txt'), '\ufeffFACT');
  fs.writeFileSync(path.join(f.files, 'bad.txt'), Buffer.from([255]));
  fs.writeFileSync(path.join(f.files, 'big.txt'), 'x'.repeat(65537));
  const reader = createDeviceReader(
    f.files,
    ['bom.txt', 'bad.txt', 'big.txt'],
    f.state.filename,
  );
  expect(reader.read('bom.txt')).toMatchObject({
    ok: true,
    content: '\ufeffFACT',
  });
  expect(reader.read('bad.txt')).toEqual({
    ok: false,
    error_code: 'INVALID_UTF8',
  });
  expect(reader.read('big.txt')).toEqual({
    ok: false,
    error_code: 'FILE_TOO_LARGE',
  });
  fs.renameSync(f.files, `${f.files}-old`);
  fs.mkdirSync(f.files);
  fs.writeFileSync(path.join(f.files, 'bom.txt'), 'REPLACED');
  expect(reader.read('bom.txt').ok).toBe(false);
  f.state.database.close();
});
test('state permissions and immutable declaration identity fail closed', () => {
  const f = fixture();
  const reader = createDeviceReader(f.files, ['a.txt'], f.state.filename);
  prepareDeviceIdentity(
    f.state.database,
    'https://gateway.invalid',
    reader.manifest,
    'a'.repeat(64),
  );
  expect(() =>
    prepareDeviceIdentity(
      f.state.database,
      'https://other.invalid',
      reader.manifest,
    ),
  ).toThrow('identity changed');
  const changed = createDeviceReader(f.files, ['b.txt'], f.state.filename);
  expect(() =>
    prepareDeviceIdentity(
      f.state.database,
      'https://gateway.invalid',
      changed.manifest,
    ),
  ).toThrow();
  f.state.database.close();
  fs.chmodSync(f.state.filename, 0o644);
  expect(() => openDeviceState(f.state.filename)).toThrow('permissions');
});
