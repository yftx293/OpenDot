import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BotGroupError, type GroupDatabase } from './protocol.js';
import {
  assertMemberAuthority,
  assertMemberSubmission,
  memberInputForRequest,
  chargeMemberGeneration,
  type MemberModelFrame,
} from './member-inbox-store.js';
import type {
  ModelRequestInfo,
  ModelRequestAdmission,
  ModelRequestResult,
} from '../personal-agent/metered-model-api.js';

let connection: GroupDatabase | null = null;
export function bindMemberModelDatabase(value: GroupDatabase | null) {
  connection = value;
}
const db = () => {
  if (!connection) throw new Error('Member model accounting unavailable');
  return connection;
};
const fail = (code: string) => new BotGroupError(code);
export const memberConcurrencyEnabled = () =>
  process.env.MINICLAW_GROUP_MEMBER_CONCURRENCY === 'true';
export type MemberModelLimits = {
  run_id: string;
  version: 1;
  group_active: number;
  owner_active: number;
  member_active: number;
  owner_waiting: number;
  run_tokens: number;
  owner_tokens_24h: number;
  owner_attempts_24h: number;
  request_tokens: number;
  wait_ms: number;
};
export function memberModelLimits(
  runId: string,
): MemberModelLimits | undefined {
  return connection
    ? (db()
        .prepare(
          'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
        )
        .get(runId) as MemberModelLimits | undefined)
    : undefined;
}
export function freezeMemberModelLimits(runId: string) {
  if (!memberConcurrencyEnabled()) return;
  db()
    .prepare(
      'INSERT INTO bot_group_member_execution_policies VALUES(?,1,2,4,1,32,2000000,8000000,256,262144,90000) ON CONFLICT(run_id) DO NOTHING',
    )
    .run(runId);
  if (process.env.MINICLAW_GROUP_MEMBER_CLOUD === 'true')
    db()
      .prepare(
        'INSERT INTO bot_group_member_cloud_runs VALUES(?,1) ON CONFLICT(run_id) DO NOTHING',
      )
      .run(runId);
}
export function memberCloudRunEnabled(runId: string) {
  return (
    !!connection &&
    !!db()
      .prepare('SELECT 1 FROM bot_group_member_cloud_runs WHERE run_id=?')
      .get(runId)
  );
}
type Ticket = {
  ordinal: number;
  id: string;
  run_id: string;
  lease_id: string;
  session_id: string;
  group_id: string;
  owner_user_id: string;
  instance_id: string;
  native_task_id: number;
  native_attempt: number;
  context_digest: string;
  source_inputs: string;
  reserved_tokens: number;
  created_at: number;
  deadline_at: number;
  request_id: string | null;
  dispatched_at: number | null;
  state:
    | 'waiting'
    | 'active'
    | 'released'
    | 'cancelled'
    | 'uncertain'
    | 'rejected';
};
const ticket = (id: string) =>
  db()
    .prepare('SELECT * FROM bot_group_member_model_admissions WHERE id=?')
    .get(id) as Ticket;
const count = (sql: string, ...args: (string | number)[]) =>
  (
    db()
      .prepare(sql)
      .get(...args) as { n: number }
  ).n;
