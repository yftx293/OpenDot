import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  threeDotGroup,
  turnContext,
} from './helpers/group-discussion-fixture.js';

// Real product HTTP, SQLite and Node Pi Sessions; model responses are synthetic.
// Hold a real model call to put the correction after its immutable input.
async function setup(
  f: Awaited<ReturnType<typeof botHandoffHttpFixture>>,
  policy: 'coordinator-v1' | 'relay-v1',
  limits: Record<string, number> = {},
) {
  const { groupId, people } = await threeDotGroup(
    f,
    'node-durable',
    [],
    policy,
  );
  const snapshot = await f.snapshot(groupId);
  await f.json(
    await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
      enabled: true,
      policy,
      coordinator_profile_id: people[0].id,
      participant_profile_ids: people.slice(0, 2).map((p) => p.id),
      max_turns: 6,
      max_turns_per_dot: 2,
      max_model_attempts: 12,
      ...limits,
      expected_revision: snapshot.revision,
    }),
  );
  return { groupId, people };
}

function response(
  policy: 'coordinator-v1' | 'relay-v1',
  control: Record<string, unknown>,
  message: string | null,
) {
  const decision =
    policy === 'relay-v1'
      ? { version: 2, public_message: message, control }
      : {
          ...control,
          ...(control.action === 'reply'
            ? { message }
            : control.action === 'finish'
              ? { summary: message }
              : {}),
        };
  return {
    text: JSON.stringify(decision),
    usage: { input: 11, output: 3 },
  };
}

