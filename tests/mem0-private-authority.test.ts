import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { privateMem0ProductInput } from '../src/mem0-private-authority.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE product_session_inputs(id TEXT,session_id TEXT,state TEXT,payload TEXT);
    CREATE TABLE product_session_runtimes(session_id TEXT,owner_user_id TEXT,workspace_jid TEXT,group_folder TEXT,runtime_kind TEXT,state TEXT,goal_id TEXT);
    CREATE TABLE agents(id TEXT,created_by TEXT,chat_jid TEXT,group_folder TEXT,source_kind TEXT);
    CREATE TABLE workspace_agent_profiles(group_folder TEXT,agent_profile_id TEXT);
    CREATE TABLE agent_profiles(id TEXT,owner_user_id TEXT,status TEXT);
    CREATE TABLE product_input_results(input_id TEXT,session_id TEXT,answer_entry_id INTEGER);
    CREATE TABLE bot_group_dot_sessions(session_id TEXT);
    CREATE TABLE bot_groups(workspace_jid TEXT);
    CREATE TABLE bot_handoff_session_origins(session_id TEXT);
    CREATE TABLE agent_channel_mounts(session_id TEXT);
    CREATE TABLE product_cloud_sessions(session_id TEXT);
    INSERT INTO product_session_inputs VALUES('input-1','session-1','submitted','{"sender":"owner","content":"hello","origin":null}');
    INSERT INTO product_session_runtimes VALUES('session-1','owner','private-workspace','folder-1','pi-durable','ready',NULL);
    INSERT INTO agents VALUES('session-1','owner','private-workspace','folder-1','manual');
    INSERT INTO workspace_agent_profiles VALUES('folder-1','dot-1');
    INSERT INTO agent_profiles VALUES('dot-1','owner','active');
  `);
  const resolve = (purpose: 'recall' | 'capture', ownerUserId = 'owner') =>
    privateMem0ProductInput(db, {
      inputId: 'input-1',
      ownerUserId,
      installationId: 'install',
      environment: 'test',
      purpose,
    });
  return { db, resolve };
}

it('admits only a real owner-private input and never treats native-ack as completion', () => {
  const { db, resolve } = fixture();
  expect(resolve('recall')?.scope.run_id).toBe('session-1');
  expect(resolve('recall', 'other-owner')).toBeNull();
  expect(resolve('capture')).toBeNull();
  db.prepare("UPDATE product_session_inputs SET state='completed'").run();
  expect(resolve('capture')).toBeNull();
  db.prepare('INSERT INTO product_input_results VALUES(?,?,?)').run(
    'input-1',
    'session-1',
    7,
  );
  expect(resolve('capture')?.profileId).toBe('dot-1');
  expect(resolve('recall')).toBeNull();
});

it('denies channel-origin, foreign sender and execution payloads even inside a private Dot', () => {
  const { db, resolve } = fixture();
  const update = (payload: object) =>
    db
      .prepare('UPDATE product_session_inputs SET payload=?')
      .run(JSON.stringify(payload));
  for (const payload of [
    { sender: 'another-user' },
    { sender: 'owner', origin: { sourceJid: 'telegram:remote' } },
    { sender: 'owner', origin: { senderId: 'another-user' } },
    { sender: 'owner', origin: { channelContext: { type: 'im' } } },
    { sender: 'owner', execution: { runId: 'goal' } },
  ]) {
    update(payload);
    expect(resolve('recall')).toBeNull();
  }
  update({
    sender: 'owner',
    origin: {
      sourceJid: 'private-workspace#agent:session-1',
      senderId: 'owner',
      channelContext: null,
    },
  });
  expect(resolve('recall')?.profileId).toBe('dot-1');
});

it('denies serial Group, every member-inbox input kind, handoff, Goal, channel and Cloud origins', () => {
  for (const deny of [
    (db: Database.Database) =>
      db.prepare('INSERT INTO bot_groups VALUES(?)').run('private-workspace'),
    (db: Database.Database) =>
      db
        .prepare('INSERT INTO bot_group_dot_sessions VALUES(?)')
        .run('session-1'),
    (db: Database.Database) =>
      db
        .prepare('INSERT INTO bot_handoff_session_origins VALUES(?)')
        .run('session-1'),
    (db: Database.Database) =>
      db.prepare('INSERT INTO agent_channel_mounts VALUES(?)').run('session-1'),
    (db: Database.Database) =>
      db
        .prepare('INSERT INTO product_cloud_sessions VALUES(?)')
        .run('session-1'),
    (db: Database.Database) =>
      db.prepare("UPDATE product_session_runtimes SET goal_id='goal-1'").run(),
    (db: Database.Database) =>
      db.prepare("UPDATE agents SET source_kind='native_thread'").run(),
  ]) {
    const { db, resolve } = fixture();
    deny(db);
    for (const kind of ['root', 'question', 'reply', 'control']) {
      db.prepare('UPDATE product_session_inputs SET id=?').run(kind);
      expect(
        privateMem0ProductInput(db, {
          inputId: kind,
          ownerUserId: 'owner',
          installationId: 'install',
          environment: 'test',
          purpose: 'recall',
        }),
      ).toBeNull();
    }
    expect(resolve('recall')).toBeNull();
  }
});
