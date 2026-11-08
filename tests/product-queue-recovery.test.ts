import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createRegistry,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { PiDurableRuntimeAdapter } from '../src/personal-agent/durable-runtime.js';
import { expect, test } from 'vitest';
test('actual SIGKILL after native queue edit reconciles the original product intent in a fresh process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-queue-gap-'));
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  async function run(args: string[]) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('tests/helpers/durable-queue-worker.ts'),
        ...args,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, TZ: 'Asia/Taipei' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const [code, signal] = await once(child, 'close');
    clearTimeout(timer);
    const line = output.split('\n').find((line) => line.startsWith('{'));
    return { code, signal, result: line ? JSON.parse(line) : null };
  }
  try {
    const crashed = await run(['crash']);
    expect(crashed.signal).toBe('SIGKILL');
    expect(crashed.result?.phase).toBe(
      'native-committed-before-product-receipt',
    );
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: path.join(root, 'data/db/queue-fixture.sqlite'),
      registry: createRegistry(),
      authorizeConversation: () => {},
      recordInputRequest: () => {},
    });
    try {
      const id = crashed.result.conversationId as ConversationId;
      await expect(
        adapter.verifyProductControlReceipts(id, []),
      ).rejects.toThrow('product intent receipt');
      await adapter.verifyProductControlReceipts(id, crashed.result.controlIds);
    } finally {
      await adapter.close();
    }
    const resumed = await run(['resume', crashed.result.sessionId]);
    expect(resumed.code).toBe(0);
    expect(resumed.result).toMatchObject({
      sessionId: crashed.result.sessionId,
      controlId: crashed.result.controlId,
      state: 'applied',
      deniedState: 'rejected',
      unchanged: true,
      original: 'ORIGINAL',
    });
    expect(JSON.parse(resumed.result.inbox.items[0].content).content).toBe(
      'EDITED_ONCE',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
