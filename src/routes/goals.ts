import { canExecuteOnHost } from '../host-execution-policy.js';
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  getActiveTaskRunForTask,
  getAgent,
  getRegisteredGroup,
  getUserById,
  getTaskById,
  getTaskRunById,
  getTaskRunByIdempotencyKey,
  getTaskRunsForTask,
} from '../db.js';
import {
  canAccessGroup,
  getWebDeps,
  hasHostExecutionPermission,
  isHostExecutionGroup,
  type Variables,
} from '../web-context.js';
import {
  createPersonalGoal,
  getPersonalGoal,
  GoalConflict,
  GoalCreateSchema,
  GoalPatchSchema,
  linkPersonalGoalTask,
  listPersonalGoalEvents,
  listPersonalGoals,
  listPersonalGoalTaskIds,
  patchPersonalGoal,
  listGoalExecutionEvidence,
  listGoalDeviceEvidence,
  isGoalProductSession,
  type PersonalGoal,
} from '../personal-agent/goal-store.js';
import { notifyTaskSchedulerChanged } from '../task-scheduler.js';
import {
  provisionAutomaticGoal,
  cloudGoalAvailable,
} from '../personal-agent/automatic-goal.js';
import { CLOUD_GOAL_RUN_LIMIT } from '../personal-agent/goal-context.js';
import {
  getProductRuntime,
  productRouterKind,
} from '../personal-agent/product-runtime-store.js';
import { getProductRuntimeService } from '../personal-agent/product-runtime.js';
import { readApprovedArtifact } from '../personal-agent/artifact-effect.js';
import type { AuthUser } from '../types.js';
import {
  goalTeamStepViews,
  goalTeamChoices,
} from '../personal-agent/goal-team-store.js';
import { BotGroupError } from '../bot-groups/protocol.js';

const routes = new Hono<{ Variables: Variables }>();
const requestKey = z.string().trim().min(1).max(128);
const linkSchema = z
  .object({
    task_id: z.string().min(1).max(200),
    expected_revision: z.number().int().positive(),
  })
  .strict();
const runSchema = z
  .object({ expected_task_revision: z.number().int().positive() })
  .strict();

// Availability is authenticated but readable while the write feature is off.
routes.get('/availability', authMiddleware, (c) => {
  if (c.req.query('workspace_jid') === undefined)
    return c.json({
      enabled:
        process.env.MINICLAW_PERSONAL_GOALS?.trim().toLowerCase() === 'true',
    });
  const workspace = z
    .string()
    .startsWith('web:')
    .max(256)
    .safeParse(c.req.query('workspace_jid'));
  return c.json({
    enabled:
      process.env.MINICLAW_PERSONAL_GOALS?.trim().toLowerCase() === 'true',
    cloud_enabled:
      workspace.success && cloudGoalAvailable(c.get('user').id, workspace.data),
    cloud_max_runs: CLOUD_GOAL_RUN_LIMIT,
  });
});

routes.use('*', authMiddleware, async (c, next) => {
  if (process.env.MINICLAW_PERSONAL_GOALS?.trim().toLowerCase() !== 'true') {
    return c.json({ error: 'Not found' }, 404);
  }
  await next();
});
routes.onError((error, c) => {
  if (error instanceof BotGroupError)
    return c.json(
      {
        error: 'Goal Team is unavailable under the current authorization',
        code: error.code,
      },
      error.status,
    );
  if (error instanceof ZodError)
    return c.json(
      { error: 'Invalid Goal request', details: error.flatten() },
      400,
    );
  if (error instanceof GoalConflict)
    return c.json(
      { error: error.message, code: error.code },
      error.code === 'GOAL_NOT_FOUND'
        ? 404
        : error.code === 'GOAL_REQUEST_ID_REQUIRED'
          ? 400
          : 409,
    );
  return c.json({ error: 'Goal request failed' }, 500);
});

function canUseWorkspace(user: AuthUser, jid: string): boolean {
  const group = getRegisteredGroup(jid);
  return Boolean(
    group &&
    canAccessGroup(user, { ...group, jid }) &&
    (!isHostExecutionGroup(group) ||
      (hasHostExecutionPermission(user) &&
        canExecuteOnHost(getUserById(user.id)))),
  );
}
function visibleGoal(
  c: Context<{ Variables: Variables }>,
  id: string,
): PersonalGoal {
  const user = c.get('user');
  const goal = getPersonalGoal(user.id, id);
  if (!goal || !canUseWorkspace(user, goal.workspace_jid))
    throw new GoalConflict('GOAL_NOT_FOUND', 'Goal not found');
  return goal;
}
function linkedTasks(goal: PersonalGoal) {
  return listPersonalGoalTaskIds(goal.owner_user_id, goal.id)
    .map(getTaskById)
    .filter((task): task is NonNullable<typeof task> =>
      Boolean(
        task &&
        task.created_by === goal.owner_user_id &&
        task.chat_jid === goal.workspace_jid,
      ),
    );
}

