import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-private-config-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
}));
const config = await import('../src/mem0-private-config.js');
const secrets = await import('../src/runtime-config.js');

const databases: Database.Database[] = [];
afterEach(() => {
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
    INSERT INTO users VALUES('alice','active',NULL),('bob','active',NULL);
    INSERT INTO agent_profiles VALUES('dot-a','alice','active'),('dot-b','bob','active');
  `);
  config.createMem0PrivateConfigSchema(db);
  config.bindMem0PrivateConfigDatabase(db);
  return db;
}

it('encrypts an owner key and requires explicit per-Dot opt-in for each operation', () => {
  const db = fixture();
  expect(config.mem0DotCredential('alice', 'dot-a', 'recall')).toBeNull();
  config.setMem0OwnerCredential('alice', 'test-secret');
  const row = db
    .prepare(
      'SELECT ciphertext FROM mem0_owner_credentials WHERE owner_user_id=?',
    )
    .get('alice') as { ciphertext: string };
  expect(row.ciphertext).not.toContain('test-secret');
  expect(() =>
    secrets.openHostPrivateJson(
      { ownerId: 'bob', recordId: 'alice', purpose: 'mem0.owner.credential' },
      row.ciphertext,
    ),
  ).toThrow(/unavailable/);
  config.setMem0DotPolicy('alice', 'dot-a', {
    enabled: true,
    recallEnabled: true,
    captureEnabled: false,
  });
  expect(config.mem0DotCredential('alice', 'dot-a', 'recall')).toBe(
    'test-secret',
  );
  expect(config.mem0DotCredential('alice', 'dot-a', 'capture')).toBeNull();
  expect(config.mem0DotCredential('bob', 'dot-a', 'recall')).toBeNull();
  expect(() =>
    config.setMem0DotPolicy('bob', 'dot-a', {
      enabled: true,
      recallEnabled: true,
      captureEnabled: true,
    }),
  ).toThrow(/unavailable/);
});

it('fails closed when an owner or Dot is disabled, key is removed, or ciphertext is swapped', () => {
  const db = fixture();
  config.setMem0OwnerCredential('alice', 'alice-secret');
  config.setMem0OwnerCredential('bob', 'bob-secret');
  config.setMem0DotPolicy('alice', 'dot-a', {
    enabled: true,
    recallEnabled: true,
    captureEnabled: true,
  });
  expect(config.mem0DotCredential('alice', 'dot-a', 'capture')).toBe(
    'alice-secret',
  );
  const bob = db
    .prepare(
      'SELECT ciphertext FROM mem0_owner_credentials WHERE owner_user_id=?',
    )
    .get('bob') as { ciphertext: string };
  db.prepare(
    'UPDATE mem0_owner_credentials SET ciphertext=? WHERE owner_user_id=?',
  ).run(bob.ciphertext, 'alice');
  expect(config.mem0DotCredential('alice', 'dot-a', 'recall')).toBeNull();
  config.setMem0OwnerCredential('alice', 'restored');
  db.prepare("UPDATE users SET status='disabled' WHERE id='alice'").run();
  expect(config.mem0DotCredential('alice', 'dot-a', 'recall')).toBeNull();
  db.prepare("UPDATE users SET status='active' WHERE id='alice'").run();
  db.prepare(
    "UPDATE agent_profiles SET status='disabled' WHERE id='dot-a'",
  ).run();
  expect(config.mem0DotCredential('alice', 'dot-a', 'recall')).toBeNull();
  db.prepare(
    "UPDATE agent_profiles SET status='active' WHERE id='dot-a'",
  ).run();
  config.clearMem0OwnerCredential('alice');
  expect(config.mem0DotCredential('alice', 'dot-a', 'capture')).toBeNull();
});
