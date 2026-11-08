import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import {
  acquireDurableDatabaseOwnership,
  DurableOwnershipConflict,
} from '../src/personal-agent/durable-ownership.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-durable-path-race-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('a runtime file created after a failed lookup still contends on its original real SQLite owner', () => {
  const filename = path.join(root, 'created-by-winner.sqlite');
  const winner = acquireDurableDatabaseOwnership(filename);
  // Actual coordinator/writer lock; inject only the lookup → file-creation interleaving.
  const lookup = vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
    fs.writeFileSync(filename, '');
    throw Object.assign(new Error('lookup preceded runtime file creation'), {
      code: 'ENOENT',
    });
  });
  try {
    expect(() => acquireDurableDatabaseOwnership(filename)).toThrow(
      DurableOwnershipConflict,
    );
    expect(fs.statSync(`${filename}.owner.sqlite`).mode & 0o777).toBe(0o600);
  } finally {
    lookup.mockRestore();
    winner.release();
  }
  const successor = acquireDurableDatabaseOwnership(filename);
  successor.release();
});

test('a hard link appearing after a failed lookup remains forbidden and its target is unchanged', () => {
  const filename = path.join(root, 'created-hardlink.sqlite');
  const target = path.join(root, 'private-target');
  fs.writeFileSync(target, 'must remain untouched');
  const lookup = vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
    fs.linkSync(target, filename);
    throw Object.assign(new Error('lookup preceded hard link creation'), {
      code: 'ENOENT',
    });
  });
  try {
    expect(() => acquireDurableDatabaseOwnership(filename)).toThrow(
      'regular file without hard links',
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('must remain untouched');
    expect(fs.existsSync(`${filename}.owner.sqlite`)).toBe(false);
  } finally {
    lookup.mockRestore();
  }
});
