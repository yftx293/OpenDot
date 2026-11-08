import WebSocket from 'ws';
import { once } from 'node:events';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
import {
  turnContext,
  threeDotGroup,
} from './helpers/group-discussion-fixture.js';
// Real backend + persistent Pi Durable sessions; loopback model SSE is synthetic.
import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('a Group Dot retains its real Pi session across runs/restart; decisions commit once and a second Group is isolated', async () => {
  const f = await botHandoffHttpFixture();
  let socket: WebSocket | undefined;
  const events: any[] = [];
  try {
    const group = await f.createGroup([], 4);
    let state = await f.snapshot(group.groupId);
    const configured = await f.call(
      `/api/bot-groups/${group.groupId}/discussion-settings`,
      'PATCH',
      {
        enabled: true,
        coordinator_profile_id: group.profileId,
        participant_profile_ids: [group.profileId],
        expected_revision: state.revision,
      },
    );
    expect(configured.status).toBe(200);
    const login = await f.call('/api/auth/login', 'POST', f.credentials);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await login.body?.cancel();
    socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws', {
      headers: { Cookie: cookie, Origin: f.origin },
    });
    socket.on('message', (data) => {
      try {
        events.push(JSON.parse(data.toString()));
      } catch {}
    });
    await once(socket, 'open');

    f.setModel((body) => {
      const context = turnContext(body);
      if (context.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: `PUBLIC_${context.root_question.content}`,
          }),
        };
      const nativeReplies = body.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => {
          const content = Array.isArray(message.content)
            ? message.content.map((part) => part.text ?? '').join('')
            : message.content;
          if (typeof content !== 'string') return [];
          try {
            return [JSON.parse(content)];
          } catch {
            return [];
          }
        });
      const nativeReply = nativeReplies
        .filter((reply) => reply.action === 'reply')
        .at(-1);
      if (context.turn_count > 0) {
        expect(nativeReply?.message).toBe(
          `PUBLIC_${context.root_question.content}`,
        );
        expect(
          context.recent_and_delta.some(
            (message: any) => message.content === nativeReply.message,
          ),
        ).toBe(false);
        expect(context.known_session_output_ids.length).toBeGreaterThan(0);
      }
      return {
        text: JSON.stringify(
          context.turn_count === 0
            ? { action: 'speak', profileId: group.profileId }
            : {
                action: 'finish',
                summary: `FINAL_${nativeReply?.message}`,
              },
        ),
      };
    });
    const send = async (question: string) => {
      const key = crypto.randomUUID();
      const body = { content: question, mentions: [] };
      const first = await f.call(
        `/api/bot-groups/${group.groupId}/messages`,
        'POST',
        body,
        key,
      );
      expect(first.status).toBe(202);
      expect(
        (
          await f.call(
            `/api/bot-groups/${group.groupId}/messages`,
            'POST',
            body,
            key,
          )
        ).status,
      ).toBe(202);
      try {
        await waitFor(
          async () =>
            (await f.snapshot(group.groupId)).discussion?.run?.status ===
            'completed',
        );
      } catch (e) {
        console.info(
          JSON.stringify({
            state: (await f.snapshot(group.groupId)).discussion,
            requests: f.requests,
            log: f.diagnostics().slice(-4500),
          }),
        );
        throw e;
      }
      return f.snapshot(group.groupId);
    };
    state = await send('FIRST_ROOT');
    expect(
      state.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['PUBLIC_FIRST_ROOT', 'FINAL_PUBLIC_FIRST_ROOT']);
    expect(f.requests).toHaveLength(3);
    let db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const session = db
      .prepare('SELECT * FROM bot_group_dot_sessions WHERE group_id=?')
      .get(group.groupId) as any;
    expect(session.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(events.some((e) => e.type === 'bot_group_update')).toBe(true);
    expect(
      events.filter(
        (e) => e.type === 'agent_status' && e.agentId === session.session_id,
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (e) =>
          e.type === 'new_message' &&
          JSON.stringify(e).includes(session.session_id),
      ),
    ).toEqual([]);
    const closed = once(socket, 'close');
    socket.close();
    await closed;
    socket = undefined;

    const privateSessions = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(group.workspaceJid)}/sessions`,
      ),
    );
    const privateAgents = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(group.workspaceJid)}/agents`,
      ),
    );
    expect(
      privateSessions.sessions.some((s: any) => s.id === session.session_id),
    ).toBe(false);
    expect(
      privateAgents.agents.some((s: any) => s.id === session.session_id),
    ).toBe(false);

    expect(
      db
        .prepare(
          'SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(session.session_id),
    ).toEqual({ n: 3 });
    db.close();
    await f.stop();
    await f.start();
    const recovered = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        recovered
          .prepare(
            "SELECT COUNT(*) n FROM messages WHERE chat_jid LIKE ? AND id LIKE 'system-recover-%'",
          )
          .get(`%#agent:${session.session_id}`),
      ).toEqual({ n: 0 });
    } finally {
      recovered.close();
    }
    state = await send('SECOND_ROOT');
    expect(state.discussion?.run?.model_attempts).toBe(3);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      (
        db
          .prepare(
            'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?',
          )
          .get(group.groupId) as any
      ).session_id,
    ).toBe(session.session_id);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=?',
        )
        .get(session.session_id),
    ).toEqual({ n: 6 });
    db.close();
    expect(state.messages.filter((m) => m.author_kind === 'bot')).toHaveLength(
      4,
    );
    const other = await f.createGroup([], 4);
    const otherState = await f.snapshot(other.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${other.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: other.profileId,
          participant_profile_ids: [other.profileId],
          expected_revision: otherState.revision,
        },
      ),
    );
    f.setModel((body) => {
      expect(JSON.stringify(body.messages)).not.toContain('FIRST_ROOT');
      expect(JSON.stringify(body.messages)).not.toContain('SECOND_ROOT');
      return {
        text: JSON.stringify({ action: 'finish', summary: 'ISOLATED_GROUP_B' }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${other.groupId}/messages`, 'POST', {
        content: 'GROUP_B_ROOT',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(other.groupId)).discussion?.run?.status ===
        'completed',
    );
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      (
        db
          .prepare(
            'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?',
          )
          .get(other.groupId) as any
      ).session_id,
    ).not.toBe(session.session_id);
    db.close();
  } finally {
    socket?.terminate();
    await f.dispose();
  }
}, 180000);

test('three independent Pi sessions read each other’s committed public messages in order; pass, finish and restart reuse exact identities', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(f);
    const canonical: string[] = [];
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'coordinator') {
        const next = c.participants.find((p: any) => p.turns === 0);
        return {
          text: JSON.stringify(
            next
              ? { action: 'speak', profileId: next.profile_id }
              : { action: 'finish', summary: 'FINAL_SHARED_PLAN' },
          ),
        };
      }
      const index = c.turn_count;
      const current = people[index];
      const publicMessages = c.recent_and_delta.filter(
        (m: any) => m.author_kind === 'bot',
      );
      expect(publicMessages.map((m: any) => m.content)).toEqual(canonical);
      const reply = `${current.name}_PUBLIC_${crypto.randomUUID()}`;
      canonical.push(reply);
      if (index === 1) {
        // The coordinator's persistent session must survive another Dot's
        // turn lasting longer than its one-second authority heartbeat.
        setTimeout(
          () =>
            f.release({
              text: JSON.stringify({ action: 'reply', message: reply }),
            }),
          1600,
        );
        return { hold: true };
      }
      return { text: JSON.stringify({ action: 'reply', message: reply }) };
    });
    const accepted = await f.call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      {
        content:
          'GROUP_A_ONLY: review the multi Dot design in Researcher, Developer, Reviewer order.',
        mentions: [],
      },
    );
    expect(accepted.status).toBe(202);
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    let snapshot = await f.snapshot(groupId);
    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual([...canonical, 'FINAL_SHARED_PLAN']);
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const sessions = db
      .prepare(
        'SELECT * FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
      )
      .all(groupId) as any[];
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map((s) => s.session_id)).size).toBe(3);
    const turns = db
      .prepare(
        'SELECT * FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
      )
      .all(snapshot.discussion!.run!.id) as any[];
    expect(turns).toHaveLength(7);
    for (const turn of turns) {
      expect(turn.state).toBe('completed');
      expect(turn.input_id).toBeTruthy();
    }
    db.close();
    expect(f.requests).toHaveLength(7);
    await f.stop('SIGKILL');
    await f.start();
    snapshot = await f.snapshot(groupId);
    expect(snapshot.discussion?.run?.status).toBe('completed');
    expect(f.requests).toHaveLength(7);
    expect(
      snapshot.messages.filter((m) => m.author_kind === 'bot'),
    ).toHaveLength(4);
  } finally {
    await f.dispose();
  }
}, 180000);

test('an in-flight Stop rejects a late real native answer and new discussion reuses the same Group Session safely', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const group = await f.createGroup([], 4);
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
        content: 'HOLD_FOR_STOP',
      }),
    );
    await waitFor(() => f.held.size === 1);
    snapshot = await f.snapshot(group.groupId);
    const runId = snapshot.discussion!.run!.id;
    const response = await f.call(
      `/api/bot-groups/${group.groupId}/discussions/${runId}/stop`,
      'POST',
      {},
    );
    expect(response.status).toBe(200);
    expect(
      (await f.json<any>(response)).snapshot.discussion.run.stop_state,
    ).toBe('stopped');
    f.release({
      text: JSON.stringify({
        action: 'finish',
        summary: 'FORBIDDEN_LATE_REPLY',
      }),
    });
    expect((await f.snapshot(group.groupId)).discussion?.run?.status).toBe(
      'cancelled',
    );
    expect(
      (await f.snapshot(group.groupId)).messages.some((m) =>
        m.content.includes('FORBIDDEN_LATE_REPLY'),
      ),
    ).toBe(false);
    f.setModel(() => ({
      text: JSON.stringify({
        action: 'finish',
        summary: 'SAFE_NEXT_DISCUSSION',
      }),
    }));
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'NEXT_ROOT',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
    );
    expect(
      (await f.snapshot(group.groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['SAFE_NEXT_DISCUSSION']);
  } finally {
    await f.dispose();
  }
}, 180000);

test('discussion artifact consent uses the existing native approval UI/API and Stop revokes stale consent', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const group = await f.createGroup(['create_approved_artifact'], 4);
    const state = await f.snapshot(group.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: group.profileId,
          participant_profile_ids: [group.profileId],
          expected_revision: state.revision,
        },
      ),
    );
    let requestArtifact = true;
    f.setModel(() => {
      if (requestArtifact) {
        requestArtifact = false;
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: 'EXACT_GROUP_PRIVATE_ARTIFACT' },
          },
        };
      }
      return {
        text: JSON.stringify({
          action: 'finish',
          summary: 'PUBLIC_APPROVED_RESULT',
        }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'Create the artifact only with my approval, then summarize.',
      }),
    );
    await waitFor(
      async () =>
        !!(
          await f.snapshot(group.groupId)
        ).discussion?.current_task?.approvals.some(
          (a) => a.state === 'pending',
        ),
    );
    const pending = (await f.snapshot(group.groupId)).discussion!.current_task!;
    const approval = pending.approvals.find((a) => a.state === 'pending')!;
    expect(approval.content).toBe('EXACT_GROUP_PRIVATE_ARTIFACT');
    expect(
      (
        await f.call(
          `/api/groups/${encodeURIComponent(pending.workspace_jid)}/sessions/${pending.session_id}/approvals/${approval.id}`,
          'POST',
          {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: crypto.randomUUID(),
          },
        )
      ).status,
    ).toBe(200);
    await waitFor(
      async () =>
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
    );
    expect(
      (await f.snapshot(group.groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['PUBLIC_APPROVED_RESULT']);
    requestArtifact = true;
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'Request a second artifact and await my confirmation.',
      }),
    );
    await waitFor(
      async () =>
        !!(
          await f.snapshot(group.groupId)
        ).discussion?.current_task?.approvals.some(
          (a) => a.state === 'pending',
        ),
    );
    const second = await f.snapshot(group.groupId);
    const secondTask = second.discussion!.current_task!;
    const oldApproval = secondTask.approvals.find(
      (a) => a.state === 'pending',
    )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussions/${second.discussion!.run!.id}/stop`,
        'POST',
        {},
      ),
    );
    expect(
      (
        await f.call(
          `/api/groups/${encodeURIComponent(secondTask.workspace_jid)}/sessions/${secondTask.session_id}/approvals/${oldApproval.id}`,
          'POST',
          {
            parametersDigest: oldApproval.parameters_digest,
            decision: 'approve',
            requestId: crypto.randomUUID(),
          },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare('SELECT state,resolution FROM product_approvals WHERE id=?')
        .get(oldApproval.id),
    ).toEqual({ state: 'denied', resolution: 'revoked' });
    db.close();
  } finally {
    await f.dispose();
  }
}, 180000);

test('native runs enforce pass, structured decisions, hard turn/model limits and revocation during a held speaker', async () => {
  const f = await botHandoffHttpFixture();
  try {
    f.setModel((body) => {
      const c = turnContext(body),
        kind = c.root_question.content;
      if (kind === 'INVALID_ROOT')
        return {
          text: '{"action":"finish","summary":"untrusted","extra":"authority"}',
        };
      if (c.speaker_contract.role === 'coordinator')
        return {
          text: JSON.stringify(
            kind === 'PASS_ROOT' && c.turn_count
              ? { action: 'finish', summary: 'PASS_FINAL' }
              : { action: 'speak', profileId: c.participants[0].profile_id },
          ),
        };
      if (kind === 'REVOKE_ROOT') return { hold: true };
      return {
        text: JSON.stringify(
          kind === 'PASS_ROOT'
            ? { action: 'pass', reason: 'No additional evidence' }
            : { action: 'reply', message: 'ONE_PUBLIC_REPLY' },
        ),
      };
    });
    const start = async (
      content: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const g = await f.createGroup([], 4),
        s = await f.snapshot(g.groupId);
      await f.json(
        await f.call(
          `/api/bot-groups/${g.groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            coordinator_profile_id: g.profileId,
            participant_profile_ids: [g.profileId],
            expected_revision: s.revision,
            ...overrides,
          },
        ),
      );
      await f.json(
        await f.call(`/api/bot-groups/${g.groupId}/messages`, 'POST', {
          content,
        }),
      );
      return g;
    };
    const pass = await start('PASS_ROOT');
    await waitFor(
      async () =>
        (await f.snapshot(pass.groupId)).discussion?.run?.status ===
        'completed',
    );
    expect(
      (await f.snapshot(pass.groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['PASS_FINAL']);
    const limited = await start('LIMIT_ROOT', { max_turns: 1 });
    await waitFor(
      async () =>
        (await f.snapshot(limited.groupId)).discussion?.run?.status ===
        'waiting_user',
    );
    expect((await f.snapshot(limited.groupId)).discussion?.run).toMatchObject({
      turn_count: 1,
      error_code: 'GROUP_DISCUSSION_TURN_LIMIT',
    });
    const invalid = await start('INVALID_ROOT');
    await waitFor(
      async () =>
        (await f.snapshot(invalid.groupId)).discussion?.run?.status ===
        'failed',
    );
    expect(
      (await f.snapshot(invalid.groupId)).discussion?.run?.error_code,
    ).toBe('GROUP_DISCUSSION_INVALID_DECISION');
    const budget = await start('BUDGET_ROOT', { max_model_attempts: 1 });
    await waitFor(
      async () =>
        (await f.snapshot(budget.groupId)).discussion?.run?.status ===
        'waiting_user',
    );
    expect((await f.snapshot(budget.groupId)).discussion?.run).toMatchObject({
      turn_count: 0,
      model_attempts: 1,
      error_code: 'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED',
    });
    const revoke = await start('REVOKE_ROOT');
    await waitFor(() => f.held.size > 0);
    const before = await f.snapshot(revoke.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${revoke.groupId}/members/${revoke.memberId}`,
        'PATCH',
        { state: 'disabled', expected_revision: before.revision },
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(revoke.groupId)).discussion?.run?.status === 'failed',
    );
    f.release({
      text: JSON.stringify({ action: 'reply', message: 'REVOKED_LATE_REPLY' }),
    });
    expect(
      (await f.snapshot(revoke.groupId)).messages.filter(
        (m) => m.author_kind === 'bot',
      ),
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 180000);

test('SIGKILL during a participant turn recovers the same pending native input and never duplicates its Group reply', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(f);
    let interrupted = false;
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'coordinator') {
        const next = c.participants.find((p: any) => p.turns === 0);
        return {
          text: JSON.stringify(
            next
              ? { action: 'speak', profileId: next.profile_id }
              : { action: 'finish', summary: 'RECOVERED_FINAL' },
          ),
        };
      }
      if (!interrupted) {
        interrupted = true;
        return { hold: true };
      }
      return {
        text: JSON.stringify({
          action: 'reply',
          message: `RECOVERED_PUBLIC_${c.turn_count}`,
        }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Recover these three Dot sessions after a process interruption.',
      }),
    );
    await waitFor(() => f.held.size > 0);
    let db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const turn = db
      .prepare(
        "SELECT t.id,t.session_id,t.request_id,i.id input_id,i.submission_id FROM bot_group_discussion_turns t JOIN product_session_inputs i ON i.session_id=t.session_id AND i.request_id=t.request_id WHERE t.state='pending'",
      )
      .get() as any;
    db.close();
    expect(turn.submission_id).toBeTypeOf('number');
    await f.stop('SIGKILL');
    f.release({
      text: JSON.stringify({
        action: 'reply',
        message: 'LOST_OLD_PROCESS_RESPONSE',
      }),
    });
    await f.start();
    await waitFor(async () => {
      const run = (await f.snapshot(groupId)).discussion?.run;
      if (run?.status === 'failed')
        throw new Error(run.error_code ?? 'recovery failed');
      return run?.status === 'completed';
    }, 60000);
    const snapshot = await f.snapshot(groupId);
    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual([
      'RECOVERED_PUBLIC_0',
      'RECOVERED_PUBLIC_1',
      'RECOVERED_PUBLIC_2',
      'RECOVERED_FINAL',
    ]);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const recovered = db
      .prepare(
        'SELECT t.id,t.session_id,t.request_id,i.id input_id,i.submission_id FROM bot_group_discussion_turns t JOIN product_session_inputs i ON i.session_id=t.session_id AND i.request_id=t.request_id WHERE t.id=?',
      )
      .get(turn.id);
    expect(recovered).toEqual(turn);
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM bot_group_dot_sessions WHERE group_id=?',
        )
        .get(groupId),
    ).toEqual({ n: people.length });
    db.close();
  } finally {
    await f.dispose();
  }
}, 180000);

