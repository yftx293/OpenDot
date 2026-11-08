import {
  DROP_V81_BOT_FIXTURE_SCHEMA,
  DROP_V80_BOT_FIXTURE_SCHEMA,
} from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-goals-'));
const store = path.join(root, 'db');
const filename = path.join(store, 'messages.db');
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');

beforeAll(() => {
  db.initDatabase();
  db.createUser({
    id: 'legacy-owner',
    username: 'legacy-owner',
    password_hash: 'test-hash',
    display_name: 'Owner',
    role: 'member',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    must_change_password: false,
  });
  db.setRegisteredGroup('web:legacy-goal', {
    name: 'Legacy workspace',
    folder: 'legacy-goal',
    created_by: 'legacy-owner',
    is_home: false,
    executionMode: 'container',
    added_at: new Date().toISOString(),
  });
  db.setSession('legacy-goal', 'unchanged-jsonl-session');
  db.createTask({
    id: 'legacy-scheduled-task',
    group_folder: 'legacy-goal',
    chat_jid: 'web:legacy-goal',
    prompt: 'Existing task',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    status: 'paused',
    next_run: null,
    created_at: new Date().toISOString(),
    created_by: 'legacy-owner',
  });
  db.closeDatabase();
  const raw = new Database(filename);
  raw.exec(
    DROP_V81_BOT_FIXTURE_SCHEMA +
      DROP_V80_BOT_FIXTURE_SCHEMA +
      `DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;DROP TABLE github_goal_events;DROP TABLE github_goal_triggers;DROP TABLE product_input_results;DROP TABLE product_queue_controls;DROP TABLE product_approval_decisions; DROP TABLE product_approvals; DROP TABLE product_session_inputs; DROP TABLE product_session_runtimes; DROP TABLE goal_execution_contexts; DROP TABLE personal_goal_events; DROP TABLE personal_goal_charges; DROP TABLE personal_goal_tasks; DROP TABLE personal_goals; UPDATE router_state SET value='69' WHERE key='schema_version';`,
  );
  raw.close();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v70 additive Personal Goal migration', () => {
  test('backs up v69 before changing schema and preserves existing tasks/sessions', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getSession('legacy-goal')).toBe('unchanged-jsonl-session');
    expect(db.getTaskById('legacy-scheduled-task')).toMatchObject({
      prompt: 'Existing task',
      status: 'paused',
      next_run: null,
    });
    expect(goals.listPersonalGoals('legacy-owner')).toEqual([]);
    const backups = fs
      .readdirSync(path.join(store, 'migration-backups'))
      .filter((name) =>
        name.startsWith(`messages-v69-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backups).toHaveLength(1);
    const backupPath = path.join(store, 'migration-backups', backups[0]);
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        backup
          .prepare("SELECT value FROM router_state WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '69' });
      expect(
        backup
          .prepare("SELECT name FROM sqlite_master WHERE name='personal_goals'")
          .get(),
      ).toBeUndefined();
      expect(
        backup
          .prepare(
            "SELECT prompt FROM scheduled_tasks WHERE id='legacy-scheduled-task'",
          )
          .get(),
      ).toEqual({ prompt: 'Existing task' });
    } finally {
      backup.close();
    }
  });
  test('reopening v70 is idempotent and retains newly created Goal history', () => {
    const goal = goals.createPersonalGoal('legacy-owner', 'migration-goal', {
      workspace_jid: 'web:legacy-goal',
      objective: 'Continue research',
      completion_criteria: ['Deliver findings'],
    });
    db.closeDatabase();
    db.initDatabase();
    expect(goals.getPersonalGoal('legacy-owner', goal.id)).toEqual(goal);
    expect(goals.listPersonalGoalEvents('legacy-owner', goal.id)).toHaveLength(
      1,
    );
    expect(
      fs
        .readdirSync(path.join(store, 'migration-backups'))
        .filter((name) =>
          name.startsWith(`messages-v69-to-v${db.CURRENT_SCHEMA_VERSION}-`),
        ),
    ).toHaveLength(1);
  });
});
