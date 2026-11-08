// Product API + native Node/workerd. Provider text and a one-shot process crash
// are controlled; real filesystem writes/approval/Task receipts are inspected.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';
import { memberEffectCrash } from './helpers/member-effect-crash.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';
import {
  memberPlacementPairs,
  prepareMemberLifecycleGroup,
} from './helpers/member-lifecycle-http-fixture.js';

const usage = { input: 31, output: 7 };
for (const kinds of memberPlacementPairs)
  test(`${kinds.join(' → ')}: an authority crash after the approved effect preserves its original native tool and never rewrites the resource`, async () => {
    const fault = memberEffectCrash();
    let f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>> | undefined;
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    const details: Record<string, unknown> = {};
    const record = (prefix = '') => {
      if (!f || !db || !runId) return;
      recordCloudMemberProof(
        prefix + 'effect-ack-loss-' + kinds.join('-'),
        f,
        db,
        runId,
        {
          ...details,
          crash: fault.evidence(),
          effect_test_sha256: createHash('sha256')
            .update(fs.readFileSync(new URL(import.meta.url)))
            .digest('hex'),
          crash_helper_sha256: createHash('sha256')
            .update(
              fs.readFileSync(
                new URL('./helpers/member-effect-crash.ts', import.meta.url),
              ),
            )
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
      f = await cloudBotHandoffHttpFixture({
        memberInbox: true,
        authorityPreload: fault.preload,
      });
      const { groupId, people } = await prepareMemberLifecycleGroup(
        f,
        kinds,
        [1],
      );
      const question = `APPROVED_PREVIEW_${randomUUID()}`,
        content = `ONE_APPROVED_EFFECT_${randomUUID()}`;
      let asked = false,
        requestedArtifact = false,
        approvalId: string | undefined;
      f.setModel((body) => {
        try {
          const envelopes = memberEnvelopes(body),
            current = envelopes.at(-1)!;
          expect(current.group_id).toBe(groupId);
          if (current.recipient_profile_id === people[1].id) {
            expect(
              envelopes.some(
                (e) =>
                  e.input_kind === 'question' && e.trigger.content === question,
              ),
            ).toBe(true);
            if (!requestedArtifact) {
              requestedArtifact = true;
              return {
                tool: {
                  name: 'create_approved_artifact',
                  arguments: { content },
                },
                usage,
              };
            }
            expect(body.messages.some((m) => m.role === 'tool')).toBe(true);
            expect(approvalId).toBeTruthy();
            expect(
              db!
                .prepare('SELECT state FROM product_approvals WHERE id=?')
                .get(approvalId),
            ).toEqual({ state: 'completed' });
            return { text: `PEER_EFFECT_CONFIRMED_${question}`, usage };
          }
          if (envelopes.some((e) => e.input_kind === 'reply')) {
            expect(JSON.stringify(envelopes)).toContain(
              `PEER_EFFECT_CONFIRMED_${question}`,
            );
            return { text: `FINAL_USED_REAL_RECEIPT_${question}`, usage };
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
            'Developer, continue an independent preview while Reviewer creates one explicitly approved artifact. Use only its real completed receipt.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return (
          !!db!
            .prepare("SELECT 1 FROM product_approvals WHERE state='pending'")
            .get() && f!.held.size === 1
        );
      }, 60000);
      const run = (await f.snapshot(groupId)).discussion!.run!;
      runId = run.id;
      const approval = db
        .prepare('SELECT * FROM product_approvals')
        .get() as any;
      approvalId = approval.id;
      expect(approval.content).toBe(content);
      const runtime = db
        .prepare(
          'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
        )
        .get(approval.session_id) as any;
      const inputs = db
        .prepare(
          'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
        )
        .all() as any[];
      const frozen = db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        )
        .all(runId) as any[];
      const questionBefore = db
        .prepare(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        )
        .get(runId) as any;
      const sessions = db
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        )
        .all(groupId);
      details.original_question = questionBefore;
      details.original_inputs = inputs;
      details.frozen_before = frozen;
      details.original_approval = {
        id: approval.id,
        session_id: approval.session_id,
        tool_task_id: approval.tool_task_id,
        parameters_digest: approval.parameters_digest,
        content_digest: approval.content_digest,
      };
      const target = path.join(
        f.root,
        'data/db/private-artifacts',
        `${approval.id}.txt`,
      );
      expect(fs.existsSync(target)).toBe(false);
      fault.arm();
      try {
        const response = await f.call(
          `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
          'POST',
          {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          },
        );
        expect(response.status).toBe(200);
        await response.body?.cancel();
        details.approval_http_status = response.status;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // Only a transport interruption bound to the exact subsequent crash
        // receipt is expected; permission/validation errors are never ignored.
        details.approval_http_interrupted = true;
      }
      await waitFor(() => fault.crashed(), 60000);
      expect(fault.evidence()).toMatchObject({
        phase: 'effect-written-before-receipt',
        approval_id: approval.id,
        wall_clock_modified: false,
      });
      expect(
        db
          .prepare('SELECT state FROM product_approvals WHERE id=?')
          .get(approval.id),
      ).toEqual({ state: 'executing' });
      expect(fs.readFileSync(target, 'utf8')).toBe(content);
      const before = fs.statSync(target);
      details.effect_before_recovery = {
        sha256: createHash('sha256').update(content).digest('hex'),
        inode: before.ino,
        mtime_ms: before.mtimeMs,
      };
      await f.restartNode();
      await waitFor(async () => {
        if (failure) throw failure;
        const state = (await f!.snapshot(groupId)).discussion!.run!;
        if (state.status === 'failed')
          throw new Error(state.error_code ?? 'Effect recovery failed');
        return (
          state.status === 'completed' ||
          ((
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
              )
              .get(runId) as any
          ).n === 1 &&
            f!.held.size === 1)
        );
      }, 60000);
      if ((await f.snapshot(groupId)).discussion!.run!.status === 'running')
        expect(
          f.releaseMatching(
            (body) =>
              memberEnvelopes(body).at(-1)?.recipient_profile_id ===
              people[0].id,
            { text: 'PROVISIONAL_BEFORE_READING_PEER', usage },
          ),
        ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        const state = (await f!.snapshot(groupId)).discussion!.run!;
        if (state.status === 'failed')
          throw new Error(state.error_code ?? 'Effect recovery failed');
        return state.status === 'completed';
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        id: runId,
        deadline_at: run.deadline_at,
        max_model_attempts: run.max_model_attempts,
      });
      expect(done.discussion!.run!.model_attempts).toBe(f.requests.length);
      expect(f.requests.length).toBeLessThanOrEqual(8);
      expect(
        db
          .prepare(
            'SELECT id,session_id,tool_task_id,parameters_digest,content_digest,state FROM product_approvals',
          )
          .all(),
      ).toEqual([
        { ...(details.original_approval as object), state: 'completed' },
      ]);
      for (const original of inputs)
        expect(
          db
            .prepare(
              'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
            )
            .get(original.id),
        ).toEqual(original);
      for (const original of frozen)
        expect(
          db
            .prepare(
              'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            )
            .get(original.id),
        ).toEqual(original);
      expect(
        db
          .prepare(
            "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId),
      ).toEqual(questionBefore);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          )
          .get(runId),
      ).toEqual({ n: 1 });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) n FROM bot_group_member_inputs WHERE run_id=?',
          )
          .get(runId),
      ).toEqual({ n: 3 });
      const reply = db
        .prepare(
          "SELECT source_input_id FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
        )
        .get(runId) as any;
      expect(reply.source_input_id).toBe(
        inputs.find((input) => input.session_id === approval.session_id)!.id,
      );
      expect(
        db
          .prepare(
            'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          )
          .all(groupId),
      ).toEqual(sessions);
      expect(fs.readFileSync(target, 'utf8')).toBe(content);
      expect(fs.statSync(target).ino).toBe(before.ino);
      expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
      expect(fs.readdirSync(path.dirname(target))).toEqual([
        `${approval.id}.txt`,
      ]);
      expect(
        done.messages
          .filter((m) => m.source.kind === 'group_member_reply')
          .map((m) => m.content),
      ).toEqual([`PEER_EFFECT_CONFIRMED_${question}`]);
      expect(
        done.messages
          .filter((m) => m.source.kind === 'group_member_final')
          .map((m) => m.content),
      ).toEqual([`FINAL_USED_REAL_RECEIPT_${question}`]);
      const accounting = db
        .prepare(
          'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? ORDER BY ordinal',
        )
        .all(runId) as any[];
      expect(
        accounting.every((a) => !['active', 'waiting'].includes(a.state)),
      ).toBe(true);
      const unknown = accounting.filter(
        (a) => a.request_id && a.reported_tokens === null,
      );
      expect(unknown.length).toBeGreaterThan(0);
      expect(
        unknown.every((a) => a.accounted_tokens >= a.reserved_tokens),
      ).toBe(true);
      details.effect_after_recovery = {
        inode: fs.statSync(target).ino,
        mtime_ms: fs.statSync(target).mtimeMs,
      };
      record();
      const calls = f.requests.length;
      await f.restartWorker();
      await f.restartNode();
      await delay(500);
      expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
      expect(f.requests).toHaveLength(calls);
    } catch (error) {
      record('failure-');
      throw error;
    } finally {
      db?.close();
      await f?.dispose();
      fault.dispose();
    }
  }, 240000);
