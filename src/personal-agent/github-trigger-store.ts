import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canExecuteOnHost } from '../host-execution-policy.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}
let database: Database | null = null;
const db = () => {
  if (!database) throw new Error('GitHub trigger database is not initialized');
  return database;
};
export function bindGithubTriggerDatabase(value: Database | null) {
  database = value;
}
export class GithubTriggerError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export const GithubTriggerCreateSchema = z
  .object({
    workspace_jid: z.string().startsWith('web:').max(256),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
      .transform((s) => s.toLowerCase()),
    secret_variable: z
      .string()
      .regex(/^MINICLAW_GITHUB_WEBHOOK_[A-Z0-9_]{1,80}$/)
      .refine((name) => name !== 'MINICLAW_GITHUB_WEBHOOK_GRANTS'),
    objective: z.string().trim().min(1).max(8000),
    completion_criteria: z
      .array(z.string().trim().min(1).max(2000))
      .min(1)
      .max(10),
    events: z
      .array(z.enum(['workflow_failure', 'pull_request']))
      .min(1)
      .max(2)
      .transform((v) => [...new Set(v)].sort()),
    max_goals: z.number().int().min(1).max(100).default(10),
    runs_per_goal: z.number().int().min(1).max(10).default(1),
    cooldown_seconds: z.number().int().min(0).max(86400).default(300),
  })
  .strict();
export type GithubTriggerConfig = z.infer<typeof GithubTriggerCreateSchema>;
const signingGrantSchema = z
  .array(
    z
      .object({
        owner_user_id: z.string().min(1).max(200),
        workspace_jid: z.string().startsWith('web:').max(256),
        secret_variable: GithubTriggerCreateSchema.shape.secret_variable,
      })
      .strict(),
  )
  .max(100);
