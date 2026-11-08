// Actual product SQLite, existing Scheduler claims, encrypted Provider and local
// HTTP/SSE transport. Model text is a fixture; this is not Cloud deployment proof.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { ClaimedTaskRun } from '../src/types.js';
import type {
  CloudBinding,
  CloudExecutionGrant,
} from '../src/personal-agent/cloud-wire.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-goal-execution-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
const runtime = await import('../src/personal-agent/product-runtime.js');
const config = await import('../src/runtime-config.js');
const model = await import('../src/personal-agent/product-model.js');
const host = await import('../src/host-execution-policy.js');
const wire = await import('../src/personal-agent/cloud-wire.js');
const approvals = await import('../src/personal-agent/approval-store.js');
const artifacts = await import('../src/personal-agent/artifact-effect.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
const objectId = 'a'.repeat(64);
const secret = 'synthetic-cloud-goal-execution-signing-key';
let providerId = '',
  calls = 0,
  hold = false;
const held = new Set<ServerResponse>();
const provider = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  calls++;
  expect(request.url).toBe('/v1/chat/completions');
  expect(request.headers.authorization).toBe(
    'Bearer synthetic-goal-provider-key',
  );
  const input = JSON.parse(raw);
  expect(input.model).toBe('goal-fixture-model');
  expect(input.execution).toBeUndefined();
  if (hold) {
    held.add(response);
    response.on('close', () => held.delete(response));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    'data: {"choices":[{"delta":{"content":"CLOUD_GOAL_MODEL_FIXTURE"},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
  );
});
const rawDb = () => new Database(path.join(root, 'db/messages.db'));
function withDb<T>(fn: (value: Database.Database) => T): T {
  const value = rawDb();
  try {
    return fn(value);
  } finally {
    value.close();
  }
}
beforeAll(async () => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const owner of ['alice', 'bob']) {
    db.createUser({
      id: owner,
      username: owner,
      password_hash: 'fixture',
      display_name: owner,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.setRegisteredGroup(`web:${owner}`, {
      name: owner,
      folder: owner,
      created_by: owner,
      executionMode: 'host',
      is_home: false,
      added_at: now,
    });
  }
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  providerId = config.createProvider({
    name: 'Cloud Goal HTTP fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    anthropicApiKey: 'synthetic-goal-provider-key',
    anthropicModel: 'goal-fixture-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  }).id;
  runtime.startProductRuntimeService();
});
afterEach(() => {
  hold = false;
  host.endHostPrivilegeRevocation('alice');
  for (const response of held) response.destroy();
  for (const run of db.getTaskRunsByStatus(['queued', 'running', 'retry_wait']))
    db.cancelTaskRun(run.id);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await runtime.getProductRuntimeService().close();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function managed(owner = 'alice', cloud = true, budget = 3, bindCloud = true) {
  const goal = goals.createPersonalGoal(
    owner,
    randomUUID(),
    {
      workspace_jid: `web:${owner}`,
      objective: 'Produce bounded approved research',
      completion_criteria: ['artifact_contains:research evidence'],
      budget_max_runs: budget,
    },
    (goal) => {
      const sessionId = randomUUID(),
        taskId = randomUUID(),
        now = new Date().toISOString();
      const selected = model.productModelConfiguration(
        goal.workspace_jid,
        providerId,
      );
      db.createAgent(
        {
          id: sessionId,
          chat_jid: goal.workspace_jid,
          group_folder: owner,
          name: 'Cloud Goal',
          prompt: '',
          kind: 'conversation',
          status: 'idle',
          created_by: owner,
          created_at: now,
          completed_at: null,
          result_summary: null,
          last_im_jid: null,
          spawned_from_jid: null,
        },
        {
          kind: 'pi-durable',
          providerId,
          configFingerprint: selected.fingerprint,
          goalId: goal.id,
          ...(cloud
            ? {
                cloud: {
                  runtime_id: randomUUID(),
                  gateway_origin: 'https://cloud.fixture',
                  model_id: selected.modelId,
                  instructions: 'Use only explicitly granted Cloud tools.',
                  max_model_steps: 24,
                  deadline_at: Date.now() + 60000,
                  tool_capabilities: ['create_approved_artifact'],
                },
              }
            : {}),
        },
      );
      db.createTask({
        id: taskId,
        chat_jid: goal.workspace_jid,
        group_folder: owner,
        prompt: 'Advance Goal',
        schedule_type: 'interval',
        schedule_value: '86400000',
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'host',
        script_command: null,
        next_run: null,
        status: 'paused',
        created_by: owner,
        created_at: now,
      });
      goals.attachAutomaticGoalSession(owner, goal.id, sessionId);
      goals.linkPersonalGoalTask(owner, goal.id, taskId, goal.revision);
      goals.markAutomaticGoalTask(goal.id, taskId);
    },
  );
  const sessionId = goal.session_id!;
  if (cloud && bindCloud) {
    product.bindCloudObject(
      sessionId,
      product.getCloudPlacement(sessionId)!.runtime_id,
      objectId,
    );
    product.bindProductConversation(sessionId, 1);
  }
  return {
    goal,
    sessionId,
    task: db.getTaskById(goals.listPersonalGoalTaskIds(owner, goal.id)[0])!,
  };
}
function start(
  value: ReturnType<typeof managed>,
  owner = 'scheduler',
): ClaimedTaskRun {
  const created = db.createTaskRun({
    task: value.task,
    triggerType: 'manual',
  }).run;
  const claim = db.claimNextTaskRun(owner, 60000)!;
  expect(claim.id).toBe(created.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  return claim;
}
function binding(id: string): CloudBinding {
  return JSON.parse(product.getCloudPlacement(id)!.binding_json);
}
function ref(grant: CloudExecutionGrant) {
  return {
    goal_id: grant.goal_id,
    run_id: grant.run_id,
    context_digest: grant.context_digest,
  };
}
async function call(id: string, suffix: string, body: unknown) {
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
  return routes.fetch(
    await wire.signedRequest(
      secret,
      binding(id),
      `https://product.fixture/api/cloud-runtime/${id}/objects/${objectId}/${suffix}`,
      'POST',
      JSON.stringify(body),
    ),
  );
}
const request = {
  model: 'goal-fixture-model',
  stream: true,
  messages: [{ role: 'user', content: 'Bounded research fixture' }],
  max_tokens: 128,
};
function expire(id: string) {
  withDb((raw) =>
    raw
      .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), id),
  );
}
function steps(sessionId: string, runId: string) {
  return withDb((raw) => ({
    session: (
      raw
        .prepare(
          'SELECT model_attempts FROM product_cloud_sessions WHERE session_id=?',
        )
        .get(sessionId) as { model_attempts: number }
    ).model_attempts,
    cloud: (
      raw
        .prepare(
          'SELECT model_attempts FROM product_cloud_executions WHERE run_id=?',
        )
        .get(runId) as { model_attempts: number }
    ).model_attempts,
    goal: (
      raw
        .prepare(
          'SELECT generation_steps FROM goal_execution_contexts WHERE run_id=?',
        )
        .get(runId) as { generation_steps: number }
    ).generation_steps,
  }));
}

test('new Cloud Goal ownership is atomic, explicit and freezes only Cloud-compatible capabilities', () => {
  const value = managed();
  expect(product.productRouterKind(value.sessionId)).toBe('cloudflare-durable');
  expect(binding(value.sessionId).goal_id).toBe(value.goal.id);
  expect(
    goals.snapshotPersonalGoalExecution(value.task.id)?.capabilities,
  ).toEqual(['inspect_text', 'create_approved_artifact']);
  const node = managed('bob', false);
  expect(product.productRouterKind(node.sessionId)).toBe('node-durable');
  expect(
    goals.snapshotPersonalGoalExecution(node.task.id)?.capabilities,
  ).toContain('read_workspace_file');
  expect(() =>
    product.issueCloudGoalExecution(value.sessionId, {
      id: randomUUID(),
      lease_owner: 'invented',
      lease_token: 1,
    }),
  ).toThrow();
  expect(() =>
    product.issueCloudGoalExecution(node.sessionId, start(node)),
  ).toThrow('current Scheduler claim');
});

test('a grant survives database reopen and claim takeover without renewing identity, budget or deadline', async () => {
  const value = managed(),
    first = start(value);
  const grant = product.issueCloudGoalExecution(value.sessionId, first);
  product.admitCloudModelAttempt(
    value.sessionId,
    randomUUID(),
    'a'.repeat(64),
    ref(grant),
  );
  expect(steps(value.sessionId, first.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
  db.closeDatabase();
  db.initDatabase();
  expect(product.issueCloudGoalExecution(value.sessionId, first)).toEqual(
    grant,
  );
  expire(first.id);
  expect(db.failExpiredStartedTaskRuns()).toBe(0);
  const recovered = db.claimNextTaskRun('recovered', 60000)!;
  expect(recovered.id).toBe(first.id);
  expect(recovered.lease_token).toBeGreaterThan(first.lease_token);
  expect(
    db.markTaskRunExecutionStarted(
      recovered.id,
      recovered.lease_owner,
      recovered.lease_token,
    ),
  ).toBe(true);
  expect(() => product.issueCloudGoalExecution(value.sessionId, first)).toThrow(
    'current Scheduler claim',
  );
  expect(product.issueCloudGoalExecution(value.sessionId, recovered)).toEqual(
    grant,
  );
  expect(steps(value.sessionId, first.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
  expect(goals.getPersonalGoal('alice', value.goal.id)?.budget_used_runs).toBe(
    1,
  );
});

test('managed model requests require the exact persisted grant and use the encrypted Provider through real HTTP', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const before = calls;
  expect(
    (await call(value.sessionId, `model/${randomUUID()}`, request)).status,
  ).toBe(400);
  expect(
    (
      await call(value.sessionId, `model/${randomUUID()}`, {
        request,
        execution: { ...ref(grant), context_digest: 'b'.repeat(64) },
      })
    ).status,
  ).toBe(409);
  const other = managed('bob');
  expect(
    (
      await call(other.sessionId, `model/${randomUUID()}`, {
        request,
        execution: ref(grant),
      })
    ).status,
  ).toBe(409);
  expect(calls).toBe(before);
  const id = randomUUID();
  const response = await call(value.sessionId, `model/${id}`, {
    request,
    execution: ref(grant),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('CLOUD_GOAL_MODEL_FIXTURE');
  expect(calls).toBe(before + 1);
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
  expect(
    (
      await call(value.sessionId, `model/${id}`, {
        request,
        execution: ref(grant),
      })
    ).status,
  ).toBe(409);
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
  expect(calls).toBe(before + 1);
  expect(
    withDb((raw) =>
      raw
        .prepare(
          'SELECT run_id FROM product_cloud_execution_attempts WHERE session_id=? AND request_id=?',
        )
        .get(value.sessionId, id),
    ),
  ).toEqual({ run_id: claim.id });
});

test('each existing Scheduler occurrence has 12 persisted model steps; new runs do not recharge old grants', async () => {
  const value = managed();
  let prior: CloudExecutionGrant | undefined;
  for (let occurrence = 0; occurrence < 3; occurrence++) {
    const claim = start(value),
      grant = product.issueCloudGoalExecution(value.sessionId, claim);
    if (prior) {
      expect(() =>
        product.admitCloudModelAttempt(
          value.sessionId,
          randomUUID(),
          'a'.repeat(64),
          ref(prior!),
        ),
      ).toThrow('suspended');
      expect(
        product.requireCloudExecution(value.sessionId, ref(prior), true),
      ).toEqual(prior);
    }
    for (let i = 0; i < 12; i++)
      product.admitCloudModelAttempt(
        value.sessionId,
        randomUUID(),
        'a'.repeat(64),
        ref(grant),
      );
    expect(steps(value.sessionId, claim.id)).toEqual({
      session: (occurrence + 1) * 12,
      cloud: 12,
      goal: 12,
    });
    expect(() =>
      product.admitCloudModelAttempt(
        value.sessionId,
        randomUUID(),
        'a'.repeat(64),
        ref(grant),
      ),
    ).toThrow('budget exhausted');
    expect(steps(value.sessionId, claim.id)).toEqual({
      session: (occurrence + 1) * 12,
      cloud: 12,
      goal: 12,
    });
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
      }),
    ).toBe(true);
    prior = grant;
  }
  expect(goals.getPersonalGoal('alice', value.goal.id)?.budget_used_runs).toBe(
    3,
  );
  expect(binding(value.sessionId).max_model_steps).toBe(24);
});

test('a duplicate or failed attempt transaction rolls back both counters and the association', () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const id = randomUUID();
  withDb((raw) =>
    raw.exec(
      `CREATE TRIGGER inject_cloud_attempt_failure BEFORE INSERT ON product_cloud_execution_attempts BEGIN SELECT RAISE(ABORT,'injected association failure'); END`,
    ),
  );
  try {
    expect(() =>
      product.admitCloudModelAttempt(
        value.sessionId,
        id,
        'a'.repeat(64),
        ref(grant),
      ),
    ).toThrow('injected association failure');
    expect(steps(value.sessionId, claim.id)).toEqual({
      session: 0,
      cloud: 0,
      goal: 0,
    });
    expect(
      withDb((raw) =>
        raw
          .prepare(
            'SELECT * FROM product_cloud_model_attempts WHERE session_id=? AND request_id=?',
          )
          .get(value.sessionId, id),
      ),
    ).toBeUndefined();
  } finally {
    withDb((raw) => raw.exec('DROP TRIGGER inject_cloud_attempt_failure'));
  }
  product.admitCloudModelAttempt(
    value.sessionId,
    id,
    'a'.repeat(64),
    ref(grant),
  );
  expect(() =>
    product.admitCloudModelAttempt(
      value.sessionId,
      id,
      'b'.repeat(64),
      ref(grant),
    ),
  ).toThrow('already admitted');
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
});

test('pause, cancellation and expired claims fence new model requests, while authorized history remains readable', async () => {
  for (const status of ['paused', 'cancelled'] as const) {
    const value = managed(),
      claim = start(value),
      grant = product.issueCloudGoalExecution(value.sessionId, claim);
    const current = goals.getPersonalGoal('alice', value.goal.id)!;
    goals.patchPersonalGoal('alice', value.goal.id, {
      status,
      expected_revision: current.revision,
    });
    expect(
      (
        await call(value.sessionId, `model/${randomUUID()}`, {
          request,
          execution: ref(grant),
        })
      ).status,
    ).not.toBe(200);
    expect(
      product.requireCloudExecution(value.sessionId, ref(grant), true),
    ).toEqual(grant);
    const read = await call(value.sessionId, 'policy', {
      binding_digest: await wire.bindingDigest(binding(value.sessionId)),
      gateway_origin: 'https://cloud.fixture',
      purpose: 'read',
    });
    expect(read.status).toBe(200);
    db.cancelTaskRun(claim.id);
  }
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  expire(claim.id);
  expect(() =>
    product.requireCloudExecution(value.sessionId, ref(grant)),
  ).toThrow();
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 0,
    cloud: 0,
    goal: 0,
  });
});

test('Workspace/Host permission revocation aborts a live managed model request without admitting another attempt', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  hold = true;
  const before = calls;
  const pending = call(value.sessionId, `model/${randomUUID()}`, {
    request,
    execution: ref(grant),
  });
  await vi.waitFor(() => expect(calls).toBe(before + 1));
  host.beginHostPrivilegeRevocation('alice');
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic-goal-provider-key');
  expect(
    (
      await call(value.sessionId, `model/${randomUUID()}`, {
        request,
        execution: ref(grant),
      })
    ).status,
  ).not.toBe(200);
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
});

test('grant bytes, deadline and attempt identity cannot be edited; execution policy verifies the full grant digest', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  withDb((raw) => {
    expect(() =>
      raw
        .prepare(
          "UPDATE product_cloud_executions SET grant_json=json_set(grant_json,'$.deadline_at',?) WHERE run_id=?",
        )
        .run(Date.now() + 999999999, claim.id),
    ).toThrow('immutable');
    expect(() =>
      raw
        .prepare(
          'UPDATE product_cloud_executions SET grant_digest=? WHERE run_id=?',
        )
        .run('b'.repeat(64), claim.id),
    ).toThrow('immutable');
  });
  const body = {
    binding_digest: await wire.bindingDigest(binding(value.sessionId)),
    gateway_origin: 'https://cloud.fixture',
    execution: ref(grant),
  };
  expect((await call(value.sessionId, 'policy', body)).status).toBe(409);
  expect(
    (
      await call(value.sessionId, 'policy', {
        ...body,
        execution_grant_digest: await wire.executionGrantDigest({
          ...grant,
          deadline_at: grant.deadline_at + 1,
        }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(value.sessionId, 'policy', {
        ...body,
        execution_grant_digest: await wire.executionGrantDigest(grant),
      })
    ).status,
  ).toBe(200);
});

test('an expired execution grant is never renewed by the Scheduler', () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const issuedAt = grant.issued_at;
  // Advance only the grant clock with a real, independently extended DB lease.
  withDb((raw) =>
    raw
      .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
      .run(new Date(issuedAt + 2 * 86400000).toISOString(), claim.id),
  );
  const now = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 86400001);
  try {
    expect(() =>
      product.issueCloudGoalExecution(value.sessionId, claim),
    ).toThrow('suspended');
    expect(
      product.requireCloudExecution(value.sessionId, ref(grant), true),
    ).toEqual(grant);
  } finally {
    now.mockRestore();
  }
});

test('a current Goal grant outlives the old pilot Session deadline without editing the immutable binding', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const original = product.getCloudPlacement(value.sessionId)!.binding_json;
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(binding(value.sessionId).deadline_at + 1);
  try {
    const response = await call(value.sessionId, `model/${randomUUID()}`, {
      request,
      execution: ref(grant),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('CLOUD_GOAL_MODEL_FIXTURE');
  } finally {
    now.mockRestore();
  }
  expect(product.getCloudPlacement(value.sessionId)!.binding_json).toBe(
    original,
  );
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
});

test('input proofs preserve the original Goal execution after takeover and reject a substituted or omitted run', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const input = product.admitProductInput(
    value.sessionId,
    `goal-run:${claim.id}`,
    {
      sender: 'alice',
      senderName: 'Goal',
      content: 'original bounded context',
      followUpBehavior: 'queue',
      execution: {
        goalId: grant.goal_id,
        runId: grant.run_id,
        contextDigest: grant.context_digest,
      },
    },
    () => undefined,
  );
  const proof = {
    input: {
      request_id: input.request_id,
      content: 'original bounded context',
      when_busy: 'followUp',
      product_receipt_digest: input.payload_digest,
      execution: ref(grant),
    },
    native: { status: 'missing', submission_id: null },
  };
  expect((await call(value.sessionId, 'inputs', proof)).status).toBe(200);
  expect(
    (
      await call(value.sessionId, 'inputs', {
        ...proof,
        input: { ...proof.input, execution: undefined },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(value.sessionId, 'inputs', {
        ...proof,
        input: {
          ...proof.input,
          execution: { ...ref(grant), run_id: randomUUID() },
        },
      })
    ).status,
  ).toBe(409);
  product.markProductInputSubmitted(input.id, 11);
  expect(
    db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'success',
    }),
  ).toBe(true);
  const later = start(value),
    nextGrant = product.issueCloudGoalExecution(value.sessionId, later);
  expect(
    (
      await call(value.sessionId, 'inputs', {
        ...proof,
        native: { submission_id: 11, status: 'done' },
        purpose: 'read',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(value.sessionId, 'inputs', {
        ...proof,
        native: { submission_id: 11, status: 'placed' },
      })
    ).status,
  ).not.toBe(200);
  expect(
    (
      await call(value.sessionId, 'inputs', {
        ...proof,
        input: { ...proof.input, execution: ref(nextGrant) },
        native: { submission_id: 11, status: 'placed' },
      })
    ).status,
  ).toBe(409);
});

test('Cloud approvals are scoped to the original Goal/run, produce real evidence, and cannot move to a later occurrence', async () => {
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const parameters = { content: 'research evidence from Cloud Goal fixture' };
  const intent = {
    id: 'task:10',
    task_id: 10,
    generation_task_id: 9,
    conversation_id: 1,
    call_id: 'goal-artifact-call',
    name: 'create_approved_artifact',
    parameters,
    parameters_digest: await wire.digest(JSON.stringify(parameters)),
    execution: ref(grant),
  };
  const proposed = await call(value.sessionId, 'tools', {
    ...intent,
    phase: 'propose',
  });
  expect(proposed.status).toBe(200);
  const proposal = (await proposed.json()) as {
    output: {
      approval_id: string;
      parameters_digest: string;
      content_digest: string;
    };
  };
  const approval = approvals.getProductApproval(
    proposal.output.approval_id,
    'alice',
  );
  expect(approval).toMatchObject({
    goal_id: value.goal.id,
    run_id: claim.id,
    task_id: value.task.id,
    state: 'pending',
  });
  expect(goals.getPersonalGoal('alice', value.goal.id)?.status).toBe(
    'waiting_for_approval',
  );
  approvals.decideProductApproval(
    'alice',
    approval.id,
    approval.parameters_digest,
    'approve',
    randomUUID(),
  );
  const execute = await call(value.sessionId, 'tools', {
    ...intent,
    phase: 'execute',
    approval_id: approval.id,
  });
  expect(execute.status).toBe(200);
  expect(
    ((await execute.json()) as { output: { state: string } }).output.state,
  ).toBe('completed');
  expect(artifacts.readApprovedArtifact(approval.id, 'alice')).toBe(
    parameters.content,
  );
  const evidence = [
    {
      artifact_id: approval.id,
      content_digest: approval.content_digest,
      criteria_matches: [true],
    },
  ];
  const settled = goals.settlePersonalGoalExecution(
    {
      runId: claim.id,
      sessionId: value.sessionId,
      leaseOwner: claim.lease_owner,
      leaseToken: claim.lease_token,
      modelCompleted: true,
      evidence,
    },
    () =>
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
      }),
    () => {
      throw new Error('Completed evidence must not enqueue another occurrence');
    },
  );
  expect(settled).toBe(true);
  expect(goals.getPersonalGoal('alice', value.goal.id)?.status).toBe(
    'completed',
  );
  expect(goals.listGoalExecutionEvidence('alice', value.goal.id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ evidence })]),
  );
  expect(
    (
      await call(value.sessionId, 'tools', {
        ...intent,
        phase: 'execute',
        approval_id: approval.id,
      })
    ).status,
  ).not.toBe(200);
  const status = await call(value.sessionId, 'tools', {
    ...intent,
    phase: 'status',
    approval_id: approval.id,
  });
  expect(status.status).toBe(200);
  expect(
    ((await status.json()) as { output: { state: string } }).output.state,
  ).toBe('completed');
});