test('a replayed Stop for an old run cannot cancel a newer run in the same persistent session', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const group = await f.createGroup([], 4),
      state = await f.snapshot(group.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: group.profileId,
          participant_profile_ids: [group.profileId],
          expected_revision: state.revision,
        },
      ),
    );
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'OLD_RUN',
      }),
    );
    await waitFor(() => f.held.size > 0);
    const old = (await f.snapshot(group.groupId)).discussion!.run!,
      key = crypto.randomUUID(),
      stopPath = `/api/bot-groups/${group.groupId}/discussions/${old.id}/stop`;
    await f.json(await f.call(stopPath, 'POST', {}, key));
    f.release({
      text: JSON.stringify({ action: 'finish', summary: 'OLD_LATE' }),
    });
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'NEW_RUN',
      }),
    );
    await waitFor(() => f.held.size > 0);
    const current = (await f.snapshot(group.groupId)).discussion!.run!;
    expect(current.id).not.toBe(old.id);
    await f.json(await f.call(stopPath, 'POST', {}, key));
    expect((await f.snapshot(group.groupId)).discussion!.run).toMatchObject({
      id: current.id,
      status: 'running',
    });
    f.release({
      text: JSON.stringify({ action: 'finish', summary: 'NEW_RUN_FINISHED' }),
    });
    await waitFor(
      async () =>
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
    );
    expect(
      (await f.snapshot(group.groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['NEW_RUN_FINISHED']);
  } finally {
    await f.dispose();
  }
}, 180000);

