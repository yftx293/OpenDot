// Accumulate individually valid messages through native tools, never seeded rows.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { freshMemberGroup } from './helpers/member-inbox-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import { memberPlacementPairs } from './helpers/member-lifecycle-http-fixture.js';

const hash = (s: string | Buffer) =>
  createHash('sha256').update(s).digest('hex');
function asciiBytes(prefix: string, bytes: number) {
  if (Buffer.byteLength(prefix) > bytes)
    throw new Error('Boundary prefix too long');
  return prefix + '.'.repeat(bytes - Buffer.byteLength(prefix));
}
for (const kinds of memberPlacementPairs)
  test(`${kinds.join(' → ')}: cumulative mail bytes reject an individually valid native reply atomically and preserve earlier receipts`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined,
      runId: string | undefined,
      modelFailure: unknown;
    const extra: Record<string, unknown> = {
      test_source_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
    };
    const record = (prefix = '') => {
      if (db && runId)
        recordCloudMemberProof(
          prefix + 'mail-byte-capacity-' + kinds.join('-'),
          f,
          db,
          runId,
          extra,
        );
    };
    try {
      const { groupId, people } = await freshMemberGroup(f, false, [
        'First writer',
        'First reviewer',
        'Second writer',
        'Second reviewer',
      ]);
      for (let index = 0; index < people.length; index++) {
        const snapshot = await f.snapshot(groupId),
          member = snapshot.members.find(
            (m) => m.kind === 'bot' && m.subject_id === people[index].id,
          )!;
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
            'POST',
            {
              runtime_kind: kinds[index % 2],
              tool_capabilities: [],
              max_model_attempts: 12,
              expected_revision: snapshot.revision,
              expected_member_revision: member.revision,
            },
          ),
        );
      }
      const snapshot = await f.snapshot(groupId);
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
            max_turns: 12,
            max_turns_per_dot: 3,
            max_model_attempts: 24,
            expected_revision: snapshot.revision,
          },
        ),
      );
      expect(f.requests).toHaveLength(0);
      const questions = Array.from({ length: 4 }, (_, i) =>
        asciiBytes(`CURRENT_QUESTION_${i}_${randomUUID()}_`, 4096),
      );
      const answerFor = (question: string) =>
        asciiBytes(`RECEIVED_QUESTION_SHA256_${hash(question)}_`, 14500);
      const answers = questions.map(answerFor);
      let asked = 0,
        secondAsked = false;
      const provisional = 'PROVISIONAL_SECOND_WRITER_MUST_NOT_PUBLISH';
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          const profile = current.recipient_profile_id;
          if (profile === people[0].id) {
            if (
              asked === 0 ||
              (asked < 3 &&
                envelopes.some(
                  (e) =>
                    e.input_kind === 'reply' &&
                    e.trigger.content === answers[asked - 1],
                ))
            ) {
              const message = questions[asked++];
              return {
                tool: {
                  name: 'ask_group_dot',
                  arguments: { recipient_profile_id: people[1].id, message },
                },
              };
            }
            return { hold: true };
          }
          if (profile === people[1].id) {
            expect(current.input_kind).toBe('question');
            expect(questions.slice(0, 3)).toContain(current.trigger.content);
            return { text: answerFor(current.trigger.content) };
          }
          if (profile === people[2].id) {
            if (!secondAsked) {
              secondAsked = true;
              return {
                tool: {
                  name: 'ask_group_dot',
                  arguments: {
                    recipient_profile_id: people[3].id,
                    message: questions[3],
                  },
                },
              };
            }
            // A genuine model final frees this slot. Its pending peer request
            // keeps this provisional result from public publication.
            return { text: provisional };
          }
          expect(profile).toBe(people[3].id);
          expect(current.input_kind).toBe('question');
          expect(current.trigger.content).toBe(questions[3]);
          return { hold: true };
        } catch (error) {
          modelFailure = error;
          return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
        }
      });
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'First pair: exchange three bounded preview questions. Retain original receipts and no progress announcements.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      const released = new Set<string>();
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const state = await f.snapshot(groupId);
        runId = state.discussion?.run?.id;
        if (state.discussion?.run?.status !== 'running')
          throw new Error(
            `Unexpected early terminal ${state.discussion?.run?.error_code}`,
          );
        if (!runId) return false;
        const queued = db!
          .prepare(
            "SELECT id FROM bot_group_member_mail WHERE run_id=? AND kind='reply' AND state='submitted' ORDER BY created_at,id",
          )
          .all(runId) as { id: string }[];
        for (const mail of queued) {
          if (released.has(mail.id)) continue;
          if (
            f.releaseMatching(
              (body) =>
                memberEnvelopes(body).at(-1)?.recipient_profile_id ===
                people[0].id,
              { tool: { name: 'read_group_context', arguments: {} } },
            ) === 1
          ) {
            released.add(mail.id);
            break;
          }
        }
        return (
          answers
            .slice(0, 3)
            .every((answer) =>
              state.messages.some((m) => m.content === answer),
            ) && f.held.size === 1
        );
      }, 90000);
      expect(asked).toBe(3);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) n, SUM(length(CAST(content AS BLOB))) bytes FROM bot_group_member_mail WHERE run_id=?',
          )
          .get(runId),
      ).toEqual({ n: 6, bytes: 55788 });
      const firstMail = db
        .prepare(
          'SELECT id,payload_digest,content,message_id,delivery_request_id FROM bot_group_member_mail WHERE run_id=? ORDER BY id',
        )
        .all(runId);
      // Explicitly wake the second independent pair via the actual user API.
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Second pair: review your own bounded preview question; do not change the first pair history.',
          mentions: [people[2].id],
          dispatch: true,
        }),
      );
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const state = await f.snapshot(groupId);
        if (state.discussion?.run?.status !== 'running')
          throw new Error(
            `Unexpected pre-limit terminal ${state.discussion?.run?.error_code}`,
          );
        return (
          f.held.size === 2 &&
          db!
            .prepare(
              "SELECT 1 FROM bot_group_member_inputs WHERE run_id=? AND profile_id=? AND kind='question' AND input_id IS NOT NULL",
            )
            .get(runId, people[3].id) !== undefined
        );
      }, 60000);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) n,SUM(length(CAST(content AS BLOB))) bytes FROM bot_group_member_mail WHERE run_id=?',
          )
          .get(runId),
      ).toEqual({ n: 7, bytes: 59884 });
      await waitFor(() => {
        const rows = db!
          .prepare(
            'SELECT m.input_id,p.submission_id FROM bot_group_member_inputs m LEFT JOIN product_session_inputs p ON p.id=m.input_id WHERE m.run_id=?',
          )
          .all(runId) as {
          input_id: string | null;
          submission_id: number | null;
        }[];
        return (
          rows.length === 10 &&
          rows.every(
            (row) => row.input_id !== null && row.submission_id !== null,
          )
        );
      }, 30000);
      const inputsBefore = db
        .prepare(
          'SELECT id,request_id,payload_digest,input_id FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(runId);
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[3].id,
          { text: answers[3] },
        ),
      ).toBe(1);
      let after = await f.snapshot(groupId);
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        after = await f.snapshot(groupId);
        return after.discussion?.run?.status !== 'running';
      }, 60000);
      expect(after.discussion!.run!.status).toBe('failed');
      expect(after.discussion!.run!.error_code).toBe(
        'GROUP_MEMBER_INBOX_LIMIT',
      );
      await waitFor(
        () =>
          f.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(runId) as any
          ).n === 0,
        30000,
      );
      expect(
        db
          .prepare(
            'SELECT COUNT(*) n,SUM(length(CAST(content AS BLOB))) bytes FROM bot_group_member_mail WHERE run_id=?',
          )
          .get(runId),
      ).toEqual({ n: 7, bytes: 59884 });
      for (const prior of firstMail as any[])
        expect(
          db
            .prepare(
              'SELECT id,payload_digest,content,message_id,delivery_request_id FROM bot_group_member_mail WHERE id=?',
            )
            .get(prior.id),
        ).toEqual(prior);
      expect(
        db
          .prepare(
            'SELECT id,request_id,payload_digest,input_id FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(runId),
      ).toEqual(inputsBefore);
      expect(
        after.messages.some(
          (m) => m.content === answers[3] || m.content === provisional,
        ),
      ).toBe(false);
      expect(
        after.messages.filter((m) => answers.slice(0, 3).includes(m.content)),
      ).toHaveLength(3);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND recipient_profile_id=? AND kind='reply'",
          )
          .get(runId, people[2].id),
      ).toEqual({ n: 0 });
      const completed = db
        .prepare(
          "SELECT p.id,p.state,p.submission_id,s.task_id,s.answer_entry_id,s.result_digest FROM bot_group_member_inputs m JOIN product_session_inputs p ON p.id=m.input_id JOIN product_input_task_sources s ON s.input_id=p.id WHERE m.run_id=? AND m.profile_id=? AND m.kind='question'",
        )
        .get(runId, people[3].id) as any;
      expect(completed.state).toBe('completed');
      expect(completed.task_id).toBeGreaterThan(0);
      expect(completed.answer_entry_id).toBeGreaterThan(0);
      expect(after.discussion!.run!.model_attempts).toBe(f.requests.length);
      expect(f.requests.length).toBeLessThanOrEqual(14);
      Object.assign(extra, {
        individual_question_bytes: 4096,
        individual_answer_bytes: 14500,
        persisted_mail_bytes: 59884,
        rejected_mail_bytes: 74384,
        public_reply_count: 3,
        rejected_reply_sha256: hash(answers[3]),
        original_completed_answer: completed,
        preserved_prior_mail_identity: true,
      });
      record();
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 240000);