test('an attached Node Goal cannot be adopted into Cloud even while its local runtime is provisioning', () => {
  const node = managed('alice', false),
    template = managed('bob');
  const cloud = product.getCloudPlacement(template.sessionId)!;
  const newBinding = {
    ...binding(template.sessionId),
    session_id: node.sessionId,
    owner_user_id: 'alice',
    workspace_jid: 'web:alice',
    runtime_id: randomUUID(),
    goal_id: node.goal.id,
  };
  withDb((raw) =>
    expect(() =>
      raw
        .prepare(
          'INSERT INTO product_cloud_sessions(session_id,runtime_id,gateway_origin,binding_json,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          node.sessionId,
          newBinding.runtime_id,
          cloud.gateway_origin,
          JSON.stringify(newBinding),
          cloud.created_at,
        ),
    ).toThrow('must precede runtime admission'),
  );
  expect(product.productRouterKind(node.sessionId)).toBe('node-durable');
  expect(product.getCloudPlacement(node.sessionId)).toBeUndefined();
});

test('concurrent model admissions cannot overdraw the Goal budget or recharge the same request', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const before = calls;
  const replies = await Promise.all(
    Array.from({ length: 14 }, () =>
      call(value.sessionId, `model/${randomUUID()}`, {
        request,
        execution: ref(grant),
      }),
    ),
  );
  expect(replies.filter((reply) => reply.status === 200)).toHaveLength(12);
  for (const response of replies) await response.text();
  expect(calls).toBe(before + 12);
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 12,
    cloud: 12,
    goal: 12,
  });
  db.cancelTaskRun(claim.id);
  const other = managed(),
    nextClaim = start(other),
    next = product.issueCloudGoalExecution(other.sessionId, nextClaim),
    id = randomUUID();
  const duplicate = await Promise.all(
    [1, 2].map(() =>
      call(other.sessionId, `model/${id}`, { request, execution: ref(next) }),
    ),
  );
  expect(duplicate.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  for (const response of duplicate) await response.text();
  expect(calls).toBe(before + 13);
  expect(steps(other.sessionId, nextClaim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
});

test('existing Scheduler admission refuses another occurrence during execution, expired lease or retry wait', () => {
  for (const cloud of [true, false])
    for (const phase of ['running', 'expired', 'retry_wait']) {
      const value = managed('alice', cloud),
        first = start(value);
      const grant = cloud
        ? product.issueCloudGoalExecution(value.sessionId, first)
        : undefined;
      if (phase === 'expired') expire(first.id);
      if (phase === 'retry_wait')
        expect(
          db.releaseTaskRunForRetry(
            first.id,
            first.lease_owner,
            first.lease_token,
            new Date(Date.now() + 86400000).toISOString(),
            'Original checkpoint retained',
            { countsAsAttempt: false },
          ),
        ).toBe(true);
      const next = db.createTaskRun({
        task: value.task,
        triggerType: 'manual',
      });
      expect(next).toMatchObject({
        created: false,
        reason: 'active_conflict',
        run: { id: first.id },
      });
      expect(db.getTaskRunsForTask(value.task.id)).toHaveLength(1);
      expect(
        goals.getPersonalGoal('alice', value.goal.id)?.budget_used_runs,
      ).toBe(1);
      if (grant)
        expect(
          product.requireCloudExecution(value.sessionId, ref(grant), true),
        ).toEqual(grant);
      db.cancelTaskRun(first.id);
    }
});

test('the existing database uniqueness fence prevents a second execution owner even if service admission is bypassed', () => {
  const value = managed(),
    first = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, first);
  // Deliberately bypass service prechecks. The existing unique index must still
  // reject a second live owner; no safety constraint is removed for this fault.
  withDb((raw) => {
    const run = raw
      .prepare('SELECT * FROM task_runs WHERE id=?')
      .get(first.id) as Record<string, unknown>;
    const id = randomUUID();
    Object.assign(run, {
      id,
      occurrence_key: `${value.task.id}:manual:${id}`,
      idempotency_key: null,
      lease_owner: 'ambiguous',
    });
    const columns = Object.keys(run);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO task_runs(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        )
        .run(...columns.map((key) => run[key])),
    ).toThrow('UNIQUE constraint failed: task_runs.task_id');
  });
  expect(goals.activeGoalExecution(value.sessionId)?.run_id).toBe(first.id);
  expect(product.requireCloudExecution(value.sessionId, ref(grant))).toEqual(
    grant,
  );
  expect(steps(value.sessionId, first.id)).toEqual({
    session: 0,
    cloud: 0,
    goal: 0,
  });
});

