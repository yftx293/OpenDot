// Actual DO SQLite/native execution/eviction. Business authorization and model
// responses are fixtures here, not formal Scheduler/deployment acceptance.
import { env, exports } from 'cloudflare:workers';
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { ExecutionGrants } from '../src/execution-grants';
import { MemberExecutions } from '../src/member-execution';
import type { CloudMemberExecution } from '../src/member-protocol';
import { assertExecutionQuiescent } from '../src/execution-ownership';
import { openPiSessionStore } from 'agents/harness/pi';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from '@earendil-works/pi-durable';
import { readRootView } from '../src/read-view';
import { executionRef } from '../src/execution-protocol';
import {
  signedRequest,
  type CloudBinding,
  type CloudExecutionGrant,
} from '../../../src/personal-agent/cloud-wire.js';
import type { Env } from '../src/worker';
const cloud = env as unknown as Env;
const secret = 'local-workerd-fixture-control-key-32bytes';
function baseBinding(): CloudBinding {
  return {
    version: 1,
    owner_user_id: 'alice',
    workspace_jid: 'web:alice',
    session_id: crypto.randomUUID(),
    runtime_id: crypto.randomUUID(),
    config_fingerprint: 'a'.repeat(64),
    provider_id: 'provider-fixture',
    model_id: 'fixture-model',
    instructions: '',
    max_model_steps: 24,
    deadline_at: Date.now() + 3600000,
  };
}
async function binding(): Promise<CloudBinding> {
  const b = baseBinding();
  const response = await exports.default.fetch(
    await signedRequest(
      secret,
      b,
      'https://gateway.fixture/internal/cloud-sessions',
      'POST',
      JSON.stringify(b),
    ),
  );
  expect(response.status).toBe(200);
  await response.json();
  return {
    ...b,
    goal_id: crypto.randomUUID(),
    execution_authority: 'miniclaw-product',
  };
}
function grant(b: CloudBinding): CloudExecutionGrant {
  const now = Date.now();
  return {
    version: 1,
    goal_id: b.goal_id!,
    session_id: b.session_id,
    runtime_id: b.runtime_id,
    task_id: crypto.randomUUID(),
    run_id: crypto.randomUUID(),
    context_digest: 'b'.repeat(64),
    snapshot_digest: 'c'.repeat(64),
    issued_at: now,
    deadline_at: now + 86400000,
    max_model_steps: 12,
  };
}
function run<T>(
  b: CloudBinding,
  work: (
    ledger: ExecutionGrants,
    storage: DurableObjectStorage,
  ) => T | Promise<T>,
) {
  return runInDurableObject(
    cloud.SESSIONS.getByName(`v1:${b.session_id}`),
    async (_instance, state) => {
      const ledger = new ExecutionGrants(state.storage);
      ledger.initialize();
      return work(ledger, state.storage);
    },
  );
}
const allowed = async () => {};

test('member Run metadata reuses an actual idle Root without resetting historical steps or restoring a retired Run', async () => {
  const { goal_id: _goal, ...ordinary } = await binding();
  const b = {
    ...ordinary,
    group_session: {
      group_id: crypto.randomUUID(),
      profile_id: crypto.randomUUID(),
    },
  };
  const first: CloudMemberExecution = {
    version: 1,
    run_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    group_id: b.group_session.group_id,
    profile_id: b.group_session.profile_id,
    session_id: b.session_id,
    runtime_id: b.runtime_id,
    grant_id: crypto.randomUUID(),
    cancel_epoch: 0,
    deadline_at: Date.now() + 60000,
    max_model_attempts: 2,
    tool_capabilities: [],
  };
  await runInDurableObject(
    cloud.SESSIONS.getByName(`v1:${b.session_id}`),
    async (_instance, state) => {
      const ledger = new MemberExecutions(state.storage);
      ledger.initialize();
      const native = await openPiSessionStore(state.storage);
      try {
        await assertExecutionQuiescent(native, false);
        expect(await ledger.accept(b, first, native)).toBe(true);
        ledger.charge(b);
        expect(await ledger.accept(b, first, native)).toBe(false);
        ledger.charge(b);
        expect(() => ledger.charge(b)).toThrow(
          'CLOUD_MEMBER_MODEL_BUDGET_EXHAUSTED',
        );
        expect(
          state.storage.sql
            .exec<{
              steps: number;
            }>(
              'SELECT steps FROM mc_member_executions WHERE run_id=?',
              first.run_id,
            )
            .one().steps,
        ).toBe(2);
        await expect(
          ledger.accept(b, { ...first, max_model_attempts: 3 }, native),
        ).rejects.toThrow('CLOUD_MEMBER_EXECUTION_CONFLICT');
        expect(() =>
          state.storage.sql.exec(
            'UPDATE mc_member_executions SET steps=0 WHERE run_id=?',
            first.run_id,
          ),
        ).toThrow('Cloud member steps cannot reset');
        expect(() =>
          state.storage.sql.exec(
            'DELETE FROM mc_member_executions WHERE run_id=?',
            first.run_id,
          ),
        ).toThrow('Cloud member execution cannot be discarded');
        const next = {
          ...first,
          run_id: crypto.randomUUID(),
          lease_id: crypto.randomUUID(),
        };
        expect(await ledger.accept(b, next, native)).toBe(true);
        await expect(ledger.accept(b, first, native)).rejects.toThrow(
          'CLOUD_MEMBER_EXECUTION_REPLAY',
        );
        expect((await ledger.verify(b))!.run_id).toBe(next.run_id);
        expect(
          state.storage.sql
            .exec<{
              steps: number;
            }>(
              'SELECT steps FROM mc_member_executions WHERE run_id=?',
              first.run_id,
            )
            .one().steps,
        ).toBe(2);
        await assertExecutionQuiescent(native, false);
      } finally {
        await native.close(BG);
      }
    },
  );
});

