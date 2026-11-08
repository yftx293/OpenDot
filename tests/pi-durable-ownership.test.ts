import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '@earendil-works/pi-durable';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { PiDurableRuntimeAdapter } from '../src/personal-agent/durable-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-durable-ownership-'));
const children = new Set<ChildProcess>();
const workerPath = fileURLToPath(
  new URL('./helpers/durable-ownership-worker.ts', import.meta.url),
);
type WorkerStatus = { status: 'opened' | 'owned' | 'error' };
function worker(databasePath: string, discard = false) {
  const child = fork(
    workerPath,
    [databasePath, ...(discard ? ['discard'] : [])],
    {
      execArgv: ['--expose-gc', '--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  children.add(child);
  const exited = once(child, 'close');
  child.once('close', () => children.delete(child));
  const first = new Promise<WorkerStatus>((resolve, reject) => {
    let received = false;
    const timeout = setTimeout(
      () => reject(new Error('Ownership worker timed out')),
      15_000,
    );
    child.once('message', (message) => {
      received = true;
      clearTimeout(timeout);
      resolve(message as WorkerStatus);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timeout);
      if (!received)
        reject(new Error('Ownership worker exited before reporting'));
    });
  });
  return { child, first, exited };
}
function open(databasePath: string) {
  return PiDurableRuntimeAdapter.open({
    databasePath,
    registry: createRegistry(),
    authorizeConversation: () => undefined,
    recordInputRequest: () => undefined,
  });
}
afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      const exited = once(child, 'close');
      child.kill('SIGKILL');
      await exited;
    }),
  );
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('exclusive local Durable Harness ownership', () => {
  test('garbage collection cannot surrender an activated Harness without explicit close', async () => {
    const filename = path.join(root, 'discarded.sqlite');
    const discarded = worker(filename, true);
    expect(await discarded.first).toEqual({ status: 'opened' });
    expect(discarded.child.exitCode).toBeNull();
    expect(discarded.child.signalCode).toBeNull();
    let conflictCode: string | undefined;
    try {
      const contender = await open(filename);
      await contender.close();
    } catch (error) {
      conflictCode = (error as { code?: string }).code;
    }
    expect(conflictCode).toBe('DURABLE_DATABASE_OWNED');
    discarded.child.kill('SIGKILL');
    expect(await discarded.exited).toEqual([null, 'SIGKILL']);
  }, 25_000);

  test('simultaneous real processes admit exactly one Harness', async () => {
    const filename = path.join(root, 'race.sqlite');
    const first = worker(filename);
    const second = worker(filename);
    const results = await Promise.all([first.first, second.first]);
    expect(
      results.map((result) => result.status).sort(),
      JSON.stringify(results),
    ).toEqual(['opened', 'owned']);
    const winner = results[0].status === 'opened' ? first : second;
    const loser = winner === first ? second : first;
    expect(await loser.exited).toEqual([2, null]);
    winner.child.send('close');
    expect(await winner.exited).toEqual([0, null]);
    const adapter = await open(filename);
    await adapter.close();
  }, 25_000);

  test('SIGKILL releases OS ownership for a fresh process without deleting the coordinator', async () => {
    const filename = path.join(root, 'killed.sqlite');
    const original = worker(filename);
    expect(await original.first).toEqual({ status: 'opened' });
    const coordinator = `${filename}.owner.sqlite`;
    const inode = fs.statSync(coordinator).ino;
    expect(fs.statSync(coordinator).mode & 0o777).toBe(0o600);
    await expect(open(filename)).rejects.toMatchObject({
      code: 'DURABLE_DATABASE_OWNED',
    });
    original.child.kill('SIGKILL');
    expect(await original.exited).toEqual([null, 'SIGKILL']);
    const recovered = worker(filename);
    expect(await recovered.first).toEqual({ status: 'opened' });
    expect(fs.statSync(coordinator).ino).toBe(inode);
    recovered.child.send('close');
    expect(await recovered.exited).toEqual([0, null]);
  }, 25_000);

  test('canonicalizes file and parent-directory symlinks and rejects hard links', async () => {
    const directory = path.join(root, 'canonical');
    const filename = path.join(directory, 'runtime.sqlite');
    const adapter = await open(filename);
    try {
      const alias = path.join(root, 'file-alias.sqlite');
      fs.symlinkSync(filename, alias);
      const parentAlias = path.join(root, 'directory-alias');
      fs.symlinkSync(directory, parentAlias, 'dir');
      await expect(open(alias)).rejects.toMatchObject({
        code: 'DURABLE_DATABASE_OWNED',
      });
      await expect(
        open(path.join(parentAlias, 'runtime.sqlite')),
      ).rejects.toMatchObject({ code: 'DURABLE_DATABASE_OWNED' });
      const hardLink = path.join(root, 'hard-link.sqlite');
      fs.linkSync(filename, hardLink);
      try {
        await expect(open(hardLink)).rejects.toThrow('without hard links');
      } finally {
        fs.unlinkSync(hardLink);
      }
    } finally {
      await adapter.close();
    }
  });

  test('failed Harness initialization releases ownership for a repaired database', async () => {
    const filename = path.join(root, 'invalid.sqlite');
    fs.writeFileSync(filename, 'invalid sqlite header');
    await expect(open(filename)).rejects.toThrow();
    // Deliberately corrupt test data only; production repair must preserve its DB.
    fs.truncateSync(filename, 0);
    const adapter = await open(filename);
    await adapter.close();
  });

  test('rejects a dangling database symlink and a linked coordinator', async () => {
    const dangling = path.join(root, 'dangling.sqlite');
    fs.symlinkSync(path.join(root, 'missing.sqlite'), dangling);
    await expect(open(dangling)).rejects.toThrow('dangling symlink');
    const filename = path.join(root, 'linked-coordinator.sqlite');
    const foreign = path.join(root, 'foreign.sqlite');
    fs.writeFileSync(foreign, 'must remain unchanged');
    fs.symlinkSync(foreign, `${filename}.owner.sqlite`);
    await expect(open(filename)).rejects.toThrow();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('must remain unchanged');
  });
});