test('SIGKILL after an attempt commits but before its receipt preserves the grant and refuses duplicate admission in a fresh process', async () => {
  const value = managed(),
    claim = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, claim);
  const childRoot = fs.mkdtempSync(path.join(root, 'child-'));
  fs.symlinkSync(root, path.join(childRoot, 'data'), 'dir');
  fs.symlinkSync(
    path.resolve('node_modules'),
    path.join(childRoot, 'node_modules'),
    'dir',
  );
  const requestId = randomUUID(),
    helper = path.resolve('tests/helpers/cloud-goal-grant-recovery.ts');
  async function run(mode: string) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        helper,
        mode,
        value.sessionId,
        claim.id,
        requestId,
        claim.lease_owner,
        String(claim.lease_token),
      ],
      {
        cwd: childRoot,
        env: { PATH: process.env.PATH, HOME: childRoot, TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (error += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const [code, signal] = await once(child, 'close');
    clearTimeout(timer);
    const line = output.split('\n').find((text) => text.startsWith('{'));
    if (!line)
      throw new Error(
        `Child did not report ledger checkpoint: ${error.slice(-2000)}`,
      );
    return { code, signal, record: JSON.parse(line) };
  }
  const crashed = await run('crash');
  expect(crashed.signal).toBe('SIGKILL');
  expect(crashed.record).toEqual({
    phase: 'attempt-committed-before-receipt',
    grant,
  });
  const recovered = await run('resume');
  expect(recovered.code).toBe(0);
  expect(recovered.record).toEqual({
    phase: 'recovered-original-grant',
    grant,
    duplicateRejected: true,
  });
  expect(steps(value.sessionId, claim.id)).toEqual({
    session: 1,
    cloud: 1,
    goal: 1,
  });
  expect(
    withDb((raw) =>
      raw
        .prepare(
          'SELECT state FROM product_cloud_model_attempts WHERE session_id=? AND request_id=?',
        )
        .get(value.sessionId, requestId),
    ),
  ).toEqual({ state: 'started' });
}, 30000);

