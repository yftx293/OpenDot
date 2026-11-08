import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  bindMem0ResourceDatabase,
  createMem0ResourceSchema,
  reserveMem0Operation,
  settleMem0Operation,
} from '../src/mem0-resource-controls.js';
import { Mem0OperationError } from '../src/mem0-private-client.js';
let db: Database.Database;
afterEach(() => {
  bindMem0ResourceDatabase(null);
  db?.close();
  delete process.env.MINICLAW_MEM0_DAILY_BUDGET;
});
function fixture() {
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE agent_profiles(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner'),('other'); INSERT INTO agent_profiles VALUES('dot'),('other-dot');",
  );
  createMem0ResourceSchema(db);
  bindMem0ResourceDatabase(db);
  return {
    ownerId: 'owner',
    profileId: 'dot',
    credentialVersion: 1,
    policyVersion: 1,
  };
}
it('limits search and capture together without resetting on key rotation', () => {
  const scope = fixture();
  process.env.MINICLAW_MEM0_DAILY_BUDGET = '2';
  expect(reserveMem0Operation(scope, 100000)).toBe('reserved');
  expect(reserveMem0Operation(scope, 100000)).toBe('reserved');
  expect(reserveMem0Operation({ ...scope, credentialVersion: 2 }, 100000)).toBe(
    'budget_exhausted',
  );
  expect(
    reserveMem0Operation({ ...scope, profileId: 'other-dot' }, 100000),
  ).toBe('reserved');
  expect(reserveMem0Operation(scope, 100000 + 86400000)).toBe('reserved');
});
it('isolates authentication and rate limit circuits by credential and scope', () => {
  const scope = fixture();
  settleMem0Operation(scope, new Mem0OperationError('authentication'), 100000);
  expect(reserveMem0Operation(scope, 999999)).toBe('circuit_open');
  expect(reserveMem0Operation({ ...scope, credentialVersion: 2 }, 999999)).toBe(
    'reserved',
  );
  expect(reserveMem0Operation({ ...scope, ownerId: 'other' }, 999999)).toBe(
    'reserved',
  );
  settleMem0Operation(scope, new Mem0OperationError('rate_limited', 1), 100000);
  expect(reserveMem0Operation(scope, 999999)).toBe('circuit_open');
});
