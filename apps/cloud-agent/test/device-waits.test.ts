// Actual workerd/SQLite/Alarms; adversarial product-only wait rows deliberately
// have no native ToolTask. They must never manufacture execution authority.
import { env, exports } from 'cloudflare:workers';
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import { expect, test } from 'vitest';
import { signedRequest, digest, type SessionBinding } from '../src/protocol';
import type { Env } from '../src/worker';
const cloud = env as unknown as Env,
  secret = 'local-workerd-fixture-control-key-32bytes';
async function fixture() {
  await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
    'https://authority.fixture/fixture/reset',
    { method: 'POST' },
  );
  await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/reset', {
    method: 'POST',
  });
  const binding: SessionBinding = {
    version: 1,
    owner_user_id: 'alice',
    workspace_jid: 'web:alice',
    session_id: crypto.randomUUID(),
    runtime_id: crypto.randomUUID(),
    provider_id: 'provider-fixture',
    config_fingerprint: 'a'.repeat(64),
    model_id: 'fixture-model',
    instructions: 'Only explicitly granted file requests.',
    max_model_steps: 4,
    deadline_at: Date.now() + 3600000,
    execution_authority: 'miniclaw-product',
    tool_capabilities: ['read_device_file'],
    bot_handoff: {
      handoff_id: crypto.randomUUID(),
      group_id: crypto.randomUUID(),
      grant_digest: 'b'.repeat(64),
    },
  };
  const created = await exports.default.fetch(
    await signedRequest(
      secret,
      binding,
      'https://gateway.fixture/internal/cloud-sessions',
      'POST',
      JSON.stringify(binding),
    ),
  );
  expect(created.status).toBe(200);
  await created.json();
  const parameters = { node_id: crypto.randomUUID(), path: 'declared.txt' },
    intent = {
      id: 'task:771',
      conversation_id: 1,
      task_id: 771,
      generation_task_id: 991,
      call_id: 'forged-tool',
      name: 'read_device_file',
      parameters,
      parameters_digest: await digest(JSON.stringify(parameters)),
    };
  const receipt = {
    request_id: crypto.randomUUID(),
    owner_user_id: binding.owner_user_id,
    workspace_jid: binding.workspace_jid,
    goal_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    handoff_id: binding.bot_handoff!.handoff_id,
    cloud_session_id: binding.session_id,
    node_id: parameters.node_id,
    path: parameters.path,
    operation_digest: 'c'.repeat(64),
    deadline_at: Date.now() + 60000,
  };
  const stub = cloud.SESSIONS.getByName('v1:' + binding.session_id);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO mc_device_waits(task_id,request_id,payload,kind) VALUES(?,?,?,'permission')",
      intent.task_id,
      receipt.request_id,
      JSON.stringify({ intent, receipt }),
    );
    state.storage.sql.exec(
      "UPDATE mc_binding SET state='waiting_for_device_permission' WHERE id=1",
    );
  });
  return { binding, intent, receipt, stub };
}
test('read-only device proof rejects a product-only intent after eviction without opening a Harness or accepting a forged native identity', async () => {
  const f = await fixture();
  await evictDurableObject(f.stub);
  const response = await exports.default.fetch(
    await signedRequest(
      secret,
      f.binding,
      `https://gateway.fixture/internal/cloud-sessions/${f.binding.session_id}/device-proof`,
      'POST',
      JSON.stringify({ intent: f.intent, receipt: f.receipt }),
    ),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'CLOUD_DEVICE_CHECKPOINT_MISSING',
  });
  await runInDurableObject(f.stub, (instance, state) => {
    expect(instance.devices.summary()[0]).toMatchObject({
      task_id: 771,
      state: 'waiting',
      attempts: 0,
      activation_attempts: 0,
    });
    expect(
      state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM mc_intents')
        .one().n,
    ).toBe(0);
  });
});
test('an Alarm cannot turn a ledger-only file request into a ToolTask; a missing native checkpoint leaves an observable blocked fence', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance) => instance.devices.rearm());
  await evictDurableObject(f.stub);
  // Lifecycle runs only due jobs; forcing an earlier Alarm is not a wake at
  // the committed job deadline.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await runDurableObjectAlarm(f.stub);
  await runInDurableObject(f.stub, (instance, state) => {
    expect(instance.devices.summary()[0]).toMatchObject({
      state: 'blocked',
      activation_attempts: 0,
    });
    expect(
      state.storage.sql
        .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
        .one().state,
    ).toBe('blocked');
    expect(
      state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM mc_intents')
        .one().n,
    ).toBe(0);
  });
});
test('cancelled device waits stay cancelled across eviction and retry budgets cannot be reset by a duplicate wake', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (instance, state) => {
    state.storage.sql.exec(
      'UPDATE mc_device_waits SET attempts=8,activation_attempts=8 WHERE task_id=771',
    );
    expect(() =>
      state.storage.sql.exec(
        'UPDATE mc_device_waits SET attempts=0 WHERE task_id=771',
      ),
    ).toThrow(/budget cannot reset/);
    await instance.devices.cancelGeneration(f.intent.generation_task_id);
    expect(await instance.devices.check(f.receipt.request_id)).toBe(false);
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (instance) => {
    await instance.devices.rearm();
    expect(await instance.devices.check(f.receipt.request_id)).toBe(false);
    expect(instance.devices.summary()[0]).toMatchObject({
      state: 'cancelled',
      attempts: 8,
      activation_attempts: 8,
    });
  });
});

test('an old completed-tool wake retires against its exact generation instead of reopening a Session or watching unrelated tasks', async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, async (instance, state) => {
    state.storage.sql.exec(
      "UPDATE mc_device_waits SET state='done' WHERE task_id=771",
    );
    state.storage.sql.exec("UPDATE mc_binding SET state='active' WHERE id=1");
    expect(await instance.devices.check(f.receipt.request_id)).toBe(false);
    expect(instance.devices.summary()[0]).toMatchObject({
      state: 'settled',
      activation_attempts: 0,
    });
    expect(
      state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM mc_intents')
        .one().n,
    ).toBe(0);
  });
  await evictDurableObject(f.stub);
  await runInDurableObject(f.stub, async (instance) => {
    await instance.devices.rearm();
    expect(instance.devices.summary()[0]).toMatchObject({
      state: 'settled',
      activation_attempts: 0,
    });
  });
});
