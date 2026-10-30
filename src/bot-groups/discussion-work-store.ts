import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BotGroupError, type GroupDatabase } from './protocol.js';
import {
  botGroupReadContext,
  mutateBotGroup,
  appendBotGroupSystemEvent,
} from './store.js';
import {
  getDiscussion,
  discussionTurns,
  assertDiscussionParticipants,
  targetGrant,
} from './discussion-store.js';
import {
  admitDiscussionWorkHandoff,
  botRuntimeGrantDigest,
} from './handoff-store.js';
import type { BotHandoff, BotRuntimeGrant } from './handoff-types.js';
import type {
  DiscussionWorkRequest,
  DiscussionWorkView,
} from './discussion-types.js';

let database: GroupDatabase | null = null;
export const bindDiscussionWorkDatabase = (value: GroupDatabase | null) => {
  database = value;
};
const db = () => {
  if (!database) throw new Error('Discussion work storage unavailable');
  return database;
};
const now = () => new Date().toISOString();
const fail = (code = 'GROUP_DISCUSSION_WORK_UNAVAILABLE') =>
  new BotGroupError(code);
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type DiscussionWorkRecord = Omit<
  DiscussionWorkView,
  keyof DiscussionWorkRequest | 'can_decide' | 'handoff_id'
> & {
  group_id: string;
  owner_user_id: string;
  target_profile_id: string;
  request: string;
  grant_id: string;
  grant_digest: string;
  tool_capabilities: string;
  max_model_attempts: number;
  handoff_id: string;
  approved_by: string | null;
  approval_request_id: string | null;
  approved_at: string | null;
};
export function getDiscussionWork(id: string) {
  return database
    ? (db()
        .prepare('SELECT * FROM bot_group_discussion_work WHERE id=?')
        .get(id) as DiscussionWorkRecord | undefined)
    : undefined;
}
export function discussionWorkForHandoff(handoffId: string) {
  return database
    ? (db()
        .prepare('SELECT * FROM bot_group_discussion_work WHERE handoff_id=?')
        .get(handoffId) as DiscussionWorkRecord | undefined)
    : undefined;
}
export function discussionWorkBudget(runId: string) {
  if (!database) return { used: 0, reserved: 0 };
  return db()
    .prepare(
      `SELECT COALESCE(SUM(h.model_attempts),0) used,
    COALESCE(SUM(CASE WHEN w.state='authorized' AND h.state NOT IN ('completed','cancelled','failed','uncertain')
      THEN MAX(0,w.max_model_attempts-h.model_attempts) ELSE 0 END),0) reserved
    FROM bot_group_discussion_work w JOIN bot_group_handoffs h ON h.id=w.handoff_id WHERE w.run_id=?`,
    )
    .get(runId) as { used: number; reserved: number };
}
export function availableDiscussionBudget(runId: string) {
  const run = db()
    .prepare(
      'SELECT model_attempts,max_model_attempts FROM bot_group_discussions WHERE id=?',
    )
    .get(runId) as
    | { model_attempts: number; max_model_attempts: number }
    | undefined;
  if (!run) throw fail();
  const work = discussionWorkBudget(runId);
  return Math.max(
    0,
    run.max_model_attempts - run.model_attempts - work.used - work.reserved,
  );
}
export function hasPendingDiscussionWork(runId: string) {
  return (
    !!database &&
    !!db()
      .prepare(
        "SELECT 1 FROM bot_group_discussion_work WHERE run_id=? AND (state IN ('awaiting_approval','authorized') OR (state='returned' AND continuation_state IN ('none','queued'))) LIMIT 1",
      )
      .get(runId)
  );
}
export function discussionWorkViews(
  actorId: string,
  groupId: string,
): DiscussionWorkView[] {
  const { member } = botGroupReadContext(actorId, groupId);
  const rows = db()
    .prepare(
      'SELECT w.*,EXISTS(SELECT 1 FROM bot_group_handoffs h WHERE h.id=w.handoff_id) admitted FROM bot_group_discussion_work w WHERE group_id=? ORDER BY created_at DESC,id DESC LIMIT 50',
    )
    .all(groupId) as (DiscussionWorkRecord & { admitted: number })[];
  return rows.reverse().map((row) => ({
    ...(JSON.parse(row.request) as DiscussionWorkRequest),
    id: row.id,
    run_id: row.run_id,
    originating_turn_id: row.originating_turn_id,
    source_message_id: row.source_message_id,
    requester_profile_id: row.requester_profile_id,
    proposal_digest: row.proposal_digest,
    state: row.state,
    handoff_id: row.admitted ? row.handoff_id : null,
    result_message_id: row.result_message_id,
    result_digest: row.result_digest,
    continuation_state: row.continuation_state,
    continuation_turn_id: row.continuation_turn_id,
    error_code: row.error_code,
    revision: row.revision,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
    can_decide:
      member.role === 'owner' &&
      row.state === 'awaiting_approval' &&
      Date.now() < row.deadline_at,
  }));
}
export function discussionWorkContext(runId: string) {
  return db()
    .prepare(
      'SELECT id,requester_profile_id,target_profile_id,state,source_message_id,result_message_id,result_digest,continuation_state,error_code FROM bot_group_discussion_work WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 12',
    )
    .all(runId);
}

