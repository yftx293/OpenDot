// Actual product/Node/workerd receipts; provider output and declared short-mail
// TTL fault are controlled. These are not vendor inference/staging acceptance.
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
  createMemberMailExpiryPreload,
} from './helpers/member-lifecycle-http-fixture.js';

const usage = { input: 31, output: 7 };
function recordLifecycle(
  name: string,
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
  db: Database.Database,
  runId: string,
  extra: Record<string, unknown> = {},
) {
  recordCloudMemberProof(name, f, db, runId, {
    canonical_messages: db
      .prepare(
        `SELECT id,seq,author_kind,author_id,content,source FROM bot_group_messages
      WHERE group_id=(SELECT group_id FROM bot_group_discussions WHERE id=?) ORDER BY seq`,
      )
      .all(runId),
    lifecycle_source_sha256: Object.fromEntries(
      [
        'tests/group-member-lifecycle-cloud-http.test.ts',
        'tests/helpers/member-lifecycle-http-fixture.ts',
        'tests/helpers/cloud-bot-handoff-http-fixture.ts',
        'src/bot-groups/member-inbox-store.ts',
        'src/bot-groups/discussion-service.ts',
        'src/personal-agent/cloud-authority.ts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(new URL('../' + file, import.meta.url)))
          .digest('hex'),
      ]),
    ),
    ...extra,
  });
}

async function rejectLateModelReplays(
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
) {
  const late: { index: number; status: number; error: string }[] = [];
  for (let index = 0; index < f.modelSources.length; index++) {
    const response = await f.replayMemberModel(index);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const body = (await response.json()) as { error: string };
    expect([
      'GROUP_MEMBER_LEASE_UNAVAILABLE',
      'GROUP_MEMBER_EXECUTION_FENCED',
      'GROUP_DISCUSSION_AUTHORITY_UNAVAILABLE',
      'GROUP_DISCUSSION_TURN_NOT_ACTIVE',
    ]).toContain(body.error);
    late.push({ index, status: response.status, error: body.error });
  }
  return late;
}

for (const kinds of memberPlacementPairs) {
  test(`${kinds.join(' → ')}: an expired original question stops both native owners without clock skew or a late reply`, async () => {
    const clock = createMemberMailExpiryPreload();
    let f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>> | undefined,
      db: Database.Database | undefined;
    try {
      f = await cloudBotHandoffHttpFixture({
        memberInbox: true,
        authorityPreload: clock.preload,
      });
      const { groupId, people } = await prepareMemberLifecycleGroup(f, kinds);
      let asks = 0;
      f.setModel((body) =>
        memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id &&
        ++asks === 1
          ? {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: `EXPIRY_${randomUUID()}`,
                },
              },
              usage,
            }
          : { hold: true },
      );
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'Developer, ask the reviewer while continuing the preview.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => f!.held.size === 2, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const run = (await f.snapshot(groupId)).discussion!.run!;
      const original = db
        .prepare(
          'SELECT id,deadline_at,created_at FROM bot_group_member_mail WHERE run_id=?',
        )
        .get(run.id) as any;
      const frozen = db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(run.id);
      const attestation = clock.receipt();
      expect(attestation).toMatchObject({
        production_ttl_ms: 120000,
        controlled_ttl_ms: 10000,
        wall_clock_modified: false,
      });
      expect(attestation.original_js_sha256).toBe(
        createHash('sha256')
          .update(fs.readFileSync(clock.compiledModule))
          .digest('hex'),
      );
      expect(attestation.executed_js_sha256).not.toBe(
        attestation.original_js_sha256,
      );
      expect(
        original.deadline_at - Date.parse(original.created_at),
      ).toBeGreaterThan(0);
      expect(
        original.deadline_at - Date.parse(original.created_at),
      ).toBeLessThanOrEqual(10000);
      await waitFor(
        async () =>
          (await f!.snapshot(groupId)).discussion?.run?.status === 'failed',
        60000,
      );
      await waitFor(
        () =>
          f!.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(run.id) as any
          ).n === 0,
        60000,
      );
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run!.error_code).toBe(
        'GROUP_MEMBER_DELIVERY_EXPIRED',
      );
      expect(
        db
          .prepare(
            'SELECT id,deadline_at,state FROM bot_group_member_mail WHERE id=?',
          )
          .get(original.id),
      ).toEqual({
        id: original.id,
        deadline_at: original.deadline_at,
        state: 'expired',
      });
      expect(
        db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(run.id),
      ).toEqual(frozen);
      expect(
        done.messages.some(
          (m) =>
            (m.source as any)?.kind === 'group_member_final' ||
            (m.source as any)?.kind === 'group_member_reply',
        ),
      ).toBe(false);
      expect(f.requests).toHaveLength(3);
      expect(
        f.releaseMatching(() => true, { text: 'LATE_EXPIRED_OUTPUT' }),
      ).toBe(0);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('waiting','active')",
          )
          .get(run.id),
      ).toEqual({ n: 0 });
      const late = await rejectLateModelReplays(f);
      expect(f.requests).toHaveLength(3);
      expect(f.stopFailures).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      recordLifecycle('expiry-' + kinds.join('-'), f, db, run.id, {
        expiry_fault: attestation,
        original_deadline: original.deadline_at,
        late_model_replays: late,
      });
    } catch (error) {
      if (f) console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f?.dispose();
      clock.dispose();
    }
  }, 180000);
}