test('member metadata rejects scope changes, unsupported private grants, expiry and corrupted saved digests on actual DO SQLite', async () => {
  const { goal_id: _goal, ...ordinary } = await binding();
  const b = {
    ...ordinary,
    group_session: {
      group_id: crypto.randomUUID(),
      profile_id: crypto.randomUUID(),
    },
  };
  const grant: CloudMemberExecution = {
    version: 1,
    run_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    group_id: b.group_session.group_id,
    profile_id: b.group_session.profile_id,
    session_id: b.session_id,
    runtime_id: b.runtime_id,
    grant_id: crypto.randomUUID(),
    cancel_epoch: 0,
    deadline_at: Date.now() + 60000,
    max_model_attempts: 2,
    tool_capabilities: [],
  };
  await runInDurableObject(
    cloud.SESSIONS.getByName(`v1:${b.session_id}`),
    async (_instance, state) => {
      const ledger = new MemberExecutions(state.storage);
      ledger.initialize();
      const native = await openPiSessionStore(state.storage);
      try {
        for (const changed of [
          { ...grant, group_id: crypto.randomUUID() },
          { ...grant, session_id: crypto.randomUUID() },
          { ...grant, runtime_id: crypto.randomUUID() },
          { ...grant, deadline_at: Date.now() - 1 },
        ])
          await expect(ledger.accept(b, changed, native)).rejects.toThrow(
            'CLOUD_MEMBER_EXECUTION_CONFLICT',
          );
        await expect(
          ledger.accept(
            b,
            {
              ...grant,
              tool_capabilities: ['read_personal_memory'],
            } as unknown as CloudMemberExecution,
            native,
          ),
        ).rejects.toThrow();
        expect(ledger.current(b)).toBeUndefined();
        state.storage.sql.exec(
          'INSERT INTO mc_member_executions(run_id,lease_id,value,digest) VALUES(?,?,?,?)',
          grant.run_id,
          grant.lease_id,
          JSON.stringify(grant),
          '0'.repeat(64),
        );
        state.storage.sql.exec(
          'INSERT INTO mc_member_owner VALUES(1,?)',
          grant.run_id,
        );
        await expect(ledger.verify(b)).rejects.toThrow(
          'CLOUD_MEMBER_EXECUTION_CONFLICT',
        );
      } finally {
        await native.close(BG);
      }
    },
  );
});
const idle = async () => {};
async function quiescent(storage: DurableObjectStorage, initial = false) {
  const native = await openPiSessionStore(storage);
  try {
    await assertExecutionQuiescent(native, initial);
  } finally {
    await native.close(BG);
  }
}
async function request(b: CloudBinding, suffix: string, body: unknown) {
  return exports.default.fetch(
    await signedRequest(
      secret,
      b,
      `https://gateway.fixture/internal/cloud-sessions/${b.session_id}${suffix}`,
      'POST',
      JSON.stringify(body),
    ),
  );
}
async function activeRun(b: CloudBinding, execution: CloudExecutionGrant) {
  await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/execution',
      {
        method: 'POST',
        body: JSON.stringify({
          session_id: b.session_id,
          run_id: execution.run_id,
        }),
      },
    )
  ).json();
}

test('real SQLite and object eviction retain the same run, immutable grant and spent model budget', async () => {
  const b = await binding(),
    first = grant(b);
  await run(b, async (ledger) => {
    expect(await ledger.accept(b, first, allowed, idle)).toEqual(first);
    for (let i = 0; i < 5; i++) ledger.charge(b, executionRef(first), () => {});
    expect(ledger.steps(b)).toBe(5);
  });
  await evictDurableObject(cloud.SESSIONS.getByName(`v1:${b.session_id}`));
  await run(b, async (ledger, storage) => {
    expect(ledger.current(b)).toEqual(first);
    expect(ledger.steps(b)).toBe(5);
    expect(
      await ledger.accept(b, first, allowed, async () => {
        throw new Error('Duplicate grant must not change owners');
      }),
    ).toEqual(first);
    for (let i = 5; i < 12; i++)
      ledger.charge(b, executionRef(first), () => {});
    expect(() => ledger.charge(b, executionRef(first), () => {})).toThrow(
      'CLOUD_MODEL_BUDGET_EXHAUSTED',
    );
    expect(ledger.steps(b)).toBe(12);
    expect(() =>
      storage.sql.exec(
        'UPDATE mc_goal_executions SET steps=0 WHERE run_id=?',
        first.run_id,
      ),
    ).toThrow('cannot be reset');
    expect(() =>
      storage.sql.exec(
        'UPDATE mc_goal_executions SET value=? WHERE run_id=?',
        JSON.stringify({ ...first, deadline_at: first.deadline_at + 1 }),
        first.run_id,
      ),
    ).toThrow('immutable');
  });
});

