import {
  DROP_V81_BOT_FIXTURE_SCHEMA,
  DROP_V80_BOT_FIXTURE_SCHEMA,
} from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-approval-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const approvals = await import('../src/personal-agent/approval-store.js');
const effects = await import('../src/personal-agent/artifact-effect.js');
let sessionId = '';
beforeAll(() => {
  db.initDatabase();
  for (const owner of ['alice', 'bob'])
    db.createUser({
      id: owner,
      username: owner,
      password_hash: 'fixture',
      display_name: owner,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  db.setRegisteredGroup('web:alice', {
    name: 'Alice',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    added_at: new Date().toISOString(),
    is_home: false,
  });
  sessionId = randomUUID();
  db.createAgent(
    {
      id: sessionId,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Approvals',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: 'alice',
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'frozen' },
  );
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function approve(toolId: number, content: string) {
  const row = approvals.requestArtifactApproval(sessionId, toolId, content);
  approvals.decideProductApproval(
    'alice',
    row.id,
    row.parameters_digest,
    'approve',
    randomUUID(),
  );
  return row;
}
test('binds approval to the original exact intent, owner and decision receipt across restart', () => {
  const row = approvals.requestArtifactApproval(sessionId, 1, 'exact content');
  expect(() =>
    effects.executeApprovedArtifact(row.id, 'alice', () => undefined),
  ).toThrow();
  expect(fs.existsSync(path.join(root, 'db/private-artifacts'))).toBe(false);
  expect(() => approvals.getProductApproval(row.id, 'bob')).toThrow();
  expect(() =>
    approvals.requestArtifactApproval(sessionId, 1, 'changed content'),
  ).toThrow();
  expect(() =>
    approvals.decideProductApproval(
      'alice',
      row.id,
      'changed',
      'approve',
      randomUUID(),
    ),
  ).toThrow();
  db.closeDatabase();
  db.initDatabase();
  expect(
    approvals.requestArtifactApproval(sessionId, 1, 'exact content').id,
  ).toBe(row.id);
  const key = randomUUID();
  expect(
    approvals.decideProductApproval(
      'alice',
      row.id,
      row.parameters_digest,
      'approve',
      key,
    ).state,
  ).toBe('approved');
  expect(
    approvals.decideProductApproval(
      'alice',
      row.id,
      row.parameters_digest,
      'approve',
      key,
    ).state,
  ).toBe('approved');
  expect(() =>
    approvals.decideProductApproval(
      'alice',
      row.id,
      row.parameters_digest,
      'deny',
      key,
    ),
  ).toThrow();
});
test('reconciles a completed file effect after the receipt gap without rewriting the file', () => {
  const row = approve(2, 'committed artifact');
  expect(() =>
    effects.executeApprovedArtifact(
      row.id,
      'alice',
      () => undefined,
      () => {
        throw new Error('injected receipt gap');
      },
    ),
  ).toThrow('injected');
  const filename = path.join(root, 'db/private-artifacts', `${row.id}.txt`);
  const before = fs.statSync(filename);
  expect(approvals.getProductApproval(row.id, 'alice').state).toBe('executing');
  db.closeDatabase();
  db.initDatabase();
  expect(
    effects.executeApprovedArtifact(row.id, 'alice', () => undefined).state,
  ).toBe('completed');
  expect(effects.readApprovedArtifact(row.id, 'alice')).toBe(
    'committed artifact',
  );
  expect(fs.statSync(filename).ino).toBe(before.ino);
  expect(fs.statSync(filename).mtimeMs).toBe(before.mtimeMs);
});
test('partial or replaced effects become uncertain and never overwrite an existing file', () => {
  const row = approve(3, 'expected complete content');
  const filename = path.join(root, 'db/private-artifacts', `${row.id}.txt`);
  fs.writeFileSync(filename, 'partial', { mode: 0o600 });
  expect(() =>
    effects.executeApprovedArtifact(row.id, 'alice', () => undefined),
  ).toThrow('uncertain');
  expect(approvals.getProductApproval(row.id, 'alice').state).toBe('uncertain');
  expect(fs.readFileSync(filename, 'utf8')).toBe('partial');
  expect(() =>
    effects.executeApprovedArtifact(row.id, 'alice', () => undefined),
  ).toThrow();
});
test('rechecks execution authorization immediately before any approved effect', () => {
  const row = approve(4, 'must not write');
  expect(() =>
    effects.executeApprovedArtifact(row.id, 'alice', () => {
      throw new Error('revoked');
    }),
  ).toThrow('revoked');
  expect(
    fs.existsSync(path.join(root, 'db/private-artifacts', `${row.id}.txt`)),
  ).toBe(false);
});
test('v71 migration preserves runtime identity and takes a private backup before approvals exist', () => {
  db.closeDatabase();
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  raw.exec(
    DROP_V81_BOT_FIXTURE_SCHEMA +
      DROP_V80_BOT_FIXTURE_SCHEMA +
      "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;DROP TABLE github_goal_events;DROP TABLE github_goal_triggers;DROP TABLE product_input_results;DROP TABLE product_queue_controls;DROP TABLE product_approval_decisions;DROP TABLE product_approvals;DROP TABLE goal_execution_contexts;DROP TRIGGER product_runtime_goal_identity_immutable;DROP INDEX product_runtime_goal_unique;ALTER TABLE product_session_runtimes DROP COLUMN goal_id;DROP INDEX idx_goal_automatic_task;ALTER TABLE personal_goal_tasks DROP COLUMN automatic;UPDATE router_state SET value='71' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  const backupName = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .find((name) =>
      name.startsWith(`messages-v71-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  const filename = path.join(root, 'db/migration-backups', backupName);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='product_approvals'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare(
          'SELECT runtime_kind FROM product_session_runtimes WHERE session_id=?',
        )
        .get(sessionId),
    ).toMatchObject({ runtime_kind: 'pi-durable' });
    expect(backup.prepare('PRAGMA integrity_check').get()).toMatchObject({
      integrity_check: 'ok',
    });
  } finally {
    backup.close();
  }
});