test('a user message during a live run joins the same discussion and the coordinator reads it before deciding', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(f);
    let coordinatorRounds = 0;
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: `DOT_${c.turn_count}`,
          }),
        };
      coordinatorRounds += 1;
      if (coordinatorRounds === 1) return { hold: true };
      // The user redirected the discussion; the coordinator must see it as an
      // unread direct interjection, not as another Dot's contribution.
      expect(c.user_interjection_ids).toHaveLength(1);
      const interjection = c.recent_and_delta.find(
        (m: any) => m.id === c.user_interjection_ids[0],
      );
      expect(interjection).toMatchObject({
        content: 'PLEASE_FOCUS_ON_COST',
        author_kind: 'user',
        since_last_read: true,
      });
      return {
        text: JSON.stringify({
          action: 'finish',
          summary: 'COST_FOCUSED_ANSWER',
        }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'ORIGINAL_QUESTION',
      }),
    );
    await waitFor(() => f.held.size === 1);
    // A second user message while the run is live is accepted, not BUSY.
    const interjection = await f.call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      { content: 'PLEASE_FOCUS_ON_COST' },
    );
    expect(interjection.status).toBe(202);
    f.release({
      text: JSON.stringify({ action: 'speak', profileId: people[1].id }),
    });
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    const snapshot = await f.snapshot(groupId);
    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'user')
        .map((m) => m.content),
    ).toEqual(['ORIGINAL_QUESTION', 'PLEASE_FOCUS_ON_COST']);
    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toContain('COST_FOCUSED_ANSWER');
  } finally {
    await f.dispose();
  }
}, 180000);

