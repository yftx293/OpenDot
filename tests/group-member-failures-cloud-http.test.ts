// Real product/Node/workerd; only provider failures and usage are controlled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
for (const mode of [
  'bad-request',
  'auth-rejection',
  'token-overrun',
] as const) {
  for (const kinds of memberPlacementPairs) {
    test(`${kinds.join(' → ')}: a peer ${mode} keeps the original work and budget without publishing a false answer`, async () => {
      const providerError = mode !== 'token-overrun';
      const rejectedStatus = mode === 'auth-rejection' ? 401 : 400;
      // Node retains Pi's existing three retries; Cloud explicitly disables
      // model-error retry in openCloudHarness. Do not change either policy.
      const expectedPeerAttempts =
        providerError && kinds[1] === 'node-durable' ? 4 : 1;
      const expectedRequests = 2 + expectedPeerAttempts;
      const details: Record<string, unknown> = {
        upstream_status: providerError ? rejectedStatus : 200,
        expected_peer_attempts: expectedPeerAttempts,
      };
      const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
      let db: Database.Database | undefined, runId: string | undefined;
      let failure: unknown;
      const record = (prefix = '') => {
        if (!db || !runId) return;
        recordCloudMemberProof(
          prefix + 'peer-' + mode + '-' + kinds.join('-'),
          f,
          db,
          runId,
          {
            ...details,
            failure_source_sha256: Object.fromEntries(
              [
                'src/personal-agent/durable-runtime.ts',
                'apps/cloud-agent/src/harness.ts',
                'package-lock.json',
                'apps/cloud-agent/package-lock.json',
              ].map((file) => [
                file,
                createHash('sha256')
                  .update(
                    fs.readFileSync(new URL('../' + file, import.meta.url)),
                  )
                  .digest('hex'),
              ]),
            ),
            frozen_after: db
              .prepare(
                'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
              )
              .all(runId),
            failure_test_sha256: createHash('sha256')
              .update(fs.readFileSync(new URL(import.meta.url)))
              .digest('hex'),
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
        const question = `CHECK_CURRENT_PREVIEW_${randomUUID()}: verify 87 minus 29.`;
        const counts = [0, 0];
        let armed = false;
        f.setModel((body) => {
          try {
            const envelopes = memberEnvelopes(body),
              current = envelopes.at(-1)!;
            expect(current.group_id).toBe(groupId);
            expect(envelopes.every((e) => e.group_id === groupId)).toBe(true);
            expect(body.tools?.map((t) => t.function.name)).toEqual([
              'ask_group_dot',
              'read_group_context',
            ]);
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
              return armed
                ? {
                    error: {
                      status: rejectedStatus,
                      code: 'SYNTHETIC_PEER_PROVIDER_REJECTION',
                    },
                  }
                : { hold: true };
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
            return { hold: true };
          } catch (error) {
            failure = error;
            return { text: 'SYNTHETIC_ASSERTION_FAILED' };
          }
        });
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content:
              'Developer, check the preview while asking your peer about the uncertain arithmetic. Never invent the missing peer answer.',
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
        const before = await f.snapshot(groupId);
        runId = before.discussion!.run!.id;
        const frozen = db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(runId) as any[];
        const original = db
          .prepare(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId);
        details.frozen_before = frozen;
        details.original_question = original;
        details.model_calls_by_member = counts;
        expect(f.requests).toHaveLength(3);
        armed = true;
        expect(
          f.releaseMatching(
            (body) =>
              memberEnvelopes(body).at(-1)?.recipient_profile_id ===
              people[1].id,
            providerError
              ? {
                  error: {
                    status: rejectedStatus,
                    code: 'SYNTHETIC_PEER_PROVIDER_REJECTION',
                  },
                }
              : {
                  text: 'OVER_BUDGET_PEER_ANSWER_MUST_NOT_PUBLISH',
                  usage: { input: 31, output: 200006 },
                },
          ),
        ).toBe(1);
        await waitFor(async () => {
          if (failure) throw failure;
          return (
            f.requests.length > expectedRequests ||
            (await f.snapshot(groupId)).discussion?.run?.status !== 'running'
          );
        }, 60000);
        const done = await f.snapshot(groupId),
          run = done.discussion!.run!;
        expect(run.id).toBe(runId);
        expect(run).toMatchObject(
          providerError
            ? {
                status: 'failed',
                error_code: 'GROUP_MEMBER_NATIVE_INPUT_FAILED',
              }
            : {
                status: 'waiting_user',
                error_code: 'GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED',
              },
        );
        expect(f.requests).toHaveLength(expectedRequests);
        expect(counts).toEqual([2, expectedPeerAttempts]);
        expect(run.model_attempts).toBe(f.requests.length);
        expect(
          done.messages.filter((m) => m.author_kind === 'bot').map((m) => m.id),
        ).toEqual(
          before.messages
            .filter((m) => m.author_kind === 'bot')
            .map((m) => m.id),
        );
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
            )
            .get(runId),
        ).toEqual({ n: 0 });
        expect(
          db
            .prepare(
              "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
            )
            .get(runId),
        ).toEqual(original);
        expect(
          db
            .prepare(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
            )
            .all(runId),
        ).toEqual(frozen);
        const inputs = db
          .prepare('SELECT * FROM bot_group_member_inputs WHERE run_id=?')
          .all(runId) as any[];
        expect(inputs).toHaveLength(2);
        expect(inputs.every((i) => i.result_message_id === null)).toBe(true);
        const peer = inputs.find((i) => i.kind === 'question')!;
        const attempts = db
          .prepare(
            'SELECT native_task_id,native_attempt FROM bot_group_member_model_requests WHERE run_id=? AND session_id=? ORDER BY ordinal',
          )
          .all(runId, peer.session_id) as any[];
        expect(
          attempts.every(
            (a) =>
              Number.isSafeInteger(a.native_task_id) && a.native_task_id > 0,
          ),
        ).toBe(true);
        expect(new Set(attempts.map((a) => a.native_task_id)).size).toBe(1);
        expect(attempts.map((a) => a.native_attempt)).toEqual(
          Array.from({ length: expectedPeerAttempts }, (_, index) => index + 1),
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
            ).n === 0 &&
            (
              db!
                .prepare(
                  "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('active','waiting')",
                )
                .get(runId) as any
            ).n === 0,
          60000,
        );
        const accounting = db
          .prepare(
            'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? ORDER BY ordinal',
          )
          .all(runId) as any[];
        expect(accounting.filter((a) => a.request_id)).toHaveLength(
          f.requests.length,
        );
        expect(
          accounting
            .filter((a) => a.request_id)
            .every(
              (a) =>
                a.accounted_tokens >= (a.reported_tokens ?? a.reserved_tokens),
            ),
        ).toBe(true);
        if (mode === 'token-overrun')
          expect(
            accounting.find((a) => a.session_id === peer.session_id),
          ).toMatchObject({
            state: 'released',
            reported_tokens: 200037,
            accounted_tokens: 200037,
          });
        else
          expect(
            accounting
              .filter((a) => a.session_id === peer.session_id)
              .every(
                (a) =>
                  a.reported_tokens === null &&
                  a.accounted_tokens === a.reserved_tokens &&
                  a.accounted_tokens > 0,
              ),
          ).toBe(true);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM product_cloud_model_attempts WHERE state='started'",
            )
            .get(),
        ).toEqual({ n: 0 });
        expect(f.stopFailures).toEqual([]);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        record();
      } catch (error) {
        record('failed-');
        console.error(f.diagnostics());
        throw error;
      } finally {
        db?.close();
        await f.dispose();
      }
    }, 180000);
  }
}
