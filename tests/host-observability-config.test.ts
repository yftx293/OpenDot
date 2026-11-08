import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-observability-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
}));
const config =
  await import('../src/personal-agent/host-observability-config.js');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('default off, encrypted Host credentials, stable installation and zero-sample policy', () => {
  expect(config.readHostObservabilityOptions()).toBeUndefined();
  const input = {
    enabled: true,
    origin: 'https://example.test/',
    sampleRate: 0,
    publicKey: 'pk-fixture',
    secretKey: 'private-langfuse-secret',
  };
  config.saveHostObservabilitySettings(input);
  const file = path.join(root, 'config', 'langfuse-observability.json');
  const raw = fs.readFileSync(file, 'utf8');
  expect(raw).not.toContain(input.secretKey);
  expect(raw).not.toContain(input.publicKey);
  expect(fs.statSync(file).mode & 0o077).toBe(0);
  const first = config.readHostObservabilityOptions()!;
  expect(first).toMatchObject({
    baseUrl: input.origin,
    sampleRate: 0,
    publicKey: input.publicKey,
    secretKey: input.secretKey,
  });
  expect(config.readHostObservabilitySettings()).toEqual({
    configured: true, enabled: true, origin: 'https://example.test', sampleRate: 0,
  });
  config.saveHostObservabilitySettings({ enabled: true, origin: 'https://example.test/', sampleRate: 0.5 });
  expect(config.readHostObservabilityOptions()).toMatchObject({ publicKey: input.publicKey, secretKey: input.secretKey, sampleRate: 0.5 });
  expect(() => config.saveHostObservabilitySettings({ enabled: true, origin: input.origin, sampleRate: 1, publicKey: 'only-one-key' })).toThrow();
  config.saveHostObservabilitySettings({ ...input, enabled: false });
  expect(config.readHostObservabilityOptions()).toBeUndefined();
  config.saveHostObservabilitySettings(input);
  expect(config.readHostObservabilityOptions()?.installationId).toBe(
    first.installationId,
  );
});

test('invalid destinations and nonprivate files fail closed', () => {
  expect(() =>
    config.saveHostObservabilitySettings({
      enabled: true,
      origin: 'http://example.test/',
      sampleRate: 1,
      publicKey: 'pk',
      secretKey: 'sk',
    }),
  ).toThrow();
  const file = path.join(root, 'config', 'langfuse-observability.json');
  fs.chmodSync(file, 0o644);
  expect(() => config.readHostObservabilityOptions()).toThrow('private');
  expect(() => config.saveHostObservabilitySettings({ enabled: false, origin: 'https://example.test/', sampleRate: 1 })).toThrow('private');
});
