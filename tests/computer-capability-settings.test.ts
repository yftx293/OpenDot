import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-setting-test-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
}));
const {
  saveComputerCapability,
  readComputerCapability,
  clearComputerCapability,
} = await import('../src/personal-agent/computer-capability-settings.js');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('computer capability is explicitly stored for one owner and fails closed on insecure permissions', () => {
  const ownerId = randomUUID(),
    nodeId = randomUUID(),
    other = randomUUID();
  const binding = {
    version: 1,
    ownerId,
    nodeId,
    serverId: `opendot_computer_${randomUUID().replaceAll('-', '')}`,
  };
  expect(readComputerCapability(ownerId)).toBeUndefined();
  saveComputerCapability(binding);
  expect(readComputerCapability(ownerId)).toEqual(binding);
  expect(readComputerCapability(other)).toBeUndefined();
  const file = path.join(
    root,
    'config/computer-capabilities',
    `${ownerId}.json`,
  );
  fs.chmodSync(file, 0o644);
  expect(() => readComputerCapability(ownerId)).toThrow();
  fs.chmodSync(file, 0o600);
  clearComputerCapability(ownerId);
  expect(readComputerCapability(ownerId)).toBeUndefined();
});