test('a coordinator finish frozen before an interjection cannot close the run or publish a stale conclusion', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId } = await threeDotGroup(f);
    let calls = 0;
    f.setModel((body) => {
      calls += 1;
      const context = turnContext(body);
      if (calls === 1) return { hold: true };
      expect(context.speaker_contract.role).toBe('coordinator');
      expect(
        context.recent_and_delta.some(
          (message: any) => message.content === 'NEW_USER_CONSTRAINT',
        ),
      ).toBe(true);
      return {
        text: JSON.stringify({ action: 'finish', summary: 'FRESH_CONCLUSION' }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'ORIGINAL_ROOT',
      }),
    );
    await waitFor(() => f.requests.length === 1);
    const runId = (await f.snapshot(groupId)).discussion!.run!.id;
    const added = await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
      content: 'NEW_USER_CONSTRAINT',
    });
    expect(added.status).toBe(202);
    await added.body?.cancel();
    f.release({
      text: JSON.stringify({ action: 'finish', summary: 'STALE_CONCLUSION' }),
    });
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    const snapshot = await f.snapshot(groupId);
    expect(snapshot.discussion!.run!.id).toBe(runId);
    expect(
      snapshot.messages
        .filter((message) => message.author_kind === 'bot')
        .map((message) => message.content),
    ).toEqual(['FRESH_CONCLUSION']);
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.dispose();
  }
}, 180000);