function validateSource(sessionId: string, frame: MemberModelFrame) {
  const c = assertMemberAuthority(sessionId);
  if (
    c.lease.id !== frame.lease_id ||
    c.run.id !== frame.run_id ||
    c.lease.cancel_epoch !== frame.cancel_epoch
  )
    throw fail('GROUP_MEMBER_EXECUTION_FENCED');
  for (const input of frame.inputs) {
    const row = memberInputForRequest(sessionId, input.requestId);
    if (!row || row.run_id !== frame.run_id)
      throw fail('GROUP_MEMBER_SOURCE_MISMATCH');
    assertMemberSubmission(sessionId, row.request_id, JSON.parse(row.payload));
  }
  if (!frame.inputs.length) throw fail('GROUP_MEMBER_SOURCE_MISMATCH');
  return c;
}
function verifyBudget(row: Ticket, limits: MemberModelLimits) {
  const cutoff = Date.now() - 86400000;
  // Index the recent history and older active reservations separately. TOTAL
  // avoids integer overflow for an invalid but persisted excessive report.
  const owner = db()
    .prepare(
      `SELECT TOTAL(CASE WHEN state='active' THEN reserved_tokens ELSE accounted_tokens END) tokens,
              SUM(CASE WHEN dispatched_at>=? THEN 1 ELSE 0 END) attempts
       FROM (
         SELECT state,reserved_tokens,accounted_tokens,dispatched_at
         FROM bot_group_member_model_admissions
         WHERE owner_user_id=? AND id<>? AND dispatched_at>=?
         UNION ALL
         SELECT state,reserved_tokens,accounted_tokens,dispatched_at
         FROM bot_group_member_model_admissions
         WHERE owner_user_id=? AND id<>? AND state='active'
           AND (dispatched_at IS NULL OR dispatched_at<?)
       )`,
    )
    .get(
      cutoff,
      row.owner_user_id,
      row.id,
      cutoff,
      row.owner_user_id,
      row.id,
      cutoff,
    ) as { tokens: number; attempts: number | null };
  const run = db()
    .prepare(
      `SELECT TOTAL(CASE WHEN state='active' THEN reserved_tokens ELSE accounted_tokens END) tokens
       FROM bot_group_member_model_admissions WHERE run_id=? AND id<>?
         AND (state='active' OR request_id IS NOT NULL)`,
    )
    .get(row.run_id, row.id) as { tokens: number };
  if (
    owner.tokens + row.reserved_tokens > limits.owner_tokens_24h ||
    run.tokens + row.reserved_tokens > limits.run_tokens
  )
    throw fail('GROUP_MEMBER_TOKEN_BUDGET_EXHAUSTED');
  if ((owner.attempts ?? 0) >= limits.owner_attempts_24h)
    throw fail('GROUP_MEMBER_OWNER_BUDGET_EXHAUSTED');
}
function available(row: Ticket) {
  const limits = memberModelLimits(row.run_id)!;
  return (
    count(
      "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE owner_user_id=? AND state='active'",
      row.owner_user_id,
    ) < limits.owner_active &&
    count(
      "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE group_id=? AND state='active'",
      row.group_id,
    ) < limits.group_active &&
    count(
      "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE session_id=? AND state='active'",
      row.session_id,
    ) < limits.member_active
  );
}
function tryAcquire(id: string, frame: MemberModelFrame) {
  return db().transaction(() => {
    const row = ticket(id);
    // A waiting ticket cannot run tools or disclose context. Check current
    // authority each time, but hash its frozen input only when capacity opens.
    assertMemberAuthority(row.session_id);
    if (row.state !== 'waiting')
      throw fail('GROUP_MEMBER_MODEL_ATTEMPT_FENCED');
    if (Date.now() >= row.deadline_at)
      throw fail('GROUP_MEMBER_CAPACITY_WAIT_EXPIRED');
    // Expired earlier waiters cannot block this owner's ready requests forever.
    db()
      .prepare(
        "UPDATE bot_group_member_model_admissions SET state='cancelled',terminal_kind='aborted',ended_at=?,error_code='GROUP_MEMBER_CAPACITY_WAIT_EXPIRED' WHERE state='waiting' AND deadline_at<=? AND id<>?",
      )
      .run(Date.now(), Date.now(), id);
    if (!available(row)) return false;
    const older = db()
      .prepare(
        "SELECT * FROM bot_group_member_model_admissions WHERE owner_user_id=? AND state='waiting' AND ordinal<? ORDER BY ordinal",
      )
      .all(row.owner_user_id, row.ordinal) as Ticket[];
    if (older.some((candidate) => available(candidate))) return false;
    validateSource(row.session_id, frame);
    verifyBudget(row, memberModelLimits(row.run_id)!);
    const changed = db()
      .prepare(
        "UPDATE bot_group_member_model_admissions SET state='active' WHERE id=? AND state='waiting'",
      )
      .run(id);
    if (changed.changes !== 1) throw fail('GROUP_MEMBER_MODEL_ATTEMPT_FENCED');
    return true;
  })();
}
function reported(result: ModelRequestResult) {
  const u = result.usage;
  if (!u) return null;
  const fields = [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens];
  if (fields.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const total = Math.max(
    u.totalTokens,
    u.input + u.output + u.cacheRead + u.cacheWrite,
  );
  if (!Number.isSafeInteger(total) || total === 0) return null;
  return {
    total,
    usage: {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      totalTokens: u.totalTokens,
    },
  };
}
function settle(id: string, instance: string, result: ModelRequestResult) {
  const exceeded = db().transaction(() => {
    const row = ticket(id);
    if (
      row.instance_id !== instance ||
      !['waiting', 'active'].includes(row.state)
    )
      throw fail('GROUP_MEMBER_MODEL_ATTEMPT_FENCED');
    const usage = reported(result),
      used = row.request_id
        ? result.kind === 'done' && usage
          ? usage.total
          : row.reserved_tokens
        : 0;
    db()
      .prepare(
        'UPDATE bot_group_member_model_admissions SET state=?,terminal_kind=?,reported_usage=?,reported_tokens=?,accounted_tokens=?,ended_at=? WHERE id=?',
      )
      .run(
        result.kind === 'aborted' ? 'cancelled' : 'released',
        result.kind,
        usage ? JSON.stringify(usage.usage) : null,
        usage?.total ?? null,
        used,
        Date.now(),
        id,
      );
    return used > row.reserved_tokens;
  })();
  // Preserve an excessive provider report before rejecting further execution.
  if (exceeded) throw fail('GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED');
}
/** Call only after this process acquired the Session's native OS-backed owner. */
export function recoverMemberModelAccounting(
  sessionId: string,
  instance: string,
) {
  db()
    .prepare(
      "UPDATE bot_group_member_model_admissions SET state=CASE WHEN request_id IS NULL THEN 'cancelled' ELSE 'uncertain' END,terminal_kind='uncertain',accounted_tokens=CASE WHEN request_id IS NULL THEN 0 ELSE reserved_tokens END,ended_at=?,error_code='MODEL_OWNER_RECOVERED' WHERE session_id=? AND instance_id<>? AND state IN ('waiting','active')",
    )
    .run(Date.now(), sessionId, instance);
}
/** Called after a trusted native terminal Stop proof, never on a UI intent alone. */
export function completeStoppedMemberModelAccounting(
  sessionId: string,
  runId: string,
) {
  db().transaction(() => {
    db()
      .prepare(
        `UPDATE product_cloud_model_attempts SET state='uncertain',finished_at=?
    WHERE session_id=? AND state='started' AND request_id IN (
      SELECT c.request_id FROM bot_group_member_cloud_attempts c
      JOIN bot_group_member_model_admissions a ON a.id=c.admission_id
      WHERE a.session_id=? AND a.run_id=?)`,
      )
      .run(new Date().toISOString(), sessionId, sessionId, runId);
    db()
      .prepare(
        "UPDATE bot_group_member_model_admissions SET state=CASE WHEN request_id IS NULL THEN 'cancelled' ELSE 'uncertain' END,terminal_kind='uncertain',accounted_tokens=CASE WHEN request_id IS NULL THEN 0 ELSE reserved_tokens END,ended_at=?,error_code='MODEL_NATIVE_STOP_CONFIRMED' WHERE session_id=? AND run_id=? AND state IN ('waiting','active')",
      )
      .run(Date.now(), sessionId, runId);
  })();
}
export async function acquireMemberModelAdmission(
  sessionId: string,
  frame: MemberModelFrame,
  request: ModelRequestInfo,
  instance: string,
): Promise<ModelRequestAdmission & { id: string }> {
  const id = db().transaction(() => {
    const { lease, run } = validateSource(sessionId, frame),
      limits = memberModelLimits(run.id);
    if (!limits) throw fail('GROUP_MEMBER_MODEL_POLICY_MISSING');
    const reserve =
      Math.max(request.contextWindow, request.contextBytes + 4096) +
      request.maxOutputTokens;
    if (
      !Number.isSafeInteger(reserve) ||
      reserve <= 0 ||
      reserve > limits.request_tokens
    )
      throw fail('GROUP_MEMBER_MODEL_CONTEXT_LIMIT');
    if (
      count(
        "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE owner_user_id=? AND state='waiting'",
        run.owner_user_id,
      ) >= limits.owner_waiting
    )
      throw fail('GROUP_MEMBER_MODEL_BACKPRESSURE');
    const id = randomUUID(),
      stamp = Date.now();
    const previous = db()
      .prepare(
        'SELECT id FROM bot_group_member_model_admissions WHERE lease_id=? AND native_task_id=? AND native_attempt=? ORDER BY ordinal DESC LIMIT 1',
      )
      .get(lease.id, frame.task_id, frame.attempt) as
      | { id: string }
      | undefined;
    db()
      .prepare(
        "INSERT INTO bot_group_member_model_admissions(id,run_id,lease_id,session_id,group_id,owner_user_id,instance_id,native_task_id,native_attempt,context_digest,source_inputs,reserved_tokens,previous_admission_id,created_at,deadline_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting')",
      )
      .run(
        id,
        run.id,
        lease.id,
        sessionId,
        run.group_id,
        run.owner_user_id,
        instance,
        frame.task_id,
        frame.attempt,
        frame.context_digest,
        JSON.stringify(frame.inputs),
        reserve,
        previous?.id ?? null,
        stamp,
        Math.min(stamp + limits.wait_ms, run.deadline_at),
      );
    return id;
  })();
  try {
    for (;;) {
      request.signal?.throwIfAborted();
      if (tryAcquire(id, frame)) break;
      await delay(50, undefined, { signal: request.signal });
    }
  } catch (error) {
    const row = ticket(id);
    const run = db()
      .prepare('SELECT status FROM bot_group_discussions WHERE id=?')
      .get(row.run_id) as { status: string };
    const cancelled = request.signal?.aborted || run.status !== 'running';
    if (['waiting', 'active'].includes(row.state))
      db()
        .prepare(
          "UPDATE bot_group_member_model_admissions SET state=?,terminal_kind='aborted',ended_at=?,error_code=? WHERE id=?",
        )
        .run(
          row.state === 'waiting' && !cancelled ? 'rejected' : 'cancelled',
          Date.now(),
          error instanceof BotGroupError
            ? error.code
            : 'MODEL_ADMISSION_CANCELLED',
          id,
        );
    throw error;
  }
  return {
    id,
    dispatch: () =>
      db().transaction(() => {
        const row = ticket(id),
          limits = memberModelLimits(row.run_id)!;
        if (
          row.state !== 'active' ||
          row.request_id ||
          row.instance_id !== instance
        )
          throw fail('GROUP_MEMBER_MODEL_ATTEMPT_FENCED');
        request.signal?.throwIfAborted();
        if (Date.now() >= row.deadline_at)
          throw fail('GROUP_MEMBER_CAPACITY_WAIT_EXPIRED');
        validateSource(sessionId, frame);
        verifyBudget(row, limits);
        const requestId = chargeMemberGeneration(sessionId, frame);
        db()
          .prepare(
            'UPDATE bot_group_member_model_admissions SET request_id=?,dispatched_at=? WHERE id=?',
          )
          .run(requestId, Date.now(), id);
      })(),
    settle: (result) => settle(id, instance, result),
  };
}

/** A signed DO host attests its persisted opening revision plus actual native
 * generation/input proof. A newer owned Harness fences the older invocation,
 * retaining conservative spend; no native Task is marked completed here. */
export function claimMemberCloudOwner(
  sessionId: string,
  runtimeId: string,
  objectId: string,
  revision: number,
  frame: MemberModelFrame,
) {
  return db().transaction(() => {
    const c = validateSource(sessionId, frame);
    if (
      c.origin.runtime_kind !== 'cloudflare-durable' ||
      !memberCloudRunEnabled(c.run.id) ||
      !Number.isSafeInteger(revision) ||
      revision <= 0
    )
      throw fail('GROUP_MEMBER_SOURCE_MISMATCH');
    const previous = db()
      .prepare('SELECT * FROM bot_group_member_cloud_owners WHERE session_id=?')
      .get(sessionId) as
      | {
          runtime_id: string;
          object_id: string;
          owner_revision: number;
          lease_id: string;
        }
      | undefined;
    if (
      previous &&
      (previous.runtime_id !== runtimeId ||
        previous.object_id !== objectId ||
        previous.owner_revision > revision ||
        (previous.owner_revision === revision &&
          previous.lease_id !== frame.lease_id))
    )
      throw fail('GROUP_MEMBER_NATIVE_OWNER_RETIRED');
    if (previous?.owner_revision === revision) return;
    // The signed transport attempt and native admission have distinct IDs.
    // Reconcile their immutable association before retiring this owner, even
    // if its Node gateway died without running a fetch cleanup handler.
    db()
      .prepare(
        `UPDATE product_cloud_model_attempts SET state='uncertain',finished_at=?
      WHERE session_id=? AND state='started' AND request_id IN (
        SELECT c.request_id FROM bot_group_member_cloud_attempts c
        JOIN bot_group_member_model_admissions a ON a.id=c.admission_id
        WHERE a.session_id=? AND a.state IN ('waiting','active') AND a.instance_id<>?)`,
      )
      .run(
        new Date().toISOString(),
        sessionId,
        sessionId,
        memberCloudOwnerKey(runtimeId, revision),
      );
    if (previous)
      db()
        .prepare(
          'UPDATE bot_group_member_cloud_owners SET owner_revision=?,lease_id=? WHERE session_id=?',
        )
        .run(revision, frame.lease_id, sessionId);
    else
      db()
        .prepare('INSERT INTO bot_group_member_cloud_owners VALUES(?,?,?,?,?)')
        .run(sessionId, runtimeId, objectId, revision, frame.lease_id);
    db()
      .prepare(
        `UPDATE bot_group_member_model_admissions SET state=CASE WHEN request_id IS NULL THEN 'cancelled' ELSE 'uncertain' END,
      terminal_kind='uncertain',accounted_tokens=CASE WHEN request_id IS NULL THEN 0 ELSE reserved_tokens END,ended_at=?,error_code='CLOUD_NATIVE_OWNER_REPLACED'
      WHERE session_id=? AND state IN ('waiting','active') AND instance_id<>?`,
      )
      .run(Date.now(), sessionId, memberCloudOwnerKey(runtimeId, revision));
  })();
}
export const memberCloudOwnerKey = (runtimeId: string, revision: number) =>
  `cloud:${runtimeId}:${revision}`;
export function assertMemberCloudOwner(sessionId: string, revision: number) {
  const row = db()
    .prepare(
      'SELECT owner_revision FROM bot_group_member_cloud_owners WHERE session_id=?',
    )
    .get(sessionId) as { owner_revision: number } | undefined;
  if (row?.owner_revision !== revision)
    throw fail('GROUP_MEMBER_NATIVE_OWNER_RETIRED');
}
