// Production HTTP + Node Pi Durable; inference is an isolated synthetic provider.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { ConversationId } from '@earendil-works/pi-durable';
import {
  botHandoffHttpFixture,
  waitFor,
  type ModelBody,
  type ModelPlan,
} from './helpers/bot-handoff-http-fixture.js';

import {
  memberEnvelopes,
  freshMemberGroup,
  recordProof,
} from './helpers/member-inbox-http-fixture.js';

test('lost submit ACK and duplicate user commands reconcile one original native input without another inference', async () => {
  const faultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-ack-fault-'));
  const preload = path.join(faultRoot, 'ack.mjs');
  const module = new URL(
    '../dist/personal-agent/product-runtime.js',
    import.meta.url,
  ).href;
  fs.writeFileSync(
    preload,
    `import { ProductRuntimeService } from ${JSON.stringify(module)};
const submit = ProductRuntimeService.prototype.submit;
let dropped = false;
ProductRuntimeService.prototype.submit = async function (...args) {
  const [session, request] = args;
  const value = await submit.apply(this, args);
  if (!dropped && request.startsWith('member-root:')) { dropped = true; throw new Error('SYNTHETIC_LOST_NATIVE_ACK'); }
  return value;
};\n`,
  );
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  let storage: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(preload, {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
    });
    const { groupId, people } = await freshMemberGroup(f);
    const content = `DEDUP_${randomUUID()}`,
      key = randomUUID();
    const body = { content, mentions: [people[0].id], dispatch: true };
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', body, key),
    );
    await waitFor(() => f!.held.size === 1);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              'SELECT delivery_attempts FROM bot_group_member_inputs WHERE run_id=?',
            )
            .get(run.id) as any
        )?.delivery_attempts === 2,
    );
    const input = storage
      .prepare('SELECT * FROM bot_group_member_inputs WHERE run_id=?')
      .get(run.id) as any;
    expect(input.request_id).toMatch(/^member-root:/);
    expect(input.state).toBe('submitted');
    const receipt = storage
      .prepare('SELECT * FROM product_session_inputs WHERE id=?')
      .get(input.input_id) as any;
    expect(receipt.submission_id).toBeGreaterThan(0);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', body, key),
    );
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', body, key),
    );
    expect(
      storage
        .prepare(
          'SELECT COUNT(*) n FROM bot_group_member_inputs WHERE run_id=?',
        )
        .get(run.id),
    ).toEqual({ n: 1 });
    expect(
      storage
        .prepare(
          'SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(input.session_id),
    ).toEqual({ n: 1 });
    expect(f.requests).toHaveLength(1);
    f.release({ text: `FINAL_${content}` });
    await waitFor(
      async () =>
        (await f!.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    const snapshot = await f.snapshot(groupId);
    expect(
      snapshot.messages.filter((m) => m.content === `FINAL_${content}`),
    ).toHaveLength(1);
    expect(snapshot.discussion!.run!.model_attempts).toBe(1);
    expect(
      storage
        .prepare('SELECT submission_id FROM product_session_inputs WHERE id=?')
        .get(receipt.id),
    ).toEqual({ submission_id: receipt.submission_id });
    recordProof('lost-ack', f, storage, run.id);
  } catch (error) {
    if (f) console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f?.dispose();
    fs.rmSync(faultRoot, { recursive: true, force: true });
  }
}, 180_000);

