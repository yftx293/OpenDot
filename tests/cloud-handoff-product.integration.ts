// Real production Node HTTP + workerd + encrypted Provider/native receipts.
// The HTTP model and HTTPS hostname routing are fixtures, not cloud deployment.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

test('formal Cloud Group admission survives detach and Node SIGKILL, retains original identity and publishes one actual result (model simulated)', async () => {
  const fixture = await cloudBotHandoffHttpFixture();
  try {
    fixture.setModel(() => ({ hold: true }));
    const { groupId } = await fixture.createGroup([], 4, 'cloudflare-durable');
    fixture.loseNextSubmissionAck();
    expect(
      (
        await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            '@Chief Keep this exact formal Cloud Handoff alive after the client leaves.',
        })
      ).status,
    ).toBe(202);
    await waitFor(async () => {
      const handoff = (await fixture.snapshot(groupId)).handoffs![0];
      return fixture.requests.length === 1 && handoff.submission_id !== null;
    });
    const original = (await fixture.snapshot(groupId)).handoffs![0];
    expect(original).toMatchObject({
      runtime_kind: 'cloudflare-durable',
      model_attempts: 1,
    });
    expect(original.session_id).toBeTruthy();
    expect(original.input_id).toBeTruthy();
    await fixture.restartNode();
    await fixture.restartWorker();
    await waitFor(() => fixture.requests.length === 2 && fixture.held.size > 0);
    expect((await fixture.snapshot(groupId)).handoffs![0]).toMatchObject({
      id: original.id,
      request_id: original.request_id,
      session_id: original.session_id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      payload_digest: original.payload_digest,
    });
    fixture.release({ text: 'FORMAL_CLOUD_BOT_RESULT' });
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'completed',
    );
    const final = await fixture.snapshot(groupId),
      results = final.messages.filter((row) => row.author_kind === 'bot');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('FORMAL_CLOUD_BOT_RESULT');
    expect(final.handoffs![0]).toMatchObject({
      id: original.id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      model_attempts: 2,
    });
    expect(final.handoffs![0].task_id).toBeGreaterThan(0);
    expect(
      fs.existsSync(
        path.join(
          fixture.root,
          'data/db/durable-sessions',
          `${original.session_id}.sqlite`,
        ),
      ),
    ).toBe(false);
    expect(
      fixture.submissions.every(
        (row) =>
          (row.body as { request_id: string }).request_id ===
          original.request_id,
      ),
    ).toBe(true);
  } catch (error) {
    throw new Error(
      String(error) + '\nPrivate product:\n' + fixture.diagnostics(),
    );
  } finally {
    await fixture.dispose();
  }
}, 60000);

test('formal Cloud Group revocation removes observer access and permanently blocks the original owner without late model continuation (model simulated)', async () => {
  const fixture = await cloudBotHandoffHttpFixture();
  let stage = 'starting';
  let observed:
    | import('../src/bot-groups/handoff-types.js').BotHandoffView
    | undefined;
  try {
    fixture.setModel(() => ({ hold: true }));
    const { groupId, memberId, workspaceJid } = await fixture.createGroup(
      [],
      4,
      'cloudflare-durable',
    );
    await fixture.json(
      await fixture.call('/api/admin/users', 'POST', {
        username: 'cloud_observer',
        password: fixture.credentials.password,
        role: 'member',
        must_change_password: false,
      }),
    );
    const login = await fetch(fixture.origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'cloud_observer',
        password: fixture.credentials.password,
      }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    let snapshot = await fixture.snapshot(groupId);
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/members`, 'POST', {
        kind: 'user',
        username: 'cloud_observer',
        role: 'member',
        expected_revision: snapshot.revision,
      }),
    );
    const read = () =>
      fetch(fixture.origin + `/api/bot-groups/${groupId}`, {
        headers: { Cookie: cookie },
      });
    expect((await read()).status).toBe(200);
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Retain cancellation after the observer leaves.',
      }),
    );
    stage = 'waiting for original association';
    await waitFor(async () => {
      snapshot = await fixture.snapshot(groupId);
      observed = snapshot.handoffs![0];
      return (
        fixture.requests.length === 1 &&
        snapshot.handoffs![0].association?.state === 'associated'
      );
    });
    const original = snapshot.handoffs![0],
      observer = snapshot.members.find(
        (row) => row.kind === 'user' && row.role === 'member',
      )!;
    await fixture.json(
      await fixture.call(
        `/api/bot-groups/${groupId}/members/${observer.id}`,
        'PATCH',
        { state: 'removed', expected_revision: snapshot.revision },
      ),
    );
    expect((await read()).status).toBe(404);
    snapshot = await fixture.snapshot(groupId);
    await fixture.json(
      await fixture.call(
        `/api/bot-groups/${groupId}/members/${memberId}`,
        'PATCH',
        { state: 'disabled', expected_revision: snapshot.revision },
      ),
    );
    // Revocation uses the existing conservative blocked/uncertain contract;
    // only an explicit joined cancellation claims a cancelled business result.
    stage = 'waiting for restrictive revocation proof';
    await waitFor(async () => {
      observed = (await fixture.snapshot(groupId)).handoffs![0];
      return observed.state === 'uncertain';
    });
    const database = new Database(
      path.join(fixture.root, 'data/db/messages.db'),
      { readonly: true },
    );
    try {
      expect(
        database
          .prepare(
            'SELECT state FROM product_session_runtimes WHERE session_id=?',
          )
          .get(original.session_id),
      ).toEqual({ state: 'blocked' });
    } finally {
      database.close();
    }
    expect(
      (
        await fixture.call(
          `/api/groups/${encodeURIComponent(workspaceJid)}/sessions/${original.session_id}/runtime`,
        )
      ).ok,
    ).toBe(false);
    await fixture.restartNode(false);
    await fixture.restartWorker();
    fixture.release({ text: 'LATE_REVOKED_OUTPUT_MUST_NOT_APPEAR' });
    const final = await fixture.snapshot(groupId);
    expect(final.handoffs![0]).toMatchObject({
      id: original.id,
      session_id: original.session_id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      state: 'uncertain',
      model_attempts: 1,
    });
    expect(
      final.messages.filter((row) => row.author_kind === 'bot'),
    ).toHaveLength(0);
    expect((await read()).status).toBe(404);
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/handoffs/${original.id}/control`,
          'POST',
          { action: 'resume', expected_revision: final.handoffs![0].revision },
        )
      ).status,
    ).toBe(409);
    expect(fixture.requests).toHaveLength(1);
  } catch (error) {
    throw new Error(
      String(error) +
        '\n' +
        JSON.stringify({
          stage,
          requests: fixture.requests.length,
          state: observed?.state,
          association: observed?.association,
        }) +
        '\n' +
        fixture.diagnostics(),
    );
  } finally {
    await fixture.dispose();
  }
}, 60000);

