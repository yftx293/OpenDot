import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-feedback-upgrade-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v103 preserves Group state and creates empty feedback storage with a private backup', async () => {
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
    const receipt = groups.createBotGroup('owner', randomUUID(), {
      workspace_jid: 'web:owner',
      name: 'Existing Group',
    });
    db.closeDatabase();
    raw = new Database(file);
    raw.exec(
      "DROP TABLE bot_group_feedback_exports; DROP TABLE bot_group_feedback_requests; DROP TABLE bot_group_message_feedback; UPDATE router_state SET value='103' WHERE key='schema_version'",
    );
    raw.close();
    raw = undefined;
    db.initDatabase();
    expect(
      groups.getBotGroupSnapshot('owner', receipt.group_id).group.name,
    ).toBe('Existing Group');
    db.closeDatabase();
    raw = new Database(file, { readonly: true });
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      raw.prepare('SELECT count(*) AS n FROM bot_group_message_feedback').get(),
    ).toEqual({ n: 0 });
    raw.close();
    raw = undefined;
    const backups = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((n) => n.endsWith('.db'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      new RegExp(`^messages-v103-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
    const backup = path.join(root, 'db/migration-backups', backups[0]);
    expect(fs.statSync(backup).mode & 0o077).toBe(0);
    raw = new Database(backup, { readonly: true });
    expect(
      raw
        .prepare('SELECT name FROM bot_groups WHERE id=?')
        .get(receipt.group_id),
    ).toEqual({ name: 'Existing Group' });
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='bot_group_message_feedback'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