test('a Dot waiting for approval no longer blocks the Group; the run closes only after its result returns', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const base = await f.createGroup([], 6);
    const profiles: { id: string; name: string }[] = [];
    for (const name of ['Coordinator', 'Worker', 'Analyst']) {
      const created = await f.json<any>(
        await f.call('/api/agent-profiles/quick-create', 'POST', {
          request_id: crypto.randomUUID(),
          name,
          avatar_shape: 'blob',
          avatar_color: '#1456f0',
          identity_prompt: `You are ${name}. Answer only through the JSON contract.`,
        }),
      );
      profiles.push({ id: created.profile.id, name });
      let snapshot = await f.snapshot(base.groupId);
      snapshot = (
        await f.json<any>(
          await f.call(`/api/bot-groups/${base.groupId}/members`, 'POST', {
            kind: 'bot',
            profile_id: created.profile.id,
            scope_workspace_jid: created.jid,
            expected_revision: snapshot.revision,
          }),
        )
      ).snapshot;
      const member = snapshot.members.find(
        (m: any) => m.subject_id === created.profile.id,
      )!;
      await f.json(
        await f.call(
          `/api/bot-groups/${base.groupId}/members/${member.id}/runtime-grants`,
          'POST',
          {
            runtime_kind: 'node-durable',
            max_model_attempts: 6,
            tool_capabilities: ['create_approved_artifact'],
            expected_revision: snapshot.revision,
            expected_member_revision: member.revision,
          },
        ),
      );
    }
    const state = await f.snapshot(base.groupId);
    const [coordinator, worker, analyst] = profiles;
    await f.json(
      await f.call(
        `/api/bot-groups/${base.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: coordinator.id,
          participant_profile_ids: profiles.map((p) => p.id),
          expected_revision: state.revision,
        },
      ),
    );
    // The Worker parks on an approval; the coordinator keeps the Group moving
    // with the Analyst, publishes a provisional conclusion, and only closes the
    // run once the Worker's result has returned.
    let artifactRequested = false;
    const coordinatorRounds: string[] = [];
    f.setModel((body) => {
      const c = turnContext(body);
      const contract = c.speaker_contract;
      if (contract.role === 'coordinator') {
        const awaiting = contract.awaiting.map((a: any) => a.profile_id);
        coordinatorRounds.push(awaiting.join(','));
        if (coordinatorRounds.length === 1)
          return {
            text: JSON.stringify({ action: 'speak', profileId: worker.id }),
          };
        if (coordinatorRounds.length === 2) {
          // The parked Dot is neither eligible nor forgotten: it is reported.
          expect(awaiting).toEqual([worker.id]);
          expect(contract.eligible_speakers).toEqual([analyst.id]);
          return {
            text: JSON.stringify({ action: 'speak', profileId: analyst.id }),
          };
        }
        if (coordinatorRounds.length === 3) {
          expect(awaiting).toEqual([worker.id]);
          return {
            text: JSON.stringify({
              action: 'finish',
              summary: 'PROVISIONAL_FINAL',
            }),
          };
        }
        expect(awaiting).toEqual([]);
        return {
          text: JSON.stringify({ action: 'finish', summary: 'APPROVED_FINAL' }),
        };
      }
      if (contract.speaker_profile_id === analyst.id) {
        expect(contract.awaiting).toBeUndefined();
        return {
          text: JSON.stringify({
            action: 'reply',
            message: 'ANALYST_CONTINUES',
          }),
        };
      }
      expect(contract.speaker_profile_id).toBe(worker.id);
      if (!artifactRequested) {
        artifactRequested = true;
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: 'PARKED_ARTIFACT' },
          },
        };
      }
      return {
        text: JSON.stringify({ action: 'reply', message: 'WORKER_RESUMED' }),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${base.groupId}/messages`, 'POST', {
        content: 'Prepare the artifact, but keep discussing meanwhile.',
      }),
    );
    // The waiting Dot must not hold the floor: the coordinator reaches a
    // provisional conclusion while the approval is still pending.
    try {
      await waitFor(async () => {
        const snapshot = await f.snapshot(base.groupId);
        return (
          snapshot.messages.some((m) => m.content === 'PROVISIONAL_FINAL') &&
          !!snapshot.discussion?.awaiting?.some((item) =>
            item.task?.approvals.some((a) => a.state === 'pending'),
          )
        );
      });
    } catch (error) {
      console.info(
        JSON.stringify({
          discussion: (await f.snapshot(base.groupId)).discussion,
          requests: f.requests.length,
          log: f.diagnostics().slice(-3000),
        }),
      );
      throw error;
    }
    const deferred = await f.snapshot(base.groupId);
    // A parked turn must never own the run-level speaking slot.
    expect(deferred.discussion?.run?.current_speaker_profile_id).toBeNull();
    expect(deferred.discussion?.run?.status).toBe('running');
    expect(deferred.discussion?.awaiting).toHaveLength(1);
    expect(deferred.discussion?.awaiting?.[0].profile_id).toBe(worker.id);
    expect(deferred.discussion?.awaiting?.[0].reason).toBe('approval');
    // The consent belongs to the parked Dot's own session, not the active one.
    const task = deferred.discussion!.awaiting![0].task!;
    expect(task.session_id).toBe(deferred.discussion!.awaiting![0].session_id);
    const approval = task.approvals.find((a) => a.state === 'pending')!;
    expect(approval.content).toBe('PARKED_ARTIFACT');
    expect(
      (
        await f.call(
          `/api/groups/${encodeURIComponent(task.workspace_jid)}/sessions/${task.session_id}/approvals/${approval.id}`,
          'POST',
          {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: crypto.randomUUID(),
          },
        )
      ).status,
    ).toBe(200);
    // The result rejoins the same discussion and the coordinator closes it.
    await waitFor(
      async () =>
        (await f.snapshot(base.groupId)).discussion?.run?.status ===
        'completed',
      60000,
    );
    const settled = await f.snapshot(base.groupId);
    expect(settled.discussion?.awaiting).toHaveLength(0);
    expect(
      settled.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual([
      'ANALYST_CONTINUES',
      'PROVISIONAL_FINAL',
      'WORKER_RESUMED',
      'APPROVED_FINAL',
    ]);
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM bot_group_discussion_turns WHERE run_id=? AND state='pending'",
        )
        .get(settled.discussion!.run!.id),
    ).toEqual({ n: 0 });
    db.close();
  } finally {
    await f.dispose();
  }
}, 240000);

