import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-goals-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');

beforeAll(() => {
  db.initDatabase();
  for (const id of ['alice', 'bob']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'unit-test-hash',
      display_name: id,
      role: id === 'bob' ? 'admin' : 'member',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      must_change_password: false,
    });
  }
  for (const [id, owner] of [
    ['project', 'alice'],
    ['other', 'alice'],
    ['private', 'bob'],
  ]) {
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      added_at: new Date().toISOString(),
      created_by: owner,
      executionMode: 'container',
      is_home: false,
    });
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createGoal(budget = 3) {
  return goals.createPersonalGoal('alice', randomUUID(), {
    workspace_jid: 'web:project',
    objective: 'Track project health',
    completion_criteria: ['Deliver a review'],
    budget_max_runs: budget,
  });
}
function task(overrides: Partial<Parameters<typeof db.createTask>[0]> = {}) {
  const id = randomUUID();
  db.createTask({
    id,
    group_folder: 'project',
    chat_jid: 'web:project',
    prompt: 'Review project',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: 'alice',
    ...overrides,
    script_command: overrides.script_command ?? null,
  });
  return db.getTaskById(id)!;
}

describe('Personal Goals with existing Scheduler persistence', () => {
  test('partial Goal updates preserve the reviewed budget and next action across pause/resume, while exhausted work remains fenced', () => {
    let goal = goals.createPersonalGoal('alice', randomUUID(), {
      workspace_jid: 'web:project',
      objective: 'One explicitly budgeted step',
      completion_criteria: ['Deliver one review'],
      budget_max_runs: 1,
      next_action: 'Review the existing evidence before any more work',
    });
    const candidate = task();
    goal = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      candidate.id,
      goal.revision,
    );
    const first = db.createTaskRun({
      task: candidate,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('goal-budget-preservation', 60000)!;
    expect(claim.id).toBe(first.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    db.cancelTaskRun(first.id);
    const current = goals.getPersonalGoal('alice', goal.id)!;
    const paused = goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: current.revision,
      status: 'paused',
    });
    expect(paused).toMatchObject({
      budget_max_runs: 1,
      budget_used_runs: 1,
      next_action: goal.next_action,
      status: 'paused',
    });
    expect(goals.personalGoalContentDigest(paused)).toBe(
      goals.personalGoalContentDigest(goal),
    );
    const resumed = goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: paused.revision,
      status: 'pending',
    });
    expect(resumed).toMatchObject({
      budget_max_runs: 1,
      budget_used_runs: 1,
      next_action: goal.next_action,
    });
    expect(goals.personalGoalContentDigest(resumed)).toBe(
      goals.personalGoalContentDigest(goal),
    );
    expect(goals.personalGoalTaskBlockReason(candidate.id)).toBe(
      'Goal execution budget exhausted',
    );
    const second = db.createTaskRun({
      task: candidate,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const denied = db.claimNextTaskRun('goal-budget-preservation', 60000)!;
    expect(denied.id).toBe(second.id);
    expect(
      db.markTaskRunExecutionStarted(
        denied.id,
        denied.lease_owner,
        denied.lease_token,
      ),
    ).toBe(false);
    expect(db.getTaskRunById(second.id)?.status).toBe('cancelled');
    const revised = goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: resumed.revision,
      budget_max_runs: 2,
      next_action: '',
    });
    expect(revised).toMatchObject({
      budget_max_runs: 2,
      budget_used_runs: 1,
      next_action: '',
    });
    expect(goals.personalGoalTaskBlockReason(candidate.id)).toBeUndefined();
  });
  test('creation has payload-bound idempotency and does not expose its internal hash/key', () => {
    const key = randomUUID();
    const input = {
      workspace_jid: 'web:project',
      objective: 'Research',
      completion_criteria: ['Report'],
    };
    const first = goals.createPersonalGoal('alice', key, input);
    expect(goals.createPersonalGoal('alice', key, input).id).toBe(first.id);
    expect(first).not.toHaveProperty('create_request_hash');
    expect(first).not.toHaveProperty('create_request_id');
    expect(() =>
      goals.createPersonalGoal('alice', key, {
        ...input,
        objective: 'Changed',
      }),
    ).toThrow('different Goal content');
  });

  test('isolates owners and workspaces, including when one caller is an administrator', () => {
    const goal = createGoal();
    expect(goals.getPersonalGoal('bob', goal.id)).toBeUndefined();
    expect(goals.listPersonalGoals('bob')).toEqual([]);
    expect(() =>
      goals.createPersonalGoal('bob', randomUUID(), {
        workspace_jid: 'web:project',
        objective: 'No',
        completion_criteria: ['No'],
      }),
    ).toThrow('Workspace not found');
    expect(() =>
      goals.patchPersonalGoal('bob', goal.id, {
        expected_revision: goal.revision,
        status: 'cancelled',
      }),
    ).toThrow('Goal not found');
  });

  test('requires optimistic revisions and keeps completed/cancelled Goals terminal', () => {
    const goal = createGoal();
    const paused = goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      status: 'paused',
    });
    expect(() =>
      goals.patchPersonalGoal('alice', goal.id, {
        expected_revision: goal.revision,
        status: 'running',
      }),
    ).toThrow('reload');
    const cancelled = goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: paused.revision,
      status: 'cancelled',
    });
    expect(() =>
      goals.patchPersonalGoal('alice', goal.id, {
        expected_revision: cancelled.revision,
        status: 'pending',
      }),
    ).toThrow('terminal');
  });

  test('only links an owned paused Agent task in the same workspace', () => {
    const goal = createGoal();
    for (const candidate of [
      task({ created_by: 'bob' }),
      task({ chat_jid: 'web:other', group_folder: 'other' }),
      task({ execution_type: 'script', script_command: 'true' }),
      task({ status: 'active' }),
    ]) {
      expect(() =>
        goals.linkPersonalGoalTask(
          'alice',
          goal.id,
          candidate.id,
          goal.revision,
        ),
      ).toThrow('owned, paused');
    }
    const valid = task();
    const linked = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      valid.id,
      goal.revision,
    );
    expect(goals.listPersonalGoalTaskIds('alice', goal.id)).toEqual([valid.id]);
    expect(linked.revision).toBe(goal.revision + 1);
    const other = createGoal();
    expect(() =>
      goals.linkPersonalGoalTask('alice', other.id, valid.id, other.revision),
    ).toThrow('another Goal');
  });

  test('charges once at the irreversible Scheduler start boundary and cancels over-budget work', () => {
    let goal = createGoal(1);
    const candidate = task();
    goal = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      candidate.id,
      goal.revision,
    );
    const first = db.createTaskRun({
      task: candidate,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('goal-test', 60_000)!;
    expect(claim.id).toBe(first.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(goals.getPersonalGoal('alice', goal.id)?.budget_used_runs).toBe(1);
    expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('running');
    db.cancelTaskRun(first.id);
    const next = db.createTaskRun({
      task: candidate,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const second = db.claimNextTaskRun('goal-test', 60_000)!;
    expect(second.id).toBe(next.id);
    expect(
      db.markTaskRunExecutionStarted(
        second.id,
        second.lease_owner,
        second.lease_token,
      ),
    ).toBe(false);
    expect(db.getTaskRunById(next.id)?.status).toBe('cancelled');
    expect(goals.getPersonalGoal('alice', goal.id)?.budget_used_runs).toBe(1);
    expect(
      goals
        .listPersonalGoalEvents('alice', goal.id)
        .filter((e) => e.kind === 'execution_started'),
    ).toHaveLength(1);
  });

  test('pausing fences already queued runs and hides future scheduled occurrences', () => {
    let goal = createGoal();
    const candidate = task();
    goal = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      candidate.id,
      goal.revision,
    );
    db.updateTask(candidate.id, { status: 'active' });
    expect(
      db.getDueTaskDefinitionsV2().some((t) => t.id === candidate.id),
    ).toBe(true);
    const run = db.createTaskRun({
      task: db.getTaskById(candidate.id)!,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('paused-goal', 60_000)!;
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      status: 'paused',
    });
    expect(
      db.getDueTaskDefinitionsV2().some((t) => t.id === candidate.id),
    ).toBe(false);
    expect(
      db.markTaskRunExecutionStarted(
        run.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);
    expect(db.getTaskRunById(run.id)?.status).toBe('cancelled');
    expect(goals.getPersonalGoal('alice', goal.id)?.budget_used_runs).toBe(0);
  });

  test('revalidates edited task scope and workspace ownership at execution time', () => {
    const goal = createGoal();
    const candidate = task();
    goals.linkPersonalGoalTask('alice', goal.id, candidate.id, goal.revision);
    db.updateTask(candidate.id, {
      chat_jid: 'web:other',
      group_folder: 'other',
    });
    const run = db.createTaskRun({
      task: db.getTaskById(candidate.id)!,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('moved-task', 60_000)!;
    expect(
      db.markTaskRunExecutionStarted(
        run.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(false);
    expect(goals.getPersonalGoal('alice', goal.id)?.budget_used_runs).toBe(0);
  });

  test('persists Goal state and links across database reopen', () => {
    const goal = createGoal();
    const candidate = task();
    const linked = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      candidate.id,
      goal.revision,
    );
    db.closeDatabase();
    db.initDatabase();
    expect(goals.getPersonalGoal('alice', goal.id)).toEqual(linked);
    expect(goals.listPersonalGoalTaskIds('alice', goal.id)).toEqual([
      candidate.id,
    ]);
  });

  test('one shared Goal budget fences starts across different linked tasks', () => {
    let goal = createGoal(1);
    const firstTask = task();
    const secondTask = task();
    goal = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      firstTask.id,
      goal.revision,
    );
    goal = goals.linkPersonalGoalTask(
      'alice',
      goal.id,
      secondTask.id,
      goal.revision,
    );
    const first = db.createTaskRun({
      task: firstTask,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const second = db.createTaskRun({
      task: secondTask,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const firstClaim = db.claimNextTaskRun('budget-first', 60_000)!;
    const secondClaim = db.claimNextTaskRun('budget-second', 60_000)!;
    expect(new Set([firstClaim.id, secondClaim.id])).toEqual(
      new Set([first.id, second.id]),
    );
    expect(
      db.markTaskRunExecutionStarted(
        firstClaim.id,
        firstClaim.lease_owner,
        firstClaim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.markTaskRunExecutionStarted(
        secondClaim.id,
        secondClaim.lease_owner,
        secondClaim.lease_token,
      ),
    ).toBe(false);
    expect(goals.getPersonalGoal('alice', goal.id)?.budget_used_runs).toBe(1);
    db.cancelTaskRun(firstClaim.id);
  });

  test('revoked workspace ownership blocks an admitted run before execution', () => {
    const goal = createGoal();
    const candidate = task();
    goals.linkPersonalGoalTask('alice', goal.id, candidate.id, goal.revision);
    const run = db.createTaskRun({
      task: candidate,
      triggerType: 'manual',
      idempotencyKey: randomUUID(),
    }).run;
    const claim = db.claimNextTaskRun('revoked-owner', 60_000)!;
    const workspace = db.getRegisteredGroup('web:project')!;
    db.setRegisteredGroup('web:project', { ...workspace, created_by: 'bob' });
    try {
      expect(goals.getPersonalGoal('alice', goal.id)).toBeUndefined();
      expect(
        db.markTaskRunExecutionStarted(
          run.id,
          claim.lease_owner,
          claim.lease_token,
        ),
      ).toBe(false);
      expect(db.getTaskRunById(run.id)?.status).toBe('cancelled');
    } finally {
      db.setRegisteredGroup('web:project', workspace);
    }
  });
});
