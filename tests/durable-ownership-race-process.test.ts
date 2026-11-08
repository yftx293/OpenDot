import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('simultaneous first openers always elect exactly one database owner', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'durable-first-owner-race-'),
  );
  const worker = fileURLToPath(
    new URL('./helpers/durable-ownership-race-worker.mjs', import.meta.url),
  );
  try {
    // A readiness barrier makes both real processes contend on a fresh file.
    // Repeat to exercise the DDL-lock window that used to reject both callers.
    for (let round = 0; round < 40; round++) {
      const children = [0, 1].map(() =>
        fork(worker, [path.join(root, `race-${round}.sqlite`)], {
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }),
      );
      try {
        await Promise.all(children.map((child) => once(child, 'message')));
        const replies = children.map((child) => once(child, 'message'));
        children.forEach((child) => child.send('acquire'));
        const results = (await Promise.all(replies)).map(
          ([reply]) => reply as { status: string },
        );
        expect(
          results.map((reply) => reply.status).sort(),
          JSON.stringify({ round, results }),
        ).toEqual(['opened', 'owned']);
        const exits = children.map((child) => once(child, 'close'));
        children.forEach((child) => child.send('close'));
        await Promise.all(exits);
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = once(child, 'close');
            child.kill('SIGKILL');
            await exited;
          }),
        );
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
