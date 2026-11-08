import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { DeviceGrantSchema } from '../src/personal-agent/device-protocol.js';
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';
import type { RuntimeSelection } from '../src/personal-agent/product-runtime-store.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-device-store-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js'),
  goals = await import('../src/personal-agent/goal-store.js'),
  teams = await import('../src/personal-agent/goal-team-store.js');
const groups = await import('../src/bot-groups/store.js'),
  handoffs = await import('../src/bot-groups/handoff-store.js'),
  product = await import('../src/personal-agent/product-runtime-store.js');
const devices = await import('../src/personal-agent/device-store.js'),
  protocol = await import('../src/personal-agent/device-protocol.js'),
  cloud = await import('../src/personal-agent/cloud-device-store.js');
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
  for (const r of db.getTaskRunsByStatus(['queued', 'running', 'retry_wait']))
    db.cancelTaskRun(r.id);
  vi.unstubAllEnvs();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function agent(id: string, selection: RuntimeSelection) {
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Scope fixture',
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
    selection,
  );
}
function fixture(requireResource = false) {
  for (const name of [
    'MINICLAW_PERSONAL_GOALS',
    'MINICLAW_GOAL_TEAMS',
    'MINICLAW_BOT_GROUPS',
    'MINICLAW_BOT_HANDOFFS',
    'MINICLAW_CLOUD_RUNTIME',
    'MINICLAW_CLOUD_BOT_HANDOFFS',
    'MINICLAW_CLOUD_DEVICES',
    'MINICLAW_DEVICE_NODES',
  ])
    vi.stubEnv(name, 'true');
  const receipt = groups.createBotGroup('alice', randomUUID(), {
    name: 'Cloud Device Team',
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
      runtime_kind: 'cloudflare-durable',
      tool_capabilities: ['read_device_file'],
      max_model_attempts: 4,
    },
    () => ({ providerId: 'fixture', configFingerprint: 'f'.repeat(64) }),
  );
  handoffs.configureBotHandoffProvisioner(({ sessionId, handoff, grant }) =>
    agent(sessionId, {
      kind: 'pi-durable',
      providerId: 'fixture',
      configFingerprint: 'f'.repeat(64),
      cloud: {
        runtime_id: randomUUID(),
        gateway_origin: 'https://cloud.fixture',
        model_id: 'fixture-model',
        instructions: 'Only the reviewed Goal/Device tools.',
        max_model_steps: grant.max_model_attempts,
        deadline_at: Date.parse(grant.expires_at),
        tool_capabilities: ['read_device_file'],
        bot_handoff: {
          handoff_id: handoff.id,
          group_id: handoff.group_id,
          grant_digest: handoff.grant_digest!,
        },
      },
    }),
  );
  const ticket = devices.createDevicePairTicket('alice', randomUUID(), {
      name: 'Finite file node',
    }),
    manifest = {
      version: 1,
      capability: 'files.read',
      root_label: 'Project',
      root_fingerprint: 'b'.repeat(64),
      paths: ['evidence.txt', 'second.txt'],
    };
  const paired = devices.joinPersonalDevice({
    pair_code: ticket.pair_code,
    claim_request_id: randomUUID(),
    token_hash: protocol.deviceTextDigest(randomUUID()),
    manifest,
  });
  const node = devices.approvePersonalDevice(
    'alice',
    paired.id,
    paired.revision,
    randomUUID(),
  );
  const goal = goals.createPersonalGoal(
    'alice',
    randomUUID(),
    {
      workspace_jid: 'web:alice',
      objective: 'Read one explicitly authorized local file',
      completion_criteria: ['artifact_contains:verified'],
      budget_max_runs: 2,
      team: {
        group_id: receipt.group_id,
        bot_member_ids: [member.id],
        ...(requireResource
          ? { device_resources: [{ node_id: node.id, path: 'evidence.txt' }] }
          : {}),
      },
    },
    (goal: PersonalGoal) => {
      const session = randomUUID(),
        task = randomUUID();
      agent(session, {
        kind: 'pi-durable',
        providerId: 'fixture',
        configFingerprint: 'f'.repeat(64),
        goalId: goal.id,
      });
      db.createTask({
        id: task,
        chat_jid: 'web:alice',
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
        created_at: new Date().toISOString(),
      });
      goals.attachAutomaticGoalSession('alice', goal.id, session);
      goals.linkPersonalGoalTask('alice', goal.id, task, goal.revision);
      goals.markAutomaticGoalTask(goal.id, task);
    },
  );
  if (requireResource)
    expect(cloud.cloudGoalRequiredDevicesVerified(goal.id)).toBe(false);
  const task = db.getTaskById(
    goals.listPersonalGoalTaskIds('alice', goal.id)[0],
  )!;
  db.createTaskRun({ task, triggerType: 'manual' });
  const claim = db.claimNextTaskRun('cloud-device-scope', 60000)!;
  expect(
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    ),
  ).toBe(true);
  const step = teams.admitGoalTeamStep(claim),
    handoff = handoffs.getBotHandoff(step.handoff_id)!;
  product.bindProductConversation(handoff.session_id!, 1);
  product.bindCloudObject(
    handoff.session_id!,
    product.getCloudPlacement(handoff.session_id!)!.runtime_id,
    'a'.repeat(64),
  );
  const parameters = { node_id: node.id, path: 'evidence.txt' },
    intent = {
      id: 'task:17',
      conversation_id: 1 as const,
      task_id: 17,
      generation_task_id: 11,
      call_id: 'read-original-file',
      name: 'read_device_file' as const,
      parameters,
      parameters_digest: protocol.deviceDigest(parameters),
    };
  const request = cloud.proposeCloudDeviceRequest(handoff.session_id!, intent);
  const grantInput = {
    confirmed: true,
    workspace_jid: 'web:alice',
    capability: 'files.read',
    paths: ['evidence.txt'],
    expected_revision: node.revision,
    ttl_seconds: 3600,
    cloud_request_id: request.id,
  };
  return {
    goal,
    claim,
    groupId: receipt.group_id,
    memberId: member.id,
    handoff,
    node,
    intent,
    request,
    grantInput,
  };
}

