import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const fixture = fileURLToPath(
  new URL('./helpers/durable-process-worker.ts', import.meta.url),
);
type Worker = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostic: () => string;
};
type Message = { event: string; [key: string]: unknown };
const workers: Worker[] = [];
const roots: string[] = [];

function start(
  mode: string,
  root: string,
  scenario: string,
  position = '',
): Worker {
  const child = fork(fixture, [mode, root, scenario, position], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (data: Buffer) => {
    output = (output + data.toString()).slice(-4_000);
  });
  child.stderr?.on('data', (data: Buffer) => {
    output = (output + data.toString()).slice(-4_000);
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const worker = { child, exited, diagnostic: () => output };
  workers.push(worker);
  return worker;
}

function waitMessage(worker: Worker, event: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        finish(
          new Error(`Timed out waiting for ${event}: ${worker.diagnostic()}`),
        ),
      10_000,
    );
    const onMessage = (message: unknown) => {
      const value = message as Message;
      if (value.event === 'error') finish(new Error(String(value.message)));
      else if (value.event === event) finish(undefined, value);
    };
    const onExit = () =>
      finish(
        new Error(`Worker exited before ${event}: ${worker.diagnostic()}`),
      );
    function finish(error?: Error, message?: Message) {
      clearTimeout(timeout);
      worker.child.off('message', onMessage);
      worker.child.off('exit', onExit);
      if (error) reject(error);
      else resolve(message!);
    }
    worker.child.on('message', onMessage);
    worker.child.once('exit', onExit);
  });
}

async function crashAndResume(
  scenario: string,
  position?: string,
): Promise<Message> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-process-recovery-'),
  );
  roots.push(root);
  const first = start('start', root, scenario, position);
  await waitMessage(first, 'fault-ready');
  expect(first.child.kill('SIGKILL')).toBe(true);
  await expect(first.exited).resolves.toEqual({
    code: null,
    signal: 'SIGKILL',
  });
  const recovered = start('resume', root, scenario, position);
  const result = await waitMessage(recovered, 'result');
  await expect(recovered.exited).resolves.toEqual({ code: 0, signal: null });
  return result;
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill('SIGKILL');
    await worker.exited;
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Pi Durable real subprocess SIGKILL recovery', () => {
  test.each(['before-effect', 'after-effect', 'after-checkpoint'])(
    'resumes committed task state at %s using simulated service receipts',
    async (position) => {
      const result = await crashAndResume('task', position);
      expect(result.state).toMatchObject({
        status: 'terminal',
        outcome: { status: 'completed', result: 3 },
      });
      expect(result.effects).toEqual(
        [1, 2, 3].map((step) => ({ step, receipt: `receipt-${step}` })),
      );
      expect(result.attempts).toEqual(
        [1, 2, 3].map((step) => ({
          step,
          count: step === 2 && position === 'after-effect' ? 2 : 1,
        })),
      );
    },
    20_000,
  );

  test('resumes an interrupted simulated provider request without resubmitting the prompt', async () => {
    const result = await crashAndResume('model');
    expect(result).toMatchObject({
      status: 'done',
      userEntries: 1,
      assistantEntries: 1,
      modelAttempts: 2,
    });
    expect(result.submissionId).toBe(result.persistedSubmissionId);
  }, 20_000);

  test('recovers the payload reservation/admission gap and returns one stable input receipt', async () => {
    const result = await crashAndResume('admission');
    expect(result).toMatchObject({
      sameReceipt: true,
      mismatchRejected: true,
      userEntries: 1,
    });
  }, 20_000);
});
