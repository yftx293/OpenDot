import {
  assertGroupDiscussionAuthority,
  assertGroupDiscussionSubmission,
  chargeGroupDiscussionGeneration,
  groupSessionOrigin,
} from './discussion-store.js';
import {
  getDiscussionWork,
  discussionWorkForHandoff,
  effectiveDiscussionWorkScope,
  assertDiscussionWorkGeneration,
} from './discussion-work-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertGoalTeamHandoff } from '../personal-agent/goal-team-store.js';
import { BotGroupError, type GroupDatabase } from './protocol.js';
import {
  botGroupExecutionTarget,
  mutateBotGroup,
  appendBotGroupSystemEvent,
  botGroupReadContext,
} from './store.js';
import type {
  BotHandoff,
  BotRuntimeGrant,
  BotHandoffView,
} from './handoff-types.js';

let database: GroupDatabase | null = null;
export function bindBotHandoffDatabase(value: GroupDatabase | null) {
  database = value;
}
const db = () => {
  if (!database) throw new Error('Bot Handoff storage unavailable');
  return database;
};
function touchGroup(groupId: string) {
  db()
    .prepare(
      'UPDATE bot_groups SET revision=revision+1,updated_at=? WHERE id=?',
    )
    .run(new Date().toISOString(), groupId);
}
export const handoffDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class BotHandoffSuspended extends Error {}
export const cloudBotHandoffsEnabled = () =>
  [
    'MINICLAW_BOT_GROUPS',
    'MINICLAW_BOT_HANDOFFS',
    'MINICLAW_CLOUD_RUNTIME',
    'MINICLAW_CLOUD_BOT_HANDOFFS',
  ].every((key) => process.env[key] === 'true');
