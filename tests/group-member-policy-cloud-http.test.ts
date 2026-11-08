// Product APIs/native Node/workerd; only model SSE is synthetic. No DB policy
// writes: revoke a pinned provider, withdraw Host, or reassign Workspace scope.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { POLL_INTERVAL } from '../src/config.js';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
} from './helpers/member-lifecycle-http-fixture.js';

for (const mode of [
  'disabled-model',
  'withdrawn-host-contract',
  'reassigned-workspace-profile',
] as const)
  for (const kinds of memberPlacementPairs)
    test(`${kinds.join(' → ')}: ${mode} fences a parked approval and every old call without losing history or choosing a replacement`, async () => {
      const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
      let db: Database.Database | undefined, runId: string | undefined;
      let failure: unknown;
      const details: Record<string, unknown> = { mode };
      const record = (prefix = '') => {
        if (!db || !runId) return;
        recordCloudMemberProof(
          prefix + mode + '-' + kinds.join('-'),
          f,
          db,
          runId,
          {
            ...details,
            policy_source_sha256: Object.fromEntries(
              [
                'src/runtime-config.ts',
                'src/personal-agent/product-model.ts',
                'src/personal-agent/product-runtime.ts',
                'src/personal-agent/cloud-authority.ts',
                'src/bot-groups/discussion-service.ts',
                'src/bot-groups/store.ts',
                'src/routes/groups.ts',
                'src/agent-profile-runtime.ts',
              ].map((file) => [
                file,
                createHash('sha256')
                  .update(
                    fs.readFileSync(new URL('../' + file, import.meta.url)),
                  )
                  .digest('hex'),
              ]),
            ),
            policy_test_sha256: createHash('sha256')
              .update(fs.readFileSync(new URL(import.meta.url)))
              .digest('hex'),
            run_snapshot: db
              .prepare('SELECT * FROM bot_group_discussions WHERE id=?')
              .get(runId),
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
        const { groupId, people } = await prepareMemberLifecycleGroup(
          f,
          kinds,
          [1],
        );
        if (mode === 'withdrawn-host-contract')
          await f.json(
            await f.call('/api/config/host-integration', 'PUT', {
              adminHostOnlyMode: false,
            }),
          );
        const providers = await f.json<any>(
          await f.call('/api/config/claude/providers'),
        );
        const original =
          providers.providers.find(
            (p: any) => p.id === providers.defaultProviderId,
          ) ?? providers.providers[0];
        if (mode === 'disabled-model') {
          // Disable requires another enabled default. Pin both Dots before
          // changing that default, then refresh grants through the owner API.
          for (const [index, person] of people.entries()) {
            await f.json(
              await f.call(`/api/agent-profiles/${person.id}`, 'PATCH', {
                model_config_id: original.id,
              }),
            );
            const before = await f.snapshot(groupId),
              member = before.members.find(
                (m) => m.kind === 'bot' && m.subject_id === person.id,
              )!;
            await f.json(
              await f.call(
                `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
                'POST',
                {
                  runtime_kind: kinds[index],
                  tool_capabilities:
                    index === 1 ? ['create_approved_artifact'] : [],
                  max_model_attempts: 6,
                  expected_revision: before.revision,
                  expected_member_revision: member.revision,
                },
              ),
            );
          }
          const alternate = await f.json<any>(
            await f.call('/api/config/claude/providers', 'POST', {
              name: 'Unselected model canary',
              type: 'third_party',
              enabled: true,
              anthropicBaseUrl: original.anthropicBaseUrl,
              anthropicModel: 'must-not-be-selected',
              anthropicApiKey: 'synthetic-unused-canary',
              customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
            }),
          );
          await f.json(
            await f.call('/api/config/claude/default', 'PUT', {
              providerId: alternate.id,
            }),
          );
          details.disabled_provider_id = original.id;
          details.unselected_provider_id = alternate.id;
        }
        expect(f.requests).toHaveLength(0);
        const content = `REVOKED_SCOPE_ARTIFACT_${randomUUID()}`;
        let asked = false,
          artifactRequested = false;
        f.setModel((body) => {
          try {
            expect(body.model).toBe('fixture-model');
            const c = memberEnvelopes(body).at(-1)!;
            expect(c.group_id).toBe(groupId);
            if (c.recipient_profile_id === people[1].id) {
              expect(artifactRequested).toBe(false);
              artifactRequested = true;
              return {
                tool: {
                  name: 'create_approved_artifact',
                  arguments: { content },
                },
                usage: { input: 31, output: 7 },
              };
            }
            if (!asked) {
              asked = true;
              return {
                tool: {
                  name: 'ask_group_dot',
                  arguments: {
                    recipient_profile_id: people[1].id,
                    message:
                      'Propose this exact preview artifact only; wait for owner approval.',
                  },
                },
                usage: { input: 31, output: 7 },
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
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content:
              'Developer, continue independently while Reviewer proposes one preview artifact for approval.',
            mentions: [people[0].id],
            dispatch: true,
          }),
        );
        await waitFor(async () => {
          if (failure) throw failure;
          return (
            f.held.size === 1 &&
            (await f.snapshot(groupId)).discussion?.awaiting?.some(
              (a) => a.profile_id === people[1].id && a.reason === 'approval',
            ) === true
          );
        }, 60000);
        db = new Database(path.join(f.root, 'data/db/messages.db'), {
          readonly: true,
        });
        const before = await f.snapshot(groupId),
          run = before.discussion!.run!;
        runId = run.id;
        const approval = db
          .prepare('SELECT * FROM product_approvals WHERE content=?')
          .get(content) as any;
        const runtime = db
          .prepare(
            'SELECT workspace_jid,provider_id FROM product_session_runtimes WHERE session_id=?',
          )
          .get(approval.session_id) as any;
        const frozen = db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(runId);
        const originalQuestion = db
          .prepare(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId);
        details.original_run = run;
        details.original_question = originalQuestion;
        details.frozen_before = frozen;
        details.revoked_approval_id = approval.id;
        expect(approval.state).toBe('pending');
        expect(f.requests).toHaveLength(3);
        if (mode === 'disabled-model') {
          expect(runtime.provider_id).toBe(original.id);
          await f.json(
            await f.call(
              `/api/config/claude/providers/${original.id}/toggle`,
              'POST',
              { enabled: false },
            ),
          );
          const changed = await f.json<any>(
            await f.call('/api/config/claude/providers'),
          );
          expect(
            changed.providers.find((p: any) => p.id === original.id).enabled,
          ).toBe(false);
        } else if (mode === 'reassigned-workspace-profile') {
          expect((await f.snapshot(groupId)).group.workspace_jid).not.toBe(
            runtime.workspace_jid,
          );
          const mapping = () =>
            db!
              .prepare(
                'SELECT r.jid,r.folder,r.created_by,r.is_home,p.agent_profile_id FROM registered_groups r LEFT JOIN workspace_agent_profiles p ON p.group_folder=r.folder WHERE r.jid=?',
              )
              .get(runtime.workspace_jid) as any;
          details.workspace_scope_before = mapping();
          expect(mapping()).toMatchObject({
            is_home: 0,
            agent_profile_id: people[1].id,
          });
          const changed = await f.json<any>(
            await f.call(
              `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/agent-profile`,
              'PATCH',
              { agent_profile_id: people[0].id },
            ),
          );
          expect(changed).toMatchObject({
            success: true,
            agent_profile_id: people[0].id,
          });
          expect(mapping().agent_profile_id).toBe(people[0].id);
          details.workspace_scope_after = mapping();
          const revoked = (await f.snapshot(groupId)).members.find(
            (member) =>
              member.kind === 'bot' && member.subject_id === people[1].id,
          )!;
          expect(revoked).toMatchObject({
            available: false,
            scope_configured: false,
          });
        } else {
          await f.json(
            await f.call(
              `/api/groups/${encodeURIComponent(runtime.workspace_jid)}`,
              'PATCH',
              { execution_mode: 'container' },
            ),
          );
          expect(
            db
              .prepare(
                'SELECT execution_mode FROM registered_groups WHERE jid=?',
              )
              .get(runtime.workspace_jid),
          ).toEqual({ execution_mode: 'container' });
        }
        await waitFor(async () => {
          if (failure) throw failure;
          return (
            (await f.snapshot(groupId)).discussion?.run?.status === 'failed'
          );
        }, 60000);
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
          60000,
        );
        expect(
          db
            .prepare(
              'SELECT state,resolution FROM product_approvals WHERE id=?',
            )
            .get(approval.id),
        ).toEqual({ state: 'denied', resolution: 'revoked' });
        const denied = await f.call(
          `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
          'POST',
          {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          },
        );
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(denied.status).toBeLessThan(500);
        await denied.body?.cancel();
        expect(
          fs.existsSync(
            path.join(
              f.root,
              'data/db/private-artifacts',
              `${approval.id}.txt`,
            ),
          ),
        ).toBe(false);
        const replays = [];
        for (let index = 0; index < f.modelSources.length; index++) {
          const response = await f.replayMemberModel(index);
          const replay = {
            index,
            status: response.status,
            body: await response.json(),
          };
          replays.push(replay);
          details.old_model_replays = replays;
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.status).toBeLessThan(500);
        }
        details.old_model_replays = replays;
        const done = await f.snapshot(groupId);
        expect(done.discussion!.run).toMatchObject({
          id: runId,
          deadline_at: run.deadline_at,
          model_attempts: 3,
          status: 'failed',
        });
        expect(
          done.messages.some((m) =>
            ['group_member_final', 'group_member_reply'].includes(
              String(m.source.kind),
            ),
          ),
        ).toBe(false);
        expect(
          db
            .prepare(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
            )
            .all(runId),
        ).toEqual(frozen);
        expect(
          db
            .prepare(
              "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
            )
            .get(runId),
        ).toEqual(originalQuestion);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('active','waiting')",
            )
            .get(runId),
        ).toEqual({ n: 0 });
        expect(f.requests).toHaveLength(3);
        if (mode === 'disabled-model')
          await f.json(
            await f.call(
              `/api/config/claude/providers/${original.id}/toggle`,
              'POST',
              { enabled: true },
            ),
          );
        else if (mode === 'reassigned-workspace-profile') {
          const restored = await f.json<any>(
            await f.call(
              `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/agent-profile`,
              'PATCH',
              { agent_profile_id: people[1].id },
            ),
          );
          expect(restored).toMatchObject({
            success: true,
            agent_profile_id: people[1].id,
          });
          expect(
            (await f.snapshot(groupId)).members.find(
              (member) =>
                member.kind === 'bot' && member.subject_id === people[1].id,
            ),
          ).toMatchObject({ available: true, scope_configured: true });
          details.workspace_scope_restored_profile_id =
            restored.agent_profile_id;
        } else
          await f.json(
            await f.call(
              `/api/groups/${encodeURIComponent(runtime.workspace_jid)}`,
              'PATCH',
              { execution_mode: 'host' },
            ),
          );
        await delay(
          mode === 'reassigned-workspace-profile'
            ? 2 * POLL_INTERVAL + 100
            : 1000,
        );
        expect((await f.snapshot(groupId)).discussion!.run!.id).toBe(runId);
        expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
          'failed',
        );
        expect(f.requests).toHaveLength(3);
        record();
      } catch (error) {
        record('failure-');
        throw error;
      } finally {
        db?.close();
        await f.dispose();
      }
    }, 240000);
