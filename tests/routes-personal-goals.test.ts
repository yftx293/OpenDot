import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-personal-goals-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'personal-goal-test-signing-secret',
}));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const auth = await import('../src/auth.js');
const webContext = await import('../src/web-context.js');
const routes = (await import('../src/routes/goals.js')).default;
const cookies = new Map<string, string>();
const trigger =
  vi.fn<
    (
      id: string,
      key?: string,
    ) => { success: boolean; runId?: string; error?: string }
  >();
const cancel = vi.fn<(id: string) => { success: boolean; error?: string }>();

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
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: null,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    cookies.set(id, `miniclaw_session=${auth.signSessionToken(token)}`);
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'container',
      is_home: false,
      added_at: new Date().toISOString(),
    });
  }
  webContext.setWebDeps({
    triggerTaskRun: trigger,
    cancelTaskRun: cancel,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});
beforeEach(() => {
  vi.stubEnv('MINICLAW_PERSONAL_GOALS', 'true');
  trigger.mockImplementation((id, key) => {
    const reason = goals.personalGoalTaskBlockReason(id);
    if (reason) return { success: false, error: reason };
    const task = db.getTaskById(id)!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: key,
    });
    return { success: true, runId: created.run.id };
  });
  cancel.mockImplementation((id) => ({ success: db.cancelTaskRun(id) }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(
  url: string,
  method = 'GET',
  body?: unknown,
  user = 'alice',
  key?: string,
) {
  return routes.request(url, {
    method,
    headers: {
      cookie: cookies.get(user)!,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function createGoal() {
  const response = await request(
    '/',
    'POST',
    {
      workspace_jid: 'web:alice',
      objective: 'Review project',
      completion_criteria: ['Deliver findings'],
      budget_max_runs: 1,
    },
    'alice',
    randomUUID(),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { goal: PersonalGoal }).goal;
}
async function linkTask(goal: PersonalGoal) {
  const id = randomUUID();
  db.createTask({
    id,
    group_folder: 'alice',
    chat_jid: 'web:alice',
    prompt: 'Inspect project',
    script_command: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    next_run: new Date().toISOString(),
    status: 'paused',
    created_at: new Date().toISOString(),
    created_by: 'alice',
  });
  const response = await request(`/${goal.id}/tasks`, 'POST', {
    task_id: id,
    expected_revision: goal.revision,
  });
  expect(response.status).toBe(200);
  return {
    task: db.getTaskById(id)!,
    goal: ((await response.json()) as { goal: PersonalGoal }).goal,
  };
}

describe('Personal Goal API with real signed-session authentication', () => {
  test('requires authentication and the explicit rollout flag', async () => {
    expect((await routes.request('/')).status).toBe(401);
    vi.stubEnv('MINICLAW_PERSONAL_GOALS', 'false');
    expect((await request('/')).status).toBe(404);
    const availability = await request('/availability');
    expect(availability.status).toBe(200);
    expect(await availability.json()).toEqual({ enabled: false });
  });
  test('rejects an expired signed session', async () => {
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: 'alice',
      ip_address: null,
      user_agent: null,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(
      (
        await routes.request('/', {
          headers: {
            cookie: `miniclaw_session=${auth.signSessionToken(token)}`,
          },
        })
      ).status,
    ).toBe(401);
  });
  test('requires creation idempotency and rejects same-key changed content', async () => {
    const input = {
      workspace_jid: 'web:alice',
      objective: 'A',
      completion_criteria: ['Report'],
    };
    expect((await request('/', 'POST', input)).status).toBe(400);
    const key = randomUUID();
    const first = await request('/', 'POST', input, 'alice', key);
    const repeat = await request('/', 'POST', input, 'alice', key);
    expect(((await first.json()) as { goal: PersonalGoal }).goal.id).toBe(
      ((await repeat.json()) as { goal: PersonalGoal }).goal.id,
    );
    expect(
      (await request('/', 'POST', { ...input, objective: 'B' }, 'alice', key))
        .status,
    ).toBe(409);
  });
  test('denies cross-user reads and writes even for an admin', async () => {
    const goal = await createGoal();
    expect((await request(`/${goal.id}`, 'GET', undefined, 'bob')).status).toBe(
      404,
    );
    expect(
      (
        await request(
          `/${goal.id}`,
          'PATCH',
          { expected_revision: goal.revision, status: 'cancelled' },
          'bob',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          '/',
          'POST',
          {
            workspace_jid: 'web:alice',
            objective: 'No',
            completion_criteria: ['No'],
          },
          'bob',
          randomUUID(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        (await (await request('/', 'GET', undefined, 'bob')).json()) as {
          goals: unknown[];
        }
      ).goals,
    ).toEqual([]);
  });
  test('returns conflict for a stale Goal revision', async () => {
    const goal = await createGoal();
    expect(
      (
        await request(`/${goal.id}`, 'PATCH', {
          expected_revision: goal.revision,
          status: 'paused',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/${goal.id}`, 'PATCH', {
          expected_revision: goal.revision,
          next_action: 'stale',
        })
      ).status,
    ).toBe(409);
  });
  test('uses existing Scheduler receipts and does not queue a duplicate after cancellation', async () => {
    const linked = await linkTask(await createGoal());
    const key = randomUUID();
    const payload = { expected_task_revision: linked.task.revision };
    const first = await request(
      `/${linked.goal.id}/tasks/${linked.task.id}/run`,
      'POST',
      payload,
      'alice',
      key,
    );
    expect(first.status).toBe(202);
    const runId = ((await first.json()) as { runId: string }).runId;
    const cancelled = await request(`/${linked.goal.id}`, 'PATCH', {
      expected_revision: linked.goal.revision,
      status: 'cancelled',
    });
    expect(cancelled.status).toBe(200);
    expect(db.getTaskRunById(runId)?.status).toBe('cancelled');
    const retry = await request(
      `/${linked.goal.id}/tasks/${linked.task.id}/run`,
      'POST',
      payload,
      'alice',
      key,
    );
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { runId: string }).runId).toBe(runId);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(
      (
        await request(
          `/${linked.goal.id}/tasks/${linked.task.id}/run`,
          'POST',
          { expected_task_revision: linked.task.revision + 1 },
          'alice',
          key,
        )
      ).status,
    ).toBe(409);
  });
  test('does not mark a Goal cancelled when stopping its active run fails', async () => {
    const linked = await linkTask(await createGoal());
    await request(
      `/${linked.goal.id}/tasks/${linked.task.id}/run`,
      'POST',
      { expected_task_revision: linked.task.revision },
      'alice',
      randomUUID(),
    );
    cancel.mockImplementationOnce(() => ({
      success: false,
      error: 'worker unavailable',
    }));
    const response = await request(`/${linked.goal.id}`, 'PATCH', {
      expected_revision: linked.goal.revision,
      status: 'cancelled',
    });
    expect(response.status).toBe(409);
    const data = (await response.json()) as {
      goal: PersonalGoal;
      code: string;
    };
    expect(data.code).toBe('GOAL_STOP_PENDING');
    expect(data.goal.status).toBe('paused');
    expect(data.goal.status).not.toBe('cancelled');
  });
  test('hides Goal data immediately when workspace ownership is revoked', async () => {
    const goal = await createGoal();
    const group = db.getRegisteredGroup('web:alice')!;
    db.setRegisteredGroup('web:alice', { ...group, created_by: 'bob' });
    try {
      expect((await request(`/${goal.id}`)).status).toBe(404);
      expect(
        (
          await request(`/${goal.id}`, 'PATCH', {
            expected_revision: goal.revision,
            status: 'running',
          })
        ).status,
      ).toBe(404);
    } finally {
      db.setRegisteredGroup('web:alice', group);
    }
  });
});
