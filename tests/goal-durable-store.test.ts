import {
  DROP_V81_BOT_FIXTURE_SCHEMA,
  DROP_V80_BOT_FIXTURE_SCHEMA,
} from './helpers/legacy-bot-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { beforeAll, afterAll, afterEach, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-durable-store-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
const approvals = await import('../src/personal-agent/approval-store.js');
const artifacts = await import('../src/personal-agent/artifact-effect.js');
const { ProductRuntimeService } =
  await import('../src/personal-agent/product-runtime.js');
const { processClaimedTaskRunNotification } =
  await import('../src/task-scheduler.js');
const hostPolicy = await import('../src/host-execution-policy.js');
const { productModelConfiguration } =
  await import('../src/personal-agent/product-model.js');
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'owner',
    password_hash: 'fixture',
    display_name: 'owner',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:owner', {
    name: 'Owner',
    folder: 'owner',
    created_by: 'owner',
    executionMode: 'host',
    added_at: now,
    is_home: false,
  });
});
afterEach(() => {
  for (const run of db.getTaskRunsByStatus(['queued', 'running', 'retry_wait']))
    db.cancelTaskRun(run.id);
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function create(key = randomUUID(), managed = true) {
  const goal = goals.createPersonalGoal(
    'owner',
    key,
    {
      workspace_jid: 'web:owner',
      objective: 'Frozen objective',
      completion_criteria: ['artifact_contains:evidence'],
      budget_max_runs: 2,
    },
    (goal) => {
      const session = randomUUID();
      const taskId = randomUUID();
      const now = new Date().toISOString();
      db.createAgent(
        {
          id: session,
          chat_jid: 'web:owner',
          group_folder: 'owner',
          name: 'Goal',
          prompt: '',
          kind: 'conversation',
          status: 'idle',
          created_by: 'owner',
          created_at: now,
          completed_at: null,
          result_summary: null,
          last_im_jid: null,
          spawned_from_jid: null,
        },
        {
          kind: 'pi-durable',
          providerId: 'fixture',
          configFingerprint: 'frozen',
          ...(managed ? { goalId: goal.id } : {}),
        },
      );
      db.createTask({
        id: taskId,
        chat_jid: 'web:owner',
        group_folder: 'owner',
        prompt: 'not the Goal objective',
        schedule_type: 'interval',
        schedule_value: '86400000',
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'host',
        script_command: null,
        next_run: null,
        status: 'paused',
        created_at: now,
        created_by: 'owner',
      });
      goals.attachAutomaticGoalSession('owner', goal.id, session);
      goals.linkPersonalGoalTask('owner', goal.id, taskId, goal.revision);
      if (managed) goals.markAutomaticGoalTask(goal.id, taskId);
    },
  );
  return {
    goal,
    task: db.getTaskById(goals.listPersonalGoalTaskIds('owner', goal.id)[0])!,
  };
}
function expire(runId: string) {
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    const changed = raw
      .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), runId);
    expect(changed.changes).toBe(1);
    const lease = raw
      .prepare('SELECT lease_expires_at FROM task_runs WHERE id=?')
      .get(runId) as { lease_expires_at: string };
    expect(Date.parse(lease.lease_expires_at)).toBeLessThan(Date.now());
  } finally {
    raw.close();
  }
}
test('Goal/Task/Session provisioning rolls back together and retries do not provision twice', () => {
  const key = randomUUID();
  let attempts = 0;
  expect(() =>
    goals.createPersonalGoal(
      'owner',
      key,
      {
        workspace_jid: 'web:owner',
        objective: 'Rollback',
        completion_criteria: ['Evidence'],
      },
      () => {
        throw new Error('injected provisioning failure');
      },
    ),
  ).toThrow('injected');
  expect(
    goals
      .listPersonalGoals('owner')
      .some((goal) => goal.objective === 'Rollback'),
  ).toBe(false);
  const original = create(key);
  const retry = goals.createPersonalGoal(
    'owner',
    key,
    {
      workspace_jid: 'web:owner',
      objective: 'Frozen objective',
      completion_criteria: ['artifact_contains:evidence'],
      budget_max_runs: 2,
    },
    () => {
      attempts++;
    },
  );
  expect(retry.id).toBe(original.goal.id);
  expect(attempts).toBe(0);
  expect(goals.listPersonalGoalTaskIds('owner', retry.id)).toEqual([
    original.task.id,
  ]);
});
test('an existing manual Goal link does not switch its task or take over an ordinary Durable Session', () => {
  const { goal, task } = create(randomUUID(), false);
  expect(goals.isGoalProductSession(goal.session_id!)).toBe(false);
  expect(goals.goalForProductSession(goal.session_id!)).toBeUndefined();
  const run = db.createTaskRun({ task, triggerType: 'manual' }).run;
  expect(run.definition_snapshot.personal_goal).toBeUndefined();
});
test('a managed Session cannot lose its execution owner or become an ordinary conversation after links disappear', () => {
  const { goal } = create();
  const probe = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      probe
        .prepare(
          'UPDATE product_session_runtimes SET goal_id=NULL WHERE session_id=?',
        )
        .run(goal.session_id),
    ).toThrow('immutable');
    probe
      .prepare('DELETE FROM personal_goal_tasks WHERE goal_id=?')
      .run(goal.id);
    expect(goals.isGoalProductSession(goal.session_id!)).toBe(true);
    expect(() =>
      new ProductRuntimeService().authorize(goal.session_id!, 'owner'),
    ).toThrow('Managed Goal runtime ownership');
  } finally {
    probe.close();
  }
});
test('a queued execution retains its Goal version instead of executing an unrelated task prompt', () => {
  const { goal, task } = create();
  const run = db.createTaskRun({
    task,
    triggerType: 'manual',
    idempotencyKey: 'frozen',
  }).run;
  goals.patchPersonalGoal('owner', goal.id, {
    expected_revision: goal.revision,
    objective: 'Edited for the next step',
  });
  expect(
    db.getTaskRunById(run.id)!.definition_snapshot.personal_goal,
  ).toMatchObject({
    goal_revision: goal.revision,
    objective: 'Frozen objective',
    completion_criteria: ['artifact_contains:evidence'],
    session_id: goal.session_id,
  });
  expect(db.getTaskRunById(run.id)!.definition_snapshot.prompt).toBe(
    'not the Goal objective',
  );
});
test('only a trusted Durable binding can reclaim a started run; a stale lease cannot commit or double-charge its budget', () => {
  const { goal, task } = create();
  const run = db.createTaskRun({ task, triggerType: 'manual' }).run;
  const first = db.claimNextTaskRun('first', 60000)!;
  expect(first.id).toBe(run.id);
  expect(
    db.markTaskRunExecutionStarted(
      first.id,
      first.lease_owner,
      first.lease_token,
    ),
  ).toBe(true);
  expire(run.id);
  expect(db.failExpiredStartedTaskRuns()).toBe(0);
  const recovered = db.claimNextTaskRun('recovered', 60000)!;
  expect(recovered.id).toBe(run.id);
  expect(recovered.lease_token).toBeGreaterThan(first.lease_token);
  expect(
    db.markTaskRunExecutionStarted(
      recovered.id,
      recovered.lease_owner,
      recovered.lease_token,
    ),
  ).toBe(true);
  expect(goals.getPersonalGoal('owner', goal.id)!.budget_used_runs).toBe(1);
  expect(
    db.completeTaskRun(first.id, first.lease_owner, first.lease_token, {
      status: 'success',
    }),
  ).toBe(false);
});
test('pause prevents claims and original-run continuation preserves the input owner and shared budget', () => {
  const { goal, task } = create();
  const run = db.createTaskRun({ task, triggerType: 'manual' }).run;
  const claim = db.claimNextTaskRun('first', 60000)!;
  db.markTaskRunExecutionStarted(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
  );
  const current = goals.getPersonalGoal('owner', goal.id)!;
  const paused = goals.patchPersonalGoal('owner', goal.id, {
    expected_revision: current.revision,
    status: 'paused',
  });
  expect(goals.activeGoalExecution(goal.session_id!)).toBeUndefined();
  db.releaseTaskRunForRetry(
    run.id,
    claim.lease_owner,
    claim.lease_token,
    new Date().toISOString(),
    'paused',
    { countsAsAttempt: false },
  );
  expect(db.claimNextTaskRun('blocked', 60000)).toBeUndefined();
  goals.patchPersonalGoal('owner', goal.id, {
    expected_revision: paused.revision,
    status: 'pending',
  });
  const resumed = db.claimNextTaskRun('resumed', 60000)!;
  expect(resumed.id).toBe(run.id);
  db.markTaskRunExecutionStarted(
    resumed.id,
    resumed.lease_owner,
    resumed.lease_token,
  );
  expect(goals.getPersonalGoal('owner', goal.id)!.budget_used_runs).toBe(1);
  expect(goals.activeGoalExecution(goal.session_id!)?.run_id).toBe(run.id);
});
test('a local executor can bind only the current started Scheduler claim', () => {
  const { task } = create();
  db.createTaskRun({ task, triggerType: 'manual' });
  const first = db.claimNextTaskRun('first-executor', 60000)!;
  const service = new ProductRuntimeService();
  expect(() => service.bindGoalClaim(first)).toThrow();
  db.markTaskRunExecutionStarted(
    first.id,
    first.lease_owner,
    first.lease_token,
  );
  expect(() => service.bindGoalClaim(first)).not.toThrow();
  expire(first.id);
  const next = db.claimNextTaskRun('next-executor', 60000)!;
  expect(() => service.bindGoalClaim(first)).toThrow();
  expect(() => service.bindGoalClaim(next)).not.toThrow();
});
test('legacy started tasks retain their no-replay failure boundary', () => {
  const { task } = create();
  const unlinked = { ...task, id: randomUUID() };
  db.createTask(unlinked);
  const run = db.createTaskRun({
    task: db.getTaskById(unlinked.id)!,
    triggerType: 'manual',
  }).run;
  const claim = db.claimNextTaskRun('legacy', 60000)!;
  expect(claim.id).toBe(run.id);
  expect(run.definition_snapshot.personal_goal).toBeUndefined();
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  expire(run.id);
  expect(db.getTaskRunById(run.id)).toMatchObject({
    status: 'running',
    started_at: expect.any(String),
  });
  expect(Date.parse(db.getTaskRunById(run.id)!.lease_expires_at!)).toBeLessThan(
    Date.now(),
  );
  const probe = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(
      probe
        .prepare(
          `SELECT ${goals.TRUSTED_GOAL_DURABLE_RUN} AS trusted FROM task_runs WHERE id=?`,
        )
        .get(run.id),
    ).toMatchObject({ trusted: 0 });
  } finally {
    probe.close();
  }
  expect(db.failExpiredStartedTaskRuns()).toBe(1);
  expect(db.getTaskRunById(run.id)!.status).toBe('failed');
  expect(db.claimNextTaskRun('must-not-replay', 60000)).toBeUndefined();
});
test('a cancelled Goal run revokes its exact unexecuted approval and cannot reuse consent', () => {
  const { goal, task } = create();
  const run = db.createTaskRun({ task, triggerType: 'manual' }).run;
  const claim = db.claimNextTaskRun('approval', 60000)!;
  db.markTaskRunExecutionStarted(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
  );
  const approval = approvals.requestArtifactApproval(
    goal.session_id!,
    99,
    'must remain unwritten',
    { goalId: goal.id, runId: run.id, taskId: task.id },
  );
  approvals.decideProductApproval(
    'owner',
    approval.id,
    approval.parameters_digest,
    'approve',
    randomUUID(),
  );
  db.cancelTaskRun(run.id);
  approvals.revokeGoalApprovals(run.id);
  goals.cancelPersonalGoalExecution(run.id);
  expect(approvals.getProductApproval(approval.id, 'owner')).toMatchObject({
    state: 'denied',
    resolution: 'revoked',
    run_id: run.id,
  });
  expect(() =>
    artifacts.executeApprovedArtifact(approval.id, 'owner', () => undefined),
  ).toThrow();
  expect(
    fs.existsSync(
      path.join(root, 'db/private-artifacts', `${approval.id}.txt`),
    ),
  ).toBe(false);
});
test('an expired approval cannot grant or execute its original effect', () => {
  const { goal } = create();
  const approval = approvals.requestArtifactApproval(
    goal.session_id!,
    100,
    'expired content',
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 86400100);
    expect(approvals.getProductApproval(approval.id, 'owner')).toMatchObject({
      state: 'denied',
      resolution: 'expired',
    });
    expect(() =>
      approvals.decideProductApproval(
        'owner',
        approval.id,
        approval.parameters_digest,
        'approve',
        randomUUID(),
      ),
    ).toThrow();
    expect(() =>
      artifacts.executeApprovedArtifact(approval.id, 'owner', () => undefined),
    ).toThrow();
  } finally {
    vi.useRealTimers();
  }
});
test('in-progress Host revocation blocks selection and execution before the role update commits', () => {
  const { goal } = create();
  hostPolicy.beginHostPrivilegeRevocation('owner');
  try {
    expect(db.getUserById('owner')!.role).toBe('admin');
    expect(() => productModelConfiguration('web:owner')).toThrow(
      'Host execution permission',
    );
    expect(() =>
      new ProductRuntimeService().authorize(goal.session_id!, 'owner'),
    ).toThrow('Host execution permission');
  } finally {
    hostPolicy.endHostPrivilegeRevocation('owner');
  }
});
test('a committed Goal outbox result cannot be delivered after workspace ownership changes', async () => {
  const { goal, task } = create();
  const run = db.createTaskRun({ task, triggerType: 'manual' }).run;
  const claim = db.claimNextTaskRun('producer', 60000)!;
  db.markTaskRunExecutionStarted(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
  );
  expect(
    db.completeIsolatedTaskRunWithWorkspaceResultIntent({
      runId: run.id,
      taskId: task.id,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      status: 'success',
      result: 'private result',
      payload: {
        kind: 'workspace_result',
        chatJid: 'web:owner',
        text: 'private result',
        options: {
          ownerId: 'owner',
          notifyChannels: [],
          sourceKind: 'scheduled_task_result',
          messageId: `scheduled-task-result:${run.id}`,
          skipStore: false,
          workspaceFolder: 'owner',
        },
      },
    }),
  ).toBe(true);
  const notification = db.claimNextTaskRunNotification('notifier', 60000)!;
  expect(notification.runId).toBe(run.id);
  const workspace = db.getRegisteredGroup('web:owner')!;
  const now = new Date().toISOString();
  db.createUser({
    id: 'new-owner',
    username: 'new-owner',
    password_hash: 'fixture',
    display_name: 'new-owner',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:owner', { ...workspace, created_by: 'new-owner' });
  const delivery = vi.fn();
  try {
    expect(
      await processClaimedTaskRunNotification(notification, {
        storeResultAndNotify: delivery,
      } as unknown as Parameters<typeof processClaimedTaskRunNotification>[1]),
    ).toBe(true);
    expect(delivery).not.toHaveBeenCalled();
    expect(db.getTaskRunById(run.id)!.notification_status).toBe('skipped');
    expect(db.getTaskRunById(run.id)!.notification_error).toContain(
      'authorization',
    );
  } finally {
    db.setRegisteredGroup('web:owner', workspace);
  }
});
test('v72 migration backs up Goal/runtime identities and does not auto-promote existing task links', () => {
  const original = goals.listPersonalGoals('owner')[0];
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    DROP_V81_BOT_FIXTURE_SCHEMA +
      DROP_V80_BOT_FIXTURE_SCHEMA +
      "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;DROP TABLE github_goal_events;DROP TABLE github_goal_triggers;DROP TABLE product_input_results;DROP TABLE product_queue_controls;DROP TABLE goal_execution_contexts;DROP TRIGGER product_runtime_goal_identity_immutable;DROP INDEX product_runtime_goal_unique;ALTER TABLE product_session_runtimes DROP COLUMN goal_id;DROP INDEX idx_goal_automatic_task;ALTER TABLE personal_goal_tasks DROP COLUMN automatic;DROP TRIGGER product_approval_goal_scope_immutable;ALTER TABLE product_approvals DROP COLUMN goal_id;ALTER TABLE product_approvals DROP COLUMN run_id;ALTER TABLE product_approvals DROP COLUMN task_id;ALTER TABLE product_approvals DROP COLUMN expires_at;ALTER TABLE product_approvals DROP COLUMN resolution;UPDATE task_runs SET definition_snapshot=json_remove(definition_snapshot,'$.personal_goal');UPDATE router_state SET value='72' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(goals.getPersonalGoal('owner', original.id)?.session_id).toBe(
    original.session_id,
  );
  expect(goals.unstartedAutomaticGoalTasks()).toEqual([]);
  const backupName = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .find((name) =>
      name.startsWith(`messages-v72-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  const filename = path.join(root, 'db/migration-backups', backupName);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new Database(filename, { readonly: true });
  try {
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='goal_execution_contexts'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare('SELECT session_id FROM personal_goals WHERE id=?')
        .get(original.id),
    ).toMatchObject({ session_id: original.session_id });
    expect(backup.prepare('PRAGMA integrity_check').get()).toMatchObject({
      integrity_check: 'ok',
    });
  } finally {
    backup.close();
  }
});

test('completion is transactionally fenced by late input and control admissions without committing a result', () => {
  const { goal, task } = create();
  db.createTaskRun({ task, triggerType: 'manual' });
  const claim = db.claimNextTaskRun('completion-race', 60000)!;
  db.markTaskRunExecutionStarted(
    claim.id,
    claim.lease_owner,
    claim.lease_token,
  );
  const execution = goals.activeGoalExecution(goal.session_id!)!;
  const input = product.admitProductInput(
    goal.session_id!,
    'late-follow-up',
    {
      content: 'continue',
      followUpBehavior: 'queue',
      sender: 'owner',
      senderName: 'Owner',
      execution: {
        goalId: goal.id,
        runId: claim.id,
        contextDigest: execution.snapshot.content_digest,
      },
    },
    () => {},
  );
  const commit = vi.fn(() => true);
  const settle = () =>
    goals.settlePersonalGoalExecution(
      {
        runId: claim.id,
        sessionId: goal.session_id!,
        leaseOwner: claim.lease_owner,
        leaseToken: claim.lease_token,
        modelCompleted: false,
        evidence: [],
      },
      commit,
      () => {},
    );
  expect(settle).toThrow(goals.GoalExecutionPending);
  expect(commit).not.toHaveBeenCalled();
  product.finishProductInput(input.id, true, () => {});
  const control = product.admitQueueControl(goal.session_id!, 'late-control', {
    command: {
      action: 'abort',
      taskId: 1,
      expectedQueueDigest: 'a'.repeat(64),
    },
    targets: [],
    goalRunId: claim.id,
  });
  expect(settle).toThrow(goals.GoalExecutionPending);
  expect(commit).not.toHaveBeenCalled();
  product.finishQueueControl(control.id, false);
  expect(settle()).toBe(true);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(goals.getPersonalGoal('owner', goal.id)!.budget_used_runs).toBe(1);
});