test('the existing device grant accepts an explicit original Cloud Tool request, while requiring owner confirmation', () => {
  const request = {
    confirmed: true,
    workspace_jid: 'web:owner',
    capability: 'files.read',
    paths: ['evidence.txt'],
    expected_revision: 1,
    cloud_request_id: randomUUID(),
  };
  expect(DeviceGrantSchema.parse(request)).toHaveProperty(
    'cloud_request_id',
    request.cloud_request_id,
  );
  expect(
    DeviceGrantSchema.safeParse({ ...request, confirmed: false }).success,
  ).toBe(false);
});

test('request identity and exact resource are durable; broad workspace permission never satisfies a Cloud request', () => {
  const f = fixture();
  expect(
    cloud.proposeCloudDeviceRequest(f.handoff.session_id!, f.intent).id,
  ).toBe(f.request.id);
  expect(cloud.cloudDeviceStatus(f.request).state).toBe(
    'waiting_for_permission',
  );
  expect(devices.getDeviceCommand(f.request.id)).toBeUndefined();
  const { cloud_request_id: _, ...generic } = f.grantInput;
  devices.grantPersonalDevice('alice', f.node.id, randomUUID(), generic);
  expect(
    cloud.cloudDeviceStatus(cloud.cloudDeviceRequest(f.request.id, 'alice'))
      .state,
  ).toBe('waiting_for_permission');
  expect(() =>
    cloud.proposeCloudDeviceRequest(f.handoff.session_id!, {
      ...f.intent,
      parameters: { ...f.intent.parameters, path: 'second.txt' },
      parameters_digest: protocol.deviceDigest({
        ...f.intent.parameters,
        path: 'second.txt',
      }),
    }),
  ).toThrow(/CONFLICT/);
  expect(() =>
    devices.grantPersonalDevice('alice', f.node.id, randomUUID(), {
      ...f.grantInput,
      paths: ['evidence.txt', 'second.txt'],
    }),
  ).toThrow(/CONFLICT/);
  expect(() => cloud.cloudDeviceRequest(f.request.id, 'bob')).toThrow(
    /NOT_FOUND/,
  );
});