test('a speaker may hand the next turn to an eligible peer without the coordinator', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      [],
      'relay-v1',
    );
    let coordinatorRounds = 0;
    const respond = (
      control: Record<string, unknown>,
      public_message: string | null,
    ) => ({ text: JSON.stringify({ version: 2, public_message, control }) });
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'coordinator') {
        coordinatorRounds += 1;
        expect(c.speaker_contract.protocol_version).toBe(2);
        return respond({ action: 'finish' }, 'RELAY_FINAL');
      }
      if (c.speaker_contract.speaker_profile_id === people[0].id) {
        return respond(
          { action: 'reply', relay_to: people[2].id },
          'HANDOFF_FROM_RESEARCHER',
        );
      }
      if (c.speaker_contract.relayed_from === people[0].id) {
        // The relayed peer may hand back to anyone still under the per-Dot
        // cap, but never to itself.
        expect(c.speaker_contract.eligible_relays).toContain(people[1].id);
        expect(c.speaker_contract.eligible_relays).not.toContain(people[2].id);
        return respond({ action: 'reply' }, 'REVIEWER_TAKES_IT');
      }
      expect(c.speaker_contract.speaker_profile_id).toBe(people[1].id);
      return respond({ action: 'pass' }, null);
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Relay this review between Dots.',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    expect(coordinatorRounds).toBe(1);
    const snapshot = await f.snapshot(groupId);
    const publicReplies = snapshot.messages.filter(
      (message) => message.author_kind === 'bot',
    );
    expect(
      publicReplies.every(
        (message) =>
          message.message_type === 'conversation' &&
          message.kind === 'system_event',
      ),
    ).toBe(true);
    expect(
      publicReplies.every((message) => message.source.protocol_version === 2),
    ).toBe(true);

    expect(
      snapshot.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['HANDOFF_FROM_RESEARCHER', 'REVIEWER_TAKES_IT', 'RELAY_FINAL']);
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const turns = db
      .prepare(
        'SELECT profile_id,relay_from_turn_id FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
      )
      .all(snapshot.discussion!.run!.id) as any[];
    expect(
      turns.find((t) => t.profile_id === people[2].id)!.relay_from_turn_id,
    ).toBeTruthy();
    db.close();
  } finally {
    await f.dispose();
  }
}, 180000);