/** Called only after native proof and canonical public reply have committed in
 * the surrounding turn transaction. A proposal is not an execution grant. */
export function createDiscussionWorkProposal(
  runId: string,
  turnId: string,
  request: DiscussionWorkRequest,
) {
  const run = getDiscussion(runId),
    turn = discussionTurns(runId).find((value) => value.id === turnId);
  if (
    !run ||
    run.status !== 'running' ||
    run.protocol_version !== 2 ||
    !turn ||
    turn.role !== 'speaker' ||
    turn.state !== 'completed' ||
    !turn.result_message_id ||
    !turn.input_id
  )
    throw fail();
  const decision = JSON.parse(turn.decision ?? '{}');
  if (
    decision.action !== 'delegate' ||
    JSON.stringify(decision.work) !== JSON.stringify(request) ||
    !run.participant_profile_ids.includes(request.target_profile_id)
  )
    throw fail('GROUP_DISCUSSION_WORK_ORIGIN_MISMATCH');
  const grant = targetGrant(
    run.owner_user_id,
    run.group_id,
    request.target_profile_id,
  );
  if (
    request.max_model_attempts > grant.max_model_attempts ||
    request.tool_capabilities.some(
      (cap) => !JSON.parse(grant.tool_capabilities).includes(cap),
    )
  )
    throw fail('GROUP_DISCUSSION_WORK_SCOPE_NOT_GRANTED');
  const frozen = JSON.parse(JSON.parse(turn.payload).content);
  const visible = new Set<string>([
    frozen.root_question.id,
    ...(frozen.recent_and_delta ?? []).map((m: { id: string }) => m.id),
    ...(frozen.user_interjections ?? []).map((m: { id: string }) => m.id),
    ...(frozen.known_session_output_ids ?? []),
  ]);
  if (request.context_message_ids.some((id) => !visible.has(id)))
    throw fail('GROUP_DISCUSSION_WORK_CONTEXT_MISMATCH');
  const id = randomUUID(),
    handoffId = randomUUID(),
    stamp = now(),
    deadline = Math.min(run.deadline_at, Date.parse(grant.expires_at));
  const proposal = {
    run_id: run.id,
    originating_turn_id: turn.id,
    source_message_id: turn.result_message_id,
    requester_profile_id: turn.profile_id,
    request,
    grant_id: grant.id,
    grant_digest: botRuntimeGrantDigest(grant),
    deadline_at: deadline,
    handoff_id: handoffId,
  };
  db()
    .prepare(
      `INSERT INTO bot_group_discussion_work(id,run_id,group_id,owner_user_id,originating_turn_id,source_message_id,requester_profile_id,target_profile_id,request,proposal_digest,grant_id,grant_digest,tool_capabilities,max_model_attempts,deadline_at,handoff_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_approval',?,?)`,
    )
    .run(
      id,
      run.id,
      run.group_id,
      run.owner_user_id,
      turn.id,
      turn.result_message_id,
      turn.profile_id,
      request.target_profile_id,
      JSON.stringify(request),
      digest(proposal),
      grant.id,
      proposal.grant_digest,
      JSON.stringify([...request.tool_capabilities].sort()),
      request.max_model_attempts,
      deadline,
      handoffId,
      stamp,
      stamp,
    );
  return getDiscussionWork(id)!;
}

const DecisionSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    proposal_digest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'deny']),
  })
  .strict();
export function decideDiscussionWork(
  actorId: string,
  groupId: string,
  workId: string,
  requestId: string,
  raw: unknown,
) {
  const input = DecisionSchema.parse(raw);
  return mutateBotGroup(
    actorId,
    requestId,
    'discussion_work_decision',
    groupId,
    { work_id: workId, ...input },
    () => {
      const { group, member } = botGroupReadContext(actorId, groupId),
        work = getDiscussionWork(workId);
      if (
        member.role !== 'owner' ||
        !work ||
        work.group_id !== groupId ||
        work.owner_user_id !== actorId
      )
        throw fail();
      if (
        work.state !== 'awaiting_approval' ||
        work.revision !== input.expected_revision ||
        work.proposal_digest !== input.proposal_digest
      )
        throw fail('GROUP_DISCUSSION_WORK_REVISION_CONFLICT');
      if (input.decision === 'approve') {
        const run = getDiscussion(work.run_id);
        if (
          !run ||
          run.status !== 'running' ||
          group.state !== 'active' ||
          Date.now() >= work.deadline_at
        )
          throw fail();
        assertDiscussionParticipants(run);
        const grant = targetGrant(actorId, groupId, work.target_profile_id);
        if (
          grant.id !== work.grant_id ||
          botRuntimeGrantDigest(grant) !== work.grant_digest
        )
          throw fail('GROUP_DISCUSSION_WORK_SCOPE_CHANGED');
        if (availableDiscussionBudget(run.id) < work.max_model_attempts)
          throw fail('GROUP_DISCUSSION_WORK_BUDGET_UNAVAILABLE');
        db()
          .prepare(
            "UPDATE bot_group_discussion_work SET state='authorized',approved_by=?,approval_request_id=?,approved_at=?,revision=revision+1,updated_at=? WHERE id=? AND state='awaiting_approval'",
          )
          .run(actorId, requestId, now(), now(), work.id);
        admitDiscussionWorkHandoff(actorId, work.id);
      } else
        db()
          .prepare(
            "UPDATE bot_group_discussion_work SET state='denied',continuation_state='suppressed',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(now(), work.id);
      return appendBotGroupSystemEvent(
        groupId,
        actorId,
        input.decision === 'approve'
          ? '已确认后台工作，群聊将继续'
          : '已拒绝后台工作提议',
        'discussion_work_decision',
        [],
        { work_id: work.id, decision: input.decision },
      );
    },
  );
}

/** This narrows an existing grant; it can never manufacture a new one. */
export function effectiveDiscussionWorkScope(
  handoff: BotHandoff,
  grant: BotRuntimeGrant,
) {
  const work = discussionWorkForHandoff(handoff.id);
  if (!work) {
    if (JSON.parse(handoff.payload).discussion_origin)
      throw fail('GROUP_DISCUSSION_WORK_ORIGIN_MISSING');
    return {
      toolCapabilities: JSON.parse(grant.tool_capabilities) as string[],
      maxModelAttempts: grant.max_model_attempts,
      deadlineAt: Date.parse(grant.expires_at),
    };
  }
  const tools = JSON.parse(work.tool_capabilities) as string[];
  if (
    !['authorized', 'returned'].includes(work.state) ||
    work.approved_by !== handoff.owner_user_id ||
    !work.approval_request_id ||
    work.grant_id !== grant.id ||
    work.grant_digest !== handoff.grant_digest ||
    work.group_id !== handoff.group_id ||
    work.target_profile_id !== handoff.target_bot_id ||
    work.max_model_attempts > grant.max_model_attempts ||
    work.deadline_at > Date.parse(grant.expires_at) ||
    tools.some((tool) => !JSON.parse(grant.tool_capabilities).includes(tool))
  )
    throw fail('GROUP_DISCUSSION_WORK_SCOPE_CHANGED');
  return {
    toolCapabilities: tools,
    maxModelAttempts: work.max_model_attempts,
    deadlineAt: work.deadline_at,
  };
}
export function assertDiscussionWorkGeneration(handoff: BotHandoff) {
  const work = discussionWorkForHandoff(handoff.id);
  if (!work) return;
  const run = db()
    .prepare(
      'SELECT model_attempts,max_model_attempts FROM bot_group_discussions WHERE id=?',
    )
    .get(work.run_id) as
    | { model_attempts: number; max_model_attempts: number }
    | undefined;
  const used = discussionWorkBudget(work.run_id).used;
  if (
    !run ||
    work.state !== 'authorized' ||
    Date.now() >= work.deadline_at ||
    handoff.model_attempts >= work.max_model_attempts ||
    run.model_attempts + used >= run.max_model_attempts
  )
    throw fail('GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED');
}

/** The existing Handoff projection proves the native result first. This sweep
 * only associates that already-public result and never invents reply text. */
export function refreshDiscussionWorkResults() {
  if (!database) return [] as string[];
  const changed = new Set<string>();
  db().transaction(() => {
    const rows = db()
      .prepare(
        "SELECT w.* FROM bot_group_discussion_work w JOIN bot_group_handoffs h ON h.id=w.handoff_id WHERE w.state='authorized' AND h.state IN ('completed','cancelled','failed','uncertain')",
      )
      .all() as DiscussionWorkRecord[];
    for (const work of rows) {
      const h = db()
        .prepare('SELECT * FROM bot_group_handoffs WHERE id=?')
        .get(work.handoff_id) as BotHandoff;
      const run = getDiscussion(work.run_id);
      if (h.state === 'completed') {
        const message = db()
          .prepare(
            "SELECT source FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind='bot'",
          )
          .get(h.result_message_id, work.group_id) as
          | { source: string }
          | undefined;
        const source = message && JSON.parse(message.source);
        if (
          !h.result_message_id ||
          !h.result_digest ||
          source?.kind !== 'native_handoff_result' ||
          source.handoff_id !== h.id ||
          source.result_digest !== h.result_digest
        ) {
          db()
            .prepare(
              "UPDATE bot_group_discussion_work SET state='failed',continuation_state='suppressed',error_code='GROUP_DISCUSSION_WORK_RESULT_MISMATCH',revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(now(), work.id);
          appendBotGroupSystemEvent(
            work.group_id,
            work.owner_user_id,
            '后台工作回执无法核对，未自动接话',
            'discussion_work_result',
            [],
            { work_id: work.id, handoff_id: h.id },
          );
          changed.add(work.group_id);
          continue;
        }
        db()
          .prepare(
            "UPDATE bot_group_discussion_work SET state='returned',result_message_id=?,result_digest=?,continuation_state=CASE WHEN ? THEN continuation_state ELSE 'suppressed' END,revision=revision+1,updated_at=? WHERE id=? AND state='authorized'",
          )
          .run(
            h.result_message_id,
            h.result_digest,
            run?.status === 'running' ? 1 : 0,
            now(),
            work.id,
          );
      } else
        db()
          .prepare(
            "UPDATE bot_group_discussion_work SET state='failed',continuation_state='suppressed',error_code=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(
            `GROUP_DISCUSSION_WORK_${h.state.toUpperCase()}`,
            now(),
            work.id,
          );
      appendBotGroupSystemEvent(
        work.group_id,
        work.owner_user_id,
        h.state === 'completed'
          ? '后台工作结果已返回群聊'
          : '后台工作未完成，请检查任务状态',
        'discussion_work_result',
        [],
        { work_id: work.id, handoff_id: h.id },
      );
      changed.add(work.group_id);
    }
  })();
  return [...changed];
}
export function queueDiscussionWorkContinuation(runId: string) {
  const run = getDiscussion(runId);
  if (!run || run.status !== 'running' || run.phase !== 'coordinator') return;
  const works = db()
    .prepare(
      "SELECT * FROM bot_group_discussion_work WHERE run_id=? AND state='returned' AND continuation_state='none' ORDER BY created_at,id",
    )
    .all(runId) as DiscussionWorkRecord[];
  for (const work of works) {
    const turns = discussionTurns(runId);
    if (
      turns.some(
        (t) =>
          t.profile_id === work.requester_profile_id && t.state === 'pending',
      )
    )
      return;
    const exhausted =
      turns.filter((t) => t.role === 'speaker').length >= run.max_turns ||
      turns.filter(
        (t) =>
          t.role === 'speaker' && t.profile_id === work.requester_profile_id,
      ).length >= run.max_turns_per_dot ||
      availableDiscussionBudget(runId) <= 0;
    if (exhausted) {
      db()
        .prepare(
          "UPDATE bot_group_discussion_work SET continuation_state='suppressed',error_code='GROUP_DISCUSSION_WORK_CONTINUATION_BUDGET',revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(now(), work.id);
      appendBotGroupSystemEvent(
        work.group_id,
        work.owner_user_id,
        '工作结果已保留，本轮额度不足，未追加接话',
        'discussion_work_continuation',
        [],
        { work_id: work.id },
      );
      continue;
    }
    db()
      .prepare(
        "UPDATE bot_group_discussion_work SET continuation_state='queued',revision=revision+1,updated_at=? WHERE id=? AND continuation_state='none'",
      )
      .run(now(), work.id);
    db()
      .prepare(
        "UPDATE bot_group_discussions SET phase='speaker',current_speaker_profile_id=?,pending_relay_from_turn_id=NULL,awaiting_results_since=NULL,activity=?,revision=revision+1,updated_at=? WHERE id=? AND status='running'",
      )
      .run(
        work.requester_profile_id,
        '后台结果已返回，请求方正在接续…',
        now(),
        runId,
      );
    return;
  }
}
export function pendingDiscussionWorkContinuation(
  runId: string,
  profileId: string,
) {
  return db()
    .prepare(
      "SELECT * FROM bot_group_discussion_work WHERE run_id=? AND requester_profile_id=? AND state='returned' AND continuation_state='queued' ORDER BY created_at,id LIMIT 1",
    )
    .get(runId, profileId) as DiscussionWorkRecord | undefined;
}
export function consumeDiscussionWorkContinuation(
  workId: string,
  turnId: string,
) {
  const changed = db()
    .prepare(
      "UPDATE bot_group_discussion_work SET continuation_state='consumed',continuation_turn_id=?,revision=revision+1,updated_at=? WHERE id=? AND continuation_state='queued' AND continuation_turn_id IS NULL",
    )
    .run(turnId, now(), workId);
  if (changed.changes !== 1)
    throw fail('GROUP_DISCUSSION_WORK_CONTINUATION_CONFLICT');
}
export function cancelDiscussionWorkContinuations(runId: string) {
  db()
    .prepare(
      "UPDATE bot_group_discussion_work SET state=CASE WHEN state='awaiting_approval' THEN 'cancelled' ELSE state END,continuation_state=CASE WHEN continuation_state='consumed' THEN continuation_state ELSE 'suppressed' END,revision=revision+1,updated_at=? WHERE run_id=? AND (state IN ('awaiting_approval','authorized') OR continuation_state IN ('none','queued'))",
    )
    .run(now(), runId);
}
