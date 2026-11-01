#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , source, destination] = process.argv;
if (!source || !destination)
  throw new Error('Expected Durable Session source/destination directories');
if (!fs.existsSync(source)) process.exit(0); // Backward-compatible optional data.
if (!fs.lstatSync(source).isDirectory())
  throw new Error('Durable Session storage must be a real directory');
const id = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const database = new RegExp(`^${id}\\.sqlite$`, 'i');
const transient = new RegExp(
  `^${id}\\.sqlite(?:-(?:wal|shm)|\\.owner\\.sqlite(?:-journal|-(?:wal|shm))?)$`,
  'i',
);
const files = [];
for (const name of fs.readdirSync(source)) {
  const stat = fs.lstatSync(path.join(source, name));
  if (!stat.isFile() || stat.nlink > 1)
    throw new Error('Unsafe Durable Session storage entry');
  if (database.test(name)) files.push(name);
  else if (!transient.test(name))
    throw new Error('Unrecognized Durable Session storage entry');
}
if (files.length) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  fs.chmodSync(destination, 0o700);
}
for (const name of files.sort()) {
  execFileSync(
    process.execPath,
    [
      path.join(import.meta.dirname, 'sqlite-snapshot.mjs'),
      path.join(source, name),
      path.join(destination, name),
    ],
    { stdio: 'inherit' },
  );
  // The integrity probe can create empty WAL/SHM sidecars. The online backup
  // itself is self-contained; a stopped destination must carry neither one.
  fs.rmSync(path.join(destination, `${name}-wal`), { force: true });
  fs.rmSync(path.join(destination, `${name}-shm`), { force: true });
}
