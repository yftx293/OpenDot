// Actual Node/workerd admission; only provider output and precise ACK loss are controlled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import {
  memberInputAckLoss,
  type MemberAckPhase,
} from './helpers/member-input-ack-loss.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
} from './helpers/member-lifecycle-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';

for (const kinds of memberPlacementPairs)
  test(`${kinds.join(' → ')}: lost question and reply native ACKs reconcile original inputs without duplicate inference`, async () => {
    const phases: MemberAckPhase[] = ['question', 'reply'];
    const destination = { question: kinds[1], reply: kinds[0] };
    const fault = memberInputAckLoss(
      phases.filter((phase) => destination[phase] === 'node-durable'),
    );
    let f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>> | undefined;
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    const details: Record<string, unknown> = {};
    const record = (prefix = '') => {
      if (!f || !db || !runId) return;
      recordCloudMemberProof(
        prefix + 'question-reply-ack-loss-' + kinds.join('-'),
        f,
        db,
        runId,
        {
          ...details,
          node_ack_loss: fault.evidence(),
          cloud_ack_loss: f.submissionAcknowledgementLosses(),
          cloud_message_admissions: f.submissions.map(({ path, body }) => {
            const input = body as {
              request_id: string;
              product_receipt_digest: string;
            };
            return {
              path,
              request_id: input.request_id,
              product_receipt_digest: input.product_receipt_digest,
            };
          }),
          ack_test_sha256: createHash('sha256')
            .update(fs.readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          ack_helper_sha256: createHash('sha256')
            .update(
              fs.readFileSync(
                new URL('./helpers/member-input-ack-loss.ts', import.meta.url),
              ),
            )
            .digest('hex'),
        },
      );
    };
    try {
      f = await cloudBotHandoffHttpFixture({
        memberInbox: true,
        authorityPreload: fault.preload,
      });
      const fixture = f;
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      for (const phase of phases)
        if (destination[phase] === 'cloudflare-durable')
          f.loseNextSubmissionAck(`member-${phase}:`);
      const nonce = randomUUID();
      const question = `ACK_PREVIEW_${nonce}: verify 83 minus 26`,
        answer = `PEER_ACK_${nonce}_57`,
        final = `FINAL_ACK_${nonce}_57`;
      let asked = false;
      const counts = [0, 0];
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          expect(current.group_id).toBe(groupId);
          if (current.recipient_profile_id === people[1].id) {
            counts[1]++;
            expect(
              envelopes.some(
                (e) =>
                  e.input_kind === 'question' && e.trigger.content === question,
              ),
            ).toBe(true);
            return { hold: true };
          }
          expect(current.recipient_profile_id).toBe(people[0].id);
          counts[0]++;
          if (envelopes.some((e) => e.input_kind === 'reply')) {
            expect(JSON.stringify(envelopes)).toContain(answer);
            return { text: final, usage: { input: 31, output: 7 } };
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
              usage: { input: 31, output: 7 },
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
      const one = (sql: string, ...args: any[]) =>
        db!.prepare(sql).get(...args) as any;
      const all = (sql: string, ...args: any[]) =>
        db!.prepare(sql).all(...args) as any[];
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, ask Reviewer to verify the preview while continuing independent checks; use the actual reply.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return fixture.held.size === 2;
      }, 60000);
      const run = (await f.snapshot(groupId)).discussion!.run!;
      runId = run.id;
      const input = (phase: MemberAckPhase) =>
        one(
          'SELECT * FROM bot_group_member_inputs WHERE run_id=? AND kind=?',
          runId,
          phase,
        );
      const loss = (phase: MemberAckPhase) =>
        destination[phase] === 'node-durable'
          ? fault.evidence().records.find((entry) => entry.phase === phase)
          : fixture
              .submissionAcknowledgementLosses()
              .find((entry) => entry.request_id.startsWith(`member-${phase}:`));
      const recovered = (phase: MemberAckPhase) => {
        if (failure) throw failure;
        const row = input(phase);
        const product = row?.input_id
          ? one(
              'SELECT submission_id FROM product_session_inputs WHERE id=?',
              row.input_id,
            )
          : undefined;
        return (
          !!loss(phase) &&
          !!row?.input_id &&
          product?.submission_id > 0 &&
          row.delivery_attempts >= 2 &&
          row.delivery_attempts <= 3 &&
          row.state === 'submitted'
        );
      };
      await waitFor(() => recovered('question'), 60000);
      expect(counts).toEqual([2, 1]);
      expect(f.requests).toHaveLength(3);
      const frozen = all(
        'SELECT id,session_id,request_id,input_id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        runId,
      );
      const originalQuestion = one(
        "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        runId,
      );
      details.original_run = run;
      details.frozen_before = frozen;
      details.original_question = originalQuestion;
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
          { text: answer, usage: { input: 31, output: 7 } },
        ),
      ).toBe(1);
      await waitFor(() => recovered('reply'), 60000);
      for (const phase of phases) {
        const row = input(phase),
          marker = loss(phase)!;
        expect(marker.request_id).toBe(row.request_id);
        const product = one(
          'SELECT id,request_id,submission_id,payload_digest FROM product_session_inputs WHERE id=?',
          row.input_id,
        );
        expect(product.request_id).toBe(row.request_id);
        expect(product.submission_id).toBeGreaterThan(0);
        if ('receipt' in marker) {
          expect(marker.native_status).toBe(202);
          expect(marker.receipt).toMatchObject({
            operationId: row.request_id,
            request_id: row.request_id,
            submission_id: product.submission_id,
          });
        } else {
          expect(marker.session_id).toBe(row.session_id);
          expect(marker.message_id).toBe(product.id);
          expect(marker.submission_id).toBe(product.submission_id);
        }
        expect(
          all(
            'SELECT id FROM product_session_inputs WHERE session_id=? AND request_id=?',
            row.session_id,
            row.request_id,
          ),
        ).toHaveLength(1);
      }
      expect(counts).toEqual([2, 1]);
      expect(f.requests).toHaveLength(3);
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id,
          {
            text: 'PROVISIONAL_BEFORE_ACK_PEER_CONSUMPTION',
            usage: { input: 31, output: 7 },
          },
        ),
      ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        const current = (await fixture.snapshot(groupId)).discussion!.run!;
        if (current.status === 'failed')
          throw new Error(current.error_code ?? 'Member ACK recovery failed');
        return current.status === 'completed';
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        id: runId,
        deadline_at: run.deadline_at,
        max_model_attempts: run.max_model_attempts,
        model_attempts: 4,
        status: 'completed',
      });
      expect(counts).toEqual([3, 1]);
      expect(f.requests).toHaveLength(4);
      expect(
        done.messages.filter((message) => message.content === question),
      ).toHaveLength(1);
      expect(
        done.messages.filter((message) => message.content === answer),
      ).toHaveLength(1);
      expect(
        done.messages.filter((message) => message.content === final),
      ).toHaveLength(1);
      expect(
        done.messages.some(
          (message) =>
            message.content === 'PROVISIONAL_BEFORE_ACK_PEER_CONSUMPTION',
        ),
      ).toBe(false);
      expect(
        done.messages.find((message) => message.content === answer)?.author_id,
      ).toBe(people[1].id);
      expect(
        done.messages.find((message) => message.content === final)?.author_id,
      ).toBe(people[0].id);
      expect(
        all('SELECT id FROM bot_group_member_inputs WHERE run_id=?', runId),
      ).toHaveLength(3);
      for (const original of frozen)
        expect(
          one(
            'SELECT id,session_id,request_id,input_id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            original.id,
          ),
        ).toEqual(original);
      expect(
        one(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        ),
      ).toEqual(originalQuestion);
      const reply = one(
        "SELECT * FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
        runId,
      );
      expect(reply.in_reply_to).toBe(originalQuestion.id);
      expect(reply.deadline_at).toBe(originalQuestion.deadline_at);
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
      expect(
        all(
          "SELECT request_id FROM product_cloud_model_attempts WHERE state='started'",
        ),
      ).toHaveLength(0);
      const originals = all(
        'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
      );
      details.receipts_before_restart = originals;
      details.canonical_messages = done.messages.map(
        ({ id, seq, author_id, content, source }) => ({
          id,
          seq,
          author_id,
          content,
          source,
        }),
      );
      await f.restartNode();
      await f.restartWorker();
      expect((await f.snapshot(groupId)).discussion!.run).toMatchObject({
        id: runId,
        status: 'completed',
        model_attempts: 4,
      });
      expect(
        all(
          'SELECT id,session_id,request_id,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
        ),
      ).toEqual(originals);
      expect(f.requests).toHaveLength(4);
      record();
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      db?.close();
      await f?.dispose();
      fault.dispose();
    }
  }, 240000);