test('handoff waits for native quiescence, cannot rewrite a prepared grant and never reuses the previous budget', async () => {
  const b = await binding(),
    first = grant(b),
    next = grant(b);
  await run(b, async (ledger) => {
    let currentRun = first.run_id;
    const authorize = async (g: CloudExecutionGrant) => {
      if (g.run_id !== currentRun)
        throw new Error('Current business claim required');
    };
    await ledger.accept(b, first, authorize, idle);
    ledger.charge(b, executionRef(first), () => {});
    currentRun = next.run_id;
    await expect(
      ledger.accept(b, next, authorize, async () => {
        throw new Error('Root still busy');
      }),
    ).rejects.toThrow('Root still busy');
    expect(ledger.current(b)).toEqual(first);
    await expect(
      ledger.accept(
        b,
        { ...next, deadline_at: next.deadline_at - 1 },
        authorize,
        idle,
      ),
    ).rejects.toThrow('CLOUD_EXECUTION_IDENTITY_CONFLICT');
    await ledger.accept(b, next, authorize, async (previous) => {
      expect(previous).toEqual(first);
    });
    expect(ledger.current(b)).toEqual(next);
    expect(ledger.steps(b)).toBe(0);
    expect(() => ledger.charge(b, executionRef(first), () => {})).toThrow(
      'CLOUD_EXECUTION_SUSPENDED',
    );
    expect(await ledger.verify(b, executionRef(first), true)).toEqual(first);
    await expect(ledger.verify(b, executionRef(first))).rejects.toThrow(
      'CLOUD_EXECUTION_SUSPENDED',
    );
    await expect(ledger.accept(b, first, authorize, idle)).rejects.toThrow(
      'Current business claim required',
    );
    expect(ledger.current(b)).toEqual(next);
  });
});

test('a late competing handoff cannot replace a newer owner after its business claim changed', async () => {
  const b = await binding(),
    first = grant(b),
    next = grant(b),
    newer = grant(b);
  await run(b, async (ledger) => {
    await ledger.accept(b, first, allowed, idle);
    let currentRun = next.run_id,
      release!: () => void,
      reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const authorize = async (g: CloudExecutionGrant) => {
      if (g.run_id !== currentRun) throw new Error('Stale business claim');
    };
    const stale = ledger.accept(b, next, authorize, async () => {
      reached();
      await gate;
    });
    const rejected = expect(stale).rejects.toThrow('Stale business claim');
    await pending;
    currentRun = newer.run_id;
    await ledger.accept(b, newer, authorize, idle);
    release();
    await rejected;
    expect(ledger.current(b)).toEqual(newer);
  });
});

test('failed projection rolls back the DO quota and checksum/ref checks deny forged execution identities', async () => {
  const b = await binding(),
    first = grant(b);
  await run(b, async (ledger, storage) => {
    await expect(
      ledger.accept({ ...b, goal_id: undefined }, first, allowed, idle),
    ).rejects.toThrow('CLOUD_GOAL_BINDING_REQUIRED');
    await expect(
      ledger.accept(
        b,
        { ...first, runtime_id: crypto.randomUUID() },
        allowed,
        idle,
      ),
    ).rejects.toThrow('CLOUD_EXECUTION_IDENTITY_CONFLICT');
    await ledger.accept(b, first, allowed, idle);
    expect(() =>
      ledger.charge(b, executionRef(first), () => {
        storage.sql.exec('UPDATE mc_binding SET steps=steps+1 WHERE id=1');
        throw new Error('Injected projection interruption');
      }),
    ).toThrow('Injected projection interruption');
    expect(ledger.steps(b)).toBe(0);
    expect(
      storage.sql
        .exec<{ steps: number }>('SELECT steps FROM mc_binding WHERE id=1')
        .one().steps,
    ).toBe(0);
    await expect(
      ledger.verify(b, {
        ...executionRef(first),
        context_digest: 'd'.repeat(64),
      }),
    ).rejects.toThrow('CLOUD_EXECUTION_SUSPENDED');
    await expect(
      ledger.verify(b, { ...executionRef(first), run_id: crypto.randomUUID() }),
    ).rejects.toThrow('CLOUD_EXECUTION_CHECKPOINT_MISSING');
  });
});

