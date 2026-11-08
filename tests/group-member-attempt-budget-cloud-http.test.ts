// Actual product API and native Node/workerd. Provider responses are controlled;
// the persisted member and Run attempt limits are never patched in storage.
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
for (const mode of ['member-attempt-limit', 'run-attempt-limit'] as const)
  for (const kinds of memberPlacementPairs)
    test(`${kinds.join(' → ')}: ${mode} is charged across a user correction and fences another native request before inference`, async () => {
      const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
      let db: Database.Database | undefined, runId: string | undefined;
      let failure: unknown;
      const details: Record<string, unknown> = { mode };
      const one = (sql: string, ...args: any[]) =>
        db!.prepare(sql).get(...args) as any;
      const all = (sql: string, ...args: any[]) =>
        db!.prepare(sql).all(...args) as any[];
      const record = (prefix = '') => {
        if (!db || !runId) return;
        recordCloudMemberProof(
          prefix + mode + '-' + kinds.join('-'),
          f,
          db,
          runId,
          {
            ...details,
            budget_test_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
            budget_source_sha256: Object.fromEntries(
              [
                'src/bot-groups/member-model-store.ts',
                'src/bot-groups/member-inbox-store.ts',
                'src/personal-agent/product-runtime.ts',
                'src/personal-agent/cloud-member-model.ts',
              ].map((file) => [
                file,
                hash(fs.readFileSync(new URL('../' + file, import.meta.url))),
              ]),
            ),
            run_snapshot: one(
              'SELECT * FROM bot_group_discussions WHERE id=?',
              runId,
            ),
            frozen_after: all(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
              runId,
            ),
            model_limits_after: one(
              'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
              runId,
            ),
            grants_after: all(
              'SELECT g.* FROM bot_group_runtime_grants g JOIN bot_group_member_leases l ON l.grant_id=g.id WHERE l.run_id=? ORDER BY g.id',
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
        const memberLimit = mode === 'member-attempt-limit' ? 2 : 6;
        const runLimit = mode === 'run-attempt-limit' ? 3 : 12;
        const beforeGrant = await f.snapshot(groupId);
        const member = beforeGrant.members.find(
          (m) => m.kind === 'bot' && m.subject_id === people[0].id,
        )!;
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
            'POST',
            {
              runtime_kind: kinds[0],
              tool_capabilities: [],
              max_model_attempts: memberLimit,
              expected_revision: beforeGrant.revision,
              expected_member_revision: member.revision,
            },
          ),
        );
        const beforeSettings = await f.snapshot(groupId);
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
              max_model_attempts: runLimit,
              expected_revision: beforeSettings.revision,
            },
          ),
        );
        expect(f.requests).toHaveLength(0);
        const question = `BOUNDED_PEER_${randomUUID()}`;
        const correction = `ONLY_PREVIEW_NO_RESET_${randomUUID()}`;
        let rootCalls = 0,
          peerCalls = 0;
        f.setModel((body) => {
          try {
            const current = memberEnvelopes(body).at(-1)!;
            expect(current.group_id).toBe(groupId);
            expect(body.tools?.map((t) => t.function.name)).toEqual([
              'ask_group_dot',
              'read_group_context',
            ]);
            if (current.recipient_profile_id === people[1].id) {
              expect(++peerCalls).toBe(1);
              expect(current.trigger.content).toBe(question);
              return { hold: true };
            }
            if (++rootCalls === 1)
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
            expect(rootCalls).toBe(2);
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
              'Developer, ask Reviewer one preview question while checking the shared context independently. Stay inside the existing allowance.',
            mentions: [people[0].id],
            dispatch: true,
          }),
        );
        await waitFor(() => {
          if (failure) throw failure;
          return f.held.size === 2 && rootCalls === 2 && peerCalls === 1;
        }, 60000);
        const before = await f.snapshot(groupId),
          run = before.discussion!.run!;
        runId = run.id;
        expect(run.model_attempts).toBe(3);
        expect(run.max_model_attempts).toBe(runLimit);
        const frozen = all(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          runId,
        );
        const originalQuestion = one(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        );
        const grants = all(
          'SELECT g.* FROM bot_group_runtime_grants g JOIN bot_group_member_leases l ON l.grant_id=g.id WHERE l.run_id=? ORDER BY g.id',
          runId,
        );
        details.original_run = run;
        details.original_question = originalQuestion;
        details.frozen_before = frozen;
        details.grants_before = grants;
        details.model_limits_before = one(
          'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
          runId,
        );
        expect(frozen).toHaveLength(2);
        expect(f.requests).toHaveLength(3);
        if (
          mode === 'member-attempt-limit' &&
          kinds[1] === 'cloudflare-durable'
        ) {
          const peerInput = one(
            "SELECT request_id FROM bot_group_member_inputs WHERE run_id=? AND kind='question'",
            runId,
          );
          const index = f.modelSources.findIndex((source: any) =>
            source.inputs.some(
              (input: any) => input.requestId === peerInput.request_id,
            ),
          );
          expect(index).toBeGreaterThanOrEqual(0);
          const denied = await f.replayMemberModel(index, true);
          expect(denied.status).toBe(409);
          const diagnostic = await denied.json();
          expect(JSON.stringify(diagnostic)).toContain(
            'CLOUD_MEMBER_MODEL_BUDGET_CONFLICT',
          );
          details.premature_budget_claim = {
            status: denied.status,
            result: diagnostic,
          };
          // The signed caller cannot invent exhaustion or purchase a model
          // call with a diagnostic: B has spent only one of its six attempts.
          expect((await f.snapshot(groupId)).discussion!.run).toMatchObject({
            id: runId,
            status: 'running',
            model_attempts: 3,
          });
          expect(f.requests).toHaveLength(3);
        }
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content: correction,
            dispatch: true,
          }),
        );
        expect((await f.snapshot(groupId)).discussion!.run!.id).toBe(runId);
        expect(
          f.releaseMatching(
            (body) =>
              memberEnvelopes(body).at(-1)?.recipient_profile_id ===
              people[0].id,
            { tool: { name: 'read_group_context', arguments: {} }, usage },
          ),
        ).toBe(1);
        await waitFor(async () => {
          if (failure) throw failure;
          return (
            (await f.snapshot(groupId)).discussion!.run!.status !== 'running'
          );
        }, 60000);
        const done = await f.snapshot(groupId);
        expect(done.discussion!.run).toMatchObject({
          id: runId,
          status: 'waiting_user',
          error_code: 'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED',
          deadline_at: run.deadline_at,
          max_model_attempts: runLimit,
          model_attempts: 3,
        });
        await waitFor(
          () =>
            f.held.size === 0 &&
            all(
              'SELECT state FROM bot_group_member_leases WHERE run_id=?',
              runId,
            ).every((l) => l.state === 'done'),
          60000,
        );
        expect(f.requests).toHaveLength(3);
        expect(rootCalls).toBe(2);
        expect(peerCalls).toBe(1);
        const rootLease = one(
          'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
          runId,
          people[0].id,
        );
        const peerLease = one(
          'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
          runId,
          people[1].id,
        );
        expect(rootLease.model_attempts).toBe(2);
        expect(peerLease.model_attempts).toBe(1);
        expect(
          grants.find((g) => g.profile_id === people[0].id).max_model_attempts,
        ).toBe(memberLimit);
        expect(
          all(
            'SELECT g.* FROM bot_group_runtime_grants g JOIN bot_group_member_leases l ON l.grant_id=g.id WHERE l.run_id=? ORDER BY g.id',
            runId,
          ),
        ).toEqual(grants);
        expect(
          one(
            'SELECT * FROM bot_group_member_execution_policies WHERE run_id=?',
            runId,
          ),
        ).toEqual(details.model_limits_before);
        for (const original of frozen)
          expect(
            one(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
              original.id,
            ),
          ).toEqual(original);
        expect(
          one(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
            runId,
          ),
        ).toEqual(originalQuestion);
        expect(
          done.messages.filter((m) => m.content === correction),
        ).toHaveLength(1);
        expect(
          done.messages.some((m) =>
            ['group_member_final', 'group_member_reply'].includes(
              String(m.source.kind),
            ),
          ),
        ).toBe(false);
        const accounting = all(
          'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? ORDER BY ordinal',
          runId,
        );
        expect(
          accounting.every((a) => !['active', 'waiting'].includes(a.state)),
        ).toBe(true);
        expect(accounting.filter((a) => a.request_id)).toHaveLength(3);
        const unknown = accounting.filter(
          (a) => a.request_id && a.reported_tokens === null,
        );
        expect(unknown.length).toBeGreaterThan(0);
        expect(
          unknown.every((a) => a.accounted_tokens >= a.reserved_tokens),
        ).toBe(true);
        const calls = f.requests.length;
        await f.restartWorker();
        await f.restartNode();
        await delay(500);
        expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
        expect((await f.snapshot(groupId)).discussion!.run).toMatchObject({
          id: runId,
          status: 'waiting_user',
          model_attempts: 3,
          max_model_attempts: runLimit,
        });
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
