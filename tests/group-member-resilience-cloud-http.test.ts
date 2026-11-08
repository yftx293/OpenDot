// Actual product/Node/workerd; only the provider outage and usage are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
} from './helpers/member-lifecycle-http-fixture.js';

const usage = { input: 31, output: 7 };
for (const status of [503, 429])
  for (const kinds of memberPlacementPairs)
    test(`${kinds.join(' → ')}: a single peer ${status} recovers the original question and native input without resetting budget`, async () => {
      const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
      let db: Database.Database | undefined, runId: string | undefined;
      let failure: unknown;
      const counts = [0, 0];
      const details: Record<string, unknown> = {
        upstream_status: status,
        model_calls_by_member: counts,
      };
      const record = (prefix = '') => {
        if (!db || !runId) return;
        recordCloudMemberProof(
          prefix + `transient-${status}-${kinds.join('-')}`,
          f,
          db,
          runId,
          {
            ...details,
            test_sha256: createHash('sha256')
              .update(fs.readFileSync(new URL(import.meta.url)))
              .digest('hex'),
            frozen_after: db
              .prepare(
                'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
              )
              .all(runId),
            canonical_messages: db
              .prepare(
                'SELECT id,seq,author_kind,author_id,content,source FROM bot_group_messages WHERE group_id=(SELECT group_id FROM bot_group_discussions WHERE id=?) ORDER BY seq',
              )
              .all(runId),
          },
        );
      };
      try {
        const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
        const question = `TRANSIENT_REVIEW_${randomUUID()}: independently check 87 minus 29.`;
        f.setModel((body) => {
          try {
            const envelopes = memberEnvelopes(body),
              current = envelopes.at(-1)!;
            expect(current.group_id).toBe(groupId);
            expect(envelopes.every((e) => e.group_id === groupId)).toBe(true);
            const member =
              current.recipient_profile_id === people[0].id ? 0 : 1;
            const count = ++counts[member];
            if (member === 1) {
              expect(
                envelopes.some(
                  (e) =>
                    e.input_kind === 'question' &&
                    e.trigger.content === question,
                ),
              ).toBe(true);
              expect(count).toBeLessThanOrEqual(2);
              return count === 1
                ? { hold: true }
                : { text: `PEER_CONFIRMED_58_${question}`, usage };
            }
            if (count === 1)
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
            if (envelopes.some((e) => e.input_kind === 'reply')) {
              expect(JSON.stringify(envelopes)).toContain(
                `PEER_CONFIRMED_58_${question}`,
              );
              return { text: `FINAL_CONSUMED_58_${question}`, usage };
            }
            return { hold: true };
          } catch (error) {
            failure = error;
            return {
              error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' },
            };
          }
        });
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content:
              'Developer, continue an independent preview while Reviewer checks the arithmetic. Use the actual peer answer.',
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
        const before = await f.snapshot(groupId),
          run = before.discussion!.run!;
        runId = run.id;
        const frozen = db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(runId) as any[];
        const original = db
          .prepare(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId) as any;
        const peer = db
          .prepare(
            "SELECT * FROM bot_group_member_inputs WHERE run_id=? AND kind='question'",
          )
          .get(runId) as any;
        const native = db
          .prepare(
            'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
          )
          .get(peer.input_id);
        expect(native).toBeTruthy();
        expect(f.requests).toHaveLength(3);
        details.frozen_before = frozen;
        details.original_question = original;
        details.original_native_input = native;
        expect(
          f.releaseMatching(
            (body) =>
              memberEnvelopes(body).at(-1)?.recipient_profile_id ===
              people[1].id,
            { error: { status, code: 'SYNTHETIC_TRANSIENT_OUTAGE' } },
          ),
        ).toBe(1);
        await waitFor(async () => {
          if (failure) throw failure;
          const state = (await f.snapshot(groupId)).discussion!.run!;
          if (state.status !== 'running')
            throw new Error(state.error_code ?? state.status);
          return (
            (
              db!
                .prepare(
                  "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
                )
                .get(runId) as any
            ).n === 1 && f.held.size === 1
          );
        }, 60000);
        expect(counts).toEqual([2, 2]);
        expect(f.requests).toHaveLength(4);
        expect(
          db
            .prepare(
              'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
            )
            .get(peer.input_id),
        ).toEqual(native);
        expect(
          db
            .prepare(
              "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
            )
            .get(runId),
        ).toEqual(original);
        expect(
          f.releaseMatching(
            (body) =>
              memberEnvelopes(body).at(-1)?.recipient_profile_id ===
              people[0].id,
            { text: 'PROVISIONAL_BEFORE_READING_PEER', usage },
          ),
        ).toBe(1);
        await waitFor(async () => {
          if (failure) throw failure;
          const state = (await f.snapshot(groupId)).discussion!.run!;
          if (state.status === 'failed')
            throw new Error(state.error_code ?? state.status);
          return state.status === 'completed';
        }, 60000);
        const done = await f.snapshot(groupId);
        expect(done.discussion!.run).toMatchObject({
          id: runId,
          deadline_at: run.deadline_at,
          model_attempts: 5,
          max_model_attempts: run.max_model_attempts,
        });
        expect(counts).toEqual([3, 2]);
        expect(f.requests).toHaveLength(5);
        expect(
          done.messages
            .filter((m) => m.source.kind === 'group_member_reply')
            .map((m) => m.content),
        ).toEqual([`PEER_CONFIRMED_58_${question}`]);
        expect(
          done.messages
            .filter((m) => m.source.kind === 'group_member_final')
            .map((m) => m.content),
        ).toEqual([`FINAL_CONSUMED_58_${question}`]);
        for (const originalInput of frozen)
          expect(
            db
              .prepare(
                'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
              )
              .get(originalInput.id),
          ).toEqual(originalInput);
        const reply = db
          .prepare(
            "SELECT * FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          )
          .get(runId) as any;
        expect(reply).toMatchObject({
          in_reply_to: original.id,
          deadline_at: original.deadline_at,
          source_input_id: peer.input_id,
        });
        const source = db
          .prepare('SELECT * FROM product_input_task_sources WHERE input_id=?')
          .get(peer.input_id) as any;
        expect(source.task_id).toBe(reply.source_task_id);
        const attempts = db
          .prepare(
            'SELECT native_task_id,native_attempt FROM bot_group_member_model_requests WHERE run_id=? AND session_id=? ORDER BY ordinal',
          )
          .all(runId, peer.session_id) as any[];
        expect(attempts).toHaveLength(2);
        expect(new Set(attempts.map((a) => a.native_task_id)).size).toBe(1);
        if (kinds[1] === 'node-durable')
          expect(attempts.map((a) => a.native_attempt)).toEqual([1, 2]);
        const accounting = db
          .prepare(
            'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? AND request_id IS NOT NULL ORDER BY ordinal',
          )
          .all(runId) as any[];
        expect(accounting).toHaveLength(5);
        expect(
          accounting.every((a) => !['active', 'waiting'].includes(a.state)),
        ).toBe(true);
        expect(
          accounting.reduce((n, a) => n + (a.reported_tokens ?? 0), 0),
        ).toBe(152);
        const unknown = accounting.filter((a) => a.reported_tokens === null);
        expect(unknown).toHaveLength(1);
        expect(unknown[0].accounted_tokens).toBeGreaterThanOrEqual(
          unknown[0].reserved_tokens,
        );
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
            )
            .get(runId),
        ).toEqual({ n: 0 });
        details.peer_native_attempts = attempts;
        record();
        await f.restartWorker();
        await f.restartNode();
        await delay(500);
        expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
        expect(f.requests).toHaveLength(5);
      } catch (error) {
        record('failure-');
        throw error;
      } finally {
        db?.close();
        await f.dispose();
      }
    }, 240000);
