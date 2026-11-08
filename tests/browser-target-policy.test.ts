import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserTargetPolicy,
  type BrowserTarget,
  type FencedBrowserBackend,
} from '../src/personal-agent/browser-target-policy.js';

const target: BrowserTarget = {
  session: 'server-session',
  tab: 'tab-1',
  url: 'https://example.test/',
  revision: 'v1',
};
function fixture() {
  const backend: FencedBrowserBackend = {
    observe: vi.fn(async () => ({ target, text: 'Page' })),
    executeAtTarget: vi.fn(async ({ target: current }) => ({
      target: current,
      text: 'done',
    })),
  };
  let clock = 1000,
    allowed = true;
  const lockDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'opendot-browser-lock-'),
  );
  const policy = new BrowserTargetPolicy({
    resourceId: 'browser-1',
    lockDirectory,
    sessionId: 'server-session',
    allowedOrigins: ['https://example.test'],
    backend,
    authorize: () => {
      if (!allowed) throw new Error('revoked');
    },
    now: () => clock,
  });
  return {
    policy,
    backend,
    lockDirectory,
    advance: (ms: number) => {
      clock += ms;
    },
    revoke: () => {
      allowed = false;
    },
  };
}
describe('browser target policy', () => {
  it('waits for the operating-system lock held by another connection', async () => {
    const f = fixture();
    const name = createHash('sha256')
      .update(JSON.stringify('browser-1'))
      .digest('hex');
    const holder = new Database(path.join(f.lockDirectory, `${name}.sqlite`), {
      timeout: 0,
    });
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const observe = f.policy.observe();
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(f.backend.observe).not.toHaveBeenCalled();
      holder.exec('ROLLBACK');
      await observe;
      expect(f.backend.observe).toHaveBeenCalledTimes(1);
    } finally {
      if (holder.inTransaction) holder.exec('ROLLBACK');
      holder.close();
      fs.rmSync(f.lockDirectory, { recursive: true, force: true });
    }
  });

  it('holds the resource across processes and releases it after a crashed holder', async () => {
    const f = fixture();
    const name = createHash('sha256')
      .update(JSON.stringify('browser-1'))
      .digest('hex');
    const holder = spawn(
      process.execPath,
      [
        path.resolve('tests/fixtures/browser-resource-lock-holder.mjs'),
        path.join(f.lockDirectory, `${name}.sqlite`),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const [ready] = await once(holder.stdout!, 'data');
      expect(String(ready)).toContain('locked');
      const observed = f.policy.observe();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(f.backend.observe).not.toHaveBeenCalled();
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;
      await observed;
      expect(f.backend.observe).toHaveBeenCalledTimes(1);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null)
        holder.kill('SIGKILL');
      fs.rmSync(f.lockDirectory, { recursive: true, force: true });
    }
  });

  it('binds approval to the exact observed target and action and consumes it once', async () => {
    const { policy, backend } = fixture();
    const observation = await policy.observe();
    const action = { action: 'click', selector: '@e1' };
    const approval = policy.approvalDigest(observation.token, action);
    await expect(
      policy.execute(
        { action: 'click', selector: '@e2' },
        observation.token,
        approval,
      ),
    ).rejects.toThrow();
    await policy.execute(action, observation.token, approval);
    await expect(
      policy.execute(action, observation.token, approval),
    ).rejects.toThrow();
    expect(backend.executeAtTarget).toHaveBeenCalledTimes(1);
  });
  it('denies expired, revoked, non-allowlisted and unapproved operations before dispatch', async () => {
    const f = fixture();
    const observation = await f.policy.observe();
    const forbidden = { action: 'navigate', url: 'https://other.test/' };
    const approval = f.policy.approvalDigest(observation.token, forbidden);
    await expect(
      f.policy.execute(forbidden, observation.token, approval),
    ).rejects.toThrow();
    expect(() =>
      f.policy.approvalDigest(observation.token, {
        action: 'evaluate',
        code: '1',
      }),
    ).toThrow();
    f.advance(30001);
    await expect(
      f.policy.execute(forbidden, observation.token, approval),
    ).rejects.toThrow();
    f.revoke();
    await expect(f.policy.observe()).rejects.toThrow('revoked');
    expect(f.backend.executeAtTarget).not.toHaveBeenCalled();
  });
  it('never releases a response from a different target origin', async () => {
    const f = fixture();
    const observation = await f.policy.observe();
    vi.mocked(f.backend.executeAtTarget).mockResolvedValueOnce({
      target: { ...target, url: 'https://other.test/' },
      text: 'secret',
    });
    const action = { action: 'read' };
    await expect(
      f.policy.execute(
        action,
        observation.token,
        f.policy.approvalDigest(observation.token, action),
      ),
    ).rejects.toThrow();
  });
});

it('does not reuse a previous approval after a failed browser observation', async () => {
  const f = fixture();
  try {
    const previous = await f.policy.observe();
    const action = { action: 'click', selector: '@e1' };
    const approval = f.policy.approvalDigest(previous.token, action);
    vi.mocked(f.backend.observe).mockRejectedValueOnce(
      new Error('disconnected'),
    );
    await expect(f.policy.observe()).rejects.toThrow('disconnected');
    await expect(
      f.policy.execute(action, previous.token, approval),
    ).rejects.toThrow();
    expect(f.backend.executeAtTarget).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(f.lockDirectory, { recursive: true, force: true });
  }
});
