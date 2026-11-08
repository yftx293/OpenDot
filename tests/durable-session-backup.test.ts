import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, test } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-session-backup-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const script = path.resolve('scripts/snapshot-durable-sessions.mjs');
test('snapshots committed WAL state and excludes live ownership/sidecar files', () => {
  const source = path.join(root, 'source');
  const dest = path.join(root, 'snapshot');
  fs.mkdirSync(source);
  const name = '12345678-abcd-1234-abcd-123456789abc.sqlite';
  const filename = path.join(source, name);
  const writer = new DatabaseSync(filename);
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE checkpoints(value TEXT);INSERT INTO checkpoints VALUES ('committed');",
    );
    fs.writeFileSync(
      `${filename}.owner.sqlite`,
      'coordinator-is-not-task-state',
    );
    expect(fs.statSync(`${filename}-wal`).size).toBeGreaterThan(0);
    execFileSync(process.execPath, [script, source, dest]);
    expect(fs.readdirSync(dest)).toEqual([name]);
    expect(fs.statSync(path.join(dest, name)).mode & 0o777).toBe(0o600);
    const restored = new DatabaseSync(path.join(dest, name));
    try {
      expect(
        restored.prepare('SELECT value FROM checkpoints').get(),
      ).toMatchObject({ value: 'committed' });
    } finally {
      restored.close();
    }
  } finally {
    writer.close();
  }
});
test('rejects linked Session storage and accepts absent legacy storage', () => {
  const absent = path.join(root, 'absent');
  const dest = path.join(root, 'legacy');
  execFileSync(process.execPath, [script, absent, dest]);
  expect(fs.existsSync(dest)).toBe(false);
  const source = path.join(root, 'linked');
  fs.mkdirSync(source);
  fs.symlinkSync(
    '/tmp',
    path.join(source, '12345678-abcd-1234-abcd-123456789abc.sqlite'),
  );
  expect(() =>
    execFileSync(process.execPath, [script, source, dest], { stdio: 'ignore' }),
  ).toThrow();
});