test('Cloud controls retain their original Goal run for execution and historical lost-ACK proofs', async () => {
  const value = managed(),
    first = start(value);
  const grant = product.issueCloudGoalExecution(value.sessionId, first);
  const row = product.admitQueueControl(value.sessionId, randomUUID(), {
    command: {
      action: 'abort',
      taskId: 99,
      expectedQueueDigest: 'a'.repeat(64),
    },
    targets: [],
    goalRunId: first.id,
  });
  const proof = {
    id: row.id,
    digest: row.payload_digest,
    payload: row.payload,
    state: row.state,
    execution: ref(grant),
  };
  expect((await call(value.sessionId, 'controls', proof)).status).toBe(200);
  expect(
    (
      await call(value.sessionId, 'controls', {
        ...proof,
        execution: undefined,
      })
    ).status,
  ).toBe(409);
  expect(
    db.completeTaskRun(first.id, first.lease_owner, first.lease_token, {
      status: 'success',
    }),
  ).toBe(true);
  const next = start(value),
    nextGrant = product.issueCloudGoalExecution(value.sessionId, next);
  expect((await call(value.sessionId, 'controls', proof)).status).not.toBe(200);
  expect(
    (await call(value.sessionId, 'controls', { ...proof, purpose: 'read' }))
      .status,
  ).toBe(200);
  expect(
    (
      await call(value.sessionId, 'controls', {
        ...proof,
        execution: ref(nextGrant),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(value.sessionId, 'controls', {
        ...proof,
        execution: ref(nextGrant),
        purpose: 'read',
      })
    ).status,
  ).toBe(409);
});

test('reading an unprovisioned managed Goal neither issues a grant nor opens a Cloud or Node executor', async () => {
  const value = managed('alice', true, 3, false);
  const originalFetch = globalThis.fetch;
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('A history read must not provision an executor');
  });
  try {
    const snapshot = await runtime
      .getProductRuntimeService()
      .snapshot(value.sessionId, 'alice');
    expect(snapshot.live).toBeNull();
    expect(snapshot.executionState).toBe('waiting_for_scheduler');
    expect(
      product.getProductRuntime(value.sessionId)?.conversation_id,
    ).toBeNull();
    expect(product.getCloudPlacement(value.sessionId)?.object_id).toBeNull();
    expect(
      withDb((raw) =>
        raw
          .prepare(
            'SELECT count(*) AS n FROM product_cloud_executions WHERE session_id=?',
          )
          .get(value.sessionId),
      ),
    ).toEqual({ n: 0 });
    expect(outbound).not.toHaveBeenCalled();
  } finally {
    outbound.mockRestore();
    expect(globalThis.fetch).toBe(originalFetch);
  }
});

