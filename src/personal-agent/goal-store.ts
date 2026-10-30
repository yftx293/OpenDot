import {
  verifyCloudGoalDeviceEvidence,
  verifyGoalRequiredDevices,
  readCloudGoalDeviceEvidence,
} from './cloud-device-evidence.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PersonalGoalExecutionSnapshot } from '../types.js';
import { githubGoalSourceAllowed } from './github-trigger-store.js';
import {
  GoalTeamSchema,
  validateGoalTeamDefinition,
  bindGoalTeamDatabase,
  createGoalTeamSchema,
  bindGoalTeam,
  goalTeam,
  goalTeamSourceAllowed,
  goalTeamForSession,
  projectGoalTeamOutcome,
  type GoalTeam,
} from './goal-team-store.js';
import { notifyBotGroupUpdate } from '../bot-groups/events.js';
import {
  assertCloudGoalBase,
  CLOUD_GOAL_RUN_LIMIT,
  GoalContextLimit,
} from './goal-context.js';

interface Statement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface GoalDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}
let database: GoalDatabase | null = null;
const db = () => {
  if (!database) throw new Error('Goal database is not initialized');
  return database;
};

export const GOAL_STATUSES = [
  'pending',
  'running',
  'paused',
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_device',
  'completed',
  'failed',
  'cancelled',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GoalCreateSchema = z
  .object({
    workspace_jid: z.string().startsWith('web:').max(256),
    objective: z.string().trim().min(1).max(16_000),
    completion_criteria: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1)
      .max(20),
    next_action: z.string().trim().max(4_000).default(''),
    budget_max_runs: z.number().int().min(1).max(10_000).default(10),
    session_id: z.string().min(1).max(200).nullable().default(null),
    runtime: z.enum(['node-durable', 'cloudflare-durable']).optional(),
    team: GoalTeamSchema.optional(),
  })
  .strict();
export const GoalPatchSchema = GoalCreateSchema.omit({
  workspace_jid: true,
  session_id: true,
  runtime: true,
  team: true,
})
  .partial()
  .extend({
    // Zod 4 applies nested creation defaults even through partial(). A PATCH
    // must preserve omitted fields, especially the user's spending budget.
    next_action: GoalCreateSchema.shape.next_action.removeDefault().optional(),
    budget_max_runs: GoalCreateSchema.shape.budget_max_runs
      .removeDefault()
      .optional(),
    expected_revision: z.number().int().positive(),
    status: z.enum(GOAL_STATUSES).optional(),
  })
  .strict();

