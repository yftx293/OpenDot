// Actual Pi owners/HTTP/SQLite; only model inference is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
import {
  botHandoffHttpFixture,
  waitFor,
  type ModelBody,
  type ModelPlan,
} from './helpers/bot-handoff-http-fixture.js';
import {
  memberEnvelopes,
  grantMemberTools,
  recordProof,
} from './helpers/member-inbox-http-fixture.js';
const flags = {
  MINICLAW_GROUP_MEMBER_INBOX: 'true',
  MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
};
type Fixture = Awaited<ReturnType<typeof botHandoffHttpFixture>>;
async function fresh(f: Fixture) {
  const people: { id: string; jid: string }[] = [];
  for (const name of ['Developer', 'Reviewer', 'Researcher']) {
    const p = await f.json<any>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name,
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
      }),
    );
    people.push({ id: p.profile.id, jid: p.jid });
  }
  const created = await f.json<{ snapshot: BotGroupSnapshot }>(
    await f.call('/api/bot-groups', 'POST', {
      name: 'Bounded native members',
      bot_profile_ids: people.map((p) => p.id),
    }),
  );
  const groupId = created.snapshot.group.id;
  await f.json(
    await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
      enabled: true,
      policy: 'relay-v1',
      execution_contract: 'member-inbox-v1',
      participant_profile_ids: people.map((p) => p.id),
      coordinator_profile_id: people[0].id,
      max_turns: 12,
      max_turns_per_dot: 3,
      expected_revision: created.snapshot.revision,
    }),
  );
  return { groupId, people };
}
const current = (body: ModelBody) => memberEnvelopes(body).at(-1)!;
const openStorage = (f: Fixture) =>
  new Database(path.join(f.root, 'data/db/messages.db'), { readonly: true });
async function send(
  f: Fixture,
  group: string,
  profile: string,
  content: string,
) {
  return f.json(
    await f.call(`/api/bot-groups/${group}/messages`, 'POST', {
      content,
      mentions: [profile],
      dispatch: true,
    }),
  );
}
function rows(db: Database.Database, runId: string) {
  return db
    .prepare(
      'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? ORDER BY ordinal',
    )
    .all(runId) as any[];
}
function record(
  name: string,
  f: Fixture,
  db: Database.Database,
  runId: string,
) {
  const files = [
    'src/bot-groups/member-model-store.ts',
    'src/bot-groups/member-model-schema.ts',
    'src/bot-groups/member-inbox-store.ts',
    'src/bot-groups/member-wire.ts',
    'src/bot-groups/discussion-store.ts',
    'src/personal-agent/product-runtime.ts',
    'src/personal-agent/durable-runtime.ts',
    'src/personal-agent/native-product-source.ts',
    'src/personal-agent/metered-model-api.ts',
    'src/personal-agent/product-model.ts',
    'tests/group-member-inbox-concurrency-http.test.ts',
    'tests/helpers/bot-handoff-http-fixture.ts',
    'tests/helpers/member-envelopes.ts',
  ];
  recordProof(name, f, db, runId, {
    source_sha256: Object.fromEntries(
      files.map((p) => [
        p,
        createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
      ]),
    ),
    model_admissions: rows(db, runId).map(({ instance_id, ...row }) => ({
      ...row,
      instance_sha256: createHash('sha256').update(instance_id).digest('hex'),
    })),
    owner_model_admissions: db
      .prepare(
        'SELECT a.* FROM bot_group_member_model_admissions a JOIN bot_group_discussions r ON r.id=? WHERE a.owner_user_id=r.owner_user_id ORDER BY a.ordinal',
      )
      .all(runId)
      .map((value: any) => {
        const { instance_id, ...row } = value;
        return {
          ...row,
          instance_sha256: createHash('sha256')
            .update(instance_id)
            .digest('hex'),
        };
      }),
    execution_limits: db
      .prepare(
        'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
      )
      .get(runId),
  });
}
async function stop(f: Fixture, group: string) {
  const s = await f.snapshot(group);
  await f.json(
    await f.call(
      `/api/bot-groups/${group}/discussions/${s.discussion!.run!.id}/stop`,
      'POST',
      {},
    ),
  );
  await waitFor(
    async () =>
      (await f.snapshot(group)).discussion?.run?.stop_state === 'stopped',
  );
}

