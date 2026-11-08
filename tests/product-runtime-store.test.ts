import {
  DROP_V81_BOT_FIXTURE_SCHEMA,
  DROP_V80_BOT_FIXTURE_SCHEMA,
} from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-runtime-store-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const runtime = await import('../src/personal-agent/product-runtime-store.js');
beforeAll(() => {
  db.initDatabase();
  for (const owner of ['alice', 'bob']) {
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
    db.setRegisteredGroup(`web:${owner}`, {
      name: owner,
      folder: owner,
      created_by: owner,
      executionMode: 'host',
      added_at: new Date().toISOString(),
      is_home: false,
    });
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function session(kind: 'pi-coding-agent' | 'pi-durable' = 'pi-durable') {
  const id = randomUUID();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Runtime session',
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
    {
      kind,
      providerId: kind === 'pi-durable' ? 'configured-provider' : null,
      configFingerprint: 'frozen',
    },
  );
  return id;
}
test('persists engine selection and provisioning across reopen; flag changes cannot switch it', () => {
  const id = session();
  expect(runtime.requireProductRuntime(id, 'alice')).toMatchObject({
    runtime_kind: 'pi-durable',
    state: 'provisioning',
    conversation_id: null,
  });
  vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'false');
  db.closeDatabase();
  db.initDatabase();
  expect(runtime.requireProductRuntime(id, 'alice').runtime_kind).toBe(
    'pi-durable',
  );
  vi.unstubAllEnvs();
  runtime.bindProductConversation(id, 7);
  expect(runtime.requireProductRuntime(id, 'alice')).toMatchObject({
    conversation_id: 7,
    state: 'ready',
  });
  expect(() => runtime.bindProductConversation(id, 8)).toThrow();
});
test('uses exact owner/workspace/session identity and rechecks revocation', () => {
  const id = session();
  expect(() => runtime.requireProductRuntime(id, 'bob')).toThrow();
  db.setRegisteredGroup('web:alice', {
    name: 'changed',
    folder: 'alice',
    created_by: 'bob',
    executionMode: 'host',
    added_at: new Date().toISOString(),
    is_home: false,
  });
  expect(() => runtime.requireProductRuntime(id, 'alice')).toThrow();
  db.setRegisteredGroup('web:alice', {
    name: 'alice',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    added_at: new Date().toISOString(),
    is_home: false,
  });
});
test('binds the full admitted payload and projects each user message only once', () => {
  const id = session();
  const requestId = randomUUID();
  let projections = 0;
  const payload = {
    content: 'Research',
    followUpBehavior: 'queue' as const,
    sender: 'alice',
    senderName: 'Alice',
  };
  const first = runtime.admitProductInput(id, requestId, payload, () => {
    projections++;
  });
  const second = runtime.admitProductInput(id, requestId, payload, () => {
    projections++;
  });
  expect(second.id).toBe(first.id);
  expect(projections).toBe(1);
  expect(() =>
    runtime.admitProductInput(
      id,
      requestId,
      { ...payload, followUpBehavior: 'steer' },
      () => {},
    ),
  ).toThrow();
  expect(() =>
    runtime.admitProductInput(
      id,
      requestId,
      { ...payload, content: 'Different' },
      () => {},
    ),
  ).toThrow();
  expect(() =>
    runtime.admitProductInput(
      id,
      requestId,
      { ...payload, sender: 'bob' },
      () => {},
    ),
  ).toThrow();
});
test('legacy/default conversations stay on Coding Agent and cannot acquire a Durable binding', () => {
  const id = session('pi-coding-agent');
  expect(runtime.requireProductRuntime(id, 'alice').runtime_kind).toBe(
    'pi-coding-agent',
  );
  expect(() => runtime.bindProductConversation(id, 9)).toThrow();
});

test('terminal provider failure is persisted with the input receipt', () => {
  const id = session();
  runtime.bindProductConversation(id, 150);
  const input = runtime.admitProductInput(
    id,
    'provider-403',
    {
      content: 'use an unavailable model',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    },
    () => {},
  );
  runtime.finishProductInput(input.id, false, () => {}, {
    kind: 'provider',
    status: 403,
    message: 'model not available in your country',
    retryable: false,
    hint: '请检查模型配置、服务地区或网络设置后再试。',
  });
  expect(runtime.listProductInputs(id).at(-1)).toMatchObject({
    state: 'failed',
    failure_json: expect.stringContaining('"status":403'),
  });
  expect(
    runtime.productInputFailure(runtime.listProductInputs(id).at(-1)!),
  ).toMatchObject({
    kind: 'provider',
    status: 403,
    retryable: false,
  });
});

test('shared answers project once and a persisted input cannot bind to a different checkpoint answer', () => {
  const id = session();
  runtime.bindProductConversation(id, 100);
  const inputs = ['first', 'second'].map((requestId) =>
    runtime.admitProductInput(
      id,
      requestId,
      {
        content: requestId,
        followUpBehavior: 'queue',
        sender: 'alice',
        senderName: 'Alice',
      },
      () => {},
    ),
  );
  const projections: string[] = [];
  for (const input of inputs)
    runtime.finishProductInput(input.id, true, () => {
      const answer = runtime.bindProductAnswer(input, 101);
      if (answer.project) projections.push(answer.messageId);
    });
  expect(projections).toHaveLength(1);
  expect(runtime.productAnswerMessageId(inputs[0].id)).toBe(
    runtime.productAnswerMessageId(inputs[1].id),
  );
  expect(() => runtime.bindProductAnswer(inputs[0], 102)).toThrow(
    'checkpoint binding changed',
  );
});
test('v73 upgrade preserves inputs and runtime identity with a private pre-v74 backup', () => {
  const id = session();
  runtime.bindProductConversation(id, 90);
  const input = runtime.admitProductInput(
    id,
    'before-v74',
    {
      content: 'legacy pending input',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    },
    () => {},
  );
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    DROP_V81_BOT_FIXTURE_SCHEMA +
      DROP_V80_BOT_FIXTURE_SCHEMA +
      "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;DROP TABLE github_goal_events;DROP TABLE github_goal_triggers;DROP TABLE product_input_results;DROP TABLE product_queue_controls;UPDATE router_state SET value='73' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(runtime.requireProductRuntime(id, 'alice').conversation_id).toBe(90);
  expect(runtime.listProductInputs(id)[0]).toEqual(input);
  expect(runtime.listQueueControls(id)).toEqual([]);
  const current = new Database(path.join(root, 'db/messages.db'), {
    readonly: true,
  });
  expect(
    current
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('product_input_results','product_queue_controls') ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: 'product_input_results' },
    { name: 'product_queue_controls' },
  ]);
  current.close();
  const backup = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .find((name) =>
      name.startsWith(`messages-v73-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  expect(backup).toBeTruthy();
  const filename = path.join(root, 'db/migration-backups', backup);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const snapshot = new Database(filename, { readonly: true });
  expect(
    snapshot
      .prepare("SELECT value FROM router_state WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: '73' });
  expect(
    snapshot
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='product_queue_controls'",
      )
      .get(),
  ).toBeUndefined();
  expect(snapshot.prepare('PRAGMA integrity_check').get()).toEqual({
    integrity_check: 'ok',
  });
  snapshot.close();
});
