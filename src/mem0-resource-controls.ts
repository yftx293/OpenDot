import { Mem0OperationError } from './mem0-private-client.js';

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};
let connection: Database | null = null;
export function bindMem0ResourceDatabase(value: Database | null) {
  connection = value;
}
export function createMem0ResourceSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS mem0_daily_budget (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    day TEXT NOT NULL, used INTEGER NOT NULL CHECK(used>=0), PRIMARY KEY(owner_id,profile_id,day)
  );
  CREATE TABLE IF NOT EXISTS mem0_scope_circuits (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    credential_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,
    reason TEXT NOT NULL,until_ms INTEGER,PRIMARY KEY(owner_id,profile_id,credential_version,policy_version)
  );`);
}
type Scope = {
  ownerId: string;
  profileId: string;
  credentialVersion: number;
  policyVersion: number;
};
const db = () => {
  if (!connection) throw new Error('Mem0 resource controls unavailable');
  return connection;
};
function dailyLimit(): number {
  const raw = process.env.MINICLAW_MEM0_DAILY_BUDGET;
  if (raw === undefined || raw === '') return 100;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100000
    ? parsed
    : 0;
}
/** Reserve atomically before external IO. The owner/Dot daily budget covers
 * both search and add and cannot be reset by rotating credentials. */
export function reserveMem0Operation(
  scope: Scope,
  now = Date.now(),
): 'reserved' | 'budget_exhausted' | 'circuit_open' {
  const circuit = db()
    .prepare(
      'SELECT until_ms FROM mem0_scope_circuits WHERE owner_id=? AND profile_id=? AND credential_version=? AND policy_version=?',
    )
    .get(
      scope.ownerId,
      scope.profileId,
      scope.credentialVersion,
      scope.policyVersion,
    ) as { until_ms: number | null } | undefined;
  if (circuit && (circuit.until_ms === null || circuit.until_ms > now))
    return 'circuit_open';
  const limit = dailyLimit();
  if (!limit) return 'budget_exhausted';
  const day = new Date(now).toISOString().slice(0, 10);
  const row = db()
    .prepare(
      `INSERT INTO mem0_daily_budget(owner_id,profile_id,day,used) VALUES(?,?,?,1)
    ON CONFLICT(owner_id,profile_id,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used`,
    )
    .get(scope.ownerId, scope.profileId, day, limit);
  return row ? 'reserved' : 'budget_exhausted';
}
export function settleMem0Operation(
  scope: Scope,
  error?: unknown,
  now = Date.now(),
) {
  if (!error) {
    db()
      .prepare(
        'DELETE FROM mem0_scope_circuits WHERE owner_id=? AND profile_id=? AND credential_version=? AND policy_version=? AND until_ms IS NOT NULL AND until_ms<=?',
      )
      .run(
        scope.ownerId,
        scope.profileId,
        scope.credentialVersion,
        scope.policyVersion,
        now,
      );
    return;
  }
  if (
    !(error instanceof Mem0OperationError) ||
    ![
      'authentication',
      'rate_limited',
      'uncertain',
      'invalid_response',
    ].includes(error.kind)
  )
    return;
  const until =
    error.kind === 'authentication'
      ? null
      : now +
        (error.kind === 'rate_limited'
          ? Math.max(1, error.retryAfterSeconds ?? 60) * 1000
          : 30000);
  db()
    .prepare(
      `INSERT INTO mem0_scope_circuits(owner_id,profile_id,credential_version,policy_version,reason,until_ms) VALUES(?,?,?,?,?,?)
    ON CONFLICT(owner_id,profile_id,credential_version,policy_version) DO UPDATE SET
      reason=CASE WHEN until_ms IS NULL THEN reason ELSE excluded.reason END,
      until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE max(until_ms,excluded.until_ms) END`,
    )
    .run(
      scope.ownerId,
      scope.profileId,
      scope.credentialVersion,
      scope.policyVersion,
      error.kind,
      until,
    );
}
