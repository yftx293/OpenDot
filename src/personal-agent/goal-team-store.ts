import { DevicePathSchema, DeviceManifestSchema } from './device-protocol.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GroupDatabase } from '../bot-groups/protocol.js';
import { BotGroupError } from '../bot-groups/protocol.js';
import {
  botGroupExecutionTarget,
  botGroupReadContext,
  postBotGroupMessage,
  appendBotGroupSystemEvent,
  mutateBotGroup,
  listBotGroups,
  getBotGroupSnapshot,
} from '../bot-groups/store.js';
import {
  admitGroupMessageHandoffs,
  currentBotRuntimeGrant,
  getBotHandoff,
  assertBotHandoffAuthority,
  handoffDigest,
} from '../bot-groups/handoff-store.js';
import type { PersonalGoal } from './goal-store.js';
import type { ClaimedTaskRun } from '../types.js';

export const GoalTeamSchema = z
  .object({
    group_id: z.uuid(),
    device_resources: z
      .array(z.object({ node_id: z.uuid(), path: DevicePathSchema }).strict())
      .max(1)
      .optional(),
    bot_member_ids: z
      .array(z.uuid())
      .min(1)
      .max(2)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type GoalTeam = z.infer<typeof GoalTeamSchema> & {
  chief_profile_id: string;
};
type TeamRow = {
  goal_id: string;
  group_id: string;
  chief_profile_id: string;
  bot_member_ids: string;
  device_resources: string;
};
export type GoalTeamStep = {
  run_id: string;
  goal_id: string;
  handoff_id: string;
  source_message_id: string;
  selected_member_id: string;
  contract: string;
  contract_digest: string;
};
let connection: GroupDatabase | null = null;
const db = () => {
  if (!connection) throw new Error('Goal Team storage unavailable');
  return connection;
};
export function bindGoalTeamDatabase(value: GroupDatabase | null) {
  connection = value;
}
export function createGoalTeamSchema(value: GroupDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS personal_goal_teams (
      goal_id TEXT PRIMARY KEY REFERENCES personal_goals(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL, chief_profile_id TEXT NOT NULL,
      bot_member_ids TEXT NOT NULL CHECK(json_valid(bot_member_ids)), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_goal_team_steps (
      run_id TEXT PRIMARY KEY REFERENCES goal_execution_contexts(run_id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL REFERENCES personal_goal_teams(goal_id) ON DELETE CASCADE,
      handoff_id TEXT NOT NULL UNIQUE, source_message_id TEXT NOT NULL UNIQUE,
      selected_member_id TEXT NOT NULL, contract TEXT NOT NULL CHECK(json_valid(contract)),
      contract_digest TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS personal_goal_team_identity_immutable BEFORE UPDATE ON personal_goal_teams
      BEGIN SELECT RAISE(ABORT,'Goal Team binding is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS personal_goal_team_no_adoption BEFORE INSERT ON personal_goal_teams
      WHEN NOT EXISTS(SELECT 1 FROM personal_goals g WHERE g.id=NEW.goal_id AND g.status='pending' AND g.session_id IS NULL AND g.budget_used_runs=0
        AND NOT EXISTS(SELECT 1 FROM personal_goal_tasks t WHERE t.goal_id=g.id))
      BEGIN SELECT RAISE(ABORT,'Goal Team requires a new unstarted Goal'); END;
    CREATE TRIGGER IF NOT EXISTS personal_goal_team_origin_retained BEFORE DELETE ON personal_goal_teams
      WHEN EXISTS(SELECT 1 FROM personal_goals g WHERE g.id=OLD.goal_id)
      BEGIN SELECT RAISE(ABORT,'Goal Team origin must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS personal_goal_team_step_immutable BEFORE UPDATE ON personal_goal_team_steps
      BEGIN SELECT RAISE(ABORT,'Goal Team step is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS personal_goal_team_step_retained BEFORE DELETE ON personal_goal_team_steps
      WHEN EXISTS(SELECT 1 FROM goal_execution_contexts c WHERE c.run_id=OLD.run_id)
      BEGIN SELECT RAISE(ABORT,'Goal Team step must be retained'); END;
  `);
  const columns = value
    .prepare('PRAGMA table_info(personal_goal_teams)')
    .all() as { name: string }[];
  if (!columns.some((column) => column.name === 'device_resources'))
    value.exec(
      "ALTER TABLE personal_goal_teams ADD COLUMN device_resources TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(device_resources))",
    );
}
export function goalTeam(goalId: string): GoalTeam | undefined {
  const row = db()
    .prepare('SELECT * FROM personal_goal_teams WHERE goal_id=?')
    .get(goalId) as TeamRow | undefined;
  return (
    row && {
      group_id: row.group_id,
      chief_profile_id: row.chief_profile_id,
      bot_member_ids: JSON.parse(row.bot_member_ids) as string[],
      ...(JSON.parse(row.device_resources).length
        ? {
            device_resources: JSON.parse(row.device_resources) as {
              node_id: string;
              path: string;
            }[],
          }
        : {}),
    }
  );
}
/** Product choices are observations, never grants. Creation and each later
 * model/tool call still repeat the existing live admission/authority checks. */
export function goalTeamChoices(ownerId: string) {
  if (
    process.env.MINICLAW_GOAL_TEAMS !== 'true' ||
    process.env.MINICLAW_BOT_GROUPS !== 'true' ||
    process.env.MINICLAW_BOT_HANDOFFS !== 'true'
  )
    return [];
  return listBotGroups(ownerId)
    .filter(
      (group) => group.owner_user_id === ownerId && group.state === 'active',
    )
    .slice(0, 100)
    .flatMap((group) => {
      try {
        const context = chief(ownerId, group.id),
          snapshot = getBotGroupSnapshot(ownerId, group.id);
        const bots = snapshot.members
          .filter(
            (member) =>
              member.kind === 'bot' &&
              member.available &&
              member.scope_configured &&
              member.can_execute,
          )
          .map((member) => ({
            member_id: member.id,
            profile_id: member.subject_id,
            name: member.display_name,
            capabilities: JSON.parse(
              currentBotRuntimeGrant(member.id)!.tool_capabilities,
            ) as string[],
          }));
        return bots.length
          ? [
              {
                group_id: group.id,
                name: group.name,
                workspace_jid: group.workspace_jid,
                chief_profile_id: context.profileId,
                bots,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
}
function chief(ownerId: string, groupId: string, expected?: string) {
  const { group, member } = botGroupReadContext(ownerId, groupId);
  if (
    group.state !== 'active' ||
    group.owner_user_id !== ownerId ||
    member.role !== 'owner'
  )
    throw new BotGroupError('GOAL_TEAM_UNAVAILABLE');
  if (
    !db()
      .prepare(
        "SELECT 1 FROM registered_groups WHERE jid=? AND created_by=? AND execution_mode='host'",
      )
      .get(group.workspace_jid, ownerId)
  )
    throw new BotGroupError('GOAL_TEAM_WORKSPACE_UNAVAILABLE');
  const profile = db()
    .prepare(
      "SELECT p.id FROM agent_profiles p JOIN bot_group_members m ON m.subject_id=p.id AND m.group_id=? AND m.kind='bot' AND m.state='active' WHERE p.owner_user_id=? AND p.is_default=1 AND p.status='active'",
    )
    .get(groupId, ownerId) as { id: string } | undefined;
  if (!profile || (expected && expected !== profile.id))
    throw new BotGroupError('GOAL_TEAM_CHIEF_UNAVAILABLE');
  return { group, profileId: profile.id };
}
export function bindGoalTeam(
  goal: PersonalGoal,
  raw: z.infer<typeof GoalTeamSchema>,
) {
  if (
    process.env.MINICLAW_GOAL_TEAMS !== 'true' ||
    process.env.MINICLAW_BOT_GROUPS !== 'true' ||
    process.env.MINICLAW_BOT_HANDOFFS !== 'true'
  )
    throw new BotGroupError('GOAL_TEAM_ADMISSION_DISABLED');
  const input = GoalTeamSchema.parse(raw),
    context = chief(goal.owner_user_id, input.group_id);
  if (
    goal.session_id ||
    goal.budget_used_runs ||
    context.group.workspace_jid !== goal.workspace_jid
  )
    throw new BotGroupError('GOAL_TEAM_UNAVAILABLE');
  validateGoalTeamDefinition(goal);
  let deviceCapable = false;
  for (const id of input.bot_member_ids) {
    const { target } = botGroupExecutionTarget(
      goal.owner_user_id,
      input.group_id,
      id,
    );
    const grant = currentBotRuntimeGrant(id);
    if (
      !grant ||
      grant.revoked_at ||
      Date.parse(grant.expires_at) <= Date.now() ||
      grant.member_revision !== target.revision ||
      grant.profile_id !== target.subject_id ||
      grant.workspace_jid !== target.scope_workspace_jid
    )
      throw new BotGroupError('GOAL_TEAM_REVIEWED_GRANT_REQUIRED');
    deviceCapable ||=
      grant.runtime_kind === 'cloudflare-durable' &&
      JSON.parse(grant.tool_capabilities).includes('read_device_file');
  }
  for (const resource of input.device_resources ?? []) {
    const node = db()
      .prepare(
        "SELECT manifest FROM personal_devices WHERE id=? AND owner_id=? AND state='active'",
      )
      .get(resource.node_id, goal.owner_user_id) as
      | { manifest: string }
      | undefined;
    if (
      !deviceCapable ||
      !node ||
      !DeviceManifestSchema.parse(JSON.parse(node.manifest)).paths.includes(
        resource.path,
      )
    )
      throw new BotGroupError('GOAL_TEAM_DEVICE_UNAVAILABLE');
  }
  db()
    .prepare(
      'INSERT INTO personal_goal_teams(goal_id,group_id,chief_profile_id,bot_member_ids,created_at,device_resources) VALUES(?,?,?,?,?,?)',
    )
    .run(
      goal.id,
      input.group_id,
      context.profileId,
      JSON.stringify(input.bot_member_ids),
      new Date().toISOString(),
      JSON.stringify(input.device_resources ?? []),
    );
}
export function validateGoalTeamDefinition(goal: PersonalGoal) {
  if (
    goal.budget_max_runs > 100 ||
    JSON.stringify({
      objective: goal.objective,
      completion_criteria: goal.completion_criteria,
      next_action: goal.next_action,
    }).length > 8000
  )
    throw new BotGroupError('GOAL_TEAM_CONTEXT_LIMIT', 400);
}
export function goalTeamSourceAllowed(goalId: string) {
  const team = goalTeam(goalId);
  if (!team) return true;
  try {
    const goal = db()
      .prepare(
        'SELECT owner_user_id,workspace_jid FROM personal_goals WHERE id=?',
      )
      .get(goalId) as
      | { owner_user_id: string; workspace_jid: string }
      | undefined;
    if (!goal) return false;
    const context = chief(
      goal.owner_user_id,
      team.group_id,
      team.chief_profile_id,
    );
    return (
      context.group.workspace_jid === goal.workspace_jid &&
      team.bot_member_ids.every((id) => {
        const { target } = botGroupExecutionTarget(
          goal.owner_user_id,
          team.group_id,
          id,
        );
        return !!db()
          .prepare(
            "SELECT 1 FROM registered_groups WHERE jid=? AND created_by=? AND execution_mode='host'",
          )
          .get(target.scope_workspace_jid, goal.owner_user_id);
      })
    );
  } catch {
    return false;
  }
}
export function goalTeamForSession(sessionId: string) {
  return db()
    .prepare(
      'SELECT t.goal_id FROM personal_goal_teams t JOIN personal_goals g ON g.id=t.goal_id WHERE g.session_id=?',
    )
    .get(sessionId) as { goal_id: string } | undefined;
}
export function goalTeamStep(runId: string) {
  return db()
    .prepare('SELECT * FROM personal_goal_team_steps WHERE run_id=?')
    .get(runId) as GoalTeamStep | undefined;
}
/** Current lease/Goal authority is checked at every model/tool boundary. No
 * executor owns both the coordinator Session and a Bot Session. */
export function assertGoalTeamHandoff(handoffId: string, goalId: string) {
  const step = db()
    .prepare(
      `SELECT s.run_id FROM personal_goal_team_steps s
    JOIN goal_execution_contexts c ON c.run_id=s.run_id AND c.goal_id=s.goal_id
    JOIN task_runs r ON r.id=c.run_id AND r.task_id=c.task_id
    JOIN personal_goals g ON g.id=c.goal_id AND g.session_id=c.session_id AND g.owner_user_id=c.owner_user_id
    JOIN personal_goal_tasks gt ON gt.goal_id=g.id AND gt.task_id=c.task_id AND gt.automatic=1
    JOIN scheduled_tasks d ON d.id=c.task_id AND d.created_by=c.owner_user_id AND d.deleted_at IS NULL AND d.execution_type='agent' AND d.execution_mode='host' AND d.context_mode='isolated'
    JOIN registered_groups w ON w.jid=g.workspace_jid AND w.created_by=c.owner_user_id AND w.folder=d.group_folder AND w.jid=d.chat_jid
    JOIN product_session_runtimes p ON p.session_id=c.session_id AND p.goal_id=g.id AND p.owner_user_id=c.owner_user_id AND p.workspace_jid=g.workspace_jid AND p.runtime_kind='pi-durable' AND p.state!='blocked'
    WHERE s.handoff_id=? AND s.goal_id=? AND r.status='running' AND r.started_at IS NOT NULL AND r.lease_expires_at>?
      AND g.status IN ('running','waiting_for_approval','waiting_for_device')`,
    )
    .get(handoffId, goalId, new Date().toISOString());
  if (!step || !goalTeamSourceAllowed(goalId))
    throw new BotGroupError('GOAL_TEAM_EXECUTION_SUSPENDED');
}
export function teamHandoffsForSession(
  sessionId: string,
  claim?: Pick<ClaimedTaskRun, 'id' | 'lease_owner' | 'lease_token'>,
) {
  return (
    db()
      .prepare(
        `SELECT s.handoff_id,r.id,r.lease_owner,r.lease_token FROM personal_goal_team_steps s
    JOIN personal_goals g ON g.id=s.goal_id JOIN task_runs r ON r.id=s.run_id WHERE g.session_id=?`,
      )
      .all(sessionId) as {
      handoff_id: string;
      id: string;
      lease_owner: string;
      lease_token: number;
    }[]
  )
    .filter(
      (row) =>
        !claim ||
        (row.id === claim.id &&
          row.lease_owner === claim.lease_owner &&
          row.lease_token === claim.lease_token),
    )
    .map((row) => getBotHandoff(row.handoff_id))
    .filter(
      (row) =>
        !!row &&
        !['completed', 'failed', 'cancelled', 'uncertain'].includes(row.state),
    );
}
export function listGoalTeamSteps(goalId: string) {
  return db()
    .prepare(
      'SELECT * FROM personal_goal_team_steps WHERE goal_id=? ORDER BY rowid',
    )
    .all(goalId) as GoalTeamStep[];
}
export function goalTeamStepViews(goalId: string) {
  return listGoalTeamSteps(goalId).map((step) => {
    const evaluated = db()
      .prepare(
        'SELECT outcome,evidence FROM goal_execution_contexts WHERE run_id=? AND evaluated_at IS NOT NULL',
      )
      .get(step.run_id) as { outcome: string; evidence: string } | undefined;
    return {
      ...step,
      result: evaluated
        ? {
            status:
              evaluated.outcome === 'pending' ? 'continue' : evaluated.outcome,
            summary:
              getBotHandoff(step.handoff_id)?.state === 'completed'
                ? verifiedGoalTeamResult(step.handoff_id).slice(0, 4000)
                : 'Execution requires review.',
            evidence_refs: JSON.parse(evaluated.evidence) as {
              artifact_id: string;
              content_digest: string;
              criteria_matches: boolean[];
            }[],
            suggested_next_action:
              evaluated.outcome === 'pending'
                ? 'Advance the next reviewed Bot step.'
                : evaluated.outcome === 'waiting_for_input'
                  ? 'Review the verified evidence and completion criteria.'
                  : '',
          }
        : null,
    };
  });
}
export function verifiedGoalTeamResult(handoffId: string) {
  const row = getBotHandoff(handoffId);
  if (
    !row ||
    row.state !== 'completed' ||
    !row.result_message_id ||
    !row.result_digest
  )
    throw new BotGroupError('GOAL_TEAM_RESULT_UNVERIFIED');
  const message = db()
    .prepare(
      "SELECT content,source FROM bot_group_messages WHERE id=? AND group_id=? AND author_kind='bot' AND author_id=?",
    )
    .get(row.result_message_id, row.group_id, row.target_bot_id) as
    | { content: string; source: string }
    | undefined;
  const source =
    message &&
    (JSON.parse(message.source) as {
      handoff_id?: string;
      result_digest?: string;
    });
  if (
    !message ||
    source?.handoff_id !== row.id ||
    source.result_digest !== row.result_digest
  )
    throw new BotGroupError('GOAL_TEAM_RESULT_UNVERIFIED');
  return message.content;
}
export function projectGoalTeamOutcome(
  ownerId: string,
  goalId: string,
  runId: string,
  status: string,
  evidence: unknown[],
) {
  const team = goalTeam(goalId);
  if (!team) return;
  const payload = {
    goal_id: goalId,
    run_id: runId,
    status,
    evidence,
    chief_profile_id: team.chief_profile_id,
  };
  return mutateBotGroup(
    ownerId,
    `goal-outcome:${runId}`,
    'goal_team_evaluated',
    team.group_id,
    payload,
    () =>
      appendBotGroupSystemEvent(
        team.group_id,
        ownerId,
        status === 'completed'
          ? `Chief：目标完成条件已核验，已保存 ${evidence.length} 份成果回执。`
          : status === 'pending'
            ? 'Chief：当前步骤已核验，将在授权预算内继续。'
            : status === 'waiting_for_input'
              ? 'Chief：成果已保存，需要你核对完成条件。'
              : 'Chief：执行已停止，需要核对任务与权限。',
        'goal_team_evaluated',
        [],
        payload,
      ),
  );
}
/** One existing Scheduler occurrence maps atomically to one existing Handoff.
 * The caller has already charged that occurrence. A retry returns its identity. */
export function admitGoalTeamStep(claim: ClaimedTaskRun) {
  return db().transaction(() => {
    const snapshot = claim.definition_snapshot.personal_goal!;
    const team = goalTeam(snapshot.goal_id);
    const current = db()
      .prepare(
        "SELECT 1 FROM goal_execution_contexts c JOIN task_runs r ON r.id=c.run_id JOIN personal_goals g ON g.id=c.goal_id WHERE c.run_id=? AND c.snapshot=? AND r.status='running' AND r.started_at IS NOT NULL AND r.lease_owner=? AND r.lease_token=? AND r.lease_expires_at>? AND g.status IN ('running','waiting_for_approval','waiting_for_device')",
      )
      .get(
        claim.id,
        JSON.stringify(snapshot),
        claim.lease_owner,
        claim.lease_token,
        new Date().toISOString(),
      );
    if (!team || !current || !goalTeamSourceAllowed(snapshot.goal_id))
      throw new BotGroupError('GOAL_TEAM_EXECUTION_SUSPENDED');
    const previous = goalTeamStep(claim.id);
    if (previous) return previous;
    const ordinal = listGoalTeamSteps(snapshot.goal_id).length;
    const ordered = [
      ...team.bot_member_ids.slice(ordinal % team.bot_member_ids.length),
      ...team.bot_member_ids.slice(0, ordinal % team.bot_member_ids.length),
    ];
    const selected = ordered
      .map((id) => ({
        target: botGroupExecutionTarget(
          snapshot.owner_user_id,
          team.group_id,
          id,
        ).target,
        grant: currentBotRuntimeGrant(id),
      }))
      .find(
        ({ target, grant }) =>
          grant &&
          !grant.revoked_at &&
          Date.parse(grant.expires_at) > Date.now() &&
          grant.member_revision === target.revision &&
          grant.profile_id === target.subject_id &&
          grant.workspace_jid === target.scope_workspace_jid &&
          !db()
            .prepare(
              "SELECT 1 FROM bot_group_handoffs WHERE target_member_id=? AND state NOT IN ('completed','failed','cancelled','uncertain')",
            )
            .get(target.id),
      );
    if (!selected?.grant) throw new BotGroupError('GOAL_TEAM_NO_AVAILABLE_BOT');
    const handoffId = randomUUID();
    const contract = {
      kind: 'goal_team_step',
      ...(team.device_resources?.length
        ? { device_resources: team.device_resources }
        : {}),
      goal: {
        ...snapshot,
        previous_results: snapshot.previous_results.map((previous) => ({
          ...previous,
          result: previous.result?.slice(0, 2000) ?? null,
        })),
        previous_result_excerpt_limit: 2000,
      },
      run_id: claim.id,
      group_id: team.group_id,
      chief_profile_id: team.chief_profile_id,
      selected_bot_id: selected.target.subject_id,
      selected_member_id: selected.target.id,
      handoff_id: handoffId,
      grant_id: selected.grant.id,
      deadline_at: Date.parse(selected.grant.expires_at),
      allowed_tools: JSON.parse(selected.grant.tool_capabilities) as string[],
      previous_verified_evidence: db()
        .prepare(
          'SELECT run_id,evidence FROM goal_execution_contexts WHERE goal_id=? AND evaluated_at IS NOT NULL ORDER BY rowid DESC LIMIT 3',
        )
        .all(snapshot.goal_id),
      instructions:
        'Produce a result and evidence using only the reviewed tools. Completion, continuation and waiting states are determined by the server, never by claims or @mentions in model output.',
    };
    const content = JSON.stringify(contract);
    if (content.length > 15000)
      throw new BotGroupError('GOAL_TEAM_CONTEXT_TOO_LARGE', 400);
    const message = postBotGroupMessage(
      snapshot.owner_user_id,
      team.group_id,
      `goal-step:${claim.id}`,
      { content, mentions: [selected.target.subject_id], dispatch: false },
    );
    db()
      .prepare(
        'INSERT INTO personal_goal_team_steps(run_id,goal_id,handoff_id,source_message_id,selected_member_id,contract,contract_digest,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        claim.id,
        snapshot.goal_id,
        handoffId,
        message.message_id,
        selected.target.id,
        content,
        handoffDigest(contract),
        new Date().toISOString(),
      );
    admitGroupMessageHandoffs(
      snapshot.owner_user_id,
      team.group_id,
      message.message_id,
      undefined,
      {
        goal_id: snapshot.goal_id,
        run_id: claim.id,
        handoff_id: handoffId,
        chief_profile_id: team.chief_profile_id,
      },
    );
    appendBotGroupSystemEvent(
      team.group_id,
      snapshot.owner_user_id,
      'Chief 已为目标选择获授权的 Bot，开始当前步骤。',
      'goal_team_delegation',
      [],
      {
        goal_id: snapshot.goal_id,
        run_id: claim.id,
        handoff_id: handoffId,
        selected_bot_id: selected.target.subject_id,
        chief_profile_id: team.chief_profile_id,
      },
    );
    const handoff = getBotHandoff(handoffId);
    if (!handoff?.session_id)
      throw new BotGroupError('GOAL_TEAM_RUNTIME_UNAVAILABLE');
    assertBotHandoffAuthority(handoff.session_id, { execute: true });
    return goalTeamStep(claim.id)!;
  })();
}