test('an explicit request grant queues one existing command; neither another Goal nor legacy workspace tools can reuse it', () => {
  const f = fixture(),
    key = randomUUID();
  const first = devices.grantPersonalDevice(
    'alice',
    f.node.id,
    key,
    f.grantInput,
  ) as { id: string };
  expect(
    devices.grantPersonalDevice('alice', f.node.id, key, f.grantInput),
  ).toMatchObject({ id: first.id });
  const command = devices.getDeviceCommand(f.request.id)!;
  expect(command).toMatchObject({
    id: f.request.id,
    goal_run_id: f.claim.id,
    state: 'queued',
    node_id: f.node.id,
    grant_id: first.id,
  });
  const binding = protocol.DeviceBindingSchema.parse(
    JSON.parse(command.binding),
  );
  expect(devices.validateDeviceBinding(binding)).toEqual(binding);
  expect(() =>
    devices.deviceGrantForFile('alice', 'web:alice', f.node.id, 'evidence.txt'),
  ).toThrow(/NOT_AUTHORIZED/);
  const { cloud_scope: _, ...withoutScope } = binding;
  expect(() => devices.validateDeviceBinding(withoutScope)).toThrow(
    /NOT_AUTHORIZED/,
  );
  for (const forged of [
    { ...binding, goal_run_id: randomUUID() },
    {
      ...binding,
      cloud_scope: { ...binding.cloud_scope!, goal_id: randomUUID() },
    },
    { ...binding, node_id: randomUUID() },
    { ...binding, path: 'second.txt' },
  ])
    expect(() => devices.validateDeviceBinding(forged)).toThrow();
  expect(
    cloud.cloudDeviceStatus(cloud.cloudDeviceRequest(f.request.id, 'alice'))
      .state,
  ).toBe('waiting_for_device');
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare('DELETE FROM cloud_device_grant_origins WHERE grant_id=?')
        .run(first.id),
    ).toThrow(/retained/);
    expect(() =>
      raw
        .prepare('UPDATE cloud_device_requests SET goal_id=? WHERE id=?')
        .run(randomUUID(), f.request.id),
    ).toThrow(/immutable/);
  } finally {
    raw.close();
  }
});

test('pause/recovery retains the queued command; revoke and cancellation deny later receipt use without workspace-grant fallback', () => {
  const f = fixture();
  const grant = devices.grantPersonalDevice(
    'alice',
    f.node.id,
    randomUUID(),
    f.grantInput,
  ) as { id: string };
  let goal = goals.getPersonalGoal('alice', f.goal.id)!;
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'paused',
  });
  expect(() =>
    cloud.cloudDeviceStatus(cloud.cloudDeviceRequest(f.request.id, 'alice')),
  ).toThrow(goals.GoalRuntimeSuspended);
  expect(devices.getDeviceCommand(f.request.id)?.state).toBe('queued');
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'pending',
  });
  expect(() => cloud.cloudDeviceRequest(f.request.id, 'alice')).toThrow(
    goals.GoalRuntimeSuspended,
  );
  devices.revokePersonalDeviceGrant('alice', grant.id, randomUUID());
  expect(devices.getDeviceCommand(f.request.id)?.state).toBe('cancelled');
  goal = goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'cancelled',
  });
  expect(() => cloud.cloudDeviceRequest(f.request.id, 'alice')).toThrow();
  expect(devices.getDeviceCommand(f.request.id)?.id).toBe(f.request.id);
});

