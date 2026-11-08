import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test } from 'vitest';
test('SIGKILL after an actual artifact effect reconciles the same file in a fresh process without another write', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'artifact-process-recovery-'),
  );
  const helper = path.resolve('tests/helpers/product-artifact-recovery.ts');
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  async function run(args: string[]) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', helper, ...args],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, TZ: 'Asia/Taipei' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const [code, signal] = await once(child, 'close');
    clearTimeout(timer);
    const line = stdout
      .trim()
      .split('\n')
      .find((value) => value.startsWith('{'));
    return { code, signal, record: line ? JSON.parse(line) : null };
  }
  try {
    const crashed = await run(['crash']);
    expect(crashed.signal).toBe('SIGKILL');
    expect(crashed.record?.phase).toBe('effect-written-before-receipt');
    const target = path.join(
      root,
      'data/db/private-artifacts',
      `${crashed.record.id}.txt`,
    );
    const before = fs.statSync(target);
    const resumed = await run(['resume', crashed.record.id]);
    expect(resumed.code).toBe(0);
    expect(resumed.record).toEqual({
      id: crashed.record.id,
      state: 'completed',
      content: 'PROCESS_APPROVED_ARTIFACT',
    });
    expect(fs.statSync(target).ino).toBe(before.ino);
    expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(path.dirname(target))).toEqual([
      `${crashed.record.id}.txt`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
