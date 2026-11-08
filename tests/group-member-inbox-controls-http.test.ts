// Actual Product/Pi owners and effects; inference is isolated and synthetic.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
import {
  botHandoffHttpFixture,
  waitFor,
  type ModelBody,
  type ModelPlan,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  grantMemberTools,
  memberEnvelopes,
  recordProof,
  waitForMemberQuestionSubmission,
} from './helpers/member-inbox-http-fixture.js';

function pendingTask(snapshot: BotGroupSnapshot, profile: string) {
  return snapshot.discussion?.awaiting?.find(
    (item) => item.profile_id === profile,
  )?.task;
}

test('a final answer before queued peer consumption stays provisional until the actual reply input finishes', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    const nonce = randomUUID(),
      answer = `REVIEW_${nonce}_61`,
      final = `FINAL_${nonce}_61`;
    const provisional =
      'PROVISIONAL_BEFORE_NATIVE_PEER_CONSUMPTION_MUST_NOT_PUBLISH';
    let a = 0,
      modelFailure: unknown;
    f.setModel((body) => {
      try {
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        if (current.recipient_profile_id === people[1].id)
          return { text: answer };
        if (++a === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: `Review ${nonce}: 88 minus 27?`,
              },
            },
          };
        if (a === 2) return { hold: true };
        expect(
          envelopes.some(
            (e) => e.input_kind === 'reply' && e.trigger.content === answer,
          ),
        ).toBe(true);
        return { text: final };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: `Ask the peer to check ${nonce} while working.`,
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    let snapshot = await f.snapshot(groupId);
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      return (
        f.held.size === 1 && snapshot.messages.some((m) => m.content === answer)
      );
    });
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = snapshot.discussion!.run!;
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT state FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
            )
            .get(run.id) as any
        )?.state === 'submitted',
    );
    // Native final (not a tool result): the queued steer starts a new Task and
    // must not turn this already superseded answer into another public result.
    f.release({ text: provisional });
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      return snapshot.discussion?.run?.status !== 'running';
    });
    expect(snapshot.discussion!.run!.status).toBe('completed');
    expect(snapshot.messages.some((m) => m.content === provisional)).toBe(
      false,
    );
    expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
      1,
    );
    expect(a).toBe(3);
    expect(f.requests).toHaveLength(4);
    const sources = storage
      .prepare(
        'SELECT i.kind,s.answer_entry_id,s.task_id FROM bot_group_member_inputs i JOIN product_input_task_sources s ON s.input_id=i.input_id WHERE i.run_id=? AND i.profile_id=? ORDER BY i.created_at',
      )
      .all(run.id, people[0].id) as any[];
    expect(sources).toHaveLength(2);
    expect(sources[0].task_id).not.toBe(sources[1].task_id);
    expect(sources[0].answer_entry_id).toBeLessThan(sources[1].answer_entry_id);
    recordProof('final-before-peer-consumption', f, storage, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);
const approvalPath = (
  task: { workspace_jid: string; session_id: string },
  approval: { id: string },
) =>
  `/api/groups/${encodeURIComponent(task.workspace_jid)}/sessions/${task.session_id}/approvals/${approval.id}`;

