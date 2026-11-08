import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { Mem0PrivateClient } from '../src/mem0-private-client.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-coding-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
}));
const config = await import('../src/mem0-private-config.js');
const recall = await import('../src/mem0-private-recall.js');
const capture = await import('../src/mem0-private-capture.js');
let db: Database.Database;
afterEach(() => {
  recall.bindMem0PrivateRecallDatabase(null);
  capture.bindMem0PrivateCaptureDatabase(null);
  config.bindMem0PrivateConfigDatabase(null);
  db?.close();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture() {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT,deleted_at TEXT);
    CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,owner_user_id TEXT,status TEXT);
    CREATE TABLE product_session_inputs(id TEXT PRIMARY KEY,session_id TEXT,state TEXT,payload TEXT,payload_digest TEXT,request_id TEXT,submission_id INTEGER);
    CREATE TABLE product_session_runtimes(session_id TEXT PRIMARY KEY,owner_user_id TEXT,workspace_jid TEXT,group_folder TEXT,runtime_kind TEXT,state TEXT,goal_id TEXT);
    CREATE TABLE agents(id TEXT,created_by TEXT,chat_jid TEXT,group_folder TEXT,source_kind TEXT,kind TEXT,last_im_jid TEXT);
    CREATE TABLE router_state(key TEXT,value TEXT);
    CREATE TABLE workspace_agent_profiles(group_folder TEXT,agent_profile_id TEXT);
    CREATE TABLE messages(id TEXT,chat_jid TEXT,content TEXT,sender TEXT,is_from_me INTEGER,task_id TEXT,source_jid TEXT,channel_context TEXT,source_kind TEXT,turn_id TEXT,finalization_reason TEXT);
    CREATE TABLE bot_group_dot_sessions(session_id TEXT); CREATE TABLE bot_groups(workspace_jid TEXT);
    CREATE TABLE bot_handoff_session_origins(session_id TEXT); CREATE TABLE agent_channel_mounts(session_id TEXT); CREATE TABLE product_cloud_sessions(session_id TEXT);
    INSERT INTO users VALUES('owner','active',NULL); INSERT INTO agent_profiles VALUES('dot','owner','active');
    INSERT INTO product_session_runtimes VALUES('session','owner','web:private','folder','pi-coding-agent','ready',NULL);
    INSERT INTO agents VALUES('session','owner','web:private','folder','manual','conversation',NULL);
    INSERT INTO workspace_agent_profiles VALUES('folder','dot');
    INSERT INTO messages VALUES('input','web:private#agent:session','tea','owner',0,NULL,NULL,NULL,NULL,NULL,NULL);
  `);
  config.createMem0PrivateConfigSchema(db);
  recall.createMem0PrivateRecallSchema(db);
  capture.createMem0PrivateCaptureSchema(db);
  config.bindMem0PrivateConfigDatabase(db);
  recall.bindMem0PrivateRecallDatabase(db);
  capture.bindMem0PrivateCaptureDatabase(db);
  config.setMem0OwnerCredential('owner', 'key');
  config.setMem0DotPolicy('owner', 'dot', {
    enabled: true,
    recallEnabled: true,
    captureEnabled: false,
  });
  const send = vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    return Response.json({
      results: [
        {
          id: 'hit',
          memory: 'tea preference',
          score: 0.9,
          app_id: body.filters.AND[0].app_id,
          user_id: body.filters.AND[1].OR[0].user_id,
        },
      ],
    });
  });
  const input = {
    sessionId: 'session',
    ownerId: 'owner',
    messageId: 'input',
    assertActive: () => {},
  };
  return {
    send,
    input,
    client: (key: string) => new Mem0PrivateClient(key, send),
  };
}
it('freezes one owner-private lookup and never refetches on retry', async () => {
  const f = fixture();
  expect(await recall.codingMem0Recall(f.input, f.client)).toContain(
    'tea preference',
  );
  expect(await recall.codingMem0Recall(f.input, f.client)).toContain(
    'tea preference',
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(
      db.prepare('SELECT ciphertext FROM mem0_coding_recall_snapshots').get(),
    ),
  ).not.toContain('tea preference');
});
it('does not query channel, group, foreign sender or scheduled inputs', async () => {
  const f = fixture();
  for (const mutation of [
    "UPDATE messages SET sender='another'",
    "UPDATE messages SET source_jid='telegram:group'",
    "UPDATE messages SET task_id='task'",
    "INSERT INTO bot_group_dot_sessions VALUES('session')",
  ]) {
    db.exec('SAVEPOINT change');
    db.exec(mutation);
    expect(await recall.codingMem0Recall(f.input, f.client)).toBeNull();
    db.exec('ROLLBACK TO change');
    db.exec('RELEASE change');
  }
  expect(f.send).not.toHaveBeenCalled();
});
it('does not reveal a snapshot when credentials are removed and recreated', async () => {
  const f = fixture();
  await recall.codingMem0Recall(f.input, f.client);
  config.clearMem0OwnerCredential('owner');
  config.setMem0OwnerCredential('owner', 'new-key');
  expect(await recall.codingMem0Recall(f.input, f.client)).toBeNull();
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('captures only an admission-frozen private input with its committed final answer', async () => {
  const f = fixture();
  config.setMem0DotPolicy('owner', 'dot', {
    enabled: true,
    recallEnabled: true,
    captureEnabled: true,
  });
  const admitted = {
    sessionId: 'session',
    ownerId: 'owner',
    messageId: 'input',
    turnId: 'turn-1',
  };
  const id = capture.armCodingMem0Capture(admitted)!;
  expect(capture.getArmedCodingMem0Capture(admitted)).toBe(id);
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'partial',
    'web:private#agent:session',
    'partial',
    'miniclaw-agent',
    1,
    null,
    null,
    null,
    'sdk_final',
    'turn-1',
    'interrupted',
  );
  expect(capture.finalizeCodingMem0Capture(id, 'partial')).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});

it('sends a completed pair once and records asynchronous acceptance, not completion', async () => {
  const f = fixture();
  config.setMem0DotPolicy('owner', 'dot', {
    enabled: true,
    recallEnabled: true,
    captureEnabled: true,
  });
  const id = capture.armCodingMem0Capture({
    sessionId: 'session',
    ownerId: 'owner',
    messageId: 'input',
    turnId: 'turn-1',
  })!;
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'answer',
    'web:private#agent:session',
    'I will remember tea',
    'miniclaw-agent',
    1,
    null,
    null,
    null,
    'sdk_final',
    'turn-1',
    'completed',
  );
  expect(capture.finalizeCodingMem0Capture(id, 'answer')).toBe(true);
  const send = vi.fn<typeof fetch>(async () =>
    Response.json({ status: 'PENDING', event_id: 'event-1' }),
  );
  const factory = (key: string) => new Mem0PrivateClient(key, send);
  await capture.dispatchCodingMem0Capture(id, factory);
  await capture.dispatchCodingMem0Capture(id, factory);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    db
      .prepare(
        'SELECT state,event_id FROM mem0_coding_capture_intents WHERE id=?',
      )
      .get(id),
  ).toEqual({ state: 'accepted', event_id: 'event-1' });
});
