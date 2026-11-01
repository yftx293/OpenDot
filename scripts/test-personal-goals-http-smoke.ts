import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';

// Actual HTTP and compiled backend; intentionally no model, tool, or channel execution.
const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function availablePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function main(): Promise<void> {
  assert(
    fs.existsSync(path.join(repository, 'dist/index.js')),
    'Build backend first',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-goal-http-'));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let cookie = '';
  const checks: string[] = [];
  const check = (name: string, value: unknown) => {
    assert(value, name);
    checks.push(name);
  };
  async function request<T>(
    url: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ): Promise<{ status: number; body: T; response: Response }> {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as T,
      response,
    };
  }
  async function start(): Promise<void> {
    child = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      // Do not inherit provider credentials or the user's HOME configuration.
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        NODE_ENV: 'test',
        TZ: 'Asia/Taipei',
        WEB_PORT: String(port),
        MINICLAW_PERSONAL_GOALS: 'true',
      },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      assert(
        child.exitCode === null && child.signalCode === null,
        'Backend exited before readiness',
      );
      try {
        const result = await request<{ status: string }>('/api/health');
        if (result.status === 200 && result.body.status === 'healthy') return;
      } catch {
        // Connection refusal is expected until the listener starts.
      }
      await delay(100);
    }
    throw new Error('Backend readiness timed out');
  }
  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const processToStop = child;
    let forced = false;
    const closed = once(processToStop, 'close');
    const timeout = setTimeout(() => {
      forced = true;
      processToStop.kill('SIGKILL');
    }, 10_000);
    processToStop.kill('SIGINT');
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
      child = undefined;
    }
    assert(
      !forced && processToStop.exitCode === 0,
      'Backend did not shut down cleanly',
    );
  }
  try {
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
    fs.symlinkSync(path.join(repository, 'web'), path.join(root, 'web'), 'dir');
    fs.symlinkSync(
      path.join(repository, 'container'),
      path.join(root, 'container'),
      'dir',
    );
    await start();
    check(
      'unauthenticated_denied',
      (await request('/api/goals')).status === 401,
    );
    const setup = await request('/api/auth/setup', 'POST', {
      username: 'goal_smoke',
      password: `Goal9!${randomBytes(24).toString('hex')}`,
    });
    assert.equal(setup.status, 201, 'Disposable administrator setup failed');
    cookie = setup.response.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert(cookie, 'Setup did not return a session cookie');
    const groups = await request<{
      groups: Record<string, { folder: string }>;
    }>('/api/groups');
    const workspace = Object.keys(groups.body.groups).find((jid) =>
      jid.startsWith('web:'),
    );
    assert(workspace, 'Disposable home workspace missing');
    const key = randomUUID();
    const payload = {
      workspace_jid: workspace,
      objective: 'Verify local Goal lifecycle without invoking a model',
      completion_criteria: ['Persist state and reject execution while paused'],
      budget_max_runs: 1,
    };
    const created = await request<{ goal: PersonalGoal }>(
      '/api/goals',
      'POST',
      payload,
      key,
    );
    assert.equal(created.status, 201, 'Goal creation failed');
    let goal = created.body.goal;
    const repeated = await request<{ goal: PersonalGoal }>(
      '/api/goals',
      'POST',
      payload,
      key,
    );
    check(
      'same_creation_receipt',
      repeated.status === 201 && repeated.body.goal.id === goal.id,
    );
    const goalUrl = `/api/goals/${goal.id}`;
    const paused = await request<{ goal: PersonalGoal }>(goalUrl, 'PATCH', {
      expected_revision: goal.revision,
      status: 'paused',
    });
    assert.equal(paused.status, 200, 'Pause failed');
    goal = paused.body.goal;
    check('paused_persisted', goal.status === 'paused');
    check(
      'stale_revision_denied',
      (
        await request(goalUrl, 'PATCH', {
          expected_revision: 1,
          status: 'pending',
        })
      ).status === 409,
    );
    const task = await request<{ taskId: string }>('/api/tasks', 'POST', {
      group_folder: groups.body.groups[workspace].folder,
      chat_jid: workspace,
      prompt: 'This future task must never execute during the smoke',
      execution_type: 'agent',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal(task.status, 200, 'Task creation failed');
    const taskId = task.body.taskId;
    const tasks = await request<{ tasks: { id: string; revision: number }[] }>(
      '/api/tasks',
    );
    const definition = tasks.body.tasks.find((item) => item.id === taskId);
    assert(definition, 'Task definition missing');
    assert.equal(
      (
        await request(`/api/tasks/${taskId}`, 'PATCH', {
          expected_revision: definition.revision,
          status: 'paused',
        })
      ).status,
      200,
      'Task pause failed',
    );
    const linked = await request<{ goal: PersonalGoal }>(
      `${goalUrl}/tasks`,
      'POST',
      {
        task_id: taskId,
        expected_revision: goal.revision,
      },
    );
    assert.equal(linked.status, 200, 'Task link failed');
    goal = linked.body.goal;
    check(
      'paused_goal_blocks_real_scheduler',
      (
        await request(
          `${goalUrl}/tasks/${taskId}/run`,
          'POST',
          {
            expected_task_revision: definition.revision + 1,
          },
          randomUUID(),
        )
      ).status === 409,
    );
    const detail = await request<{
      tasks: { id: string }[];
      executions: unknown[];
    }>(goalUrl);
    check(
      'linked_task_visible',
      detail.body.tasks.some((item) => item.id === taskId),
    );
    check('no_agent_execution', detail.body.executions.length === 0);
    const cancelled = await request<{ goal: PersonalGoal }>(goalUrl, 'PATCH', {
      expected_revision: goal.revision,
      status: 'cancelled',
    });
    check(
      'cancelled_persisted',
      cancelled.status === 200 && cancelled.body.goal.status === 'cancelled',
    );
    await stop();
    await start();
    const restored = await request<{
      goal: PersonalGoal;
      executions: unknown[];
    }>(goalUrl);
    check(
      'goal_and_login_survive_backend_restart',
      restored.status === 200 &&
        restored.body.goal.status === 'cancelled' &&
        restored.body.executions.length === 0,
    );
    check(
      'health_after_restart',
      (await request<{ status: string }>('/api/health')).body.status ===
        'healthy',
    );
    process.stdout.write(
      `${JSON.stringify({ passed: checks, liveModel: false, externalDelivery: false }, null, 2)}\n`,
    );
  } finally {
    try {
      await stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

void main().catch(() => {
  process.stderr.write(
    'Personal Goal HTTP smoke failed; response bodies and credentials suppressed\n',
  );
  process.exitCode = 1;
});