export interface PersonalGoal {
  team?: GoalTeam;
  id: string;
  owner_user_id: string;
  workspace_jid: string;
  objective: string;
  completion_criteria: string[];
  next_action: string;
  status: GoalStatus;
  budget_max_runs: number;
  budget_used_runs: number;
  session_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
type GoalRow = Omit<PersonalGoal, 'completion_criteria'> & {
  completion_criteria: string;
  create_request_id: string;
  create_request_hash: string;
};
export class GoalConflict extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const mapGoal = (row: GoalRow): PersonalGoal => {
  const {
    create_request_id: _request,
    create_request_hash: _hash,
    completion_criteria,
    ...goal
  } = row;
  return {
    ...goal,
    ...(goalTeam(goal.id) ? { team: goalTeam(goal.id) } : {}),
    completion_criteria: JSON.parse(completion_criteria) as string[],
  };
};

export function bindPersonalGoalDatabase(value: GoalDatabase | null): void {
  database = value;
  bindGoalTeamDatabase(value);
}

export function createPersonalGoalSchema(connection: GoalDatabase): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS personal_goals (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_jid TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      completion_criteria TEXT NOT NULL CHECK(json_valid(completion_criteria)),
      next_action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','waiting_for_input','waiting_for_approval','waiting_for_device','completed','failed','cancelled')),
      budget_max_runs INTEGER NOT NULL CHECK(budget_max_runs > 0),
      budget_used_runs INTEGER NOT NULL DEFAULT 0 CHECK(budget_used_runs >= 0),
      session_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      create_request_id TEXT NOT NULL,
      create_request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, create_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_personal_goals_owner ON personal_goals(owner_user_id, updated_at);
    CREATE TABLE IF NOT EXISTS personal_goal_tasks (
      goal_id TEXT NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL UNIQUE REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      PRIMARY KEY(goal_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS personal_goal_charges (
      run_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_goal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL CHECK(json_valid(detail)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_personal_goal_events_goal ON personal_goal_events(goal_id, id);
    CREATE TABLE IF NOT EXISTS goal_execution_contexts (
      run_id TEXT PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE, goal_id TEXT NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), generation_steps INTEGER NOT NULL DEFAULT 0,
      outcome TEXT, evidence TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence)), evaluated_at TEXT
    );
    CREATE TRIGGER IF NOT EXISTS goal_execution_context_immutable BEFORE UPDATE OF run_id,task_id,goal_id,session_id,owner_user_id,snapshot ON goal_execution_contexts
      WHEN NEW.run_id!=OLD.run_id OR NEW.task_id!=OLD.task_id OR NEW.goal_id!=OLD.goal_id OR NEW.session_id!=OLD.session_id
        OR NEW.owner_user_id!=OLD.owner_user_id OR NEW.snapshot!=OLD.snapshot
      BEGIN SELECT RAISE(ABORT,'Goal execution context is immutable'); END;
  `);
  const taskColumns = connection
    .prepare('PRAGMA table_info(personal_goal_tasks)')
    .all() as { name: string }[];
  if (!taskColumns.some((row) => row.name === 'automatic'))
    connection.exec(
      'ALTER TABLE personal_goal_tasks ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0',
    );
  connection.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_automatic_task ON personal_goal_tasks(goal_id) WHERE automatic=1',
  );
  createGoalTeamSchema(connection);
}

const visibleGoalSql = `SELECT g.* FROM personal_goals g
  JOIN registered_groups w ON w.jid = g.workspace_jid AND w.created_by = g.owner_user_id
  JOIN users u ON u.id = g.owner_user_id AND u.status = 'active' AND u.deleted_at IS NULL
  WHERE g.owner_user_id = ?`;

export function getPersonalGoal(
  ownerId: string,
  id: string,
): PersonalGoal | undefined {
  const row = db()
    .prepare(`${visibleGoalSql} AND g.id = ?`)
    .get(ownerId, id) as GoalRow | undefined;
  return row ? mapGoal(row) : undefined;
}

export function listPersonalGoals(ownerId: string): PersonalGoal[] {
  return (
    db()
      .prepare(`${visibleGoalSql} ORDER BY g.updated_at DESC, g.id LIMIT 200`)
      .all(ownerId) as GoalRow[]
  ).map(mapGoal);
}

function requireGoal(
  ownerId: string,
  id: string,
  revision?: number,
): PersonalGoal {
  const goal = getPersonalGoal(ownerId, id);
  if (!goal) throw new GoalConflict('GOAL_NOT_FOUND', 'Goal not found');
  if (revision !== undefined && revision !== goal.revision) {
    throw new GoalConflict(
      'GOAL_REVISION_CONFLICT',
      'Goal changed; reload and retry',
    );
  }
  return goal;
}

function touchGoalRuntime(goalId: string) {
  db()
    .prepare(
      'UPDATE product_session_runtimes SET revision=revision+1 WHERE goal_id=?',
    )
    .run(goalId);
}

function event(goalId: string, kind: string, detail: object): void {
  db()
    .prepare(
      'INSERT INTO personal_goal_events(goal_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(goalId, kind, JSON.stringify(detail), new Date().toISOString());
  touchGoalRuntime(goalId);
}

export function createPersonalGoal(
  ownerId: string,
  requestId: string,
  raw: unknown,
  provision?: (goal: PersonalGoal) => void,
): PersonalGoal {
  const input = GoalCreateSchema.parse(raw);
  if (input.runtime && input.session_id)
    throw new GoalConflict(
      'GOAL_SESSION_MISMATCH',
      'Runtime selection is only available for a new Goal Session',
    );
  if (!requestId.trim() || Buffer.byteLength(requestId) > 200)
    throw new GoalConflict(
      'GOAL_REQUEST_ID_REQUIRED',
      'A request ID of 1–200 bytes is required',
    );
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return db().transaction(() => {
    const workspace = db()
      .prepare(
        `SELECT w.folder FROM registered_groups w JOIN users u ON u.id = w.created_by
      WHERE w.jid = ? AND w.created_by = ? AND u.status = 'active' AND u.deleted_at IS NULL`,
      )
      .get(input.workspace_jid, ownerId) as { folder: string } | undefined;
    if (!workspace)
      throw new GoalConflict('GOAL_NOT_FOUND', 'Workspace not found');
    if (input.session_id) {
      const managed = db()
        .prepare(
          'SELECT goal_id FROM product_session_runtimes WHERE session_id=? AND goal_id IS NOT NULL',
        )
        .get(input.session_id);
      if (managed)
        throw new GoalConflict(
          'GOAL_SESSION_MISMATCH',
          'This Session already has an immutable Goal owner',
        );
      const session = db()
        .prepare(
          'SELECT 1 FROM agents WHERE id = ? AND chat_jid = ? AND group_folder = ? AND created_by = ?',
        )
        .get(input.session_id, input.workspace_jid, workspace.folder, ownerId);
      if (!session)
        throw new GoalConflict(
          'GOAL_SESSION_MISMATCH',
          'Session does not belong to the Goal workspace',
        );
    }
    const previous = db()
      .prepare(
        'SELECT * FROM personal_goals WHERE owner_user_id = ? AND create_request_id = ?',
      )
      .get(ownerId, requestId) as GoalRow | undefined;
    if (previous) {
      if (previous.create_request_hash !== digest)
        throw new GoalConflict(
          'GOAL_REQUEST_CONFLICT',
          'Request ID was used with different Goal content',
        );
      return requireGoal(ownerId, previous.id);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db()
      .prepare(
        `INSERT INTO personal_goals(id,owner_user_id,workspace_jid,objective,completion_criteria,next_action,
      budget_max_runs,session_id,create_request_id,create_request_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        ownerId,
        input.workspace_jid,
        input.objective,
        JSON.stringify(input.completion_criteria),
        input.next_action,
        input.budget_max_runs,
        input.session_id,
        requestId,
        digest,
        now,
        now,
      );
    event(id, 'created', { actor_id: ownerId });
    if (input.team) bindGoalTeam(requireGoal(ownerId, id), input.team);
    provision?.(requireGoal(ownerId, id));
    const created = requireGoal(ownerId, id);
    if (input.team && !created.session_id)
      throw new GoalConflict(
        'GOAL_TEAM_RUNTIME_REQUIRED',
        'Team Goal requires an existing managed Goal execution',
      );
    if (input.runtime) {
      const binding =
        created.session_id &&
        (db()
          .prepare(
            `SELECT r.goal_id,r.runtime_kind,c.session_id AS cloud_id FROM product_session_runtimes r LEFT JOIN product_cloud_sessions c ON c.session_id=r.session_id WHERE r.session_id=?`,
          )
          .get(created.session_id) as
          | { goal_id: string; runtime_kind: string; cloud_id: string | null }
          | undefined);
      if (
        !binding ||
        binding.goal_id !== id ||
        binding.runtime_kind !== 'pi-durable' ||
        (input.runtime === 'cloudflare-durable') !== !!binding.cloud_id
      )
        throw new GoalConflict(
          'GOAL_RUNTIME_UNAVAILABLE',
          'Requested Goal runtime was not provisioned',
        );
    }
    return created;
  })();
}

