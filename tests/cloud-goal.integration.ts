// Real Node authority, encrypted Provider, Scheduler claims and local workerd.
// Only model inference and HTTPS hostname routing are fixtures; no cloud deploy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { afterAll, expect, test, vi } from 'vitest';
import type { ClaimedTaskRun } from '../src/types.js';
import type { CloudBinding } from '../src/personal-agent/cloud-wire.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-goal-native-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const step = await import('../src/personal-agent/goal-runtime.js');
const store = await import('../src/personal-agent/product-runtime-store.js');
const runtime = await import('../src/personal-agent/product-runtime.js');
const config = await import('../src/runtime-config.js');
const models = await import('../src/personal-agent/product-model.js');
const approvals = await import('../src/personal-agent/approval-store.js');
const artifacts = await import('../src/personal-agent/artifact-effect.js');
const wire = await import('../src/personal-agent/cloud-wire.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
interface WorkerRuntime {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}
const requireCloud = createRequire(
  new URL('../apps/cloud-agent/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = requireCloud('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => WorkerRuntime;
  convertV4MiniflareOptions: (
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
};
let worker: WorkerRuntime | undefined;
const servers: Server[] = [];
afterAll(async () => {
  vi.restoreAllMocks();
  await worker?.dispose();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await runtime.getProductRuntimeService().close();
  db.closeDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

test('real Scheduler claims install two Cloud runs into one Root, recover lost ACK and pending approval, and settle real artifact evidence', async () => {
  const secret = 'synthetic-native-cloud-goal-signing-key';
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  db.initDatabase();
  runtime.startProductRuntimeService();
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: 'fixture',
    display_name: 'Alice',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:alice', {
    name: 'Cloud Goal',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    is_home: false,
    added_at: now,
  });
  const evidence = `approved-cloud-goal-${randomUUID()}`;
  const received: {
    messages: { role: string; content?: unknown }[];
    execution?: unknown;
  }[] = [];
  let occurrence = 1;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as (typeof received)[number];
    received.push(input);
    expect(request.headers.authorization).toBe(
      'Bearer synthetic-native-goal-provider-key',
    );
    expect(input.execution).toBeUndefined();
    const toolDone = input.messages.at(-1)?.role === 'tool';
    const delta =
      occurrence === 1 || toolDone
        ? {
            role: 'assistant',
            content:
              occurrence === 1
                ? 'FIRST_BOUNDED_PROGRESS'
                : 'APPROVED_GOAL_FINISHED',
          }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'native-goal-artifact-call',
                type: 'function',
                function: {
                  name: 'create_approved_artifact',
                  arguments: JSON.stringify({ content: evidence }),
                },
              },
            ],
          };
    const packet = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'goal-model-fixture', object: 'chat.completion.chunk', created: 1, model: 'goal-model', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (received.length === 1) {
      response.write(
        packet(
          { role: 'assistant', content: 'PARTIAL_BEFORE_NODE_PAUSE' },
          null,
        ),
      );
      return;
    }
    response.end(
      packet(delta, null) +
        packet({}, occurrence === 1 || toolDone ? 'stop' : 'tool_calls') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  servers.push(provider);
  await once(provider, 'listening');
  const p = config.createProvider({
    name: 'Native Cloud Goal fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    anthropicApiKey: 'synthetic-native-goal-provider-key',
    anthropicModel: 'goal-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const authority = serve({
    fetch: (request) => routes.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
  }) as Server;
  servers.push(authority);
  if (!authority.listening) await once(authority, 'listening');
  const authorityPort = (authority.address() as { port: number }).port;
  const selected = models.productModelConfiguration('web:alice', p.id);
  const goal = goals.createPersonalGoal(
    'alice',
    randomUUID(),
    {
      workspace_jid: 'web:alice',
      objective:
        'Make bounded progress, then publish an explicitly approved result',
      completion_criteria: [`artifact_contains:${evidence}`],
      budget_max_runs: 3,
    },
    (goal) => {
      const sessionId = randomUUID(),
        taskId = randomUUID();
      db.createAgent(
        {
          id: sessionId,
          chat_jid: goal.workspace_jid,
          group_folder: 'alice',
          name: 'Native Cloud Goal',
          kind: 'conversation',
          prompt: '',
          status: 'idle',
          created_by: 'alice',
          created_at: now,
          completed_at: null,
          result_summary: null,
          last_im_jid: null,
          spawned_from_jid: null,
        },
        {
          kind: 'pi-durable',
          providerId: p.id,
          configFingerprint: selected.fingerprint,
          goalId: goal.id,
          cloud: {
            runtime_id: randomUUID(),
            gateway_origin: 'https://cloud.fixture',
            model_id: selected.modelId,
            instructions:
              'Follow the frozen Goal criteria. Only inspect_text and create_approved_artifact are available. No local device or file access.',
            max_model_steps: 24,
            deadline_at: Date.now() + 60000,
            tool_capabilities: ['create_approved_artifact'],
          },
        },
      );
      db.createTask({
        id: taskId,
        chat_jid: goal.workspace_jid,
        group_folder: 'alice',
        prompt: 'Advance Goal',
        schedule_type: 'interval',
        schedule_value: '86400000',
        context_mode: 'isolated',
        execution_type: 'agent',
        execution_mode: 'host',
        script_command: null,
        next_run: null,
        status: 'paused',
        created_by: 'alice',
        created_at: now,
      });
      goals.attachAutomaticGoalSession('alice', goal.id, sessionId);
      goals.linkPersonalGoalTask('alice', goal.id, taskId, goal.revision);
      goals.markAutomaticGoalTask(goal.id, taskId);
    },
  );
  const id = goal.session_id!;
  db.ensureChatExists(`${goal.workspace_jid}#agent:${id}`);
  const binding = JSON.parse(
    store.getCloudPlacement(id)!.binding_json,
  ) as CloudBinding;
  const task = db.getTaskById(
    goals.listPersonalGoalTaskIds('alice', goal.id)[0],
  )!;
  function start(): ClaimedTaskRun {
    const created = db.createTaskRun({ task, triggerType: 'manual' }).run;
    const claim = db.claimNextTaskRun('native-goal-scheduler', 60000)!;
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
  const transport: string[] = [];
  function startWorker() {
    return new Miniflare(
      convertV4MiniflareOptions({
        name: 'miniclaw-cloud-agent',
        telemetry: { enabled: false },
        modules: true,
        scriptPath: path.resolve('apps/cloud-agent/dist/worker.js'),
        modulesRoot: process.cwd(),
        compatibilityDate: '2026-10-13',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          SESSIONS: { className: 'CloudSession', useSQLite: true },
        },
        resourcePersistencePath: path.join(root, 'workerd'),
        bindings: {
          MINICLAW_CLOUD_ADMISSION: 'true',
          MINICLAW_CLOUD_SHARED_SECRET: secret,
          MINICLAW_CLOUD_ORIGIN: 'https://cloud.fixture',
          MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
        },
        serviceBindings: {
          MINICLAW_AUTHORITY_SERVICE: async (request: Request) =>
            fetch(
              `http://127.0.0.1:${authorityPort}${new URL(request.url).pathname}`,
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
                signal: request.signal,
                redirect: 'error',
              },
            ),
        },
      }),
    );
  }
  worker = startWorker();
  const originalFetch = globalThis.fetch.bind(globalThis);
  let loseInputReceipt = true;
  let loseControlReceipt = false;
  let loseGrantReceipt = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== 'https://cloud.fixture')
      return originalFetch(input, init);
    transport.push(`start:${new URL(request.url).pathname.split('/').at(-1)}`);
    const response = await worker!.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method === 'GET' ? undefined : await request.text(),
    });
    transport.push(
      `end:${new URL(request.url).pathname.split('/').at(-1)}:${response.status}`,
    );
    if (loseInputReceipt && request.url.endsWith('/messages') && response.ok) {
      loseInputReceipt = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    if (
      loseControlReceipt &&
      request.url.endsWith('/controls') &&
      response.ok
    ) {
      loseControlReceipt = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    if (
      loseGrantReceipt &&
      request.url.endsWith('/executions') &&
      response.ok
    ) {
      loseGrantReceipt = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    return response;
  });
  async function call(suffix: string, body?: unknown) {
    const url = `https://cloud.fixture/internal/cloud-sessions/${id}${suffix}`;
    const signed = await wire.signedRequest(
      secret,
      binding,
      url,
      body === undefined ? 'GET' : 'POST',
      body === undefined ? '' : JSON.stringify(body),
    );
    return fetch(signed);
  }
  const first = start();
  // The production executor retries the same immutable input after the lost ACK.
  const lostAck = await step
    .executeGoalRuntimeStep(first)
    .catch((error) => error);
  expect(
    lostAck,
    lostAck instanceof Error ? lostAck.stack : undefined,
  ).toBeInstanceOf(goals.GoalExecutionPending);
  const initialGrant = store.issueCloudGoalExecution(id, first);
  async function nativeSnapshot() {
    const response = await call('');
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      state: string;
      epoch: string;
      inputs: { id: string; submission_id: number; status: string }[];
      view: {
        entries: unknown[];
        docs: Record<string, { run?: { taskId: number } }>;
      };
    }>;
  }
  await expect.poll(() => received.length).toBe(1);
  await expect
    .poll(async () =>
      JSON.stringify((await nativeSnapshot()).view).includes(
        'PARTIAL_BEFORE_NODE_PAUSE',
      ),
    )
    .toBe(true);
  const originalNative = await nativeSnapshot();
  const beforePause = goals.getPersonalGoal('alice', goal.id)!;
  const pausedGoal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: beforePause.revision,
    status: 'paused',
  });
  // Let the real Node model proxy observe the persisted fence before the stop
  // request arrives. Its interrupted stream must not settle the native input.
  await expect
    .poll(async () => (await nativeSnapshot()).state, { timeout: 5000 })
    .toBe('recovering');
  await runtime.getProductRuntimeService().suspendGoalSession(id);
  const suspended = await nativeSnapshot();
  expect(suspended.state).toBe('suspended');
  expect(suspended.inputs[0]).toMatchObject({
    id: `goal-run:${first.id}`,
    submission_id: originalNative.inputs[0].submission_id,
    status: 'placed',
  });
  expect(suspended.view.docs['pi.live']?.run?.taskId).toBe(
    originalNative.view.docs['pi.live']?.run?.taskId,
  );
  await worker.dispose();
  worker = startWorker();
  const pausedRecovery = await nativeSnapshot();
  expect(pausedRecovery.state).toBe('suspended');
  expect(pausedRecovery.epoch).not.toBe(suspended.epoch);
  expect(pausedRecovery.inputs).toEqual(suspended.inputs);
  expect(received).toHaveLength(1);
  goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: pausedGoal.revision,
    status: 'running',
  });
  const stalePause = await call('/suspend', {
    fence: {
      kind: 'goal',
      goal_id: goal.id,
      goal_revision: pausedGoal.revision,
    },
  });
  expect(stalePause.status).toBe(409);
  await stalePause.json();
  const result = await step.executeGoalRuntimeStep(first);
  expect(result).toMatchObject({
    completed: true,
    result: 'FIRST_BOUNDED_PROGRESS',
    evidence: [],
  });
  expect(store.listProductInputs(id)).toHaveLength(1);
  expect(store.listProductInputs(id)[0].request_id).toBe(
    `goal-run:${first.id}`,
  );
  const originalInput = store.listProductInputs(id)[0];
  const firstSnapshot = await runtime
    .getProductRuntimeService()
    .snapshot(id, 'alice');
  expect(received).toHaveLength(2);
  expect(store.listProductInputs(id)[0].submission_id).toBe(
    originalNative.inputs[0].submission_id,
  );
  expect(JSON.stringify(received[0].messages)).toContain(goal.objective);
  expect(JSON.stringify(received[0].messages)).not.toContain(
    'Use read_workspace_file',
  );
  let continuation = false;
  expect(
    goals.settlePersonalGoalExecution(
      {
        runId: first.id,
        sessionId: id,
        leaseOwner: first.lease_owner,
        leaseToken: first.lease_token,
        modelCompleted: result.completed,
        evidence: result.evidence,
      },
      () =>
        db.completeTaskRun(first.id, first.lease_owner, first.lease_token, {
          status: 'success',
        }),
      () => {
        continuation = true;
      },
    ),
  ).toBe(true);
  expect(continuation).toBe(true);
  expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('pending');
  occurrence = 2;
  const second = start();
  loseGrantReceipt = true;
  await expect(step.executeGoalRuntimeStep(second)).rejects.toBeInstanceOf(
    goals.GoalExecutionPending,
  );
  expect(loseGrantReceipt).toBe(false);
  expect(store.listProductInputs(id)).toHaveLength(1);
  const secondGrant = store.issueCloudGoalExecution(id, second);
  const execution = step.executeGoalRuntimeStep(second);
  // Observe rejection immediately so a failure cannot become an unhandled promise.
  let executionError: unknown;
  void execution.catch((error) => {
    executionError = error;
  });
  await expect
    .poll(
      () => {
        if (executionError) throw executionError;
        return approvals.listProductApprovals(id, 'alice').length;
      },
      {
        timeout: 10000,
      },
    )
    .toBe(1)
    .catch((error) => {
      throw new Error(
        JSON.stringify({
          failure: String(error),
          executionError: String(executionError),
          transport,
          models: received.length,
          toolResults: received.flatMap((row) =>
            row.messages.filter((message) => message.role === 'tool'),
          ),
          inputs: store.listProductInputs(id).map((row) => ({
            id: row.request_id,
            state: row.state,
            submission: row.submission_id,
          })),
        }),
      );
    });
  const proposal = approvals.listProductApprovals(id, 'alice')[0];
  expect(proposal).toMatchObject({
    goal_id: goal.id,
    run_id: second.id,
    task_id: task.id,
    state: 'pending',
  });
  const service = runtime.getProductRuntimeService();
  const followup = await service.submit(id, randomUUID(), {
    sender: 'alice',
    senderName: 'Alice',
    content: 'Keep the exact completion criterion',
    followUpBehavior: 'queue',
  });
  const queue = await service.snapshot(id, 'alice');
  expect(queue.live?.queue).toHaveLength(1);
  const edit = {
    action: 'edit',
    submissionId: followup.submissionId,
    content: 'Do not broaden device permissions',
    expectedQueueDigest: queue.live!.queueDigest,
  };
  const editId = randomUUID();
  loseControlReceipt = true;
  await expect(
    service.control(id, 'alice', editId, edit),
  ).rejects.toBeInstanceOf(wire.CloudError);
  expect(loseControlReceipt).toBe(false);
  expect(store.listQueueControls(id)[0].state).toBe('pending');
  const pending = await call('');
  expect(pending.status).toBe(200);
  const pendingView = (await pending.json()) as {
    epoch: string;
    inputs: unknown[];
    execution: { run_id: string; steps: number };
    waits: { approval_id: string; state: string }[];
  };
  expect(pendingView.execution).toMatchObject({ run_id: second.id, steps: 1 });
  await expect
    .poll(async () => {
      const response = await call('');
      const value = (await response.json()) as typeof pendingView;
      return value.waits.some(
        (row) => row.approval_id === proposal.id && row.state === 'waiting',
      );
    })
    .toBe(true);
  await worker.dispose();
  worker = startWorker();
  const recovered = await call('');
  expect(recovered.status).toBe(200);
  const recoveredView = (await recovered.json()) as typeof pendingView;
  expect(recoveredView.epoch).not.toBe(pendingView.epoch);
  expect(recoveredView.inputs).toEqual(pendingView.inputs);
  expect(received).toHaveLength(3);
  const editReceipt = await service.control(id, 'alice', editId, edit);
  expect(editReceipt.state).toBe('applied');
  const edited = await service.snapshot(id, 'alice');
  expect(edited.live?.queue[0].content).toBe(edit.content);
  expect(
    (
      await service.control(id, 'alice', randomUUID(), {
        action: 'steer',
        submissionId: followup.submissionId,
        expectedQueueDigest: edited.live!.queueDigest,
      })
    ).state,
  ).toBe('applied');
  const steered = await service.snapshot(id, 'alice');
  expect(steered.live?.queue[0].mode).toBe('steer');
  expect(
    (
      await service.control(id, 'alice', randomUUID(), {
        action: 'cancel',
        submissionId: followup.submissionId,
        expectedQueueDigest: steered.live!.queueDigest,
      })
    ).state,
  ).toBe('applied');
  expect((await service.snapshot(id, 'alice')).live?.queue).toHaveLength(0);
  approvals.decideProductApproval(
    'alice',
    proposal.id,
    proposal.parameters_digest,
    'approve',
    randomUUID(),
  );
  const resumed = await call('/approval-decisions', {
    request_id: proposal.id,
  });
  expect(resumed.status).toBe(200);
  await resumed.json();
  const completed = await execution;
  expect(completed).toMatchObject({
    completed: true,
    result: 'APPROVED_GOAL_FINISHED',
    evidence: [{ artifact_id: proposal.id, criteria_matches: [true] }],
  });
  expect(artifacts.readApprovedArtifact(proposal.id, 'alice')).toBe(evidence);
  expect(received).toHaveLength(4);
  expect(
    goals.settlePersonalGoalExecution(
      {
        runId: second.id,
        sessionId: id,
        leaseOwner: second.lease_owner,
        leaseToken: second.lease_token,
        modelCompleted: completed.completed,
        evidence: completed.evidence,
      },
      () =>
        db.completeTaskRun(second.id, second.lease_owner, second.lease_token, {
          status: 'success',
        }),
      () => {
        throw new Error('Completed Goal cannot enqueue another occurrence');
      },
    ),
  ).toBe(true);
  expect(goals.getPersonalGoal('alice', goal.id)?.status).toBe('completed');
  expect(goals.listGoalExecutionEvidence('alice', goal.id)).toHaveLength(2);
  expect(store.issueCloudGoalExecution.bind(null, id, first)).toThrow();
  const snapshot = await runtime
    .getProductRuntimeService()
    .snapshot(id, 'alice');
  expect(snapshot.runtime.conversation_id).toBe(1);
  expect(snapshot.runtime.runtime_kind).toBe(
    firstSnapshot.runtime.runtime_kind,
  );
  expect(store.listProductInputs(id)[0]).toEqual(originalInput);
  expect(store.listProductInputs(id)).toHaveLength(3);
  expect(store.getCloudPlacement(id)?.model_attempts).toBe(4);
  const finalNative = await call('');
  const finalView = (await finalNative.json()) as {
    execution: { run_id: string; steps: number; deadline_at: number };
  };
  expect(finalView.execution).toMatchObject({
    run_id: second.id,
    steps: 2,
    deadline_at: secondGrant.deadline_at,
  });
  expect(
    store.requireCloudExecution(
      id,
      {
        goal_id: goal.id,
        run_id: first.id,
        context_digest: initialGrant.context_digest,
      },
      true,
    ),
  ).toEqual(initialGrant);
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', `${id}.sqlite`)),
  ).toBe(false);
  // This one case reconstructs workerd and injects three lost acknowledgements.
  // Each transport/authority wait stays bounded; allow their combined wall time
  // without reducing assertions or extending any production execution deadline.
}, 90_000);
