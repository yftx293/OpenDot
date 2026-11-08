import { randomUUID } from 'node:crypto';
// Actual Node authority + workerd/SQLite + Pi sessions. Model SSE and hostname
// routing are synthetic. This is not evidence of deployed Cloudflare access.
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import {
  turnContext,
  groupInputContext,
  threeDotGroup,
} from './helpers/group-discussion-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import Database from 'better-sqlite3';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('a Cloud relay speaker rereads an in-flight user correction without changing its original Task or spending the stale relay', async () => {
  const f = await cloudBotHandoffHttpFixture();
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'cloudflare-durable',
      [],
      'relay-v1',
    );
    const before = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.slice(0, 2).map((p) => p.id),
        expected_revision: before.revision,
      }),
    );
    const contexts: any[] = [];
    const say = (control: Record<string, unknown>, public_message: string) => ({
      text: JSON.stringify({ version: 2, public_message, control }),
    });
    f.setModel((body, index) => {
      contexts.push(turnContext(body));
      if (index === 1)
        return say(
          { action: 'reply', relay_to: people[1].id },
          'INITIAL_102_208',
        );
      if (index === 2) return { hold: true };
      return index === 3
        ? say({ action: 'reply' }, 'REVIEWER_FRESH_88_222')
        : say({ action: 'finish' }, 'FINAL_88_222');
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Budget 310; spend 61, 27 and 14.',
      }),
    );
    await waitFor(() => f.requests.length === 2 && f.held.size === 1);
    const run = (await f.snapshot(groupId)).discussion!.run!;
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const old = db
      .prepare(
        "SELECT * FROM bot_group_discussion_turns WHERE run_id=? AND state='pending'",
      )
      .get(run.id) as any;
    const nativeBefore = db
      .prepare(
        'SELECT id,payload,payload_digest,submission_id FROM product_session_inputs WHERE session_id=? AND request_id=?',
      )
      .get(old.session_id, old.request_id);
    expect(nativeBefore).toBeTruthy();
    const correction = await f.json<any>(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Cancel 14. Correct spend 88, balance 222.',
      }),
    );
    f.release(
      say(
        { action: 'reply', relay_to: people[0].id },
        'REVIEWER_STALE_102_208',
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    expect(contexts[2].speaker_contract).toMatchObject({
      role: 'speaker',
      speaker_profile_id: people[1].id,
    });
    expect(contexts[2].user_interjection_ids).toContain(
      correction.receipt.message_id,
    );
    const turns = db
      .prepare(
        'SELECT * FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
      )
      .all(run.id) as any[];
    expect(turns).toHaveLength(4);
    expect(turns[1]).toMatchObject({
      id: old.id,
      payload: old.payload,
      request_id: old.request_id,
      state: 'completed',
      model_attempts: 1,
      result_message_id: null,
    });
    expect(turns[2].session_id).toBe(old.session_id);
    expect(turns[2].request_id).not.toBe(old.request_id);
    expect(JSON.parse(turns[2].payload).followUpBehavior).toBe('queue');
    expect(
      db
        .prepare(
          'SELECT id,payload,payload_digest,submission_id FROM product_session_inputs WHERE id=?',
        )
        .get(turns[1].input_id),
    ).toEqual(nativeBefore);
    const sources = db
      .prepare(
        'SELECT task_id,input_id FROM product_input_task_sources WHERE input_id IN (?,?)',
      )
      .all(turns[1].input_id, turns[2].input_id) as any[];
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s) => s.task_id)).size).toBe(2);
    const snapshot = await f.snapshot(groupId);
    expect(snapshot.discussion!.run).toMatchObject({
      id: run.id,
      deadline_at: run.deadline_at,
      model_attempts: 4,
      turn_count: 3,
      policy: 'relay-v1',
      protocol_version: 2,
    });
    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['INITIAL_102_208', 'REVIEWER_FRESH_88_222', 'FINAL_88_222']);
    db.close();
    db = undefined;
    await f.restartWorker();
    await f.stop();
    await f.start();
    await delay(500);
    expect((await f.snapshot(groupId)).messages).toEqual(snapshot.messages);
    expect(f.requests).toHaveLength(4);
  } finally {
    db?.close();
    await f.dispose();
  }
}, 240000);

