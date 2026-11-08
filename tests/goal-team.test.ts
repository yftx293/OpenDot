import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-goal-team-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const { GoalCreateSchema, GoalPatchSchema } = goals;
const teams = await import('../src/personal-agent/goal-team-store.js');
const groups = await import('../src/bot-groups/store.js');
const handoffs = await import('../src/bot-groups/handoff-store.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const owner of ['alice', 'bob']) {
    db.createUser({
      id: owner,
      username: owner,
      password_hash: 'synthetic',
      display_name: owner,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const profile = db.getOrCreateDefaultAgentProfile(owner);
    db.setRegisteredGroup('web:' + owner, {
      name: owner,
      folder: owner,
      created_by: owner,
      executionMode: 'host',
      is_home: false,
      added_at: now,
    });
    db.assignWorkspaceAgentProfile(owner, profile.id);
  }
});
afterEach(() => {
  handoffs.configureBotHandoffProvisioner(undefined);
  for (const run of db.getTaskRunsByStatus(['queued', 'running', 'retry_wait']))
    db.cancelTaskRun(run.id);
  vi.unstubAllEnvs();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function agent(id: string, goalId?: string) {
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Test metadata',
      prompt: '',
      kind: 'conversation',
      status: 'idle',
      created_by: 'alice',
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    {
      kind: 'pi-durable',
      providerId: 'fixture',
      configFingerprint: 'frozen',
      ...(goalId ? { goalId } : {}),
    },
  );
}
function fixture() {
  for (const name of [
    'MINICLAW_PERSONAL_GOALS',
    'MINICLAW_GOAL_TEAMS',
    'MINICLAW_BOT_GROUPS',
    'MINICLAW_BOT_HANDOFFS',
  ])
    vi.stubEnv(name, 'true');
  const receipt = groups.createBotGroup('alice', randomUUID(), {
    name: 'Reviewed team',
    workspace_jid: 'web:alice',
  });
  let snapshot = groups.getBotGroupSnapshot('alice', receipt.group_id);
  const member = snapshot.members.find((m) => m.kind === 'bot')!;
  groups.patchBotGroupMember(
    'alice',
    receipt.group_id,
    member.id,
    randomUUID(),
    { expected_revision: snapshot.revision, scope_workspace_jid: 'web:alice' },
  );
  snapshot = groups.getBotGroupSnapshot('alice', receipt.group_id);
  handoffs.grantBotRuntime(
    'alice',
    receipt.group_id,
    member.id,
    randomUUID(),
    {
      expected_revision: snapshot.revision,
      expected_member_revision: snapshot.members.find(
        (m) => m.id === member.id,
      )!.revision,
      runtime_kind: 'node-durable',
      max_model_attempts: 2,
      tool_capabilities: ['create_approved_artifact'],
    },
    () => ({ providerId: 'fixture', configFingerprint: 'frozen' }),
  );
  handoffs.configureBotHandoffProvisioner(({ sessionId }) => agent(sessionId));
  const input = {
    workspace_jid: 'web:alice',
    objective: 'Controlled Team work',
    completion_criteria: ['artifact_contains:verified'],
    next_action: 'Inspect the existing evidence',
    budget_max_runs: 2,
    team: { group_id: receipt.group_id, bot_member_ids: [member.id] },
  };
  const provision = (goal: PersonalGoal) => {
    const sessionId = randomUUID(),
      taskId = randomUUID();
    agent(sessionId, goal.id);
    db.createTask({
      id: taskId,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      prompt: 'Advance the existing Goal',
      schedule_type: 'interval',
      schedule_value: '86400000',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'host',
      script_command: null,
      next_run: null,
      status: 'paused',
      created_by: 'alice',
      created_at: new Date().toISOString(),
    });
    goals.attachAutomaticGoalSession('alice', goal.id, sessionId);
    goals.linkPersonalGoalTask('alice', goal.id, taskId, goal.revision);
    goals.markAutomaticGoalTask(goal.id, taskId);
  };
  const key = randomUUID(),
    goal = goals.createPersonalGoal('alice', key, input, provision),
    task = db.getTaskById(goals.listPersonalGoalTaskIds('alice', goal.id)[0])!;
  return {
    goal,
    task,
    memberId: member.id,
    groupId: receipt.group_id,
    key,
    input,
    provision,
  };
}
function start(task: ReturnType<typeof db.getTaskById>) {
  const run = db.createTaskRun({
    task: task!,
    triggerType: 'manual',
    idempotencyKey: randomUUID(),
  }).run;
  const claim = db.claimNextTaskRun('goal-team-test', 60000)!;
  expect(claim.id).toBe(run.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  return claim;
}

test('a Goal can explicitly select its existing Group and a bounded reviewed Bot team, while PATCH cannot retarget it', () => {
  const team = { group_id: randomUUID(), bot_member_ids: [randomUUID()] };
  const goal = GoalCreateSchema.parse({
    workspace_jid: 'web:owner',
    objective: 'A controlled Team research goal',
    completion_criteria: ['artifact_contains:verified'],
    team,
  });
  expect(goal).toHaveProperty('team', team);
  expect(
    GoalPatchSchema.safeParse({ expected_revision: 1, team }).success,
  ).toBe(false);
  expect(
    GoalCreateSchema.safeParse({
      ...goal,
      team: {
        ...team,
        bot_member_ids: [randomUUID(), randomUUID(), randomUUID()],
      },
    }).success,
  ).toBe(false);
});

test('v82 upgrades with a private integrity-checked backup and never adopts a legacy Goal into a Team', () => {
  const legacy = goals.createPersonalGoal('alice', randomUUID(), {
    workspace_jid: 'web:alice',
    objective: 'Legacy independent Goal',
    completion_criteria: ['Keep its identity'],
    budget_max_runs: 1,
    next_action: 'Preserve reviewed work',
  });
  const digest = goals.personalGoalContentDigest(legacy);
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    'DROP TABLE personal_goal_team_steps; DROP TABLE personal_goal_teams;',
  );
  raw
    .prepare("UPDATE router_state SET value='82' WHERE key='schema_version'")
    .run();
  raw.close();
  db.initDatabase();
  expect(goals.getPersonalGoal('alice', legacy.id)).toEqual(legacy);
  expect(
    goals.personalGoalContentDigest(goals.getPersonalGoal('alice', legacy.id)!),
  ).toBe(digest);
  expect(teams.goalTeam(legacy.id)).toBeUndefined();
  const directory = path.join(root, 'db/migration-backups');
  const backup = fs
    .readdirSync(directory)
    .find((name) =>
      name.startsWith(`messages-v82-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  expect(backup).toBeTruthy();
  expect(fs.statSync(path.join(directory, backup)).mode & 0o777).toBe(0o600);
  const copy = new Database(path.join(directory, backup), { readonly: true });
  try {
    expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    copy.close();
  }
  db.closeDatabase();
  db.initDatabase();
  expect(teams.goalTeam(legacy.id)).toBeUndefined();
});

test('Goal creation binds the existing Group atomically; duplicate delegation retains one reviewed contract/Handoff and the coordinator has no native input', () => {
  const f = fixture(),
    claim = start(f.task),
    step = teams.admitGoalTeamStep(claim);
  expect(teams.admitGoalTeamStep(claim)).toEqual(step);
  expect(
    goals.createPersonalGoal('alice', f.key, f.input, f.provision).id,
  ).toBe(f.goal.id);
  expect(teams.listGoalTeamSteps(f.goal.id)).toHaveLength(1);
  const row = handoffs.getBotHandoff(step.handoff_id)!;
  expect(row).toMatchObject({
    goal_id: f.goal.id,
    source_bot_id: f.goal.team!.chief_profile_id,
    target_member_id: f.memberId,
    state: 'pending',
  });
  expect(row.session_id).not.toBe(f.goal.session_id);
  expect(product.listProductInputs(f.goal.session_id!)).toEqual([]);
  expect(JSON.parse(step.contract)).toMatchObject({
    goal: {
      objective: f.goal.objective,
      completion_criteria: f.goal.completion_criteria,
      next_action: f.goal.next_action,
      budget_remaining_runs: 2,
    },
    handoff_id: row.id,
    allowed_tools: ['create_approved_artifact'],
  });
  expect(() => goals.assertGoalExecution(f.goal.session_id!)).toThrow(
    /selected Handoff/,
  );
  expect(() =>
    handoffs.assertBotHandoffAuthority(row.session_id!, {
      execute: true,
      tool: 'read_device_file',
    }),
  ).toThrow();
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare('UPDATE personal_goal_teams SET group_id=? WHERE goal_id=?')
        .run(randomUUID(), f.goal.id),
    ).toThrow(/immutable/);
    expect(() =>
      raw
        .prepare(
          'UPDATE personal_goal_team_steps SET handoff_id=? WHERE run_id=?',
        )
        .run(randomUUID(), claim.id),
    ).toThrow(/immutable/);
    expect(() =>
      raw
        .prepare('DELETE FROM personal_goal_teams WHERE goal_id=?')
        .run(f.goal.id),
    ).toThrow(/retained/);
  } finally {
    raw.close();
  }
});

test('pause/cancel and a stale Scheduler lease fence Team tools; a restrictive pause still works after Bot removal', () => {
  const f = fixture(),
    claim = start(f.task),
    step = teams.admitGoalTeamStep(claim),
    handoff = handoffs.getBotHandoff(step.handoff_id)!;
  expect(() =>
    handoffs.assertBotHandoffAuthority(handoff.session_id!, { execute: true }),
  ).not.toThrow();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw
    .prepare('UPDATE task_runs SET lease_token=lease_token+1 WHERE id=?')
    .run(claim.id);
  raw.close();
  expect(() => teams.admitGoalTeamStep(claim)).toThrow(/SUSPENDED/);
  expect(teams.teamHandoffsForSession(f.goal.session_id!, claim)).toEqual([]);
  let goal = goals.getPersonalGoal('alice', f.goal.id)!;
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'paused',
  });
  expect(() =>
    handoffs.assertBotHandoffAuthority(handoff.session_id!, { execute: true }),
  ).toThrow(/SUSPENDED/);
  expect(goal.budget_max_runs).toBe(2);
  expect(goal.next_action).toBe(f.input.next_action);
  const snapshot = groups.getBotGroupSnapshot('alice', f.groupId);
  groups.patchBotGroupMember('alice', f.groupId, f.memberId, randomUUID(), {
    expected_revision: snapshot.revision,
    state: 'disabled',
  });
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      status: 'pending',
    }),
  ).toThrow(/authorization changed/);
  expect(
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      status: 'cancelled',
    }).status,
  ).toBe('cancelled');
  expect(() => teams.admitGoalTeamStep(claim)).toThrow(/SUSPENDED/);
  expect(teams.listGoalTeamSteps(f.goal.id)).toHaveLength(1);
});

test('cross-owner Group access, disabled admission and missing reviewed grant never create a Team Handoff', () => {
  const f = fixture();
  expect(() =>
    goals.createPersonalGoal(
      'bob',
      randomUUID(),
      { ...f.input, workspace_jid: 'web:bob' },
      f.provision,
    ),
  ).toThrow();
  vi.stubEnv('MINICLAW_GOAL_TEAMS', 'false');
  expect(() =>
    goals.createPersonalGoal('alice', randomUUID(), f.input, f.provision),
  ).toThrow(/ADMISSION_DISABLED/);
  vi.stubEnv('MINICLAW_GOAL_TEAMS', 'true');
  const claim = start(f.task),
    raw = new Database(path.join(root, 'db/messages.db'));
  raw
    .prepare(
      'UPDATE bot_group_runtime_grants SET revoked_at=? WHERE member_id=?',
    )
    .run(new Date().toISOString(), f.memberId);
  raw.close();
  expect(() => teams.admitGoalTeamStep(claim)).toThrow(/NO_AVAILABLE_BOT/);
  expect(teams.listGoalTeamSteps(f.goal.id)).toEqual([]);
  expect(handoffs.listBotHandoffs(f.groupId)).toEqual([]);
});

test('deleting the existing Scheduler definition immediately fences Team tools even before the coordinator observes it', () => {
  const f = fixture(),
    claim = start(f.task),
    step = teams.admitGoalTeamStep(claim),
    row = handoffs.getBotHandoff(step.handoff_id)!;
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    raw
      .prepare('UPDATE scheduled_tasks SET deleted_at=? WHERE id=?')
      .run(new Date().toISOString(), f.task.id);
    expect(() =>
      handoffs.assertBotHandoffAuthority(row.session_id!, {
        execute: true,
        tool: 'create_approved_artifact',
      }),
    ).toThrow(/SUSPENDED/);
    expect(teams.listGoalTeamSteps(f.goal.id)).toHaveLength(1);
  } finally {
    raw.close();
  }
});

test('Workspace scope revocation fences a running Team and Goal budget cannot be reset through pause/resume', () => {
  const f = fixture(),
    claim = start(f.task),
    step = teams.admitGoalTeamStep(claim),
    row = handoffs.getBotHandoff(step.handoff_id)!;
  const workspace = db.getRegisteredGroup('web:alice')!;
  db.setRegisteredGroup('web:alice', {
    ...workspace,
    executionMode: 'container',
  });
  try {
    expect(teams.goalTeamSourceAllowed(f.goal.id)).toBe(false);
    expect(() =>
      handoffs.assertBotHandoffAuthority(row.session_id!, { execute: true }),
    ).toThrow();
    expect(() => teams.admitGoalTeamStep(claim)).toThrow();
  } finally {
    db.setRegisteredGroup('web:alice', workspace);
  }
  let goal = goals.getPersonalGoal('alice', f.goal.id)!;
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision - 1,
      status: 'paused',
    }),
  ).toThrow(/changed/);
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'paused',
  });
  expect(goal).toMatchObject({
    budget_max_runs: 2,
    budget_used_runs: 1,
    next_action: f.input.next_action,
  });
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'cancelled',
  });
  expect(() => teams.admitGoalTeamStep(claim)).toThrow();
  expect(teams.listGoalTeamSteps(goal.id)).toHaveLength(1);
});

test('Chief product choices include only the current Group owner and current available, scoped, reviewed Bot memberships', () => {
  const f = fixture();
  const choices = teams.goalTeamChoices('alice');
  expect(choices.find((item) => item.group_id === f.groupId)).toMatchObject({
    workspace_jid: 'web:alice',
    bots: [{ member_id: f.memberId }],
  });
  expect(
    teams.goalTeamChoices('bob').some((item) => item.group_id === f.groupId),
  ).toBe(false);
  const snapshot = groups.getBotGroupSnapshot('alice', f.groupId);
  groups.patchBotGroupMember('alice', f.groupId, f.memberId, randomUUID(), {
    expected_revision: snapshot.revision,
    state: 'removed',
  });
  expect(
    teams.goalTeamChoices('alice').some((item) => item.group_id === f.groupId),
  ).toBe(false);
});

test('v84 upgrade retains legacy Team and Goal content identity while adding an empty immutable local-resource declaration', () => {
  const f = fixture(),
    before = teams.goalTeam(f.goal.id),
    digest = goals.personalGoalContentDigest(f.goal);
  db.closeDatabase();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    "ALTER TABLE personal_goal_teams DROP COLUMN device_resources;UPDATE router_state SET value='84' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(teams.goalTeam(f.goal.id)).toEqual(before);
  expect(
    goals.personalGoalContentDigest(goals.getPersonalGoal('alice', f.goal.id)!),
  ).toBe(digest);
  const directory = path.join(root, 'db/migration-backups'),
    backup = fs
      .readdirSync(directory)
      .find((name) =>
        name.startsWith(`messages-v84-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      )!;
  expect(backup).toBeTruthy();
  expect(fs.statSync(path.join(directory, backup)).mode & 0o777).toBe(0o600);
  const copy = new Database(path.join(directory, backup), { readonly: true });
  try {
    expect(copy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(
      (
        copy.prepare('PRAGMA table_info(personal_goal_teams)').all() as {
          name: string;
        }[]
      ).some((column) => column.name === 'device_resources'),
    ).toBe(false);
  } finally {
    copy.close();
  }
  const current = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      current
        .prepare(
          "UPDATE personal_goal_teams SET device_resources='[]' WHERE goal_id=?",
        )
        .run(f.goal.id),
    ).toThrow(/immutable/);
  } finally {
    current.close();
  }
});
