import {
  DROP_V81_BOT_FIXTURE_SCHEMA,
  DROP_V80_BOT_FIXTURE_SCHEMA,
} from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v71-runtime-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const runtime = await import('../src/personal-agent/product-runtime-store.js');
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
test('backs up v70 and explicitly assigns existing sessions to Coding Agent even when the flag enables new Durable sessions', () => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'legacy',
    username: 'legacy',
    password_hash: 'fixture',
    display_name: 'legacy',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:legacy', {
    name: 'legacy',
    folder: 'legacy',
    created_by: 'legacy',
    added_at: now,
    executionMode: 'host',
    is_home: false,
  });
  db.createAgent({
    id: 'legacy-session',
    chat_jid: 'web:legacy',
    group_folder: 'legacy',
    name: 'Legacy',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'legacy',
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  db.setSession('legacy', 'original-jsonl', 'legacy-session');
  db.closeDatabase();
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  raw.exec(
    DROP_V81_BOT_FIXTURE_SCHEMA +
      DROP_V80_BOT_FIXTURE_SCHEMA +
      "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;DROP TABLE github_goal_events;DROP TABLE github_goal_triggers;DROP TABLE product_input_results;DROP TABLE product_queue_controls;DROP TABLE product_approval_decisions;DROP TABLE product_approvals;DROP TABLE product_session_inputs;DROP TABLE product_session_runtimes;DROP TABLE goal_execution_contexts;DROP INDEX idx_goal_automatic_task;ALTER TABLE personal_goal_tasks DROP COLUMN automatic;UPDATE router_state SET value='70' WHERE key='schema_version'",
  );
  raw.close();
  vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'true');
  db.initDatabase();
  expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
  expect(
    runtime.requireProductRuntime('legacy-session', 'legacy'),
  ).toMatchObject({
    runtime_kind: 'pi-coding-agent',
    state: 'ready',
    conversation_id: null,
  });
  expect(db.getSession('legacy', 'legacy-session')).toBe('original-jsonl');
  const backups = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .filter((name) =>
      name.startsWith(`messages-v70-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
  expect(backups).toHaveLength(1);
  const filename = path.join(root, 'db/migration-backups', backups[0]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(
      backup
        .prepare("SELECT value FROM router_state WHERE key='schema_version'")
        .get(),
    ).toMatchObject({ value: '70' });
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='product_session_runtimes'",
        )
        .get(),
    ).toBeUndefined();
    expect(backup.prepare('PRAGMA integrity_check').get()).toMatchObject({
      integrity_check: 'ok',
    });
  } finally {
    backup.close();
  }
});