routes.get('/team-options', (c) => {
  const user = c.get('user');
  return c.json({
    teams: goalTeamChoices(user.id)
      .filter((team) => canUseWorkspace(user, team.workspace_jid))
      .flatMap((team) => {
        const runtime =
          process.env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() === 'true'
            ? 'node-durable'
            : cloudGoalAvailable(user.id, team.workspace_jid)
              ? 'cloudflare-durable'
              : null;
        return runtime ? [{ ...team, runtime }] : [];
      }),
  });
});
routes.get('/', (c) => {
  const user = c.get('user');
  return c.json({
    goals: listPersonalGoals(user.id).filter((goal) =>
      canUseWorkspace(user, goal.workspace_jid),
    ),
  });
});
routes.post('/', async (c) => {
  const input = GoalCreateSchema.parse(await c.req.json().catch(() => ({})));
  const user = c.get('user');
  if (!canUseWorkspace(user, input.workspace_jid))
    throw new GoalConflict('GOAL_NOT_FOUND', 'Workspace not found');
  const key = requestKey.parse(c.req.header('Idempotency-Key'));
  const goal = createPersonalGoal(user.id, key, input, (goal) =>
    provisionAutomaticGoal(goal, input.runtime),
  );
  const task = linkedTasks(goal)[0];
  // A retry after a crash before start uses the same TaskRun key. No execution
  // starts until Goal/Task/Session ownership has committed atomically.
  const automatic = goal.session_id && isGoalProductSession(goal.session_id);
  const started =
    automatic && task
      ? getWebDeps()?.triggerTaskRun?.(task.id, `goal:${goal.id}:initial`)
      : undefined;
  return c.json(
    { goal: getPersonalGoal(user.id, goal.id), execution: started ?? null },
    201,
  );
});
routes.get('/:id', (c) => {
  const goal = visibleGoal(c, c.req.param('id'));
  const tasks = linkedTasks(goal);
  const session = goal.session_id ? getAgent(goal.session_id) : undefined;
  const managed = Boolean(
    goal.session_id && isGoalProductSession(goal.session_id),
  );
  return c.json({
    goal,
    tasks,
    permission_scope: 'workspace',
    delivery_policy: managed ? 'session_and_workspace' : 'linked_task_channels',
    managed_execution: managed,
    runtime_kind:
      goal.session_id && getProductRuntime(goal.session_id)
        ? productRouterKind(goal.session_id)
        : null,
    session:
      session?.created_by === goal.owner_user_id &&
      session.chat_jid === goal.workspace_jid
        ? session
        : null,
    executions: tasks
      .flatMap((task) => getTaskRunsForTask(task.id, 20))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 100),
    activity: listPersonalGoalEvents(goal.owner_user_id, goal.id),
    evidence: listGoalExecutionEvidence(goal.owner_user_id, goal.id),
    device_evidence: listGoalDeviceEvidence(goal.owner_user_id, goal.id),
    ...(goal.team ? { team_steps: goalTeamStepViews(goal.id) } : {}),
  });
});
routes.patch('/:id', async (c) => {
  const goal = visibleGoal(c, c.req.param('id'));
  const input = GoalPatchSchema.parse(await c.req.json().catch(() => ({})));
  const user = c.get('user');
  if (goal.session_id && isGoalProductSession(goal.session_id)) {
    const tasks = linkedTasks(goal);
    const active = tasks
      .map((task) => getActiveTaskRunForTask(task.id))
      .filter((run) => !!run);
    if (
      input.status &&
      !['pending', 'running', 'paused', 'completed', 'cancelled'].includes(
        input.status,
      )
    )
      return c.json(
        {
          error:
            'Use pause, resume or cancel; waiting states are derived from execution',
        },
        409,
      );
    if (input.status === 'completed') {
      if (active.length)
        return c.json(
          {
            error:
              'Wait for the active execution to stop before confirming completion',
          },
          409,
        );
      const evidence = listGoalExecutionEvidence(user.id, goal.id).flatMap(
        (run) => run.evidence,
      );
      if (!evidence.length)
        return c.json(
          { error: 'Goal completion requires a verified result artifact' },
          409,
        );
      try {
        for (const item of evidence)
          readApprovedArtifact(item.artifact_id, user.id);
      } catch {
        return c.json({ error: 'Goal evidence requires reconciliation' }, 409);
      }
    }
    if (
      ['pending', 'running'].includes(input.status ?? '') &&
      getProductRuntime(goal.session_id)?.state === 'blocked'
    )
      return c.json(
        {
          error:
            'Goal runtime is blocked; inspect its checkpoint before resuming',
        },
        409,
      );
    if (
      ['pending', 'running'].includes(input.status ?? '') &&
      !active.length &&
      goal.budget_used_runs >= (input.budget_max_runs ?? goal.budget_max_runs)
    )
      return c.json(
        {
          error:
            'Goal execution budget exhausted; revise the budget before starting another step',
        },
        409,
      );
    const updated = patchPersonalGoal(user.id, goal.id, input);
    if (input.status === 'paused')
      await getProductRuntimeService().suspendGoalSession(goal.session_id);
    if (input.status === 'cancelled') {
      for (const run of active) getWebDeps()?.cancelTaskRun?.(run.id);
      await getProductRuntimeService().stopSession(goal.session_id, user.id);
    }
    if (
      ['pending', 'running'].includes(input.status ?? '') &&
      !active.length &&
      tasks[0]
    )
      getWebDeps()?.triggerTaskRun?.(
        tasks[0].id,
        `goal:${goal.id}:resume:${input.expected_revision}`,
      );
    notifyTaskSchedulerChanged();
    return c.json({ goal: getPersonalGoal(user.id, updated.id) });
  }
  if (input.status && !['pending', 'running'].includes(input.status)) {
    const deps = getWebDeps();
    const tasks = linkedTasks(goal);
    const active = tasks
      .map((task) => getActiveTaskRunForTask(task.id))
      .filter((run) => Boolean(run));
    if (active.length && !deps?.cancelTaskRun)
      return c.json({ error: 'Scheduler cannot stop active Goal runs' }, 503);
    // Persist the fence first. Terminal state is committed only after stop/fencing succeeds.
    let updated = patchPersonalGoal(user.id, goal.id, {
      ...input,
      status: 'paused',
    });
    const pending: string[] = [];
    for (const task of tasks) {
      const run = getActiveTaskRunForTask(task.id);
      if (!run) continue;
      try {
        if (!deps?.cancelTaskRun?.(run.id).success) pending.push(run.id);
      } catch {
        pending.push(run.id);
      }
    }
    notifyTaskSchedulerChanged();
    if (pending.length)
      return c.json(
        {
          error: 'Goal paused; stopping current runs needs retry',
          code: 'GOAL_STOP_PENDING',
          goal: updated,
          pending_run_ids: pending,
        },
        409,
      );
    if (input.status !== 'paused')
      updated = patchPersonalGoal(user.id, goal.id, {
        expected_revision: updated.revision,
        status: input.status,
      });
    return c.json({ goal: updated });
  }
  const updated = patchPersonalGoal(user.id, goal.id, input);
  notifyTaskSchedulerChanged();
  return c.json({ goal: updated });
});
routes.post('/:id/tasks', async (c) => {
  const goal = visibleGoal(c, c.req.param('id'));
  const input = linkSchema.parse(await c.req.json().catch(() => ({})));
  return c.json({
    goal: linkPersonalGoalTask(
      c.get('user').id,
      goal.id,
      input.task_id,
      input.expected_revision,
    ),
  });
});
routes.post('/:id/tasks/:taskId/run', async (c) => {
  const goal = visibleGoal(c, c.req.param('id'));
  const input = runSchema.parse(await c.req.json().catch(() => ({})));
  const task = linkedTasks(goal).find(
    (item) => item.id === c.req.param('taskId'),
  );
  if (!task) throw new GoalConflict('GOAL_NOT_FOUND', 'Goal task not found');
  const key = requestKey.parse(c.req.header('Idempotency-Key'));
  const executionKey = `goal:${goal.id}:${createHash('sha256').update(key).digest('hex')}`;
  const previous = getTaskRunByIdempotencyKey(task.id, executionKey);
  if (previous) {
    if (previous.definition_revision !== input.expected_task_revision)
      throw new GoalConflict(
        'GOAL_REQUEST_CONFLICT',
        'Request ID refers to another task revision',
      );
    return c.json({ goal, run: previous, runId: previous.id }, 202);
  }
  if (task.revision !== input.expected_task_revision)
    throw new GoalConflict(
      'GOAL_TASK_REVISION_CONFLICT',
      'Task changed; reload before starting',
    );
  const deps = getWebDeps();
  if (!deps?.triggerTaskRun)
    return c.json({ error: 'Scheduler not available' }, 503);
  const result = deps.triggerTaskRun(task.id, executionKey);
  if (!result.success)
    return c.json({ error: result.error, runId: result.runId }, 409);
  return c.json(
    {
      goal: getPersonalGoal(goal.owner_user_id, goal.id),
      run: result.runId ? getTaskRunById(result.runId) : null,
      runId: result.runId,
    },
    202,
  );
});

export default routes;
