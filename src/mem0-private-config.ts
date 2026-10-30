import { openHostPrivateJson, sealHostPrivateJson } from './runtime-config.js';
import { clearMem0RecallCache } from './mem0-recall-cache.js';

type Statement = {
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
};

let connection: Database | null = null;
const db = () => {
  if (!connection) throw new Error('Mem0 private configuration unavailable');
  return connection;
};

export function bindMem0PrivateConfigDatabase(value: Database | null) {
  connection = value;
}

export function createMem0PrivateConfigSchema(value: Database) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS mem0_owner_credentials (
      owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mem0_owner_credential_versions (
      owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version>0)
    );
    CREATE TABLE IF NOT EXISTS mem0_dot_policies (
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      recall_enabled INTEGER NOT NULL DEFAULT 0 CHECK(recall_enabled IN (0,1)),
      capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK(capture_enabled IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_user_id,profile_id)
    );
  `);
  const credentialColumns = value
    .prepare('PRAGMA table_info(mem0_owner_credentials)')
    .all() as { name: string }[];
  if (!credentialColumns.some((c) => c.name === 'version'))
    value.exec(
      'ALTER TABLE mem0_owner_credentials ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    );
  value.exec(`INSERT INTO mem0_owner_credential_versions(owner_user_id,version)
    SELECT owner_user_id,version FROM mem0_owner_credentials WHERE true
    ON CONFLICT(owner_user_id) DO UPDATE SET version=max(version,excluded.version)`);
  const policyColumns = value
    .prepare('PRAGMA table_info(mem0_dot_policies)')
    .all() as { name: string }[];
  if (!policyColumns.some((c) => c.name === 'version'))
    value.exec(
      'ALTER TABLE mem0_dot_policies ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
    );
}

function activeOwner(ownerId: string) {
  if (!ownerId || ownerId.length > 256) return false;
  return !!db()
    .prepare(
      `SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL`,
    )
    .get(ownerId);
}

function activeProfile(ownerId: string, profileId: string) {
  if (!activeOwner(ownerId) || !profileId || profileId.length > 256)
    return false;
  return !!db()
    .prepare(
      `SELECT 1 FROM agent_profiles WHERE id=? AND owner_user_id=? AND status='active'`,
    )
    .get(profileId, ownerId);
}

function credentialScope(ownerId: string) {
  return {
    ownerId,
    recordId: ownerId,
    purpose: 'mem0.owner.credential' as const,
  };
}

function discardRecallSnapshots(ownerId: string, profileId?: string) {
  clearMem0RecallCache();
  const exists = db()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mem0_private_recall_snapshots'",
    )
    .get();
  const params = profileId ? [ownerId, profileId] : [ownerId];
  const filter = profileId ? ' AND profile_id=?' : '';
  if (exists)
    db()
      .prepare(
        `UPDATE mem0_private_recall_snapshots
         SET state='degraded',ciphertext=NULL,reason='revoked'
         WHERE owner_user_id=? AND state='ready'${filter}`,
      )
      .run(...params);
  const codingExists = db()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mem0_coding_recall_snapshots'",
    )
    .get();
  if (codingExists)
    db()
      .prepare(
        `UPDATE mem0_coding_recall_snapshots SET state='degraded',ciphertext=NULL,reason='revoked'
      WHERE owner_user_id=? AND state='ready'${filter}`,
      )
      .run(...params);
  const captureExists = db()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mem0_private_capture_intents'",
    )
    .get();
  if (captureExists)
    db()
      .prepare(
        `UPDATE mem0_private_capture_intents SET
         state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
         ciphertext=NULL,reason='revoked',settled_at=?
         WHERE owner_user_id=? AND state IN
           ('awaiting_answer','pending','rate_limited','dispatching')${filter}`,
      )
      .run(new Date().toISOString(), ...params);
  const codingCaptureExists = db()
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mem0_coding_capture_intents'",
    )
    .get();
  if (codingCaptureExists)
    db()
      .prepare(
        `UPDATE mem0_coding_capture_intents SET
      state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
      ciphertext=NULL,reason='revoked',settled_at=?
      WHERE owner_user_id=? AND state IN ('awaiting_answer','pending','rate_limited','dispatching')${filter}`,
      )
      .run(new Date().toISOString(), ...params);
}

/** Host-only write. The key is encrypted before entering SQLite. */
export function setMem0OwnerCredential(ownerId: string, apiKey: string) {
  if (
    !activeOwner(ownerId) ||
    !apiKey ||
    apiKey.length > 4096 ||
    /[\r\n]/.test(apiKey)
  )
    throw new Error('Invalid Mem0 owner credential');
  const ciphertext = sealHostPrivateJson(credentialScope(ownerId), {
    apiKey,
  });
  discardRecallSnapshots(ownerId);
  const nextVersion = db()
    .prepare(
      `INSERT INTO mem0_owner_credential_versions(owner_user_id,version) VALUES(?,1)
    ON CONFLICT(owner_user_id) DO UPDATE SET version=version+1 RETURNING version`,
    )
    .get(ownerId) as { version: number };
  db()
    .prepare(
      `INSERT INTO mem0_owner_credentials(owner_user_id,ciphertext,version,updated_at)
       VALUES(?,?,?,?) ON CONFLICT(owner_user_id) DO UPDATE SET
       ciphertext=excluded.ciphertext,version=excluded.version,
       updated_at=excluded.updated_at`,
    )
    .run(ownerId, ciphertext, nextVersion.version, new Date().toISOString());
}

export function clearMem0OwnerCredential(ownerId: string) {
  discardRecallSnapshots(ownerId);
  db()
    .prepare(
      `INSERT INTO mem0_owner_credential_versions(owner_user_id,version) VALUES(?,1)
    ON CONFLICT(owner_user_id) DO UPDATE SET version=version+1`,
    )
    .run(ownerId);
  db()
    .prepare('DELETE FROM mem0_owner_credentials WHERE owner_user_id=?')
    .run(ownerId);
}

export type Mem0DotPolicy = Readonly<{
  enabled: boolean;
  recallEnabled: boolean;
  captureEnabled: boolean;
}>;

/** Public settings projection: never decrypt or expose the owner API key. */
export function mem0OwnerCredentialConfigured(ownerId: string): boolean {
  if (!activeOwner(ownerId)) return false;
  return !!db()
    .prepare('SELECT 1 FROM mem0_owner_credentials WHERE owner_user_id=?')
    .get(ownerId);
}

export function getMem0DotPolicy(
  ownerId: string,
  profileId: string,
): Mem0DotPolicy & { version: number } {
  if (!activeProfile(ownerId, profileId))
    throw new Error('Mem0 Dot policy target unavailable');
  const row = db()
    .prepare(
      `SELECT enabled,recall_enabled,capture_enabled,version
       FROM mem0_dot_policies WHERE owner_user_id=? AND profile_id=?`,
    )
    .get(ownerId, profileId) as
    | {
        enabled: number;
        recall_enabled: number;
        capture_enabled: number;
        version: number;
      }
    | undefined;
  return {
    enabled: row?.enabled === 1,
    recallEnabled: row?.recall_enabled === 1,
    captureEnabled: row?.capture_enabled === 1,
    version: row?.version ?? 0,
  };
}

export function setMem0DotPolicy(
  ownerId: string,
  profileId: string,
  policy: Mem0DotPolicy,
) {
  if (
    !activeProfile(ownerId, profileId) ||
    typeof policy?.enabled !== 'boolean' ||
    typeof policy.recallEnabled !== 'boolean' ||
    typeof policy.captureEnabled !== 'boolean'
  )
    throw new Error('Mem0 Dot policy target unavailable');
  discardRecallSnapshots(ownerId, profileId);
  db()
    .prepare(
      `INSERT INTO mem0_dot_policies
       (owner_user_id,profile_id,enabled,recall_enabled,capture_enabled,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(owner_user_id,profile_id) DO UPDATE SET
       enabled=excluded.enabled,recall_enabled=excluded.recall_enabled,
       capture_enabled=excluded.capture_enabled,version=mem0_dot_policies.version+1,
       updated_at=excluded.updated_at`,
    )
    .run(
      ownerId,
      profileId,
      Number(policy.enabled),
      Number(policy.recallEnabled),
      Number(policy.captureEnabled),
      new Date().toISOString(),
    );
}

/** Fail closed: missing policy, missing key and deactivated users/Dots make no request. */
export function mem0DotAccess(
  ownerId: string,
  profileId: string,
  purpose: 'recall' | 'capture',
): { apiKey: string; credentialVersion: number; policyVersion: number } | null {
  if (!activeProfile(ownerId, profileId)) return null;
  const row = db()
    .prepare(
      `SELECT c.ciphertext,c.version AS credential_version,
              p.version AS policy_version FROM mem0_dot_policies p
       JOIN mem0_owner_credentials c ON c.owner_user_id=p.owner_user_id
       WHERE p.owner_user_id=? AND p.profile_id=? AND p.enabled=1
         AND ${purpose === 'recall' ? 'p.recall_enabled' : 'p.capture_enabled'}=1`,
    )
    .get(ownerId, profileId) as
    | {
        ciphertext: string;
        credential_version: number;
        policy_version: number;
      }
    | undefined;
  if (!row) return null;
  try {
    const value = openHostPrivateJson(
      credentialScope(ownerId),
      row.ciphertext,
    ) as { apiKey?: unknown };
    return typeof value?.apiKey === 'string' &&
      value.apiKey.length > 0 &&
      value.apiKey.length <= 4096 &&
      !/[\r\n]/.test(value.apiKey) &&
      Number.isSafeInteger(row.credential_version) &&
      Number.isSafeInteger(row.policy_version)
      ? {
          apiKey: value.apiKey,
          credentialVersion: row.credential_version,
          policyVersion: row.policy_version,
        }
      : null;
  } catch {
    return null;
  }
}

export function mem0DotCredential(
  ownerId: string,
  profileId: string,
  purpose: 'recall' | 'capture',
): string | null {
  return mem0DotAccess(ownerId, profileId, purpose)?.apiKey ?? null;
}