test('three independent native Sessions overlap two actual requests and queue the third without reading future peer replies', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await fresh(f);
    expect(f.requests).toHaveLength(0);
    db = openStorage(f);
    const b = `PEER_B_${randomUUID()}_47`,
      c = `PEER_C_${randomUUID()}_47`,
      final = `BOTH_PEERS_${randomUUID()}_47`;
    let a = 0,
      failure: unknown;
    f.setModel((body) => {
      try {
        const input = current(body);
        if (input.recipient_profile_id !== people[0].id) return { hold: true };
        a++;
        if (a < 3)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[a].id,
                message: `Review this public task: ${a === 1 ? b : c}`,
              },
            },
          };
        if (a === 3) {
          expect(
            memberEnvelopes(body).some((e) => e.input_kind === 'reply'),
          ).toBe(false);
          return { hold: true };
        }
        const seen = memberEnvelopes(body)
          .filter((e) => e.run_id === input.run_id && e.input_kind === 'reply')
          .map((e) => e.trigger.content);
        expect(seen).toEqual(expect.arrayContaining([b, c]));
        return { text: final };
      } catch (error) {
        failure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await send(
      f,
      groupId,
      people[0].id,
      'Ask two peers while you continue your own work.',
    );
    let snapshot = await f.snapshot(groupId);
    const check = () => {
      if (failure) throw failure;
    };
    await waitFor(async () => {
      check();
      snapshot = await f.snapshot(groupId);
      return (
        f.held.size === 2 &&
        rows(db!, snapshot.discussion!.run!.id).filter(
          (r) => r.state === 'waiting',
        ).length === 1
      );
    });
    const run = snapshot.discussion!.run!;
    // Either A or its second peer may reach the capacity boundary first.
    expect([2, 3]).toContain(a);
    expect(rows(db, run.id).filter((r) => r.state === 'active')).toHaveLength(
      2,
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_inputs WHERE run_id=? AND kind='root' AND state='submitted'",
        )
        .get(run.id),
    ).toEqual({ n: 1 });
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[1].id,
        { text: b },
      ),
    ).toBe(1);
    await waitFor(() => {
      check();
      return a === 3 && f.held.size === 2;
    });
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[2].id,
        { text: c },
      ),
    ).toBe(1);
    await waitFor(async () => {
      check();
      snapshot = await f.snapshot(groupId);
      return (
        snapshot.messages.some((m) => m.content === b) &&
        snapshot.messages.some((m) => m.content === c)
      );
    });
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[0].id,
        { tool: { name: 'read_group_context', arguments: {} } },
      ),
    ).toBe(1);
    await waitFor(async () => {
      check();
      snapshot = await f.snapshot(groupId);
      return snapshot.discussion?.run?.status !== 'running';
    });
    expect(snapshot.discussion!.run!.status).toBe('completed');
    expect(a).toBe(4);
    expect(f.requests).toHaveLength(6);
    expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
      1,
    );
    expect(
      rows(db, run.id).every(
        (r) => r.state === 'released' && r.request_id && r.accounted_tokens > 0,
      ),
    ).toBe(true);
    const requests = rows(db, run.id);
    let peak = 0;
    for (const r of requests) {
      peak = Math.max(
        peak,
        requests.filter(
          (other) =>
            other.dispatched_at <= r.dispatched_at &&
            other.ended_at > r.dispatched_at,
        ).length,
      );
    }
    expect(peak).toBe(2);
    expect(
      db
        .prepare(
          'SELECT COUNT(DISTINCT session_id) n FROM bot_group_member_leases WHERE run_id=?',
        )
        .get(run.id),
    ).toEqual({ n: 3 });
    record('three-members-two-active', f, db, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);