function signingGrants() {
  const raw = process.env.MINICLAW_GITHUB_WEBHOOK_GRANTS;
  if (!raw || Buffer.byteLength(raw) > 65536) return [];
  try {
    const parsed = signingGrantSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function githubSigningVariables(ownerId: string) {
  return [
    ...new Set(
      signingGrants()
        .filter(
          (grant) =>
            grant.owner_user_id === ownerId &&
            db()
              .prepare(
                'SELECT 1 FROM registered_groups WHERE jid=? AND created_by=?',
              )
              .get(grant.workspace_jid, ownerId) &&
            Buffer.byteLength(process.env[grant.secret_variable] ?? '') >= 32 &&
            Buffer.byteLength(process.env[grant.secret_variable] ?? '') <= 4096,
        )
        .map((grant) => grant.secret_variable),
    ),
  ].sort();
}
function hasSigningGrant(
  trigger: Pick<
    GithubTrigger,
    'owner_user_id' | 'workspace_jid' | 'secret_variable'
  >,
) {
  return signingGrants().some(
    (grant) =>
      grant.owner_user_id === trigger.owner_user_id &&
      grant.workspace_jid === trigger.workspace_jid &&
      grant.secret_variable === trigger.secret_variable,
  );
}
export type GithubTrigger = GithubTriggerConfig & {
  id: string;
  owner_user_id: string;
  workspace_folder: string;
  state: 'active' | 'paused' | 'cancelled';
  revision: number;
  admitted_goals: number;
  last_admitted_at: string | null;
  created_at: string;
};
type TriggerRow = Omit<GithubTrigger, keyof GithubTriggerConfig> & {
  config: string;
};
const mapTrigger = (row: TriggerRow): GithubTrigger => {
  return {
    ...(JSON.parse(row.config) as GithubTriggerConfig),
    id: row.id,
    owner_user_id: row.owner_user_id,
    workspace_folder: row.workspace_folder,
    state: row.state,
    revision: row.revision,
    admitted_goals: row.admitted_goals,
    last_admitted_at: row.last_admitted_at,
    created_at: row.created_at,
  };
};
export type GithubEventReceipt = {
  delivery_id: string;
  state: 'created' | 'ignored' | 'suppressed';
  reason: string;
  goal_id: string | null;
  run_id: string | null;
  created_at: string;
};
export function createGithubTriggerSchema(connection: Database) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS github_goal_triggers (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_jid TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
      workspace_folder TEXT NOT NULL, config TEXT NOT NULL CHECK(json_valid(config)),
      state TEXT NOT NULL CHECK(state IN ('active','paused','cancelled')), revision INTEGER NOT NULL DEFAULT 1,
      admitted_goals INTEGER NOT NULL DEFAULT 0, last_admitted_at TEXT,
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(owner_user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS github_goal_events (
      trigger_id TEXT NOT NULL REFERENCES github_goal_triggers(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL, payload_digest TEXT NOT NULL, event_key TEXT,
      state TEXT NOT NULL CHECK(state IN ('created','ignored','suppressed')), reason TEXT NOT NULL,
      goal_id TEXT, run_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(trigger_id,delivery_id)
    );
    CREATE INDEX IF NOT EXISTS github_goal_events_semantic ON github_goal_events(trigger_id,event_key);
    CREATE INDEX IF NOT EXISTS github_goal_events_goal ON github_goal_events(goal_id);
    CREATE TRIGGER IF NOT EXISTS github_trigger_identity_immutable BEFORE UPDATE OF owner_user_id,workspace_jid,workspace_folder,config,request_id,request_digest ON github_goal_triggers
      BEGIN SELECT RAISE(ABORT,'GitHub trigger identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS github_event_receipt_immutable BEFORE UPDATE ON github_goal_events
      BEGIN SELECT RAISE(ABORT,'GitHub event receipt is immutable'); END;
  `);
}
export function getGithubTrigger(id: string, ownerId?: string) {
  const row = db()
    .prepare(
      `SELECT t.* FROM github_goal_triggers t
    JOIN users u ON u.id=t.owner_user_id AND u.status='active' AND u.deleted_at IS NULL
    JOIN registered_groups w ON w.jid=t.workspace_jid AND w.created_by=t.owner_user_id AND w.folder=t.workspace_folder
    WHERE t.id=? ${ownerId === undefined ? '' : 'AND t.owner_user_id=?'}`,
    )
    .get(...(ownerId === undefined ? [id] : [id, ownerId])) as
    | TriggerRow
    | undefined;
  return row ? mapTrigger(row) : undefined;
}
export function listGithubTriggers(ownerId: string) {
  const ids = db()
    .prepare(
      'SELECT id FROM github_goal_triggers WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 200',
    )
    .all(ownerId) as { id: string }[];
  return ids.flatMap(({ id }) => getGithubTrigger(id, ownerId) ?? []);
}
export function requireGithubExecution(trigger: GithubTrigger) {
  const owner = db()
    .prepare(
      'SELECT id,role,status FROM users WHERE id=? AND deleted_at IS NULL',
    )
    .get(trigger.owner_user_id) as Parameters<typeof canExecuteOnHost>[0];
  const group = db()
    .prepare(
      'SELECT execution_mode FROM registered_groups WHERE jid=? AND created_by=? AND folder=?',
    )
    .get(
      trigger.workspace_jid,
      trigger.owner_user_id,
      trigger.workspace_folder,
    ) as { execution_mode: string } | undefined;
  if (
    !canExecuteOnHost(owner) ||
    group?.execution_mode !== 'host' ||
    !hasSigningGrant(trigger)
  )
    throw new GithubTriggerError('TRIGGER_NOT_FOUND');
}
export function createGithubTrigger(
  ownerId: string,
  requestId: string,
  raw: unknown,
) {
  const config = GithubTriggerCreateSchema.parse(raw);
  if (!requestId.trim() || requestId.length > 128)
    throw new GithubTriggerError('INVALID_REQUEST_ID');
  const digest = createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');
  return db().transaction(() => {
    const old = db()
      .prepare(
        'SELECT id,request_digest FROM github_goal_triggers WHERE owner_user_id=? AND request_id=?',
      )
      .get(ownerId, requestId) as
      | { id: string; request_digest: string }
      | undefined;
    if (old) {
      if (old.request_digest !== digest)
        throw new GithubTriggerError('REQUEST_CONFLICT');
      const trigger = getGithubTrigger(old.id, ownerId);
      if (!trigger) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
      return trigger;
    }
    const group = db()
      .prepare(
        'SELECT folder FROM registered_groups WHERE jid=? AND created_by=?',
      )
      .get(config.workspace_jid, ownerId) as { folder: string } | undefined;
    if (!group) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
    const trigger: GithubTrigger = {
      ...config,
      id: randomUUID(),
      owner_user_id: ownerId,
      workspace_folder: group.folder,
      state: 'active',
      revision: 1,
      admitted_goals: 0,
      last_admitted_at: null,
      created_at: new Date().toISOString(),
    };
    requireGithubExecution(trigger);
    const secretBytes = Buffer.byteLength(
      process.env[config.secret_variable] ?? '',
    );
    if (secretBytes < 32 || secretBytes > 4096)
      throw new GithubTriggerError('WEBHOOK_SECRET_UNAVAILABLE');
    db()
      .prepare(
        'INSERT INTO github_goal_triggers(id,owner_user_id,workspace_jid,workspace_folder,config,state,request_id,request_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        trigger.id,
        ownerId,
        config.workspace_jid,
        group.folder,
        JSON.stringify(config),
        'active',
        requestId,
        digest,
        trigger.created_at,
      );
    return trigger;
  })();
}
export function listGithubEventReceipts(
  triggerId: string,
): GithubEventReceipt[] {
  return db()
    .prepare(
      'SELECT delivery_id,state,reason,goal_id,run_id,created_at FROM github_goal_events WHERE trigger_id=? ORDER BY rowid DESC LIMIT 100',
    )
    .all(triggerId) as GithubEventReceipt[];
}
export function githubGoalSourceAllowed(goalId: string): boolean {
  const linked = db()
    .prepare(`SELECT trigger_id FROM github_goal_events WHERE goal_id=?`)
    .get(goalId) as { trigger_id: string } | undefined;
  if (!linked) return true;
  const trigger = getGithubTrigger(linked.trigger_id);
  if (!trigger || trigger.state === 'cancelled') return false;
  try {
    requireGithubExecution(trigger);
    return true;
  } catch {
    return false;
  }
}

/** All effects in `provision` must use this same SQLite connection. No network IO. */
export function admitGithubEvent(
  triggerId: string,
  deliveryId: string,
  payloadDigest: string,
  event: { key: string; kind: string; context: string } | null,
  provision: (trigger: GithubTrigger) => { goalId: string; runId: string },
): GithubEventReceipt {
  return db().transaction(() => {
    const trigger = getGithubTrigger(triggerId);
    if (!trigger) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
    requireGithubExecution(trigger);
    const previous = db()
      .prepare(
        'SELECT * FROM github_goal_events WHERE trigger_id=? AND delivery_id=?',
      )
      .get(triggerId, deliveryId) as
      | (GithubEventReceipt & { payload_digest: string })
      | undefined;
    if (previous) {
      if (previous.payload_digest !== payloadDigest)
        throw new GithubTriggerError('DELIVERY_CONFLICT');
      const { delivery_id, state, reason, goal_id, run_id, created_at } =
        previous;
      return { delivery_id, state, reason, goal_id, run_id, created_at };
    }
    // Never discard deduplication records to make room for a replay. Close intake instead.
    const count = db()
      .prepare(
        'SELECT count(*) AS n FROM github_goal_events WHERE trigger_id=?',
      )
      .get(triggerId) as { n: number };
    if (count.n >= 10000)
      throw new GithubTriggerError('RECEIPT_CAPACITY_REACHED');
    const now = new Date().toISOString();
    let reason =
      !event ||
      !trigger.events.includes(
        event.kind as GithubTriggerConfig['events'][number],
      )
        ? 'event_filtered'
        : '';
    let state: GithubEventReceipt['state'] = reason ? 'ignored' : 'created';
    if (trigger.state !== 'active') reason = `trigger_${trigger.state}`;
    if (
      !reason &&
      event &&
      db()
        .prepare(
          'SELECT 1 FROM github_goal_events WHERE trigger_id=? AND event_key=?',
        )
        .get(triggerId, event.key)
    )
      reason = 'duplicate_event';
    if (!reason && trigger.admitted_goals >= trigger.max_goals)
      reason = 'goal_budget_exhausted';
    if (
      !reason &&
      trigger.last_admitted_at &&
      Date.now() - Date.parse(trigger.last_admitted_at) <
        trigger.cooldown_seconds * 1000
    )
      reason = 'cooldown';
    if (reason && state !== 'ignored') state = 'suppressed';
    const result = state === 'created' ? provision(trigger) : null;
    if (result)
      db()
        .prepare(
          'UPDATE github_goal_triggers SET admitted_goals=admitted_goals+1,last_admitted_at=?,revision=revision+1 WHERE id=?',
        )
        .run(now, triggerId);
    const receipt: GithubEventReceipt = {
      delivery_id: deliveryId,
      state,
      reason: reason || 'goal_created',
      goal_id: result?.goalId ?? null,
      run_id: result?.runId ?? null,
      created_at: now,
    };
    db()
      .prepare(
        'INSERT INTO github_goal_events(trigger_id,delivery_id,payload_digest,event_key,state,reason,goal_id,run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        triggerId,
        deliveryId,
        payloadDigest,
        event?.key ?? null,
        state,
        receipt.reason,
        receipt.goal_id,
        receipt.run_id,
        now,
      );
    return receipt;
  })();
}

/** Persist the cancellation fence before stopping processes. Retry returns the same targets. */
export function changeGithubTriggerState(
  ownerId: string,
  id: string,
  revision: number,
  state: GithubTrigger['state'],
  cancel: (goalId: string) => void,
) {
  return db().transaction(() => {
    const trigger = getGithubTrigger(id, ownerId);
    if (!trigger) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
    if (trigger.state !== state && trigger.revision !== revision)
      throw new GithubTriggerError('REVISION_CONFLICT');
    if (trigger.state === 'cancelled' && state !== 'cancelled')
      throw new GithubTriggerError('TRIGGER_TERMINAL');
    if (trigger.state !== state)
      db()
        .prepare(
          'UPDATE github_goal_triggers SET state=?,revision=revision+1 WHERE id=?',
        )
        .run(state, id);
    const goals = db()
      .prepare(
        'SELECT goal_id FROM github_goal_events WHERE trigger_id=? AND goal_id IS NOT NULL',
      )
      .all(id) as { goal_id: string }[];
    if (state === 'cancelled') for (const goal of goals) cancel(goal.goal_id);
    return {
      trigger: getGithubTrigger(id, ownerId)!,
      goalIds: state === 'cancelled' ? goals.map((g) => g.goal_id) : [],
    };
  })();
}
