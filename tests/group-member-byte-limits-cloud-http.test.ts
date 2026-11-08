// Actual Node/workerd, normal Group admission, controlled provider UTF-8 boundaries.
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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

function utf8Bytes(prefix: string, bytes: number) {
  const remaining = bytes - Buffer.byteLength(prefix);
  if (remaining < 0) throw new Error('Boundary prefix exceeds budget');
  return (
    prefix + '界'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3)
  );
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
for (const kinds of memberPlacementPairs) {
  test(`${kinds.join(' → ')}: an oversized UTF-8 native question admits no mail; the same Run can ask a valid boundary question`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined,
      runId: string | undefined,
      modelFailure: unknown;
    const extra: Record<string, unknown> = {
      test_source_sha256: createHash('sha256')
        .update(fs.readFileSync(new URL(import.meta.url)))
        .digest('hex'),
    };
    let recorded = false;
    const record = (prefix = '') => {
      if (!db || !runId) return;
      recordCloudMemberProof(
        prefix + 'question-utf8-limit-' + kinds.join('-'),
        f,
        db,
        runId,
        extra,
      );
      recorded = true;
    };
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      const nonce = randomUUID(),
        oversized = utf8Bytes(`TOO_LARGE_${nonce}_`, 4098),
        accepted = utf8Bytes(`BOUNDARY_${nonce}_`, 4096);
      expect(oversized.length).toBeLessThan(4096);
      expect(Buffer.byteLength(accepted)).toBe(4096);
      const answer = `REAL_BOUNDARY_REPLY_${nonce}`,
        final = `USED_BOUNDARY_REPLY_${nonce}`;
      let aCalls = 0;
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          if (current.recipient_profile_id === people[1].id) {
            expect(current.input_kind).toBe('question');
            expect(current.trigger.content).toBe(accepted);
            return { hold: true };
          }
          ++aCalls;
          if (aCalls === 1)
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: oversized,
                },
              },
            };
          if (aCalls === 2) {
            const nativeTools = body.messages.filter((m) => m.role === 'tool');
            expect(JSON.stringify(nativeTools)).toContain(
              'GROUP_MEMBER_MESSAGE_LIMIT',
            );
            expect(
              db!.prepare('SELECT COUNT(*) n FROM bot_group_member_mail').get(),
            ).toEqual({ n: 0 });
            extra.native_rejection_observed = true;
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: accepted,
                },
              },
            };
          }
          if (
            envelopes.some(
              (e) => e.input_kind === 'reply' && e.trigger.content === answer,
            )
          )
            return { text: final };
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
            'Ask only a bounded public question; rejected content must not reach the peer.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const snapshot = await f.snapshot(groupId);
        runId = snapshot.discussion?.run?.id;
        return f.held.size === 2;
      }, 60000);
      const isPeer = (body: Parameters<typeof memberEnvelopes>[0]) =>
        memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id;
      expect(f.releaseMatching(isPeer, { text: answer })).toBe(1);
      await waitFor(() => {
        if (modelFailure) throw modelFailure;
        return !!db!
          .prepare(
            "SELECT 1 FROM bot_group_member_mail WHERE run_id=? AND kind='reply' AND state='submitted'",
          )
          .get(runId);
      }, 60000);
      expect(
        f.releaseMatching((body) => !isPeer(body), {
          text: 'PROVISIONAL_WITHOUT_PEER_CONSUMPTION',
        }),
      ).toBe(1);
      let snapshot = await f.snapshot(groupId);
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        snapshot = await f.snapshot(groupId);
        return snapshot.discussion?.run?.status !== 'running';
      }, 60000);
      expect(snapshot.discussion!.run!.status).toBe('completed');
      expect(
        snapshot.messages.filter((m) => m.content === accepted),
      ).toHaveLength(1);
      expect(snapshot.messages.some((m) => m.content === oversized)).toBe(
        false,
      );
      expect(
        snapshot.messages.filter((m) => m.content === answer),
      ).toHaveLength(1);
      expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
        1,
      );
      expect(
        snapshot.messages.some(
          (m) => m.content === 'PROVISIONAL_WITHOUT_PEER_CONSUMPTION',
        ),
      ).toBe(false);
      expect(f.requests).toHaveLength(5);
      expect(snapshot.discussion!.run!.model_attempts).toBe(5);
      expect(
        db
          .prepare(
            'SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=?',
          )
          .get(runId),
      ).toEqual({ n: 2 });
      Object.assign(extra, {
        oversized_bytes: Buffer.byteLength(oversized),
        oversized_sha256: hash(oversized),
        accepted_bytes: Buffer.byteLength(accepted),
        accepted_sha256: hash(accepted),
        rejected_peer_inputs: 0,
      });
      record();
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      if (!recorded && runId) record('incomplete-');
      db?.close();
      await f.dispose();
    }
  }, 180000);

  test(`${kinds.join(' → ')}: an oversized UTF-8 native answer retains its completed receipt but publishes no peer reply and fences the Run`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined,
      runId: string | undefined,
      modelFailure: unknown;
    const extra: Record<string, unknown> = {
      test_source_sha256: createHash('sha256')
        .update(fs.readFileSync(new URL(import.meta.url)))
        .digest('hex'),
    };
    const record = (prefix = '') => {
      if (db && runId)
        recordCloudMemberProof(
          prefix + 'answer-utf8-limit-' + kinds.join('-'),
          f,
          db,
          runId,
          extra,
        );
    };
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      const question = `BOUNDED_QUESTION_${randomUUID()}`,
        oversized = utf8Bytes('NATIVE_TOO_LARGE_', 16002);
      expect(oversized.length).toBeLessThan(16000);
      let asked = false;
      f.setModel((body) => {
        try {
          const current = memberEnvelopes(body).at(-1)!;
          if (current.recipient_profile_id === people[1].id) {
            expect(current.trigger.content).toBe(question);
            return { hold: true };
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
            };
          }
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
            'Retain native evidence; do not publish a peer answer exceeding the public byte budget.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const snapshot = await f.snapshot(groupId);
        runId = snapshot.discussion?.run?.id;
        return f.held.size === 2;
      }, 60000);
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
          { text: oversized },
        ),
      ).toBe(1);
      let snapshot = await f.snapshot(groupId);
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        snapshot = await f.snapshot(groupId);
        return snapshot.discussion?.run?.status !== 'running';
      }, 60000);
      expect(snapshot.discussion!.run!.status).toBe('failed');
      expect(snapshot.discussion!.run!.error_code).toBe(
        'GROUP_MEMBER_RESULT_LIMIT',
      );
      await waitFor(() => f.held.size === 0, 30000);
      expect(f.requests).toHaveLength(3);
      expect(snapshot.discussion!.run!.model_attempts).toBe(3);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          )
          .get(runId),
      ).toEqual({ n: 0 });
      expect(
        snapshot.messages.some(
          (m) =>
            m.content === oversized ||
            (m.source as any)?.kind === 'group_member_final',
        ),
      ).toBe(false);
      const native = db
        .prepare(
          "SELECT p.id,p.state,s.task_id,s.answer_entry_id,s.result_digest FROM bot_group_member_inputs m JOIN product_session_inputs p ON p.id=m.input_id JOIN product_input_task_sources s ON s.input_id=p.id WHERE m.run_id=? AND m.profile_id=? AND m.kind='question'",
        )
        .get(runId, people[1].id) as any;
      expect(native.state).toBe('completed');
      expect(native.task_id).toBeGreaterThan(0);
      expect(native.answer_entry_id).toBeGreaterThan(0);
      await waitFor(
        () =>
          (
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(runId) as any
          ).n === 0,
        30000,
      );
      Object.assign(extra, {
        oversized_bytes: Buffer.byteLength(oversized),
        oversized_sha256: hash(oversized),
        native_completed_answer: native,
        public_reply_count: 0,
      });
      record();
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);
}