test('one owner shares four model slots across Groups; waiting does not infer and stopping one Group leaves the others running', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const groups: Awaited<ReturnType<typeof fresh>>[] = [];
    for (let i = 0; i < 3; i++) groups.push(await fresh(f));
    expect(f.requests).toHaveLength(0);
    db = openStorage(f);
    const byProfile = new Map(
      groups.flatMap((g) => g.people.map((p) => [p.id, g] as const)),
    );
    const asked = new Set<string>();
    f.setModel((body) => {
      const input = current(body),
        g = byProfile.get(input.recipient_profile_id)!;
      if (
        g !== groups[2] &&
        input.recipient_profile_id === g.people[0].id &&
        !asked.has(input.run_id)
      ) {
        asked.add(input.run_id);
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: g.people[1].id,
              message: 'Review this current Group only.',
            },
          },
        };
      }
      return { hold: true };
    });
    for (const g of groups.slice(0, 2)) {
      await send(
        f,
        g.groupId,
        g.people[0].id,
        'Keep working and ask the reviewer.',
      );
      await waitFor(() => f.held.size === (g === groups[0] ? 2 : 4));
    }
    const initial = f.requests.length;
    await send(
      f,
      groups[2].groupId,
      groups[2].people[0].id,
      'Independent work must wait only for the owner capacity.',
    );
    const third = (await f.snapshot(groups[2].groupId)).discussion!.run!;
    await waitFor(() => rows(db!, third.id).some((r) => r.state === 'waiting'));
    expect(f.requests).toHaveLength(initial);
    const originalWaitingRun = third.id;
    await stop(f, groups[2].groupId);
    expect(
      rows(db, originalWaitingRun).every(
        (r) =>
          !r.request_id && r.accounted_tokens === 0 && r.state === 'cancelled',
      ),
    ).toBe(true);
    expect(f.requests).toHaveLength(initial);
    await send(
      f,
      groups[2].groupId,
      groups[2].people[0].id,
      'New work has a new capacity admission, not the cancelled one.',
    );
    const currentThird = (await f.snapshot(groups[2].groupId)).discussion!.run!;
    expect(currentThird.id).not.toBe(originalWaitingRun);
    await waitFor(() =>
      rows(db!, currentThird.id).some((r) => r.state === 'waiting'),
    );
    await f.json(
      await f.call(
        `/api/bot-groups/${groups[2].groupId}/discussions/${originalWaitingRun}/stop`,
        'POST',
        {},
      ),
    );
    expect((await f.snapshot(groups[2].groupId)).discussion!.run!.status).toBe(
      'running',
    );
    expect(f.requests).toHaveLength(initial);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE state='active'",
        )
        .get(),
    ).toEqual({ n: 4 });
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === groups[0].people[1].id,
        { text: 'OWNER_SLOT_RELEASED' },
      ),
    ).toBe(1);
    // Dispatch is persisted before the HTTP request reaches the provider. Wait
    // for both observations without treating the ledger as transport evidence.
    await waitFor(
      () =>
        rows(db!, currentThird.id).some(
          (r) => r.state === 'active' && r.request_id,
        ) && f.requests.length >= initial + 1,
    );
    expect(f.requests).toHaveLength(initial + 1);
    expect(current(f.requests.at(-1)!).recipient_profile_id).toBe(
      groups[2].people[0].id,
    );
    await stop(f, groups[0].groupId);
    expect((await f.snapshot(groups[1].groupId)).discussion!.run!.status).toBe(
      'running',
    );
    expect((await f.snapshot(groups[2].groupId)).discussion!.run!.status).toBe(
      'running',
    );
    for (const g of groups.slice(1)) await stop(f, g.groupId);
    await waitFor(() => f.held.size === 0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE state IN ('waiting','active')",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(f.requests).toHaveLength(initial + 1);
    record('owner-capacity-and-scoped-stop', f, db, currentThird.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);

test('an approval-waiting native Task stays unfinished while both other members use the freed model slots', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await fresh(f);
    await grantMemberTools(f, groupId, people[0].id, [
      'create_approved_artifact',
    ]);
    db = openStorage(f);
    let a = 0;
    f.setModel((body) => {
      const input = current(body);
      if (input.recipient_profile_id === people[0].id) {
        if (++a === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'Review and ask the Researcher if needed.',
              },
            },
          };
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: 'PREVIEW_REQUIRES_HUMAN_CONSENT' },
          },
        };
      }
      return { hold: true };
    });
    await send(
      f,
      groupId,
      people[0].id,
      'Propose the exact preview, ask a peer, and wait for my approval.',
    );
    let s = await f.snapshot(groupId);
    await waitFor(async () => {
      s = await f.snapshot(groupId);
      return (
        !!s.discussion?.awaiting?.some(
          (item) =>
            item.profile_id === people[0].id && item.reason === 'approval',
        ) && f.held.size === 1
      );
    });
    const run = s.discussion!.run!;
    expect(
      rows(db, run.id).filter(
        (r) =>
          r.session_id === s.discussion!.awaiting![0].session_id &&
          r.state === 'active',
      ),
    ).toHaveLength(0);
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[1].id,
        {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[2].id,
              message:
                'Check the current preview without accessing private history.',
            },
          },
        },
      ),
    ).toBe(1);
    await waitFor(() => f.held.size === 2);
    s = await f.snapshot(groupId);
    expect(s.discussion!.run!.status).toBe('running');
    expect(
      s.discussion!.awaiting!.some(
        (item) =>
          item.profile_id === people[0].id && item.reason === 'approval',
      ),
    ).toBe(true);
    expect(rows(db, run.id).filter((r) => r.state === 'active')).toHaveLength(
      2,
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_inputs WHERE run_id=? AND profile_id=? AND state='submitted'",
        )
        .get(run.id, people[0].id),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM product_approvals WHERE state='pending'",
        )
        .get(),
    ).toEqual({ n: 1 });
    record('approval-wait-releases-model-capacity', f, db, run.id);
    await stop(f, groupId);
    await waitFor(() => f.held.size === 0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM product_approvals WHERE state='pending'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);

