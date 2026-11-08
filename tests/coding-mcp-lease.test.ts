import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import {
  bindMcpSessionDatabase,
  createMcpSessionSchema,
} from '../src/personal-agent/mcp-session-schema.js';
import {
  acquireCodingMcpLease,
  assertCodingMcpLease,
  releaseCodingMcpLease,
  renewCodingMcpLease,
} from '../src/personal-agent/coding-mcp-lease.js';

afterEach(() => {
  bindMcpSessionDatabase(null);
  vi.restoreAllMocks();
});

test('only the current unexpired epoch owns a session, including after takeover', () => {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE product_session_runtimes(session_id TEXT PRIMARY KEY);',
  );
  createMcpSessionSchema(db);
  bindMcpSessionDatabase(db);
  db.exec(
    "INSERT INTO users VALUES('owner'); INSERT INTO product_session_runtimes VALUES('session');",
  );
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(acquireCodingMcpLease('session', 'owner', 'one')).toBe(true);
  expect(acquireCodingMcpLease('session', 'owner', 'two')).toBe(false);
  expect(renewCodingMcpLease('session', 'owner', 'one')).toBe(true);
  now += 15_001;
  expect(renewCodingMcpLease('session', 'owner', 'one')).toBe(false);
  expect(acquireCodingMcpLease('session', 'owner', 'two')).toBe(true);
  expect(() => assertCodingMcpLease('session', 'owner', 'one')).toThrow();
  releaseCodingMcpLease('session', 'owner', 'one');
  expect(() => assertCodingMcpLease('session', 'owner', 'two')).not.toThrow();
  releaseCodingMcpLease('session', 'owner', 'two');
  expect(() => assertCodingMcpLease('session', 'owner', 'two')).toThrow();
  bindMcpSessionDatabase(null);
  db.close();
});
