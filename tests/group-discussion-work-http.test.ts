// Real backend/Pi sessions and approval/tool paths; loopback inference is synthetic.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  threeDotGroup,
  groupInputContext as input,
} from './helpers/group-discussion-fixture.js';

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

test('owner-approved work uses an independent scoped Handoff, preserves consent through restart, and causally continues once', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      ['read_workspace_file', 'create_approved_artifact'],
      'relay-v1',
    );
    let workId = '',
      artifactRequested = false,
      continuations = 0;
    let nativeResult = '';
    f.setModel((body) => {
      const c = input(body);
      if (c.kind === 'bot_group_request') {
        expect(c.discussion_origin.work_id).toBe(workId);
        expect(c.discussion_origin.requester_profile_id).toBe(people[0].id);
        expect(body.tools?.map((tool) => tool.function.name)).toEqual([
          'create_approved_artifact',
        ]);
        if (!artifactRequested) {
          artifactRequested = true;
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'INDEPENDENT_APPROVED_ARTIFACT' },
            },
          };
        }
        expect(body.messages.some((message) => message.role === 'tool')).toBe(
          true,
        );
        nativeResult = `NATIVE_WORK_${randomUUID()}`;
        return { text: nativeResult };
      }
      const contract = c.speaker_contract;
      if (contract.work_return) {
        continuations += 1;
        expect(contract.speaker_profile_id).toBe(people[0].id);
        expect(contract.work_return.work_id).toBe(workId);
        expect(contract.work_return.public_result).toBe(nativeResult);
        expect(contract.work_return.result_digest).toMatch(/^[a-f0-9]{64}$/);
        return say(
          'reply',
          `REQUESTER_CONTINUED_${contract.work_return.public_result}`,
        );
      }
      if (contract.role === 'coordinator')
        return say(
          'finish',
          c.work.some((work: any) =>
            ['awaiting_approval', 'authorized'].includes(work.state),
          )
            ? 'PROVISIONAL_WHILE_WORKING'
            : 'FINAL_AFTER_WORK',
        );
      if (contract.speaker_profile_id === people[0].id)
        return say('delegate', '请 Developer 准备产物，等待主人确认后执行。', {
          work: {
            target_profile_id: people[1].id,
            instruction:
              'Create the explicitly approved artifact and return its actual result.',
            tool_capabilities: ['create_approved_artifact'],
            max_model_attempts: 2,
            context_message_ids: [c.root_question.id],
          },
        });
      if (contract.speaker_profile_id === people[2].id) return { hold: true };
      return say('pass', null);
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Collaborate and prepare an artifact, without blocking peer discussion.',
      }),
    );
    await waitFor(
      async () => !!(await f.snapshot(groupId)).discussion?.work?.length,
    );
    const proposal = (await f.snapshot(groupId)).discussion!.work![0];
    workId = proposal.id;
    expect(proposal.state).toBe('awaiting_approval');
    expect(proposal.handoff_id).toBeNull();
    expect((await f.snapshot(groupId)).handoffs).toHaveLength(0);
    await waitFor(() => f.held.size === 1);
    const approvalBody = {
      expected_revision: proposal.revision,
      proposal_digest: proposal.proposal_digest,
      decision: 'approve',
    };
    const key = randomUUID();
    const approvals = await Promise.all([
      f.call(
        `/api/bot-groups/${groupId}/discussion-work/${workId}/decision`,
        'POST',
        approvalBody,
        key,
      ),
      f.call(
        `/api/bot-groups/${groupId}/discussion-work/${workId}/decision`,
        'POST',
        approvalBody,
        key,
      ),
    ]);
    const receipts = await Promise.all(
      approvals.map((response) => f.json<any>(response)),
    );
    expect(receipts.map((reply) => reply.receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).handoffs?.[0]?.state ===
        'waiting_for_approval',
    );
    const during = await f.snapshot(groupId),
      handoff = during.handoffs![0];
    expect(handoff.source_bot_id).toBe(people[0].id);
    expect(handoff.target_bot_id).toBe(people[1].id);
    expect(handoff.budget_max_attempts).toBe(2);
    expect(during.discussion!.run!.current_speaker_profile_id).toBe(
      people[2].id,
    );
    expect(during.discussion!.run!.reserved_work_attempts).toBe(1);
    f.release(say('reply', 'REVIEWER_CONTINUES_DURING_WORK_APPROVAL'));
    await waitFor(async () =>
      (await f.snapshot(groupId)).messages.some(
        (message) => message.content === 'PROVISIONAL_WHILE_WORKING',
      ),
    );
    let db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const groupSession = db
      .prepare(
        'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=? AND profile_id=?',
      )
      .get(groupId, people[1].id) as { session_id: string };
    expect(groupSession.session_id).not.toBe(handoff.session_id);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM bot_group_messages WHERE group_id=? AND author_kind='user'",
        )
        .get(groupId),
    ).toEqual({ n: 1 });
    db.close();
    const pending = await f.json<any>(
      await f.call(
        `/api/bot-groups/${groupId}/handoffs/${handoff.id}/approvals`,
      ),
    );
    const consent = pending.approvals.find(
      (value: any) => value.state === 'pending',
    );
    expect(consent.content).toBe('INDEPENDENT_APPROVED_ARTIFACT');
    await f.stop('SIGKILL');
    await f.start();
    const restored = (await f.snapshot(groupId)).handoffs![0];
    expect(restored.session_id).toBe(handoff.session_id);
    expect(restored.request_id).toBe(handoff.request_id);
    expect(restored.input_id).toBe(handoff.input_id);
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/handoffs/${handoff.id}/approvals/${consent.id}`,
        'POST',
        { parameters_digest: consent.parameters_digest, decision: 'approve' },
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    const done = await f.snapshot(groupId),
      work = done.discussion!.work![0];
    expect(work.state).toBe('returned');
    expect(work.continuation_state).toBe('consumed');
    expect(work.continuation_turn_id).toBeTruthy();
    expect(continuations).toBe(1);
    expect(
      done.messages.some(
        (message) =>
          message.id === work.result_message_id &&
          message.content === nativeResult,
      ),
    ).toBe(true);
    expect(
      done.messages.some(
        (message) => message.content === `REQUESTER_CONTINUED_${nativeResult}`,
      ),
    ).toBe(true);
    expect(done.messages.at(-1)?.content).toBe('FINAL_AFTER_WORK');
    expect(done.discussion!.run!.work_model_attempts).toBe(2);
    expect(done.discussion!.run!.model_attempts).toBe(f.requests.length);
    expect(done.discussion!.run!.reserved_work_attempts).toBe(0);
    const replay = await f.json<any>(
      await f.call(
        `/api/bot-groups/${groupId}/discussion-work/${workId}/decision`,
        'POST',
        approvalBody,
        key,
      ),
    );
    expect(replay.receipt.replayed).toBe(true);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare('SELECT count(*) n FROM bot_group_handoffs WHERE group_id=?')
        .get(groupId),
    ).toEqual({ n: 1 });
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
}, 240000);

test('denied and stopped proposals never create a Handoff or spend a worker model call', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      [],
      'relay-v1',
    );
    const foreignCookies: string[] = [];
    for (const username of ['invited_work_admin', 'outside_work_admin']) {
      await f.json(
        await f.call('/api/admin/users', 'POST', {
          username,
          password: f.credentials.password,
          role: 'admin',
          must_change_password: false,
        }),
      );
      const login = await fetch(f.origin + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: f.credentials.password }),
      });
      expect(login.status).toBe(200);
      foreignCookies.push(login.headers.get('set-cookie')!.split(';')[0]);
      await login.body?.cancel();
    }
    const initial = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/members`, 'POST', {
        kind: 'user',
        username: 'invited_work_admin',
        role: 'member',
        expected_revision: initial.revision,
      }),
    );
    let workerCalls = 0;
    f.setModel((body) => {
      const c = input(body);
      if (c.kind === 'bot_group_request') {
        workerCalls++;
        return { text: 'FORBIDDEN_WORK' };
      }
      if (c.speaker_contract.role === 'coordinator')
        return say('finish', 'No unapproved work was started.');
      if (c.speaker_contract.speaker_profile_id === people[0].id)
        return say('delegate', 'Only a proposal, awaiting confirmation.', {
          work: {
            target_profile_id: people[1].id,
            instruction: 'Review this public question.',
            tool_capabilities: [],
            max_model_attempts: 1,
            context_message_ids: [],
          },
        });
      return say('pass', null);
    });
    for (const stop of [false, true]) {
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: stop ? 'STOP_PENDING_WORK' : 'DENY_PENDING_WORK',
        }),
      );
      await waitFor(
        async () =>
          !!(await f.snapshot(groupId)).discussion?.work?.some(
            (work) => work.state === 'awaiting_approval',
          ),
      );
      const s = await f.snapshot(groupId),
        work = s.discussion!.work!.find(
          (value) => value.state === 'awaiting_approval',
        )!;
      for (const cookie of foreignCookies) {
        const forbidden = await fetch(
          `${f.origin}/api/bot-groups/${groupId}/discussion-work/${work.id}/decision`,
          {
            method: 'POST',
            headers: {
              Cookie: cookie,
              'Content-Type': 'application/json',
              'Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({
              expected_revision: work.revision,
              proposal_digest: work.proposal_digest,
              decision: 'approve',
            }),
          },
        );
        expect(forbidden.status).toBeGreaterThanOrEqual(400);
        await forbidden.body?.cancel();
      }
      const invalid = await f.call(
        `/api/bot-groups/${groupId}/discussion-work/${work.id}/decision`,
        'POST',
        {
          expected_revision: work.revision,
          proposal_digest: '0'.repeat(64),
          decision: 'approve',
        },
      );
      expect(invalid.status).toBe(409);
      await invalid.body?.cancel();
      if (stop)
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/discussions/${s.discussion!.run!.id}/stop`,
            'POST',
            {},
          ),
        );
      else
        await f.json(
          await f.call(
            `/api/bot-groups/${groupId}/discussion-work/${work.id}/decision`,
            'POST',
            {
              expected_revision: work.revision,
              proposal_digest: work.proposal_digest,
              decision: 'deny',
            },
          ),
        );
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status !== 'running',
      );
      const ended = await f.snapshot(groupId);
      expect(
        ended.discussion!.work!.find((value) => value.id === work.id)?.state,
      ).toBe(stop ? 'cancelled' : 'denied');
      expect(ended.handoffs).toHaveLength(0);
    }
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'A replaced runtime grant must not silently re-authorize an old proposal.',
      }),
    );
    await waitFor(
      async () =>
        !!(await f.snapshot(groupId)).discussion?.work?.some(
          (work) => work.state === 'awaiting_approval',
        ),
    );
    // Let the native coordinator publish its provisional response first. Grant
    // replacement uses the real Group revision; racing that legitimate reply
    // would only test the unrelated optimistic-concurrency rejection.
    await waitFor(
      async () =>
        !!(await f.snapshot(groupId)).discussion?.run?.awaiting_results_since,
    );
    const beforeReplacement = await f.snapshot(groupId),
      stale = beforeReplacement.discussion!.work!.find(
        (work) => work.state === 'awaiting_approval',
      )!;
    const target = beforeReplacement.members.find(
      (member) => member.subject_id === people[1].id,
    )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${target.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: 'node-durable',
          max_model_attempts: 4,
          tool_capabilities: [],
          expected_revision: beforeReplacement.revision,
          expected_member_revision: target.revision,
        },
      ),
    );
    const rejected = await f.call(
      `/api/bot-groups/${groupId}/discussion-work/${stale.id}/decision`,
      'POST',
      {
        expected_revision: stale.revision,
        proposal_digest: stale.proposal_digest,
        decision: 'approve',
      },
    );
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    await rejected.body?.cancel();
    expect((await f.snapshot(groupId)).handoffs).toHaveLength(0);
    expect(workerCalls).toBe(0);
  } finally {
    await f.dispose();
  }
}, 240000);

test('stopping discussion suppresses continuations while independently authorized work may finish once', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      [],
      'relay-v1',
    );
    let continuations = 0;
    f.setModel((body) => {
      const c = input(body);
      if (c.kind === 'bot_group_request') return { hold: true };
      if (c.speaker_contract.work_return) {
        continuations++;
        return say('reply', 'FORBIDDEN_CONTINUATION');
      }
      if (c.speaker_contract.role === 'coordinator')
        return say('finish', 'Waiting for separately authorized work.');
      if (c.speaker_contract.speaker_profile_id === people[0].id)
        return say('delegate', 'Please confirm a separate work session.', {
          work: {
            target_profile_id: people[1].id,
            instruction: 'Return a public analysis.',
            tool_capabilities: [],
            max_model_attempts: 1,
            context_message_ids: [],
          },
        });
      return say('pass', null);
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Work may finish, but a stopped discussion must stay stopped.',
      }),
    );
    await waitFor(
      async () => !!(await f.snapshot(groupId)).discussion?.work?.length,
    );
    const work = (await f.snapshot(groupId)).discussion!.work![0];
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
    await waitFor(() => f.held.size === 1);
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${work.run_id}/stop`,
        'POST',
        {},
      ),
    );
    const stopped = await f.snapshot(groupId);
    expect(stopped.discussion!.run!.status).toBe('cancelled');
    expect(stopped.discussion!.work![0].continuation_state).toBe('suppressed');
    expect(stopped.handoffs![0].state).not.toBe('cancelled');
    const result = `POST_STOP_NATIVE_RESULT_${randomUUID()}`;
    f.release({ text: result });
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.work?.[0]?.state === 'returned',
      60000,
    );
    const finished = await f.snapshot(groupId);
    expect(
      finished.messages.filter((message) => message.content === result),
    ).toHaveLength(1);
    expect(finished.discussion!.run!.status).toBe('cancelled');
    expect(continuations).toBe(0);
    const calls = f.requests.length;
    await f.stop();
    await f.start();
    expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
      'cancelled',
    );
    expect(f.requests.length).toBe(calls);
    expect(continuations).toBe(0);
  } finally {
    await f.dispose();
  }
}, 240000);