test('the default-off gate admits no work; cross-group recipients stay asleep and live removal fences an already running member', async () => {
  const environment = { MINICLAW_GROUP_MEMBER_INBOX: 'false' };
  const f = await botHandoffHttpFixture(undefined, environment);
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f, false);
    let snapshot = await f.snapshot(groupId);
    expect(snapshot.discussion?.member_inbox_available).toBe(false);
    const configure = () =>
      f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        expected_revision: snapshot.revision,
      });
    expect((await configure()).ok).toBe(false);
    expect((await f.snapshot(groupId)).discussion?.settings).toBeNull();
    expect(f.requests).toHaveLength(0);
    await f.stop();
    environment.MINICLAW_GROUP_MEMBER_INBOX = 'true';
    await f.start();
    snapshot = await f.snapshot(groupId);
    await f.json(await configure());
    const third = await f.json<any>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Other group only',
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
      }),
    );
    const other = await f.json<any>(
      await f.call('/api/bot-groups', 'POST', {
        name: 'Separate authorized context',
        bot_profile_ids: [third.profile.id],
      }),
    );
    const canary = `OTHER_GROUP_PRIVATE_${randomUUID()}`;
    await f.json(
      await f.call(
        `/api/bot-groups/${other.snapshot.group.id}/messages`,
        'POST',
        { content: canary, dispatch: false },
      ),
    );
    f.setModel((_body, call) =>
      call === 1
        ? {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: third.profile.id,
                message: 'No authorization from a profile ID.',
              },
            },
          }
        : { hold: true },
    );
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Review public scope only.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 1);
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests)).not.toContain(canary);
    expect(JSON.stringify(f.requests[1])).toContain(
      'GROUP_MEMBER_RECIPIENT_UNAVAILABLE',
    );
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=?')
        .get(run.id),
    ).toEqual({ n: 0 });
    snapshot = await f.snapshot(groupId);
    const member = snapshot.members.find(
      (m) => m.kind === 'bot' && m.subject_id === people[1].id,
    )!;
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/members/${member.id}`, 'PATCH', {
        state: 'removed',
        expected_revision: snapshot.revision,
      }),
    );
    await waitFor(() => {
      const outcome = storage!
        .prepare('SELECT status FROM bot_group_discussions WHERE id=?')
        .get(run.id) as any;
      const live = storage!
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
        )
        .get(run.id) as any;
      return outcome.status === 'failed' && live.n === 0;
    });
    f.release({ text: 'LATE_AFTER_REVOCATION_MUST_NOT_PUBLISH' });
    snapshot = await f.snapshot(groupId);
    expect(
      snapshot.messages.some((m) =>
        m.content.includes('LATE_AFTER_REVOCATION'),
      ),
    ).toBe(false);
    expect(f.requests).toHaveLength(2);
    expect(snapshot.discussion!.run!.model_attempts).toBe(2);
    recordProof('live-removal-and-default-off', f, storage, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test('two freshly selected Dots exchange native inputs while the sender is unfinished; corrections steer at a safe boundary', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    let snapshot = await f.snapshot(groupId);
    const nonce = randomUUID();
    const question = `Review this run's preview allowance: ${nonce}; 71 minus 24?`;
    const answer = `REVIEWED_${nonce}_47`;
    const result = `FINAL_${nonce}_47_PREVIEW_ONLY`;
    let callsA = 0,
      callsB = 0;
    let modelFailure: unknown;
    const plan = (body: ModelBody): ModelPlan => {
      const envelopes = memberEnvelopes(body),
        current = envelopes.at(-1);
      expect(current).toBeDefined();
      expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual([
        'ask_group_dot',
        'read_group_context',
      ]);
      if (current.recipient_profile_id === people[1].id) {
        callsB++;
        expect(current.trigger.content).toBe(question);
        expect(current.input_kind).toBe('question');
        return { text: answer };
      }
      expect(current.recipient_profile_id).toBe(people[0].id);
      callsA++;
      if (callsA === 1)
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1].id,
              message: question,
            },
          },
        };
      if (callsA === 2) return { hold: true };
      // A only sees the real answer after Pi has placed the reply input, rather
      // than a tool querying future mail while its original generation is held.
      expect(
        envelopes.some(
          (e) => e.input_kind === 'reply' && e.trigger.content === answer,
        ),
      ).toBe(true);
      expect(
        envelopes.some(
          (e) =>
            e.input_kind === 'control' &&
            e.trigger.content === '只处理预览环境，不得部署生产。',
        ),
      ).toBe(true);
      expect(envelopes.some((e) => e.input_kind === 'root')).toBe(true);
      return { text: result };
    };
    f.setModel((body) => {
      try {
        return plan(body);
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_MODEL_ASSERTION_FAILED' };
      }
    });

    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: `Developer: review the allowance for ${nonce}; ask Reviewer while you keep working.`,
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          `Member run failed: ${snapshot.discussion.run.error_code}`,
        );
      return (
        f.held.size === 1 && snapshot.messages.some((m) => m.content === answer)
      );
    });
    const run = snapshot.discussion!.run!;
    expect(run.execution_contract).toBe('member-inbox-v1');
    expect(run.status).toBe('running');
    const a = storage
      .prepare(
        'SELECT session_id FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[0].id) as { session_id: string };
    const original = storage
      .prepare(
        "SELECT * FROM bot_group_member_inputs WHERE run_id=? AND kind='root'",
      )
      .get(run.id) as any;
    const rootProduct = storage
      .prepare('SELECT * FROM product_session_inputs WHERE id=?')
      .get(original.input_id) as any;
    expect(rootProduct.state).toBe('submitted');
    expect(callsB).toBe(1);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '只处理预览环境，不得部署生产。',
        dispatch: true,
      }),
    );
    await waitFor(() => {
      const control = storage!
        .prepare(
          "SELECT input_id FROM bot_group_member_inputs WHERE run_id=? AND kind='control'",
        )
        .get(run.id) as any;
      return !!control?.input_id;
    });
    expect(f.held.size).toBe(1);
    f.release({ tool: { name: 'read_group_context', arguments: {} } });
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          `Member run failed: ${snapshot.discussion.run.error_code}`,
        );
      return snapshot.discussion?.run?.status === 'completed';
    });
    expect(
      snapshot.messages.filter((m) => m.content === question),
    ).toHaveLength(1);
    expect(snapshot.messages.filter((m) => m.content === answer)).toHaveLength(
      1,
    );
    expect(snapshot.messages.filter((m) => m.content === result)).toHaveLength(
      1,
    );
    expect(callsA).toBe(3);
    expect(callsB).toBe(1);
    const inputs = storage
      .prepare('SELECT * FROM bot_group_member_inputs WHERE run_id=?')
      .all(run.id) as any[];
    expect(inputs).toHaveLength(4);
    expect(inputs.every((i) => i.state === 'completed' && i.input_id)).toBe(
      true,
    );
    const dispatches = storage
      .prepare(
        'SELECT * FROM bot_group_member_model_requests WHERE run_id=? ORDER BY created_at',
      )
      .all(run.id) as any[];
    expect(dispatches).toHaveLength(4);
    const aDispatches = dispatches.filter((d) => d.session_id === a.session_id);
    expect(aDispatches[2].native_task_id).not.toBe(
      aDispatches[0].native_task_id,
    );
    const consumed = JSON.parse(aDispatches[2].source_inputs) as any[];
    expect(new Set(consumed.map((i) => i.requestId))).toEqual(
      new Set(
        inputs
          .filter((i) => i.session_id === a.session_id)
          .map((i) => i.request_id),
      ),
    );
    const mail = storage
      .prepare('SELECT * FROM bot_group_member_mail WHERE run_id=?')
      .all(run.id) as any[];
    expect(mail).toHaveLength(2);
    expect(mail.find((m) => m.kind === 'reply').in_reply_to).toBe(
      mail.find((m) => m.kind === 'question').id,
    );
    expect(snapshot.discussion!.run!.model_attempts).toBe(4);
    const callCount = f.requests.length;
    await f.snapshot(groupId);
    await f.snapshot(groupId);
    expect(f.requests).toHaveLength(callCount);
    recordProof('unfinished-sender-reply-and-correction', f, storage, run.id);
  } catch (error) {
    // Entirely synthetic, isolated fixture diagnostics; no user runtime data.
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test('restart reconciles the original member inputs and native submissions, charging retries without duplicate public replies', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    const nonce = randomUUID(),
      question = `CHECK_${nonce}_83_MINUS_29`,
      answer = `ANSWER_${nonce}_54`,
      final = `DONE_${nonce}_54`;
    let callsA = 0,
      callsB = 0;
    f.setModel((body) => {
      const current = memberEnvelopes(body).at(-1);
      if (current?.recipient_profile_id === people[1].id) {
        callsB++;
        return callsB === 1 ? { hold: true } : { text: answer };
      }
      callsA++;
      if (callsA === 1)
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1].id,
              message: question,
            },
          },
        };
      if (callsA <= 3) return { hold: true };
      return { text: final };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: `Check ${nonce}`,
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 2);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const before = storage
      .prepare(
        'SELECT id,session_id,request_id,input_id FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
      )
      .all(run.id) as any[];
    expect(before).toHaveLength(2);
    const beforeNative = storage
      .prepare(
        'SELECT id,request_id,submission_id FROM product_session_inputs WHERE session_id IN (SELECT session_id FROM bot_group_member_leases WHERE run_id=?) ORDER BY id',
      )
      .all(run.id);
    await f.stop('SIGKILL');
    await f.start();
    await waitFor(async () => {
      const snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          `Restart failed: ${snapshot.discussion.run.error_code}`,
        );
      return (
        f.held.size === 1 && snapshot.messages.some((m) => m.content === answer)
      );
    });
    expect(
      storage
        .prepare(
          "SELECT id,session_id,request_id,input_id FROM bot_group_member_inputs WHERE run_id=? AND kind IN ('root','question') ORDER BY id",
        )
        .all(run.id),
    ).toEqual(before);
    for (const receipt of beforeNative as any[])
      expect(
        storage
          .prepare(
            'SELECT id,request_id,submission_id FROM product_session_inputs WHERE id=?',
          )
          .get(receipt.id),
      ).toEqual(receipt);
    f.release({ tool: { name: 'read_group_context', arguments: {} } });
    await waitFor(async () => {
      const snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          `Restart failed: ${snapshot.discussion.run.error_code}`,
        );
      return snapshot.discussion?.run?.status === 'completed';
    });
    const snapshot = await f.snapshot(groupId);
    expect(snapshot.messages.filter((m) => m.content === answer)).toHaveLength(
      1,
    );
    expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
      1,
    );
    expect(callsA).toBe(4);
    expect(callsB).toBe(2);
    expect(snapshot.discussion!.run!.model_attempts).toBe(6);
    const last = memberEnvelopes(f.requests.at(-1)!);
    expect(
      last.some(
        (e) => e.input_kind === 'reply' && e.trigger.content === answer,
      ),
    ).toBe(true);
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=?')
        .get(run.id),
    ).toEqual({ n: 2 });
    recordProof('restart-original-inputs', f, storage, run.id, {
      before_inputs: before,
      before_native_receipts: beforeNative,
    });
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test('a crash after the product Stop fence joins the real native checkpoint on restart with the feature disabled', async () => {
  const faultRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'member-stop-fault-'),
  );
  const preload = path.join(faultRoot, 'stop.mjs');
  // Crash boundary: product Stop is committed, but the native abort has not
  // happened. The replacement is absent from the restarted production process.
  const runtimeModule = new URL(
    '../dist/personal-agent/product-runtime.js',
    import.meta.url,
  ).href;
  fs.writeFileSync(
    preload,
    `import { ProductRuntimeService } from ${JSON.stringify(runtimeModule)};\nProductRuntimeService.prototype.stopGroupDiscussionSession = async function () { await new Promise(() => {}); };\n`,
  );
  const environment = { MINICLAW_GROUP_MEMBER_INBOX: 'true' };
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  let storage: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(preload, environment);
    const { groupId, people } = await freshMemberGroup(f);
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Hold this preview review until interrupted.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f!.held.size === 1);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const stopKey = randomUUID();
    const stopped = f
      .call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/stop`,
        'POST',
        {},
        stopKey,
      )
      .catch(() => null);
    await waitFor(
      () =>
        (
          storage!
            .prepare('SELECT status FROM bot_group_discussions WHERE id=?')
            .get(run.id) as any
        )?.status === 'cancelled',
    );
    const checkpoint = storage
      .prepare(
        'SELECT r.session_id,r.conversation_id FROM product_session_runtimes r JOIN bot_group_member_leases l ON l.session_id=r.session_id WHERE l.run_id=? AND r.conversation_id IS NOT NULL',
      )
      .get(run.id) as any;
    expect(checkpoint).toBeDefined();
    expect(
      storage
        .prepare('SELECT cancel_epoch FROM bot_group_discussions WHERE id=?')
        .get(run.id),
    ).toEqual({ cancel_epoch: 1 });
    await f.stop('SIGKILL');
    await stopped;
    environment.MINICLAW_GROUP_MEMBER_INBOX = 'false';
    await f.start();
    await waitFor(
      async () =>
        (await f!.snapshot(groupId)).discussion?.run?.stop_state === 'stopped',
    );
    expect(f.requests).toHaveLength(1);
    expect(
      storage
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
        )
        .get(run.id),
    ).toEqual({ n: 0 });
    expect(
      storage
        .prepare(
          "SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=? AND state IN ('admitted','submitted')",
        )
        .get(checkpoint.session_id),
    ).toEqual({ n: 0 });
    const native = await openNodeSqliteStorage(
      path.join(
        f.root,
        'data/db/durable-sessions',
        `${checkpoint.session_id}.sqlite`,
      ),
    );
    try {
      const submissions = await native.scanSubmissions(
        { conversationId: checkpoint.conversation_id as ConversationId },
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(
        submissions.items
          .filter((s) => s.type === 'input')
          .map((s) => s.status),
      ).toEqual(['unanswered']);
      const tasks = await native.scanTasks(
        { conversationId: checkpoint.conversation_id as ConversationId },
        100,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(tasks.items.length).toBeGreaterThan(0);
      expect(
        tasks.items.every((task) => task.state.status === 'terminal'),
      ).toBe(true);
      recordProof('restart-stop-gray-off', f, storage, run.id, {
        native_submissions_after_stop: submissions.items,
        native_tasks_after_stop: tasks.items.map((task) => ({
          id: task.id,
          state: task.state.status,
          abort_requested: task.abortRequested,
        })),
      });
    } finally {
      await native.close(BACKGROUND_CONTEXT);
    }
    const replay = await f.json<any>(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/stop`,
        'POST',
        {},
        stopKey,
      ),
    );
    expect(replay.snapshot.discussion.run.stop_state).toBe('stopped');
    expect(
      storage
        .prepare('SELECT cancel_epoch FROM bot_group_discussions WHERE id=?')
        .get(run.id),
    ).toEqual({ cancel_epoch: 1 });
    const rejected = await f.call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      {
        content: 'Do not admit another member run while gray-off.',
        dispatch: true,
      },
    );
    expect(rejected.ok).toBe(false);
    expect(f.requests).toHaveLength(1);
  } catch (error) {
    if (f) console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f?.dispose();
    fs.rmSync(faultRoot, { recursive: true, force: true });
  }
}, 180_000);
