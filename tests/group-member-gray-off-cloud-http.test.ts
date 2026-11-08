// Actual Node/workerd reconstruction with admission disabled. Existing work
// must retain its source/budget and remain reconcilable/stoppable, without fallback.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
} from './helpers/member-lifecycle-http-fixture.js';

const usage = { input: 31, output: 7 };
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
for (const mode of ['reconcile-admitted', 'stop-admitted'] as const)
  for (const kinds of memberPlacementPairs)
    test(`${kinds.join(' → ')}: gray-off rejects new member work while ${mode} preserves its original source and budget`, async () => {
      const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
      let db: Database.Database | undefined,
        runId: string | undefined,
        failure: unknown;
      const details: Record<string, unknown> = {
        mode,
        node_member_admission_after_restart: false,
        worker_new_session_admission_after_restart: false,
      };
      const one = (sql: string, ...args: any[]) =>
        db!.prepare(sql).get(...args) as any;
      const all = (sql: string, ...args: any[]) =>
        db!.prepare(sql).all(...args) as any[];
      const record = (prefix = '') => {
        if (!db || !runId) return;
        recordCloudMemberProof(
          prefix + 'gray-off-' + mode + '-' + kinds.join('-'),
          f,
          db,
          runId,
          {
            ...details,
            gray_off_test_sha256: hash(
              fs.readFileSync(new URL(import.meta.url)),
            ),
            gray_off_fixture_sha256: hash(
              fs.readFileSync(
                new URL(
                  './helpers/cloud-bot-handoff-http-fixture.ts',
                  import.meta.url,
                ),
              ),
            ),
            run_snapshot: one(
              'SELECT * FROM bot_group_discussions WHERE id=?',
              runId,
            ),
            frozen_after: all(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
              runId,
            ),
            canonical_messages: all(
              'SELECT id,seq,author_kind,author_id,content,source FROM bot_group_messages WHERE group_id=(SELECT group_id FROM bot_group_discussions WHERE id=?) ORDER BY seq',
              runId,
            ),
          },
        );
      };
      try {
        const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
        const question = `ORIGINAL_GRAY_OFF_QUESTION_${randomUUID()}`;
        const peerAnswer = `PEER_RECOVERED_SAME_QUESTION_${question}`;
        const finalAnswer = `FINAL_READ_AFTER_GRAY_OFF_${question}`;
        let asked = false,
          after = false;
        f.setModel((body) => {
          try {
            const envelopes = memberEnvelopes(body),
              current = envelopes.at(-1)!;
            expect(current.group_id).toBe(groupId);
            if (current.recipient_profile_id === people[1].id) {
              expect(
                envelopes.some(
                  (e) =>
                    e.input_kind === 'question' &&
                    e.trigger.content === question,
                ),
              ).toBe(true);
              return after && mode === 'reconcile-admitted'
                ? { text: peerAnswer, usage }
                : { hold: true };
            }
            if (envelopes.some((e) => e.input_kind === 'reply')) {
              expect(after && mode === 'reconcile-admitted').toBe(true);
              expect(JSON.stringify(envelopes)).toContain(peerAnswer);
              return { text: finalAnswer, usage };
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
            return {
              error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' },
            };
          }
        });
        db = new Database(path.join(f.root, 'data/db/messages.db'), {
          readonly: true,
        });
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content:
              'Developer, continue independently while asking Reviewer one public preview question. Preserve this exact work when admission closes.',
            mentions: [people[0].id],
            dispatch: true,
          }),
        );
        await waitFor(() => {
          if (failure) throw failure;
          return f.held.size === 2;
        }, 60000);
        const before = await f.snapshot(groupId),
          run = before.discussion!.run!;
        runId = run.id;
        expect(f.requests).toHaveLength(3);
        const frozen = all(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          runId,
        );
        const originals = all(
          'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
        );
        const originalQuestion = one(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        );
        const sessions = all(
          'SELECT profile_id,session_id,runtime_kind FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          groupId,
        );
        const oldAdmissions = all(
          "SELECT id,reserved_tokens FROM bot_group_member_model_admissions WHERE run_id=? AND state='active'",
          runId,
        );
        const policy = one(
          'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
          runId,
        );
        expect(frozen).toHaveLength(2);
        expect(oldAdmissions).toHaveLength(2);
        details.original_run = run;
        details.original_question = originalQuestion;
        details.original_inputs = originals;
        details.frozen_before = frozen;
        details.original_sessions = sessions;
        details.interrupted_admissions = oldAdmissions;
        details.original_execution_policy = policy;
        await f.stop('SIGKILL');
        await waitFor(() => f.held.size === 0, 60000);
        await f.restartWorker(); // Existing fixture rebuilds with new Session admission false.
        after = true;
        await f.restartNode(true, false); // All three Node member-admission flags false.
        expect((await f.snapshot(groupId)).discussion!.run!.id).toBe(runId);
        if (mode === 'stop-admitted') {
          const stop = await f.call(
            `/api/bot-groups/${groupId}/discussions/${runId}/stop`,
            'POST',
          );
          expect(stop.ok).toBe(true);
          await stop.body?.cancel();
          await waitFor(
            async () =>
              (await f.snapshot(groupId)).discussion!.run!.status ===
              'cancelled',
            60000,
          );
        } else {
          await waitFor(async () => {
            if (failure) throw failure;
            const state = (await f.snapshot(groupId)).discussion!.run!;
            if (state.status === 'failed')
              throw new Error(state.error_code ?? 'Gray-off recovery failed');
            return (
              state.status === 'completed' ||
              (f.held.size === 1 &&
                one(
                  "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
                  runId,
                ).n === 1)
            );
          }, 60000);
          if ((await f.snapshot(groupId)).discussion!.run!.status === 'running')
            expect(
              f.releaseMatching(
                (body) =>
                  memberEnvelopes(body).at(-1)?.recipient_profile_id ===
                  people[0].id,
                { text: 'PROVISIONAL_BEFORE_RECOVERED_REPLY', usage },
              ),
            ).toBe(1);
          await waitFor(async () => {
            if (failure) throw failure;
            return (
              (await f.snapshot(groupId)).discussion!.run!.status ===
              'completed'
            );
          }, 60000);
        }
        await waitFor(
          () =>
            f.held.size === 0 &&
            all(
              'SELECT state FROM bot_group_member_leases WHERE run_id=?',
              runId,
            ).every((l) => l.state === 'done'),
          60000,
        );
        const done = await f.snapshot(groupId);
        expect(done.discussion!.run).toMatchObject({
          id: runId,
          deadline_at: run.deadline_at,
          max_model_attempts: run.max_model_attempts,
          status: mode === 'reconcile-admitted' ? 'completed' : 'cancelled',
          model_attempts: f.requests.length,
        });
        expect(f.requests.length).toBeLessThanOrEqual(6);
        for (const row of frozen)
          expect(
            one(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
              row.id,
            ),
          ).toEqual(row);
        for (const row of originals)
          expect(
            one(
              'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
              row.id,
            ),
          ).toEqual(row);
        expect(
          one(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
            runId,
          ),
        ).toEqual(originalQuestion);
        expect(
          all(
            'SELECT profile_id,session_id,runtime_kind FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
            groupId,
          ),
        ).toEqual(sessions);
        expect(
          one(
            'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
            runId,
          ),
        ).toEqual(policy);
        for (const old of oldAdmissions) {
          const retained = one(
            'SELECT state,reported_tokens,accounted_tokens FROM bot_group_member_model_admissions WHERE id=?',
            old.id,
          );
          expect(retained.reported_tokens).toBe(null);
          expect(['uncertain', 'cancelled']).toContain(retained.state);
          expect(retained.accounted_tokens).toBeGreaterThanOrEqual(
            old.reserved_tokens,
          );
        }
        expect(
          all(
            'SELECT state FROM bot_group_member_model_admissions WHERE run_id=?',
            runId,
          ).every((a) => !['active', 'waiting'].includes(a.state)),
        ).toBe(true);
        const peerReplies = done.messages.filter(
          (m) => m.source.kind === 'group_member_reply',
        );
        const finals = done.messages.filter(
          (m) => m.source.kind === 'group_member_final',
        );
        if (mode === 'reconcile-admitted') {
          expect(peerReplies.map((m) => m.content)).toEqual([peerAnswer]);
          expect(finals.map((m) => m.content)).toEqual([finalAnswer]);
          const reply = one(
            "SELECT source_input_id FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
            runId,
          );
          const peerSession = sessions.find(
            (s) => s.profile_id === people[1].id,
          ).session_id;
          expect(reply.source_input_id).toBe(
            originals.find((i) => i.session_id === peerSession)!.id,
          );
        } else {
          expect(peerReplies).toEqual([]);
          expect(finals).toEqual([]);
        }
        const calls = f.requests.length;
        const rejected = await f.call(
          `/api/bot-groups/${groupId}/messages`,
          'POST',
          {
            content: `NEW_WORK_MUST_NOT_START_${randomUUID()}`,
            dispatch: true,
          },
        );
        expect(rejected.status).toBeGreaterThanOrEqual(400);
        expect(rejected.status).toBeLessThan(500);
        details.new_admission_status = rejected.status;
        await rejected.body?.cancel();
        expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
        expect(f.requests).toHaveLength(calls);
        await f.restartWorker();
        await f.restartNode(true, false);
        await delay(500);
        expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
        expect(f.requests).toHaveLength(calls);
        record();
      } catch (error) {
        record('failure-');
        throw error;
      } finally {
        db?.close();
        await f.dispose();
      }
    }, 240000);
