import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-schema-v87-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
test('v86 upgrade backs up canonical Group data, creates empty discussion associations and refuses downgrade', async () => {
  const db = await import('../src/db.js');
  const groups = await import('../src/bot-groups/store.js');
  const file = path.join(root, 'db/messages.db');
  try {
    db.initDatabase();
    const stamp = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      password_hash: 'fixture',
      display_name: 'Alice',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: stamp,
      updated_at: stamp,
    });
    const profile = db.getOrCreateDefaultAgentProfile('alice');
    db.setRegisteredGroup('web:alice', {
      name: 'Alice',
      folder: 'alice',
      created_by: 'alice',
      executionMode: 'host',
      is_home: false,
      added_at: stamp,
    });
    db.assignWorkspaceAgentProfile('alice', profile.id);
    const id = groups.createBotGroup('alice', crypto.randomUUID(), {
      workspace_jid: 'web:alice',
      name: 'Existing team',
    }).group_id;
    groups.postBotGroupMessage('alice', id, crypto.randomUUID(), {
      content: 'CANONICAL_BEFORE_UPGRADE',
      dispatch: false,
    });
    db.closeDatabase();
    const old = new Database(file);
    old.exec(
      'DROP TABLE bot_group_discussion_work; DROP TABLE bot_group_discussion_turns; DROP TABLE bot_group_discussions; DROP TABLE bot_group_discussion_settings; DROP TABLE bot_group_dot_sessions;',
    );
    old
      .prepare("UPDATE router_state SET value='86' WHERE key='schema_version'")
      .run();
    old.close();
    db.initDatabase();
    expect(
      groups
        .getBotGroupSnapshot('alice', id)
        .messages.some((m) => m.content === 'CANONICAL_BEFORE_UPGRADE'),
    ).toBe(true);
    const current = new Database(file, { readonly: true });
    expect(
      current.prepare('SELECT COUNT(*) n FROM bot_group_dot_sessions').get(),
    ).toEqual({ n: 0 });
    expect(
      current.prepare('SELECT COUNT(*) n FROM bot_group_discussions').get(),
    ).toEqual({ n: 0 });
    expect(
      current.prepare('SELECT COUNT(*) n FROM bot_group_discussion_work').get(),
    ).toEqual({ n: 0 });
    // Deferred-work columns and the slot index exist on the upgraded schema.
    expect(
      current
        .prepare('PRAGMA table_info(bot_group_discussion_turns)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'parked_at',
        'parked_reason',
        'relay_from_turn_id',
      ]),
    );
    expect(
      current
        .prepare('PRAGMA table_info(bot_group_discussions)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).toEqual(
      expect.arrayContaining([
        'continued_from_run_id',
        'awaiting_results_since',
      ]),
    );
    expect(
      current
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='bot_group_one_active_turn'",
        )
        .get(),
    ).toEqual({ name: 'bot_group_one_active_turn' });
    current.close();
    const backups = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((f) =>
        f.startsWith(`messages-v86-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backups).toHaveLength(1);
    const backup = new Database(
      path.join(root, 'db/migration-backups', backups[0]),
      { readonly: true },
    );
    expect(
      backup
        .prepare(
          "SELECT content FROM bot_group_messages WHERE content='CANONICAL_BEFORE_UPGRADE'",
        )
        .get(),
    ).toEqual({ content: 'CANONICAL_BEFORE_UPGRADE' });
    backup.close();
    db.closeDatabase();
    // Reconstruct the actual pre-follow-up v87 shape with a frozen pending
    // turn. A fresh v86 database alone cannot exercise additive-column upgrade.
    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE bot_group_discussion_work;
      DROP TRIGGER bot_group_discussion_policy_identity;
      DROP TRIGGER bot_group_discussion_protocol_identity;
      DROP TRIGGER bot_group_turn_park_immutable;
      DROP INDEX bot_group_one_active_turn;
      ALTER TABLE bot_group_dot_sessions DROP COLUMN stop_error_code;
      ALTER TABLE bot_group_discussion_settings DROP COLUMN policy;
      ALTER TABLE bot_group_discussions DROP COLUMN policy;
      ALTER TABLE bot_group_discussions DROP COLUMN protocol_version;
      ALTER TABLE bot_group_discussions DROP COLUMN relay_queue;
      ALTER TABLE bot_group_discussions DROP COLUMN pending_relay_from_turn_id;
      ALTER TABLE bot_group_discussions DROP COLUMN continued_from_run_id;
      ALTER TABLE bot_group_discussions DROP COLUMN awaiting_results_since;
      ALTER TABLE bot_group_discussion_turns DROP COLUMN parked_at;
      ALTER TABLE bot_group_discussion_turns DROP COLUMN parked_reason;
      ALTER TABLE bot_group_discussion_turns DROP COLUMN relay_from_turn_id;
      CREATE UNIQUE INDEX bot_group_one_pending_turn ON bot_group_discussion_turns(run_id) WHERE state='pending';
      UPDATE router_state SET value='87' WHERE key='schema_version';
    `);
    const rootMessage = legacy
      .prepare(
        "SELECT id,seq FROM bot_group_messages WHERE group_id=? AND author_kind='user' LIMIT 1",
      )
      .get(id) as { id: string; seq: number };
    legacy
      .prepare(
        `INSERT INTO bot_group_discussions(id,group_id,owner_user_id,root_message_id,coordinator_profile_id,participant_profile_ids,status,phase,max_turns,max_turns_per_dot,max_model_attempts,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,'running','coordinator',6,2,24,?,?,?)`,
      )
      .run(
        'legacy-run',
        id,
        'alice',
        rootMessage.id,
        profile.id,
        JSON.stringify([profile.id]),
        stamp,
        stamp,
        Date.now() + 60000,
      );
    const frozenPayload = JSON.stringify({ content: 'LEGACY_FROZEN_INPUT' });
    legacy
      .prepare(
        `INSERT INTO bot_group_discussion_turns(id,run_id,ordinal,profile_id,role,session_id,grant_id,request_id,payload,context_through_seq,state) VALUES('legacy-turn','legacy-run',1,?,'coordinator','legacy-session','legacy-grant','legacy-request',?,?,'pending')`,
      )
      .run(profile.id, frozenPayload, rootMessage.seq);
    legacy.close();
    db.initDatabase();
    const upgraded = new Database(file);
    expect(
      upgraded
        .prepare('PRAGMA table_info(bot_group_dot_sessions)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).toContain('stop_error_code');
    expect(
      upgraded
        .prepare(
          "SELECT policy,relay_queue FROM bot_group_discussions WHERE id='legacy-run'",
        )
        .get(),
    ).toEqual({ policy: 'coordinator-v1', relay_queue: '[]' });
    expect(
      upgraded
        .prepare(
          "SELECT payload,request_id,parked_at FROM bot_group_discussion_turns WHERE id='legacy-turn'",
        )
        .get(),
    ).toEqual({
      payload: frozenPayload,
      request_id: 'legacy-request',
      parked_at: null,
    });
    expect(() =>
      upgraded
        .prepare(
          "UPDATE bot_group_discussion_turns SET parked_at='first',parked_reason='approval' WHERE id='legacy-turn'",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      upgraded
        .prepare(
          "UPDATE bot_group_discussion_turns SET parked_at='changed' WHERE id='legacy-turn'",
        )
        .run(),
    ).toThrow('immutable');
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='bot_group_one_pending_turn'",
        )
        .get(),
    ).toBeUndefined();
    upgraded.close();
    expect(
      fs
        .readdirSync(path.join(root, 'db/migration-backups'))
        .filter((name) =>
          name.startsWith(`messages-v87-to-v${db.CURRENT_SCHEMA_VERSION}-`),
        ),
    ).toHaveLength(1);
    db.closeDatabase();
    const future = new Database(file);
    future
      .prepare("UPDATE router_state SET value=? WHERE key='schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    future.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  } finally {
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