test('a file receipt is not Goal completion evidence until the original Cloud host confirms a committed result; lost confirmation ACK is idempotent', () => {
  const f = fixture();
  devices.grantPersonalDevice('alice', f.node.id, randomUUID(), f.grantInput);
  expect(cloud.cloudGoalDeviceEvidenceVerified(f.goal.id)).toBe(false);
  devices.heartbeatPersonalDevice(f.node.id, f.node.manifest_hash, true);
  const command = devices.claimDeviceCommand(f.request.id, f.node.id)!;
  const result = {
    ok: true as const,
    content: 'verified local bytes',
    content_digest: protocol.deviceTextDigest('verified local bytes'),
  };
  devices.finishDeviceCommand(
    command.id,
    f.node.id,
    command.lease_id,
    command.params_digest,
    result,
  );
  expect(cloud.cloudGoalDeviceEvidenceVerified(f.goal.id)).toBe(false);
  const digest = protocol.deviceDigest(result);
  expect(() =>
    cloud.confirmCloudDeviceResult(f.request, '0'.repeat(64)),
  ).toThrow(/CONFLICT/);
  cloud.confirmCloudDeviceResult(f.request, digest);
  cloud.confirmCloudDeviceResult(f.request, digest);
  expect(cloud.cloudGoalDeviceEvidenceVerified(f.goal.id)).toBe(true);
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare(
          'UPDATE cloud_device_requests SET delivery_digest=NULL WHERE id=?',
        )
        .run(f.request.id),
    ).toThrow(/immutable/);
  } finally {
    raw.close();
  }
});

test('duplicate online/result wakes never reset the persisted bounded delivery budget', () => {
  const f = fixture();
  devices.grantPersonalDevice('alice', f.node.id, randomUUID(), f.grantInput);
  cloud.queueCloudDeviceWake(f.request.id, 'online');
  cloud.queueCloudDeviceWake(f.request.id, 'online');
  const wake = cloud
    .cloudDeviceWakes(f.node.id)
    .find((w) => w.id.endsWith(':online'))!;
  expect(cloud.claimCloudDeviceWake(wake.id)).toBe(true);
  expect(cloud.claimCloudDeviceWake(wake.id)).toBe(false);
  cloud.settleCloudDeviceWake(wake.id, true);
  cloud.queueCloudDeviceWake(f.request.id, 'online');
  expect(cloud.cloudDeviceWakes(f.node.id).some((w) => w.id === wake.id)).toBe(
    false,
  );
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare(
          "UPDATE cloud_device_wakes SET attempts=0,state='pending',next_at=0 WHERE id=?",
        )
        .run(wake.id),
    ).toThrow(/fenced/);
  } finally {
    raw.close();
  }
});

test('a declared local resource cannot be completed by an artifact claim before any device request exists', () => {
  const f = fixture(true);
  expect(teams.goalTeam(f.goal.id)?.device_resources).toEqual([
    { node_id: f.node.id, path: 'evidence.txt' },
  ]);
  expect(
    JSON.parse(teams.admitGoalTeamStep(f.claim).contract).device_resources,
  ).toEqual([{ node_id: f.node.id, path: 'evidence.txt' }]);
  expect(cloud.cloudGoalRequiredDevicesVerified(f.goal.id)).toBe(false);
  expect(() =>
    cloud.proposeCloudDeviceRequest(f.handoff.session_id!, {
      ...f.intent,
      id: 'task:18',
      task_id: 18,
      parameters: { ...f.intent.parameters, path: 'second.txt' },
      parameters_digest: protocol.deviceDigest({
        ...f.intent.parameters,
        path: 'second.txt',
      }),
    }),
  ).toThrow(/DENIED/);
});

test('an explicit completion click cannot override the immutable missing local-resource receipt', () => {
  const f = fixture(true),
    goal = goals.getPersonalGoal('alice', f.goal.id)!;
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      status: 'completed',
    }),
  ).toThrow(/GOAL_DEVICE_EVIDENCE_REQUIRED/);
});