test('expiry preserves history and spent steps but never renews or reactivates the same grant', async () => {
  const b = await binding(),
    first = grant(b);
  await run(b, async (ledger) => {
    await ledger.accept(b, first, allowed, idle);
    ledger.charge(b, executionRef(first), () => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(first.deadline_at + 1);
    try {
      expect(ledger.current(b)).toEqual(first);
      expect(await ledger.verify(b, executionRef(first), true)).toEqual(first);
      await expect(ledger.accept(b, first, allowed, idle)).rejects.toThrow(
        'CLOUD_EXECUTION_SUSPENDED',
      );
      await expect(ledger.verify(b, executionRef(first))).rejects.toThrow(
        'CLOUD_EXECUTION_SUSPENDED',
      );
      expect(() => ledger.charge(b, executionRef(first), () => {})).toThrow(
        'CLOUD_EXECUTION_SUSPENDED',
      );
      expect(ledger.steps(b)).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
});

test('a running native task blocks grant handoff and storage inspection preserves its running identity', async () => {
  await (
    await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/reset', {
      method: 'POST',
    })
  ).json();
  const b = await binding(),
    first = grant(b),
    next = grant(b);
  await run(b, (ledger, storage) =>
    ledger.accept(b, first, allowed, () => quiescent(storage)),
  );
  const id = crypto.randomUUID();
  const submitted = await request(b, '/messages', {
    request_id: id,
    content: 'INTERRUPT_ONCE ownership proof',
  });
  expect(submitted.status).toBe(202);
  await submitted.json();
  const active = () =>
    run(b, async (_ledger, storage) => {
      const native = await openPiSessionStore(storage);
      try {
        return (await native.scanTasks({}, 100, undefined, BG)).items
          .filter((task) => task.state.status === 'running')
          .map((task) => Number(task.id));
      } finally {
        await native.close(BG);
      }
    });
  await expect.poll(active).not.toEqual([]);
  const before = await active();
  await run(b, async (ledger, storage) => {
    await expect(
      ledger.accept(b, next, allowed, () => quiescent(storage)),
    ).rejects.toThrow('CLOUD_PREVIOUS_EXECUTION_PENDING');
    expect(ledger.current(b)).toEqual(first);
  });
  expect(await active()).toEqual(before);
  const missing = await request(b, '/abort', {
    request_id: crypto.randomUUID(),
  });
  expect(missing.status).toBe(200);
  expect(await missing.json()).toMatchObject({ aborted: false });
  expect(await active()).toEqual(before);
  const aborted = await request(b, '/abort', { request_id: id });
  expect(aborted.status).toBe(200);
  expect(await aborted.json()).toMatchObject({ aborted: true });
  let diagnostic: unknown;
  try {
    await expect
      .poll(async () =>
        run(b, async (_ledger, storage) => {
          try {
            await quiescent(storage);
            return true;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'CLOUD_PREVIOUS_EXECUTION_PENDING'
            ) {
              const native = await openPiSessionStore(storage);
              try {
                const view = await readRootView(native);
                diagnostic = {
                  tasks: (
                    await native.scanTasks({}, 100, undefined, BG)
                  ).items.map((task) => ({
                    id: task.id,
                    state: task.state.status,
                    background: task.background,
                    abortRequested: task.abortRequested,
                  })),
                  liveRun: view.docs[LiveDoc.definition.kind]?.run,
                  inboxCount: Array.isArray(
                    view.docs[InboxDoc.definition.kind]?.items,
                  )
                    ? (view.docs[InboxDoc.definition.kind].items as unknown[])
                        .length
                    : 'invalid',
                };
              } finally {
                await native.close(BG);
              }
              return false;
            }
            throw error;
          }
        }),
      )
      .toBe(true);
  } catch (error) {
    throw new Error(JSON.stringify(diagnostic), { cause: error });
  }
  await run(b, async (ledger, storage) => {
    await ledger.accept(b, next, allowed, () => quiescent(storage));
    expect(ledger.current(b)).toEqual(next);
  });
  expect(
    (
      (await (
        await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
      ).json()) as { requests: number }
    ).requests,
  ).toBe(1);
});

test('only initial provisioning accepts empty native storage; a missing established Root fails closed', async () => {
  const stub = cloud.SESSIONS.getByName(`v1:${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (_instance, state) => {
    await quiescent(state.storage, true);
    await expect(quiescent(state.storage)).rejects.toThrow(
      'CLOUD_EXECUTION_CHECKPOINT_MISSING',
    );
  });
});

test('a managed Session keeps Root and input identities across two granted native runs, old-scope rejection and eviction', async () => {
  await (
    await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/reset', {
      method: 'POST',
    })
  ).json();
  await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/reset',
      { method: 'POST' },
    )
  ).json();
  const b: CloudBinding = {
    ...baseBinding(),
    goal_id: crypto.randomUUID(),
    execution_authority: 'miniclaw-product',
    model_id: 'product-configured-model',
  };
  const first = grant(b),
    next = {
      ...grant(b),
      snapshot_digest: 'd'.repeat(64),
      task_id: first.task_id,
    };
  const create = async (value: unknown) =>
    exports.default.fetch(
      await signedRequest(
        secret,
        b,
        'https://gateway.fixture/internal/cloud-sessions',
        'POST',
        JSON.stringify(value),
      ),
    );
  const missingGrant = await create(b);
  expect(missingGrant.status).toBe(400);
  await missingGrant.json();
  await activeRun(b, first);
  const provisioned = await create({ binding: b, execution: first });
  expect(provisioned.status).toBe(200);
  const identity = (await provisioned.json()) as {
    object_id: string;
    conversation_id: number;
  };
  expect(identity.conversation_id).toBe(1);
  const one = {
    request_id: crypto.randomUUID(),
    content: 'inspect first granted evidence',
    execution: executionRef(first),
    product_receipt_digest: 'a'.repeat(64),
  };
  const submitted = await request(b, '/messages', one);
  expect(submitted.status).toBe(202);
  const original = (await submitted.json()) as {
    receipt: { submission_id: number };
  };
  await runInDurableObject(
    cloud.SESSIONS.getByName(`v1:${b.session_id}`),
    (instance) => instance.harness.wait(one.request_id),
  );
  await expect
    .poll(async () =>
      run(b, async (_ledger, storage) => {
        try {
          await quiescent(storage);
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'CLOUD_PREVIOUS_EXECUTION_PENDING'
          )
            return false;
          throw error;
        }
      }),
    )
    .toBe(true);
  const oldSteps = await run(b, (ledger) => ledger.steps(b));
  expect(oldSteps).toBe(2);
  await activeRun(b, next);
  const accepted = await request(b, '/executions', next);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    accepted: true,
    session_id: b.session_id,
    run_id: next.run_id,
  });
  expect(await run(b, (ledger) => ledger.steps(b))).toBe(0);
  const stale = await request(b, '/messages', {
    ...one,
    request_id: crypto.randomUUID(),
  });
  expect(stale.status).toBe(409);
  await stale.json();
  const two = {
    ...one,
    request_id: crypto.randomUUID(),
    content: 'second granted result',
    execution: executionRef(next),
  };
  const continued = await request(b, '/messages', two);
  expect(continued.status).toBe(202);
  await continued.json();
  await runInDurableObject(
    cloud.SESSIONS.getByName(`v1:${b.session_id}`),
    (instance) => instance.harness.wait(two.request_id),
  );
  const snapshot = async () => {
    const url = `https://gateway.fixture/internal/cloud-sessions/${b.session_id}`;
    const response = await exports.default.fetch(
      await signedRequest(secret, b, url, 'GET'),
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      epoch: string;
      object_id: string;
      inputs: { id: string; submission_id: number; status: string }[];
      execution: { run_id: string; steps: number };
    }>;
  };
  const before = await snapshot();
  expect(before.object_id).toBe(identity.object_id);
  expect(before.execution).toMatchObject({ run_id: next.run_id, steps: 1 });
  expect(before.inputs).toHaveLength(2);
  expect(
    before.inputs.find((input) => input.id === one.request_id),
  ).toMatchObject({
    submission_id: original.receipt.submission_id,
    status: 'done',
  });
  await evictDurableObject(cloud.SESSIONS.getByName(`v1:${b.session_id}`));
  const after = await snapshot();
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.inputs).toEqual(before.inputs);
  expect(after.execution).toEqual(before.execution);
  const observations = (await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/counts',
    )
  ).json()) as { modelExecutions: { session_id: string; run_id: string }[] };
  expect(
    observations.modelExecutions
      .filter((entry) => entry.session_id === b.session_id)
      .map((entry) => entry.run_id),
  ).toEqual([first.run_id, first.run_id, next.run_id]);
  expect(
    (
      (await (
        await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
      ).json()) as { requests: number }
    ).requests,
  ).toBe(3);
});

