import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v79-cloud-'));
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

test('v78 upgrade backs up the old admission trigger and preserves legacy Cloud binding bytes, budgets, Root and JSONL without creating Goal grants', () => {
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
  // Exactly remove the v79 additions and reinstate v78's original trigger.
  // This fixture contains no managed Cloud Sessions, which did not exist in v78.
  raw.exec(`DROP TABLE product_cloud_execution_attempts; DROP TABLE product_cloud_executions;
    DROP TRIGGER product_cloud_no_runtime_adoption;
    CREATE TRIGGER product_cloud_no_runtime_adoption BEFORE INSERT ON product_cloud_sessions
      WHEN NOT EXISTS(SELECT 1 FROM product_session_runtimes r WHERE r.session_id=NEW.session_id
        AND r.runtime_kind='pi-durable' AND r.state='provisioning' AND r.conversation_id IS NULL AND r.goal_id IS NULL)
        OR EXISTS(SELECT 1 FROM product_session_inputs i WHERE i.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'Cloud ownership must precede runtime admission'); END;
    UPDATE router_state SET value='78' WHERE key='schema_version';`);
  const oldTrigger = (
    raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='product_cloud_no_runtime_adoption'",
      )
      .get() as { sql: string }
  ).sql;
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
      name.startsWith(`messages-v78-to-v${db.CURRENT_SCHEMA_VERSION}-`),
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
    ).toEqual({ value: '78' });
    expect(
      backup
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='product_cloud_no_runtime_adoption'",
        )
        .get(),
    ).toEqual({ sql: oldTrigger });
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='product_cloud_executions'",
        )
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
    ).not.toEqual({ sql: oldTrigger });
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