test('a Group Dot cannot adopt its own private native transcript or inherit private Memory tools from that workspace', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    const canary = `PRIVATE_NATIVE_TRANSCRIPT_${randomUUID()}`;
    const created = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(people[0].jid)}/sessions`,
        'POST',
        { name: 'Separate private native context', requestId: randomUUID() },
      ),
    );
    expect(created.session.runtime_kind).toBe('pi-durable');
    const privateId = created.session.id;
    f.setModel(() => ({ text: `Private-only answer ${canary}` }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: people[0].jid,
        agentId: privateId,
        requestId: randomUUID(),
        content: `Remember only in this private conversation: ${canary}`,
        followUpBehavior: 'queue',
      }),
    );
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=? AND state='completed'",
            )
            .get(privateId) as any
        ).n === 1,
    );
    const privateCalls = f.requests.length;
    expect(privateCalls).toBe(1);
    let callsA = 0,
      callsB = 0,
      modelFailure: unknown;
    const answer = `PUBLIC_PEER_${randomUUID()}`,
      final = `PUBLIC_FINAL_${randomUUID()}`;
    f.setModel((body) => {
      try {
        expect(JSON.stringify(body.messages)).not.toContain(canary);
        expect(body.tools?.map((tool) => tool.function.name).sort()).toEqual([
          'ask_group_dot',
          'read_group_context',
        ]);
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        if (current.recipient_profile_id === people[1].id) {
          callsB++;
          return { text: answer };
        }
        callsA++;
        if (callsA === 1)
          return {
            tool: {
              name: 'read_personal_memory',
              arguments: { query: 'unshared private notes' },
            },
          };
        if (callsA === 2)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'Review only this authorized public question.',
              },
            },
          };
        return {
          text: envelopes.some(
            (e) => e.input_kind === 'reply' && e.trigger.content === answer,
          )
            ? final
            : 'PROVISIONAL_AWAITING_PUBLIC_PEER',
        };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Do not read private history or private Memory. Ask the other participant using public Group context.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    let snapshot = await f.snapshot(groupId);
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          `Public-only run failed: ${snapshot.discussion.run.error_code}`,
        );
      return snapshot.discussion?.run?.status === 'completed';
    });
    const run = snapshot.discussion!.run!;
    expect(snapshot.messages.some((m) => m.content.includes(canary))).toBe(
      false,
    );
    expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
      1,
    );
    expect(
      snapshot.messages.some(
        (m) => m.content === 'PROVISIONAL_AWAITING_PUBLIC_PEER',
      ),
    ).toBe(false);
    expect(callsA).toBeGreaterThanOrEqual(3);
    expect(callsA).toBeLessThanOrEqual(4);
    expect(callsB).toBe(1);
    expect(run.model_attempts).toBe(callsA + callsB);
    const sessions = storage
      .prepare(
        'SELECT session_id,profile_id FROM bot_group_member_leases WHERE run_id=?',
      )
      .all(run.id) as any[];
    expect(sessions.every((row) => row.session_id !== privateId)).toBe(true);
    expect(
      storage
        .prepare(
          'SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(privateId),
    ).toEqual({ n: 1 });
    const groupRequests = f.requests.slice(privateCalls);
    expect(JSON.stringify(groupRequests)).not.toContain(canary);
    recordProof('private-native-context-isolation', f, storage, run.id, {
      private_precondition_model_calls: privateCalls,
      group_model_calls: groupRequests.length,
      private_canary_sha256: (await import('node:crypto'))
        .createHash('sha256')
        .update(canary)
        .digest('hex'),
    });
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test.each([false, true])(
  'peer reply and user correction=%s while approval is pending preserve the native boundary and exact consent',
  async (correct) => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
    });
    let storage: Database.Database | undefined;
    try {
      const { groupId, people } = await freshMemberGroup(f);
      await grantMemberTools(
        f,
        groupId,
        people[0].id,
        ['create_approved_artifact'],
        6,
      );
      const nonce = randomUUID(),
        question = `REVIEW_${nonce}_68_MINUS_19`,
        answer = `PEER_${nonce}_49`,
        final = `FINAL_${nonce}_49`;
      const oldContent = `ORIGINAL_REVIEW_${nonce}`,
        newContent = `PREVIEW_ONLY_REVIEW_${nonce}`;
      let callsA = 0,
        callsB = 0,
        modelFailure: unknown;
      const plan = (body: ModelBody): ModelPlan => {
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        if (current.recipient_profile_id === people[1].id) {
          callsB++;
          if (callsB === 1) return { hold: true };
          expect(
            envelopes.some(
              (e) =>
                e.input_kind === 'control' &&
                e.trigger.content ===
                  '只处理预览环境；原先的产物确认失效，新的内容需要重新确认。',
            ),
          ).toBe(true);
          return { text: answer };
        }
        callsA++;
        if (callsA === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: question,
              },
            },
          };
        if (callsA === 2)
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: oldContent },
            },
          };
        if (correct) {
          expect(envelopes.some((e) => e.input_kind === 'control')).toBe(true);
          if (callsA === 3)
            return {
              text: 'Preview restriction received; the previous artifact must not be created.',
            };
          expect(
            envelopes.some(
              (e) => e.input_kind === 'reply' && e.trigger.content === answer,
            ),
          ).toBe(true);
          if (callsA === 4)
            return {
              tool: {
                name: 'create_approved_artifact',
                arguments: { content: newContent },
              },
            };
        } else
          expect(
            envelopes.some(
              (e) => e.input_kind === 'reply' && e.trigger.content === answer,
            ),
          ).toBe(true);
        return { text: final };
      };
      f.setModel((body) => {
        try {
          return plan(body);
        } catch (error) {
          modelFailure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      const checkModel = () => {
        if (modelFailure) throw modelFailure;
      };
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: `Review ${nonce} with the other Dot; propose the exact artifact for approval.`,
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      let snapshot = await f.snapshot(groupId);
      await waitFor(async () => {
        checkModel();
        snapshot = await f.snapshot(groupId);
        return (
          f.held.size === 1 &&
          !!pendingTask(snapshot, people[0].id)?.approvals.some(
            (a) => a.state === 'pending',
          )
        );
      });
      const run = snapshot.discussion!.run!;
      const task = pendingTask(snapshot, people[0].id)!;
      const approval = task.approvals.find((a) => a.state === 'pending')!;
      expect(approval.content).toBe(oldContent);
      expect(callsA).toBe(2);
      expect(callsB).toBe(1);
      storage = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const artifacts = path.join(f.root, 'data/db/private-artifacts');
      expect(fs.existsSync(path.join(artifacts, `${approval.id}.txt`))).toBe(
        false,
      );
      if (correct) {
        await f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content:
              '只处理预览环境；原先的产物确认失效，新的内容需要重新确认。',
            dispatch: true,
          }),
        );
        await waitFor(() => {
          checkModel();
          return callsA === 3;
        });
        expect(
          storage
            .prepare(
              'SELECT state,resolution FROM product_approvals WHERE id=?',
            )
            .get(approval.id),
        ).toEqual({ state: 'denied', resolution: 'revoked' });
        const stale = await f.call(approvalPath(task, approval), 'POST', {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        });
        expect(stale.ok).toBe(false);
        expect(fs.existsSync(path.join(artifacts, `${approval.id}.txt`))).toBe(
          false,
        );
        f.release({ tool: { name: 'read_group_context', arguments: {} } });
        await waitFor(async () => {
          checkModel();
          snapshot = await f.snapshot(groupId);
          return !!pendingTask(snapshot, people[0].id)?.approvals.some(
            (a) => a.state === 'pending',
          );
        });
        const correctedTask = pendingTask(snapshot, people[0].id)!;
        const corrected = correctedTask.approvals.find(
          (a) => a.state === 'pending',
        )!;
        expect(corrected.id).not.toBe(approval.id);
        expect(corrected.content).toBe(newContent);
        expect(snapshot.messages.some((m) => m.content === answer)).toBe(true);
        await f.json(
          await f.call(approvalPath(correctedTask, corrected), 'POST', {
            parametersDigest: corrected.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          }),
        );
        await waitFor(() =>
          fs.existsSync(path.join(artifacts, `${corrected.id}.txt`)),
        );
        expect(
          fs.readFileSync(path.join(artifacts, `${corrected.id}.txt`), 'utf8'),
        ).toBe(newContent);
      } else {
        f.release({ text: answer });
        await waitFor(async () => {
          checkModel();
          snapshot = await f.snapshot(groupId);
          return snapshot.messages.some((m) => m.content === answer);
        });
        const reply = storage
          .prepare(
            "SELECT state FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          )
          .get(run.id) as any;
        expect(reply.state).toBe('submitted'); // admission is not native consumption
        expect(callsA).toBe(2);
        expect(
          pendingTask(snapshot, people[0].id)?.approvals.find(
            (a) => a.id === approval.id,
          )?.state,
        ).toBe('pending');
        await f.json(
          await f.call(approvalPath(task, approval), 'POST', {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          }),
        );
        await waitFor(() =>
          fs.existsSync(path.join(artifacts, `${approval.id}.txt`)),
        );
        expect(
          fs.readFileSync(path.join(artifacts, `${approval.id}.txt`), 'utf8'),
        ).toBe(oldContent);
      }
      await waitFor(async () => {
        checkModel();
        snapshot = await f.snapshot(groupId);
        if (snapshot.discussion?.run?.status === 'failed')
          throw new Error(
            `Approval run failed: ${snapshot.discussion.run.error_code}`,
          );
        return snapshot.discussion?.run?.status === 'completed';
      });
      expect(snapshot.messages.filter((m) => m.content === final)).toHaveLength(
        1,
      );
      expect(
        snapshot.messages.filter((m) => m.content === answer),
      ).toHaveLength(1);
      expect(snapshot.discussion?.awaiting).toHaveLength(0);
      expect(fs.readdirSync(artifacts)).toHaveLength(1);
      expect(callsA).toBe(correct ? 5 : 3);
      expect(callsB).toBe(correct ? 2 : 1);
      expect(snapshot.discussion!.run!.model_attempts).toBe(correct ? 7 : 4);
      const approvals = storage
        .prepare(
          'SELECT id,session_id,tool_task_id,content,parameters_digest,content_digest,state,resolution FROM product_approvals WHERE session_id=? ORDER BY created_at',
        )
        .all(task.session_id);
      recordProof(
        correct
          ? 'approval-control-replaces-consent'
          : 'peer-reply-during-approval',
        f,
        storage,
        run.id,
        { approvals },
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      storage?.close();
      await f.dispose();
    }
  },
  180_000,
);

test('member model budget denial is an explicit waiting-user outcome, fences both owners, and dispatches no extra inference', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    let snapshot = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        max_model_attempts: 1,
        expected_revision: snapshot.revision,
      }),
    );
    f.setModel(() => ({
      tool: {
        name: 'ask_group_dot',
        arguments: {
          recipient_profile_id: people[1].id,
          message:
            'This question must not manufacture another model allowance.',
        },
      },
    }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'One-call budget acceptance.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(async () => {
      snapshot = await f.snapshot(groupId);
      return snapshot.discussion?.run?.status !== 'running';
    });
    expect(snapshot.discussion!.run!.status).toBe('waiting_user');
    expect(snapshot.discussion!.run!.error_code).toBe(
      'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED',
    );
    expect(snapshot.discussion!.run!.model_attempts).toBe(1);
    expect(f.requests).toHaveLength(1);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = snapshot.discussion!.run!;
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
            )
            .get(run.id) as any
        ).n === 0,
    );
    expect(
      snapshot.messages.some(
        (m) => (m.source as any)?.kind === 'group_member_final',
      ),
    ).toBe(false);
    recordProof('model-budget-fenced', f, storage, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test('retryable upstream errors consume each native attempt and end with no fabricated answer or replacement input', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    f.setModel(() => ({
      error: { status: 503, code: 'SYNTHETIC_UPSTREAM_UNAVAILABLE' },
    }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Do not invent an answer if the provider fails.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    let snapshot = await f.snapshot(groupId);
    await waitFor(async () => {
      snapshot = await f.snapshot(groupId);
      return snapshot.discussion?.run?.status !== 'running';
    });
    const run = snapshot.discussion!.run!;
    expect(run.status).toBe('failed');
    expect(run.error_code).toBe('GROUP_MEMBER_NATIVE_INPUT_FAILED');
    expect(f.requests).toHaveLength(4);
    expect(run.model_attempts).toBe(4);
    expect(snapshot.messages.some((m) => m.author_kind === 'bot')).toBe(false);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const inputs = storage
      .prepare('SELECT * FROM bot_group_member_inputs WHERE run_id=?')
      .all(run.id) as any[];
    expect(inputs).toHaveLength(1);
    const receipts = storage
      .prepare(
        'SELECT id,request_id,submission_id,state FROM product_session_inputs WHERE session_id=?',
      )
      .all(inputs[0].session_id) as any[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0].state).toBe('failed');
    const models = storage
      .prepare(
        'SELECT ordinal,native_task_id,native_attempt FROM bot_group_member_model_requests WHERE run_id=? ORDER BY ordinal',
      )
      .all(run.id) as any[];
    expect(models.map((m) => m.ordinal)).toEqual([1, 2, 3, 4]);
    expect(models.map((m) => m.native_attempt)).toEqual([1, 2, 3, 4]);
    expect(new Set(models.map((m) => m.native_task_id)).size).toBe(1);
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
            )
            .get(run.id) as any
        ).n === 0,
    );
    recordProof('upstream-errors-charged', f, storage, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);

test('an expired peer question retains its original deadline and terminates both real native owners', async () => {
  const fault = fs.mkdtempSync(path.join(os.tmpdir(), 'member-expiry-clock-'));
  const clockFile = path.join(fault, 'clock.txt'),
    preload = path.join(fault, 'clock.mjs');
  fs.writeFileSync(clockFile, '0');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';\nconst now = Date.now.bind(Date);\nDate.now = () => now() + Number(fs.readFileSync(${JSON.stringify(clockFile)}, 'utf8'));\n`,
  );
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  let storage: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(preload, {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
    });
    const { groupId, people } = await freshMemberGroup(f);
    let a = 0;
    f.setModel((body) =>
      memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id &&
      ++a === 1
        ? {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: `EXPIRY_${randomUUID()}`,
              },
            },
          }
        : { hold: true },
    );
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Review while this peer reply is pending.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f!.held.size === 2);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    let snapshot = await f.snapshot(groupId);
    const run = snapshot.discussion!.run!;
    const before = storage
      .prepare(
        'SELECT id,deadline_at FROM bot_group_member_mail WHERE run_id=?',
      )
      .get(run.id) as any;
    fs.writeFileSync(clockFile, '120001'); // controlled clock, not an increased test deadline
    await waitFor(async () => {
      snapshot = await f!.snapshot(groupId);
      return snapshot.discussion?.run?.status === 'failed';
    });
    expect(snapshot.discussion!.run!.error_code).toBe(
      'GROUP_MEMBER_DELIVERY_EXPIRED',
    );
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
            )
            .get(run.id) as any
        ).n === 0,
    );
    const after = storage
      .prepare(
        'SELECT id,deadline_at,state FROM bot_group_member_mail WHERE run_id=?',
      )
      .get(run.id) as any;
    expect(after).toEqual({ ...before, state: 'expired' });
    expect(f.requests).toHaveLength(3);
    expect(
      snapshot.messages.some(
        (m) => (m.source as any)?.kind === 'group_member_final',
      ),
    ).toBe(false);
    recordProof('expired-original-question', f, storage, run.id, {
      controlled_clock_advance_ms: 120001,
      original_deadline: before.deadline_at,
    });
  } catch (error) {
    if (f) console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f?.dispose();
    fs.rmSync(fault, { recursive: true, force: true });
  }
}, 180_000);