export function patchPersonalGoal(
  ownerId: string,
  id: string,
  raw: unknown,
): PersonalGoal {
  const input = GoalPatchSchema.parse(raw);
  return db().transaction(() => {
    const goal = requireGoal(ownerId, id, input.expected_revision);
    if (
      ['pending', 'running'].includes(input.status ?? '') &&
      !goalTeamSourceAllowed(id)
    )
      throw new GoalConflict(
        'GOAL_TEAM_UNAVAILABLE',
        'Goal Team authorization changed',
      );
    if (['completed', 'cancelled'].includes(goal.status))
      throw new GoalConflict(
        'GOAL_TERMINAL',
        'A terminal Goal cannot be reopened or edited',
      );
    if (
      input.status === 'completed' &&
      !verifyGoalRequiredDevices(db(), goal.id)
    )
      throw new GoalConflict(
        'GOAL_DEVICE_EVIDENCE_REQUIRED',
        'GOAL_DEVICE_EVIDENCE_REQUIRED: the declared local file requires a verified read receipt',
      );
    const budget = input.budget_max_runs ?? goal.budget_max_runs;
    if (budget < goal.budget_used_runs)
      throw new GoalConflict(
        'GOAL_BUDGET_CONFLICT',
        'Budget cannot be below already started executions',
      );
    const next = { ...goal, ...input };
    if (
      input.objective !== undefined ||
      input.completion_criteria !== undefined ||
      input.next_action !== undefined ||
      input.budget_max_runs !== undefined
    )
      validateCloudGoalDefinition({ ...next, revision: goal.revision + 1 });
    db()
      .prepare(
        `UPDATE personal_goals SET objective=?,completion_criteria=?,next_action=?,status=?,budget_max_runs=?,revision=revision+1,updated_at=? WHERE id=?`,
      )
      .run(
        next.objective,
        JSON.stringify(next.completion_criteria),
        next.next_action,
        next.status,
        budget,
        new Date().toISOString(),
        id,
      );
    event(id, 'updated', {
      actor_id: ownerId,
      from_status: goal.status,
      status: next.status,
      revision: goal.revision + 1,
    });
    return requireGoal(ownerId, id);
  })();
}