test('Cloud stop authority fences stale leases and Goal revisions but remains available after Host revocation', async () => {
  const value = managed(),
    first = start(value),
    grant = product.issueCloudGoalExecution(value.sessionId, first);
  const claimFence = {
    kind: 'claim',
    run_id: first.id,
    lease_owner: first.lease_owner,
    lease_token: first.lease_token,
  };
  const proof = { fence: claimFence, execution: ref(grant) };
  expect((await call(value.sessionId, 'stop-policy', proof)).status).toBe(200);
  expect(
    (
      await call(value.sessionId, 'stop-policy', {
        ...proof,
        fence: { ...claimFence, lease_owner: 'invented' },
      })
    ).status,
  ).toBe(409);
  expire(first.id);
  const next = db.claimNextTaskRun('replacement-owner', 60000)!;
  expect(next.id).toBe(first.id);
  expect(
    db.markTaskRunExecutionStarted(next.id, next.lease_owner, next.lease_token),
  ).toBe(true);
  expect((await call(value.sessionId, 'stop-policy', proof)).status).toBe(409);
  const currentProof = {
    ...proof,
    fence: {
      ...claimFence,
      lease_owner: next.lease_owner,
      lease_token: next.lease_token,
    },
  };
  host.beginHostPrivilegeRevocation('alice');
  expect(
    (await call(value.sessionId, 'stop-policy', currentProof)).status,
  ).toBe(200);
  host.endHostPrivilegeRevocation('alice');
  const goal = goals.getPersonalGoal('alice', value.goal.id)!;
  const paused = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'paused',
  });
  const pauseFence = {
    kind: 'goal',
    goal_id: goal.id,
    goal_revision: paused.revision,
  };
  expect(
    (
      await call(value.sessionId, 'stop-policy', {
        ...proof,
        fence: pauseFence,
      })
    ).status,
  ).toBe(200);
  goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: paused.revision,
    status: 'running',
  });
  expect(
    (
      await call(value.sessionId, 'stop-policy', {
        ...proof,
        fence: pauseFence,
      })
    ).status,
  ).toBe(409);
  expect(db.cancelTaskRun(next.id)).toBe(true);
  expect(
    (await call(value.sessionId, 'stop-policy', currentProof)).status,
  ).toBe(200);
  expect((await call(value.sessionId, 'stop-policy', proof)).status).toBe(409);
});