test('an interrupted managed model stream parks the original native request, survives eviction and resumes by Alarm without another input', async () => {
  await (
    await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/reset', {
      method: 'POST',
    })
  ).json();
  await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/reset',
      { method: 'POST' },
    )
  ).json();
  const b: CloudBinding = {
    ...baseBinding(),
    goal_id: crypto.randomUUID(),
    execution_authority: 'miniclaw-product',
    model_id: 'product-configured-model',
  };
  const execution = grant(b);
  await activeRun(b, execution);
  const provision = await exports.default.fetch(
    await signedRequest(
      secret,
      b,
      'https://gateway.fixture/internal/cloud-sessions',
      'POST',
      JSON.stringify({ binding: b, execution }),
    ),
  );
  expect(provision.status).toBe(200);
  await provision.json();
  const input = {
    request_id: crypto.randomUUID(),
    content: 'INTERRUPT_ONCE',
    product_receipt_digest: 'a'.repeat(64),
    execution: executionRef(execution),
  };
  const admission = await request(b, '/messages', input);
  expect(admission.status).toBe(202);
  const ack = (await admission.json()) as {
    receipt: { submission_id: number };
  };
  const stub = () => cloud.SESSIONS.getByName(`v1:${b.session_id}`);
  const readGeneration = () =>
    runInDurableObject(stub(), async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        const view = await readRootView(storage);
        return (
          view.docs[LiveDoc.definition.kind] as
            | { run?: { taskId: number } }
            | undefined
        )?.run?.taskId;
      } finally {
        await storage.close(BG);
      }
    });
  let generation: number | undefined;
  await expect
    .poll(
      async () => {
        generation = await readGeneration();
        return generation;
      },
      { timeout: 5000 },
    )
    .toBeTypeOf('number');
  await expect
    .poll(
      () =>
        runInDurableObject(
          stub(),
          (_instance, state) =>
            state.storage.sql
              .exec<{
                state: string;
              }>('SELECT state FROM mc_binding WHERE id=1')
              .one().state,
        ),
      { timeout: 15000 },
    )
    .toBe('recovering');
  await runInDurableObject(stub(), (instance) => instance.recovery.closing);
  const parked = await runInDurableObject(stub(), async (instance, state) => {
    const storage = await openPiSessionStore(state.storage);
    try {
      return {
        task: await storage.task(generation as TaskId, BG),
        submission: await storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          input.request_id,
          BG,
        ),
        recovery: instance.recovery.summary(),
      };
    } finally {
      await storage.close(BG);
    }
  });
  expect(parked.task?.state.status).not.toBe('terminal');
  expect(parked.submission?.id).toBe(ack.receipt.submission_id);
  expect(parked.submission?.status).toBe('placed');
  expect(parked.recovery).toMatchObject([
    { run_id: execution.run_id, state: 'waiting', attempts: 0 },
  ]);
  await evictDurableObject(stub());
  await runInDurableObject(stub(), (instance) => {
    const original = instance.harness.pi.bind(instance.harness);
    let fail = true;
    instance.harness.pi = async () => {
      if (fail) {
        fail = false;
        throw new Error('Injected activation failure after policy admission');
      }
      return original();
    };
  });
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(1, parked.recovery[0].not_before - Date.now() + 20),
    ),
  );
  await runDurableObjectAlarm(stub());
  const retry = await runInDurableObject(
    stub(),
    (instance) => instance.recovery.summary()[0],
  );
  expect(retry).toMatchObject({ state: 'waiting', attempts: 1 });
  expect(
    await (
      await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
    ).json(),
  ).toEqual({ requests: 1 });
  await evictDurableObject(stub());
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1, retry.not_before - Date.now() + 20)),
  );
  await runDurableObjectAlarm(stub());
  await expect
    .poll(
      async () =>
        runInDurableObject(stub(), async (_instance, state) => {
          const storage = await openPiSessionStore(state.storage);
          try {
            return (
              await storage.submissionByRequest(
                ROOT_CONVERSATION_ID,
                input.request_id,
                BG,
              )
            )?.status;
          } finally {
            await storage.close(BG);
          }
        }),
      { timeout: 5000 },
    )
    .toBe('done');
  const completed = await runInDurableObject(
    stub(),
    async (instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        return {
          task: await storage.task(generation as TaskId, BG),
          submission: await storage.submissionByRequest(
            ROOT_CONVERSATION_ID,
            input.request_id,
            BG,
          ),
          inputs: state.storage.sql
            .exec<{ n: number }>('SELECT count(*) AS n FROM mc_intents')
            .one().n,
          steps: instance.executions.steps(b),
          recovery: instance.recovery.summary(),
        };
      } finally {
        await storage.close(BG);
      }
    },
  );
  expect(completed.task?.id).toBe(generation);
  expect(completed.task?.state.status).toBe('terminal');
  expect(completed.submission?.id).toBe(ack.receipt.submission_id);
  expect(completed.inputs).toBe(1);
  expect(completed.steps).toBe(2);
  expect(completed.recovery).toMatchObject([
    { run_id: execution.run_id, state: 'resumed', attempts: 2 },
  ]);
  expect(
    await (
      await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
    ).json(),
  ).toEqual({ requests: 2 });
});

