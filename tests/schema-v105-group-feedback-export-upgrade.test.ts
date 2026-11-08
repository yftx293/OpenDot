import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-export-upgrade-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v104 preserves existing Group feedback and backs it up before adding export storage', async () => {
  const db = await import('../src/db.js');
  const groups = await import('../src/bot-groups/store.js');
  const file = path.join(root, 'db/messages.db');
  let raw: Database.Database | undefined;
  try {
    db.initDatabase();
    const now = new Date().toISOString();
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
    const profile = db.getOrCreateDefaultAgentProfile('owner');
    db.setRegisteredGroup('web:owner', {
      name: 'Fixture',
      folder: 'owner',
      created_by: 'owner',
      executionMode: 'host',
      is_home: false,
      added_at: now,
    });
    db.assignWorkspaceAgentProfile('owner', profile.id);
    const group = groups.createBotGroup('owner', randomUUID(), {
      workspace_jid: 'web:owner',
      name: 'Existing Group',
    }).group_id;
    db.closeDatabase();
    raw = new Database(file);
    const message = randomUUID();
    raw
      .prepare(
        "INSERT INTO bot_group_messages(id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at) VALUES(?,?,10000,'system_event','bot',?,'Dot','Answer','[]','{}',?)",
      )
      .run(message, group, profile.id, now);
    raw
      .prepare('INSERT INTO bot_group_message_feedback VALUES(?,?,?,?,?,?,?,?)')
      .run('feedback', group, message, 'owner', 1, 'kept', 1, 123);
    raw.exec(
      "DROP TABLE bot_group_feedback_exports; UPDATE router_state SET value='104' WHERE key='schema_version'",
    );
    raw.close();
    raw = undefined;
    db.initDatabase();
    db.closeDatabase();
    raw = new Database(file, { readonly: true });
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      raw
        .prepare(
          'SELECT score,comment,version FROM bot_group_message_feedback WHERE id=?',
        )
        .get('feedback'),
    ).toEqual({ score: 1, comment: 'kept', version: 1 });
    expect(
      raw.prepare('SELECT count(*) AS n FROM bot_group_feedback_exports').get(),
    ).toEqual({ n: 0 });
    raw.close();
    raw = undefined;
    const names = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((n) =>
        n.startsWith(`messages-v104-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(names).toHaveLength(1);
    const backup = path.join(root, 'db/migration-backups', names[0]);
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
    raw = new Database(backup, { readonly: true });
    expect(
      raw
        .prepare('SELECT comment FROM bot_group_message_feedback WHERE id=?')
        .get('feedback'),
    ).toEqual({ comment: 'kept' });
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='bot_group_feedback_exports'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
