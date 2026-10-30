import { groupDiscussionApprovalDeadline } from '../bot-groups/discussion-store.js';
import {
  assertBotHandoffAuthority,
  botHandoffApprovalScope,
} from '../bot-groups/handoff-store.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  requireProductRuntime,
  touchProductRuntimeRevision,
} from './product-runtime-store.js';
import { activeGoalExecution, setGoalApprovalWaiting } from './goal-store.js';
import {
  bindMcpApprovalDatabase,
  createMcpApprovalSchema,
} from './mcp-approval-store.js';
import {
  bindMcpSessionDatabase,
  createMcpSessionSchema,
} from './mcp-session-schema.js';

export interface ApprovalDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}
let connection: ApprovalDatabase | null = null;
const db = () => {
  if (!connection) throw new Error('Approval storage unavailable');
  return connection;
};
export const digestText = (text: string) =>
  createHash('sha256').update(text).digest('hex');
export type ProductApproval = {
  id: string;
  session_id: string;
  owner_user_id: string;
  tool_task_id: number;
  operation: 'create_private_artifact';
  content: string;
  parameters_digest: string;
  content_digest: string;
  state:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'executing'
    | 'completed'
    | 'uncertain';
  created_at: string;
  decided_at: string | null;
  completed_at: string | null;
  goal_id: string | null;
  run_id: string | null;
  task_id: string | null;
  expires_at: string | null;
  resolution: string | null;
};
export function bindApprovalDatabase(value: ApprovalDatabase | null) {
  connection = value;
  bindMcpApprovalDatabase(value);
  bindMcpSessionDatabase(value);
}
export function createApprovalSchema(value: ApprovalDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS product_approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tool_task_id INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation='create_private_artifact'), content TEXT NOT NULL,
      parameters_digest TEXT NOT NULL, content_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','executing','completed','uncertain')),
      created_at TEXT NOT NULL, decided_at TEXT, completed_at TEXT,
      UNIQUE(session_id,tool_task_id)
    );
    CREATE TABLE IF NOT EXISTS product_approval_decisions (
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      approval_id TEXT NOT NULL REFERENCES product_approvals(id) ON DELETE CASCADE, decision_digest TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(owner_user_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS product_approval_scope_immutable BEFORE UPDATE OF
      session_id,owner_user_id,tool_task_id,operation,content,parameters_digest,content_digest ON product_approvals
      WHEN NEW.session_id!=OLD.session_id OR NEW.owner_user_id!=OLD.owner_user_id OR NEW.tool_task_id!=OLD.tool_task_id
        OR NEW.operation!=OLD.operation OR NEW.content!=OLD.content OR NEW.parameters_digest!=OLD.parameters_digest
        OR NEW.content_digest!=OLD.content_digest
      BEGIN SELECT RAISE(ABORT,'Approval intent is immutable'); END;
  `);
  const columns = new Set(
    (
      value.prepare('PRAGMA table_info(product_approvals)').all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const name of [
    'goal_id',
    'run_id',
    'task_id',
    'expires_at',
    'resolution',
  ])
    if (!columns.has(name))
      value.exec(`ALTER TABLE product_approvals ADD COLUMN ${name} TEXT`);
  value.exec(`CREATE TRIGGER IF NOT EXISTS product_approval_goal_scope_immutable BEFORE UPDATE OF goal_id,run_id,task_id,expires_at ON product_approvals
    WHEN NEW.goal_id IS NOT OLD.goal_id OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN SELECT RAISE(ABORT,'Approval Goal scope is immutable'); END;`);
  createMcpApprovalSchema(value);
  createMcpSessionSchema(value);
}
export function getProductApproval(
  id: string,
  ownerId: string,
): ProductApproval {
  const row = db()
    .prepare('SELECT * FROM product_approvals WHERE id=? AND owner_user_id=?')
    .get(id, ownerId) as ProductApproval | undefined;
  if (!row) throw new Error('Approval not found');
  const runtime = requireProductRuntime(row.session_id, ownerId);
  if (runtime.runtime_kind !== 'pi-durable' || runtime.state === 'blocked')
    throw new Error('Approval scope unavailable');
  if (
    row.expires_at &&
    Date.parse(row.expires_at) <= Date.now() &&
    ['pending', 'approved'].includes(row.state)
  ) {
    db()
      .prepare(
        "UPDATE product_approvals SET state='denied',resolution='expired' WHERE id=? AND state IN ('pending','approved')",
      )
      .run(id);
    touchProductRuntimeRevision(row.session_id);
    return { ...row, state: 'denied', resolution: 'expired' };
  }
  return row;
}
export function listProductApprovalWaits(
  sessionId: string,
): { startedAtMs: number; endedAtMs: number | null }[] {
  return (
    db()
      .prepare(
        `SELECT created_at, decided_at, state FROM product_approvals WHERE session_id=?`,
      )
      .all(sessionId) as {
      created_at: string;
      decided_at: string | null;
      state: string;
    }[]
  ).flatMap((row) => {
    const startedAtMs = Date.parse(row.created_at);
    if (!Number.isFinite(startedAtMs)) return [];
    const endedAtMs =
      row.state === 'pending'
        ? null
        : row.decided_at
          ? Date.parse(row.decided_at)
          : startedAtMs;
    return [
      {
        startedAtMs,
        endedAtMs:
          endedAtMs != null && Number.isFinite(endedAtMs)
            ? endedAtMs
            : startedAtMs,
      },
    ];
  });
}

export function countPendingProductApprovals(sessionId: string): number {
  return (
    db()
      .prepare(
        `SELECT count(*) AS n FROM product_approvals WHERE session_id=? AND state='pending'`,
      )
      .get(sessionId) as { n: number }
  ).n;
}

export function listProductApprovals(
  sessionId: string,
  ownerId: string,
): ProductApproval[] {
  requireProductRuntime(sessionId, ownerId);
  return db()
    .prepare(
      'SELECT * FROM product_approvals WHERE session_id=? AND owner_user_id=? ORDER BY created_at,id',
    )
    .all(sessionId, ownerId)
    .map((row) => getProductApproval((row as ProductApproval).id, ownerId));
}
export function requestArtifactApproval(
  sessionId: string,
  toolTaskId: number,
  content: string,
  goalScope?: { goalId: string; runId: string; taskId: string },
  executionScope?: {
    deadlineAt: number;
    generationTaskId: number;
    callId: string;
    runtimeId: string;
    parametersDigest: string;
    member?: import('../bot-groups/member-wire.js').CloudMemberEffectProof;
  },
): ProductApproval {
  const runtime = requireProductRuntime(sessionId);
  if (
    runtime.runtime_kind !== 'pi-durable' ||
    runtime.state === 'blocked' ||
    !Number.isSafeInteger(toolTaskId) ||
    toolTaskId <= 0 ||
    !content ||
    Buffer.byteLength(content) > 65536 ||
    (executionScope !== undefined &&
      (!Number.isSafeInteger(executionScope.deadlineAt) ||
        !Number.isSafeInteger(executionScope.generationTaskId) ||
        executionScope.generationTaskId <= 0))
  )
    throw new Error('Artifact approval request unavailable');
  const botScope = botHandoffApprovalScope(sessionId);
  const parameters = digestText(
    JSON.stringify({
      operation: 'create_private_artifact',
      ...(botScope ? { handoff: botScope } : {}),
      sessionId,
      toolTaskId,
      content,
      ...(goalScope ? { goal: goalScope } : {}),
      ...(executionScope !== undefined ? { executionScope } : {}),
    }),
  );
  return db().transaction(() => {
    const previous = db()
      .prepare(
        'SELECT * FROM product_approvals WHERE session_id=? AND tool_task_id=?',
      )
      .get(sessionId, toolTaskId) as ProductApproval | undefined;
    if (previous) {
      if (previous.parameters_digest !== parameters)
        throw new Error('Approval parameter conflict');
      if (goalScope && previous.state === 'pending')
        setGoalApprovalWaiting(goalScope.runId, true);
      return getProductApproval(previous.id, runtime.owner_user_id);
    }
    const id = randomUUID();
    if (executionScope !== undefined && executionScope.deadlineAt <= Date.now())
      throw new Error('Artifact approval execution grant expired');
    const usage = db()
      .prepare(
        'SELECT count(*) AS n,coalesce(sum(length(CAST(content AS BLOB))),0) AS bytes FROM product_approvals WHERE session_id=?',
      )
      .get(sessionId) as { n: number; bytes: number };
    if (usage.n >= 20 || usage.bytes + Buffer.byteLength(content) > 1048576)
      throw new Error('Session artifact approval budget exhausted');
    db()
      .prepare(
        `INSERT INTO product_approvals(id,session_id,owner_user_id,tool_task_id,operation,content,parameters_digest,content_digest,state,created_at,goal_id,run_id,task_id,expires_at)
      VALUES (?,?,?,?,'create_private_artifact',?,?,?,'pending',?,?,?,?,?)`,
      )
      .run(
        id,
        sessionId,
        runtime.owner_user_id,
        toolTaskId,
        content,
        parameters,
        digestText(content),
        new Date().toISOString(),
        goalScope?.goalId ?? null,
        goalScope?.runId ?? null,
        goalScope?.taskId ?? null,
        new Date(
          Math.min(
            Date.now() + 86400000,
            executionScope?.deadlineAt ?? Infinity,
            botScope?.deadline_at ?? Infinity,
            groupDiscussionApprovalDeadline(sessionId) ?? Infinity,
          ),
        ).toISOString(),
      );
    touchProductRuntimeRevision(sessionId);
    if (goalScope) setGoalApprovalWaiting(goalScope.runId, true);
    return getProductApproval(id, runtime.owner_user_id);
  })();
}
export function decideProductApproval(
  ownerId: string,
  id: string,
  parametersDigest: string,
  decision: 'approve' | 'deny',
  requestId: string,
) {
  if (
    !requestId ||
    Buffer.byteLength(requestId) > 128 ||
    !['approve', 'deny'].includes(decision)
  )
    throw new Error('Invalid approval decision');
  return db().transaction(() => {
    if (
      db()
        .prepare(
          'SELECT 1 FROM product_mcp_decisions WHERE owner_user_id=? AND request_id=?',
        )
        .get(ownerId, requestId)
    )
      throw new Error('Decision request conflict');
    const row = getProductApproval(id, ownerId);
    assertBotHandoffAuthority(
      row.session_id,
      row.state === 'pending' && decision === 'approve'
        ? { execute: true, tool: 'create_approved_artifact' }
        : {},
    );
    if (
      row.run_id &&
      activeGoalExecution(row.session_id)?.run_id !== row.run_id
    )
      throw new Error('Original Goal execution is no longer authorized');
    if (row.parameters_digest !== parametersDigest)
      throw new Error('Approval parameters changed');
    const digest = digestText(
      JSON.stringify({ id, parametersDigest, decision }),
    );
    const previous = db()
      .prepare(
        'SELECT approval_id,decision_digest FROM product_approval_decisions WHERE owner_user_id=? AND request_id=?',
      )
      .get(ownerId, requestId) as
      | { approval_id: string; decision_digest: string }
      | undefined;
    if (
      previous &&
      (previous.approval_id !== id || previous.decision_digest !== digest)
    )
      throw new Error('Decision request conflict');
    const accepted = decision === 'approve' ? 'approved' : 'denied';
    if (
      row.state !== 'pending' &&
      !(
        decision === 'approve' &&
        ['approved', 'executing', 'completed'].includes(row.state)
      ) &&
      row.state !== accepted
    )
      throw new Error('Approval already resolved differently');
    const now = new Date().toISOString();
    db()
      .prepare(
        'INSERT OR IGNORE INTO product_approval_decisions(owner_user_id,request_id,approval_id,decision_digest,created_at) VALUES (?,?,?,?,?)',
      )
      .run(ownerId, requestId, id, digest, now);
    db()
      .prepare(
        "UPDATE product_approvals SET state=?,decided_at=?,resolution=? WHERE id=? AND state='pending'",
      )
      .run(accepted, now, decision === 'approve' ? 'approved' : 'rejected', id);
    touchProductRuntimeRevision(row.session_id);
    if (row.run_id) setGoalApprovalWaiting(row.run_id, false);
    return getProductApproval(id, ownerId);
  })();
}
export function beginApprovedArtifact(
  id: string,
  ownerId: string,
): ProductApproval {
  const row = getProductApproval(id, ownerId);
  if (row.run_id && activeGoalExecution(row.session_id)?.run_id !== row.run_id)
    throw new Error('Original Goal execution is no longer authorized');
  if (!['approved', 'executing', 'completed'].includes(row.state))
    throw new Error('Artifact is not approved');
  db()
    .prepare(
      "UPDATE product_approvals SET state='executing' WHERE id=? AND state='approved'",
    )
    .run(id);
  if (row.state === 'approved') touchProductRuntimeRevision(row.session_id);
  return getProductApproval(id, ownerId);
}

export function revokeGoalApprovals(runId: string) {
  const sessions = db()
    .prepare('SELECT DISTINCT session_id FROM product_approvals WHERE run_id=?')
    .all(runId) as { session_id: string }[];
  db()
    .prepare(
      "UPDATE product_approvals SET state=CASE WHEN state='executing' THEN 'uncertain' ELSE 'denied' END,resolution='revoked' WHERE run_id=? AND state IN ('pending','approved','executing')",
    )
    .run(runId);
  for (const row of sessions) touchProductRuntimeRevision(row.session_id);
}
export function finishApprovedArtifact(
  id: string,
  ownerId: string,
  verified: boolean,
) {
  const row = getProductApproval(id, ownerId);
  db()
    .prepare(
      "UPDATE product_approvals SET state=?,completed_at=CASE WHEN ? IS NULL THEN NULL ELSE coalesce(completed_at,?) END WHERE id=? AND state IN ('executing','completed')",
    )
    .run(
      verified ? 'completed' : 'uncertain',
      verified ? new Date().toISOString() : null,
      verified ? new Date().toISOString() : null,
      id,
    );
  if (row.state !== (verified ? 'completed' : 'uncertain'))
    touchProductRuntimeRevision(row.session_id);
  return getProductApproval(id, ownerId);
}
