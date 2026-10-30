import { randomUUID } from 'node:crypto';
import {
  createAgent,
  createTask,
  getRegisteredGroup,
  ensureChatExists,
  getUserById,
} from '../db.js';
import {
  attachAutomaticGoalSession,
  linkPersonalGoalTask,
  markAutomaticGoalTask,
  type PersonalGoal,
  GoalConflict,
  validateCloudGoalDefinition,
  getPersonalGoal,
} from './goal-store.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { selectNewProductRuntime } from './product-model.js';

const CLOUD_GOAL_PROMPT =
  'Execute only the frozen Goal context supplied by the MiniClaw Scheduler using the explicitly granted Cloud tools. Propose a private artifact for exact-content user approval. Do not claim completion without server-verified evidence.';
const NODE_GOAL_PROMPT =
  'Execute only the frozen Goal context supplied by the MiniClaw Scheduler. Read workspace evidence and propose a private artifact for explicit user approval. Do not claim completion without evidence.';

export function cloudGoalAvailable(ownerId: string, workspaceJid: string) {
  if (
    process.env.MINICLAW_PERSONAL_GOALS !== 'true' ||
    process.env.MINICLAW_CLOUD_GOALS !== 'true'
  )
    return false;
  const workspace = getRegisteredGroup(workspaceJid);
  if (
    workspace?.created_by !== ownerId ||
    workspace.executionMode !== 'host' ||
    !canExecuteOnHost(getUserById(ownerId))
  )
    return false;
  try {
    const selected = selectNewProductRuntime(
      workspaceJid,
      'cloudflare-durable',
      CLOUD_GOAL_PROMPT,
    );
    return (
      selected.kind === 'pi-durable' &&
      !!selected.cloud &&
      selected.cloud.instructions.length <= 32768 &&
      !!selected.cloud.tool_capabilities?.includes('create_approved_artifact')
    );
  } catch {
    return false;
  }
}

/** Runs inside Goal creation's database transaction, before any Scheduler admission. */
export function provisionAutomaticGoal(
  goal: PersonalGoal,
  requested?: 'node-durable' | 'cloudflare-durable',
) {
  if (goal.session_id) return;
  if (
    requested === 'cloudflare-durable' &&
    !cloudGoalAvailable(goal.owner_user_id, goal.workspace_jid)
  )
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Cloud Goal requires enabled admission, an authorized workspace, a compatible model and artifact approval capability',
    );
  const cloud = requested === 'cloudflare-durable';
  if (cloud && process.env.MINICLAW_CLOUD_GOALS !== 'true')
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Cloud Goal admission is disabled',
    );
  if (
    !cloud &&
    process.env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() !== 'true'
  ) {
    if (requested)
      throw new GoalConflict(
        'GOAL_RUNTIME_UNAVAILABLE',
        'Node Durable Goal admission is disabled',
      );
    return;
  }
  const workspace = getRegisteredGroup(goal.workspace_jid);
  if (workspace?.executionMode !== 'host') {
    if (requested)
      throw new GoalConflict(
        'GOAL_RUNTIME_UNAVAILABLE',
        'Goal runtime requires an authorized Host workspace',
      );
    return;
  }
  if (cloud && !canExecuteOnHost(getUserById(goal.owner_user_id)))
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Cloud Goal requires current Host execution permission',
    );
  const prompt = cloud ? CLOUD_GOAL_PROMPT : NODE_GOAL_PROMPT;
  let selection: ReturnType<typeof selectNewProductRuntime>;
  try {
    selection = selectNewProductRuntime(goal.workspace_jid, requested, prompt);
  } catch {
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Requested Goal runtime configuration is unavailable',
    );
  }
  if (selection.kind !== 'pi-durable')
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Goal requires a Durable runtime',
    );
  if (
    cloud &&
    !selection.cloud?.tool_capabilities?.includes('create_approved_artifact')
  )
    throw new GoalConflict(
      'GOAL_RUNTIME_UNAVAILABLE',
      'Cloud Goal requires the explicit artifact approval capability',
    );
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  createAgent(
    {
      id: sessionId,
      chat_jid: goal.workspace_jid,
      group_folder: workspace.folder,
      name: goal.objective.slice(0, 80),
      prompt,
      kind: 'conversation',
      status: 'idle',
      created_by: goal.owner_user_id,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { ...selection, goalId: goal.id },
  );
  ensureChatExists(`${goal.workspace_jid}#agent:${sessionId}`);
  createTask({
    id: taskId,
    chat_jid: goal.workspace_jid,
    group_folder: workspace.folder,
    prompt: 'Advance the associated Personal Goal using its frozen context.',
    schedule_type: 'interval',
    schedule_value: '86400000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'host',
    script_command: null,
    next_run: null,
    status: 'paused',
    created_by: goal.owner_user_id,
    created_at: now,
    notify_channels: [],
  });
  attachAutomaticGoalSession(goal.owner_user_id, goal.id, sessionId);
  linkPersonalGoalTask(goal.owner_user_id, goal.id, taskId, goal.revision);
  markAutomaticGoalTask(goal.id, taskId);
  validateCloudGoalDefinition(getPersonalGoal(goal.owner_user_id, goal.id)!);
}