test.each([false, true])(
  'usage credit overrun=%s is persisted from the actual terminal response and never makes an unknown call free',
  async (overrun) => {
    const f = await botHandoffHttpFixture(undefined, flags);
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await fresh(f);
      db = openStorage(f);
      f.setModel(() => ({
        text: 'TERMINAL_WITH_REPORTED_USAGE',
        usage: overrun
          ? { input: 200000, output: 37 }
          : { input: 31, output: 7 },
      }));
      await send(
        f,
        groupId,
        people[0].id,
        'Answer once within the current public context.',
      );
      let s = await f.snapshot(groupId);
      await waitFor(async () => {
        s = await f.snapshot(groupId);
        return s.discussion?.run?.status !== 'running';
      });
      expect(s.discussion!.run!.status).toBe(
        overrun ? 'waiting_user' : 'completed',
      );
      const result = rows(db, s.discussion!.run!.id);
      expect(result).toHaveLength(1);
      expect(f.requests).toHaveLength(1);
      expect(result[0]).toMatchObject({
        state: 'released',
        terminal_kind: 'done',
        reported_tokens: overrun ? 200037 : 38,
        accounted_tokens: overrun ? 200037 : 38,
      });
      if (overrun) {
        expect(s.discussion!.run!.error_code).toBe(
          'GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED',
        );
        expect(
          s.messages.some((m) => m.content === 'TERMINAL_WITH_REPORTED_USAGE'),
        ).toBe(false);
      }
      record(
        overrun
          ? 'reported-token-overrun-fenced'
          : 'reported-usage-credits-reservation',
        f,
        db,
        s.discussion!.run!.id,
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  },
  180_000,
);

test('conservative Run token allowance stops actual retries without resetting the original work association', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await fresh(f);
    db = openStorage(f);
    await grantMemberTools(f, groupId, people[0].id, [], 12);
    await grantMemberTools(f, groupId, people[1].id, [], 12);
    let a = 0;
    f.setModel((body) => {
      if (current(body).recipient_profile_id === people[1].id)
        return { hold: true };
      if (++a === 1)
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1].id,
              message:
                'Hold the peer check while I inspect the current public context.',
            },
          },
        };
      if (a < 12)
        return { tool: { name: 'read_group_context', arguments: {} } };
      return { text: 'PROVISIONAL_WITHOUT_THE_PEER_MUST_NOT_PUBLISH' };
    });
    await send(
      f,
      groupId,
      people[0].id,
      'Inspect within the bounded allowance and wait for the actual peer result.',
    );
    let s = await f.snapshot(groupId);
    await waitFor(async () => {
      s = await f.snapshot(groupId);
      return a === 12 && f.held.size === 1;
    });
    const runId = s.discussion!.run!.id;
    expect(f.requests).toHaveLength(13);
    f.setModel(() => ({ tool: { name: 'read_group_context', arguments: {} } }));
    f.release({ tool: { name: 'read_group_context', arguments: {} } });
    await waitFor(async () => {
      s = await f.snapshot(groupId);
      return s.discussion?.run?.status !== 'running';
    });
    expect(s.discussion!.run!.id).toBe(runId);
    expect(s.discussion!.run!.status).toBe('waiting_user');
    expect(s.discussion!.run!.error_code).toBe(
      'GROUP_MEMBER_TOKEN_BUDGET_EXHAUSTED',
    );
    expect(f.requests).toHaveLength(15);
    expect(s.discussion!.run!.model_attempts).toBe(15);
    expect(
      s.messages.some(
        (m) => m.content === 'PROVISIONAL_WITHOUT_THE_PEER_MUST_NOT_PUBLISH',
      ),
    ).toBe(false);
    await waitFor(() =>
      rows(db!, runId).every((r) => !['waiting', 'active'].includes(r.state)),
    );
    const actual = rows(db, runId).filter((r) => r.request_id);
    expect(actual).toHaveLength(15);
    expect(
      actual.every(
        (r) =>
          r.reported_tokens === null &&
          r.accounted_tokens === r.reserved_tokens,
      ),
    ).toBe(true);
    expect(
      rows(db, runId).some((r) => !r.request_id && r.accounted_tokens === 0),
    ).toBe(true);
    record('run-token-budget-does-not-reset', f, db, runId);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);

