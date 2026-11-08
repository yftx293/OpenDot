import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-v84-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js'),
  devices = await import('../src/personal-agent/device-store.js'),
  wire = await import('../src/personal-agent/device-protocol.js');
afterAll(() => {
  db.closeDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
test('v83 upgrade preserves the existing generic device grant, legacy wire digest and Team tables, and writes a private verified backup', () => {
  vi.stubEnv('MINICLAW_DEVICE_NODES', 'true');
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'owner',
    password_hash: 'synthetic',
    display_name: 'Owner',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:owner', {
    name: 'Owner',
    folder: 'owner',
    created_by: 'owner',
    executionMode: 'host',
    is_home: false,
    added_at: now,
  });
  const ticket = devices.createDevicePairTicket('owner', randomUUID(), {
    name: 'Legacy finite file node',
  });
  const paired = devices.joinPersonalDevice({
    pair_code: ticket.pair_code,
    claim_request_id: randomUUID(),
    token_hash: wire.deviceTextDigest(randomUUID()),
    manifest: {
      version: 1,
      capability: 'files.read',
      root_label: 'Legacy',
      root_fingerprint: 'a'.repeat(64),
      paths: ['legacy.txt'],
    },
  });
  const node = devices.approvePersonalDevice(
    'owner',
    paired.id,
    paired.revision,
    randomUUID(),
  );
  const key = randomUUID(),
    input = {
      confirmed: true,
      workspace_jid: 'web:owner',
      capability: 'files.read',
      paths: ['legacy.txt'],
      expected_revision: node.revision,
    };
  const grant = devices.grantPersonalDevice('owner', node.id, key, input);
  const binding = {
    version: 1,
    id: randomUUID(),
    owner_id: 'owner',
    workspace_jid: 'web:owner',
    session_id: randomUUID(),
    conversation_id: 1,
    tool_task_id: 2,
    generation_task_id: 1,
    call_id: 'legacy-read',
    goal_run_id: null,
    node_id: node.id,
    grant_id: (grant as { id: string }).id,
    manifest_hash: node.manifest_hash,
    path: 'legacy.txt',
  };
  const digest = wire.deviceDigest(binding);
  expect(wire.DeviceBindingSchema.parse(binding)).toEqual(binding);
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    "DROP TABLE cloud_device_wakes;DROP TABLE cloud_device_requests;DROP TABLE cloud_device_grant_origins;ALTER TABLE personal_goal_teams DROP COLUMN device_resources;UPDATE router_state SET value='83' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
  expect(devices.grantPersonalDevice('owner', node.id, key, input)).toEqual(
    grant,
  );
  expect(
    devices.deviceGrantForFile('owner', 'web:owner', node.id, 'legacy.txt')
      .grant.id,
  ).toBe((grant as { id: string }).id);
  expect(wire.deviceDigest(wire.DeviceBindingSchema.parse(binding))).toBe(
    digest,
  );
  const directory = path.join(root, 'db/migration-backups'),
    backup = fs
      .readdirSync(directory)
      .find((name) =>
        name.startsWith(`messages-v83-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      )!;
  expect(backup).toBeTruthy();
  expect(fs.statSync(path.join(directory, backup)).mode & 0o777).toBe(0o600);
  const copy = new Database(path.join(directory, backup), { readonly: true });
  try {
    expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(
      copy
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='personal_goal_teams'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      copy
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='cloud_device_requests'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    copy.close();
  }
});
