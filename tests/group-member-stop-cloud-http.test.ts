// Actual product/Node/workerd member Sessions. Model inference is synthetic.
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  memberEnvelopes,
} from './helpers/member-inbox-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';

function recordStopProof(
  name: string,
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
  db: Database.Database,
  runId: string,
) {
  recordCloudMemberProof(name, f, db, runId, {
    member_stop_source_sha256: Object.fromEntries(
      [
        'src/bot-groups/member-stop-store.ts',
        'src/bot-groups/discussion-store.ts',
        'src/bot-groups/discussion-types.ts',
        'src/bot-groups/discussion-service.ts',
        'src/bot-groups/member-inbox-store.ts',
        'src/personal-agent/product-runtime.ts',
        'src/personal-agent/cloud-lifecycle.ts',
        'src/routes/bot-groups.ts',
        'tests/group-member-stop-cloud-http.test.ts',
        'tests/group-member-stop-http.test.ts',
        'tests/helpers/bot-handoff-http-fixture.ts',
        'tests/helpers/cloud-bot-handoff-http-fixture.ts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(new URL('../' + file, import.meta.url)))
          .digest('hex'),
      ]),
    ),
    member_stops: db
      .prepare(
        'SELECT * FROM bot_group_member_stops ORDER BY created_at,lease_id',
      )
      .all(),
    native_stop_requests: f.nativeStopCount(),
    native_stop_acknowledgements_lost: f.stopAcknowledgementLosses(),
  });
}

