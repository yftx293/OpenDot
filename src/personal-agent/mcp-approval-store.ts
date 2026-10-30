import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@earendil-works/pi-mcp';
import type { ApprovalDatabase } from './approval-store.js';
import {
  requireProductRuntime,
  getProductRuntime,
} from './product-runtime-store.js';
import {
  McpCallIntentSchema,
  mcpCanonicalJson,
  mcpDigest,
  type McpCallIntent,
} from '../mcp-contract.js';
import type { McpDispatchConnection } from '../mcp-client.js';
import { McpDeliveryError } from '../mcp-errors.js';
import { getHostObservability } from './host-observability.js';
import { computerApprovalTier } from './computer-approval-policy.js';

function observeMcpReceipt(
  approval: McpApproval,
  phase: 'decision' | 'execution',
) {
  try {
    getHostObservability()?.mcpReceipt(approval, phase);
  } catch {
    /* Observability never decides the business result. */
  }
}

let connection: ApprovalDatabase | null = null;
const db = () => {
  if (!connection) throw new Error('MCP approval storage unavailable');
  return connection;
};
export function bindMcpApprovalDatabase(value: ApprovalDatabase | null) {
  connection = value;
}

export function createMcpApprovalSchema(value: ApprovalDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS product_mcp_calls (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation='mcp.call'),
      source_runtime TEXT NOT NULL CHECK(source_runtime IN ('pi-durable','pi-coding-agent')),
      source_key TEXT NOT NULL, intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
      parameters_digest TEXT NOT NULL CHECK(length(parameters_digest)=64),
      arguments_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','dispatching','completed','uncertain','cancelled')),
      decided_at INTEGER, dispatched_at INTEGER, dispatch_owner TEXT, settled_at INTEGER,
      result_ciphertext TEXT, result_digest TEXT, result_received_at INTEGER, resolution TEXT,
      UNIQUE(session_id,source_runtime,source_key),
      CHECK(json_extract(intent_json,'$.operation') IS 'mcp.call'),
      CHECK(json_extract(intent_json,'$.call_id') IS id),
      CHECK(json_extract(intent_json,'$.owner_id') IS owner_user_id),
      CHECK(json_extract(intent_json,'$.session_id') IS session_id),
      CHECK(json_extract(intent_json,'$.source.runtime') IS source_runtime),
      CHECK(json_extract(intent_json,'$.expires_at') IS expires_at),
      CHECK(state NOT IN ('dispatching','completed') OR (dispatched_at IS NOT NULL AND dispatch_owner IS NOT NULL)),
      CHECK((result_ciphertext IS NULL)=(result_digest IS NULL)),
      CHECK((result_ciphertext IS NULL)=(result_received_at IS NULL)),
      CHECK(state!='completed' OR (result_ciphertext IS NOT NULL AND settled_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS product_mcp_session_state ON product_mcp_calls(session_id,state);
    CREATE TABLE IF NOT EXISTS product_mcp_session_controls (
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      control_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,control_id)
    );
    CREATE TABLE IF NOT EXISTS product_mcp_cancel_generations (
      session_id TEXT PRIMARY KEY REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK(generation>=0)
    );
    CREATE TABLE IF NOT EXISTS product_mcp_task_controls (
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      control_id TEXT NOT NULL, task_id INTEGER NOT NULL CHECK(task_id>0), created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,control_id)
    );
    CREATE TABLE IF NOT EXISTS product_mcp_decisions (
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES product_mcp_calls(id) ON DELETE CASCADE,
      decision_digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_user_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS product_mcp_intent_immutable BEFORE UPDATE OF
      id,session_id,owner_user_id,operation,source_runtime,source_key,intent_json,parameters_digest,arguments_ciphertext,created_at,expires_at ON product_mcp_calls
      WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.owner_user_id IS NOT OLD.owner_user_id
        OR NEW.operation IS NOT OLD.operation OR NEW.source_runtime IS NOT OLD.source_runtime OR NEW.source_key IS NOT OLD.source_key
        OR NEW.intent_json IS NOT OLD.intent_json OR NEW.parameters_digest IS NOT OLD.parameters_digest
        OR NEW.arguments_ciphertext IS NOT OLD.arguments_ciphertext OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN SELECT RAISE(ABORT,'MCP approval intent is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_mcp_dispatch_immutable BEFORE UPDATE OF dispatched_at,dispatch_owner ON product_mcp_calls
      WHEN OLD.dispatched_at IS NOT NULL AND (NEW.dispatched_at IS NOT OLD.dispatched_at OR NEW.dispatch_owner IS NOT OLD.dispatch_owner)
      BEGIN SELECT RAISE(ABORT,'MCP dispatch identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_mcp_result_immutable BEFORE UPDATE OF result_ciphertext,result_digest,result_received_at ON product_mcp_calls
      WHEN OLD.result_ciphertext IS NOT NULL AND (NEW.result_ciphertext IS NOT OLD.result_ciphertext OR NEW.result_digest IS NOT OLD.result_digest OR NEW.result_received_at IS NOT OLD.result_received_at)
      BEGIN SELECT RAISE(ABORT,'MCP result receipt is immutable'); END;
    CREATE TABLE IF NOT EXISTS computer_task_allowances (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      app_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS computer_task_allowances_session ON computer_task_allowances(session_id, owner_user_id, expires_at);
    CREATE TRIGGER IF NOT EXISTS product_mcp_state_transition BEFORE UPDATE OF state ON product_mcp_calls
      WHEN NEW.state!=OLD.state AND NOT (
        (OLD.state='pending' AND NEW.state IN ('approved','denied','cancelled')) OR
        (OLD.state='approved' AND NEW.state IN ('dispatching','denied','cancelled')) OR
        (OLD.state='dispatching' AND NEW.state IN ('completed','uncertain')))
      BEGIN SELECT RAISE(ABORT,'MCP call transition unavailable'); END;
  `);
}

type CallRow = {
  id: string;
  session_id: string;
  owner_user_id: string;
  operation: 'mcp.call';
  source_runtime: McpCallIntent['source']['runtime'];
  source_key: string;
  intent_json: string;
  parameters_digest: string;
  arguments_ciphertext: string;
  created_at: number;
  expires_at: number;
  state:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'dispatching'
    | 'completed'
    | 'uncertain'
    | 'cancelled';
  decided_at: number | null;
  dispatched_at: number | null;
  dispatch_owner: string | null;
  settled_at: number | null;
  result_ciphertext: string | null;
  result_digest: string | null;
  result_received_at: number | null;
  resolution: string | null;
};
export type McpApproval = Omit<
  CallRow,
  'arguments_ciphertext' | 'result_ciphertext' | 'intent_json'
> & { intent: McpCallIntent };
/** Only an owned Runtime/IPC adapter supplies these callbacks, never request JSON. */
export type McpCallAuthority = {
  verifySource(intent: McpCallIntent): Promise<void>;
  recheck(intent: McpCallIntent): void;
};
const scope = (
  intent: McpCallIntent,
  purpose: 'mcp.call.arguments' | 'mcp.call.result',
) => ({ ownerId: intent.owner_id, recordId: intent.call_id, purpose });
function sourceKey(intent: McpCallIntent) {
  const source = intent.source;
  return source.runtime === 'pi-durable'
    ? `task:${source.tool_task_id}`
    : mcpDigest({ turn: source.business_turn_id, call: source.tool_call_id });
}
function assertRuntime(intent: McpCallIntent) {
  const runtime = requireProductRuntime(intent.session_id, intent.owner_id);
  if (
    runtime.state === 'blocked' ||
    runtime.workspace_jid !== intent.workspace_jid ||
    runtime.runtime_kind !== intent.source.runtime ||
    (intent.source.runtime === 'pi-durable' &&
      runtime.conversation_id !== intent.source.conversation_id)
  )
    throw new Error('MCP runtime scope unavailable');
  return runtime;
}
export function mcpCancelGeneration(
  sessionId: string,
  ownerId: string,
): number {
  requireProductRuntime(sessionId, ownerId);
  return (
    (
      db()
        .prepare(
          'SELECT generation FROM product_mcp_cancel_generations WHERE session_id=?',
        )
        .get(sessionId) as { generation: number } | undefined
    )?.generation ?? 0
  );
}
function assertCurrentMcpControl(intent: McpCallIntent) {
  if (
    mcpCancelGeneration(intent.session_id, intent.owner_id) !==
    intent.cancel_generation
  )
    throw new Error('MCP session execution cancelled');
  if (
    intent.source.runtime === 'pi-durable' &&
    db()
      .prepare(
        'SELECT 1 FROM product_mcp_task_controls WHERE session_id=? AND task_id IN (SELECT value FROM json_each(?))',
      )
      .get(intent.session_id, JSON.stringify(intent.source.ancestor_task_ids))
  )
    throw new Error('MCP native task cancelled');
}
function rowFor(id: string, ownerId: string): CallRow {
  const row = db()
    .prepare('SELECT * FROM product_mcp_calls WHERE id=? AND owner_user_id=?')
    .get(id, ownerId) as CallRow | undefined;
  if (!row) throw new Error('MCP approval not found');
  const intent = McpCallIntentSchema.parse(JSON.parse(row.intent_json));
  if (mcpDigest(intent) !== row.parameters_digest)
    throw new Error('MCP approval digest unavailable');
  assertRuntime(intent);
  return row;
}
const publicRow = (row: CallRow): McpApproval => {
  const {
    arguments_ciphertext: _args,
    result_ciphertext: _result,
    intent_json,
    ...rest
  } = row;
  return {
    ...rest,
    intent: McpCallIntentSchema.parse(JSON.parse(intent_json)),
  };
};

export function getMcpApproval(id: string, ownerId: string): McpApproval {
  let row = rowFor(id, ownerId);
  if (
    row.expires_at <= Date.now() &&
    ['pending', 'approved'].includes(row.state)
  ) {
    db()
      .prepare(
        "UPDATE product_mcp_calls SET state='denied',resolution='expired',decided_at=? WHERE id=? AND state IN ('pending','approved')",
      )
      .run(Date.now(), id);
    row = rowFor(id, ownerId);
  }
  return publicRow(row);
}
export function listMcpApprovalWaits(
  sessionId: string,
): { startedAtMs: number; endedAtMs: number | null }[] {
  return (
    db()
      .prepare(
        `SELECT created_at, decided_at, settled_at, state FROM product_mcp_calls WHERE session_id=?`,
      )
      .all(sessionId) as {
      created_at: number;
      decided_at: number | null;
      settled_at: number | null;
      state: string;
    }[]
  ).map((row) => ({
    startedAtMs: row.created_at,
    endedAtMs:
      row.state === 'pending'
        ? null
        : (row.decided_at ?? row.settled_at ?? row.created_at),
  }));
}

export function countPendingMcpApprovals(sessionId: string): number {
  return (
    db()
      .prepare(
        `SELECT count(*) AS n FROM product_mcp_calls WHERE session_id=? AND state='pending'`,
      )
      .get(sessionId) as { n: number }
  ).n;
}

export type ComputerTaskAllowance = {
  serverId: string;
  appKey: string;
  expiresAt: number;
};

export function listComputerAllowances(
  sessionId: string,
  ownerId: string,
  now = Date.now(),
): ComputerTaskAllowance[] {
  return (
    db()
      .prepare(
        `SELECT server_id, app_key, expires_at FROM computer_task_allowances
         WHERE session_id=? AND owner_user_id=? AND expires_at>?`,
      )
      .all(sessionId, ownerId, now) as {
      server_id: string;
      app_key: string;
      expires_at: number;
    }[]
  ).map((row) => ({
    serverId: row.server_id,
    appKey: row.app_key,
    expiresAt: row.expires_at,
  }));
}

export function grantComputerAllowance(input: {
  sessionId: string;
  ownerId: string;
  serverId: string;
  appKey: string;
  expiresAt: number;
}): void {
  if (!input.serverId.startsWith('opendot_computer_')) return;
  if (input.expiresAt <= Date.now()) return;
  db()
    .prepare(
      `INSERT INTO computer_task_allowances(id,session_id,owner_user_id,server_id,app_key,expires_at,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      input.sessionId,
      input.ownerId,
      input.serverId,
      input.appKey,
      input.expiresAt,
      Date.now(),
    );
}

export function listMcpApprovals(
  sessionId: string,
  ownerId: string,
): McpApproval[] {
  requireProductRuntime(sessionId, ownerId);
  return (
    db()
      .prepare(
        'SELECT id FROM product_mcp_calls WHERE session_id=? AND owner_user_id=? ORDER BY created_at,id',
      )
      .all(sessionId, ownerId) as { id: string }[]
  ).map((row) => getMcpApproval(row.id, ownerId));
}
export async function requestMcpApproval(
  untrustedIntent: McpCallIntent,
  args: Record<string, unknown>,
  authority: McpCallAuthority,
): Promise<McpApproval> {
  const intent = McpCallIntentSchema.parse(untrustedIntent);
  const argumentsJson = mcpCanonicalJson(args);
  const frozenArgs = JSON.parse(argumentsJson) as Record<string, unknown>;
  if (mcpDigest(frozenArgs) !== intent.arguments_digest)
    throw new Error('MCP argument conflict');
  await authority.verifySource(intent);
  const { sealHostPrivateJson } = await import('../runtime-config.js');
  const intentJson = mcpCanonicalJson(intent),
    parametersDigest = mcpDigest(intent),
    key = sourceKey(intent);
  return db().transaction(() => {
    assertRuntime(intent);
    assertCurrentMcpControl(intent);
    authority.recheck(intent);
    const old = db()
      .prepare(
        'SELECT * FROM product_mcp_calls WHERE session_id=? AND source_runtime=? AND source_key=?',
      )
      .get(intent.session_id, intent.source.runtime, key) as
      | CallRow
      | undefined;
    if (old) {
      if (
        old.id !== intent.call_id ||
        old.parameters_digest !== parametersDigest
      )
        throw new Error('MCP native call intent conflict');
      return getMcpApproval(old.id, intent.owner_id);
    }
    const now = Date.now();
    if (intent.expires_at <= now || intent.expires_at > now + 86400000)
      throw new Error('MCP approval deadline unavailable');
    const autoRead =
      computerApprovalTier(intent.original_name) === 'read' &&
      intent.server_id.startsWith('opendot_computer_') &&
      process.env.OPENDOT_COMPUTER_REQUIRE_READ_APPROVAL !== 'true';
    const usage = db()
      .prepare(
        `SELECT count(*) AS n,coalesce(sum(length(arguments_ciphertext)),0) AS bytes
         FROM product_mcp_calls WHERE session_id=?
         AND (?=0 OR NOT (
           json_extract(intent_json,'$.server_id') LIKE 'opendot_computer_%'
           AND json_extract(intent_json,'$.original_name') IN ('list_windows','observe_window','read_page')
         ))`,
      )
      .get(intent.session_id, autoRead ? 1 : 0) as { n: number; bytes: number };
    const incoming = Buffer.byteLength(argumentsJson) * 2;
    if (
      incoming > 2097152 ||
      (!autoRead && (usage.n >= 100 || usage.bytes + incoming > 2097152))
    )
      throw new Error('MCP session approval budget exhausted');
    db()
      .prepare(
        `INSERT INTO product_mcp_calls(id,session_id,owner_user_id,operation,source_runtime,source_key,intent_json,parameters_digest,arguments_ciphertext,created_at,expires_at,state)
      VALUES (?,?,?,'mcp.call',?,?,?,?,?,?,?,'pending')`,
      )
      .run(
        intent.call_id,
        intent.session_id,
        intent.owner_id,
        intent.source.runtime,
        key,
        intentJson,
        parametersDigest,
        sealHostPrivateJson(scope(intent, 'mcp.call.arguments'), frozenArgs),
        now,
        intent.expires_at,
      );
    return getMcpApproval(intent.call_id, intent.owner_id);
  })();
}

export async function decideMcpApproval(
  input: {
    ownerId: string;
    id: string;
    parametersDigest: string;
    decision: 'approve' | 'deny';
    requestId: string;
  },
  authority: McpCallAuthority,
): Promise<McpApproval> {
  z.uuid().parse(input.requestId);
  if (!['approve', 'deny'].includes(input.decision))
    throw new Error('MCP decision unavailable');
  const initial = getMcpApproval(input.id, input.ownerId);
  if (initial.parameters_digest !== input.parametersDigest)
    throw new Error('MCP approval parameters changed');
  const digest = mcpDigest({
    id: input.id,
    parametersDigest: input.parametersDigest,
    decision: input.decision,
  });
  const previous = () =>
    db()
      .prepare(
        'SELECT call_id,decision_digest FROM product_mcp_decisions WHERE owner_user_id=? AND request_id=?',
      )
      .get(input.ownerId, input.requestId) as
      | { call_id: string; decision_digest: string }
      | undefined;
  const checkPrevious = () => {
    const old = previous();
    if (old && (old.call_id !== input.id || old.decision_digest !== digest))
      throw new Error('MCP decision request conflict');
    if (
      db()
        .prepare(
          'SELECT 1 FROM product_approval_decisions WHERE owner_user_id=? AND request_id=?',
        )
        .get(input.ownerId, input.requestId)
    )
      throw new Error('MCP decision request conflict');
    return old;
  };
  if (checkPrevious()) return initial;
  if (input.decision === 'approve')
    await authority.verifySource(initial.intent);
  let changed = false;
  const decision = db().transaction(() => {
    const current = getMcpApproval(input.id, input.ownerId);
    if (checkPrevious()) return current;
    if (input.decision === 'approve') {
      assertCurrentMcpControl(current.intent);
      authority.recheck(current.intent);
    }
    const target = input.decision === 'approve' ? 'approved' : 'denied';
    if (current.state !== 'pending' && current.state !== target)
      throw new Error('MCP approval already resolved');
    db()
      .prepare(
        'INSERT INTO product_mcp_decisions(owner_user_id,request_id,call_id,decision_digest,created_at) VALUES(?,?,?,?,?)',
      )
      .run(input.ownerId, input.requestId, input.id, digest, Date.now());
    changed =
      db()
        .prepare(
          "UPDATE product_mcp_calls SET state=?,decided_at=?,resolution=? WHERE id=? AND state='pending'",
        )
        .run(target, Date.now(), target, input.id).changes === 1;
    return getMcpApproval(input.id, input.ownerId);
  })();
  if (changed) observeMcpReceipt(decision, 'decision');
  return decision;
}

export async function readMcpApprovalArguments(
  id: string,
  ownerId: string,
): Promise<Record<string, unknown>> {
  const { openHostPrivateJson } = await import('../runtime-config.js');
  const row = rowFor(id, ownerId),
    intent = JSON.parse(row.intent_json) as McpCallIntent;
  const args = openHostPrivateJson(
    scope(intent, 'mcp.call.arguments'),
    row.arguments_ciphertext,
  );
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    mcpDigest(args) !== intent.arguments_digest
  )
    throw new Error('MCP argument receipt unavailable');
  return args as Record<string, unknown>;
}

/** Must be called only after the Runtime has acquired its exclusive owner lease. */
export function recoverMcpDispatches(
  sessionId: string,
  ownerId: string,
  executionOwner: string,
  authorizeOwnedRecovery: () => void,
): number {
  z.uuid().parse(executionOwner);
  requireProductRuntime(sessionId, ownerId);
  authorizeOwnedRecovery();
  const recovered = db()
    .prepare(
      "UPDATE product_mcp_calls SET state='uncertain',resolution='dispatch-recovery',settled_at=? WHERE session_id=? AND owner_user_id=? AND state='dispatching' AND dispatch_owner!=? RETURNING id",
    )
    .all(Date.now(), sessionId, ownerId, executionOwner) as { id: string }[];
  for (const item of recovered) {
    try {
      observeMcpReceipt(getMcpApproval(item.id, ownerId), 'execution');
    } catch {
      /* Recovery remains authoritative if observation fails. */
    }
  }
  return recovered.length;
}
export function cancelMcpApprovals(
  sessionId: string,
  ownerId: string,
  controlId: string = randomUUID(),
): number {
  // Cleanup reduces authority and must remain possible after owner revocation.
  // Public actors are checked by the caller; this binds the immutable owner.
  if (getProductRuntime(sessionId)?.owner_user_id !== ownerId)
    throw new Error('MCP cancellation scope unavailable');
  z.string().min(1).max(256).parse(controlId);
  return db().transaction(() => {
    const inserted = db()
      .prepare(
        'INSERT OR IGNORE INTO product_mcp_session_controls(session_id,control_id,created_at) VALUES(?,?,?)',
      )
      .run(sessionId, controlId, Date.now()).changes;
    if (!inserted) return 0;
    if (inserted)
      db()
        .prepare(
          'INSERT INTO product_mcp_cancel_generations(session_id,generation) VALUES(?,1) ON CONFLICT(session_id) DO UPDATE SET generation=generation+1',
        )
        .run(sessionId);
    return db()
      .prepare(
        `UPDATE product_mcp_calls SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
    resolution='cancelled',settled_at=? WHERE session_id=? AND owner_user_id=? AND state IN ('pending','approved','dispatching')`,
      )
      .run(Date.now(), sessionId, ownerId).changes;
  })();
}
export function cancelMcpApprovalsForTask(
  sessionId: string,
  ownerId: string,
  taskId: number,
  controlId: string,
): number {
  if (getProductRuntime(sessionId)?.owner_user_id !== ownerId)
    throw new Error('MCP cancellation scope unavailable');
  z.string().min(1).max(256).parse(controlId);
  z.number().int().positive().parse(taskId);
  return db().transaction(() => {
    const previous = db()
      .prepare(
        'SELECT task_id FROM product_mcp_task_controls WHERE session_id=? AND control_id=?',
      )
      .get(sessionId, controlId) as { task_id: number } | undefined;
    if (previous && previous.task_id !== taskId)
      throw new Error('MCP task control conflict');
    if (previous) return 0;
    db()
      .prepare(
        'INSERT OR IGNORE INTO product_mcp_task_controls(session_id,control_id,task_id,created_at) VALUES(?,?,?,?)',
      )
      .run(sessionId, controlId, taskId, Date.now());
    return db()
      .prepare(
        `UPDATE product_mcp_calls SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,resolution='task-cancelled',settled_at=?
      WHERE session_id=? AND owner_user_id=? AND source_runtime='pi-durable' AND state IN ('pending','approved','dispatching')
      AND EXISTS(SELECT 1 FROM json_each(product_mcp_calls.intent_json,'$.source.ancestor_task_ids') WHERE value=?)`,
      )
      .run(Date.now(), sessionId, ownerId, taskId).changes;
  })();
}

/** Revoking one explicit Session grant must not cancel unrelated servers. */
export function cancelMcpApprovalsForGrant(
  sessionId: string,
  ownerId: string,
  grantId: string,
): number {
  if (getProductRuntime(sessionId)?.owner_user_id !== ownerId)
    throw new Error('MCP cancellation scope unavailable');
  z.uuid().parse(grantId);
  return db()
    .prepare(
      `UPDATE product_mcp_calls
    SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
      resolution='grant-revoked',settled_at=?
    WHERE session_id=? AND owner_user_id=? AND json_extract(intent_json,'$.grant_id')=?
      AND state IN ('pending','approved','dispatching')`,
    )
    .run(Date.now(), sessionId, ownerId, grantId).changes;
}

/** A Coding Runner can cancel only its own approved call; a dispatched call
 * remains uncertain because cancellation cannot undo an external effect. */
export function cancelCodingMcpCall(
  id: string,
  ownerId: string,
  sessionId: string,
) {
  const current = getMcpApproval(id, ownerId);
  if (
    current.session_id !== sessionId ||
    current.intent.source.runtime !== 'pi-coding-agent'
  )
    throw new Error('MCP coding call scope unavailable');
  db()
    .prepare(
      `UPDATE product_mcp_calls SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
    resolution='runner-cancelled',settled_at=? WHERE id=? AND owner_user_id=? AND session_id=? AND state IN ('pending','approved','dispatching')`,
    )
    .run(Date.now(), id, ownerId, sessionId);
}

/** Called only inside the transaction that takes an exclusive Coding lease.
 * Does not advance the Session cancellation generation: a freshly issued
 * startup consent must remain valid during this ownership transition. */
export function retirePreviousCodingMcpCalls(
  sessionId: string,
  ownerId: string,
) {
  requireProductRuntime(sessionId, ownerId);
  return db()
    .prepare(
      `UPDATE product_mcp_calls
    SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
        resolution='coding-owner-recovery',settled_at=?
    WHERE session_id=? AND owner_user_id=? AND source_runtime='pi-coding-agent'
      AND state IN ('pending','approved','dispatching')`,
    )
    .run(Date.now(), sessionId, ownerId).changes;
}

export async function executeMcpApproval(input: {
  id: string;
  ownerId: string;
  executionOwner: string;
  signal: AbortSignal;
  connection: McpDispatchConnection;
  authority: McpCallAuthority;
}): Promise<CallToolResult> {
  z.uuid().parse(input.executionOwner);
  const initial = getMcpApproval(input.id, input.ownerId);
  await input.authority.verifySource(initial.intent);
  input.authority.recheck(initial.intent);
  assertCurrentMcpControl(initial.intent);
  if (input.signal.aborted) throw new McpDeliveryError('not_sent');
  const { openHostPrivateJson, sealHostPrivateJson } =
    await import('../runtime-config.js');
  if (initial.state === 'completed') {
    const row = rowFor(input.id, input.ownerId);
    const value = openHostPrivateJson(
      scope(initial.intent, 'mcp.call.result'),
      row.result_ciphertext!,
    );
    if (mcpDigest(value) !== row.result_digest)
      throw new Error('MCP result receipt unavailable');
    input.authority.recheck(initial.intent);
    assertCurrentMcpControl(initial.intent);
    if (input.signal.aborted) throw new Error('MCP result access cancelled');
    return value as CallToolResult;
  }
  if (initial.state !== 'approved')
    throw new McpDeliveryError(
      initial.state === 'uncertain' || initial.state === 'dispatching'
        ? 'uncertain'
        : 'not_sent',
    );
  const args = await readMcpApprovalArguments(input.id, input.ownerId);
  const recheck = () => {
    assertRuntime(initial.intent);
    assertCurrentMcpControl(initial.intent);
    input.authority.recheck(initial.intent);
  };
  let ownsDispatch = false;
  try {
    const result = await input.connection.dispatch({
      intent: initial.intent,
      arguments: args,
      signal: input.signal,
      recheck,
      markDispatched: () => {
        recheck();
        const now = Date.now();
        if (
          input.signal.aborted ||
          db()
            .prepare(
              "UPDATE product_mcp_calls SET state='dispatching',dispatched_at=?,dispatch_owner=? WHERE id=? AND owner_user_id=? AND state='approved' AND parameters_digest=? AND expires_at>?",
            )
            .run(
              now,
              input.executionOwner,
              input.id,
              input.ownerId,
              initial.parameters_digest,
              now,
            ).changes !== 1
        )
          throw new McpDeliveryError('not_sent');
        ownsDispatch = true;
      },
    });
    const sealed = sealHostPrivateJson(
      scope(initial.intent, 'mcp.call.result'),
      result,
    );
    const changed = db()
      .prepare(
        "UPDATE product_mcp_calls SET state='completed',result_ciphertext=?,result_digest=?,settled_at=?,result_received_at=?,resolution='result-received' WHERE id=? AND state='dispatching' AND dispatch_owner=?",
      )
      .run(
        sealed,
        mcpDigest(result),
        Date.now(),
        Date.now(),
        input.id,
        input.executionOwner,
      ).changes;
    if (changed !== 1) throw new McpDeliveryError('uncertain', { result });
    input.authority.recheck(initial.intent);
    assertCurrentMcpControl(initial.intent);
    if (input.signal.aborted) throw new Error('MCP result access cancelled');
    return result;
  } catch (error) {
    if (!ownsDispatch) throw error;
    const result = error instanceof McpDeliveryError ? error.result : undefined;
    db()
      .prepare(
        "UPDATE product_mcp_calls SET state='uncertain',settled_at=?,resolution='dispatch-outcome-uncertain',result_ciphertext=?,result_digest=?,result_received_at=? WHERE id=? AND state='dispatching' AND dispatch_owner=? AND result_ciphertext IS NULL",
      )
      .run(
        Date.now(),
        result
          ? sealHostPrivateJson(
              scope(initial.intent, 'mcp.call.result'),
              result,
            )
          : null,
        result ? mcpDigest(result) : null,
        result ? Date.now() : null,
        input.id,
        input.executionOwner,
      );
    if (result)
      db()
        .prepare(
          `UPDATE product_mcp_calls SET result_ciphertext=?,result_digest=?,result_received_at=?
        WHERE id=? AND state='uncertain' AND dispatch_owner=? AND result_ciphertext IS NULL`,
        )
        .run(
          sealHostPrivateJson(scope(initial.intent, 'mcp.call.result'), result),
          mcpDigest(result),
          Date.now(),
          input.id,
          input.executionOwner,
        );
    throw error;
  } finally {
    if (ownsDispatch) {
      try {
        observeMcpReceipt(getMcpApproval(input.id, input.ownerId), 'execution');
      } catch {
        /* Receipt unavailable; never invent an outcome. */
      }
    }
  }
}