for (const kinds of memberPlacementPairs) {
  test(`${kinds.join(' → ')}: revoking a recipient with a pending native approval fences its old consent and every late model replay`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(
        f,
        kinds,
        [1],
      );
      const content = `REVOKED_REVIEW_ARTIFACT_${randomUUID()}`;
      let asks = 0;
      f.setModel((body) => {
        const current = memberEnvelopes(body).at(-1)!;
        if (current.recipient_profile_id === people[1].id)
          return {
            tool: { name: 'create_approved_artifact', arguments: { content } },
            usage,
          };
        if (++asks === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message:
                  'Inspect the preview and propose its exact private artifact for approval.',
              },
            },
            usage,
          };
        return { hold: true };
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, request the reviewer preview while continuing independently.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(
        async () =>
          f.held.size === 1 &&
          (await f.snapshot(groupId)).discussion?.awaiting?.some(
            (a) => a.profile_id === people[1].id && a.reason === 'approval',
          ) === true,
        60000,
      );
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const before = await f.snapshot(groupId),
        run = before.discussion!.run!;
      const target = before.members.find(
        (m) => m.kind === 'bot' && m.subject_id === people[1].id,
      )!;
      const approval = db
        .prepare('SELECT * FROM product_approvals WHERE content=?')
        .get(content) as any;
      expect(approval.state).toBe('pending');
      const frozen = db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(run.id);
      const runtime = db
        .prepare(
          'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
        )
        .get(approval.session_id) as any;
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/members/${target.id}`,
          'PATCH',
          {
            state: 'disabled',
            expected_revision: before.revision,
          },
        ),
      );
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'failed',
        60000,
      );
      await waitFor(
        () =>
          f.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(run.id) as any
          ).n === 0,
        60000,
      );
      expect(
        db
          .prepare('SELECT state,resolution FROM product_approvals WHERE id=?')
          .get(approval.id),
      ).toEqual({ state: 'denied', resolution: 'revoked' });
      expect(
        (
          await f.call(
            `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
            'POST',
            {
              parametersDigest: approval.parameters_digest,
              decision: 'approve',
              requestId: randomUUID(),
            },
          )
        ).status,
      ).toBe(409);
      expect(
        fs.existsSync(
          path.join(f.root, 'data/db/private-artifacts', `${approval.id}.txt`),
        ),
      ).toBe(false);
      const late = await rejectLateModelReplays(f);
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run!.error_code).toBe(
        'GROUP_DISCUSSION_AUTHORITY_UNAVAILABLE',
      );
      expect(
        done.messages.some(
          (m) =>
            (m.source as any)?.kind === 'group_member_final' ||
            (m.source as any)?.kind === 'group_member_reply',
        ),
      ).toBe(false);
      expect(f.requests).toHaveLength(3);
      expect(
        db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
          )
          .all(run.id),
      ).toEqual(frozen);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM bot_group_member_model_admissions WHERE run_id=? AND state IN ('waiting','active')",
          )
          .get(run.id),
      ).toEqual({ n: 0 });
      expect(f.stopFailures).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      recordLifecycle('revoked-approval-' + kinds.join('-'), f, db, run.id, {
        late_model_replays: late,
      });
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);

  test(`${kinds.join(' → ')}: a user correction reaches both working members before any stale proposal or peer answer can publish`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    let failure: unknown;
    let diagnosticRunId: string | undefined;
    try {
      const { groupId, people } = await prepareMemberLifecycleGroup(
        f,
        kinds,
        [0],
      );
      const restriction =
        'Only inspect the preview. Do not deploy or create an artifact.';
      let asks = 0,
        reviewerCorrectionStarted = false;
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          const control = envelopes.find((e) => e.input_kind === 'control');
          if (control) {
            expect(control.trigger.content).toBe(restriction);
            if (current.recipient_profile_id === people[1].id) {
              reviewerCorrectionStarted = true;
              return { hold: true };
            }
            const reply = envelopes.find((e) => e.input_kind === 'reply');
            if (reply) {
              expect(reply.trigger.content).toBe(
                'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT',
              );
              return {
                text: 'FINAL_PREVIEW_WITH_REVIEW_AND_NEW_RESTRICTION',
                usage,
              };
            }
            return { hold: true };
          }
          if (current.recipient_profile_id === people[0].id && ++asks === 1)
            return {
              tool: {
                name: 'ask_group_dot',
                arguments: {
                  recipient_profile_id: people[1].id,
                  message: 'Review the original preview while I keep working.',
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
            'Developer, ask the reviewer and continue working independently.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => f.held.size === 2, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const run = (await f.snapshot(groupId)).discussion!.run!;
      diagnosticRunId = run.id;
      const frozen = db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(run.id);
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: restriction,
          dispatch: true,
        }),
      );
      await waitFor(
        () =>
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_inputs WHERE run_id=? AND kind='control' AND state='submitted'",
              )
              .get(run.id) as any
          ).n === 2,
        60000,
      );
      expect(
        f.releaseMatching(
          (body) => {
            const es = memberEnvelopes(body);
            return (
              es.at(-1)?.recipient_profile_id === people[0].id &&
              !es.some((e) => e.input_kind === 'control')
            );
          },
          {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'STALE_APPROVAL_MUST_NOT_EXIST' },
            },
            usage,
          },
        ),
      ).toBe(1);
      expect(
        f.releaseMatching(
          (body) => {
            const es = memberEnvelopes(body);
            return (
              es.at(-1)?.recipient_profile_id === people[1].id &&
              !es.some((e) => e.input_kind === 'control')
            );
          },
          { text: 'STALE_REVIEWER_OUTPUT', usage },
        ),
      ).toBe(1);
      await waitFor(() => {
        if (failure) throw failure;
        return (
          reviewerCorrectionStarted &&
          (
            db!
              .prepare(
                `SELECT p.state
          FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id
          WHERE i.run_id=? AND i.kind='question'`,
              )
              .get(run.id) as { state: string }
          )?.state === 'completed'
        );
      }, 60000);
      // The old native answer has completed, but the new instruction is still
      // running. Neither publication nor reply delivery may race ahead of it.
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          )
          .get(run.id),
      ).toEqual({ n: 0 });
      expect(
        (await f.snapshot(groupId)).messages.some(
          (m) => m.content === 'STALE_REVIEWER_OUTPUT',
        ),
      ).toBe(false);
      expect(
        f.releaseMatching(
          (body) => {
            const es = memberEnvelopes(body);
            return (
              es.at(-1)?.recipient_profile_id === people[1].id &&
              es.some((e) => e.input_kind === 'control')
            );
          },
          { text: 'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT', usage },
        ),
      ).toBe(1);
      await waitFor(() => {
        if (failure) throw failure;
        const admitted = db!
          .prepare(
            `SELECT count(*) n
            FROM bot_group_member_inputs i JOIN product_session_inputs p ON p.id=i.input_id
            WHERE i.run_id=? AND i.kind='reply'
              AND i.state IN ('submitted','completed') AND p.submission_id IS NOT NULL
          `,
          )
          .get(run.id) as { n: number };
        return admitted.n === 1;
      }, 60000);
      expect(
        db
          .prepare(
            "SELECT content FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          )
          .get(run.id),
      ).toEqual({ content: 'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT' });
      await waitFor(async () => {
        if (failure) throw failure;
        // The queued reply may arrive before the next model request is held,
        // or already be coalesced into its final answer. Do not miss either.
        return (
          f.releaseMatching(
            (body) => {
              const es = memberEnvelopes(body);
              return (
                es.at(-1)?.recipient_profile_id === people[0].id &&
                es.some((e) => e.input_kind === 'control') &&
                !es.some((e) => e.input_kind === 'reply')
              );
            },
            { tool: { name: 'read_group_context', arguments: {} }, usage },
          ) === 1 ||
          (await f.snapshot(groupId)).discussion?.run?.status !== 'running'
        );
      }, 60000);
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status !== 'running',
        60000,
      );
      if (failure) throw failure;
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        status: 'completed',
        error_code: null,
      });
      expect(
        done.messages.filter(
          (m) => m.content === 'FINAL_PREVIEW_WITH_REVIEW_AND_NEW_RESTRICTION',
        ),
      ).toHaveLength(1);
      expect(
        done.messages.filter(
          (m) => m.content === 'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT',
        ),
      ).toHaveLength(1);
      expect(
        done.messages.some((m) => m.content === 'STALE_REVIEWER_OUTPUT'),
      ).toBe(false);
      expect(
        db.prepare('SELECT count(*) n FROM product_approvals').get(),
      ).toEqual({ n: 0 });
      for (const original of frozen as any[])
        expect(
          db
            .prepare(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            )
            .get(original.id),
        ).toEqual(original);
      expect(f.requests.length).toBeGreaterThanOrEqual(5);
      expect(f.requests.length).toBeLessThanOrEqual(6);
      const question = db
          .prepare(
            "SELECT * FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(run.id) as any,
        reply = db
          .prepare('SELECT * FROM bot_group_member_mail WHERE in_reply_to=?')
          .get(question.id) as any,
        original = db
          .prepare(
            `SELECT i.input_id,s.task_id FROM bot_group_member_inputs i JOIN product_input_task_sources s ON s.input_id=i.input_id WHERE i.run_id=? AND i.kind='question'`,
          )
          .get(run.id) as any,
        corrected = db
          .prepare(
            `SELECT i.input_id,s.task_id,s.answer_entry_id,p.submission_id FROM bot_group_member_inputs i JOIN product_input_task_sources s ON s.input_id=i.input_id JOIN product_session_inputs p ON p.id=i.input_id WHERE i.run_id=? AND i.kind='control' AND i.profile_id=?`,
          )
          .get(run.id, people[1].id) as any;
      expect(reply).toMatchObject({
        source_input_id: corrected.input_id,
        source_task_id: corrected.task_id,
        in_reply_to: question.id,
        deadline_at: question.deadline_at,
      });
      expect(original.task_id).not.toBe(corrected.task_id);
      expect(original.input_id).not.toBe(corrected.input_id);
      expect(JSON.parse(reply.source_inputs)).toEqual([
        expect.objectContaining({
          input_id: corrected.input_id,
          submission_id: corrected.submission_id,
          answer_entry_id: corrected.answer_entry_id,
        }),
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      recordLifecycle('interjection-' + kinds.join('-'), f, db, run.id);
    } catch (error) {
      if (db && diagnosticRunId)
        recordLifecycle(
          'failed-interjection-' + kinds.join('-'),
          f,
          db,
          diagnosticRunId,
        );
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);
}
