import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-container-model-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const config = await import('../src/runtime-config.js');
const model = await import('../src/personal-agent/product-model.js');

let providerId = '';
beforeAll(() => {
  vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'true');
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'member',
    username: 'member',
    password_hash: 'fixture',
    display_name: 'Member',
    role: 'member',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:container', {
    name: 'Container',
    folder: 'container',
    executionMode: 'container',
    created_by: 'member',
    added_at: now,
  });
  providerId = config.createProvider({
    name: 'Container fixture',
    type: 'third_party',
    anthropicBaseUrl: 'http://127.0.0.1:1/v1',
    anthropicApiKey: 'test-key',
    anthropicModel: 'container-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  }).id;
});
afterAll(() => {
  vi.unstubAllEnvs();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Group runtime may select a member-owned container workspace; private Durable still requires Host', () => {
  const selected = model.productModelConfiguration(
    'web:container',
    providerId,
    { allowContainerWorkspace: true },
  );
  expect(selected.id).toBe(providerId);
  expect(
    model.selectNewProductRuntime('web:container', 'node-durable', '', {
      allowContainerWorkspace: true,
    }),
  ).toMatchObject({
    kind: 'pi-durable',
    providerId,
    configFingerprint: selected.fingerprint,
  });
  // The allowance is scoped to server-owned Group Sessions. Ordinary private
  // and Goal admission must not inherit it.
  expect(() =>
    model.productModelConfiguration('web:container', providerId),
  ).toThrow(/Host workspace/);
  expect(() =>
    model.selectNewProductRuntime('web:container', 'node-durable'),
  ).toThrow(/Host workspace/);
});

test('switching a Group workspace between Host and container changes its frozen model identity', () => {
  const now = new Date().toISOString();
  db.createUser({
    id: 'admin',
    username: 'admin',
    password_hash: 'fixture',
    display_name: 'Admin',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  const workspace = {
    name: 'Switchable',
    folder: 'switchable',
    created_by: 'admin',
    added_at: now,
  };
  db.setRegisteredGroup('web:switchable', {
    ...workspace,
    executionMode: 'host',
  });
  const host = model.productModelConfiguration('web:switchable', providerId, {
    allowContainerWorkspace: true,
  });
  expect(host.fingerprint).toBe(
    model.productModelConfiguration('web:switchable', providerId).fingerprint,
  );
  db.setRegisteredGroup('web:switchable', {
    ...workspace,
    executionMode: 'container',
  });
  const container = model.productModelConfiguration(
    'web:switchable',
    providerId,
    { allowContainerWorkspace: true },
  );
  expect(container.fingerprint).not.toBe(host.fingerprint);
  db.setRegisteredGroup('web:switchable', {
    ...workspace,
    executionMode: 'host',
  });
  expect(
    model.productModelConfiguration('web:switchable', providerId, {
      allowContainerWorkspace: true,
    }).fingerprint,
  ).toBe(host.fingerprint);
});