test('restart preserves the original native inputs, fences old model capacity as uncertain, and gray-off still completes admitted work', async () => {
  const environment = { ...flags };
  const f = await botHandoffHttpFixture(undefined, environment);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await fresh(f);
    await grantMemberTools(f, groupId, people[0].id, [], 8);
    db = openStorage(f);
    const answerB = `RECOVERED_B_${randomUUID()}`,
      answerC = `RECOVERED_C_${randomUUID()}`;
    let a = 0,
      after = false,
      resumedA = 0,
      failure: unknown;
    f.setModel((body) => {
      try {
        const input = current(body);
        if (after) {
          if (input.recipient_profile_id === people[1].id)
            return { text: answerB };
          if (input.recipient_profile_id === people[2].id)
            return { text: answerC };
          if (++resumedA === 1) return { hold: true };
          const replies = memberEnvelopes(body)
            .filter((e) => e.input_kind === 'reply')
            .map((e) => e.trigger.content);
          expect(replies).toEqual(expect.arrayContaining([answerB, answerC]));
          return { text: 'SAME_NATIVE_WORK_RECOVERED' };
        }
        if (input.recipient_profile_id !== people[0].id) return { hold: true };
        if (++a < 3)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[a].id,
                message:
                  'Review this same public work before and after recovery.',
              },
            },
          };
        return { hold: true };
      } catch (error) {
        failure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    const check = () => {
      if (failure) throw failure;
    };
    await send(
      f,
      groupId,
      people[0].id,
      'Ask both peers; preserve the original work if this server restarts.',
    );
    let s = await f.snapshot(groupId);
    await waitFor(async () => {
      check();
      s = await f.snapshot(groupId);
      return (
        f.held.size === 2 &&
        rows(db!, s.discussion!.run!.id).some((r) => r.state === 'waiting')
      );
    });
    const runId = s.discussion!.run!.id;
    const before = db
      .prepare(
        'SELECT i.id,i.request_id,i.input_id,p.submission_id FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id WHERE i.run_id=? ORDER BY i.id',
      )
      .all(runId) as any[];
    expect(before).toHaveLength(3);
    expect(before.every((r) => r.submission_id !== null)).toBe(true);
    expect(f.requests).toHaveLength(4);
    const old = rows(db, runId)
      .filter((r) => r.state === 'active')
      .map((r) => r.id);
    expect(old).toHaveLength(2);
    await f.stop('SIGKILL');
    await waitFor(() => f.held.size === 0);
    environment.MINICLAW_GROUP_MEMBER_CONCURRENCY = 'false';
    environment.MINICLAW_GROUP_MEMBER_INBOX = 'false';
    after = true;
    await f.start();
    await waitFor(async () => {
      check();
      s = await f.snapshot(groupId);
      return (
        f.held.size === 1 &&
        s.messages.some((m) => m.content === answerB) &&
        s.messages.some((m) => m.content === answerC)
      );
    });
    const restored = db
      .prepare(
        'SELECT i.id,i.request_id,i.input_id,p.submission_id FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id WHERE i.run_id=? ORDER BY i.id',
      )
      .all(runId) as any[];
    for (const original of before)
      expect(restored.find((r) => r.id === original.id)).toEqual(original);
    for (const id of old) {
      const r = rows(db, runId).find((r) => r.id === id);
      expect(r).toMatchObject({ state: 'uncertain', reported_tokens: null });
      expect(r.accounted_tokens).toBe(r.reserved_tokens);
    }
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[0].id,
        { tool: { name: 'read_group_context', arguments: {} } },
      ),
    ).toBe(1);
    await waitFor(async () => {
      check();
      s = await f.snapshot(groupId);
      return s.discussion?.run?.status !== 'running';
    });
    expect(s.discussion!.run!.status).toBe('completed');
    expect(s.discussion!.run!.id).toBe(runId);
    expect(f.requests).toHaveLength(8);
    expect(
      s.messages.filter((m) => m.content === 'SAME_NATIVE_WORK_RECOVERED'),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        )
        .get(runId),
    ).toEqual({ n: 2 });
    const count = f.requests.length,
      revision = s.revision;
    const newAdmission = await f.call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      {
        content: 'New opt-in work must not start after gray-off.',
        dispatch: true,
      },
    );
    expect(newAdmission.ok).toBe(false);
    expect(f.requests).toHaveLength(count);
    expect((await f.snapshot(groupId)).revision).toBe(revision);
    record('bounded-native-restart-and-gray-off', f, db, runId);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);