async function managedRecoveryFixture(
  content: string,
  ready?: (binding: CloudBinding) => Promise<void>,
) {
  await (
    await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/reset', {
      method: 'POST',
    })
  ).json();
  await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/reset',
      { method: 'POST' },
    )
  ).json();
  const b: CloudBinding = {
    ...baseBinding(),
    goal_id: crypto.randomUUID(),
    execution_authority: 'miniclaw-product',
    model_id: 'product-configured-model',
  };
  const execution = grant(b);
  await activeRun(b, execution);
  const created = await exports.default.fetch(
    await signedRequest(
      secret,
      b,
      'https://gateway.fixture/internal/cloud-sessions',
      'POST',
      JSON.stringify({ binding: b, execution }),
    ),
  );
  expect(created.status).toBe(200);
  await created.json();
  await ready?.(b);
  const input = {
    request_id: crypto.randomUUID(),
    content,
    execution: executionRef(execution),
    product_receipt_digest: 'a'.repeat(64),
  };
  const submitted = await request(b, '/messages', input);
  expect(submitted.status).toBe(202);
  await submitted.json();
  const stub = () => cloud.SESSIONS.getByName(`v1:${b.session_id}`);
  const state = () =>
    runInDurableObject(
      stub(),
      (_instance, s) =>
        s.storage.sql
          .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
          .one().state,
    );
  const models = async () =>
    (
      (await (
        await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
      ).json()) as { requests: number }
    ).requests;
  return { b, execution, input, stub, state, models };
}

test('denied recovery cannot request a model and an evicted exhausted wake stops at its original checkpoint', async () => {
  const fixture = await managedRecoveryFixture('TIMEOUT_FIXTURE');
  await expect.poll(fixture.state).toBe('recovering');
  await runInDurableObject(
    fixture.stub(),
    (instance) => instance.recovery.closing,
  );
  expect(await fixture.models()).toBe(1);
  await activeRun(fixture.b, {
    ...fixture.execution,
    run_id: crypto.randomUUID(),
  });
  const before = await runInDurableObject(
    fixture.stub(),
    (instance) => instance.recovery.summary()[0],
  );
  await evictDurableObject(fixture.stub());
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1, before.not_before - Date.now() + 20)),
  );
  await runDurableObjectAlarm(fixture.stub());
  const denied = await runInDurableObject(
    fixture.stub(),
    (instance) => instance.recovery.summary()[0],
  );
  expect(denied).toMatchObject({ attempts: 1, state: 'waiting' });
  expect(await fixture.models()).toBe(1);
  // Inject the persisted quota boundary, not eight fictional HTTP failures.
  await runInDurableObject(fixture.stub(), (_instance, s) => {
    s.storage.sql.exec(
      'UPDATE mc_execution_recovery SET attempts=8 WHERE run_id=?',
      fixture.execution.run_id,
    );
  });
  await evictDurableObject(fixture.stub());
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1, denied.not_before - Date.now() + 20)),
  );
  await runDurableObjectAlarm(fixture.stub());
  expect(await fixture.state()).toBe('suspended');
  const exhausted = await runInDurableObject(
    fixture.stub(),
    (instance) => instance.recovery.summary()[0],
  );
  expect(exhausted).toMatchObject({ attempts: 8, state: 'exhausted' });
  expect(await fixture.models()).toBe(1);
});

test('a paused owner stays stopped across Alarm/eviction, a stale lease cannot stop resumed work, and cancellation cannot be undone by late activation', async () => {
  const fixture = await managedRecoveryFixture('HOLD_REQUEST_FIXTURE');
  await expect.poll(fixture.models).toBe(1);
  const oldFence = {
    kind: 'claim',
    run_id: fixture.execution.run_id,
    lease_owner: 'scheduler',
    lease_token: 1,
  };
  const stopped = await request(fixture.b, '/suspend', { fence: oldFence });
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ state: 'suspended' });
  await evictDurableObject(fixture.stub());
  await runDurableObjectAlarm(fixture.stub());
  expect(await fixture.state()).toBe('suspended');
  expect(await fixture.models()).toBe(1);
  async function replaceFence(mode = 'suspended') {
    await (
      await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
        'https://authority.fixture/fixture/execution',
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: fixture.b.session_id,
            run_id: fixture.execution.run_id,
            fence: {
              lease_owner: 'replacement',
              lease_token: 2,
              goal_revision: 2,
              mode,
            },
          }),
        },
      )
    ).json();
  }
  await replaceFence();
  const resumed = await request(fixture.b, '/executions', fixture.execution);
  expect(resumed.status).toBe(200);
  await resumed.json();
  await expect.poll(fixture.models).toBe(2);
  const stale = await request(fixture.b, '/suspend', { fence: oldFence });
  expect(stale.status).toBe(409);
  await stale.json();
  expect(await fixture.state()).toBe('active');
  await replaceFence('cancelled');
  const cancelled = await request(fixture.b, '/suspend', {
    fence: { ...oldFence, lease_owner: 'replacement', lease_token: 2 },
  });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ state: 'cancelled' });
  await evictDurableObject(fixture.stub());
  await runDurableObjectAlarm(fixture.stub());
  const late = await request(fixture.b, '/executions', fixture.execution);
  expect(late.status).toBe(409);
  await late.json();
  expect(await fixture.state()).toBe('cancelled');
  expect(await fixture.models()).toBe(2);
});