const unavailable = () =>
  new BotGroupError('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
export const BotRuntimeGrantSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    expected_member_revision: z.number().int().positive(),
    runtime_kind: z.enum(['node-durable', 'cloudflare-durable']),
    max_model_attempts: z.number().int().min(1).max(12).default(4),
    expires_in_minutes: z.number().int().min(1).max(1440).default(60),
    tool_capabilities: z
      .array(
        z.enum([
          'read_workspace_file',
          'create_approved_artifact',
          'inspect_text',
          'read_device_file',
        ]),
      )
      .max(2)
      .default([])
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();
export function currentBotRuntimeGrant(memberId: string) {
  return db()
    .prepare(
      'SELECT * FROM bot_group_runtime_grants WHERE member_id=? AND revoked_at IS NULL',
    )
    .get(memberId) as BotRuntimeGrant | undefined;
}
export function getBotHandoff(id: string) {
  return db().prepare('SELECT * FROM bot_group_handoffs WHERE id=?').get(id) as
    | BotHandoff
    | undefined;
}
/** Frozen Cloud metadata must be exactly the reviewed Handoff grant, even if
 * an internal provisioner supplies a valid but more permissive Cloud selection. */
export function matchesBotHandoffCloudGrant(
  row: BotHandoff,
  binding: Pick<
    import('../personal-agent/cloud-wire.js').CloudBinding,
    'bot_handoff' | 'max_model_steps' | 'deadline_at' | 'tool_capabilities'
  >,
) {
  const marker = binding.bot_handoff;
  if (
    row.runtime_kind !== 'cloudflare-durable' ||
    !marker ||
    marker.handoff_id !== row.id ||
    marker.group_id !== row.group_id ||
    marker.grant_digest !== row.grant_digest ||
    !binding.tool_capabilities
  )
    return false;
  const grant = db()
    .prepare('SELECT * FROM bot_group_runtime_grants WHERE id=?')
    .get(row.grant_id) as BotRuntimeGrant | undefined;
  if (!grant) return false;
  let scope: ReturnType<typeof effectiveDiscussionWorkScope>;
  try {
    scope = effectiveDiscussionWorkScope(row, grant);
  } catch {
    return false;
  }
  return (
    !!grant &&
    grant.runtime_kind === 'cloudflare-durable' &&
    botRuntimeGrantDigest(grant) === row.grant_digest &&
    binding.max_model_steps === scope.maxModelAttempts &&
    binding.deadline_at === scope.deadlineAt &&
    JSON.stringify([...binding.tool_capabilities].sort()) ===
      JSON.stringify([...scope.toolCapabilities].sort())
  );
}
export function listBotHandoffs(groupId: string) {
  return db()
    .prepare(
      'SELECT * FROM bot_group_handoffs WHERE group_id=? ORDER BY created_at,id',
    )
    .all(groupId) as BotHandoff[];
}
export function handoffForProductSession(sessionId: string) {
  const origin = db()
    .prepare(
      'SELECT handoff_id FROM bot_handoff_session_origins WHERE session_id=?',
    )
    .get(sessionId) as { handoff_id: string } | undefined;
  if (!origin) return undefined;
  const handoff = getBotHandoff(origin.handoff_id);
  if (!handoff || handoff.session_id !== sessionId) throw unavailable();
  return handoff;
}
export function assertBotHandoffAuthority(
  sessionId: string,
  options: { execute?: boolean; tool?: string } = {},
) {
  assertGroupDiscussionAuthority(sessionId, options);
  const handoff = handoffForProductSession(sessionId);
  if (!handoff) return undefined;
  if (handoff.goal_id && (options.execute || options.tool))
    assertGoalTeamHandoff(handoff.id, handoff.goal_id);
  const { group, member } = botGroupReadContext(
    handoff.owner_user_id,
    handoff.group_id,
  );
  if (member.role !== 'owner') throw unavailable();
  const target =
    options.execute || options.tool
      ? botGroupExecutionTarget(
          handoff.owner_user_id,
          handoff.group_id,
          handoff.target_member_id,
        ).target
      : undefined;
  const grant = db()
    .prepare('SELECT * FROM bot_group_runtime_grants WHERE id=?')
    .get(handoff.grant_id) as BotRuntimeGrant | undefined;
  const runtime = db()
    .prepare(
      'SELECT owner_user_id,workspace_jid,config_fingerprint,provider_id,EXISTS(SELECT 1 FROM product_cloud_sessions c WHERE c.session_id=r.session_id) AS is_cloud FROM product_session_runtimes r WHERE session_id=?',
    )
    .get(sessionId) as
    | {
        owner_user_id: string;
        workspace_jid: string;
        config_fingerprint: string;
        provider_id: string;
        is_cloud: number;
      }
    | undefined;
  if (
    !grant ||
    !runtime ||
    group.owner_user_id !== grant.owner_user_id ||
    grant.owner_user_id !== runtime.owner_user_id ||
    grant.member_id !== handoff.target_member_id ||
    grant.group_id !== handoff.group_id ||
    grant.profile_id !== handoff.target_bot_id ||
    (target &&
      (grant.profile_id !== target.subject_id ||
        grant.workspace_jid !== target.scope_workspace_jid ||
        target.revision !== grant.member_revision)) ||
    runtime.workspace_jid !== grant.workspace_jid ||
    runtime.config_fingerprint !== grant.config_fingerprint ||
    runtime.provider_id !== grant.provider_id ||
    Boolean(runtime.is_cloud) !==
      (handoff.runtime_kind === 'cloudflare-durable') ||
    handoff.grant_digest !== botRuntimeGrantDigest(grant)
  )
    throw unavailable();
  if (
    (options.execute || options.tool) &&
    ['paused', 'cancelling'].includes(handoff.state)
  )
    throw new BotHandoffSuspended('Bot Handoff execution is suspended');
  if (
    (options.execute || options.tool) &&
    (grant.revoked_at !== null ||
      Date.parse(grant.expires_at) <= Date.now() ||
      ![
        'pending',
        'running',
        'waiting_for_approval',
        'waiting_for_device',
      ].includes(handoff.state))
  )
    throw unavailable();
  const scope = effectiveDiscussionWorkScope(handoff, grant);
  if ((options.execute || options.tool) && Date.now() >= scope.deadlineAt)
    throw unavailable();
  if (options.tool && !scope.toolCapabilities.includes(options.tool))
    throw new BotGroupError('BOT_HANDOFF_TOOL_NOT_GRANTED', 403);
  return handoff;
}
export function chargeBotHandoffGeneration(sessionId: string) {
  chargeGroupDiscussionGeneration(sessionId);
  return db().transaction(() => {
    const handoff = assertBotHandoffAuthority(sessionId, { execute: true });
    if (!handoff) return;
    const grant = db()
      .prepare('SELECT * FROM bot_group_runtime_grants WHERE id=?')
      .get(handoff.grant_id) as BotRuntimeGrant;
    const scope = effectiveDiscussionWorkScope(handoff, grant);
    if (handoff.model_attempts >= scope.maxModelAttempts)
      throw new BotGroupError('BOT_HANDOFF_MODEL_BUDGET_EXHAUSTED');
    assertDiscussionWorkGeneration(handoff);
    db()
      .prepare(
        'UPDATE bot_group_handoffs SET model_attempts=model_attempts+1,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(new Date().toISOString(), handoff.id);
    if (handoff.goal_id) {
      const counted = db()
        .prepare(
          'UPDATE goal_execution_contexts SET generation_steps=generation_steps+1 WHERE run_id=(SELECT run_id FROM personal_goal_team_steps WHERE handoff_id=?)',
        )
        .run(handoff.id);
      if (counted.changes !== 1)
        throw new BotGroupError('GOAL_TEAM_EXECUTION_SUSPENDED');
    }
    touchGroup(handoff.group_id);
  })();
}
/** selected() is the existing synchronous Runtime Router, called only inside
 * the receipt transaction after current Owner/Profile/Workspace validation. */
export function grantBotRuntime(
  actorId: string,
  groupId: string,
  memberId: string,
  requestId: string,
  raw: unknown,
  selected: (
    workspaceJid: string,
    kind: 'node-durable' | 'cloudflare-durable',
  ) => { configFingerprint?: string; providerId?: string | null },
) {
  const input = BotRuntimeGrantSchema.parse(raw);
  return mutateBotGroup(
    actorId,
    requestId,
    'grant_bot_runtime',
    groupId,
    { member_id: memberId, ...input },
    () => {
      const { group, target } = botGroupExecutionTarget(
        actorId,
        groupId,
        memberId,
      );
      if (
        group.revision !== input.expected_revision ||
        target.revision !== input.expected_member_revision
      )
        throw new BotGroupError('BOT_GROUP_REVISION_CONFLICT');
      const selection = selected(
        target.scope_workspace_jid!,
        input.runtime_kind,
      );
      if (!selection.configFingerprint || !selection.providerId)
        throw unavailable();
      if (
        (input.runtime_kind === 'cloudflare-durable' &&
          input.tool_capabilities.includes('read_workspace_file')) ||
        (input.runtime_kind === 'node-durable' &&
          (input.tool_capabilities.includes('inspect_text') ||
            input.tool_capabilities.includes('read_device_file'))) ||
        (input.tool_capabilities.includes('read_device_file') &&
          (process.env.MINICLAW_CLOUD_DEVICES !== 'true' ||
            process.env.MINICLAW_DEVICE_NODES !== 'true'))
      )
        throw new BotGroupError('BOT_HANDOFF_TOOL_NOT_GRANTED', 400);
      const now = new Date().toISOString(),
        id = randomUUID();
      db()
        .prepare(
          'UPDATE bot_group_runtime_grants SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL',
        )
        .run(now, memberId);
      db()
        .prepare(
          'INSERT INTO bot_group_runtime_grants(id,group_id,member_id,owner_user_id,profile_id,workspace_jid,member_revision,runtime_kind,config_fingerprint,provider_id,tool_capabilities,max_model_attempts,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          groupId,
          memberId,
          actorId,
          target.subject_id,
          target.scope_workspace_jid,
          target.revision,
          input.runtime_kind,
          selection.configFingerprint,
          selection.providerId,
          JSON.stringify(input.tool_capabilities),
          input.max_model_attempts,
          now,
          new Date(Date.now() + input.expires_in_minutes * 60000).toISOString(),
        );
      return appendBotGroupSystemEvent(
        groupId,
        actorId,
        'Bot 任务执行已授权',
        'bot_runtime_granted',
        [],
        { grant_id: id, member_id: memberId, runtime_kind: input.runtime_kind },
      );
    },
  );
}
export function botHandoffView(
  actorId: string,
  groupId: string,
): BotHandoffView[] {
  // Current read authorization is distinct from native execution permission.
  const snapshot = botGroupReadContext(actorId, groupId);
  return listBotHandoffs(groupId).map((row) => ({
    id: row.id,
    ...(row.runtime_kind === 'cloudflare-durable'
      ? { association: botHandoffAssociationView(row.id) }
      : {}),
    delivery_attempts: row.delivery_attempts,
    delivery_next_at: row.delivery_next_at,
    delivery_error_code: row.delivery_error_code,
    input_id: row.input_id,
    request_id: row.request_id,
    payload_digest: row.payload_digest,
    goal_id: row.goal_id,
    grant_id: row.grant_id,
    budget_max_attempts:
      discussionWorkForHandoff(row.id)?.max_model_attempts ??
      (row.grant_id
        ? ((
            db()
              .prepare(
                'SELECT max_model_attempts FROM bot_group_runtime_grants WHERE id=?',
              )
              .get(row.grant_id) as BotRuntimeGrant | undefined
          )?.max_model_attempts ?? null)
        : null),
    expires_at: discussionWorkForHandoff(row.id)
      ? new Date(discussionWorkForHandoff(row.id)!.deadline_at).toISOString()
      : row.grant_id
        ? ((
            db()
              .prepare(
                'SELECT expires_at FROM bot_group_runtime_grants WHERE id=?',
              )
              .get(row.grant_id) as BotRuntimeGrant | undefined
          )?.expires_at ?? null)
        : null,
    cost_status: 'unpriced' as const,
    group_id: row.group_id,
    source_message_id: row.source_message_id,
    source_bot_id: row.source_bot_id,
    target_bot_id: row.target_bot_id,
    parent_handoff_id: row.parent_handoff_id,
    depth: row.depth,
    state: row.state,
    session_id: row.session_id,
    runtime_kind: row.runtime_kind,
    submission_id: row.submission_id,
    task_id: row.task_id,
    model_attempts: row.model_attempts,
    progress: row.progress,
    result_message_id: row.result_message_id,
    answer_entry_id: row.answer_entry_id,
    result_digest: row.result_digest,
    revision: row.revision,
    can_control: snapshot.member.role === 'owner',
    can_delegate:
      snapshot.member.role === 'owner' &&
      row.state === 'completed' &&
      row.depth < 2 &&
      !!db()
        .prepare(
          "SELECT 1 FROM agent_profiles WHERE id=? AND owner_user_id=? AND is_default=1 AND status='active'",
        )
        .get(row.target_bot_id, row.owner_user_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/** Explicit, versioned identity fields; future storage columns cannot silently
 * change a committed grant digest. Revocation is a live fence, not new identity. */
export function botRuntimeGrantDigest(grant: BotRuntimeGrant) {
  return handoffDigest([
    'bot-runtime-grant.v1',
    grant.id,
    grant.group_id,
    grant.member_id,
    grant.owner_user_id,
    grant.profile_id,
    grant.workspace_jid,
    grant.member_revision,
    grant.runtime_kind,
    grant.config_fingerprint,
    grant.provider_id,
    grant.tool_capabilities,
    grant.max_model_attempts,
    grant.created_at,
    grant.expires_at,
  ]);
}
export function groupChatTargets(groupId: string, mentions: string[]) {
  if (mentions.length) return mentions;
  const target = db()
    .prepare(
      `SELECT m.subject_id FROM bot_group_members m
    JOIN bot_groups g ON g.id=m.group_id JOIN agent_profiles p ON p.id=m.subject_id
    WHERE m.group_id=? AND m.kind='bot' AND m.state='active' AND p.status='active'
      AND p.owner_user_id=g.owner_user_id ORDER BY p.is_default DESC,m.created_at,m.id LIMIT 1`,
    )
    .get(groupId) as { subject_id: string } | undefined;
  return target ? [target.subject_id] : [];
}
export function admitGroupMessageHandoffs(
  actorId: string,
  groupId: string,
  messageId: string,
  parentId?: string,
  goalStep?: {
    goal_id: string;
    run_id: string;
    handoff_id: string;
    chief_profile_id: string;
  },
) {
  return db().transaction(() => {
    const { group, member } = botGroupReadContext(actorId, groupId);
    // Shared timeline membership is not permission to spend an Owner's model or
    // tool budget. The initial rollout accepts execution requests by Owner only.
    if (member.role !== 'owner') return [];
    if (group.state !== 'active') throw unavailable();
    const source = db()
      .prepare(
        "SELECT * FROM bot_group_messages WHERE id=? AND group_id=? AND kind='user_message' AND author_kind='user' AND author_id=?",
      )
      .get(messageId, groupId, actorId) as
      | {
          id: string;
          content: string;
          mentions: string;
          author_name: string;
          created_at: string;
        }
      | undefined;
    if (!source) throw new BotGroupError('BOT_HANDOFF_SOURCE_MISMATCH');
    const chief = db()
      .prepare(
        "SELECT id FROM agent_profiles WHERE owner_user_id=? AND is_default=1 AND status='active'",
      )
      .get(actorId) as { id: string } | undefined;
    const explicit = JSON.parse(source.mentions) as string[];
    const targets = groupChatTargets(groupId, explicit);
    if (goalStep) {
      const verified = db()
        .prepare(
          'SELECT 1 FROM personal_goal_team_steps s JOIN personal_goal_teams t ON t.goal_id=s.goal_id JOIN bot_group_members m ON m.id=s.selected_member_id WHERE s.run_id=? AND s.goal_id=? AND s.handoff_id=? AND s.source_message_id=? AND t.group_id=? AND t.chief_profile_id=? AND m.subject_id=?',
        )
        .get(
          goalStep.run_id,
          goalStep.goal_id,
          goalStep.handoff_id,
          messageId,
          groupId,
          goalStep.chief_profile_id,
          targets[0],
        );
      if (
        !verified ||
        parentId ||
        targets.length !== 1 ||
        chief?.id !== goalStep.chief_profile_id
      )
        throw new BotGroupError('GOAL_TEAM_STEP_BINDING_CONFLICT');
      assertGoalTeamHandoff(goalStep.handoff_id, goalStep.goal_id);
    }
    if (!targets.length || targets.length > 2)
      throw new BotGroupError('BOT_HANDOFF_FANOUT_LIMIT', 400);
    const parent = parentId ? getBotHandoff(parentId) : undefined;
    if (
      parentId &&
      (!parent ||
        parent.group_id !== groupId ||
        parent.owner_user_id !== actorId ||
        parent.target_bot_id !== chief?.id ||
        parent.state !== 'completed' ||
        !parent.result_message_id ||
        !parent.submission_id ||
        !parent.task_id)
    )
      throw new BotGroupError('BOT_HANDOFF_PARENT_UNAVAILABLE');
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > 2) throw new BotGroupError('BOT_HANDOFF_DEPTH_LIMIT');
    const existing = listBotHandoffs(groupId);
    if (
      parent &&
      existing.filter(
        (row) =>
          row.parent_handoff_id === parent.id &&
          row.source_message_id !== messageId,
      ).length +
        targets.length >
        2
    )
      throw new BotGroupError('BOT_HANDOFF_FANOUT_LIMIT');
    if (
      existing.length +
        targets.filter(
          (profile) =>
            !existing.some(
              (row) =>
                row.source_message_id === messageId &&
                row.target_bot_id === profile,
            ),
        ).length >
      100
    )
      throw new BotGroupError('BOT_HANDOFF_GROUP_BUDGET_EXHAUSTED', 429);
    const result: BotHandoff[] = [];
    for (const profileId of targets) {
      const previous = existing.find(
        (row) =>
          row.source_message_id === messageId &&
          row.target_bot_id === profileId,
      );
      if (previous) {
        if (previous.parent_handoff_id !== (parent?.id ?? null))
          throw unavailable();
        result.push(previous);
        continue;
      }
      const target = db()
        .prepare(
          "SELECT id FROM bot_group_members WHERE group_id=? AND kind='bot' AND subject_id=? AND state='active'",
        )
        .get(groupId, profileId) as { id: string } | undefined;
      if (!target) throw new BotGroupError('BOT_HANDOFF_TARGET_UNAVAILABLE');
      const context = {
        kind: 'bot_group_request',
        group_id: groupId,
        message_id: messageId,
        target_bot_id: profileId,
        actor_user_id: actorId,
        actor_name: source.author_name,
        created_at: source.created_at,
        content: source.content,
        parent: parent
          ? {
              handoff_id: parent.id,
              source_bot_id: parent.target_bot_id,
              session_id: parent.session_id,
              submission_id: parent.submission_id,
              task_id: parent.task_id,
              result_message_id: parent.result_message_id,
              result_digest: parent.result_digest,
              // Explicitly authorized, same-Group result; always user data.
              untrusted_result:
                (
                  db()
                    .prepare(
                      "SELECT content FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind='bot'",
                    )
                    .get(parent.result_message_id, groupId) as
                    | { content: string }
                    | undefined
                )?.content.slice(0, 4000) ?? '',
              result_excerpt_limit: 4000,
            }
          : null,
      };
      const payload = JSON.stringify(context),
        id = goalStep?.handoff_id ?? randomUUID(),
        now = new Date().toISOString();
      // Match the existing native Product input limit before any association or
      // receipt commits. JSON escaping can expand a valid shared chat message.
      if (payload.length > 32768)
        throw new BotGroupError('BOT_HANDOFF_CONTEXT_TOO_LARGE', 400);
      db()
        .prepare(
          "INSERT INTO bot_group_handoffs(id,group_id,owner_user_id,source_message_id,source_bot_id,target_bot_id,target_member_id,parent_handoff_id,depth,request_id,payload,payload_digest,goal_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting_for_authorization',?,?)",
        )
        .run(
          id,
          groupId,
          actorId,
          messageId,
          goalStep?.chief_profile_id ?? parent?.target_bot_id ?? null,
          profileId,
          target.id,
          parent?.id ?? null,
          depth,
          `handoff:${id}`,
          payload,
          handoffDigest(context),
          goalStep?.goal_id ?? null,
          now,
          now,
        );
      touchGroup(groupId);
      if (provisioner) {
        const current = currentBotRuntimeGrant(target.id);
        if (current && Date.parse(current.expires_at) > Date.now())
          bindBotHandoffSession(actorId, id, provisioner);
      }
      result.push(getBotHandoff(id)!);
    }
    return result;
  })();
}
/** Explicit owner-approved discussion origin. Never forge an owner user_message
 * or relax the legacy user-message admission path to admit Bot text. */
export function admitDiscussionWorkHandoff(actorId: string, workId: string) {
  return db().transaction(() => {
    const work = getDiscussionWork(workId);
    if (
      !work ||
      work.state !== 'authorized' ||
      work.approved_by !== actorId ||
      !work.approval_request_id ||
      work.owner_user_id !== actorId ||
      Date.now() >= work.deadline_at
    )
      throw unavailable();
    const { group, member } = botGroupReadContext(actorId, work.group_id);
    if (
      member.role !== 'owner' ||
      group.state !== 'active' ||
      !provisioner ||
      process.env.MINICLAW_BOT_HANDOFFS !== 'true' ||
      process.env.MINICLAW_BOT_GROUPS !== 'true'
    )
      throw unavailable();
    const origin = db()
      .prepare(
        `SELECT t.*,r.root_message_id,r.status run_status,r.protocol_version,
      i.payload_digest native_input_digest,s.payload_digest native_source_digest,s.result_digest native_result_digest,
      s.answer_entry_id native_answer_entry_id,pr.answer_entry_id result_answer_entry_id
      FROM bot_group_discussion_turns t JOIN bot_group_discussions r ON r.id=t.run_id
      JOIN product_session_inputs i ON i.id=t.input_id AND i.session_id=t.session_id AND i.request_id=t.request_id AND i.state='completed'
      JOIN product_input_task_sources s ON s.input_id=i.id AND s.session_id=t.session_id
      JOIN product_input_results pr ON pr.input_id=i.id AND pr.session_id=t.session_id
      WHERE t.id=? AND t.run_id=? AND r.group_id=? AND r.owner_user_id=?`,
      )
      .get(work.originating_turn_id, work.run_id, work.group_id, actorId) as
      | {
          id: string;
          state: string;
          role: string;
          profile_id: string;
          result_message_id: string;
          input_id: string;
          session_id: string;
          decision: string;
          root_message_id: string;
          run_status: string;
          protocol_version: number;
          native_input_digest: string;
          native_source_digest: string;
          native_result_digest: string;
          native_answer_entry_id: number;
          result_answer_entry_id: number;
        }
      | undefined;
    const message = db()
      .prepare(
        "SELECT content,source FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind='bot'",
      )
      .get(work.source_message_id, work.group_id) as
      | { content: string; source: string }
      | undefined;
    const provenance = message && JSON.parse(message.source);
    if (
      !origin ||
      origin.state !== 'completed' ||
      origin.role !== 'speaker' ||
      origin.profile_id !== work.requester_profile_id ||
      origin.result_message_id !== work.source_message_id ||
      origin.run_status !== 'running' ||
      origin.protocol_version !== 2 ||
      origin.native_input_digest !== origin.native_source_digest ||
      origin.native_answer_entry_id !== origin.result_answer_entry_id ||
      provenance?.kind !== 'group_discussion_reply' ||
      provenance.turn_id !== origin.id ||
      provenance.input_id !== origin.input_id ||
      provenance.session_id !== origin.session_id ||
      provenance.result_digest !== origin.native_result_digest ||
      JSON.parse(origin.decision).action !== 'delegate' ||
      JSON.stringify(JSON.parse(origin.decision).work) !== work.request
    )
      throw new BotGroupError('GROUP_DISCUSSION_WORK_ORIGIN_MISMATCH');
    const target = db()
      .prepare(
        "SELECT id FROM bot_group_members WHERE group_id=? AND kind='bot' AND subject_id=? AND state='active'",
      )
      .get(work.group_id, work.target_profile_id) as { id: string } | undefined;
    if (!target) throw new BotGroupError('BOT_HANDOFF_TARGET_UNAVAILABLE');
    botGroupExecutionTarget(actorId, work.group_id, target.id);
    const grant = currentBotRuntimeGrant(target.id);
    if (
      !grant ||
      grant.id !== work.grant_id ||
      botRuntimeGrantDigest(grant) !== work.grant_digest ||
      grant.revoked_at ||
      Date.parse(grant.expires_at) <= Date.now()
    )
      throw unavailable();
    const request = JSON.parse(
      work.request,
    ) as import('./discussion-types.js').DiscussionWorkRequest;
    const root = db()
      .prepare(
        "SELECT id,content FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind='user'",
      )
      .get(origin.root_message_id, work.group_id) as
      | { id: string; content: string }
      | undefined;
    if (!root || !message) throw unavailable();
    let remaining = 8000;
    const materials = request.context_message_ids.map((id) => {
      const row = db()
        .prepare(
          "SELECT id,author_name,content FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind IN ('user','bot')",
        )
        .get(id, work.group_id) as
        | { id: string; author_name: string; content: string }
        | undefined;
      if (!row)
        throw new BotGroupError('GROUP_DISCUSSION_WORK_CONTEXT_MISMATCH');
      const content = row.content.slice(
        0,
        Math.max(0, Math.min(4000, remaining)),
      );
      remaining -= content.length;
      return {
        message_id: row.id,
        author: row.author_name,
        content,
        truncated: content.length < row.content.length,
      };
    });
    const context = {
      kind: 'bot_group_request',
      group_id: work.group_id,
      message_id: work.source_message_id,
      target_bot_id: work.target_profile_id,
      actor_user_id: actorId,
      content: request.instruction,
      discussion_origin: {
        work_id: work.id,
        run_id: work.run_id,
        originating_turn_id: work.originating_turn_id,
        requester_profile_id: work.requester_profile_id,
        proposal_digest: work.proposal_digest,
      },
      work_scope: {
        tool_capabilities: request.tool_capabilities,
        max_model_attempts: work.max_model_attempts,
        deadline_at: work.deadline_at,
      },
      shared_context: {
        root: {
          message_id: root.id,
          content: root.content.slice(0, 4000),
          truncated: root.content.length > 4000,
        },
        requester_public_message: message.content.slice(0, 4000),
        materials,
      },
    };
    const payload = JSON.stringify(context),
      previous = getBotHandoff(work.handoff_id);
    if (Buffer.byteLength(payload, 'utf8') > 32768)
      throw new BotGroupError('BOT_HANDOFF_CONTEXT_TOO_LARGE', 400);
    if (previous) {
      if (
        previous.group_id !== work.group_id ||
        previous.payload_digest !== handoffDigest(context)
      )
        throw unavailable();
      return previous;
    }
    if (listBotHandoffs(work.group_id).length >= 100)
      throw new BotGroupError('BOT_HANDOFF_GROUP_BUDGET_EXHAUSTED', 429);
    const stamp = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO bot_group_handoffs(id,group_id,owner_user_id,source_message_id,source_bot_id,target_bot_id,target_member_id,parent_handoff_id,depth,request_id,payload,payload_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,0,?,?,?,'waiting_for_authorization',?,?)",
      )
      .run(
        work.handoff_id,
        work.group_id,
        actorId,
        work.source_message_id,
        work.requester_profile_id,
        work.target_profile_id,
        target.id,
        `handoff:${work.handoff_id}`,
        payload,
        handoffDigest(context),
        stamp,
        stamp,
      );
    touchGroup(work.group_id);
    return bindBotHandoffSession(actorId, work.handoff_id, provisioner);
  })();
}

/** Runs in the product DB transaction. provision() reuses createAgent and the
 * existing Runtime Router; no Harness or model starts before this commits. */
export function bindBotHandoffSession(
  actorId: string,
  handoffId: string,
  provision: (input: {
    sessionId: string;
    handoff: BotHandoff;
    grant: BotRuntimeGrant;
  }) => void,
) {
  return db().transaction(() => {
    const row = getBotHandoff(handoffId);
    if (!row || row.owner_user_id !== actorId) throw unavailable();
    const { target } = botGroupExecutionTarget(
      actorId,
      row.group_id,
      row.target_member_id,
    );
    if (row.session_id) {
      assertBotHandoffAuthority(row.session_id);
      return row;
    }
    if (row.state !== 'waiting_for_authorization') throw unavailable();
    const grant = currentBotRuntimeGrant(target.id);
    if (
      !grant ||
      grant.member_revision !== target.revision ||
      grant.profile_id !== target.subject_id ||
      grant.workspace_jid !== target.scope_workspace_jid ||
      Date.parse(grant.expires_at) <= Date.now()
    )
      throw unavailable();
    const sessionId = randomUUID(),
      now = new Date().toISOString();
    db()
      .prepare(
        "UPDATE bot_group_handoffs SET grant_id=?,grant_digest=?,session_id=?,runtime_kind=?,state='pending',revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        grant.id,
        botRuntimeGrantDigest(grant),
        sessionId,
        grant.runtime_kind,
        now,
        row.id,
      );
    provision({ sessionId, handoff: getBotHandoff(row.id)!, grant });
    db()
      .prepare(
        'INSERT INTO bot_handoff_session_origins(session_id,handoff_id,created_at) VALUES(?,?,?)',
      )
      .run(sessionId, row.id, now);
    assertBotHandoffAuthority(sessionId, { execute: true });
    if (grant.runtime_kind === 'cloudflare-durable')
      db()
        .prepare(
          "INSERT INTO bot_handoff_associations(handoff_id,session_id,request_id,payload_digest,grant_digest,state) VALUES(?,?,?,?,?,'pending')",
        )
        .run(
          row.id,
          sessionId,
          row.request_id,
          row.payload_digest,
          botRuntimeGrantDigest(grant),
        );
    touchGroup(row.group_id);
    return getBotHandoff(row.id)!;
  })();
}
export function bindBotHandoffInput(
  id: string,
  input: {
    id: string;
    session_id: string;
    request_id: string;
    payload: string;
    submission_id: number | null;
  },
) {
  return db().transaction(() => {
    const row = getBotHandoff(id);
    if (
      !row ||
      row.session_id !== input.session_id ||
      row.request_id !== input.request_id
    )
      throw unavailable();
    const payload = JSON.parse(input.payload) as {
      content: string;
      sender: string;
    };
    if (
      payload.content !== row.payload ||
      payload.sender !== row.owner_user_id ||
      handoffDigest(JSON.parse(row.payload)) !== row.payload_digest
    )
      throw new BotGroupError('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
    // A late Cloud receipt is still validated, but cannot change the revision
    // while the original pause/cancel fence is being dispatched remotely.
    if (
      row.runtime_kind === 'cloudflare-durable' &&
      ['paused', 'cancelling'].includes(row.state)
    )
      return row;
    if (['cancelled', 'completed', 'failed', 'uncertain'].includes(row.state))
      return row;
    if (row.input_id === input.id && row.submission_id === input.submission_id)
      return row;
    db()
      .prepare(
        'UPDATE bot_group_handoffs SET input_id=?,submission_id=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(input.id, input.submission_id, new Date().toISOString(), id);
    touchGroup(row.group_id);
    return getBotHandoff(id)!;
  })();
}

export function assertBotHandoffSubmission(
  sessionId: string,
  requestId: string,
  payload: {
    content: string;
    sender: string;
    senderName: string;
    followUpBehavior: 'queue' | 'steer';
    origin?: unknown;
    execution?: unknown;
  },
) {
  assertGroupDiscussionSubmission(sessionId, requestId, payload);
  const row = assertBotHandoffAuthority(sessionId, { execute: true });
  if (!row) return;
  const source = JSON.parse(row.payload) as { actor_name: string };
  if (
    requestId !== row.request_id ||
    payload.content !== row.payload ||
    payload.sender !== row.owner_user_id ||
    payload.senderName !== source.actor_name ||
    payload.followUpBehavior !== 'queue' ||
    payload.origin != null ||
    payload.execution !== undefined
  )
    throw new BotGroupError('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
}

export function botHandoffApprovalScope(sessionId: string) {
  const row = assertBotHandoffAuthority(sessionId);
  if (!row) return undefined;
  const grant = db()
    .prepare('SELECT * FROM bot_group_runtime_grants WHERE id=?')
    .get(row.grant_id) as BotRuntimeGrant;
  return {
    handoff_id: row.id,
    grant_id: row.grant_id!,
    grant_digest: row.grant_digest!,
    deadline_at: effectiveDiscussionWorkScope(row, grant).deadlineAt,
  };
}
export function unresolvedBotHandoffs() {
  return db()
    .prepare(
      "SELECT * FROM bot_group_handoffs WHERE state NOT IN ('cancelled','completed','failed','uncertain') ORDER BY created_at,id",
    )
    .all() as BotHandoff[];
}
export function botHandoffGroupUpdate(groupId: string) {
  const group = db()
    .prepare('SELECT revision,last_seq FROM bot_groups WHERE id=?')
    .get(groupId) as { revision: number; last_seq: number } | undefined;
  if (!group) return undefined;
  const event = db()
    .prepare('SELECT id FROM bot_group_messages WHERE group_id=? AND seq=?')
    .get(groupId, group.last_seq) as { id: string } | undefined;
  if (!event) return undefined;
  return {
    group_id: groupId,
    revision: group.revision,
    seq: group.last_seq,
    message_id: event.id,
    operation: 'native_handoff_projection',
    request_id: event.id,
    replayed: false,
  };
}
const CloudProgressMetadataSchema = z
  .object({
    cloud_control_revision: z.number().int().nonnegative().optional(),
    cloud_receipt: z
      .object({
        revision: z.number().int().positive(),
        payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    cloud_runtime_state: z.string().max(64).optional(),
  })
  .passthrough();
function cloudProgressMetadata(row: BotHandoff) {
  const value = CloudProgressMetadataSchema.parse(
    JSON.parse(row.progress || '{}'),
  );
  return {
    ...(value.cloud_control_revision === undefined
      ? {}
      : { cloud_control_revision: value.cloud_control_revision }),
    ...(value.cloud_receipt ? { cloud_receipt: value.cloud_receipt } : {}),
    ...(value.cloud_runtime_state
      ? { cloud_runtime_state: value.cloud_runtime_state }
      : {}),
  };
}
/** Records the exact control fence before the asynchronous Cloud RPC. It is
 * observation metadata, never execution authority or a new Handoff revision. */
export function recordCloudHandoffControlFence(
  sessionId: string,
  revision: number,
) {
  const row = handoffForProductSession(sessionId);
  if (
    !row ||
    row.runtime_kind !== 'cloudflare-durable' ||
    row.revision !== revision
  )
    throw new BotGroupError('BOT_HANDOFF_CONTROL_FENCE_CHANGED');
  // Terminal business rows are deliberately immutable. They may still close
  // their registered Cloud owner, but observations cannot mutate their outcome.
  if (['cancelled', 'completed', 'failed', 'uncertain'].includes(row.state))
    return;
  const old = cloudProgressMetadata(row);
  if ((old.cloud_control_revision ?? 0) > revision)
    throw new BotGroupError('BOT_HANDOFF_CONTROL_FENCE_CHANGED');
  // Update only this key in the current JSON. A concurrent observation must
  // not lose its high-water receipt through a stale read/merge/write.
  const changed = db()
    .prepare(
      "UPDATE bot_group_handoffs SET progress=json_set(CASE WHEN progress='' THEN '{}' ELSE progress END,'$.cloud_control_revision',?) WHERE id=? AND revision=?",
    )
    .run(revision, row.id, revision);
  if (changed.changes !== 1)
    throw new BotGroupError('BOT_HANDOFF_CONTROL_FENCE_CHANGED');
}
export function acceptCloudHandoffProgress(
  id: string,
  value: import('./cloud-protocol.js').CloudHandoffProgress,
  payloadDigest: string,
  frame: Parameters<typeof publishBotHandoffProgress>[1] | null,
  authorize: () => void,
  input?: Parameters<typeof bindBotHandoffInput>[1],
) {
  return db().transaction(() => {
    authorize();
    const row = getBotHandoff(id);
    if (
      !row?.session_id ||
      row.runtime_kind !== 'cloudflare-durable' ||
      value.handoff.handoff_id !== row.id ||
      value.handoff.group_id !== row.group_id ||
      value.handoff.grant_digest !== row.grant_digest
    )
      throw unavailable();
    const old = cloudProgressMetadata(row),
      receipt = old.cloud_receipt;
    if (receipt && value.revision <= receipt.revision) {
      if (
        value.revision === receipt.revision &&
        payloadDigest !== receipt.payload_digest
      )
        throw new BotGroupError('BOT_HANDOFF_PROGRESS_CONFLICT');
      return receipt.revision;
    }
    if (['cancelled', 'completed', 'failed', 'uncertain'].includes(row.state))
      return Math.max(value.revision, receipt?.revision ?? 0);
    const control = old.cloud_control_revision ?? 0;
    if (value.control_revision > control)
      throw new BotGroupError('BOT_HANDOFF_CONTROL_FENCE_CHANGED');
    if (
      value.control_revision === control &&
      frame &&
      ![
        'paused',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
        'uncertain',
      ].includes(row.state)
    ) {
      if (input) bindBotHandoffInput(id, input);
      publishBotHandoffProgress(id, frame);
    }
    const current = getBotHandoff(id)!;
    const visibleRuntime =
      value.control_revision === control &&
      (!['paused', 'cancelling', 'cancelled'].includes(current.state) ||
        ['suspended', 'cancelled', 'blocked'].includes(
          value.frame.runtime_state,
        ));
    db()
      .prepare('UPDATE bot_group_handoffs SET progress=? WHERE id=?')
      .run(
        JSON.stringify({
          ...JSON.parse(current.progress || '{}'),
          ...(visibleRuntime
            ? { cloud_runtime_state: value.frame.runtime_state }
            : {}),
          cloud_receipt: {
            revision: value.revision,
            payload_digest: payloadDigest,
          },
        }),
        id,
      );
    if (
      visibleRuntime &&
      old.cloud_runtime_state !== value.frame.runtime_state &&
      current.revision === row.revision
    )
      touchGroup(row.group_id);
    return value.revision;
  })();
}
export function publishBotHandoffProgress(
  id: string,
  frame: {
    phase: 'running' | 'waiting_for_approval' | 'waiting_for_device';
    partial_text: string;
    run_task_id: number | null;
    queue_digest?: string | null;
    tools: { name: string; status: string }[];
  },
) {
  return db().transaction(() => {
    const row = getBotHandoff(id);
    if (
      !row ||
      !row.session_id ||
      [
        'paused',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
        'uncertain',
      ].includes(row.state)
    )
      return row;
    assertBotHandoffAuthority(row.session_id, { execute: true });
    const bounded = {
      ...frame,
      partial_text: frame.partial_text.slice(-4000),
      tools: frame.tools.slice(0, 20),
    };
    const digest = handoffDigest(bounded);
    if (row.progress_digest === digest && row.state === frame.phase) return row;
    if (row.state !== frame.phase)
      appendBotGroupSystemEvent(
        row.group_id,
        row.owner_user_id,
        frame.phase === 'waiting_for_approval'
          ? 'Bot 任务等待群主审批'
          : frame.phase === 'waiting_for_device'
            ? 'Bot 任务等待已授权设备'
            : 'Bot 任务开始执行',
        `bot_handoff_${frame.phase}`,
        [],
        {
          handoff_id: row.id,
          target_bot_id: row.target_bot_id,
          session_id: row.session_id,
          submission_id: row.submission_id,
          run_task_id: frame.run_task_id,
        },
      );
    db()
      .prepare(
        'UPDATE bot_group_handoffs SET state=?,progress=?,progress_digest=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(
        frame.phase,
        JSON.stringify({ ...bounded, ...cloudProgressMetadata(row) }),
        digest,
        new Date().toISOString(),
        id,
      );
    touchGroup(row.group_id);
    return getBotHandoff(id);
  })();
}
/** The caller supplies no answer, author or task identity: all are read from
 * the immutable product/native source ledger in this same SQLite transaction. */
export function publishBotHandoffResult(id: string) {
  return db().transaction(() => {
    let row = getBotHandoff(id);
    if (!row || !row.session_id) throw unavailable();
    if (
      ['paused', 'cancelling', 'cancelled', 'failed', 'uncertain'].includes(
        row.state,
      )
    )
      return undefined;
    assertBotHandoffAuthority(
      row.session_id,
      row.state === 'completed' ? {} : { execute: true },
    );
    const input = db()
      .prepare(
        'SELECT * FROM product_session_inputs WHERE session_id=? AND request_id=?',
      )
      .get(row.session_id, row.request_id) as
      | import('../personal-agent/product-runtime-store.js').ProductInput
      | undefined;
    if (!input || input.state !== 'completed' || input.submission_id === null)
      return undefined;
    const source = db()
      .prepare('SELECT * FROM product_input_task_sources WHERE input_id=?')
      .get(input.id) as
      | import('../personal-agent/product-runtime-store.js').ProductTaskSource
      | undefined;
    const result = db()
      .prepare('SELECT * FROM product_input_results WHERE input_id=?')
      .get(input.id) as
      | { session_id: string; answer_entry_id: number; message_id: string }
      | undefined;
    if (
      !source ||
      !result ||
      source.session_id !== row.session_id ||
      result.session_id !== row.session_id ||
      result.answer_entry_id !== source.answer_entry_id ||
      source.payload_digest !== input.payload_digest
    )
      throw new BotGroupError('BOT_HANDOFF_NATIVE_SOURCE_MISSING');
    const runtime = db()
      .prepare(
        'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
      )
      .get(row.session_id) as { workspace_jid: string };
    const text = db()
      .prepare(
        'SELECT content FROM messages WHERE id=? AND chat_jid=? AND is_from_me=1',
      )
      .get(
        result.message_id,
        `${runtime.workspace_jid}#agent:${row.session_id}`,
      ) as { content: string } | undefined;
    if (
      !text ||
      createHash('sha256').update(text.content).digest('hex') !==
        source.result_digest
    )
      throw new BotGroupError('BOT_HANDOFF_NATIVE_RESULT_CONFLICT');
    if (row.state === 'completed') {
      if (
        row.input_id !== input.id ||
        row.submission_id !== input.submission_id ||
        row.task_id !== source.task_id ||
        row.answer_entry_id !== source.answer_entry_id ||
        row.result_digest !== source.result_digest
      )
        throw new BotGroupError('BOT_HANDOFF_NATIVE_RESULT_CONFLICT');
      return row;
    }
    row = bindBotHandoffInput(id, input);
    const name = db()
      .prepare(
        'SELECT name,is_default FROM agent_profiles WHERE id=? AND owner_user_id=?',
      )
      .get(row.target_bot_id, row.owner_user_id) as {
      name: string;
      is_default: number;
    };
    const now = new Date().toISOString(),
      messageId = randomUUID();
    db()
      .prepare(
        'UPDATE bot_groups SET revision=revision+1,last_seq=last_seq+1,updated_at=? WHERE id=?',
      )
      .run(now, row.group_id);
    const group = db()
      .prepare('SELECT last_seq FROM bot_groups WHERE id=?')
      .get(row.group_id) as { last_seq: number };
    const provenance = {
      kind: 'native_handoff_result',
      handoff_id: row.id,
      profile_id: row.target_bot_id,
      session_id: row.session_id,
      runtime_kind: row.runtime_kind,
      request_id: row.request_id,
      input_id: input.id,
      submission_id: input.submission_id,
      task_id: source.task_id,
      task_role: 'answer_producer',
      answer_entry_id: source.answer_entry_id,
      payload_digest: row.payload_digest,
      grant_digest: row.grant_digest,
      result_digest: source.result_digest,
      truncated: text.content.length > 16000,
      empty_output: !text.content,
    };
    db()
      .prepare(
        "INSERT INTO bot_group_messages(id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at) VALUES(?,?,?,'system_event','bot',?,?,?,'[]',?,?)",
      )
      .run(
        messageId,
        row.group_id,
        group.last_seq,
        row.target_bot_id,
        name.name,
        text.content.slice(0, 16000) || 'Bot 已完成此次执行（无文本输出）',
        JSON.stringify(provenance),
        now,
      );
    db()
      .prepare(
        "UPDATE bot_group_handoffs SET state='completed',task_id=?,answer_entry_id=?,result_digest=?,result_message_id=?,delivery_next_at=0,delivery_error_code=NULL,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        source.task_id,
        source.answer_entry_id,
        source.result_digest,
        messageId,
        now,
        id,
      );
    return getBotHandoff(id)!;
  })();
}
export function transitionBotHandoff(
  actorId: string,
  id: string,
  next:
    | 'waiting_for_authorization'
    | 'paused'
    | 'pending'
    | 'cancelling'
    | 'cancelled'
    | 'failed'
    | 'uncertain',
  reason: string,
) {
  return db().transaction(() => {
    const row = getBotHandoff(id);
    if (!row || row.owner_user_id !== actorId) throw unavailable();
    const context = botGroupReadContext(actorId, row.group_id);
    if (context.member.role !== 'owner') throw unavailable();
    if (['cancelled', 'completed', 'failed', 'uncertain'].includes(row.state))
      return row;
    if (row.state === next) return row;
    if (next === 'pending' && row.state !== 'paused')
      throw new BotGroupError('BOT_HANDOFF_TRANSITION_CONFLICT');
    if (next === 'cancelled' && row.state !== 'cancelling')
      throw new BotGroupError('BOT_HANDOFF_TRANSITION_CONFLICT');
    db()
      .prepare(
        'UPDATE bot_group_handoffs SET state=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(next, new Date().toISOString(), id);
    if (
      ['cancelling', 'cancelled', 'failed', 'uncertain'].includes(next) &&
      row.session_id
    )
      db()
        .prepare(
          "UPDATE product_approvals SET state='denied',decided_at=?,resolution='handoff_stopped' WHERE session_id=? AND state='pending'",
        )
        .run(new Date().toISOString(), row.session_id);
    appendBotGroupSystemEvent(
      row.group_id,
      actorId,
      next === 'paused'
        ? 'Bot 任务已暂停'
        : next === 'pending'
          ? 'Bot 任务恢复已请求'
          : next === 'cancelling'
            ? '正在取消 Bot 任务'
            : next === 'cancelled'
              ? 'Bot 任务已取消'
              : next === 'failed'
                ? 'Bot 任务执行失败'
                : 'Bot 任务结果待核对',
      `bot_handoff_${next}`,
      [],
      {
        handoff_id: id,
        target_bot_id: row.target_bot_id,
        session_id: row.session_id,
        reason,
      },
    );
    return getBotHandoff(id)!;
  })();
}

export type BotHandoffProvisioner = Parameters<typeof bindBotHandoffSession>[2];
let provisioner: BotHandoffProvisioner | undefined;
export function configureBotHandoffProvisioner(
  value: BotHandoffProvisioner | undefined,
) {
  provisioner = value;
}
export function canonicalHandoffMentions(
  groupId: string,
  content: string,
  explicit: string[],
  maxTargets: 2 | 8 = 2,
) {
  const candidates = db()
    .prepare(
      "SELECT p.id,p.name,p.is_default FROM bot_group_members m JOIN bot_groups g ON g.id=m.group_id JOIN agent_profiles p ON p.id=m.subject_id AND p.owner_user_id=g.owner_user_id AND p.status='active' WHERE m.group_id=? AND m.kind='bot' AND m.state='active'",
    )
    .all(groupId) as { id: string; name: string; is_default: number }[];
  let rest = content.trimStart();
  const parsed: string[] = [];
  for (;;) {
    const match = /^@([\p{L}\p{N}_-]+)(?=$|[\s,，、:：])/u.exec(rest);
    if (!match) break;
    const matches = candidates.filter(
      (profile) =>
        (profile.is_default ? 'Chief' : profile.name).toLowerCase() ===
        match[1].toLowerCase(),
    );
    if (matches.length !== 1)
      throw new BotGroupError('BOT_HANDOFF_MENTION_UNKNOWN_OR_AMBIGUOUS', 400);
    parsed.push(matches[0].id);
    rest = rest.slice(match[0].length).replace(/^[\s,，、:：]+/u, '');
    if (!rest.startsWith('@')) break;
  }
  const unique = [...new Set(parsed)].sort(),
    selected = [...new Set(explicit)].sort();
  if (
    unique.length &&
    selected.length &&
    JSON.stringify(unique) !== JSON.stringify(selected)
  )
    throw new BotGroupError('BOT_HANDOFF_MENTION_CONFLICT', 400);
  const result = selected.length ? selected : unique;
  if (result.length > maxTargets)
    throw new BotGroupError('BOT_HANDOFF_FANOUT_LIMIT', 400);
  return result;
}

/** Restrictive repair only. Actual Runtime.blocked is required; current caller
 * read privileges are not needed to stop work after account/Workspace revocation. */
export function fenceBlockedBotHandoff(sessionId: string) {
  const origin = db()
    .prepare(
      'SELECT handoff_id FROM bot_handoff_session_origins WHERE session_id=?',
    )
    .get(sessionId) as { handoff_id: string } | undefined;
  if (!origin) return;
  const row = getBotHandoff(origin.handoff_id);
  if (
    !row ||
    ['cancelling', 'cancelled', 'completed', 'failed', 'uncertain'].includes(
      row.state,
    )
  )
    return;
  const runtime = db()
    .prepare('SELECT state FROM product_session_runtimes WHERE session_id=?')
    .get(sessionId) as { state: string } | undefined;
  if (runtime?.state !== 'blocked')
    throw new BotGroupError('BOT_HANDOFF_STOP_PROOF_MISSING');
  db().transaction(() => {
    const now = new Date().toISOString(),
      id = randomUUID();
    db().prepare("UPDATE agents SET status='error' WHERE id=?").run(sessionId);
    db()
      .prepare(
        "UPDATE bot_group_handoffs SET state='uncertain',revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(now, row.id);
    db()
      .prepare(
        "UPDATE product_approvals SET state='denied',decided_at=?,resolution='handoff_runtime_blocked' WHERE session_id=? AND state='pending'",
      )
      .run(now, sessionId);
    db()
      .prepare(
        'UPDATE bot_groups SET revision=revision+1,last_seq=last_seq+1,updated_at=? WHERE id=?',
      )
      .run(now, row.group_id);
    const group = db()
      .prepare('SELECT last_seq FROM bot_groups WHERE id=?')
      .get(row.group_id) as { last_seq: number };
    db()
      .prepare(
        "INSERT INTO bot_group_messages(id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at) VALUES(?,?,?,'system_event','system','miniclaw-runtime','MiniClaw','Bot 任务已停止，需要核对授权或检查点','[]',?,?)",
      )
      .run(
        id,
        row.group_id,
        group.last_seq,
        JSON.stringify({
          kind: 'native_handoff_fence',
          handoff_id: row.id,
          session_id: sessionId,
          reason: 'runtime_blocked',
        }),
        now,
      );
  })();
}

export function botHandoffToolCapabilities(
  sessionId: string,
): string[] | undefined {
  const origin = groupSessionOrigin(sessionId);
  if (origin) return JSON.parse(origin.tool_capabilities) as string[];
  const row = assertBotHandoffAuthority(sessionId);
  if (!row) return undefined;
  const grant = db()
    .prepare('SELECT * FROM bot_group_runtime_grants WHERE id=?')
    .get(row.grant_id) as BotRuntimeGrant;
  return effectiveDiscussionWorkScope(row, grant).toolCapabilities;
}

export const BotHandoffControlSchema = z
  .object({
    action: z.enum(['start', 'pause', 'resume', 'cancel']),
    expected_revision: z.number().int().positive(),
  })
  .strict();
export function prepareBotHandoffControl(
  actorId: string,
  id: string,
  requestId: string,
  raw: unknown,
  authorizeResume: (sessionId: string) => void,
) {
  const input = BotHandoffControlSchema.parse(raw),
    original = getBotHandoff(id);
  if (!original || original.owner_user_id !== actorId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  return mutateBotGroup(
    actorId,
    requestId,
    'bot_handoff_control',
    original.group_id,
    { handoff_id: id, ...input },
    () => {
      let row = getBotHandoff(id)!;
      const context = botGroupReadContext(actorId, row.group_id);
      if (context.member.role !== 'owner') throw unavailable();
      if (row.revision !== input.expected_revision)
        throw new BotGroupError('BOT_HANDOFF_REVISION_CONFLICT');
      if (['cancelled', 'completed', 'failed', 'uncertain'].includes(row.state))
        throw new BotGroupError('BOT_HANDOFF_ALREADY_SETTLED');
      if (input.action === 'start') {
        if (
          process.env.MINICLAW_BOT_GROUPS !== 'true' ||
          process.env.MINICLAW_BOT_HANDOFFS !== 'true' ||
          !provisioner ||
          row.session_id ||
          row.state !== 'waiting_for_authorization'
        )
          throw unavailable();
        row = bindBotHandoffSession(actorId, id, provisioner);
      } else if (input.action === 'resume') {
        if (row.state !== 'paused' || !row.session_id)
          throw new BotGroupError('BOT_HANDOFF_TRANSITION_CONFLICT');
        authorizeResume(row.session_id);
        db()
          .prepare(
            "UPDATE bot_group_handoffs SET state='pending',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(new Date().toISOString(), id);
        assertBotHandoffAuthority(row.session_id, { execute: true });
      } else {
        if (
          input.action === 'pause' &&
          (!row.session_id ||
            row.state === 'paused' ||
            row.state === 'cancelling')
        )
          throw new BotGroupError('BOT_HANDOFF_TRANSITION_CONFLICT');
        db()
          .prepare(
            'UPDATE bot_group_handoffs SET state=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .run(
            input.action === 'pause' ? 'paused' : 'cancelling',
            new Date().toISOString(),
            id,
          );
        if (input.action === 'cancel' && row.session_id)
          db()
            .prepare(
              "UPDATE product_approvals SET state='denied',decided_at=?,resolution='handoff_cancelled' WHERE session_id=? AND state='pending'",
            )
            .run(new Date().toISOString(), row.session_id);
      }
      return appendBotGroupSystemEvent(
        row.group_id,
        actorId,
        input.action === 'pause'
          ? 'Bot 暂停已请求'
          : input.action === 'resume'
            ? 'Bot 恢复已请求'
            : input.action === 'cancel'
              ? 'Bot 取消已请求'
              : 'Bot 执行已请求',
        'bot_handoff_control',
        [],
        {
          handoff_id: id,
          session_id: row.session_id,
          action: input.action,
          control_request_id: requestId,
        },
      );
    },
  );
}
/** Completes an already-authorized restrictive intent, even if the user left or
 * lost access while the stop was being joined. It cannot grant/resume execution. */
export function finishStoppedBotHandoffCancellation(id: string) {
  return db().transaction(() => {
    const row = getBotHandoff(id);
    if (!row || row.state !== 'cancelling') return row;
    if (
      row.session_id &&
      (
        db()
          .prepare(
            'SELECT state FROM product_session_runtimes WHERE session_id=?',
          )
          .get(row.session_id) as { state: string } | undefined
      )?.state !== 'blocked'
    )
      throw new BotGroupError('BOT_HANDOFF_STOP_PROOF_MISSING');
    const uncertain =
      !!row.session_id &&
      !!db()
        .prepare(
          "SELECT 1 FROM product_approvals WHERE session_id=? AND state IN ('executing','uncertain')",
        )
        .get(row.session_id);
    const now = new Date().toISOString(),
      messageId = randomUUID();
    db()
      .prepare(
        'UPDATE bot_group_handoffs SET state=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(uncertain ? 'uncertain' : 'cancelled', now, id);
    if (uncertain)
      db()
        .prepare(
          "UPDATE product_approvals SET state='uncertain',resolution='handoff_cancelled_unknown_effect' WHERE session_id=? AND state='executing'",
        )
        .run(row.session_id);
    db()
      .prepare(
        'UPDATE bot_groups SET revision=revision+1,last_seq=last_seq+1,updated_at=? WHERE id=?',
      )
      .run(now, row.group_id);
    const group = db()
      .prepare('SELECT last_seq FROM bot_groups WHERE id=?')
      .get(row.group_id) as { last_seq: number };
    db()
      .prepare(
        "INSERT INTO bot_group_messages(id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at) VALUES(?,?,?,'system_event','system','miniclaw-runtime','MiniClaw',?,'[]',?,?)",
      )
      .run(
        messageId,
        row.group_id,
        group.last_seq,
        uncertain ? 'Bot 已停止，外部操作结果需要核对' : 'Bot 任务已取消',
        JSON.stringify({
          kind: 'native_handoff_cancelled',
          handoff_id: id,
          session_id: row.session_id,
          uncertain_effect: uncertain,
        }),
        now,
      );
    return getBotHandoff(id)!;
  })();
}

/** Delivery retry is restricted to an already-completed, source-verified native
 * input. It never admits input, resumes a Harness or consumes a model step. */
export function retryBotHandoffProjection(id: string) {
  return db().transaction(() => {
    const row = getBotHandoff(id);
    if (
      !row ||
      !row.session_id ||
      ![
        'pending',
        'running',
        'waiting_for_approval',
        'waiting_for_device',
      ].includes(row.state)
    )
      return false;
    const completed = db()
      .prepare(
        "SELECT i.id FROM product_session_inputs i JOIN product_input_task_sources s ON s.input_id=i.id AND s.session_id=i.session_id AND s.payload_digest=i.payload_digest WHERE i.session_id=? AND i.request_id=? AND i.state='completed'",
      )
      .get(row.session_id, row.request_id);
    if (!completed) return false;
    const attempts = row.delivery_attempts + 1;
    if (attempts > 8) {
      transitionBotHandoff(
        row.owner_user_id,
        id,
        'uncertain',
        'result_delivery_budget_exhausted',
      );
      return false;
    }
    db()
      .prepare(
        "UPDATE bot_group_handoffs SET delivery_attempts=?,delivery_next_at=?,delivery_error_code='BOT_HANDOFF_PROJECTION_PENDING',revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        attempts,
        Date.now() + Math.min(5000, 250 * 2 ** (attempts - 1)),
        new Date().toISOString(),
        id,
      );
    touchGroup(row.group_id);
    return true;
  })();
}
export function dueBotHandoffProjections() {
  return db()
    .prepare(
      "SELECT h.id FROM bot_group_handoffs h JOIN product_session_inputs i ON i.session_id=h.session_id AND i.request_id=h.request_id WHERE h.delivery_next_at>0 AND h.delivery_next_at<=? AND h.state IN ('pending','running','waiting_for_approval','waiting_for_device') AND i.state='completed' ORDER BY h.delivery_next_at,h.id LIMIT 100",
    )
    .all(Date.now()) as { id: string }[];
}

export type BotHandoffAssociation = {
  handoff_id: string;
  session_id: string;
  request_id: string;
  payload_digest: string;
  grant_digest: string;
  state: 'pending' | 'associated' | 'blocked';
  attempts: number;
  next_at: number;
  lease_token: string | null;
  error_code: string | null;
};
export function getBotHandoffAssociation(id: string) {
  return db()
    .prepare('SELECT * FROM bot_handoff_associations WHERE handoff_id=?')
    .get(id) as BotHandoffAssociation | undefined;
}
export function getBotHandoffAssociationBySession(sessionId: string) {
  return db()
    .prepare('SELECT * FROM bot_handoff_associations WHERE session_id=?')
    .get(sessionId) as BotHandoffAssociation | undefined;
}
function botHandoffAssociationView(id: string) {
  const row = getBotHandoffAssociation(id);
  return row
    ? {
        state: row.state,
        attempts: row.attempts,
        retry_at: row.next_at,
        error_code: row.error_code,
      }
    : undefined;
}
/** A native admission receipt can commit while the submitter is still waiting
 * for status projection. Confirm it without waiting for the model or acquiring
 * another submission lease. This read never authorizes execution. */
export function readyBotHandoffAssociations() {
  return db()
    .prepare(
      `
    SELECT a.handoff_id AS id,h.group_id FROM bot_handoff_associations a
    JOIN bot_group_handoffs h ON h.id=a.handoff_id
    JOIN product_session_inputs i ON i.session_id=a.session_id AND i.request_id=a.request_id
    JOIN product_session_runtimes r ON r.session_id=i.session_id
    JOIN product_cloud_sessions c ON c.session_id=r.session_id
    WHERE a.state='pending' AND h.state IN ('pending','running','waiting_for_approval','waiting_for_device')
      AND i.submission_id>0 AND i.state!='admitted'
      AND r.conversation_id IS NOT NULL AND c.object_id IS NOT NULL
    ORDER BY a.handoff_id LIMIT 100
  `,
    )
    .all() as { id: string; group_id: string }[];
}
export function dueBotHandoffAssociations() {
  return db()
    .prepare(
      `SELECT a.handoff_id AS id FROM bot_handoff_associations a
    JOIN bot_group_handoffs h ON h.id=a.handoff_id
    WHERE a.state='pending' AND a.next_at<=? AND h.state IN ('pending','running','waiting_for_approval','waiting_for_device')
    ORDER BY a.next_at,a.handoff_id LIMIT 100`,
    )
    .all(Date.now()) as { id: string }[];
}
/** Charge before any cross-store request. A crash consumes that attempt and its
 * lease; concurrent kicks/restarts cannot reset the original retry allowance. */
export function claimBotHandoffAssociation(id: string, authorize: () => void) {
  return db().transaction(() => {
    const association = getBotHandoffAssociation(id),
      row = getBotHandoff(id);
    if (
      !association ||
      !row ||
      association.state !== 'pending' ||
      association.next_at > Date.now() ||
      ![
        'pending',
        'running',
        'waiting_for_approval',
        'waiting_for_device',
      ].includes(row.state)
    )
      return null;
    try {
      authorize();
      assertBotHandoffAuthority(association.session_id, { execute: true });
    } catch {
      db()
        .prepare(
          "UPDATE bot_handoff_associations SET state='blocked',next_at=0,lease_token=NULL,error_code='BOT_HANDOFF_ASSOCIATION_AUTHORITY_UNAVAILABLE' WHERE handoff_id=?",
        )
        .run(id);
      touchGroup(row.group_id);
      return null;
    }
    if (association.attempts >= 8) {
      db()
        .prepare(
          "UPDATE bot_handoff_associations SET state='blocked',next_at=0,lease_token=NULL,error_code='BOT_HANDOFF_ASSOCIATION_EXHAUSTED' WHERE handoff_id=?",
        )
        .run(id);
      touchGroup(row.group_id);
      return null;
    }
    const token = randomUUID();
    db()
      .prepare(
        'UPDATE bot_handoff_associations SET attempts=attempts+1,lease_token=?,next_at=?,error_code=NULL WHERE handoff_id=?',
      )
      .run(token, Date.now() + 120000, id);
    touchGroup(row.group_id);
    return getBotHandoffAssociation(id)!;
  })();
}
export function retryBotHandoffAssociation(id: string, token: string) {
  return db().transaction(() => {
    const row = getBotHandoffAssociation(id);
    if (!row || row.state !== 'pending' || row.lease_token !== token) return;
    db()
      .prepare(
        'UPDATE bot_handoff_associations SET state=?,next_at=?,lease_token=NULL,error_code=? WHERE handoff_id=? AND lease_token=?',
      )
      .run(
        row.attempts >= 8 ? 'blocked' : 'pending',
        row.attempts >= 8
          ? 0
          : Date.now() + Math.min(60000, 1000 * 2 ** (row.attempts - 1)),
        row.attempts >= 8
          ? 'BOT_HANDOFF_ASSOCIATION_EXHAUSTED'
          : 'BOT_HANDOFF_ASSOCIATION_PENDING',
        id,
        token,
      );
    const handoff = getBotHandoff(id);
    if (handoff) touchGroup(handoff.group_id);
  })();
}
/** Only committed product/native receipts can settle admission uncertainty.
 * This is storage reconciliation, not authority to resume or finish execution. */
export function confirmBotHandoffAssociation(id: string) {
  return db().transaction(() => {
    const association = getBotHandoffAssociation(id),
      row = getBotHandoff(id);
    if (!association || !row) return false;
    const input = db()
      .prepare(
        `SELECT i.* FROM product_session_inputs i
      JOIN product_session_runtimes r ON r.session_id=i.session_id
      JOIN product_cloud_sessions c ON c.session_id=r.session_id
      WHERE i.session_id=? AND i.request_id=? AND i.submission_id>0 AND i.state!='admitted'
        AND r.conversation_id IS NOT NULL AND c.object_id IS NOT NULL`,
      )
      .get(association.session_id, association.request_id) as
      | Parameters<typeof bindBotHandoffInput>[1]
      | undefined;
    if (!input) return false;
    bindBotHandoffInput(id, input);
    if (association.state === 'associated') return true;
    db()
      .prepare(
        "UPDATE bot_handoff_associations SET state='associated',next_at=0,lease_token=NULL,error_code=NULL WHERE handoff_id=?",
      )
      .run(id);
    touchGroup(row.group_id);
    return true;
  })();
}

export function delegateBotHandoff(
  actorId: string,
  parentId: string,
  requestId: string,
  raw: unknown,
) {
  const input = z
    .object({
      content: z.string().trim().min(1).max(16000),
      target_bot_ids: z
        .array(z.uuid())
        .min(1)
        .max(2)
        .transform((ids) => [...new Set(ids)].sort()),
      expected_revision: z.number().int().positive(),
    })
    .strict()
    .parse(raw);
  const parent = getBotHandoff(parentId);
  if (!parent || parent.owner_user_id !== actorId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  return mutateBotGroup(
    actorId,
    requestId,
    'bot_handoff_delegation',
    parent.group_id,
    { parent_handoff_id: parentId, ...input },
    () => {
      if (
        process.env.MINICLAW_BOT_HANDOFFS !== 'true' ||
        process.env.MINICLAW_BOT_GROUPS !== 'true'
      )
        throw unavailable();
      const context = botGroupReadContext(actorId, parent.group_id);
      if (
        context.member.role !== 'owner' ||
        context.group.state !== 'active' ||
        parent.revision !== input.expected_revision ||
        input.target_bot_ids.includes(parent.target_bot_id)
      )
        throw unavailable();
      if (context.group.message_count >= 10000)
        throw new BotGroupError('BOT_GROUP_MESSAGE_LIMIT', 429);
      for (const profile of input.target_bot_ids) {
        const target = db()
          .prepare(
            "SELECT id FROM bot_group_members WHERE group_id=? AND kind='bot' AND subject_id=? AND state='active'",
          )
          .get(parent.group_id, profile) as { id: string } | undefined;
        if (!target) throw unavailable();
        botGroupExecutionTarget(actorId, parent.group_id, target.id);
      }
      const receipt = appendBotGroupSystemEvent(
        parent.group_id,
        actorId,
        input.content,
        null,
        input.target_bot_ids,
        { parent_handoff_id: parentId },
      );
      admitGroupMessageHandoffs(
        actorId,
        parent.group_id,
        receipt.message_id,
        parentId,
      );
      return receipt;
    },
  );
}