test.each(['paused', 'cancelled'] as const)(
  'a Cloud Goal %s while provider dispatch is in flight interrupts the original request without a new attempt',
  async (status) => {
    const value = managed();
    const claim = start(value);
    const grant = product.issueCloudGoalExecution(value.sessionId, claim);
    hold = true;
    const before = calls;
    const pending = call(value.sessionId, `model/${randomUUID()}`, {
      request,
      execution: ref(grant),
    });
    await vi.waitFor(() => expect(calls).toBe(before + 1));
    const current = goals.getPersonalGoal('alice', value.goal.id)!;
    goals.patchPersonalGoal('alice', value.goal.id, {
      status,
      expected_revision: current.revision,
    });
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('synthetic-goal-provider-key');
    expect(
      (
        await call(value.sessionId, `model/${randomUUID()}`, {
          request,
          execution: ref(grant),
        })
      ).status,
    ).not.toBe(200);
    expect(calls).toBe(before + 1);
    expect(steps(value.sessionId, claim.id)).toEqual({
      session: 1,
      cloud: 1,
      goal: 1,
    });
    expect(
      product.requireCloudExecution(value.sessionId, ref(grant), true),
    ).toEqual(grant);
  },
  30000,
);

test('oversized serialized Cloud Goal input is rejected before runtime provisioning or product admission', async () => {
  const value = managed('alice', true, 3, false);
  const claim = start(value);
  runtime.getProductRuntimeService().bindGoalClaim(claim);
  const requestId = randomUUID();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const service = runtime.getProductRuntimeService();
  try {
    await expect(
      service.submit(value.sessionId, requestId, {
        sender: 'alice',
        senderName: 'Goal',
        content: '\u0000'.repeat(32768),
        followUpBehavior: 'queue',
      }),
    ).rejects.toMatchObject({ status: 413, code: 'CLOUD_REQUEST_TOO_LARGE' });
    expect(product.listProductInputs(value.sessionId)).toHaveLength(0);
    expect(product.getCloudPlacement(value.sessionId)?.object_id).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    const auth = await import('../src/auth.js');
    const token = auth.generateSessionToken();
    const now = new Date().toISOString();
    db.createUserSession({
      id: token,
      user_id: 'alice',
      ip_address: null,
      user_agent: null,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const web = await import('../src/web.js');
    const app = web.createAppForTest({} as any);
    const response = await app.request('/api/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `miniclaw_session=${auth.signSessionToken(token)}`,
      },
      body: JSON.stringify({
        chatJid: 'web:alice',
        agentId: value.sessionId,
        requestId: randomUUID(),
        content: '\u0000'.repeat(32768),
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: 'CLOUD_REQUEST_TOO_LARGE',
    });
    expect(product.listProductInputs(value.sessionId)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
