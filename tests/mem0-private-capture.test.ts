import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Mem0PrivateClient } from '../src/mem0-private-client.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-private-capture-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
}));
const config = await import('../src/mem0-private-config.js');
const recall = await import('../src/mem0-private-recall.js');
const capture = await import('../src/mem0-private-capture.js');
const databases: Database.Database[] = [];
afterEach(() => {
  capture.bindMem0PrivateCaptureDatabase(null);
  recall.bindMem0PrivateRecallDatabase(null);
  config.bindMem0PrivateConfigDatabase(null);
  for (const db of databases.splice(0)) db.close();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT,deleted_at TEXT);
    CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT);
    CREATE TABLE product_session_inputs(id TEXT PRIMARY KEY,session_id TEXT,state TEXT,payload TEXT,payload_digest TEXT,request_id TEXT,submission_id INTEGER);
    CREATE TABLE product_session_runtimes(session_id TEXT,owner_user_id TEXT,workspace_jid TEXT,group_folder TEXT,runtime_kind TEXT,state TEXT,goal_id TEXT);
    CREATE TABLE agents(id TEXT,created_by TEXT,chat_jid TEXT,group_folder TEXT,source_kind TEXT);
    CREATE TABLE workspace_agent_profiles(group_folder TEXT,agent_profile_id TEXT);
    CREATE TABLE product_input_results(input_id TEXT,session_id TEXT,answer_entry_id INTEGER);
    CREATE TABLE bot_group_dot_sessions(session_id TEXT);
    CREATE TABLE bot_groups(workspace_jid TEXT);
    CREATE TABLE bot_handoff_session_origins(session_id TEXT);
    CREATE TABLE agent_channel_mounts(session_id TEXT);
    CREATE TABLE product_cloud_sessions(session_id TEXT);
    INSERT INTO users VALUES('owner','active',NULL);
    INSERT INTO agent_profiles VALUES('dot-1','owner','active');
    INSERT INTO product_session_inputs VALUES('input-1','session-1','admitted','{"sender":"owner","content":"I like tea"}','digest-1','request-1',NULL);
    INSERT INTO product_session_runtimes VALUES('session-1','owner','private-workspace','folder-1','pi-durable','ready',NULL);
    INSERT INTO agents VALUES('session-1','owner','private-workspace','folder-1','manual');
    INSERT INTO workspace_agent_profiles VALUES('folder-1','dot-1');
  `);
  config.createMem0PrivateConfigSchema(db);
  recall.createMem0PrivateRecallSchema(db);
  capture.createMem0PrivateCaptureSchema(db);
  config.bindMem0PrivateConfigDatabase(db);
  recall.bindMem0PrivateRecallDatabase(db);
  capture.bindMem0PrivateCaptureDatabase(db);
  config.setMem0OwnerCredential('owner', 'secret-key');
  config.setMem0DotPolicy('owner', 'dot-1', {
    enabled: true,
    recallEnabled: false,
    captureEnabled: true,
  });
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ event_id: 'event-1', status: 'PENDING' }),
    );
  const client = (key: string) => new Mem0PrivateClient(key, send);
  const state = () =>
    db
      .prepare('SELECT * FROM mem0_private_capture_intents WHERE input_id=?')
      .get('input-1') as {
      state: string;
      ciphertext: string | null;
      event_id: string | null;
      reason: string | null;
    };
  const complete = () => {
    db.prepare(
      "UPDATE product_session_inputs SET state='completed',submission_id=1 WHERE id='input-1'",
    ).run();
    db.prepare('INSERT INTO product_input_results VALUES(?,?,?)').run(
      'input-1',
      'session-1',
      7,
    );
  };
  return { db, send, client, state, complete };
}

it('arms once, ignores native-ack, and adds only a completed bound answer', async () => {
  const { send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  capture.armMem0PrivateCapture('input-1', 'owner');
  expect(state()).toMatchObject({ state: 'awaiting_answer', ciphertext: null });
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).not.toHaveBeenCalled();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  expect(state().state).toBe('awaiting_answer');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  expect(state().state).toBe('pending');
  expect(state().ciphertext).not.toContain('I like tea');
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(state()).toMatchObject({
    state: 'accepted',
    event_id: 'event-1',
    ciphertext: null,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
    messages: [
      { role: 'user', content: 'I like tea' },
      { role: 'assistant', content: 'Noted.' },
    ],
    metadata: { turn_id: 'input-1' },
  });
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).toHaveBeenCalledTimes(1);
});

it('rolls back the claim when the budget is exhausted and resumes after budget returns', async () => {
  const { db, send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  vi.stubEnv('MINICLAW_MEM0_DAILY_BUDGET', '0');
  try {
    await capture.dispatchMem0PrivateCapture('input-1', client);
    expect(state().state).toBe('pending');
    expect(
      db
        .prepare(
          'SELECT attempts FROM mem0_private_capture_intents WHERE input_id=?',
        )
        .get('input-1'),
    ).toEqual({ attempts: 0 });
    expect(send).not.toHaveBeenCalled();
    vi.stubEnv('MINICLAW_MEM0_DAILY_BUDGET', '1');
    await capture.dispatchMem0PrivateCapture('input-1', client);
    expect(state().state).toBe('accepted');
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT used FROM mem0_daily_budget').get()).toEqual({
      used: 1,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('never arms Group input and cancels a pending intent when the audience changes', async () => {
  const { db, send, client, state, complete } = fixture();
  db.prepare('INSERT INTO bot_group_dot_sessions VALUES(?)').run('session-1');
  capture.armMem0PrivateCapture('input-1', 'owner');
  expect(
    db.prepare('SELECT * FROM mem0_private_capture_intents').all(),
  ).toEqual([]);
  db.prepare('DELETE FROM bot_group_dot_sessions').run();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  db.prepare('INSERT INTO bot_groups VALUES(?)').run('private-workspace');
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(state()).toMatchObject({ state: 'cancelled', ciphertext: null });
  expect(send).not.toHaveBeenCalled();
});

it('makes a lost add ACK uncertain and never automatically resends it', async () => {
  const { send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  send.mockRejectedValue(new Error('lost ACK'));
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(state()).toMatchObject({
    state: 'uncertain',
    reason: 'uncertain',
    ciphertext: null,
  });
  capture.recoverMem0PrivateCaptureSession('session-1');
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).toHaveBeenCalledTimes(1);
});

it('recovers a dispatching row as uncertain without reopening it', async () => {
  const { db, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  db.prepare(
    "UPDATE mem0_private_capture_intents SET state='dispatching' WHERE input_id='input-1'",
  ).run();
  capture.recoverMem0PrivateCaptureSession('session-1');
  expect(state()).toMatchObject({ state: 'uncertain', ciphertext: null });
  expect(() =>
    db
      .prepare(
        "UPDATE mem0_private_capture_intents SET state='pending' WHERE input_id='input-1'",
      )
      .run(),
  ).toThrow();
});

it('clears a pending pair on key rotation', () => {
  const { state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  config.setMem0OwnerCredential('owner', 'new-key');
  expect(state()).toMatchObject({ state: 'cancelled', ciphertext: null });
});

it('retries an explicit 429 only after its persisted delay', async () => {
  const { db, send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  send
    .mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    )
    .mockResolvedValueOnce(
      Response.json({ event_id: 'event-2', status: 'PENDING' }),
    );
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(state().state).toBe('rate_limited');
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).toHaveBeenCalledTimes(1);
  db.prepare(
    "UPDATE mem0_private_capture_intents SET retry_after_at=0 WHERE input_id='input-1'",
  ).run();
  db.prepare(
    "UPDATE mem0_scope_circuits SET until_ms=0 WHERE reason='rate_limited'",
  ).run();
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).toHaveBeenCalledTimes(2);
  expect(state()).toMatchObject({ state: 'accepted', event_id: 'event-2' });
});

it('bounds repeated explicit rate limits and clears the pair after three attempts', async () => {
  const { db, send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  send.mockResolvedValue(
    new Response('', { status: 429, headers: { 'retry-after': '1' } }),
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    db.prepare(
      "UPDATE mem0_private_capture_intents SET retry_after_at=0 WHERE input_id='input-1'",
    ).run();
    db.prepare(
      "UPDATE mem0_scope_circuits SET until_ms=0 WHERE reason='rate_limited'",
    ).run();
    await capture.dispatchMem0PrivateCapture('input-1', client);
  }
  expect(state()).toMatchObject({
    state: 'failed',
    reason: 'retry_exhausted',
    ciphertext: null,
    attempts: 3,
  });
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).toHaveBeenCalledTimes(3);
});

it('retires a failed input without ever creating a capture pair', () => {
  const { db, state } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  db.prepare(
    "UPDATE product_session_inputs SET state='failed' WHERE id='input-1'",
  ).run();
  expect(capture.recoverMem0PrivateCaptureSession('session-1')).toEqual([]);
  expect(state()).toMatchObject({ state: 'cancelled', ciphertext: null });
});

it('never sends a completed pair containing a likely API credential', async () => {
  const { send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'oc_sk_abcdefghijklmnop',
  );
  expect(state()).toMatchObject({
    state: 'failed',
    reason: 'sensitive_pair',
    ciphertext: null,
  });
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).not.toHaveBeenCalled();
});

it('expires unsent encrypted captures without sending or altering the chat', async () => {
  const { send, client, state, complete } = fixture();
  capture.armMem0PrivateCapture('input-1', 'owner');
  complete();
  capture.finalizeMem0PrivateCapture(
    'input-1',
    'owner',
    'I like tea',
    'Noted.',
  );
  expect(state().state).toBe('pending');
  expect(
    capture.expireUnsentMem0Captures(Date.now() + 25 * 60 * 60 * 1000).durable,
  ).toBe(1);
  expect(state()).toMatchObject({
    state: 'cancelled',
    reason: 'retention_expired',
    ciphertext: null,
  });
  await capture.dispatchMem0PrivateCapture('input-1', client);
  expect(send).not.toHaveBeenCalled();
});
