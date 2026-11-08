import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KimiDesktopTargetPolicy,
  type DesktopTarget,
  type FencedDesktopBackend,
} from '../src/personal-agent/kimi-desktop-target-policy.js';

it('binds desktop approval to a single allowed app, window, native snapshot and exact action', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'desktop-policy-'),
  );
  const target: DesktopTarget = {
    appId: 'com.example.test',
    pid: 12,
    windowId: 34,
    snapshotId: 'native-snapshot-1',
  };
  const backend: FencedDesktopBackend = {
    observe: vi.fn(async () => ({ target, text: 'safe' })),
    executeAtTarget: vi.fn(async ({ target }) => ({ target, text: 'done' })),
  };
  let allowed = true,
    now = 1000;
  const policy = new KimiDesktopTargetPolicy({
    resourceId: 'desktop-input',
    lockDirectory: directory,
    allowedApps: [target.appId],
    backend,
    authorize: () => {
      if (!allowed) throw Error('revoked');
    },
    now: () => now,
  });
  try {
    const first = await policy.observe();
    const action = { action: 'click', index: 1 };
    const approval = policy.approvalDigest(first.token, action);
    await expect(
      policy.execute({ action: 'click', index: 2 }, first.token, approval),
    ).rejects.toThrow();
    await policy.execute(action, first.token, approval);
    await expect(
      policy.execute(action, first.token, approval),
    ).rejects.toThrow();
    expect(backend.executeAtTarget).toHaveBeenCalledTimes(1);
    expect(() =>
      policy.approvalDigest(first.token, { action: 'js', code: 'x' }),
    ).toThrow();
    const second = await policy.observe();
    const next = policy.approvalDigest(second.token, action);
    now += 30001;
    await expect(policy.execute(action, second.token, next)).rejects.toThrow();
    allowed = false;
    await expect(policy.observe()).rejects.toThrow('revoked');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('does not return content after the backend reports a different app or snapshot', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'desktop-policy-'),
  );
  const target: DesktopTarget = {
    appId: 'com.example.test',
    pid: 12,
    windowId: 34,
    snapshotId: 'v1',
  };
  const backend: FencedDesktopBackend = {
    observe: async () => ({ target, text: 'safe' }),
    executeAtTarget: async () => ({
      target: { ...target, snapshotId: 'v2' },
      text: 'private',
    }),
  };
  const policy = new KimiDesktopTargetPolicy({
    resourceId: 'desktop-input',
    lockDirectory: directory,
    allowedApps: [target.appId],
    backend,
    authorize: () => {},
  });
  try {
    const o = await policy.observe();
    const a = { action: 'click', index: 1 };
    await expect(
      policy.execute(a, o.token, policy.approvalDigest(o.token, a)),
    ).rejects.toThrow('Desktop target changed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('invalidates the previous approval even when re-observation fails', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'desktop-policy-'),
  );
  const target: DesktopTarget = {
    appId: 'com.example.test',
    pid: 12,
    windowId: 34,
    snapshotId: 'v1',
  };
  const backend: FencedDesktopBackend = {
    observe: vi.fn(async () => ({ target, text: 'safe' })),
    executeAtTarget: vi.fn(async ({ target }) => ({ target })),
  };
  const policy = new KimiDesktopTargetPolicy({
    resourceId: 'desktop-input',
    lockDirectory: directory,
    allowedApps: [target.appId],
    backend,
    authorize: () => {},
  });
  try {
    const observed = await policy.observe();
    const action = { action: 'click', index: 1 };
    const approval = policy.approvalDigest(observed.token, action);
    vi.mocked(backend.observe).mockRejectedValueOnce(new Error('disconnected'));
    await expect(policy.observe()).rejects.toThrow('disconnected');
    await expect(
      policy.execute(action, observed.token, approval),
    ).rejects.toThrow();
    expect(backend.executeAtTarget).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('serializes actions for separate windows sharing the desktop resource', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'desktop-shared-lock-'),
  );
  const targetA = {
    appId: 'com.example.a',
    pid: 11,
    windowId: 12,
    snapshotId: 'a',
  };
  const targetB = {
    appId: 'com.example.b',
    pid: 21,
    windowId: 22,
    snapshotId: 'b',
  };
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const backendA: FencedDesktopBackend = {
    observe: async () => ({ target: targetA, text: '' }),
    executeAtTarget: async ({ target }) => {
      order.push('a-start');
      started();
      await held;
      order.push('a-end');
      return { target };
    },
  };
  const backendB: FencedDesktopBackend = {
    observe: async () => ({ target: targetB, text: '' }),
    executeAtTarget: async ({ target }) => {
      order.push('b-start');
      return { target };
    },
  };
  const common = {
    resourceId: 'shared-desktop',
    lockDirectory: directory,
    authorize: () => {},
  };
  const a = new KimiDesktopTargetPolicy({
    ...common,
    allowedApps: [targetA.appId],
    backend: backendA,
  });
  const b = new KimiDesktopTargetPolicy({
    ...common,
    allowedApps: [targetB.appId],
    backend: backendB,
  });
  try {
    const oa = await a.observe(),
      ob = await b.observe(),
      action = { action: 'click', index: 0 };
    const first = a.execute(
      action,
      oa.token,
      a.approvalDigest(oa.token, action),
    );
    await firstStarted;
    const second = b.execute(
      action,
      ob.token,
      b.approvalDigest(ob.token, action),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['a-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  } finally {
    release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('denies the returned result after in-flight revocation without repeating the dispatched action', async () => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'desktop-revoke-'),
  );
  const target: DesktopTarget = {
    appId: 'com.example.test',
    pid: 12,
    windowId: 34,
    snapshotId: 'v1',
  };
  let allowed = true;
  let finish!: (value: { target: DesktopTarget; text: string }) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const backend: FencedDesktopBackend = {
    observe: async () => ({ target, text: 'safe' }),
    executeAtTarget: vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    ),
  };
  const policy = new KimiDesktopTargetPolicy({
    resourceId: 'desktop-input',
    lockDirectory: directory,
    allowedApps: [target.appId],
    backend,
    authorize: () => {
      if (!allowed) throw new Error('revoked');
    },
  });
  try {
    const observed = await policy.observe();
    const action = { action: 'click', index: 1 };
    const approved = policy.approvalDigest(observed.token, action);
    const pending = policy.execute(action, observed.token, approved);
    await dispatched;
    allowed = false;
    finish({ target, text: 'private result after external effect' });
    await expect(pending).rejects.toThrow('revoked');
    allowed = true;
    await expect(
      policy.execute(action, observed.token, approved),
    ).rejects.toThrow();
    expect(backend.executeAtTarget).toHaveBeenCalledTimes(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