test('compatible finish_reason EOF with split UTF-8/CRLF frames completes once without a false recovery', async () => {
  const fixture = await managedRecoveryFixture('EOF_WITH_FINISH_FIXTURE');
  await expect
    .poll(() =>
      runInDurableObject(fixture.stub(), async (_instance, state) => {
        const storage = await openPiSessionStore(state.storage);
        try {
          return (
            await storage.submissionByRequest(
              ROOT_CONVERSATION_ID,
              fixture.input.request_id,
              BG,
            )
          )?.status;
        } finally {
          await storage.close(BG);
        }
      }),
    )
    .toBe('done');
  expect(await fixture.models()).toBe(1);
  expect(
    await runInDurableObject(fixture.stub(), (instance) =>
      instance.recovery.summary(),
    ),
  ).toEqual([]);
  const view = await runInDurableObject(
    fixture.stub(),
    async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        return await readRootView(storage);
      } finally {
        await storage.close(BG);
      }
    },
  );
  expect(JSON.stringify(view.entries)).toContain('PROTOCOL 完成');
});

test('stopping cancels a native tool authorization whose HTTP headers arrived but JSON body never completes', async () => {
  const observed = { pending: 0, aborted: 0 };
  const fixture = await managedRecoveryFixture(
    'inspect HOLD_AUTH_POLICY_FIXTURE',
    async (binding) => {
      await runInDurableObject(
        cloud.SESSIONS.getByName(`v1:${binding.session_id}`),
        (instance) => {
          // Observe the actual invocation's policy promise without changing it.
          const target = instance as unknown as {
            authorizeInvocation: (
              grant: CloudExecutionGrant | undefined,
              signal?: AbortSignal,
            ) => Promise<void>;
          };
          const original = target.authorizeInvocation.bind(instance);
          target.authorizeInvocation = async (grant, signal) => {
            if (!signal) return original(grant, signal);
            observed.pending++;
            try {
              return await original(grant, signal);
            } finally {
              observed.pending--;
              if (signal.aborted) observed.aborted++;
            }
          };
        },
      );
    },
  );
  await expect
    .poll(
      async () =>
        (
          (await (
            await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
              'https://authority.fixture/fixture/counts',
            )
          ).json()) as { heldPolicies: number }
        ).heldPolicies,
      { timeout: 5000 },
    )
    .toBe(1);
  expect(await fixture.state()).toBe('active');
  expect(observed.pending).toBe(1);
  expect(
    await runInDurableObject(fixture.stub(), (instance) =>
      instance.recovery.summary(),
    ),
  ).toEqual([]);
  const stop = request(fixture.b, '/suspend', {
    fence: {
      kind: 'claim',
      run_id: fixture.execution.run_id,
      lease_owner: 'scheduler',
      lease_token: 1,
    },
  });
  let result: Response | undefined, error: unknown;
  void stop.then(
    (value) => {
      result = value;
    },
    (failure) => {
      error = failure;
    },
  );
  await expect
    .poll(
      () => {
        if (error) throw error;
        return result?.status;
      },
      { timeout: 5000 },
    )
    .toBe(200);
  expect(await result!.json()).toMatchObject({ state: 'suspended' });
  const native = await runInDurableObject(
    fixture.stub(),
    async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        return await storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          fixture.input.request_id,
          BG,
        );
      } finally {
        await storage.close(BG);
      }
    },
  );
  expect(native?.status).toBe('placed');
  expect(await fixture.state()).toBe('suspended');
  expect(await fixture.models()).toBe(1);
  await expect.poll(() => observed.pending, { timeout: 5000 }).toBe(0);
  expect(observed.aborted).toBeGreaterThan(0);
});

