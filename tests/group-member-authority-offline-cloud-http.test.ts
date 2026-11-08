// The Authority process is actually killed; Cloud transport failures are observed,
// not replaced with synthetic HTTP responses. Only provider output is controlled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { prepareMemberLifecycleGroup } from './helpers/member-lifecycle-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';

const usage = { input: 31, output: 7 };
for (const recipient of ['node-durable', 'cloudflare-durable'] as const)
  test(`cloudflare-durable → ${recipient}: actual Authority downtime preserves original work without offline inference or host fallback`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    const details: Record<string, unknown> = {};
    const one = (sql: string, ...args: any[]) =>
      db!.prepare(sql).get(...args) as any;
    const all = (sql: string, ...args: any[]) =>
      db!.prepare(sql).all(...args) as any[];
    const record = (prefix = '') => {
      if (!db || !runId) return;
      recordCloudMemberProof(
        prefix + 'authority-offline-cloudflare-durable-' + recipient,
        f,
        db,
        runId,
        {
          ...details,
          authority_transport_failures: f.authorityTransportFailures(),
          offline_test_sha256: createHash('sha256')
            .update(fs.readFileSync(new URL(import.meta.url)))
            .digest('hex'),
        },
      );
    };
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, [
        'cloudflare-durable',
        recipient,
      ]);
      const question = `OFFLINE_PREVIEW_${randomUUID()}: verify 93 minus 38`,
        answer = `PEER_OFFLINE_55_${question}`,
        final = `FINAL_OFFLINE_55_${question}`;
      let asked = false,
        returning = false;
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          expect(envelopes.every((e) => e.group_id === groupId)).toBe(true);
          if (current.recipient_profile_id === people[1].id) {
            expect(
              envelopes.some(
                (e) =>
                  e.input_kind === 'question' && e.trigger.content === question,
              ),
            ).toBe(true);
            return returning ? { text: answer, usage } : { hold: true };
          }
          expect(current.recipient_profile_id).toBe(people[0].id);
          if (envelopes.some((e) => e.input_kind === 'reply')) {
            expect(returning).toBe(true);
            expect(JSON.stringify(envelopes)).toContain(answer);
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
          return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
        }
      });
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, ask Reviewer a necessary preview question while continuing independent checks. Preserve this work through a temporary Authority outage.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return f.held.size === 2;
      }, 60000);
      const run = (await f.snapshot(groupId)).discussion!.run!;
      runId = run.id;
      expect(f.requests).toHaveLength(3);
      const originals = all(
        'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
      );
      const frozen = all(
        'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        runId,
      );
      const sessions = all(
        'SELECT profile_id,session_id,runtime_kind FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        groupId,
      );
      const originalQuestion = one(
        "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        runId,
      );
      const admissions = all(
        "SELECT id,reserved_tokens FROM bot_group_member_model_admissions WHERE run_id=? AND state='active'",
        runId,
      );
      expect(originals).toHaveLength(2);
      expect(admissions).toHaveLength(2);
      expect(
        sessions.find((s) => s.profile_id === people[0].id).runtime_kind,
      ).toBe('cloudflare-durable');
      details.original_run = run;
      details.original_inputs = originals;
      details.frozen_before = frozen;
      details.original_sessions = sessions;
      details.original_question = originalQuestion;
      details.interrupted_admissions = admissions;
      const oldProcess = f.getChild()!;
      await f.stop('SIGKILL');
      expect(oldProcess.signalCode).toBe('SIGKILL');
      await waitFor(() => f.held.size === 0, 60000);
      // Observe an actual refused request from a live Cloud owner/recovery Alarm.
      const unavailable = () =>
        f
          .authorityTransportFailures()
          .filter(
            (e) =>
              e.node_signal === 'SIGKILL' &&
              e.cause_code === 'ECONNREFUSED' &&
              !e.request_aborted,
          );
      await waitFor(() => unavailable().length > 0, 60000);
      if (recipient === 'cloudflare-durable') await f.restartWorker();
      const unavailableBeforeQuiet = unavailable().length;
      await delay(4100); // More than two normal product polling intervals.
      expect(f.requests).toHaveLength(3);
      expect(
        one(
          'SELECT status,model_attempts FROM bot_group_discussions WHERE id=?',
          runId,
        ),
      ).toEqual({ status: 'running', model_attempts: 3 });
      expect(
        all(
          'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
        ),
      ).toEqual(originals);
      expect(
        one(
          "SELECT COUNT(*) n FROM bot_group_messages WHERE group_id=? AND author_kind='bot' AND content IN (?,?)",
          groupId,
          answer,
          final,
        ).n,
      ).toBe(0);
      details.offline = {
        native_node_signal: oldProcess.signalCode,
        worker_reconstructed: recipient === 'cloudflare-durable',
        refused_before_quiet: unavailableBeforeQuiet,
        refused_after_quiet: unavailable().length,
        provider_calls: f.requests.length,
        quiet_ms: 4100,
      };
      returning = true;
      await f.restartNode();
      await waitFor(async () => {
        if (failure) throw failure;
        const state = (await f.snapshot(groupId)).discussion!.run!;
        if (state.status === 'failed')
          throw new Error(state.error_code ?? 'Authority recovery failed');
        return (
          one(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
            runId,
          ).n === 1 && f.held.size === 1
        );
      }, 60000);
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id,
          { text: 'PROVISIONAL_BEFORE_OFFLINE_PEER_CONSUMPTION', usage },
        ),
      ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        const state = (await f.snapshot(groupId)).discussion!.run!;
        if (state.status === 'failed')
          throw new Error(state.error_code ?? 'Authority recovery failed');
        return state.status === 'completed';
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        id: runId,
        deadline_at: run.deadline_at,
        max_model_attempts: run.max_model_attempts,
        status: 'completed',
        model_attempts: 6,
      });
      expect(f.requests).toHaveLength(6);
      for (const content of [question, answer, final])
        expect(done.messages.filter((m) => m.content === content)).toHaveLength(
          1,
        );
      expect(
        done.messages.some(
          (m) => m.content === 'PROVISIONAL_BEFORE_OFFLINE_PEER_CONSUMPTION',
        ),
      ).toBe(false);
      expect(done.messages.find((m) => m.content === answer)?.author_id).toBe(
        people[1].id,
      );
      expect(done.messages.find((m) => m.content === final)?.author_id).toBe(
        people[0].id,
      );
      for (const row of originals)
        expect(
          one(
            'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
            row.id,
          ),
        ).toEqual(row);
      for (const row of frozen)
        expect(
          one(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            row.id,
          ),
        ).toEqual(row);
      expect(
        all(
          'SELECT profile_id,session_id,runtime_kind FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          groupId,
        ),
      ).toEqual(sessions);
      expect(
        one(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        ),
      ).toEqual(originalQuestion);
      const reply = one(
        "SELECT in_reply_to,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
        runId,
      );
      expect(reply).toEqual({
        in_reply_to: originalQuestion.id,
        deadline_at: originalQuestion.deadline_at,
      });
      expect(
        all(
          "SELECT id FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
          runId,
        ),
      ).toHaveLength(0);
      expect(
        all(
          "SELECT id FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('active','waiting')",
          runId,
        ),
      ).toHaveLength(0);
      for (const old of admissions) {
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
      details.canonical_messages = done.messages.map(
        ({ id, seq, author_id, content, source }) => ({
          id,
          seq,
          author_id,
          content,
          source,
        }),
      );
      await delay(4100);
      expect(f.requests).toHaveLength(6);
      record();
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 240000);
