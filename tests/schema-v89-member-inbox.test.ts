import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-schema-v89-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v88 upgrade privately backs up frozen serial inputs and adds empty, opt-in member provenance without rewriting old policy', async () => {
  const db = await import('../src/db.js');
  const groups = await import('../src/bot-groups/store.js');
  const file = path.join(root, 'db/messages.db');
  const frozen = JSON.stringify({
    content: 'OLD_FROZEN_QUEUE_INPUT',
    followUpBehavior: 'queue',
    sender: 'alice',
    senderName: 'Group',
  });
  try {
    db.initDatabase();
    const stamp = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      display_name: 'Alice',
      password_hash: 'fixture',
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
    const groupId = groups.createBotGroup('alice', randomUUID(), {
      workspace_jid: 'web:alice',
      name: 'Existing serial group',
    }).group_id;
    groups.postBotGroupMessage('alice', groupId, randomUUID(), {
      content: 'PRESERVE_CANONICAL_88',
      dispatch: false,
    });
    db.closeDatabase();
    const legacy = new Database(file);
    // Reconstruct the actual preceding shape rather than only changing its
    // version marker. No executable session or grant is fabricated here.
    legacy.exec(`
      DROP TABLE bot_group_member_stops; DROP TABLE bot_group_member_cloud_attempts; DROP TABLE bot_group_member_cloud_owners; DROP TABLE bot_group_member_cloud_runs; DROP TABLE bot_group_member_model_admissions;
      DROP TABLE bot_group_member_execution_policies;
      DROP TABLE bot_group_member_model_requests;
      DROP TABLE bot_group_member_answers;
      DROP TABLE bot_group_member_inputs;
      DROP TABLE bot_group_member_mail;
      DROP TABLE bot_group_member_leases;
      DROP TRIGGER bot_group_execution_contract_identity;
      DROP TRIGGER bot_group_cancel_epoch_monotonic;
      DROP TRIGGER bot_group_control_epoch_monotonic;
      ALTER TABLE bot_group_discussion_settings DROP COLUMN execution_contract;
      ALTER TABLE bot_group_discussions DROP COLUMN execution_contract;
      ALTER TABLE bot_group_discussions DROP COLUMN cancel_epoch;
      ALTER TABLE bot_group_discussions DROP COLUMN control_epoch;
      UPDATE router_state SET value='88' WHERE key='schema_version';
    `);
    const rootMessage = legacy
      .prepare(
        "SELECT id FROM bot_group_messages WHERE group_id=? AND author_kind='user'",
      )
      .get(groupId) as { id: string };
    legacy
      .prepare(
        "INSERT INTO bot_group_discussions(id,group_id,owner_user_id,root_message_id,coordinator_profile_id,participant_profile_ids,status,phase,policy,protocol_version,max_turns,max_turns_per_dot,max_model_attempts,created_at,updated_at,deadline_at) VALUES('legacy-run',?,'alice',?,? ,?,'running','coordinator','relay-v1',2,6,2,24,?,?,?)",
      )
      .run(
        groupId,
        rootMessage.id,
        profile.id,
        JSON.stringify([profile.id]),
        stamp,
        stamp,
        Date.now() + 60_000,
      );
    legacy
      .prepare(
        "INSERT INTO bot_group_discussion_turns(id,run_id,ordinal,profile_id,role,session_id,grant_id,request_id,payload,context_through_seq,state) VALUES('legacy-turn','legacy-run',1,?,'coordinator','legacy-session','legacy-grant','legacy-request',?,0,'pending')",
      )
      .run(profile.id, frozen);
    legacy.close();
    db.initDatabase();
    const upgraded = new Database(file);
    try {
      expect(
        upgraded
          .prepare(
            "SELECT execution_contract,policy,protocol_version,cancel_epoch,control_epoch FROM bot_group_discussions WHERE id='legacy-run'",
          )
          .get(),
      ).toEqual({
        execution_contract: 'serial-v1',
        policy: 'relay-v1',
        protocol_version: 2,
        cancel_epoch: 0,
        control_epoch: 0,
      });
      expect(
        upgraded
          .prepare(
            "SELECT request_id,payload,state FROM bot_group_discussion_turns WHERE id='legacy-turn'",
          )
          .get(),
      ).toEqual({
        request_id: 'legacy-request',
        payload: frozen,
        state: 'pending',
      });
      expect(
        upgraded
          .prepare('SELECT COUNT(*) n FROM bot_group_member_leases')
          .get(),
      ).toEqual({ n: 0 });
      expect(
        upgraded
          .prepare('SELECT COUNT(*) n FROM bot_group_member_inputs')
          .get(),
      ).toEqual({ n: 0 });
      expect(() =>
        upgraded
          .prepare(
            "UPDATE bot_group_discussions SET execution_contract='member-inbox-v1' WHERE id='legacy-run'",
          )
          .run(),
      ).toThrow('immutable');
      upgraded
        .prepare(
          "UPDATE bot_group_discussions SET cancel_epoch=1,control_epoch=1 WHERE id='legacy-run'",
        )
        .run();
      expect(() =>
        upgraded
          .prepare(
            "UPDATE bot_group_discussions SET cancel_epoch=0 WHERE id='legacy-run'",
          )
          .run(),
      ).toThrow('cannot reset');
      expect(() =>
        upgraded
          .prepare(
            "UPDATE bot_group_discussions SET control_epoch=0 WHERE id='legacy-run'",
          )
          .run(),
      ).toThrow('cannot reset');
      expect(
        groups
          .getBotGroupSnapshot('alice', groupId)
          .messages.some((m) => m.content === 'PRESERVE_CANONICAL_88'),
      ).toBe(true);
    } finally {
      upgraded.close();
    }
    const directory = path.join(root, 'db/migration-backups');
    const backups = fs
      .readdirSync(directory)
      .filter((name) =>
        name.startsWith(`messages-v88-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backups).toHaveLength(1);
    const backupPath = path.join(directory, backups[0]);
    expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(
        backup
          .prepare("SELECT value FROM router_state WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '88' });
      expect(
        backup
          .prepare(
            "SELECT payload FROM bot_group_discussion_turns WHERE id='legacy-turn'",
          )
          .get(),
      ).toEqual({ payload: frozen });
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='bot_group_member_inputs'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
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
