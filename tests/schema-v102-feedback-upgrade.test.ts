import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-upgrade-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v98 data upgrades to feedback storage with no historical scores and an intact backup', async () => {
  const db = await import('../src/db.js');
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
    db.closeDatabase();
    raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    const tables = [
      'feedback_score_exports',
      'message_feedback_requests',
      'observation_input_traces',
      'message_feedback',
    ];
    for (const name of tables) raw.exec(`DROP TABLE ${name}`);
    raw
      .prepare("UPDATE router_state SET value='98' WHERE key='schema_version'")
      .run();
    raw.close();
    raw = undefined;
    db.initDatabase();
    expect(db.getUserById('owner')?.id).toBe('owner');
    expect(db.getAgentProfile(profile.id)?.id).toBe(profile.id);
    db.closeDatabase();
    raw = new Database(file, { readonly: true });
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    for (const name of tables)
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      ).toEqual({ name });
    expect(
      raw.prepare('SELECT count(*) AS n FROM message_feedback').get(),
    ).toEqual({ n: 0 });
    raw.close();
    raw = undefined;
    const backups = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((name) => name.endsWith('.db'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      new RegExp(`^messages-v98-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
    const backupPath = path.join(root, 'db/migration-backups', backups[0]);
    expect(fs.statSync(backupPath).mode & 0o077).toBe(0);
    raw = new Database(backupPath, { readonly: true });
    expect(
      raw
        .prepare("SELECT value FROM router_state WHERE key='schema_version'")
        .get(),
    ).toEqual({ value: '98' });
    expect(raw.prepare("SELECT id FROM users WHERE id='owner'").get()).toEqual({
      id: 'owner',
    });
    expect(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE name='message_feedback'")
        .get(),
    ).toBeUndefined();
    raw.close();
    raw = undefined;
    db.initDatabase();
    db.closeDatabase();
    expect(
      fs
        .readdirSync(path.join(root, 'db/migration-backups'))
        .filter((name) => name.endsWith('.db')),
    ).toEqual(backups);
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
