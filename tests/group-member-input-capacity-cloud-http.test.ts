// Fill through real user corrections and native admission; no seeded Inbox rows.
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import { prepareMemberLifecycleGroup } from './helpers/member-lifecycle-http-fixture.js';

for (const runtime of ['node-durable', 'cloudflare-durable'] as const)
  test(`${runtime}: full native member input capacity rejects a new correction atomically but still permits idempotent replay, read and Stop`, async () => {
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
          prefix + 'input-capacity-' + runtime,
          f,
          db,
          runId,
          extra,
        );
    };
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(f, [
        runtime,
        runtime,
      ]);
      f.setModel((body) => {
        try {
          expect(memberEnvelopes(body).at(-1)!.recipient_profile_id).toBe(
            people[0].id,
          );
          return { hold: true };
        } catch (error) {
          modelFailure = error;
          return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
        }
      });
      const endpoint = `/api/bot-groups/${groupId}/messages`;
      await f.json(
        await f.call(endpoint, 'POST', {
          content: 'Hold the active preview until an explicit user Stop.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (modelFailure) throw modelFailure;
        return f.held.size === 1;
      }, 60000);
      runId = (await f.snapshot(groupId)).discussion!.run!.id;
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      let last:
        | {
            key: string;
            body: { content: string; mentions: string[]; dispatch: boolean };
            receipt: Record<string, unknown>;
          }
        | undefined;
      const correctionsStartedAt = Date.now();
      for (let i = 1; i <= 63; i++) {
        const key = randomUUID(),
          body = {
            content: `Preview correction ${i}: retain prior facts, never deploy production.`,
            mentions: [people[0].id],
            dispatch: true,
          };
        const result = await f.json<{ receipt: Record<string, unknown> }>(
          await f.call(endpoint, 'POST', body, key),
        );
        last = { key, body, receipt: result.receipt };
      }
      const correctionsAdmittedAt = Date.now();
      await waitFor(() => {
        if (modelFailure) throw modelFailure;
        return (
          (
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_inputs m JOIN product_session_inputs p ON p.id=m.input_id WHERE m.run_id=? AND p.state='submitted' AND p.submission_id IS NOT NULL",
              )
              .get(runId) as any
          ).n === 64
        );
      }, 60000);
      const allNativeAcknowledgedAt = Date.now();
      const snapshot = await f.snapshot(groupId);
      expect(snapshot.discussion!.run!.id).toBe(runId);
      expect(snapshot.discussion!.run!.status).toBe('running');
      expect(snapshot.discussion!.run!.model_attempts).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.held.size).toBe(1);
      const identity = () =>
        db!
          .prepare(
            'SELECT id,request_id,payload_digest,input_id FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(runId);
      const frozen = identity(),
        digest = createHash('sha256')
          .update(JSON.stringify(frozen))
          .digest('hex');
      expect(frozen).toHaveLength(64);
      const nativeBefore = db
        .prepare(
          'SELECT id,session_id,request_id,submission_id,payload_digest,state FROM product_session_inputs ORDER BY id',
        )
        .all();
      expect(nativeBefore).toHaveLength(64);
      expect(nativeBefore.every((row: any) => row.state === 'submitted')).toBe(
        true,
      );
      const replayed = await f.json<{ receipt: Record<string, unknown> }>(
        await f.call(endpoint, 'POST', last!.body, last!.key),
      );
      expect(replayed.receipt).toEqual({ ...last!.receipt, replayed: true });
      const rejectedKey = randomUUID(),
        rejectedBody = {
          content:
            'This correction must be rejected without mutating the original Run.',
          mentions: [people[0].id],
          dispatch: true,
        };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.call(
          endpoint,
          'POST',
          rejectedBody,
          rejectedKey,
        );
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe(
          'GROUP_MEMBER_INBOX_LIMIT',
        );
      }
      const after = await f.snapshot(groupId);
      expect(after.revision).toBe(snapshot.revision);
      expect(after.messages).toEqual(snapshot.messages);
      expect(after.discussion!.run!.id).toBe(runId);
      expect(after.discussion!.run!.control_epoch).toBe(
        snapshot.discussion!.run!.control_epoch,
      );
      expect(identity()).toEqual(frozen);
      expect(
        db
          .prepare(
            'SELECT id,session_id,request_id,submission_id,payload_digest,state FROM product_session_inputs ORDER BY id',
          )
          .all(),
      ).toEqual(nativeBefore);
      expect(f.requests).toHaveLength(1);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussions/${runId}/stop`,
          'POST',
          {},
        ),
      );
      await waitFor(() => {
        if (modelFailure) throw modelFailure;
        return (
          f.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(runId) as any
          ).n === 0
        );
      }, 30000);
      const stopped = await f.snapshot(groupId);
      expect(stopped.discussion!.run!.id).toBe(runId);
      expect(stopped.discussion!.run!.status).toBe('cancelled');
      expect(stopped.discussion!.run!.stop_state).toBe('stopped');
      expect(stopped.discussion!.run!.model_attempts).toBe(1);
      expect(identity()).toEqual(frozen);
      expect(f.requests).toHaveLength(1);
      expect(
        stopped.messages.some(
          (m) => (m.source as any)?.kind === 'group_member_final',
        ),
      ).toBe(false);
      Object.assign(extra, {
        admitted_inputs: 64,
        accepted_user_corrections: 63,
        original_identity_sha256: digest,
        rejected_statuses: [409, 409],
        replayed_same_receipt: true,
        rejected_mutation_atomic: true,
        native_ack_is_not_consumption: true,
        inference_calls_before_and_after_stop: 1,
        timing: {
          corrections_admission_ms:
            correctionsAdmittedAt - correctionsStartedAt,
          native_ack_wait_ms: allNativeAcknowledgedAt - correctionsAdmittedAt,
          native_ack_since_model_start_ms:
            allNativeAcknowledgedAt - f.modelIntervals[0].started_at,
          wall_clock_modified: false,
        },
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