for (const [policy, staleAction] of [
  ['coordinator-v1', 'reply'],
  ['relay-v1', 'reply'],
  ['relay-v1', 'delegate'],
] as const)
  test(`${policy}: an in-flight speaker rereads a correction before its stale ${staleAction} can take effect`, async () => {
    const f = await botHandoffHttpFixture();
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await setup(f, policy);
      const contexts: any[] = [];
      f.setModel((body, index) => {
        const context = turnContext(body);
        contexts.push(context);
        if (index === 1)
          return response(
            policy,
            policy === 'relay-v1'
              ? { action: 'reply', relay_to: people[1].id }
              : { action: 'speak', profileId: people[1].id },
            policy === 'relay-v1' ? 'DEVELOPER_INITIAL_102_208' : null,
          );
        if (index === 2 || index === 3) return { hold: true };
        return response(policy, { action: 'finish' }, 'FINAL_88_222');
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Budget 310; spend 61, 27 and 14. Reviewer checks Developer.',
        }),
      );
      await waitFor(() => f.requests.length === 2 && f.held.size === 1);
      const before = (await f.snapshot(groupId)).discussion!.run!;
      expect(contexts[1].speaker_contract).toMatchObject({
        role: 'speaker',
        speaker_profile_id: people[1].id,
      });
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const original = db
        .prepare(
          "SELECT * FROM bot_group_discussion_turns WHERE run_id=? AND profile_id=? AND state='pending'",
        )
        .get(before.id, people[1].id) as any;
      const nativeBefore = db
        .prepare(
          'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE session_id=? AND request_id=?',
        )
        .get(original.session_id, original.request_id);
      expect(nativeBefore).toBeTruthy();
      const correction = {
        content: 'Cancel the 14. Correct spend 88, balance 222.',
      };
      const key = randomUUID();
      const added = await f.json<any>(
        await f.call(
          `/api/bot-groups/${groupId}/messages`,
          'POST',
          correction,
          key,
        ),
      );
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/messages`,
          'POST',
          correction,
          key,
        ),
      );
      f.release(
        response(
          policy,
          staleAction === 'delegate'
            ? {
                action: 'delegate',
                work: {
                  target_profile_id: people[0].id,
                  instruction: 'Superseded proposed work',
                  tool_capabilities: [],
                  max_model_attempts: 1,
                  context_message_ids: [contexts[1].root_question.id],
                },
              }
            : {
                action: 'reply',
                ...(policy === 'relay-v1' ? { relay_to: people[0].id } : {}),
              },
          'REVIEWER_STALE_102_208',
        ),
      );
      await waitFor(() => f.requests.length >= 3 && f.held.size === 1);
      // A new input to the same speaker, not the obsolete relay nomination or
      // a coordinator summary that leaves Reviewer's latest reply incorrect.
      expect(contexts[2].speaker_contract).toMatchObject({
        role: 'speaker',
        speaker_profile_id: people[1].id,
      });
      expect(contexts[2].recent_and_delta).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: added.receipt.message_id,
            content: correction.content,
            author_kind: 'user',
            since_last_read: true,
          }),
        ]),
      );
      expect(contexts[2].user_interjection_ids).toContain(
        added.receipt.message_id,
      );
      const old = db
        .prepare('SELECT * FROM bot_group_discussion_turns WHERE id=?')
        .get(original.id) as any;
      expect(old).toMatchObject({
        payload: original.payload,
        request_id: original.request_id,
        session_id: original.session_id,
        context_through_seq: original.context_through_seq,
        grant_id: original.grant_id,
        state: 'completed',
        model_attempts: 1,
        result_message_id: null,
      });
      expect(JSON.parse(old.decision).message).toBe('REVIEWER_STALE_102_208');
      expect(JSON.parse(old.decision).action).toBe(staleAction);
      expect(
        db
          .prepare(
            'SELECT id,session_id,request_id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
          )
          .get(old.input_id),
      ).toEqual(nativeBefore);
      const fresh = db
        .prepare(
          "SELECT * FROM bot_group_discussion_turns WHERE run_id=? AND state='pending'",
        )
        .get(before.id) as any;
      expect(fresh.session_id).toBe(old.session_id);
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.request_id).not.toBe(old.request_id);
      expect(JSON.parse(fresh.payload).followUpBehavior).toBe('queue');
      expect(fresh.context_through_seq).toBeGreaterThan(
        old.context_through_seq,
      );
      f.release(response(policy, { action: 'reply' }, 'REVIEWER_FRESH_88_222'));
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      );
      const snapshot = await f.snapshot(groupId);
      expect(snapshot.discussion!.work).toEqual([]);
      expect(snapshot.discussion!.run).toMatchObject({
        id: before.id,
        deadline_at: before.deadline_at,
        policy,
        protocol_version: before.protocol_version,
        model_attempts: 4,
        turn_count: policy === 'relay-v1' ? 3 : 2,
      });
      expect(
        snapshot.messages.filter((m) => m.author_kind === 'user'),
      ).toHaveLength(2);
      expect(
        snapshot.messages
          .filter((m) => m.author_kind === 'bot')
          .map((m) => m.content),
      ).toEqual([
        ...(policy === 'relay-v1' ? ['DEVELOPER_INITIAL_102_208'] : []),
        'REVIEWER_FRESH_88_222',
        'FINAL_88_222',
      ]);
      const receipts = db
        .prepare(
          `SELECT t.id,t.input_id,t.payload,i.payload input_payload,i.state,
                  i.payload_digest,s.task_id,s.answer_entry_id,s.result_digest,
                  s.payload_digest source_payload_digest,m.content
           FROM bot_group_discussion_turns t
           JOIN product_session_inputs i ON i.id=t.input_id
           JOIN product_input_task_sources s ON s.input_id=i.id
           JOIN product_input_results r ON r.input_id=i.id
           JOIN messages m ON m.id=r.message_id
           WHERE t.id IN (?,?) ORDER BY t.ordinal`,
        )
        .all(old.id, fresh.id) as any[];
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map((r) => r.input_id)).size).toBe(2);
      expect(new Set(receipts.map((r) => r.task_id)).size).toBe(2);
      for (const receipt of receipts) {
        expect(receipt.state).toBe('completed');
        expect(JSON.parse(receipt.input_payload)).toEqual({
          ...JSON.parse(receipt.payload),
          origin: null,
        });
        expect(receipt.source_payload_digest).toBe(receipt.payload_digest);
        expect(receipt.result_digest).toBe(
          createHash('sha256').update(receipt.content).digest('hex'),
        );
      }
      expect(f.requests).toHaveLength(4);
      db.close();
      db = undefined;
      await f.stop();
      await f.start();
      await delay(500);
      expect((await f.snapshot(groupId)).messages).toEqual(snapshot.messages);
      expect(f.requests).toHaveLength(4);
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);

for (const [name, limits, error] of [
  ['total turns', { max_turns: 2 }, 'GROUP_DISCUSSION_TURN_LIMIT'],
  ['per-Dot turns', { max_turns_per_dot: 1 }, 'GROUP_DISCUSSION_TURN_LIMIT'],
  [
    'model calls',
    { max_model_attempts: 2 },
    'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED',
  ],
] as const)
  test(`a corrected relay speaker cannot reset ${name} to obtain a fresh answer`, async () => {
    const f = await botHandoffHttpFixture();
    try {
      const { groupId, people } = await setup(f, 'relay-v1', limits);
      f.setModel((_body, index) =>
        index === 1
          ? response(
              'relay-v1',
              { action: 'reply', relay_to: people[1].id },
              'INITIAL',
            )
          : { hold: true },
      );
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'ROOT',
        }),
      );
      await waitFor(() => f.requests.length === 2 && f.held.size === 1);
      const run = (await f.snapshot(groupId)).discussion!.run!;
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'CORRECTION',
        }),
      );
      f.release(response('relay-v1', { action: 'reply' }, 'STALE'));
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status ===
          'waiting_user',
      );
      const snapshot = await f.snapshot(groupId);
      expect(snapshot.discussion!.run).toMatchObject({
        id: run.id,
        deadline_at: run.deadline_at,
        model_attempts: 2,
        error_code: error,
      });
      expect(
        snapshot.messages
          .filter((m) => m.author_kind === 'bot')
          .map((m) => m.content),
      ).toEqual(['INITIAL']);
      expect(f.requests).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  }, 180000);