test('Cloud independent work retains its narrowed grant and one causal return through worker and authority reconstruction', async () => {
  const f = await cloudBotHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'cloudflare-durable',
      ['inspect_text', 'create_approved_artifact'],
      'relay-v1',
    );
    let toolRequested = false,
      continued = 0;
    let actualResult = '';
    const say = (
      action: string,
      public_message: string | null,
      extra: Record<string, unknown> = {},
    ) => ({
      text: JSON.stringify({
        version: 2,
        public_message,
        control: { action, ...extra },
      }),
    });
    f.setModel((body) => {
      const c = groupInputContext(body);
      if (c.kind === 'bot_group_request') {
        expect(body.tools?.map((tool) => tool.function.name)).toEqual([
          'create_approved_artifact',
        ]);
        if (!toolRequested) {
          toolRequested = true;
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'CLOUD_INDEPENDENT_CONSENT' },
            },
          };
        }
        expect(body.messages.some((message) => message.role === 'tool')).toBe(
          true,
        );
        actualResult = `CLOUD_NATIVE_WORK_${randomUUID()}`;
        return { text: actualResult };
      }
      if (c.speaker_contract.work_return) {
        continued++;
        expect(c.speaker_contract.work_return.public_result).toBe(actualResult);
        return say(
          'reply',
          `CLOUD_REQUESTER_USED_${c.speaker_contract.work_return.public_result}`,
        );
      }
      if (c.speaker_contract.role === 'coordinator')
        return say(
          'finish',
          c.work.some((work: any) =>
            ['awaiting_approval', 'authorized'].includes(work.state),
          )
            ? 'CLOUD_PROVISIONAL_WORK'
            : 'CLOUD_WORK_FINISHED',
        );
      if (c.speaker_contract.speaker_profile_id === people[0].id)
        return say(
          'delegate',
          'Owner confirmation is required before independent work.',
          {
            work: {
              target_profile_id: people[1].id,
              instruction:
                'Create the exact owner-approved Cloud artifact and return its real result.',
              tool_capabilities: ['create_approved_artifact'],
              max_model_attempts: 2,
              context_message_ids: [c.root_question.id],
            },
          },
        );
      return say('reply', `CLOUD_PEER_CONTINUES_${c.turn_count}`);
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Collaborate while independently approved Cloud work is pending.',
      }),
    );
    await waitFor(
      async () => !!(await f.snapshot(groupId)).discussion?.work?.length,
      60000,
    );
    const work = (await f.snapshot(groupId)).discussion!.work![0];
    expect((await f.snapshot(groupId)).handoffs).toHaveLength(0);
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussion-work/${work.id}/decision`,
        'POST',
        {
          expected_revision: work.revision,
          proposal_digest: work.proposal_digest,
          decision: 'approve',
        },
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).handoffs?.[0]?.state ===
        'waiting_for_approval',
      60000,
    );
    const handoff = (await f.snapshot(groupId)).handoffs![0];
    const pending = await f.json<any>(
      await f.call(
        `/api/bot-groups/${groupId}/handoffs/${handoff.id}/approvals`,
      ),
    );
    const approval = pending.approvals.find(
      (item: any) => item.state === 'pending',
    );
    expect(approval.content).toBe('CLOUD_INDEPENDENT_CONSENT');
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).messages.some(
          (message) => message.content === 'CLOUD_PROVISIONAL_WORK',
        ),
      60000,
    );
    await f.restartWorker();
    await f.restartNode();
    const restored = (await f.snapshot(groupId)).handoffs![0];
    expect(restored.session_id).toBe(handoff.session_id);
    expect(restored.request_id).toBe(handoff.request_id);
    expect(restored.payload_digest).toBe(handoff.payload_digest);
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/handoffs/${handoff.id}/approvals/${approval.id}`,
        'POST',
        { parameters_digest: approval.parameters_digest, decision: 'approve' },
      ),
    );
    await waitFor(async () => {
      const run = (await f.snapshot(groupId)).discussion?.run;
      if (run?.status === 'failed')
        throw new Error(run.error_code ?? 'Cloud work discussion failed');
      return run?.status === 'completed';
    }, 90000);
    const done = await f.snapshot(groupId),
      returned = done.discussion!.work![0];
    expect(returned.state).toBe('returned');
    expect(returned.continuation_state).toBe('consumed');
    expect(continued).toBe(1);
    expect(
      done.messages.filter((message) => message.content === actualResult),
    ).toHaveLength(1);
    expect(
      done.messages.filter(
        (message) => message.content === `CLOUD_REQUESTER_USED_${actualResult}`,
      ),
    ).toHaveLength(1);
    expect(done.discussion!.run!.work_model_attempts).toBe(2);
    expect(done.discussion!.run!.reserved_work_attempts).toBe(0);
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const worker = db
      .prepare(
        'SELECT s.binding_json FROM product_cloud_sessions s JOIN bot_group_handoffs h ON h.session_id=s.session_id WHERE h.id=?',
      )
      .get(handoff.id) as any;
    expect(JSON.parse(worker.binding_json).tool_capabilities).toEqual([
      'create_approved_artifact',
    ]);
    expect(JSON.parse(worker.binding_json).max_model_steps).toBe(2);
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM bot_group_discussion_work WHERE run_id=? AND continuation_turn_id IS NOT NULL',
        )
        .get(work.run_id),
    ).toEqual({ n: 1 });
    db.close();
  } finally {
    await f.dispose();
  }
}, 300000);