export function linkPersonalGoalTask(
  ownerId: string,
  goalId: string,
  taskId: string,
  revision: number,
): PersonalGoal {
  return db().transaction(() => {
    const goal = requireGoal(ownerId, goalId, revision);
    if (['completed', 'cancelled'].includes(goal.status))
      throw new GoalConflict(
        'GOAL_TERMINAL',
        'Cannot link tasks to a terminal Goal',
      );
    const task = db()
      .prepare(
        `SELECT t.id FROM scheduled_tasks t JOIN registered_groups w ON w.jid = ?
      WHERE t.id = ? AND t.created_by = ? AND t.chat_jid = w.jid AND t.group_folder = w.folder
        AND t.execution_type = 'agent' AND t.status = 'paused' AND t.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.task_id=t.id AND
          (r.status IN ('queued','running','retry_wait') OR (r.status='delivered' AND json_extract(r.definition_snapshot,'$.context_mode')='group')))`,
      )
      .get(goal.workspace_jid, taskId, ownerId);
    if (!task)
      throw new GoalConflict(
        'GOAL_TASK_INELIGIBLE',
        'Link an owned, paused Agent task in the same workspace with no active run',
      );
    const existing = db()
      .prepare('SELECT goal_id FROM personal_goal_tasks WHERE task_id = ?')
      .get(taskId) as { goal_id: string } | undefined;
    if (existing?.goal_id === goalId) return goal;
    if (existing)
      throw new GoalConflict(
        'GOAL_TASK_ALREADY_LINKED',
        'Task already belongs to another Goal',
      );
    db()
      .prepare(
        'INSERT INTO personal_goal_tasks(goal_id,task_id,linked_at) VALUES (?,?,?)',
      )
      .run(goalId, taskId, new Date().toISOString());
    db()
      .prepare(
        'UPDATE personal_goals SET revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(new Date().toISOString(), goalId);
    event(goalId, 'task_linked', { actor_id: ownerId, task_id: taskId });
    return requireGoal(ownerId, goalId);
  })();
}

export function listPersonalGoalTaskIds(ownerId: string, id: string): string[] {
  requireGoal(ownerId, id);
  return (
    db()
      .prepare(
        'SELECT task_id FROM personal_goal_tasks WHERE goal_id=? ORDER BY linked_at,task_id',
      )
      .all(id) as { task_id: string }[]
  ).map((row) => row.task_id);
}

export function listPersonalGoalEvents(ownerId: string, id: string) {
  requireGoal(ownerId, id);
  return (
    db()
      .prepare(
        'SELECT id,kind,detail,created_at FROM personal_goal_events WHERE goal_id=? ORDER BY id DESC LIMIT 100',
      )
      .all(id) as {
      id: number;
      kind: string;
      detail: string;
      created_at: string;
    }[]
  ).map((row) => ({
    ...row,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}

type GoalTask = {
  automatic: number;
  goal_id: string;
  task_id: string;
  owner_user_id: string;
  workspace_jid: string;
  status: GoalStatus;
  budget_max_runs: number;
  budget_used_runs: number;
};
function goalForTask(taskId: string): GoalTask | undefined {
  return db()
    .prepare(
      `SELECT gt.goal_id,gt.task_id,gt.automatic,g.owner_user_id,g.workspace_jid,g.status,g.budget_max_runs,g.budget_used_runs
    FROM personal_goal_tasks gt LEFT JOIN personal_goals g ON g.id=gt.goal_id WHERE gt.task_id=?`,
    )
    .get(taskId) as GoalTask | undefined;
}

export function personalGoalTaskBlockReason(
  taskId: string,
  alreadyCharged = false,
): string | undefined {
  const linked = goalForTask(taskId);
  if (!linked) return undefined;
  if (!goalTeamSourceAllowed(linked.goal_id))
    return 'Goal Team authorization changed';
  if (!githubGoalSourceAllowed(linked.goal_id))
    return 'GitHub routine cancelled or authorization revoked';
  if (
    !linked.owner_user_id ||
    !getPersonalGoal(linked.owner_user_id, linked.goal_id)
  )
    return 'Goal ownership or workspace access changed';
  if (
    !['pending', 'running'].includes(linked.status) &&
    !(
      alreadyCharged &&
      ['waiting_for_approval', 'waiting_for_device'].includes(linked.status)
    )
  )
    return `Goal is ${linked.status}`;
  if (!alreadyCharged && linked.budget_used_runs >= linked.budget_max_runs)
    return 'Goal execution budget exhausted';
  const task = db()
    .prepare(
      `SELECT 1 FROM scheduled_tasks t JOIN registered_groups w ON w.jid=?
    WHERE t.id=? AND t.created_by=? AND t.chat_jid=w.jid AND t.group_folder=w.folder
      AND t.execution_type='agent' AND t.deleted_at IS NULL`,
    )
    .get(linked.workspace_jid, taskId, linked.owner_user_id);
  return task
    ? undefined
    : 'Goal task workspace, owner, or execution capability changed';
}

/** Called on the same DB transaction line as the Scheduler's irreversible start marker. */
export function reservePersonalGoalExecution(runId: string): boolean {
  const run = db()
    .prepare('SELECT task_id,definition_snapshot FROM task_runs WHERE id=?')
    .get(runId) as { task_id: string; definition_snapshot: string } | undefined;
  if (!run) return false;
  const goal = goalForTask(run.task_id);
  if (!goal) return true;
  const previous = db()
    .prepare('SELECT goal_id,task_id FROM personal_goal_charges WHERE run_id=?')
    .get(runId) as { goal_id: string; task_id: string } | undefined;
  if (personalGoalTaskBlockReason(run.task_id, Boolean(previous))) return false;
  const snapshot = JSON.parse(run.definition_snapshot) as {
    chat_jid?: string;
    group_folder?: string;
    execution_type?: string;
  };
  const workspace = db()
    .prepare('SELECT folder FROM registered_groups WHERE jid=?')
    .get(goal.workspace_jid) as { folder: string };
  if (
    snapshot.chat_jid !== goal.workspace_jid ||
    snapshot.group_folder !== workspace.folder ||
    snapshot.execution_type !== 'agent'
  )
    return false;
  if (previous) {
    const same =
      previous.goal_id === goal.goal_id && previous.task_id === run.task_id;
    if (same)
      db()
        .prepare(
          "UPDATE personal_goals SET status='running',revision=revision+1,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(new Date().toISOString(), goal.goal_id);
    if (same) touchGoalRuntime(goal.goal_id);
    return same;
  }
  db()
    .prepare(
      'INSERT INTO personal_goal_charges(run_id,goal_id,task_id,created_at) VALUES (?,?,?,?)',
    )
    .run(runId, goal.goal_id, run.task_id, new Date().toISOString());
  db()
    .prepare(
      `UPDATE personal_goals SET budget_used_runs=budget_used_runs+1,status='running',revision=revision+1,updated_at=? WHERE id=?`,
    )
    .run(new Date().toISOString(), goal.goal_id);
  event(goal.goal_id, 'execution_started', {
    task_id: run.task_id,
    run_id: runId,
  });
  return true;
}

// Correlated to the existing Scheduler table, not a second scheduling loop.
export const PERSONAL_GOAL_SCHEDULE_ELIGIBILITY = `NOT EXISTS (
  SELECT 1 FROM personal_goal_tasks gt LEFT JOIN personal_goals g ON g.id=gt.goal_id
  WHERE gt.task_id=scheduled_tasks.id AND
    (g.id IS NULL OR g.status NOT IN ('pending','running') OR g.budget_used_runs >= g.budget_max_runs)
)`;

export function personalGoalContentDigest(
  goal: Pick<PersonalGoal, 'objective' | 'completion_criteria' | 'next_action'>,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        objective: goal.objective,
        completion_criteria: goal.completion_criteria,
        next_action: goal.next_action,
      }),
    )
    .digest('hex');
}
export function attachAutomaticGoalSession(
  ownerId: string,
  goalId: string,
  sessionId: string,
) {
  const goal = requireGoal(ownerId, goalId);
  if (goal.session_id && goal.session_id !== sessionId)
    throw new GoalConflict(
      'GOAL_SESSION_MISMATCH',
      'Goal Session already bound',
    );
  const session = db()
    .prepare(
      "SELECT 1 FROM agents a JOIN product_session_runtimes r ON r.session_id=a.id WHERE a.id=? AND a.created_by=? AND a.chat_jid=? AND r.runtime_kind='pi-durable'",
    )
    .get(sessionId, ownerId, goal.workspace_jid);
  if (!session)
    throw new GoalConflict(
      'GOAL_SESSION_MISMATCH',
      'Durable Goal Session is unavailable',
    );
  db()
    .prepare(
      'UPDATE personal_goals SET session_id=? WHERE id=? AND session_id IS NULL',
    )
    .run(sessionId, goalId);
}
export function goalForProductSession(
  sessionId: string,
): PersonalGoal | undefined {
  const row = db()
    .prepare(
      'SELECT g.owner_user_id,g.id FROM personal_goals g JOIN product_session_runtimes r ON r.goal_id=g.id AND r.session_id=g.session_id JOIN personal_goal_tasks gt ON gt.goal_id=g.id AND gt.automatic=1 WHERE r.session_id=?',
    )
    .get(sessionId) as { owner_user_id: string; id: string } | undefined;
  return row ? getPersonalGoal(row.owner_user_id, row.id) : undefined;
}
export function isGoalProductSession(sessionId: string): boolean {
  return Boolean(
    db()
      .prepare(
        'SELECT 1 FROM product_session_runtimes WHERE session_id=? AND goal_id IS NOT NULL',
      )
      .get(sessionId),
  );
}
export function snapshotPersonalGoalExecution(
  taskId: string,
): PersonalGoalExecutionSnapshot | undefined {
  const linked = goalForTask(taskId);
  if (!linked?.automatic) return;
  const goal = requireGoal(linked.owner_user_id, linked.goal_id);
  if (!goal.session_id) return;
  const runtime = db()
    .prepare(
      'SELECT owner_user_id,workspace_jid,runtime_kind,state,goal_id FROM product_session_runtimes WHERE session_id=?',
    )
    .get(goal.session_id) as
    | {
        owner_user_id: string;
        workspace_jid: string;
        runtime_kind: string;
        state: string;
        goal_id: string | null;
      }
    | undefined;
  if (!runtime)
    throw new GoalConflict(
      'GOAL_SESSION_MISMATCH',
      'Goal Session has no trusted runtime mapping',
    );
  if (runtime.runtime_kind !== 'pi-durable') return;
  if (
    runtime.goal_id !== goal.id ||
    runtime.owner_user_id !== goal.owner_user_id ||
    runtime.workspace_jid !== goal.workspace_jid ||
    runtime.state === 'blocked'
  )
    throw new GoalConflict('GOAL_SESSION_MISMATCH', 'Goal runtime is blocked');
  const previous = db()
    .prepare(
      'SELECT c.run_id,t.result,c.outcome FROM goal_execution_contexts c JOIN task_runs t ON t.id=c.run_id WHERE c.goal_id=? ORDER BY t.created_at DESC LIMIT 3',
    )
    .all(goal.id) as {
    run_id: string;
    result: string | null;
    outcome: string | null;
  }[];
  const cloud = db()
    .prepare(
      'SELECT binding_json FROM product_cloud_sessions WHERE session_id=?',
    )
    .get(goal.session_id) as { binding_json: string } | undefined;
  return {
    goal_id: goal.id,
    goal_revision: goal.revision,
    owner_user_id: goal.owner_user_id,
    workspace_jid: goal.workspace_jid,
    session_id: goal.session_id,
    objective: goal.objective,
    completion_criteria: goal.completion_criteria,
    next_action: goal.next_action,
    content_digest: personalGoalContentDigest(goal),
    budget_remaining_runs: Math.max(
      0,
      goal.budget_max_runs - goal.budget_used_runs,
    ),
    capabilities: cloud
      ? [
          'inspect_text',
          ...((
            JSON.parse(cloud.binding_json) as { tool_capabilities?: string[] }
          ).tool_capabilities ?? []),
        ]
      : [
          'read_workspace_file',
          'create_approved_artifact',
          'read_personal_memory',
          'list_personal_devices',
          'read_device_file',
        ],
    delivery: 'session_and_workspace',
    previous_results: previous.map((row) => ({
      ...row,
      result: row.result?.slice(0, 16000) ?? null,
    })),
  };
}
/** Runs in the same Goal transaction before admission/content edits commit. */
export function validateCloudGoalDefinition(goal: PersonalGoal) {
  if (goal.team) validateGoalTeamDefinition(goal);
  if (!goal.session_id) return;
  const cloud = db()
    .prepare('SELECT session_id FROM product_cloud_sessions WHERE session_id=?')
    .get(goal.session_id);
  if (!cloud) return;
  if (goal.budget_max_runs > CLOUD_GOAL_RUN_LIMIT)
    throw new GoalConflict(
      'GOAL_CLOUD_BUDGET_LIMIT',
      'Cloud Goal run budget exceeds the Session input limit',
    );
  const task = db()
    .prepare(
      'SELECT task_id FROM personal_goal_tasks WHERE goal_id=? AND automatic=1 LIMIT 1',
    )
    .get(goal.id) as { task_id: string } | undefined;
  const snapshot = task && snapshotPersonalGoalExecution(task.task_id);
  if (!snapshot)
    throw new GoalConflict(
      'GOAL_SESSION_MISMATCH',
      'Managed Cloud Goal definition unavailable',
    );
  try {
    assertCloudGoalBase({
      ...snapshot,
      goal_revision: goal.revision,
      objective: goal.objective,
      completion_criteria: goal.completion_criteria,
      next_action: goal.next_action,
      content_digest: personalGoalContentDigest(goal),
      budget_remaining_runs: Math.max(
        0,
        goal.budget_max_runs - goal.budget_used_runs,
      ),
    });
  } catch (error) {
    if (error instanceof GoalContextLimit)
      throw new GoalConflict(error.code, error.message);
    throw error;
  }
}

export function registerPersonalGoalRun(
  runId: string,
  taskId: string,
  snapshot: PersonalGoalExecutionSnapshot | undefined,
) {
  if (!snapshot) return;
  const goal = requireGoal(snapshot.owner_user_id, snapshot.goal_id);
  if (
    goal.session_id !== snapshot.session_id ||
    !listPersonalGoalTaskIds(goal.owner_user_id, goal.id).includes(taskId)
  )
    throw new GoalConflict('GOAL_SESSION_MISMATCH', 'Goal run binding changed');
  db()
    .prepare(
      'INSERT INTO goal_execution_contexts(run_id,task_id,goal_id,session_id,owner_user_id,snapshot) VALUES (?,?,?,?,?,?)',
    )
    .run(
      runId,
      taskId,
      goal.id,
      snapshot.session_id,
      goal.owner_user_id,
      JSON.stringify(snapshot),
    );
}
export type ActiveGoalExecution = {
  run_id: string;
  task_id: string;
  goal_id: string;
  session_id: string;
  owner_user_id: string;
  snapshot: PersonalGoalExecutionSnapshot;
  lease_token: number;
  lease_owner: string;
  generation_steps: number;
};
export function activeGoalExecution(
  sessionId: string,
): ActiveGoalExecution | undefined {
  const row = db()
    .prepare(
      `SELECT c.*,t.lease_owner,t.lease_token FROM goal_execution_contexts c JOIN task_runs t ON t.id=c.run_id
    JOIN product_session_runtimes pr ON pr.session_id=c.session_id AND pr.goal_id=c.goal_id AND pr.runtime_kind='pi-durable' AND pr.state!='blocked'
    JOIN personal_goals g ON g.id=c.goal_id AND g.session_id=c.session_id JOIN personal_goal_tasks gt ON gt.goal_id=g.id AND gt.task_id=c.task_id AND gt.automatic=1 JOIN scheduled_tasks d ON d.id=c.task_id AND d.created_by=c.owner_user_id AND d.deleted_at IS NULL AND d.execution_type='agent' AND d.execution_mode='host' AND d.context_mode='isolated'
    JOIN registered_groups w ON w.jid=g.workspace_jid AND w.created_by=c.owner_user_id AND w.folder=d.group_folder
    JOIN users u ON u.id=c.owner_user_id AND u.status='active' AND u.deleted_at IS NULL
    WHERE c.session_id=? AND t.status='running' AND t.started_at IS NOT NULL AND t.lease_expires_at>? AND g.status IN ('pending','running','waiting_for_approval','waiting_for_device')`,
    )
    .get(sessionId, new Date().toISOString()) as
    | (Omit<ActiveGoalExecution, 'snapshot'> & { snapshot: string })
    | undefined;
  return row && goalTeamSourceAllowed(row.goal_id)
    ? {
        ...row,
        snapshot: JSON.parse(row.snapshot) as PersonalGoalExecutionSnapshot,
      }
    : undefined;
}
export class GoalRuntimeSuspended extends Error {}
export function assertGoalExecution(sessionId: string) {
  if (goalTeamForSession(sessionId))
    throw new GoalRuntimeSuspended(
      'Team Goal execution belongs to its selected Handoff, not the coordinator Session',
    );
  if (!isGoalProductSession(sessionId)) return;
  const current = activeGoalExecution(sessionId);
  if (!current || !githubGoalSourceAllowed(current.goal_id))
    throw new GoalRuntimeSuspended(
      'Goal has no current authorized Scheduler claim',
    );
  return current;
}
export function chargeGoalGeneration(sessionId: string) {
  const run = assertGoalExecution(sessionId);
  if (!run) return;
  // A replayed generation attempt consumes a step too; restart cannot reset it.
  if (run.generation_steps >= 12)
    throw new Error('Goal model-step budget exhausted');
  db()
    .prepare(
      'UPDATE goal_execution_contexts SET generation_steps=generation_steps+1 WHERE run_id=?',
    )
    .run(run.run_id);
}
export function refreshGoalWaiting(runId: string) {
  const row = db()
    .prepare(
      'SELECT goal_id,owner_user_id,session_id FROM goal_execution_contexts WHERE run_id=?',
    )
    .get(runId) as
    | { goal_id: string; owner_user_id: string; session_id: string }
    | undefined;
  if (!row || activeGoalExecution(row.session_id)?.run_id !== runId) return;
  const approval = db()
    .prepare(
      "SELECT 1 FROM product_approvals WHERE state='pending' AND (run_id=? OR session_id IN (SELECT h.session_id FROM personal_goal_team_steps s JOIN bot_group_handoffs h ON h.id=s.handoff_id WHERE s.run_id=?))",
    )
    .get(runId, runId);
  const devicePermission = db()
    .prepare(
      'SELECT 1 FROM cloud_device_requests WHERE run_id=? AND grant_id IS NULL AND deadline_at>? LIMIT 1',
    )
    .get(runId, Date.now());
  const device = db()
    .prepare(
      "SELECT 1 FROM device_commands WHERE goal_run_id=? AND state IN ('queued','dispatched')",
    )
    .get(runId);
  const status =
    approval || devicePermission
      ? 'waiting_for_approval'
      : device
        ? 'waiting_for_device'
        : 'running';
  const changed = db()
    .prepare(
      "UPDATE personal_goals SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('running','waiting_for_approval','waiting_for_device') AND status!=?",
    )
    .run(status, new Date().toISOString(), row.goal_id, status);
  if (changed.changes) touchGoalRuntime(row.goal_id);
}
export function setGoalApprovalWaiting(runId: string, _waiting: boolean) {
  refreshGoalWaiting(runId);
}

// Only these persisted, exact runtime bindings permit the existing Scheduler
// to reclaim a started run. Legacy Coding/script work remains at-most-once.
export const TRUSTED_GOAL_DURABLE_RUN = `EXISTS (SELECT 1 FROM goal_execution_contexts gc
  JOIN personal_goal_tasks gt ON gt.goal_id=gc.goal_id AND gt.task_id=gc.task_id AND gt.automatic=1
  JOIN product_session_runtimes pr ON pr.session_id=gc.session_id AND pr.goal_id=gc.goal_id AND pr.runtime_kind='pi-durable' AND pr.owner_user_id=gc.owner_user_id AND pr.state!='blocked'
  JOIN personal_goals pg ON pg.id=gc.goal_id AND pg.session_id=gc.session_id AND pg.owner_user_id=gc.owner_user_id
  WHERE gc.run_id=task_runs.id AND gc.task_id=task_runs.task_id)`;
export const GOAL_RUN_CLAIM_ELIGIBILITY = `NOT EXISTS (SELECT 1 FROM goal_execution_contexts gc JOIN personal_goals pg ON pg.id=gc.goal_id
  WHERE gc.run_id=task_runs.id AND pg.status NOT IN ('pending','running','waiting_for_approval','waiting_for_device'))`;

export function markAutomaticGoalTask(goalId: string, taskId: string) {
  db()
    .prepare(
      'UPDATE personal_goal_tasks SET automatic=1 WHERE goal_id=? AND task_id=?',
    )
    .run(goalId, taskId);
}
export function unstartedAutomaticGoalTasks(): {
  task_id: string;
  goal_id: string;
}[] {
  return db()
    .prepare(
      `SELECT gt.task_id,gt.goal_id FROM personal_goal_tasks gt JOIN personal_goals g ON g.id=gt.goal_id
    JOIN product_session_runtimes r ON r.session_id=g.session_id AND r.runtime_kind='pi-durable' AND r.state!='blocked'
    WHERE gt.automatic=1 AND g.status='pending' AND NOT EXISTS (SELECT 1 FROM task_runs t WHERE t.task_id=gt.task_id)`,
    )
    .all() as { task_id: string; goal_id: string }[];
}

export type GoalEvidence = {
  artifact_id: string;
  content_digest: string;
  criteria_matches: boolean[];
};
export class GoalExecutionPending extends Error {
  readonly code = 'GOAL_EXECUTION_PENDING';
}

export function settlePersonalGoalExecution(
  input: {
    runId: string;
    sessionId: string;
    leaseOwner: string;
    leaseToken: number;
    modelCompleted: boolean;
    evidence: GoalEvidence[];
  },
  commitRun: () => boolean,
  continueRun: () => void,
) {
  let teamUpdate: ReturnType<typeof projectGoalTeamOutcome>;
  const settled = db().transaction(() => {
    const current = activeGoalExecution(input.sessionId);
    if (
      !current ||
      current.run_id !== input.runId ||
      current.lease_owner !== input.leaseOwner ||
      current.lease_token !== input.leaseToken
    )
      return false;
    const goal = requireGoal(current.owner_user_id, current.goal_id);
    if (
      db()
        .prepare(
          `SELECT 1 FROM product_queue_controls WHERE session_id=? AND state='pending' LIMIT 1`,
        )
        .get(input.sessionId) ||
      db()
        .prepare(
          `SELECT 1 FROM product_session_inputs WHERE session_id=? AND state IN ('admitted','submitted') AND json_extract(payload,'$.execution.runId')=? LIMIT 1`,
        )
        .get(input.sessionId, input.runId)
    )
      throw new GoalExecutionPending(
        'Goal execution received input or control before completion',
      );
    const context = current.snapshot;
    const unchanged =
      personalGoalContentDigest(goal) === context.content_digest;
    const deterministic = context.completion_criteria.every(
      (criterion) =>
        criterion.startsWith('artifact_contains:') &&
        criterion.slice('artifact_contains:'.length).trim().length > 0,
    );
    const verified =
      input.evidence.length > 0 &&
      context.completion_criteria.every((_, index) =>
        input.evidence.some((item) => item.criteria_matches[index]),
      );
    const devicesVerified =
      !goalTeam(goal.id) || verifyCloudGoalDeviceEvidence(db(), goal.id);
    const requiredDevicesVerified = verifyGoalRequiredDevices(db(), goal.id);
    const status: GoalStatus = !input.modelCompleted
      ? 'failed'
      : !unchanged || !devicesVerified
        ? 'waiting_for_input'
        : !requiredDevicesVerified
          ? goal.budget_used_runs < goal.budget_max_runs
            ? 'pending'
            : 'waiting_for_input'
          : deterministic && verified
            ? 'completed'
            : input.evidence.length && !deterministic
              ? 'waiting_for_input'
              : goal.budget_used_runs < goal.budget_max_runs
                ? 'pending'
                : 'failed';
    if (!commitRun()) return false;
    db()
      .prepare(
        'UPDATE goal_execution_contexts SET outcome=?,evidence=?,evaluated_at=? WHERE run_id=?',
      )
      .run(
        status,
        JSON.stringify(input.evidence),
        new Date().toISOString(),
        input.runId,
      );
    db()
      .prepare(
        'UPDATE personal_goals SET status=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(status, new Date().toISOString(), goal.id);
    event(goal.id, 'execution_evaluated', {
      run_id: input.runId,
      snapshot_revision: context.goal_revision,
      status,
      evidence: input.evidence,
      reason: !input.modelCompleted
        ? 'execution_failed'
        : !unchanged
          ? 'goal_changed'
          : !devicesVerified
            ? 'device_evidence_unconfirmed'
            : !requiredDevicesVerified
              ? 'required_device_evidence_missing'
              : deterministic
                ? 'deterministic_artifact_check'
                : 'human_confirmation_required',
    });
    teamUpdate = projectGoalTeamOutcome(
      goal.owner_user_id,
      goal.id,
      input.runId,
      status,
      input.evidence,
    );
    if (status === 'pending') continueRun();
    return true;
  })();
  if (settled && teamUpdate) notifyBotGroupUpdate(teamUpdate);
  return settled;
}
export function listGoalExecutionEvidence(ownerId: string, goalId: string) {
  requireGoal(ownerId, goalId);
  return (
    db()
      .prepare(
        'SELECT run_id,snapshot,generation_steps,outcome,evidence,evaluated_at FROM goal_execution_contexts WHERE goal_id=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(goalId) as {
      run_id: string;
      snapshot: string;
      generation_steps: number;
      outcome: string | null;
      evidence: string;
      evaluated_at: string | null;
    }[]
  ).map((row) => ({
    ...row,
    snapshot: JSON.parse(row.snapshot) as PersonalGoalExecutionSnapshot,
    evidence: JSON.parse(row.evidence) as GoalEvidence[],
  }));
}
export function cancelPersonalGoalExecution(runId: string) {
  const row = db()
    .prepare('SELECT goal_id FROM goal_execution_contexts WHERE run_id=?')
    .get(runId) as { goal_id: string } | undefined;
  if (!row) return;
  db()
    .prepare(
      "UPDATE personal_goals SET status='cancelled',revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled','paused')",
    )
    .run(new Date().toISOString(), row.goal_id);
  event(row.goal_id, 'execution_cancelled', { run_id: runId });
}
export function goalRunStatus(runId: string): GoalStatus | undefined {
  return (
    db()
      .prepare(
        'SELECT g.status FROM personal_goals g JOIN goal_execution_contexts c ON c.goal_id=g.id WHERE c.run_id=?',
      )
      .get(runId) as { status: GoalStatus } | undefined
  )?.status;
}
export function failPersonalGoalRun(runId: string, commit: () => boolean) {
  return db().transaction(() => {
    if (!commit()) return false;
    const row = db()
      .prepare('SELECT goal_id FROM goal_execution_contexts WHERE run_id=?')
      .get(runId) as { goal_id: string } | undefined;
    if (row) {
      db()
        .prepare(
          "UPDATE personal_goals SET status='failed',revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','running','waiting_for_approval','waiting_for_device')",
        )
        .run(new Date().toISOString(), row.goal_id);
      event(row.goal_id, 'execution_failed', { run_id: runId });
    }
    return true;
  })();
}

export function listGoalDeviceEvidence(ownerId: string, goalId: string) {
  requireGoal(ownerId, goalId);
  return goalTeam(goalId) ? readCloudGoalDeviceEvidence(db(), goalId) : [];
}