test('formal Cloud grant exposes only its reviewed read-only tool and disabling admission preserves the original completed owner (model simulated)', async () => {
  const fixture = await cloudBotHandoffHttpFixture();
  try {
    fixture.setModel((body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'READ_ONLY_CLOUD_RESULT' }
        : {
            tool: {
              name: 'inspect_text',
              arguments: { text: 'CLOUD_READ_ONLY' },
            },
          },
    );
    const { groupId, memberId } = await fixture.createGroup(
      ['inspect_text'],
      2,
      'cloudflare-durable',
    );
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Inspect only the authorized text.',
      }),
    );
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'completed',
    );
    const original = (await fixture.snapshot(groupId)).handoffs![0];
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests)
      expect(request.tools?.map((tool) => tool.function.name)).toEqual([
        'inspect_text',
      ]);
    const toolResult = fixture.requests[1].messages.find(
      (message) => message.role === 'tool',
    );
    expect(JSON.stringify(toolResult)).toContain(
      createHash('sha256').update('CLOUD_READ_ONLY').digest('hex'),
    );
    const state = await fixture.snapshot(groupId);
    for (const [runtime_kind, tool] of [
      ['cloudflare-durable', 'read_workspace_file'],
      ['node-durable', 'inspect_text'],
    ] as const) {
      const response = await fixture.call(
        `/api/bot-groups/${groupId}/members/${memberId}/runtime-grants`,
        'POST',
        {
          expected_revision: state.revision,
          expected_member_revision: state.members.find(
            (row) => row.id === memberId,
          )!.revision,
          runtime_kind,
          tool_capabilities: [tool],
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'BOT_HANDOFF_TOOL_NOT_GRANTED',
      });
    }
    await fixture.restartNode(false);
    expect(
      await fixture.json(await fixture.call('/api/bot-groups/availability')),
    ).toMatchObject({ cloud_handoffs_enabled: false });
    const latest = await fixture.snapshot(groupId);
    const denied = await fixture.call(
      `/api/bot-groups/${groupId}/members/${memberId}/runtime-grants`,
      'POST',
      {
        expected_revision: latest.revision,
        expected_member_revision: latest.members.find(
          (row) => row.id === memberId,
        )!.revision,
        runtime_kind: 'cloudflare-durable',
        tool_capabilities: [],
      },
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: 'BOT_HANDOFF_CLOUD_ADMISSION_DISABLED',
    });
    expect((await fixture.snapshot(groupId)).handoffs![0]).toMatchObject({
      id: original.id,
      session_id: original.session_id,
      runtime_kind: 'cloudflare-durable',
      submission_id: original.submission_id,
      task_id: original.task_id,
      state: 'completed',
      model_attempts: 2,
    });
    expect(fixture.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 60000);
