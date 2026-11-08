import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { kimiCuDeviceLock } from '../src/personal-agent/kimi-cu-device-lock.js';

test('KimiCU lock identity is independent of caller-provided HOME and target', () => {
  const before = kimiCuDeviceLock();
  const prior = process.env.HOME;
  try {
    process.env.HOME = '/tmp/not-the-account-home';
    expect(kimiCuDeviceLock()).toEqual(before);
    expect(before.lockDirectory).toBe(
      path.join(os.userInfo().homedir, '.opendot', 'device-locks'),
    );
    expect(before.resourceId).toBe('opendot:kimicu:desktop-input');
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
});
