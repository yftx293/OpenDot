// Real product admission and native Node/workerd execution; controlled inference.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { waitForMemberQuestionSubmission } from './helpers/member-inbox-http-fixture.js';
import { waitFor, type ModelBody } from './helpers/bot-handoff-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
  type MemberPlacement,
} from './helpers/member-lifecycle-http-fixture.js';

const usage = { input: 31, output: 7 };
type Fixture = Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>;
async function grantPlacements(
  f: Fixture,
  groupId: string,
  people: { id: string }[],
  kinds: readonly MemberPlacement[],
  limit = 6,
) {
  for (const [index, runtime] of kinds.entries()) {
    const before = await f.snapshot(groupId);
    const member = before.members.find(
      (m) => m.kind === 'bot' && m.subject_id === people[index].id,
    )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: runtime,
          tool_capabilities: [],
          max_model_attempts: limit,
          expected_revision: before.revision,
          expected_member_revision: member.revision,
        },
      ),
    );
  }
}
async function enable(f: Fixture, groupId: string, people: { id: string }[]) {
  const before = await f.snapshot(groupId);
  await f.json(
    await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
      enabled: true,
      execution_contract: 'member-inbox-v1',
      policy: 'relay-v1',
      coordinator_profile_id: people[0].id,
      participant_profile_ids: people.map((p) => p.id),
      max_turns_per_dot: 3,
      max_model_attempts: 12,
      expected_revision: before.revision,
    }),
  );
}
function record(
  name: string,
  f: Fixture,
  db: Database.Database,
  runId: string,
  extra: Record<string, unknown> = {},
) {
  recordCloudMemberProof(name, f, db, runId, {
    boundary_test_sha256: createHash('sha256')
      .update(fs.readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    canonical_messages: db
      .prepare(
        `SELECT id,seq,author_kind,author_id,content,source FROM bot_group_messages WHERE group_id=(SELECT group_id FROM bot_group_discussions WHERE id=?) ORDER BY seq`,
      )
      .all(runId),
    ...extra,
  });
}

for (const kinds of memberPlacementPairs) {
  test(`${kinds.join(' → ')}: the same Dots in another Group retain their native canary and stay asleep during this Group's peer exchange`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      const created = await f.json<any>(
        await f.call('/api/bot-groups', 'POST', {
          name: 'Separate Group with the same Dots',
          bot_profile_ids: people.map((p) => p.id),
        }),
      );
      const foreignId = created.snapshot.group.id as string;
      await grantPlacements(f, foreignId, people, kinds);
      await enable(f, foreignId, people);
      const canary = `OTHER_GROUP_NATIVE_${randomUUID()}`;
      f.setModel((body) => {
        try {
          expect(memberEnvelopes(body).at(-1)?.group_id).toBe(foreignId);
        } catch (error) {
          failure = error;
        }
        return { text: canary, usage };
      });
      await f.json(
        await f.call(`/api/bot-groups/${foreignId}/messages`, 'POST', {
          content: `Keep this fact only in this separate Group: ${canary}`,
          mentions: [people[1].id],
          dispatch: true,
        }),
      );
      await waitFor(async () => {
        if (failure) throw failure;
        return (
          (await f.snapshot(foreignId)).discussion?.run?.status === 'completed'
        );
      }, 60000);
      expect(f.requests).toHaveLength(1);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const foreign = await f.snapshot(foreignId),
        foreignRun = foreign.discussion!.run!;
      const foreignInputs = db
        .prepare(
          'SELECT * FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(foreignRun.id);
      const foreignSessions = db
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        )
        .all(foreignId) as { profile_id: string; session_id: string }[];
      const question = `PUBLIC_REVIEW_${randomUUID()}: what is 91 minus 36?`;
      const answer = `REVIEWED_${question}_55`,
        final = `USED_ACTUAL_REVIEW_${question}_55`;
      let asked = false;
      f.setModel((body) => {
        try {
          expect(JSON.stringify(body.messages)).not.toContain(canary);
          const es = memberEnvelopes(body),
            current = es.at(-1)!;
          expect(current.group_id).toBe(groupId);
          expect(es.every((e) => e.group_id === groupId)).toBe(true);
          expect(body.tools?.map((t) => t.function.name)).toEqual([
            'ask_group_dot',
            'read_group_context',
          ]);
          if (current.recipient_profile_id === people[1].id) {
            expect(
              es.some(
                (e) =>
                  e.input_kind === 'question' && e.trigger.content === question,
              ),
            ).toBe(true);
            return { hold: true };
          }
          const reply = es.find((e) => e.input_kind === 'reply');
          if (reply) {
            expect(reply.trigger.content).toBe(answer);
            return { text: final, usage };
          }
          if (!asked) {
            asked = true;
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: question,
                },
              },
              usage,
            };
          }
          return { hold: true };
        } catch (error) {
          failure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, request a public preview review and use its actual reply.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return f.held.size === 2;
      }, 60000);
      runId = (await f.snapshot(groupId)).discussion!.run!.id;
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
          { text: answer, usage },
        ),
      ).toBe(1);
      await waitFor(() => {
        if (failure) throw failure;
        return (
          (
            db!
              .prepare(
                `SELECT count(*) n FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id WHERE i.run_id=? AND i.kind='reply' AND p.submission_id IS NOT NULL`,
              )
              .get(runId) as { n: number }
          ).n === 1
        );
      }, 60000);
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id,
          { tool: { name: 'read_group_context', arguments: {} }, usage },
        ),
      ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        return (
          (await f.snapshot(groupId)).discussion?.run?.status !== 'running'
        );
      }, 60000);
      const done = await f.snapshot(groupId),
        after = await f.snapshot(foreignId);
      expect(done.discussion!.run).toMatchObject({
        status: 'completed',
        error_code: null,
      });
      expect(done.messages.filter((m) => m.content === answer)).toHaveLength(1);
      expect(done.messages.filter((m) => m.content === final)).toHaveLength(1);
      expect(JSON.stringify(done)).not.toContain(canary);
      expect(after.messages).toEqual(foreign.messages);
      expect(after.discussion!.run).toEqual(foreignRun);
      const foreignAfterInputs = db
        .prepare(
          'SELECT * FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(foreignRun.id);
      expect(foreignAfterInputs).toEqual(foreignInputs);
      const sessions = db
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        )
        .all(groupId) as { profile_id: string; session_id: string }[];
      for (const item of sessions)
        expect(item.session_id).not.toBe(
          foreignSessions.find((s) => s.profile_id === item.profile_id)!
            .session_id,
        );
      const mail = db
        .prepare(
          "SELECT * FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        )
        .get(runId) as any;
      expect(mail.recipient_session_id).toBe(
        sessions.find((s) => s.profile_id === people[1].id)!.session_id,
      );
      expect(f.requests).toHaveLength(5);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      record('group-isolation-' + kinds.join('-'), f, db, runId, {
        foreign_run_id: foreignRun.id,
        foreign_sessions: foreignSessions,
        foreign_inputs_unchanged: true,
        foreign_scope: {
          group_id: foreignId,
          run_before: foreignRun,
          run_after: after.discussion!.run,
          inputs_before: foreignInputs,
          inputs_after: foreignAfterInputs,
          messages_before: foreign.messages,
          messages_after: after.messages,
        },
        model_scope_checks: f.requests.map((body, index) => ({
          index: index + 1,
          group_id: memberEnvelopes(body).at(-1)?.group_id,
          foreign_canary_present: JSON.stringify(body.messages).includes(
            canary,
          ),
        })),
      });
    } catch (error) {
      if (db && runId)
        record('failed-group-isolation-' + kinds.join('-'), f, db, runId);
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);
}