const placements = [
  ['node-durable', 'node-durable'],
  ['node-durable', 'cloudflare-durable'],
  ['cloudflare-durable', 'node-durable'],
  ['cloudflare-durable', 'cloudflare-durable'],
] as const;
for (const kinds of placements)
  test(`${kinds.join(' → ')}: individual Stop cancels one peer dependency, preserves the requester and cannot cancel the next Run`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await freshMemberGroup(f, false);
      for (const [i, runtime] of kinds.entries()) {
        if (runtime === 'node-durable') continue;
        const s = await f.snapshot(groupId),
          member = s.members.find(
            (m) => m.kind === 'bot' && m.subject_id === people[i].id,
          )!;
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
            'POST',
            {
              runtime_kind: runtime,
              tool_capabilities: [],
              max_model_attempts: 6,
              expected_revision: s.revision,
              expected_member_revision: member.revision,
            },
          ),
        );
      }
      const settings = await f.snapshot(groupId);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            execution_contract: 'member-inbox-v1',
            policy: 'relay-v1',
            coordinator_profile_id: people[0].id,
            participant_profile_ids: people.map((p) => p.id),
            max_turns_per_dot: 3,
            max_model_attempts: 12,
            expected_revision: settings.revision,
          },
        ),
      );
      let asks = 0,
        failure: unknown;
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          if (current.recipient_profile_id === people[1].id)
            return { hold: true };
          const control = envelopes.find((e) => e.input_kind === 'control');
          if (control) {
            expect(control.member_stop.profile_id).toBe(people[1].id);
            expect(control.member_stop.cancelled_mail_ids).toHaveLength(1);
            expect(envelopes.some((e) => e.input_kind === 'reply')).toBe(false);
            return {
              text: 'FINISHED_AFTER_EXACT_PEER_CANCELLATION',
              usage: { input: 31, output: 7 },
            };
          }
          if (++asks === 1)
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: 'Check this public preview independently.',
                },
              },
              usage: { input: 31, output: 7 },
            };
          return { hold: true };
        } catch (error) {
          failure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, request a review and keep working until its real result.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => f.held.size === 2, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const old = (await f.snapshot(groupId)).discussion!.run!;
      const leases = db
        .prepare(
          'SELECT * FROM bot_group_member_leases WHERE run_id=? ORDER BY profile_id',
        )
        .all(old.id) as any[];
      const target = leases.find((l) => l.profile_id === people[1].id)!;
      const url = `/api/bot-groups/${groupId}/discussions/${old.id}/members/${people[1].id}/stop`;
      await f.json(await f.call(url, 'POST', { lease_id: target.id }));
      await waitFor(
        () =>
          f.held.size === 1 &&
          (
            db!
              .prepare('SELECT state FROM bot_group_member_leases WHERE id=?')
              .get(target.id) as any
          ).state === 'done',
        60000,
      );
      expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
        'running',
      );
      expect((await f.snapshot(groupId)).discussion!.run!.cancel_epoch).toBe(
        old.cancel_epoch,
      );
      await waitFor(
        () =>
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_inputs WHERE run_id=? AND kind='control' AND state='submitted'",
              )
              .get(old.id) as any
          ).n === 1,
        60000,
      );
      f.release({
        text: 'STALE_PEER_WAIT_FINAL_MUST_NOT_PUBLISH',
        usage: { input: 31, output: 7 },
      });
      await waitFor(async () => {
        if (failure) throw failure;
        const r = (await f.snapshot(groupId)).discussion?.run;
        if (r?.status === 'failed')
          throw new Error(r.error_code ?? 'Member failed');
        return r?.status === 'completed';
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(
        done.messages.filter(
          (m) => m.content === 'FINISHED_AFTER_EXACT_PEER_CANCELLATION',
        ),
      ).toHaveLength(1);
      expect(
        done.messages.some(
          (m) => m.content === 'STALE_PEER_WAIT_FINAL_MUST_NOT_PUBLISH',
        ),
      ).toBe(false);
      expect(
        db
          .prepare(
            'SELECT kind,state FROM bot_group_member_mail WHERE run_id=?',
          )
          .all(old.id),
      ).toEqual([{ kind: 'question', state: 'cancelled' }]);
      expect(f.requests).toHaveLength(4);
      f.setModel(() => ({ hold: true }));
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Both members should independently inspect this new preview.',
          mentions: people.map((p) => p.id),
          dispatch: true,
        }),
      );
      await waitFor(() => f.held.size === 2, 60000);
      const fresh = (await f.snapshot(groupId)).discussion!.run!;
      expect(fresh.id).not.toBe(old.id);
      const next = db
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_member_leases WHERE run_id=? ORDER BY profile_id',
        )
        .all(fresh.id);
      expect(next).toEqual(
        leases.map((l) => ({
          profile_id: l.profile_id,
          session_id: l.session_id,
        })),
      );
      await f.json(await f.call(url, 'POST', { lease_id: target.id }));
      expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
        'running',
      );
      expect(f.held.size).toBe(2);
      if (kinds[1] === 'cloudflare-durable')
        expect((await f.replayStop(0)).status).toBe(409);
      f.release({
        text: 'FRESH_RUN_AFTER_SINGLE_MEMBER_STOP',
        usage: { input: 31, output: 7 },
      });
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
        60000,
      );
      expect(
        (await f.snapshot(groupId)).messages.filter(
          (m) => m.content === 'FRESH_RUN_AFTER_SINGLE_MEMBER_STOP',
        ),
      ).toHaveLength(2);
      expect(f.requests).toHaveLength(6);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      recordStopProof('stop-reviewer-' + kinds.join('-'), f, db, old.id);
      recordStopProof(
        'stop-reviewer-reuse-' + kinds.join('-'),
        f,
        db,
        fresh.id,
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 240000);