test('Authority denial during Lifecycle startup parks the original native request and resumes it through the existing bounded Alarm', async () => {
  for (const [service, url] of [
    [cloud.MODEL_SERVICE!, 'https://provider.fixture/reset'],
    [
      cloud.MINICLAW_AUTHORITY_SERVICE!,
      'https://authority.fixture/fixture/reset',
    ],
  ] as const)
    await (await service.fetch(url, { method: 'POST' })).json();
  const b: CloudBinding = {
    ...baseBinding(),
    goal_id: crypto.randomUUID(),
    execution_authority: 'miniclaw-product',
    model_id: 'product-configured-model',
  };
  const execution = grant(b);
  await activeRun(b, execution);
  const created = await exports.default.fetch(
    await signedRequest(
      secret,
      b,
      'https://gateway.fixture/internal/cloud-sessions',
      'POST',
      JSON.stringify({ binding: b, execution }),
    ),
  );
  expect(created.status).toBe(200);
  await created.json();
  const input = {
    request_id: crypto.randomUUID(),
    content: 'INTERRUPT_ONCE',
    product_receipt_digest: 'a'.repeat(64),
    execution: executionRef(execution),
  };
  const accepted = await request(b, '/messages', input);
  expect(accepted.status).toBe(202);
  const ack = (await accepted.json()) as { receipt: { submission_id: number } };
  const stub = cloud.SESSIONS.getByName(`v1:${b.session_id}`);
  const calls = async () =>
    (
      (await (
        await cloud.MODEL_SERVICE!.fetch('https://provider.fixture/requests')
      ).json()) as { requests: number }
    ).requests;
  await expect.poll(calls).toBe(1);
  const inspect = () =>
    runInDurableObject(stub, async (instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        const submission = await storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          input.request_id,
          BG,
        );
        const view = await readRootView(storage);
        const live = view.docs[LiveDoc.definition.kind] as
          | { run?: { taskId: number } }
          | undefined;
        return {
          submission,
          task: live?.run?.taskId
            ? await storage.task(live.run.taskId as TaskId, BG)
            : undefined,
          inputs: state.storage.sql
            .exec<{ n: number }>('SELECT COUNT(*) n FROM mc_intents')
            .one().n,
          recovery: instance.recovery.summary(),
          state: state.storage.sql
            .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
            .one().state,
          steps: instance.executions.steps(instance.binding()),
          users: view.entries.filter((e) => e.kind === 'pi.user').length,
        };
      } finally {
        await storage.close(BG);
      }
    });
  const before = await inspect();
  expect(before.submission?.id).toBe(ack.receipt.submission_id);
  expect(before.submission?.status).toBe('placed');
  expect(before.task?.state.status).not.toBe('terminal');
  expect(before.recovery).toEqual([]);
  // Close only the in-memory owner at this actual native checkpoint. Unlike
  // waiting for the fixture stream to end during eviction, this preserves an
  // active persisted grant whose startup must perform fresh authorization.
  await runInDurableObject(stub, (instance) => instance.harness.dispose());
  const closed = await inspect();
  expect(closed.state).toBe('active');
  expect(closed.recovery).toEqual([]);
  expect(closed.submission?.status).toBe('placed');
  expect(await calls()).toBe(1);
  await (
    await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
      'https://authority.fixture/fixture/revoke-execution',
      { method: 'POST' },
    )
  ).json();
  try {
    await evictDurableObject(stub);
    // Go through the actual Lifecycle-installed fetch, not the read-only RPC.
    const denied = await stub.fetch(
      await signedRequest(
        secret,
        b,
        `https://gateway.fixture/internal/cloud-sessions/${b.session_id}/messages`,
        'POST',
        JSON.stringify(input),
      ),
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: 'CLOUD_EXECUTION_SUSPENDED' });
    const parked = await inspect();
    expect(parked.state).toBe('recovering');
    expect(parked.recovery).toMatchObject([
      { run_id: execution.run_id, state: 'waiting', attempts: 0 },
    ]);
    expect(parked.submission?.id).toBe(before.submission?.id);
    expect(parked.task?.id).toBe(before.task?.id);
    expect(parked.task?.state.status).not.toBe('terminal');
    expect([parked.inputs, parked.users, parked.steps, await calls()]).toEqual([
      1, 1, 1, 1,
    ]);
    // A denied retry consumes the existing recovery attempt only. Rebuilding
    // the DO cannot reset that counter or create another native input/model.
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(1, parked.recovery[0].not_before - Date.now() + 20),
      ),
    );
    await runDurableObjectAlarm(stub);
    const retry = await inspect();
    expect(retry.recovery).toMatchObject([
      { run_id: execution.run_id, state: 'waiting', attempts: 1 },
    ]);
    expect(retry.task?.id).toBe(before.task?.id);
    expect(retry.task?.state.status).not.toBe('terminal');
    expect([retry.inputs, retry.users, retry.steps, await calls()]).toEqual([
      1, 1, 1, 1,
    ]);
    await evictDurableObject(stub);
    expect((await inspect()).recovery).toEqual(retry.recovery);
    await (
      await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
        'https://authority.fixture/fixture/allow-execution',
        { method: 'POST' },
      )
    ).json();
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(1, retry.recovery[0].not_before - Date.now() + 20),
      ),
    );
    await runDurableObjectAlarm(stub);
    await expect
      .poll(async () => (await inspect()).submission?.status, {
        timeout: 10000,
      })
      .toBe('done');
    const done = await inspect();
    expect(done.submission?.id).toBe(before.submission?.id);
    expect([done.inputs, done.users, done.steps, await calls()]).toEqual([
      1, 1, 2, 2,
    ]);
    expect(done.recovery).toMatchObject([
      { run_id: execution.run_id, state: 'resumed', attempts: 2 },
    ]);
    console.info(
      'CLOUD_STARTUP_RECOVERY_PROOF ' +
        JSON.stringify({
          inference: 'synthetic-workerd',
          run_id: execution.run_id,
          submission_id: Number(before.submission!.id),
          task_id: Number(before.task!.id),
          parked: {
            state: parked.state,
            native_task_status: parked.task!.state.status,
            inputs: parked.inputs,
            model_calls: 1,
            steps: parked.steps,
          },
          completed: {
            status: done.submission!.status,
            inputs: done.inputs,
            model_calls: await calls(),
            steps: done.steps,
            recovery: done.recovery[0].state,
          },
        }),
    );
  } finally {
    await (
      await cloud.MINICLAW_AUTHORITY_SERVICE!.fetch(
        'https://authority.fixture/fixture/allow-execution',
        { method: 'POST' },
      )
    ).json();
  }
});
