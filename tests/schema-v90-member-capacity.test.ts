import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'miniclaw-schema-capacity-'),
);
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
test('the capacity migration privately backs up v89 and preserves its frozen native dispatch while old Runs get no new policy', async () => {
  const db = await import('../src/db.js');
  const groups = await import('../src/bot-groups/store.js');
  const file = path.join(root, 'db/messages.db');
  let storage: Database.Database | undefined;
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
      name: 'Existing member history',
    }).group_id;
    groups.postBotGroupMessage('alice', groupId, randomUUID(), {
      content: 'PRESERVE_PRE_CAPACITY_PUBLIC_TEXT',
      dispatch: false,
    });
    db.closeDatabase();
    storage = new Database(file);
    storage.exec(
      'DROP TABLE bot_group_member_stops; DROP TABLE bot_group_member_cloud_attempts; DROP TABLE bot_group_member_cloud_owners; DROP TABLE bot_group_member_cloud_runs; DROP TABLE bot_group_member_model_admissions; DROP TABLE bot_group_member_execution_policies;',
    );
    const rootMessage = storage
      .prepare(
        "SELECT id FROM bot_group_messages WHERE group_id=? AND author_kind='user'",
      )
      .get(groupId) as { id: string };
    // Opaque historical provenance is copied, never executed or adopted as a current native Task.
    storage
      .prepare(
        "INSERT INTO bot_group_discussions(id,group_id,owner_user_id,root_message_id,coordinator_profile_id,participant_profile_ids,status,phase,execution_contract,max_turns,max_turns_per_dot,max_model_attempts,created_at,updated_at,deadline_at) VALUES('old-member-run',?,'alice',?,? ,?,'completed','speaker','member-inbox-v1',6,2,24,?,?,?)",
      )
      .run(
        groupId,
        rootMessage.id,
        profile.id,
        JSON.stringify([profile.id]),
        stamp,
        stamp,
        Date.now() + 60000,
      );
    storage
      .prepare(
        "INSERT INTO bot_group_member_leases(id,run_id,group_id,profile_id,session_id,grant_id,cancel_epoch,state,created_at) VALUES('old-lease','old-member-run',?,?,'opaque-session','opaque-grant',0,'done',?)",
      )
      .run(groupId, profile.id, stamp);
    storage
      .prepare(
        "INSERT INTO bot_group_member_model_requests(id,lease_id,run_id,session_id,ordinal,native_task_id,native_attempt,context_digest,source_inputs,created_at) VALUES('old-model','old-lease','old-member-run','opaque-session',1,71,2,?,'[]',?)",
      )
      .run('a'.repeat(64), stamp);
    const frozen = storage
      .prepare(
        "SELECT * FROM bot_group_member_model_requests WHERE id='old-model'",
      )
      .get();
    storage
      .prepare("UPDATE router_state SET value='89' WHERE key='schema_version'")
      .run();
    storage.close();
    storage = undefined;
    db.initDatabase();
    storage = new Database(file);
    expect(
      storage
        .prepare(
          "SELECT * FROM bot_group_member_model_requests WHERE id='old-model'",
        )
        .get(),
    ).toEqual(frozen);
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM bot_group_member_execution_policies')
        .get(),
    ).toEqual({ n: 0 });
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM bot_group_member_model_admissions')
        .get(),
    ).toEqual({ n: 0 });
    expect(storage.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const names = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((n) =>
        n.startsWith(`messages-v89-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(names).toHaveLength(1);
    const backupPath = path.join(root, 'db/migration-backups', names[0]);
    expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(
        backup
          .prepare("SELECT value FROM router_state WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '89' });
      expect(
        backup
          .prepare(
            "SELECT * FROM bot_group_member_model_requests WHERE id='old-model'",
          )
          .get(),
      ).toEqual(frozen);
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='bot_group_member_model_admissions'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    storage.close();
    storage = undefined;
    db.closeDatabase();
    const future = new Database(file);
    future
      .prepare("UPDATE router_state SET value=? WHERE key='schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    future.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  } finally {
    storage?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