for (const kinds of placements)
  test(`${kinds.join(' → ')}: stopping the question sender preserves the recipient and suppresses its cancelled answer`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await freshMemberGroup(f, false);
      for (const [i, runtime] of kinds.entries()) {
        if (runtime === 'node-durable') continue;
        const s = await f.snapshot(groupId),
          member = s.members.find(
            (m) => m.kind === 'bot' && m.subject_id === people[i].id,
          )!;
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
            'POST',
            {
              runtime_kind: runtime,
              tool_capabilities: [],
              max_model_attempts: 6,
              expected_revision: s.revision,
              expected_member_revision: member.revision,
            },
          ),
        );
      }
      const s = await f.snapshot(groupId);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            execution_contract: 'member-inbox-v1',
            policy: 'relay-v1',
            coordinator_profile_id: people[0].id,
            participant_profile_ids: people.map((p) => p.id),
            max_turns_per_dot: 3,
            max_model_attempts: 12,
            expected_revision: s.revision,
          },
        ),
      );
      let asks = 0,
        failure: unknown;
      f.setModel((body) => {
        try {
          const es = memberEnvelopes(body),
            current = es.at(-1)!;
          const notice = es.find((e) => e.input_kind === 'control');
          if (notice) {
            expect(current.recipient_profile_id).toBe(people[1].id);
            expect(notice.member_stop.profile_id).toBe(people[0].id);
            expect(notice.member_stop.cancelled_mail_ids).toHaveLength(1);
            return {
              text: 'RECIPIENT_CONTINUES_WITHOUT_STOPPED_SENDER',
              usage: { input: 31, output: 7 },
            };
          }
          if (current.recipient_profile_id === people[0].id && ++asks === 1)
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: 'Inspect the preview while I work.',
                },
              },
              usage: { input: 31, output: 7 },
            };
          return { hold: true };
        } catch (error) {
          failure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'Ask the reviewer while keeping the preview in progress.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => f.held.size === 2, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const run = (await f.snapshot(groupId)).discussion!.run!;
      const target = db
        .prepare(
          'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
        )
        .get(run.id, people[0].id) as any;
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[0].id}/stop`,
          'POST',
          { lease_id: target.id },
        ),
      );
      await waitFor(
        () =>
          f.held.size === 1 &&
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_inputs WHERE kind='control' AND state='submitted'",
              )
              .get() as any
          ).n === 1,
        60000,
      );
      expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
        'running',
      );
      expect((await f.snapshot(groupId)).discussion!.run!.cancel_epoch).toBe(
        run.cancel_epoch,
      );
      f.release({
        text: 'CANCELLED_REQUEST_ANSWER_MUST_NOT_APPEAR',
        usage: { input: 31, output: 7 },
      });
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
        60000,
      );
      if (failure) throw failure;
      const done = await f.snapshot(groupId);
      expect(
        done.messages.filter(
          (m) => m.content === 'RECIPIENT_CONTINUES_WITHOUT_STOPPED_SENDER',
        ),
      ).toHaveLength(1);
      expect(
        done.messages.some(
          (m) => m.content === 'CANCELLED_REQUEST_ANSWER_MUST_NOT_APPEAR',
        ),
      ).toBe(false);
      expect(
        db
          .prepare(
            'SELECT kind,state FROM bot_group_member_mail WHERE run_id=?',
          )
          .all(run.id),
      ).toEqual([{ kind: 'question', state: 'cancelled' }]);
      const received = db
        .prepare(
          "SELECT i.id,i.state,p.state native_state FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id WHERE i.kind='question'",
        )
        .get() as any;
      expect(received).toMatchObject({
        state: 'completed',
        native_state: 'completed',
      });
      expect(
        db
          .prepare(
            'SELECT input_id FROM product_input_task_sources WHERE input_id IN (SELECT input_id FROM bot_group_member_inputs WHERE id=?)',
          )
          .get(received.id),
      ).toBeDefined();
      expect(f.requests).toHaveLength(4);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      recordStopProof('stop-sender-' + kinds.join('-'), f, db, run.id);
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);

test('an idle never-provisioned Cloud member stops without inventing native work or falling back to Node', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f, false);
    const initial = await f.snapshot(groupId),
      targetMember = initial.members.find(
        (m) => m.kind === 'bot' && m.subject_id === people[1].id,
      )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${targetMember.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: 'cloudflare-durable',
          tool_capabilities: [],
          max_model_attempts: 6,
          expected_revision: initial.revision,
          expected_member_revision: targetMember.revision,
        },
      ),
    );
    const s = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        max_turns_per_dot: 3,
        max_model_attempts: 12,
        expected_revision: s.revision,
      }),
    );
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Developer alone should inspect the preview.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 1, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const lease = db
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[1].id) as any;
    expect(
      db
        .prepare(
          'SELECT object_id FROM product_cloud_sessions WHERE session_id=?',
        )
        .get(lease.session_id),
    ).toEqual({ object_id: null });
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(lease.session_id),
    ).toEqual({ n: 0 });
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[1].id}/stop`,
        'POST',
        { lease_id: lease.id },
      ),
    );
    expect(
      (await f.snapshot(groupId)).discussion!.member_tasks?.find(
        (m) => m.profile_id === people[1].id,
      ),
    ).toMatchObject({ state: 'stopped', can_stop: false });
    expect((await f.snapshot(groupId)).discussion!.run!.status).toBe('running');
    expect(f.held.size).toBe(1);
    expect(f.nativeStopCount()).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT object_id FROM product_cloud_sessions WHERE session_id=?',
        )
        .get(lease.session_id),
    ).toEqual({ object_id: null });
    expect(
      db
        .prepare(
          'SELECT conversation_id FROM product_session_runtimes WHERE session_id=?',
        )
        .get(lease.session_id),
    ).toEqual({ conversation_id: null });
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(lease.session_id),
    ).toEqual({ n: 0 });
    f.release({
      text: 'ONLY_REQUESTED_MEMBER_FINISHED',
      usage: { input: 31, output: 7 },
    });
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    recordStopProof('stop-idle-cloud', f, db, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

test('a committed native Cloud member Stop with lost acknowledgements remains uncertain across Node/Worker restart, then confirms by the same fenced intent', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f, false);
    const s = await f.snapshot(groupId),
      member = s.members.find(
        (m) => m.kind === 'bot' && m.subject_id === people[1].id,
      )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: 'cloudflare-durable',
          tool_capabilities: [],
          max_model_attempts: 6,
          expected_revision: s.revision,
          expected_member_revision: member.revision,
        },
      ),
    );
    const settings = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        max_turns_per_dot: 3,
        max_model_attempts: 12,
        expected_revision: settings.revision,
      }),
    );
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Reviewer alone should inspect the preview.',
        mentions: [people[1].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 1, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const lease = db
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[1].id) as any;
    const originalInputs = db
      .prepare(
        'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=?',
      )
      .all(run.id);
    const url = `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[1].id}/stop`;
    f.maskStopAcknowledgements(true);
    await f.json(await f.call(url, 'POST', { lease_id: lease.id }));
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.member_tasks?.some(
          (m) => m.profile_id === people[1].id && m.state === 'uncertain',
        ) === true,
      60000,
    );
    expect(f.stopAcknowledgementLosses()).toBeGreaterThan(0);
    await waitFor(() => f.held.size === 0, 60000);
    expect((await f.snapshot(groupId)).discussion!.run!.status).toBe('running');
    expect(
      (await f.snapshot(groupId)).discussion!.member_tasks?.find(
        (m) => m.profile_id === people[1].id,
      ),
    ).toMatchObject({ state: 'uncertain', can_stop: true });
    expect(
      (
        db
          .prepare('SELECT state FROM bot_group_member_leases WHERE id=?')
          .get(lease.id) as any
      ).state,
    ).toBe('stopping');
    await f.restartNode();
    await f.restartWorker();
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.member_tasks?.some(
          (m) => m.profile_id === people[1].id && m.state === 'uncertain',
        ) === true,
      60000,
    );
    expect(f.requests).toHaveLength(1);
    expect(
      db.prepare('SELECT count(*) n FROM bot_group_member_stops').get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=?',
        )
        .all(run.id),
    ).toEqual(originalInputs);
    f.maskStopAcknowledgements(false);
    await f.json(await f.call(url, 'POST', { lease_id: lease.id }));
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    const done = await f.snapshot(groupId);
    expect(
      done.discussion!.member_tasks?.find((m) => m.profile_id === people[1].id),
    ).toMatchObject({ state: 'stopped', can_stop: false });
    expect(done.messages.filter((m) => m.author_kind === 'bot')).toHaveLength(
      0,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.releaseMatching(() => true, { text: 'LATE_STOPPED_RESULT' })).toBe(
      0,
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    recordStopProof('stop-cloud-lost-ack-restart', f, db, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);