test('a Group discussion runs on the default container Workspace without Host authority', async () => {
  const f = await botHandoffHttpFixture();
  let db: Database.Database | undefined;
  try {
    // A fresh member gets the product's default container Home Workspace. This
    // is the normal Docker deployment path, not the Host-only admin fixture.
    expect(
      (
        await f.call('/api/config/registration', 'PUT', {
          allowRegistration: true,
          requireInviteCode: false,
        })
      ).status,
    ).toBe(200);
    const username = 'container_owner';
    const registered = await f.call('/api/auth/register', 'POST', {
      username,
      password: 'Container9!OwnerFixture',
      display_name: 'Container Owner',
    });
    expect(registered.status).toBe(201);
    expect(
      ((await registered.json()) as { success?: boolean }).success,
    ).toBe(true);

    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    expect(options.workspaces).toHaveLength(1);
    const workspaceJid = options.workspaces[0]!.jid;
    let groupSnapshot = (
      await f.json<{ snapshot: BotGroupSnapshot }>(
        await f.call('/api/bot-groups', 'POST', {
          workspace_jid: workspaceJid,
          name: 'Container team',
        }),
      )
    ).snapshot;
    const groupId = groupSnapshot.group.id;
    const chief = groupSnapshot.members.find((member) => member.kind === 'bot')!;
    groupSnapshot = (
      await f.json<{ snapshot: BotGroupSnapshot }>(
        await f.call(`/api/bot-groups/${groupId}/members/${chief.id}`, 'PATCH', {
          scope_workspace_jid: workspaceJid,
          expected_revision: groupSnapshot.revision,
        }),
      )
    ).snapshot;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${chief.id}/runtime-grants`,
        'POST',
        {
          expected_revision: groupSnapshot.revision,
          expected_member_revision: groupSnapshot.members.find(
            (member) => member.id === chief.id,
          )!.revision,
          runtime_kind: 'node-durable',
          max_model_attempts: 4,
          tool_capabilities: [],
        },
      ),
    );
    const group = {
      groupId,
      profileId: chief.subject_id,
      workspaceJid,
    };
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare('SELECT execution_mode FROM registered_groups WHERE jid=?')
        .get(group.workspaceJid),
    ).toEqual({ execution_mode: 'container' });
    expect(
      db.prepare('SELECT role FROM users WHERE username=?').get(username),
    ).toEqual({ role: 'member' });
    db.close();
    db = undefined;

    let state = await f.snapshot(group.groupId);
    const configured = await f.call(
      `/api/bot-groups/${group.groupId}/discussion-settings`,
      'PATCH',
      {
        enabled: true,
        coordinator_profile_id: group.profileId,
        participant_profile_ids: [group.profileId],
        expected_revision: state.revision,
      },
    );
    expect(configured.status).toBe(200);

    f.setModel((body) => {
      const context = turnContext(body);
      if (context.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: 'CONTAINER_PUBLIC',
          }),
        };
      return {
        text: JSON.stringify(
          context.turn_count === 0
            ? { action: 'speak', profileId: group.profileId }
            : { action: 'finish', summary: 'CONTAINER_FINAL' },
        ),
      };
    });
    const sent = await f.call(
      `/api/bot-groups/${group.groupId}/messages`,
      'POST',
      { content: 'CONTAINER_ROOT', mentions: [] },
      crypto.randomUUID(),
    );
    expect(sent.status).toBe(202);
    await waitFor(
      async () =>
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
      30000,
    ).catch(async (error) => {
      console.info(
        JSON.stringify({
          state: (await f.snapshot(group.groupId)).discussion,
          requests: f.requests,
          log: f.diagnostics().slice(-6000),
        }),
      );
      throw error;
    });
    state = await f.snapshot(group.groupId);
    expect(
      state.messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.content),
    ).toEqual(['CONTAINER_PUBLIC', 'CONTAINER_FINAL']);
    // Registration may emit an unrelated onboarding turn; the Group run itself
    // uses two coordinator decisions plus one speaker turn.
    expect(
      f.requests.filter((body) =>
        JSON.stringify(body.messages).includes('group_discussion_context'),
      ),
    ).toHaveLength(3);
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);