test('a native A-B question cycle is bounded at four causal hops even when a newer user control is the last input', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  let modelFailure: unknown;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    for (const p of people) await grantMemberTools(f, groupId, p.id, [], 12);
    let snapshot = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        max_turns: 12,
        max_turns_per_dot: 3,
        expected_revision: snapshot.revision,
      }),
    );
    const counts = [0, 0];
    const constraint =
      'Only preview work; this correction must not renew the peer chain.';
    f.setModel((body) => {
      try {
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1),
          index = current?.recipient_profile_id === people[0].id ? 0 : 1;
        const n = ++counts[index];
        if (index === 0 && n === 6)
          return { text: 'HOP_BOUND_REACHED_WITHOUT_RENEWAL' };
        if (n % 2 === 0) return { hold: true };
        const parent =
          index === 0
            ? n === 3
              ? 'NATIVE_CYCLE_1_1'
              : n === 5
                ? 'NATIVE_CYCLE_1_3'
                : undefined
            : n === 1
              ? 'NATIVE_CYCLE_0_1'
              : n === 3
                ? 'NATIVE_CYCLE_0_3'
                : undefined;
        if (parent)
          expect(
            envelopes.some(
              (e) =>
                e.input_kind === 'question' && e.trigger.content === parent,
            ),
          ).toBe(true);
        if (index === 0 && n === 5)
          expect(
            envelopes.some(
              (e) =>
                e.input_kind === 'control' && e.trigger.content === constraint,
            ),
          ).toBe(true);
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1 - index].id,
              message: `NATIVE_CYCLE_${index}_${n}`,
            },
          },
        };
      } catch (error) {
        modelFailure = error;
        return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Bound this directed peer question chain.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => {
      if (modelFailure) throw modelFailure;
      return f.held.size === 2;
    });
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const isA = (body: ModelBody) =>
      memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id;
    await waitForMemberQuestionSubmission(storage, run.id, 'NATIVE_CYCLE_1_1');
    f.releaseMatching(isA, {
      tool: { name: 'read_group_context', arguments: {} },
    });
    await waitFor(() => {
      if (modelFailure) throw modelFailure;
      return counts[0] === 4 && f.held.size === 2;
    });
    await waitForMemberQuestionSubmission(storage, run.id, 'NATIVE_CYCLE_0_3');
    f.releaseMatching((body) => !isA(body), {
      tool: { name: 'read_group_context', arguments: {} },
    });
    await waitFor(() => {
      if (modelFailure) throw modelFailure;
      return counts[1] === 4 && f.held.size === 2;
    });
    await waitForMemberQuestionSubmission(storage, run.id, 'NATIVE_CYCLE_1_3');
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: constraint,
        dispatch: true,
      }),
    );
    await waitFor(() => {
      if (modelFailure) throw modelFailure;
      const controls = storage!
        .prepare(
          "SELECT COUNT(*) n FROM bot_group_member_inputs m JOIN product_session_inputs p ON p.id=m.input_id WHERE m.run_id=? AND m.kind='control' AND p.state='submitted' AND p.submission_id IS NOT NULL",
        )
        .get(run.id) as any;
      return controls.n === 2;
    });
    f.releaseMatching(isA, {
      tool: { name: 'read_group_context', arguments: {} },
    });
    await waitFor(async () => {
      if (modelFailure) throw modelFailure;
      snapshot = await f.snapshot(groupId);
      return snapshot.discussion?.run?.status === 'failed';
    });
    expect(counts).toEqual([6, 4]);
    expect(JSON.stringify(f.requests.at(-1))).toContain(
      'GROUP_MEMBER_HOP_LIMIT',
    );
    expect(JSON.stringify(f.requests.at(-1))).toContain(constraint);
    const mail = storage
      .prepare(
        "SELECT hop,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='question' ORDER BY hop",
      )
      .all(run.id) as any[];
    expect(mail.map((m) => m.hop)).toEqual([1, 2, 3, 4]);
    expect(new Set(mail.map((m) => m.deadline_at)).size).toBe(1);
    expect(snapshot.discussion!.run!.error_code).toBe(
      'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
    );
    await waitFor(
      () =>
        (
          storage!
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
            )
            .get(run.id) as any
        ).n === 0,
    );
    expect(f.requests).toHaveLength(10);
    recordProof('bounded-cycle-with-control', f, storage, run.id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 180_000);