for (const kinds of memberPlacementPairs) {
  test(`${kinds.join(' → ')}: a native question cycle keeps its original four-hop deadline after a user correction`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      await grantPlacements(f, groupId, people, kinds, 12);
      await enable(f, groupId, people);
      const counts = [0, 0],
        constraint =
          'Only preview work. This correction does not renew the directed question chain.';
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          expect(current.group_id).toBe(groupId);
          const index = current.recipient_profile_id === people[0].id ? 0 : 1;
          const n = ++counts[index];
          if (index === 0 && n === 6)
            return { text: 'HOP_BOUND_REACHED_WITHOUT_RENEWAL', usage };
          if (n % 2 === 0) return { hold: true };
          const parent =
            index === 0
              ? n === 3
                ? 'BOUNDARY_NATIVE_CYCLE_1_1'
                : n === 5
                  ? 'BOUNDARY_NATIVE_CYCLE_1_3'
                  : undefined
              : n === 1
                ? 'BOUNDARY_NATIVE_CYCLE_0_1'
                : n === 3
                  ? 'BOUNDARY_NATIVE_CYCLE_0_3'
                  : undefined;
          if (parent)
            expect(
              envelopes.some(
                (e) =>
                  e.input_kind === 'question' && e.trigger.content === parent,
              ),
            ).toBe(true);
          if (index === 0 && n === 5)
            expect(
              envelopes.some(
                (e) =>
                  e.input_kind === 'control' &&
                  e.trigger.content === constraint,
              ),
            ).toBe(true);
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1 - index].id,
                message: `BOUNDARY_NATIVE_CYCLE_${index}_${n}`,
              },
            },
            usage,
          };
        } catch (error) {
          failure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Bound this directed peer chain while continuing independent work.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return f.held.size === 2;
      }, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      runId = (await f.snapshot(groupId)).discussion!.run!.id;
      const isA = (body: ModelBody) =>
        memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id;
      await waitForMemberQuestionSubmission(
        db,
        runId!,
        'BOUNDARY_NATIVE_CYCLE_1_1',
        60000,
      );
      expect(
        f.releaseMatching(isA, {
          tool: { name: 'read_group_context', arguments: {} },
          usage,
        }),
      ).toBe(1);
      await waitFor(() => {
        if (failure) throw failure;
        return counts[0] === 4 && f.held.size === 2;
      }, 60000);
      await waitForMemberQuestionSubmission(
        db,
        runId!,
        'BOUNDARY_NATIVE_CYCLE_0_3',
        60000,
      );
      expect(
        f.releaseMatching((body) => !isA(body), {
          tool: { name: 'read_group_context', arguments: {} },
          usage,
        }),
      ).toBe(1);
      await waitFor(() => {
        if (failure) throw failure;
        return counts[1] === 4 && f.held.size === 2;
      }, 60000);
      await waitForMemberQuestionSubmission(
        db,
        runId!,
        'BOUNDARY_NATIVE_CYCLE_1_3',
        60000,
      );
      const frozen = db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(runId) as any[];
      const originalMail = db
        .prepare(
          "SELECT id,hop,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='question' ORDER BY hop",
        )
        .all(runId) as any[];
      expect(originalMail.map((m) => m.hop)).toEqual([1, 2, 3, 4]);
      expect(new Set(originalMail.map((m) => m.deadline_at)).size).toBe(1);
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: constraint,
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return (
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_inputs m JOIN product_session_inputs p ON p.id=m.input_id WHERE m.run_id=? AND m.kind='control' AND p.state='submitted' AND p.submission_id IS NOT NULL",
              )
              .get(runId) as { n: number }
          ).n === 2
        );
      }, 60000);
      expect(
        f.releaseMatching(isA, {
          tool: { name: 'read_group_context', arguments: {} },
          usage,
        }),
      ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        return (
          (await f.snapshot(groupId)).discussion?.run?.status !== 'running'
        );
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        status: 'failed',
        error_code: 'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
      });
      expect(counts).toEqual([6, 4]);
      expect(JSON.stringify(f.requests.at(-1))).toContain(
        'GROUP_MEMBER_HOP_LIMIT',
      );
      expect(JSON.stringify(f.requests.at(-1))).toContain(constraint);
      expect(f.requests).toHaveLength(10);
      expect(
        db
          .prepare(
            "SELECT id,hop,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='question' ORDER BY hop",
          )
          .all(runId),
      ).toEqual(originalMail);
      for (const input of frozen)
        expect(
          db
            .prepare(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            )
            .get(input.id),
        ).toEqual(input);
      await waitFor(
        () =>
          f.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(runId) as { n: number }
          ).n === 0,
        60000,
      );
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('waiting','active')",
          )
          .get(runId),
      ).toEqual({ n: 0 });
      expect(f.stopFailures).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      record('cycle-with-control-' + kinds.join('-'), f, db, runId, {
        model_calls_by_member: counts,
        original_mail: originalMail,
        user_constraint: constraint,
        last_tool_results: f.requests
          .at(-1)!
          .messages.filter((m) => m.role === 'tool'),
      });
    } catch (error) {
      if (db && runId)
        record('failed-cycle-with-control-' + kinds.join('-'), f, db, runId);
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);
}
