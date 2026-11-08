import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-v106-upgrade-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v105 is backed up and upgraded with a nullable native answer trace binding', async () => {
  const db = await import('../src/db.js');
  const file = path.join(root, 'db/messages.db');
  let raw: Database.Database | undefined;
  try {
    db.initDatabase();
    db.closeDatabase();
    raw = new Database(file);
    raw.exec(
      "ALTER TABLE product_input_task_sources DROP COLUMN observation_trace_id; DROP TRIGGER bot_group_member_mail_trace_identity; ALTER TABLE bot_group_member_mail DROP COLUMN source_observation_trace_id; UPDATE router_state SET value='105' WHERE key='schema_version'",
    );
    raw.close();
    raw = undefined;
    db.initDatabase();
    db.closeDatabase();
    raw = new Database(file, { readonly: true });
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      raw.prepare('PRAGMA table_info(product_input_task_sources)').all(),
    ).toContainEqual(
      expect.objectContaining({ name: 'observation_trace_id', notnull: 0 }),
    );
    expect(
      raw.prepare('PRAGMA table_info(bot_group_member_mail)').all(),
    ).toContainEqual(
      expect.objectContaining({
        name: 'source_observation_trace_id',
        notnull: 0,
      }),
    );
    raw.close();
    raw = undefined;
    const backups = fs
      .readdirSync(path.join(root, 'db/migration-backups'))
      .filter((name) =>
        name.startsWith(`messages-v105-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backups).toHaveLength(1);
    expect(
      fs.statSync(path.join(root, 'db/migration-backups', backups[0]!)).mode &
        0o077,
    ).toBe(0);
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
