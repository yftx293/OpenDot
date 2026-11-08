// Actual Group API/native Node/workerd. A controlled filesystem actor changes
// this fixture's artifact while Authority is offline. It is not a model tool.
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
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
for (const kinds of memberPlacementPairs)
  test(`${kinds.join(' → ')}: a changed artifact remains uncertain after lost confirmation and cannot be overwritten or borrowed by another session`, async () => {
    const fault = memberEffectCrash();
    let f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>> | undefined;
    let db: Database.Database | undefined, runId: string | undefined;
    let failure: unknown;
    const details: Record<string, unknown> = {
      conflict_actor: 'controlled-filesystem-fault-while-authority-offline',
    };
    const one = (sql: string, ...parameters: any[]) =>
      db!.prepare(sql).get(...parameters) as any;
    const all = (sql: string, ...parameters: any[]) =>
      db!.prepare(sql).all(...parameters) as any[];
    const record = (prefix = '') => {
      if (!f || !db || !runId) return;
      recordCloudMemberProof(
        prefix + 'resource-conflict-' + kinds.join('-'),
        f,
        db,
        runId,
        {
          ...details,
          crash: fault.evidence(),
          conflict_test_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
          conflict_source_sha256: Object.fromEntries(
            [
              'src/personal-agent/artifact-effect.ts',
              'src/personal-agent/approval-store.ts',
              'src/personal-agent/cloud-artifact-tool.ts',
              'apps/cloud-agent/src/artifact-tool.ts',
              'tests/helpers/member-effect-crash.ts',
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
          canonical_messages: all(
            'SELECT id,seq,author_kind,author_id,content,source FROM bot_group_messages WHERE group_id=(SELECT group_id FROM bot_group_discussions WHERE id=?) ORDER BY seq',
            runId,
          ),
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
      const question = `VERIFY_CONFLICT_${randomUUID()}`;
      const originalContent = `ONE_APPROVED_EFFECT_${randomUUID()}`;
      const conflictingContent = `CONCURRENT_RESOURCE_VERSION_${randomUUID()}`;
      const peerWarning = `PEER_EFFECT_UNCERTAIN_${question}`;
      const finalWarning = `FINAL_RESOURCE_REQUIRES_RECONCILIATION_${question}`;
      let asked = false,
        proposed = false,
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
            if (!proposed) {
              proposed = true;
              return {
                tool: {
                  name: 'create_approved_artifact',
                  arguments: { content: originalContent },
                },
                usage,
              };
            }
            // Only a real native Tool error permits this negative public answer.
            const toolResults = body.messages.filter((m) => m.role === 'tool');
            expect(JSON.stringify(toolResults)).toMatch(/uncertain|reconcil/i);
            expect(
              one('SELECT state FROM product_approvals WHERE id=?', approvalId),
            ).toEqual({ state: 'uncertain' });
            return { text: peerWarning, usage };
          }
          if (envelopes.some((e) => e.input_kind === 'reply')) {
            expect(JSON.stringify(envelopes)).toContain(peerWarning);
            return { text: finalWarning, usage };
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
            'Developer, continue independently while Reviewer proposes one artifact. If its native result is uncertain, report that conflict and do not claim success or retry with another resource.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      await waitFor(() => {
        if (failure) throw failure;
        return (
          !!one("SELECT 1 FROM product_approvals WHERE state='pending'") &&
          f!.held.size === 1
        );
      }, 60000);
      const run = (await f.snapshot(groupId)).discussion!.run!;
      runId = run.id;
      const approval = one('SELECT * FROM product_approvals');
      approvalId = approval.id;
      const runtime = one(
        'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
        approval.session_id,
      );
      const rootInput = one(
        "SELECT * FROM bot_group_member_inputs WHERE run_id=? AND kind='root'",
        runId,
      );
      const rootRuntime = one(
        'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
        rootInput.session_id,
      );
      const originals = all(
        'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs ORDER BY id',
      );
      const frozen = all(
        'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE run_id=? ORDER BY id',
        runId,
      );
      const originalQuestion = one(
        "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
        runId,
      );
      details.original_run = run;
      details.original_question = originalQuestion;
      details.original_inputs = originals;
      details.frozen_before = frozen;
      details.original_approval = {
        id: approval.id,
        session_id: approval.session_id,
        tool_task_id: approval.tool_task_id,
        parameters_digest: approval.parameters_digest,
        content_digest: approval.content_digest,
      };
      expect(approval.content).toBe(originalContent);
      expect(f.requests).toHaveLength(3);
      // A browser/owner cannot attach B's approval to A's independent Session.
      const foreign = await f.call(
        `/api/groups/${encodeURIComponent(rootRuntime.workspace_jid)}/sessions/${rootInput.session_id}/approvals/${approval.id}`,
        'POST',
        {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        },
      );
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(foreign.status).toBeLessThan(500);
      details.foreign_session_approval_status = foreign.status;
      await foreign.body?.cancel();
      expect(
        one('SELECT state FROM product_approvals WHERE id=?', approval.id),
      ).toEqual({ state: 'pending' });
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
        details.approval_http_status = response.status;
        await response.body?.cancel();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        details.approval_http_interrupted = true;
      }
      await waitFor(() => fault.crashed(), 60000);
      expect(fault.evidence()).toMatchObject({
        phase: 'effect-written-before-receipt',
        approval_id: approval.id,
        wall_clock_modified: false,
      });
      expect(
        one('SELECT state FROM product_approvals WHERE id=?', approval.id),
      ).toEqual({ state: 'executing' });
      expect(fs.readFileSync(target, 'utf8')).toBe(originalContent);
      details.original_effect_digest = hash(originalContent);
      // Controlled contention on this disposable resource; no policy/DB edits.
      const descriptor = fs.openSync(target, 'r+');
      try {
        fs.ftruncateSync(descriptor, 0);
        fs.writeFileSync(descriptor, conflictingContent, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const conflictStat = fs.statSync(target);
      details.conflict_before_recovery = {
        sha256: hash(conflictingContent),
        inode: conflictStat.ino,
        mtime_ms: conflictStat.mtimeMs,
      };
      await f.restartNode();
      await waitFor(() => {
        if (failure) throw failure;
        return (
          one('SELECT state FROM product_approvals WHERE id=?', approval.id)
            ?.state === 'uncertain'
        );
      }, 60000);
      await waitFor(async () => {
        if (failure) throw failure;
        const state = (await f!.snapshot(groupId)).discussion!.run!.status;
        return (
          ['failed', 'completed'].includes(state) ||
          (one(
            "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
            runId,
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
            { text: 'PROVISIONAL_WITHOUT_RECEIPT_MUST_NOT_PUBLISH', usage },
          ),
        ).toBe(1);
      await waitFor(async () => {
        if (failure) throw failure;
        return ['failed', 'completed'].includes(
          (await f!.snapshot(groupId)).discussion!.run!.status,
        );
      }, 60000);
      await waitFor(
        () =>
          f!.held.size === 0 &&
          all(
            'SELECT state FROM bot_group_member_leases WHERE run_id=?',
            runId,
          ).every((l) => l.state === 'done'),
        60000,
      );
      const done = await f.snapshot(groupId);
      expect(done.discussion!.run).toMatchObject({
        id: runId,
        deadline_at: run.deadline_at,
        max_model_attempts: run.max_model_attempts,
      });
      expect(done.discussion!.run!.model_attempts).toBe(f.requests.length);
      expect(f.requests.length).toBeGreaterThanOrEqual(3);
      expect(f.requests.length).toBeLessThanOrEqual(6);
      expect(
        all(
          'SELECT id,session_id,tool_task_id,parameters_digest,content_digest,state FROM product_approvals',
        ),
      ).toEqual([
        { ...(details.original_approval as object), state: 'uncertain' },
      ]);
      for (const input of originals)
        expect(
          one(
            'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
            input.id,
          ),
        ).toEqual(input);
      for (const input of frozen)
        expect(
          one(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
            input.id,
          ),
        ).toEqual(input);
      expect(
        one(
          "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at,hop FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        ),
      ).toEqual(originalQuestion);
      expect(
        one(
          "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
          runId,
        ),
      ).toEqual({ n: 1 });
      const peerReplies = done.messages.filter(
        (m) => m.source.kind === 'group_member_reply',
      );
      const finals = done.messages.filter(
        (m) => m.source.kind === 'group_member_final',
      );
      if (kinds[1] === 'cloudflare-durable')
        expect(done.discussion!.run).toMatchObject({
          status: 'failed',
          error_code: 'GROUP_MEMBER_EFFECT_UNCERTAIN',
        });
      if (done.discussion!.run!.status === 'completed') {
        // Node may return the actual native Tool error as a negative peer reply.
        // Completion is valid only when the requester has consumed that reply.
        expect(peerReplies.map((m) => m.content)).toEqual([peerWarning]);
        expect(finals.map((m) => m.content)).toEqual([finalWarning]);
        const reply = one(
          "SELECT source_input_id FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          runId,
        );
        expect(reply.source_input_id).toBe(
          originals.find((i) => i.session_id === approval.session_id)!.id,
        );
      } else {
        // A blocked native executor may fail explicitly; timeout/budget failure
        // is not evidence that the resource conflict was safely surfaced.
        expect(done.discussion!.run!.error_code).not.toMatch(
          /BUDGET|EXPIRED|DEADLINE/,
        );
        expect(finals).toEqual([]);
        expect(peerReplies.every((m) => m.content === peerWarning)).toBe(true);
      }
      expect(fs.readFileSync(target, 'utf8')).toBe(conflictingContent);
      expect(fs.statSync(target).ino).toBe(conflictStat.ino);
      expect(fs.statSync(target).mtimeMs).toBe(conflictStat.mtimeMs);
      expect(fs.readdirSync(path.dirname(target))).toEqual([
        `${approval.id}.txt`,
      ]);
      const lateApproval = await f.call(
        `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
        'POST',
        {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        },
      );
      expect(lateApproval.status).toBeGreaterThanOrEqual(400);
      expect(lateApproval.status).toBeLessThan(500);
      details.uncertain_approval_replay_status = lateApproval.status;
      await lateApproval.body?.cancel();
      const accounting = all(
        'SELECT * FROM bot_group_member_model_admissions WHERE run_id=? ORDER BY ordinal',
        runId,
      );
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
      details.conflict_after_recovery = {
        sha256: hash(fs.readFileSync(target)),
        inode: fs.statSync(target).ino,
        mtime_ms: fs.statSync(target).mtimeMs,
      };
      const calls = f.requests.length;
      await f.restartWorker();
      await f.restartNode();
      await delay(500);
      expect((await f.snapshot(groupId)).messages).toEqual(done.messages);
      expect(f.requests).toHaveLength(calls);
      expect(fs.readFileSync(target, 'utf8')).toBe(conflictingContent);
      expect(
        one('SELECT state FROM product_approvals WHERE id=?', approval.id),
      ).toEqual({ state: 'uncertain' });
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
