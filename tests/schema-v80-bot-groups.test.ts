import { DROP_GROUP_DISCUSSION_FIXTURE_SCHEMA } from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v80-groups-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('v79 upgrade adds empty Group tables after a private backup and preserves Cloud ownership, budgets, Root and JSONL byte for byte', () => {
  db.initDatabase();
  const now = new Date().toISOString(),
    id = randomUUID(),
    nodeId = randomUUID();
  db.createUser({
    id: 'owner',
    username: 'owner',
    display_name: 'Owner',
    password_hash: 'fixture',
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
  for (const session of [id, nodeId])
    db.createAgent(
      {
        id: session,
        chat_jid: 'web:owner',
        group_folder: 'owner',
        name: 'Legacy',
        prompt: '',
        kind: 'conversation',
        status: 'idle',
        created_by: 'owner',
        created_at: now,
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      },
      session === id
        ? {
            kind: 'pi-durable',
            providerId: 'legacy-provider',
            configFingerprint: 'f'.repeat(64),
            cloud: {
              runtime_id: randomUUID(),
              gateway_origin: 'https://cloud.fixture',
              model_id: 'fixture-model',
              instructions: 'Legacy v78 instructions',
              max_model_steps: 24,
              deadline_at: Date.now() + 60000,
            },
          }
        : { kind: 'pi-coding-agent' },
    );
  product.bindCloudObject(
    id,
    product.getCloudPlacement(id)!.runtime_id,
    'a'.repeat(64),
  );
  product.bindProductConversation(id, 1);
  product.admitCloudModelAttempt(id, randomUUID(), 'b'.repeat(64));
  db.setSession('owner', 'legacy-jsonl-identity', nodeId);
  const original = product.getCloudPlacement(id)!;
  expect(() =>
    product.admitCloudModelAttempt(id, randomUUID(), 'c'.repeat(64), {
      goal_id: randomUUID(),
      run_id: randomUUID(),
      context_digest: 'd'.repeat(64),
    }),
  ).toThrow('Ordinary Cloud Session cannot acquire a Goal grant');
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  // Reconstruct v79 without the later discussion ownership triggers/tables.
  raw.exec(
    DROP_GROUP_DISCUSSION_FIXTURE_SCHEMA +
      `DROP TABLE bot_group_feedback_exports; DROP TABLE bot_group_feedback_requests; DROP TABLE bot_group_message_feedback;
    DROP TABLE product_input_task_sources; DROP TABLE bot_handoff_session_origins; DROP TABLE bot_group_handoffs; DROP TABLE bot_group_runtime_grants; DROP TABLE bot_group_receipts; DROP TABLE bot_group_messages;
    DROP TABLE bot_group_members; DROP TABLE bot_groups;
    UPDATE router_state SET value='79' WHERE key='schema_version';`,
  );
  const originalTrigger = (
    raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='product_cloud_no_runtime_adoption'",
      )
      .get() as { sql: string }
  ).sql;
  // Equivalent v79 trigger with a distinguishing retained SQL comment proves
  // v80 never drops/rebuilds unrelated ownership guards during this upgrade.
  const oldTrigger = originalTrigger.replace(
    'BEFORE INSERT',
    'BEFORE INSERT /* retained v79 ownership */',
  );
  raw.exec('DROP TRIGGER product_cloud_no_runtime_adoption; ' + oldTrigger);
  raw.close();
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
  expect(product.getCloudPlacement(id)).toEqual(original);
  expect(product.getProductRuntime(id)).toMatchObject({
    state: 'ready',
    conversation_id: 1,
    goal_id: null,
  });
  expect(product.productRouterKind(nodeId)).toBe('local-pi');
  expect(db.getSession('owner', nodeId)).toBe('legacy-jsonl-identity');
  const files = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .filter((name) =>
      name.startsWith(`messages-v79-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
  expect(files).toHaveLength(1);
  const filename = path.join(root, 'db/migration-backups', files[0]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new Database(filename, { readonly: true });
  try {
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup
        .prepare("SELECT value FROM router_state WHERE key='schema_version'")
        .get(),
    ).toEqual({ value: '79' });
    expect(
      backup
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='product_cloud_no_runtime_adoption'",
        )
        .get(),
    ).toEqual({ sql: oldTrigger });
    expect(
      backup
        .prepare("SELECT name FROM sqlite_master WHERE name='bot_groups'")
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare('SELECT * FROM product_cloud_sessions WHERE session_id=?')
        .get(id),
    ).toEqual(original);
  } finally {
    backup.close();
  }
  const current = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(
      current.prepare('SELECT * FROM product_cloud_executions').all(),
    ).toEqual([]);
    expect(
      current.prepare('SELECT * FROM product_cloud_execution_attempts').all(),
    ).toEqual([]);
    expect(
      current
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='product_cloud_no_runtime_adoption'",
        )
        .get(),
    ).toEqual({ sql: oldTrigger });
    for (const table of [
      'bot_groups',
      'bot_group_members',
      'bot_group_messages',
      'bot_group_receipts',
    ])
      expect(
        current.prepare('SELECT count(*) AS n FROM ' + table).get(),
      ).toEqual({ n: 0 });
    expect(current.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    current.close();
  }
  db.closeDatabase();
  db.initDatabase();
  expect(
    fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((name) => name.endsWith('.db')),
  ).toHaveLength(1);
  expect(product.getCloudPlacement(id)).toEqual(original);
});