test('three Cloud Group sessions preserve ordered canonical context across actual workerd reconstruction and reuse', async () => {
  const f = await cloudBotHandoffHttpFixture();
  try {
    const { groupId } = await threeDotGroup(f, 'cloudflare-durable');
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'coordinator') {
        const next = c.participants.find((p: any) => p.turns === 0);
        return {
          text: JSON.stringify(
            next
              ? { action: 'speak', profileId: next.profile_id }
              : { action: 'finish', summary: 'CLOUD_DISCUSSION_FINISHED' },
          ),
        };
      }
      return {
        text: JSON.stringify({
          action: 'reply',
          message: `CLOUD_DOT_${c.turn_count}_${c.recent_and_delta
            .filter((m: any) => m.author_kind === 'bot')
            .map((m: any) => m.content)
            .join('|')}`,
        }),
      };
    });
    const send = async (root: string) => {
      expect(
        (
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content: root,
          })
        ).status,
      ).toBe(202);
      await waitFor(async () => {
        const run = (await f.snapshot(groupId)).discussion?.run;
        if (run?.status === 'failed')
          throw new Error(run.error_code ?? 'Cloud discussion failed');
        return run?.status === 'completed';
      }, 60000);
    };
    await send('CLOUD_ROOT_ONE');
    const before = await f.snapshot(groupId);
    expect(before.messages.filter((m) => m.author_kind === 'bot')).toHaveLength(
      4,
    );
    expect(f.requests).toHaveLength(7);
    let db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const original = db
      .prepare(
        'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
      )
      .all(groupId);
    const objects = db
      .prepare(
        'SELECT object_id FROM product_cloud_sessions WHERE session_id IN (SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?) ORDER BY session_id',
      )
      .all(groupId);
    db.close();
    expect(original).toHaveLength(3);
    await f.restartWorker();
    expect((await f.snapshot(groupId)).messages).toEqual(before.messages);
    expect(f.requests).toHaveLength(7);
    await send('CLOUD_ROOT_TWO');
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare(
          'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        )
        .all(groupId),
    ).toEqual(original);
    expect(
      db
        .prepare(
          'SELECT object_id FROM product_cloud_sessions WHERE session_id IN (SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?) ORDER BY session_id',
        )
        .all(groupId),
    ).toEqual(objects);
    db.close();
    expect(f.requests).toHaveLength(14);
  } finally {
    await f.dispose();
  }
}, 240000);

test('Cloud discussion Stop uses a stop-only native abort, rejects late delivery and keeps the same session usable', async () => {
  const f = await cloudBotHandoffHttpFixture();
  try {
    const group = await f.createGroup([], 4, 'cloudflare-durable');
    let snapshot = await f.snapshot(group.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: group.profileId,
          participant_profile_ids: [group.profileId],
          expected_revision: snapshot.revision,
        },
      ),
    );
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'HOLD_CLOUD_DISCUSSION',
      }),
    );
    await waitFor(() => f.held.size > 0);
    snapshot = await f.snapshot(group.groupId);
    expect(
      (
        await f.call(
          `/api/bot-groups/${group.groupId}/discussions/${snapshot.discussion!.run!.id}/stop`,
          'POST',
          {},
        )
      ).status,
    ).toBe(200);
    expect((await f.snapshot(group.groupId)).discussion!.run!.stop_state).toBe(
      'stopped',
    );
    f.release({
      text: JSON.stringify({
        action: 'finish',
        summary: 'CLOUD_FORBIDDEN_LATE',
      }),
    });
    expect((await f.snapshot(group.groupId)).discussion?.run?.status).toBe(
      'cancelled',
    );
    f.setModel(() => ({
      text: JSON.stringify({ action: 'finish', summary: 'CLOUD_SAFE_NEXT' }),
    }));
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'CLOUD_NEXT_DISCUSSION',
      }),
    );
    try {
      await waitFor(async () => {
        const run = (await f.snapshot(group.groupId)).discussion?.run;
        if (run?.status === 'failed')
          throw new Error(run.error_code ?? 'failed');
        return run?.status === 'completed';
      }, 60000);
    } catch (e) {
      console.info({
        codes: f.diagnostics().match(/(?:GROUP|CLOUD)_[A-Z_]+/g),
      });
      throw e;
    }
    expect(
      (await f.snapshot(group.groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['CLOUD_SAFE_NEXT']);
  } finally {
    await f.dispose();
  }
}, 240000);
