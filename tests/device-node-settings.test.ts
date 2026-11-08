import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-settings-'));
vi.mock('../src/config.js', async (original) => ({ ...(await original<Record<string, unknown>>()), DATA_DIR: root }));
const settings = await import('../src/personal-agent/device-node-settings.js');
beforeEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MINICLAW_DEVICE_NODES;
  delete process.env.MINICLAW_PI_MCP;
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

test('device admission is off by default and explicit opt-in is private and persistent', () => {
  expect(settings.deviceNodesEnabled()).toBe(false);
  expect(settings.piMcpEnabled()).toBe(false);
  settings.saveDeviceNodeSettings(true);
  expect(settings.deviceNodesEnabled()).toBe(true);
  expect(settings.piMcpEnabled()).toBe(true);
  expect(fs.statSync(path.join(root, 'config/device-nodes.json')).mode & 0o077).toBe(0);
  settings.saveDeviceNodeSettings(false);
  expect(settings.deviceNodesEnabled()).toBe(false);
});

test('environment overrides saved settings and invalid files fail closed', () => {
  settings.saveDeviceNodeSettings(true);
  vi.stubEnv('MINICLAW_DEVICE_NODES', 'false');
  expect(settings.deviceNodesEnabled()).toBe(false);
  expect(() => settings.saveDeviceNodeSettings(true)).toThrow();
  vi.unstubAllEnvs(); delete process.env.MINICLAW_DEVICE_NODES;
  vi.stubEnv('MINICLAW_PI_MCP', 'false');
  expect(settings.deviceNodesEnabled()).toBe(true);
  expect(settings.piMcpEnabled()).toBe(false);
  fs.chmodSync(path.join(root, 'config/device-nodes.json'), 0o644);
  expect(settings.deviceNodeSettings()).toMatchObject({ enabled: false, source: 'invalid' });
});