test.each(['artifact', 'question'] as const)(
  'explicitly named members wake independently and queued corrections fence stale tools and finals until native consumption (%s)',
  async (staleTool) => {
    const f = await botHandoffHttpFixture(undefined, flags);
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await fresh(f);
      db = openStorage(f);
      if (staleTool === 'artifact')
        for (const p of people)
          await grantMemberTools(f, groupId, p.id, [
            'create_approved_artifact',
          ]);
      const counts = new Map<string, number>();
      let failure: unknown;
      f.setModel((body) => {
        try {
          const input = current(body),
            n = (counts.get(input.recipient_profile_id) ?? 0) + 1;
          counts.set(input.recipient_profile_id, n);
          if (n === 1) return { hold: true };
          expect(
            memberEnvelopes(body).some(
              (e) =>
                e.input_kind === 'control' &&
                e.trigger.content === '只处理预览环境；取消原来的部署要求。',
            ),
          ).toBe(true);
          return { text: `PREVIEW_FINAL_${input.recipient_profile_id}` };
        } catch (error) {
          failure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Each named member should answer this request; prepare a deployment proposal.',
          mentions: people.map((p) => p.id),
          dispatch: true,
        }),
      );
      await waitFor(() => f.held.size >= 1);
      let s = await f.snapshot(groupId);
      const runId = s.discussion!.run!.id;
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM bot_group_member_inputs WHERE run_id=? AND kind='root'",
          )
          .get(runId),
      ).toEqual({ n: 3 });
      await waitFor(
        () =>
          f.held.size === 2 &&
          rows(db!, runId).some((r) => r.state === 'waiting'),
      );
      const frozen = db
        .prepare(
          "SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? AND kind='root' ORDER BY id",
        )
        .all(runId);
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: '只处理预览环境；取消原来的部署要求。',
          dispatch: true,
        }),
      );
      const stale = (index: number): Exclude<ModelPlan, { hold: true }> =>
        index === 1
          ? { text: 'STALE_DEPLOYMENT_FINAL_MUST_NOT_PUBLISH' }
          : staleTool === 'artifact'
            ? {
                tool: {
                  name: 'create_approved_artifact',
                  arguments: {
                    content: 'STALE_DEPLOYMENT_ARTIFACT_MUST_NOT_BE_PROPOSED',
                  },
                },
              }
            : {
                tool: {
                  name: 'ask_group_dot',
                  arguments: {
                    recipient_profile_id: people[(index + 1) % 3].id,
                    message: 'STALE_DEPLOYMENT_QUESTION_MUST_NOT_BE_SENT',
                  },
                },
              };
      for (const [index, p] of people.entries())
        f.releaseMatching(
          (body) => current(body).recipient_profile_id === p.id,
          stale(index),
        );
      await waitFor(() => {
        if (failure) throw failure;
        return people.every((p) => counts.has(p.id));
      });
      for (const [index, p] of people.entries())
        f.releaseMatching(
          (body) => current(body).recipient_profile_id === p.id,
          stale(index),
        );
      await waitFor(async () => {
        if (failure) throw failure;
        s = await f.snapshot(groupId);
        return (
          s.discussion?.run?.status !== 'running' ||
          (db!.prepare('SELECT COUNT(*) n FROM product_approvals').get() as any)
            .n > 0 ||
          s.messages.some(
            (m) => m.content === 'STALE_DEPLOYMENT_FINAL_MUST_NOT_PUBLISH',
          )
        );
      });
      expect(
        db.prepare('SELECT COUNT(*) n FROM product_approvals').get(),
      ).toEqual({ n: 0 });
      expect(
        s.messages.some(
          (m) => m.content === 'STALE_DEPLOYMENT_FINAL_MUST_NOT_PUBLISH',
        ),
      ).toBe(false);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId),
      ).toEqual({ n: 0 });
      expect(s.discussion!.run!.status).toBe('completed');
      expect(f.requests).toHaveLength(6);
      for (const p of people)
        expect(
          s.messages.filter((m) => m.content === `PREVIEW_FINAL_${p.id}`),
        ).toHaveLength(1);
      expect(
        db
          .prepare(
            "SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? AND kind='root' ORDER BY id",
          )
          .all(runId),
      ).toEqual(frozen);
      record(
        `explicit-members-consume-correction-before-${staleTool}`,
        f,
        db,
        runId,
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  },
  180_000,
);

test('a user can address idle members in the current Run without waking unnamed members', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await fresh(f);
    db = openStorage(f);
    let failure: unknown;
    const counts = new Map<string, number>();
    f.setModel((body) => {
      try {
        const e = current(body),
          n = (counts.get(e.recipient_profile_id) ?? 0) + 1;
        counts.set(e.recipient_profile_id, n);
        if (e.recipient_profile_id === people[0].id && n === 1)
          return { hold: true };
        expect(e.trigger.content).toBe(
          '请审阅搭子单独加入，其他人继续原工作。',
        );
        if (e.recipient_profile_id === people[1].id)
          expect(e.input_kind).toBe('root');
        else expect(e.input_kind).toBe('control');
        return { text: `DIRECTED_FINAL_${e.recipient_profile_id}` };
      } catch (error) {
        failure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await send(f, groupId, people[0].id, '开发搭子先检查，其余成员暂不调用。');
    await waitFor(() => f.held.size === 1);
    const runId = (await f.snapshot(groupId)).discussion!.run!.id;
    expect(f.requests).toHaveLength(1);
    await send(
      f,
      groupId,
      people[1].id,
      '请审阅搭子单独加入，其他人继续原工作。',
    );
    await waitFor(async () => {
      if (failure) throw failure;
      return (await f.snapshot(groupId)).messages.some(
        (m) => m.content === `DIRECTED_FINAL_${people[1].id}`,
      );
    });
    expect(counts.has(people[2].id)).toBe(false);
    expect(f.requests).toHaveLength(2);
    expect(
      f.releaseMatching(
        (body) => current(body).recipient_profile_id === people[0].id,
        { tool: { name: 'read_group_context', arguments: {} } },
      ),
    ).toBe(1);
    let s = await f.snapshot(groupId);
    await waitFor(async () => {
      if (failure) throw failure;
      s = await f.snapshot(groupId);
      return s.discussion!.run!.status !== 'running';
    });
    expect(s.discussion!.run!).toMatchObject({
      id: runId,
      status: 'completed',
    });
    expect(f.requests).toHaveLength(3);
    for (const p of people.slice(0, 2))
      expect(
        s.messages.filter((m) => m.content === `DIRECTED_FINAL_${p.id}`),
      ).toHaveLength(1);
    expect(counts.has(people[2].id)).toBe(false);
    record('explicit-idle-member-without-broadcast', f, db, runId);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180_000);
